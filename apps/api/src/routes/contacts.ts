import { Router } from 'express';
import { z } from 'zod';
import { prisma, type Prisma } from '@leadwave/db';
import { isWithinStandardWindow } from '@leadwave/shared';
import { notFound } from '../lib/errors.js';
import { created, handler, ok, parseBody, parseParams, parseQuery } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { attachWorkspace, loadAccountOrThrow, requireRole } from '../middleware/workspace.js';
import { assertFeature } from '../services/entitlements.js';
import { buildLeadExport, buildMetaAdsExport, toCsv } from '../services/leads.js';

/**
 * Contacts and leads.
 *
 * Exports are never gated behind a higher tier — a workspace's leads are its
 * own, and being able to leave with them is the point. The Meta Ads export is
 * the one exception, because building custom audiences is a Business feature.
 */

export const contactsRouter: Router = Router();
contactsRouter.use(requireAuth, attachWorkspace);

const idParam = z.object({ id: z.string().min(1) });

contactsRouter.get(
  '/',
  handler(async (req, res) => {
    const query = parseQuery(
      req,
      z.object({
        connectedAccountId: z.string().optional(),
        search: z.string().max(100).optional(),
        hasLead: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().optional(),
      }),
    );

    if (query.connectedAccountId) {
      await loadAccountOrThrow(req.workspace!.id, query.connectedAccountId);
    }

    const where: Prisma.ContactWhereInput = {
      ...(query.connectedAccountId
        ? { connectedAccountId: query.connectedAccountId }
        : { connectedAccount: { workspaceId: req.workspace!.id } }),
      ...(query.hasLead ? { leads: { some: {} } } : {}),
      ...(query.search
        ? {
            OR: [
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { leads: { some: { value: { contains: query.search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };

    const rows = await prisma.contact.findMany({
      where,
      include: {
        leads: { orderBy: { createdAt: 'desc' } },
        conversation: { select: { id: true, lastMessageAt: true } },
        connectedAccount: { select: { id: true, pageName: true, color: true } },
      },
      orderBy: { firstSeenAt: 'desc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const items = rows.slice(0, query.limit);
    const now = new Date();

    ok(res, {
      contacts: items.map((c) => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Someone',
        avatarUrl: c.profilePicUrl,
        page: c.connectedAccount,
        conversationId: c.conversation?.id ?? null,
        leads: c.leads.map((l) => ({ type: l.type, value: l.value, capturedAt: l.createdAt })),
        followConfirmed: Boolean(c.followConfirmedAt),
        optedOut: Boolean(c.optedOutAt),
        windowOpen: isWithinStandardWindow({ lastInboundAt: c.lastInboundAt }, now),
        firstSeenAt: c.firstSeenAt,
        lastInboundAt: c.lastInboundAt,
      })),
      nextCursor: rows.length > query.limit ? items.at(-1)?.id ?? null : null,
    });
  }),
);

contactsRouter.get(
  '/stats',
  handler(async (req, res) => {
    const { connectedAccountId } = parseQuery(
      req,
      z.object({ connectedAccountId: z.string().optional() }),
    );

    const scope = connectedAccountId
      ? { connectedAccountId }
      : { connectedAccount: { workspaceId: req.workspace!.id } };

    if (connectedAccountId) await loadAccountOrThrow(req.workspace!.id, connectedAccountId);

    const leadScope = connectedAccountId
      ? { connectedAccountId }
      : { connectedAccount: { workspaceId: req.workspace!.id } };

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [total, newThisWeek, emails, phones, followers, optedOut] = await Promise.all([
      prisma.contact.count({ where: scope }),
      prisma.contact.count({ where: { ...scope, firstSeenAt: { gte: weekAgo } } }),
      prisma.lead.count({ where: { ...leadScope, type: 'email' } }),
      prisma.lead.count({ where: { ...leadScope, type: 'phone' } }),
      prisma.contact.count({ where: { ...scope, followConfirmedAt: { not: null } } }),
      prisma.contact.count({ where: { ...scope, optedOutAt: { not: null } } }),
    ]);

    ok(res, {
      contacts: total,
      newThisWeek,
      emailLeads: emails,
      phoneLeads: phones,
      /** Confirmed by tap — Facebook exposes no per-user follow signal. */
      followsConfirmed: followers,
      optedOut,
    });
  }),
);

// ─── Notes ───────────────────────────────────────────────────────────────────

contactsRouter.get(
  '/:id/notes',
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    await loadContact(req.workspace!.id, id);

    const notes = await prisma.contactNote.findMany({
      where: { contactId: id },
      include: { author: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' },
    });
    ok(res, { notes });
  }),
);

contactsRouter.post(
  '/:id/notes',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const { body } = parseBody(req, z.object({ body: z.string().trim().min(1).max(2000) }));
    await loadContact(req.workspace!.id, id);

    const note = await prisma.contactNote.create({
      data: { contactId: id, authorId: req.user!.id, body },
      include: { author: { select: { id: true, name: true, avatarUrl: true } } },
    });
    created(res, note);
  }),
);

contactsRouter.delete(
  '/:id/notes/:noteId',
  requireRole('manager'),
  handler(async (req, res) => {
    const { noteId } = parseParams(req, z.object({ id: z.string(), noteId: z.string() }));

    const note = await prisma.contactNote.findFirst({
      where: { id: noteId, contact: { connectedAccount: { workspaceId: req.workspace!.id } } },
    });
    if (!note) throw notFound('That note does not exist.');

    await prisma.contactNote.delete({ where: { id: noteId } });
    ok(res, { deleted: true });
  }),
);

// ─── Export ──────────────────────────────────────────────────────────────────

contactsRouter.get(
  '/export/counts',
  handler(async (req, res) => {
    const { connectedAccountId } = parseQuery(req, z.object({ connectedAccountId: z.string() }));
    await loadAccountOrThrow(req.workspace!.id, connectedAccountId);

    // Opted-out contacts are excluded from every export, so the preview count
    // matches what actually downloads.
    const base = {
      connectedAccountId,
      OR: [{ contactId: null }, { contact: { optedOutAt: null } }],
    } satisfies Prisma.LeadWhereInput;

    const [all, emails, phones] = await Promise.all([
      prisma.lead.count({ where: base }),
      prisma.lead.count({ where: { ...base, type: 'email' } }),
      prisma.lead.count({ where: { ...base, type: 'phone' } }),
    ]);

    ok(res, { all, emails, phones });
  }),
);

contactsRouter.get(
  '/export',
  handler(async (req, res) => {
    const query = parseQuery(
      req,
      z.object({
        connectedAccountId: z.string().min(1),
        format: z.enum(['csv', 'meta_ads']).default('csv'),
        type: z.enum(['email', 'phone']).optional(),
      }),
    );

    const account = await loadAccountOrThrow(req.workspace!.id, query.connectedAccountId);
    const stamp = new Date().toISOString().slice(0, 10);
    const slug = account.pageName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);

    if (query.format === 'meta_ads') {
      assertFeature(req.workspace!.plan, 'meta_ads_export', 'The Meta Ads audience export');

      const csv = await buildMetaAdsExport(query.connectedAccountId);
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader(
        'content-disposition',
        `attachment; filename="leadwave-${slug}-meta-audience-${stamp}.csv"`,
      );
      res.send(csv);
      return;
    }

    const rows = await buildLeadExport(query.connectedAccountId, { type: query.type });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="leadwave-${slug}-leads-${stamp}.csv"`);
    res.send(toCsv(rows));
  }),
);

async function loadContact(workspaceId: string, id: string) {
  const contact = await prisma.contact.findFirst({
    where: { id, connectedAccount: { workspaceId } },
  });
  if (!contact) throw notFound('That contact does not exist.');
  return contact;
}
