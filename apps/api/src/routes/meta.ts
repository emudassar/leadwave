import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@leadwave/db';
import { configured, env } from '../env.js';
import { encrypt, randomToken, sha256, tryDecrypt } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { handler, ok, parseBody, parseParams, parseQuery } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';
import { requireAuth } from '../middleware/auth.js';
import { attachWorkspace, requireRole } from '../middleware/workspace.js';
import { assertPageQuota } from '../services/entitlements.js';
import {
  debugToken,
  exchangeForLongLivedUserToken,
  listManagedPages,
  listPagePosts,
  listPageStories,
  setGetStarted,
  subscribePageToWebhooks,
  unsubscribePageFromWebhooks,
} from '../services/graph.js';

/**
 * Connecting a Facebook Page.
 *
 * The flow is: Facebook Login for Business → a short-lived user token →
 * exchange it for a long-lived one → list the Pages this person manages → they
 * pick which to connect → store each Page token and subscribe it to webhooks.
 *
 * The user token is never persisted. It exists only long enough to derive Page
 * tokens, which is what we actually need and all we keep.
 */

export const metaRouter: Router = Router();

metaRouter.use(requireAuth, attachWorkspace);

// Kept in sync with the Facebook Login for Business configuration's granted
// permissions ("leadwave-page-connect"). pages_read_engagement,
// pages_manage_engagement and pages_read_user_content aren't offered by that
// configuration type and would make the OAuth dialog reject the request.
const PERMISSIONS = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'business_management',
];

const STATE_TTL = 600;
const stateKey = (state: string) => `oauth:meta:${sha256(state)}`;
const pagesKey = (handoff: string) => `meta:pages:${sha256(handoff)}`;
const redirectUri = () => `${env.API_URL}/api/v1/meta/auth/fb/callback`;

/** Tells the client whether the Meta app is configured, and what we ask for. */
metaRouter.get(
  '/auth/fb/config',
  handler(async (_req, res) => {
    ok(res, {
      configured: configured.meta,
      appId: env.META_APP_ID ?? null,
      configId: env.META_LOGIN_CONFIG_ID ?? null,
      permissions: PERMISSIONS,
      webhookUrl: `${env.API_URL}/webhooks/messenger`,
    });
  }),
);

metaRouter.get(
  '/auth/fb/start',
  requireRole('admin'),
  handler(async (req, res) => {
    if (!configured.meta) {
      throw badRequest('Facebook is not configured. Set META_APP_ID and META_APP_SECRET.');
    }

    const state = randomToken(24);
    await redis.setex(
      stateKey(state),
      STATE_TTL,
      JSON.stringify({ workspaceId: req.workspace!.id, userId: req.user!.id }),
    );

    const url = new URL(`https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth`);
    url.searchParams.set('client_id', env.META_APP_ID!);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    if (env.META_LOGIN_CONFIG_ID) {
      url.searchParams.set('config_id', env.META_LOGIN_CONFIG_ID);
    } else {
      url.searchParams.set('scope', PERMISSIONS.join(','));
    }

    ok(res, { url: url.toString() });
  }),
);

/**
 * Facebook redirects here. We do not connect anything yet — the Pages are
 * stashed briefly under a handoff token and the user chooses which ones they
 * actually want.
 */
metaRouter.get(
  '/auth/fb/callback',
  handler(async (req, res) => {
    const query = parseQuery(
      req,
      z.object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
      }),
    );

    const fail = (reason: string) =>
      res.redirect(`${env.APP_URL}/settings?fb_error=${encodeURIComponent(reason)}`);

    if (query.error || !query.code || !query.state) {
      return fail(query.error_description ?? query.error ?? 'cancelled');
    }

    const raw = await redis.getdel(stateKey(query.state));
    if (!raw) return fail('This connection link expired. Please try again.');

    const { workspaceId } = JSON.parse(raw) as { workspaceId: string };

    try {
      const shortLived = await exchangeCodeForUserToken(query.code);
      const longLived = await exchangeForLongLivedUserToken(shortLived);
      const pages = await listManagedPages(longLived.accessToken);

      if (pages.length === 0) {
        return fail('No Facebook Pages were found on that account.');
      }

      // Held for five minutes only, long enough for the picker.
      const handoff = randomToken(24);
      await redis.setex(
        pagesKey(handoff),
        300,
        JSON.stringify({
          workspaceId,
          pages: pages.map((p) => ({
            id: p.id,
            name: p.name,
            username: p.username ?? null,
            picture: p.picture?.data?.url ?? null,
            link: p.link ?? null,
            category: p.category ?? null,
            accessToken: p.access_token,
          })),
        }),
      );

      res.redirect(`${env.APP_URL}/settings?fb_handoff=${handoff}`);
    } catch (err) {
      logger.error({ err }, 'facebook connect failed');
      return fail('Could not read your Facebook Pages. Please try again.');
    }
  }),
);

/** The Pages waiting to be picked, minus their tokens. */
metaRouter.get(
  '/auth/fb/pages/:handoff',
  handler(async (req, res) => {
    const { handoff } = parseParams(req, z.object({ handoff: z.string().min(1) }));

    const raw = await redis.get(pagesKey(handoff));
    if (!raw) throw notFound('That connection has expired. Please connect again.');

    const parsed = JSON.parse(raw) as {
      workspaceId: string;
      pages: Array<{ id: string; name: string; username: string | null; picture: string | null; category: string | null }>;
    };

    if (parsed.workspaceId !== req.workspace!.id) throw notFound('That connection has expired.');

    const connected = await prisma.connectedAccount.findMany({
      where: { workspaceId: req.workspace!.id },
      select: { pageId: true },
    });
    const connectedIds = new Set(connected.map((c) => c.pageId));

    ok(res, {
      pages: parsed.pages.map((p) => ({
        id: p.id,
        name: p.name,
        username: p.username,
        picture: p.picture,
        category: p.category,
        alreadyConnected: connectedIds.has(p.id),
      })),
    });
  }),
);

/** Tags each connected Page in the unified inbox. Brand teal comes first. */
const PAGE_COLORS = ['#157A70', '#0EA5E9', '#E2952C', '#8B5CF6', '#EC4899', '#10B981'];

metaRouter.post(
  '/auth/fb/connect',
  requireRole('admin'),
  handler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({ handoff: z.string().min(1), pageIds: z.array(z.string()).min(1).max(10) }),
    );

    const raw = await redis.get(pagesKey(body.handoff));
    if (!raw) throw notFound('That connection has expired. Please connect again.');

    const parsed = JSON.parse(raw) as {
      workspaceId: string;
      pages: Array<{
        id: string;
        name: string;
        username: string | null;
        picture: string | null;
        link: string | null;
        accessToken: string;
      }>;
    };

    const workspace = req.workspace!;
    if (parsed.workspaceId !== workspace.id) throw notFound('That connection has expired.');

    const chosen = parsed.pages.filter((p) => body.pageIds.includes(p.id));
    if (chosen.length === 0) throw badRequest('Pick at least one Page.');

    const results: Array<{ pageId: string; name: string; status: string; detail?: string }> = [];
    const existingCount = await prisma.connectedAccount.count({
      where: { workspaceId: workspace.id, status: { not: 'disabled' } },
    });
    let colorIndex = existingCount;

    for (const page of chosen) {
      const already = await prisma.connectedAccount.findUnique({
        where: { workspaceId_pageId: { workspaceId: workspace.id, pageId: page.id } },
      });

      // Reconnecting an existing Page refreshes its token rather than
      // duplicating it — and does not count against the plan again.
      if (!already) {
        try {
          await assertPageQuota(workspace.id, workspace.plan);
        } catch (err) {
          results.push({
            pageId: page.id,
            name: page.name,
            status: 'skipped',
            detail: err instanceof Error ? err.message : 'Plan limit reached.',
          });
          continue;
        }
      }

      const tokenInfo = await debugToken(page.accessToken).catch(() => null);

      const account = await prisma.connectedAccount.upsert({
        where: { workspaceId_pageId: { workspaceId: workspace.id, pageId: page.id } },
        create: {
          workspaceId: workspace.id,
          pageId: page.id,
          pageName: page.name,
          pageUsername: page.username,
          pagePictureUrl: page.picture,
          pageUrl: page.link ?? `https://facebook.com/${page.id}`,
          accessTokenCipher: encrypt(page.accessToken),
          tokenExpiresAt: tokenInfo?.expiresAt ?? null,
          grantedScopes: tokenInfo?.scopes ?? [],
          status: 'active',
          color: PAGE_COLORS[colorIndex % PAGE_COLORS.length]!,
        },
        update: {
          pageName: page.name,
          pageUsername: page.username,
          pagePictureUrl: page.picture,
          pageUrl: page.link ?? `https://facebook.com/${page.id}`,
          accessTokenCipher: encrypt(page.accessToken),
          tokenExpiresAt: tokenInfo?.expiresAt ?? null,
          grantedScopes: tokenInfo?.scopes ?? [],
          status: 'active',
          statusDetail: null,
        },
      });
      colorIndex += 1;

      try {
        await subscribePageToWebhooks(page.id, page.accessToken);
        await setGetStarted(page.id, page.accessToken, 'LEADWAVE_GET_STARTED').catch(() => {
          // Optional nicety; a Page without it still works.
        });

        await prisma.connectedAccount.update({
          where: { id: account.id },
          data: { webhookSubscribedAt: new Date() },
        });

        // Every Page gets AI settings up front, switched off. Turning the
        // feature on later should not need a separate setup step.
        await prisma.aiSettings.upsert({
          where: { connectedAccountId: account.id },
          create: { connectedAccountId: account.id },
          update: {},
        });

        results.push({ pageId: page.id, name: page.name, status: 'connected' });
      } catch (err) {
        logger.error({ err, pageId: page.id }, 'webhook subscription failed');
        await prisma.connectedAccount.update({
          where: { id: account.id },
          data: {
            status: 'needs_reconnect',
            statusDetail: 'Could not subscribe this Page to Facebook updates.',
          },
        });
        results.push({
          pageId: page.id,
          name: page.name,
          status: 'failed',
          detail: 'Could not subscribe to Facebook updates.',
        });
      }
    }

    await redis.del(pagesKey(body.handoff));
    ok(res, { results });
  }),
);

metaRouter.delete(
  '/connected-accounts/:id',
  requireRole('admin'),
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));

    const account = await prisma.connectedAccount.findFirst({
      where: { id, workspaceId: req.workspace!.id },
    });
    if (!account) throw notFound('That Page is not connected.');

    const token = tryDecrypt(account.accessTokenCipher);
    if (token) {
      await unsubscribePageFromWebhooks(account.pageId, token).catch((err: unknown) => {
        // Disconnecting locally must succeed even if Meta is unreachable.
        logger.warn({ err, pageId: account.pageId }, 'could not unsubscribe page webhooks');
      });
    }

    await prisma.connectedAccount.delete({ where: { id: account.id } });
    ok(res, { disconnected: true });
  }),
);

/** Posts, for the automation builder's post picker. */
metaRouter.get(
  '/connected-accounts/:id/media',
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));
    const { cursor } = parseQuery(req, z.object({ cursor: z.string().optional() }));

    const account = await prisma.connectedAccount.findFirst({
      where: { id, workspaceId: req.workspace!.id },
    });
    if (!account) throw notFound('That Page is not connected.');

    const token = tryDecrypt(account.accessTokenCipher);
    if (!token) throw badRequest('Reconnect this Page to load its posts.');

    const { posts, nextCursor } = await listPagePosts(account.pageId, token, { after: cursor });

    ok(res, {
      posts: posts.map((post) => ({
        id: post.id,
        message: post.message ?? '',
        createdTime: post.created_time,
        permalink: post.permalink_url ?? null,
        thumbnail: post.full_picture ?? null,
        type: post.status_type ?? 'status',
      })),
      nextCursor,
    });
  }),
);

metaRouter.get(
  '/connected-accounts/:id/stories',
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));

    const account = await prisma.connectedAccount.findFirst({
      where: { id, workspaceId: req.workspace!.id },
    });
    if (!account) throw notFound('That Page is not connected.');

    const token = tryDecrypt(account.accessTokenCipher);
    if (!token) throw badRequest('Reconnect this Page to load its stories.');

    const stories = await listPageStories(account.pageId, token).catch(() => []);
    ok(res, { stories });
  }),
);

async function exchangeCodeForUserToken(code: string): Promise<string> {
  const url = new URL(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', env.META_APP_ID!);
  url.searchParams.set('client_secret', env.META_APP_SECRET!);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('code', code);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Facebook token exchange failed: ${await res.text()}`);

  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}
