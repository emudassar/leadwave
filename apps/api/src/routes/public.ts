import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@leadwave/db';
import { parseEmail } from '@leadwave/shared';
import { visitorHash } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { handler, ok, parseBody, parseParams } from '../lib/http.js';
import { rateLimit } from '../services/rate-limit.js';
import { recordClick } from '../services/shortlinks.js';
import { shortLinkUrl } from '../services/shortlinks.js';

/**
 * The unauthenticated surface: short-link redirects and public bio pages.
 *
 * Both are hot paths opened from inside the Facebook and Messenger in-app
 * browsers, so they are kept deliberately thin and are never allowed to be
 * cached — a cached redirect is a click nobody counts.
 */

export const publicRouter: Router = Router();

/**
 * The tracked link redirect.
 *
 * A failed click record must never cost someone the page they asked for, so the
 * redirect happens regardless of whether the write succeeded.
 */
publicRouter.get(
  '/r/:slug',
  handler(async (req, res) => {
    const { slug } = parseParams(req, z.object({ slug: z.string().min(1).max(32) }));

    const link = await prisma.shortLink.findUnique({
      where: { slug },
      select: { id: true, targetUrl: true },
    });
    if (!link) throw notFound('That link is no longer available.');

    res.setHeader('cache-control', 'no-store, max-age=0');
    res.setHeader('referrer-policy', 'no-referrer');
    res.redirect(302, link.targetUrl);

    // Recorded after the redirect is on the wire.
    void recordClick({
      slug,
      ip: req.ip ?? '',
      userAgent: req.get('user-agent') ?? '',
      referer: req.get('referer') ?? null,
      contactId: await resolveClicker(slug, req.ip ?? '', req.get('user-agent') ?? ''),
    }).catch(() => {
      // Analytics are not worth an error page.
    });
  }),
);

/**
 * Attributes an anonymous click to a contact where we can.
 *
 * A link sent to exactly one person can only have been tapped by that person,
 * which is what makes per-contact click attribution possible without tracking
 * anybody across the web.
 */
async function resolveClicker(
  slug: string,
  _ip: string,
  _userAgent: string,
): Promise<string | null> {
  const link = await prisma.shortLink.findUnique({
    where: { slug },
    select: { id: true, automationId: true },
  });
  if (!link?.automationId) return null;

  const recent = await prisma.message.findMany({
    where: {
      automationId: link.automationId,
      direction: 'outbound',
      status: { in: ['sent', 'delivered', 'read'] },
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
    select: { conversation: { select: { contactId: true } } },
    orderBy: { createdAt: 'desc' },
    take: 2,
  });

  // Only attribute when there is no ambiguity about who received it.
  const contactIds = new Set(recent.map((m) => m.conversation.contactId));
  return contactIds.size === 1 ? (recent[0]?.conversation.contactId ?? null) : null;
}

// ─── Public bio page ─────────────────────────────────────────────────────────

/**
 * Everything needed to render a bio page. Scheduled links are filtered here
 * rather than in the client, so a link that has not launched yet is never even
 * sent to the browser.
 */
publicRouter.get(
  '/api/public/bio/:handle',
  handler(async (req, res) => {
    const { handle } = parseParams(req, z.object({ handle: z.string().min(1).max(32) }));

    const page = await prisma.bioPage.findUnique({
      where: { handle: handle.toLowerCase() },
      include: {
        blocks: { orderBy: { position: 'asc' }, include: { shortLinks: true } },
      },
    });

    if (!page || !page.isPublished) throw notFound('No page here.');

    const now = new Date();
    const visible = page.blocks.filter((block) => {
      if (!block.isVisible) return false;
      if (block.visibleFrom && block.visibleFrom > now) return false;
      if (block.visibleUntil && block.visibleUntil < now) return false;
      return true;
    });

    res.setHeader('cache-control', 'public, max-age=60');

    ok(res, {
      page: {
        handle: page.handle,
        displayName: page.displayName,
        bio: page.bio,
        avatarUrl: page.avatarUrl,
        theme: page.theme,
        themeConfig: page.themeConfig,
        showBranding: page.showBranding,
        seo: {
          title: page.seoTitle ?? page.displayName,
          description: page.seoDescription ?? page.bio,
          image: page.seoImageUrl ?? page.avatarUrl,
          noIndex: page.seoNoIndex,
        },
      },
      blocks: visible.map((block) => ({
        id: block.id,
        type: block.type,
        title: block.title,
        subtitle: block.subtitle,
        imageUrl: block.imageUrl,
        config: block.config,
        // Always the tracked URL, so a bio tap counts like a DM tap.
        url: block.shortLinks[0] ? shortLinkUrl(block.shortLinks[0].slug) : block.url,
      })),
    });
  }),
);

/** A page view. Deduped per visitor per day so a refresh is not a new view. */
publicRouter.post(
  '/api/public/bio/:handle/view',
  handler(async (req, res) => {
    const { handle } = parseParams(req, z.object({ handle: z.string().min(1).max(32) }));

    const page = await prisma.bioPage.findUnique({
      where: { handle: handle.toLowerCase() },
      select: { id: true, isPublished: true },
    });
    if (!page?.isPublished) return ok(res, { recorded: false });

    const hash = visitorHash(req.ip ?? '', req.get('user-agent') ?? '');
    const allowed = await rateLimit(`bioview:${page.id}:${hash}`, 1, 86_400);
    if (!allowed) return ok(res, { recorded: false });

    await prisma.$transaction([
      prisma.bioPageView.create({
        data: {
          bioPageId: page.id,
          device: deviceFrom(req.get('user-agent') ?? ''),
          referer: req.get('referer')?.slice(0, 500) ?? null,
          visitorHash: hash,
        },
      }),
      prisma.bioPage.update({ where: { id: page.id }, data: { viewCount: { increment: 1 } } }),
    ]);

    ok(res, { recorded: true });
  }),
);

/** The inline email capture block. Goes straight into the workspace's leads. */
publicRouter.post(
  '/api/public/bio/:handle/subscribe',
  handler(async (req, res) => {
    const { handle } = parseParams(req, z.object({ handle: z.string().min(1).max(32) }));
    const body = parseBody(req, z.object({ email: z.string().min(3).max(254) }));

    const allowed = await rateLimit(`biosub:${req.ip}`, 10, 3_600);
    if (!allowed) throw badRequest('Too many attempts. Try again shortly.');

    const page = await prisma.bioPage.findUnique({
      where: { handle: handle.toLowerCase() },
      select: { id: true, workspaceId: true, isPublished: true },
    });
    if (!page?.isPublished) throw notFound('No page here.');

    const email = parseEmail(body.email);
    if (!email) throw badRequest("That doesn't look like an email address.");

    const account = await prisma.connectedAccount.findFirst({
      where: { workspaceId: page.workspaceId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    await prisma.lead.upsert({
      where: {
        connectedAccountId_type_value: {
          connectedAccountId: account?.id ?? '',
          type: 'email',
          value: email,
        },
      },
      create: {
        connectedAccountId: account?.id ?? null,
        bioPageId: page.id,
        type: 'email',
        value: email,
        rawValue: body.email.slice(0, 200),
        source: 'bio_page',
      },
      update: {},
    });

    ok(res, { subscribed: true }, "You're on the list.");
  }),
);

function deviceFrom(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(ua)) return 'tablet';
  if (/mobi|android|iphone|ipod/.test(ua)) return 'mobile';
  return 'desktop';
}
