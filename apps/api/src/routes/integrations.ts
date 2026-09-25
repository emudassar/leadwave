import { Router } from 'express';
import { z } from 'zod';
import { prisma, type Prisma } from '@leadwave/db';
import type { Plan } from '@leadwave/shared';
import { configured, env } from '../env.js';
import { encrypt, randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { handler, ok, parseBody, parseParams, parseQuery } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';
import { requireAuth } from '../middleware/auth.js';
import { attachWorkspace, loadAccountOrThrow, requireRole } from '../middleware/workspace.js';
import { assertFeature } from '../services/entitlements.js';
import {
  authUrl,
  exchangeCode,
  listTabs,
  type SheetsConfig,
} from '../services/integrations/google-sheets.js';

/**
 * Integrations. Today that means Google Sheets, connected per Page so an agency
 * can keep each client's leads in that client's own spreadsheet.
 */

export const integrationsRouter: Router = Router();

const idParam = z.object({ id: z.string().min(1) });
const stateKey = (state: string) => `oauth:sheets:${sha256(state)}`;

/**
 * The OAuth callback has no session cookie to rely on in every browser, so the
 * workspace and Page are carried in the signed one-time state instead.
 */
integrationsRouter.get(
  '/google-sheets/callback',
  handler(async (req, res) => {
    const query = parseQuery(
      req,
      z.object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      }),
    );

    const done = (params: string) => res.redirect(`${env.APP_URL}/settings?${params}`);

    if (query.error || !query.code || !query.state) {
      return done(`sheets_error=${encodeURIComponent(query.error ?? 'cancelled')}`);
    }

    const raw = await redis.getdel(stateKey(query.state));
    if (!raw) return done('sheets_error=expired');

    const { workspaceId, connectedAccountId } = JSON.parse(raw) as {
      workspaceId: string;
      connectedAccountId: string;
    };

    try {
      const tokens = await exchangeCode(query.code);

      await prisma.integration.upsert({
        where: { connectedAccountId_type: { connectedAccountId, type: 'google_sheets' } },
        create: {
          workspaceId,
          connectedAccountId,
          type: 'google_sheets',
          accessTokenCipher: encrypt(tokens.accessToken),
          refreshTokenCipher: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
          tokenExpiresAt: tokens.expiresAt,
          config: { tabStrategy: 'monthly' } as Prisma.InputJsonValue,
        },
        update: {
          accessTokenCipher: encrypt(tokens.accessToken),
          // Google only re-issues a refresh token on first consent, so keep the
          // one we already have when it is not re-sent.
          ...(tokens.refreshToken ? { refreshTokenCipher: encrypt(tokens.refreshToken) } : {}),
          tokenExpiresAt: tokens.expiresAt,
          isEnabled: true,
          lastError: null,
        },
      });

      done('sheets_connected=1');
    } catch (err) {
      logger.error({ err }, 'google sheets connect failed');
      done('sheets_error=failed');
    }
  }),
);

integrationsRouter.use(requireAuth, attachWorkspace);

integrationsRouter.get(
  '/',
  handler(async (req, res) => {
    const integrations = await prisma.integration.findMany({
      where: { workspaceId: req.workspace!.id },
      include: { connectedAccount: { select: { id: true, pageName: true } } },
    });

    ok(res, {
      integrations: integrations.map((i) => ({
        id: i.id,
        type: i.type,
        isEnabled: i.isEnabled,
        page: i.connectedAccount,
        config: i.config,
        lastSyncAt: i.lastSyncAt,
        lastError: i.lastError,
        needsReauth: !i.refreshTokenCipher,
      })),
      available: {
        google_sheets: {
          configured: configured.googleSheets,
          requiresPlan: 'business',
        },
      },
    });
  }),
);

integrationsRouter.post(
  '/google-sheets/connect',
  requireRole('admin'),
  handler(async (req, res) => {
    const { connectedAccountId } = parseBody(
      req,
      z.object({ connectedAccountId: z.string().min(1) }),
    );

    assertFeature(req.workspace!.plan as Plan, 'google_sheets', 'The Google Sheets integration');
    if (!configured.googleSheets) {
      throw badRequest('Google Sheets is not configured on this deployment.');
    }

    await loadAccountOrThrow(req.workspace!.id, connectedAccountId);

    const state = randomToken(24);
    await redis.setex(
      stateKey(state),
      600,
      JSON.stringify({ workspaceId: req.workspace!.id, connectedAccountId }),
    );

    ok(res, { url: authUrl(state) });
  }),
);

integrationsRouter.patch(
  '/:id',
  requireRole('admin'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(
      req,
      z.object({
        isEnabled: z.boolean().optional(),
        spreadsheetId: z.string().trim().max(120).optional(),
        spreadsheetName: z.string().trim().max(200).optional(),
        tabStrategy: z.enum(['monthly', 'single']).optional(),
        tabName: z.string().trim().max(80).optional(),
      }),
    );

    const integration = await loadIntegration(req.workspace!.id, id);
    const config = { ...((integration.config as SheetsConfig) ?? {}) };

    if (body.spreadsheetId !== undefined) config.spreadsheetId = extractSheetId(body.spreadsheetId);
    if (body.spreadsheetName !== undefined) config.spreadsheetName = body.spreadsheetName;
    if (body.tabStrategy !== undefined) config.tabStrategy = body.tabStrategy;
    if (body.tabName !== undefined) config.tabName = body.tabName;

    const updated = await prisma.integration.update({
      where: { id },
      data: {
        ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
        config: config as Prisma.InputJsonValue,
        lastError: null,
      },
    });

    ok(res, { id: updated.id, config: updated.config, isEnabled: updated.isEnabled });
  }),
);

integrationsRouter.get(
  '/:id/sheets/tabs',
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const integration = await loadIntegration(req.workspace!.id, id);

    const tabs = await listTabs(integration).catch((err: unknown) => {
      logger.warn({ err, integrationId: id }, 'could not list sheet tabs');
      return [];
    });

    ok(res, { tabs });
  }),
);

integrationsRouter.delete(
  '/:id',
  requireRole('admin'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    await loadIntegration(req.workspace!.id, id);
    await prisma.integration.delete({ where: { id } });
    ok(res, { disconnected: true });
  }),
);

async function loadIntegration(workspaceId: string, id: string) {
  const integration = await prisma.integration.findFirst({ where: { id, workspaceId } });
  if (!integration) throw notFound('That integration is not connected.');
  return integration;
}

/** People paste the whole Sheets URL far more often than the bare id. */
function extractSheetId(input: string): string {
  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? input.trim();
}
