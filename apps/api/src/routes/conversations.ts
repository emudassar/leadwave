import { Router } from 'express';
import { z } from 'zod';
import { prisma, type Prisma } from '@leadwave/db';
import {
  MAX_SCHEDULE_DAYS,
  isWithinHumanAgentWindow,
  isWithinStandardWindow,
  resolveSendEligibility,
  windowExpiresAt,
  type Plan,
} from '@leadwave/shared';
import { badRequest, notFound } from '../lib/errors.js';
import { created, handler, ok, parseBody, parseParams, parseQuery } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { attachWorkspace, loadAccountOrThrow, requireRole } from '../middleware/workspace.js';
import { assertFeature } from '../services/entitlements.js';
import { deliver } from '../services/send.js';
import { describeMessage } from '../services/message-builder.js';
import { cancelPendingFollowUps } from '../services/inbound.js';
import { cancelScheduledMessage, enqueueScheduledMessage } from '../queues/index.js';

/**
 * The Inbox.
 *
 * One screen for every connected Page. Two things here are not just CRUD: the
 * messaging-window state is surfaced explicitly so a user is never confused
 * about why they cannot reply, and a human reply silences LeadWave AI in that
 * thread for 48 hours — which is recorded here, at the moment they hit send.
 */

export const conversationsRouter: Router = Router();
conversationsRouter.use(requireAuth, attachWorkspace);

const idParam = z.object({ id: z.string().min(1) });

// ─── List ────────────────────────────────────────────────────────────────────

conversationsRouter.get(
  '/',
  handler(async (req, res) => {
    const query = parseQuery(
      req,
      z.object({
        connectedAccountId: z.string().optional(),
        filter: z.enum(['all', 'unread', 'ai', 'archived']).default('all'),
        labelId: z.string().optional(),
        search: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(25),
        cursor: z.string().optional(),
      }),
    );

    // No Page chosen means "every Page in this workspace" — the unified inbox.
    const accountFilter = query.connectedAccountId
      ? { connectedAccountId: query.connectedAccountId }
      : { connectedAccount: { workspaceId: req.workspace!.id } };

    if (query.connectedAccountId) {
      await loadAccountOrThrow(req.workspace!.id, query.connectedAccountId);
    }

    const where: Prisma.ConversationWhereInput = {
      ...accountFilter,
      isArchived: query.filter === 'archived',
      ...(query.filter === 'unread' ? { unreadCount: { gt: 0 } } : {}),
      ...(query.filter === 'ai' ? { hasAiActivity: true } : {}),
      ...(query.labelId ? { labels: { some: { labelId: query.labelId } } } : {}),
      ...(query.search
        ? {
            contact: {
              OR: [
                { firstName: { contains: query.search, mode: 'insensitive' } },
                { lastName: { contains: query.search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const rows = await prisma.conversation.findMany({
      where,
      include: {
        contact: true,
        connectedAccount: { select: { id: true, pageName: true, color: true } },
        labels: { include: { label: true } },
      },
      orderBy: [{ isPinned: 'desc' }, { lastMessageAt: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const items = rows.slice(0, query.limit);
    const now = new Date();

    ok(res, {
      conversations: items.map((c) => ({
        id: c.id,
        contact: {
          id: c.contact.id,
          name: [c.contact.firstName, c.contact.lastName].filter(Boolean).join(' ') || 'Someone',
          avatarUrl: c.contact.profilePicUrl,
        },
        page: c.connectedAccount,
        lastMessageAt: c.lastMessageAt,
        preview: c.lastMessagePreview,
        unreadCount: c.unreadCount,
        isPinned: c.isPinned,
        isArchived: c.isArchived,
        hasAiActivity: c.hasAiActivity,
        aiMuted: Boolean(c.aiMutedAt),
        windowOpen: isWithinStandardWindow({ lastInboundAt: c.contact.lastInboundAt }, now),
        labels: c.labels.map((l) => ({ id: l.label.id, name: l.label.name, color: l.label.color })),
      })),
      nextCursor: rows.length > query.limit ? items.at(-1)?.id ?? null : null,
    });
  }),
);

// ─── One conversation ────────────────────────────────────────────────────────

/**
 * Everything the composer needs to behave correctly: who they are, whether the
 * window is open, and if not, whether a human may still use the 7-day
 * human-agent allowance.
 */
conversationsRouter.get(
  '/:id/context',
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const conversation = await loadConversation(req.workspace!.id, id);

    const now = new Date();
    const state = { lastInboundAt: conversation.contact.lastInboundAt };
    const eligibility = resolveSendEligibility(state, { humanInitiated: true }, now);

    const [leads, notes, runs] = await Promise.all([
      prisma.lead.findMany({
        where: { contactId: conversation.contactId },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.contactNote.count({ where: { contactId: conversation.contactId } }),
      prisma.automationRun.findMany({
        where: { contactId: conversation.contactId },
        include: { automation: { select: { name: true } } },
        orderBy: { startedAt: 'desc' },
        take: 5,
      }),
    ]);

    ok(res, {
      id: conversation.id,
      contact: {
        id: conversation.contact.id,
        name:
          [conversation.contact.firstName, conversation.contact.lastName]
            .filter(Boolean)
            .join(' ') || 'Someone',
        avatarUrl: conversation.contact.profilePicUrl,
        locale: conversation.contact.locale,
        firstSeenAt: conversation.contact.firstSeenAt,
        optedOut: Boolean(conversation.contact.optedOutAt),
        followConfirmed: Boolean(conversation.contact.followConfirmedAt),
      },
      page: {
        id: conversation.connectedAccount.id,
        name: conversation.connectedAccount.pageName,
        color: conversation.connectedAccount.color,
      },
      window: {
        open: isWithinStandardWindow(state, now),
        expiresAt: windowExpiresAt(conversation.contact.lastInboundAt),
        humanAgentAvailable: isWithinHumanAgentWindow(state, now),
        canSend: eligibility.allowed,
      },
      ai: {
        muted: Boolean(conversation.aiMutedAt),
        hasActivity: conversation.hasAiActivity,
      },
      leads: leads.map((l) => ({ id: l.id, type: l.type, value: l.value, capturedAt: l.createdAt })),
      noteCount: notes,
      recentAutomations: runs.map((r) => ({
        id: r.id,
        name: r.automation.name,
        status: r.status,
        startedAt: r.startedAt,
      })),
    });
  }),
);

conversationsRouter.get(
  '/:id/messages',
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const query = parseQuery(
      req,
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(40),
        cursor: z.string().optional(),
      }),
    );

    await loadConversation(req.workspace!.id, id);

    const rows = await prisma.message.findMany({
      where: { conversationId: id },
      include: {
        sender: { select: { id: true, name: true, avatarUrl: true } },
        automation: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const items = rows.slice(0, query.limit);

    ok(res, {
      messages: items.reverse().map((m) => ({
        id: m.id,
        direction: m.direction,
        status: m.status,
        source: m.source,
        text: m.text,
        payload: m.payload,
        isAiGenerated: m.isAiGenerated,
        automation: m.automation,
        sender: m.sender,
        scheduledFor: m.scheduledFor,
        failureReason: m.failureReason,
        createdAt: m.createdAt,
      })),
      nextCursor: rows.length > query.limit ? rows[query.limit - 1]?.id ?? null : null,
    });
  }),
);

// ─── Sending ─────────────────────────────────────────────────────────────────

const composeSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  buttons: z
    .array(z.object({ label: z.string().max(20), url: z.string().url() }))
    .max(3)
    .optional(),
});

conversationsRouter.post(
  '/:id/messages',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, composeSchema);

    const conversation = await loadConversation(req.workspace!.id, id);
    const workspace = req.workspace!;

    const message = buildOutbound(body);

    const outcome = await deliver({
      account: conversation.connectedAccount,
      contact: conversation.contact,
      conversationId: conversation.id,
      message,
      text: body.text,
      source: 'human',
      plan: workspace.plan as Plan,
      workspaceId: workspace.id,
      senderId: req.user!.id,
      // A person is typing, so the human-agent window is available.
      humanInitiated: true,
      idempotencyKey: `human:${conversation.id}:${Date.now()}:${req.user!.id}`,
    });

    if (outcome.status === 'failed' || outcome.status === 'held') {
      throw badRequest(outcome.message);
    }

    // A human has taken this thread over. The AI stays quiet here for 48 hours,
    // and replying again resets the clock.
    await prisma.$transaction([
      prisma.contact.update({
        where: { id: conversation.contactId },
        data: { lastHumanReplyAt: new Date() },
      }),
      prisma.conversation.update({
        where: { id: conversation.id },
        data: { unreadCount: 0 },
      }),
    ]);

    await cancelPendingFollowUps(conversation.contactId, 'a human replied');

    created(res, { messageId: outcome.status === 'sent' ? outcome.messageId : null });
  }),
);

/**
 * Scheduling. Up to 7 days out, which matches the human-agent allowance. The
 * window is re-checked at send time, not here — if they have gone quiet by
 * then, the message is held rather than sent.
 */
conversationsRouter.post(
  '/:id/schedule',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(
      req,
      composeSchema.extend({ sendAt: z.coerce.date() }),
    );

    const workspace = req.workspace!;
    assertFeature(workspace.plan, 'schedule_messages', 'Scheduling messages');

    const conversation = await loadConversation(workspace.id, id);

    const maxAt = Date.now() + MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000;
    if (body.sendAt.getTime() > maxAt) {
      throw badRequest(`Messages can be scheduled up to ${MAX_SCHEDULE_DAYS} days ahead.`);
    }
    if (body.sendAt.getTime() < Date.now() + 30_000) {
      throw badRequest('Pick a time at least a minute from now.');
    }

    const payload = buildOutbound(body);

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'outbound',
        status: 'scheduled',
        source: 'scheduled',
        text: body.text,
        payload: payload as Prisma.InputJsonValue,
        senderId: req.user!.id,
        scheduledFor: body.sendAt,
        idempotencyKey: `scheduled:${conversation.id}:${body.sendAt.getTime()}`,
      },
    });

    await enqueueScheduledMessage(message.id, body.sendAt.getTime() - Date.now());
    created(res, { messageId: message.id, scheduledFor: message.scheduledFor });
  }),
);

conversationsRouter.delete(
  '/messages/:id/cancel-schedule',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);

    const message = await prisma.message.findFirst({
      where: {
        id,
        status: 'scheduled',
        conversation: { connectedAccount: { workspaceId: req.workspace!.id } },
      },
    });
    if (!message) throw notFound('That scheduled message does not exist.');

    await cancelScheduledMessage(message.id);
    await prisma.message.update({ where: { id: message.id }, data: { status: 'canceled' } });

    ok(res, { canceled: true });
  }),
);

// ─── Conversation state ──────────────────────────────────────────────────────

conversationsRouter.post(
  '/:id/mark-read',
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    await loadConversation(req.workspace!.id, id);
    await prisma.conversation.update({ where: { id }, data: { unreadCount: 0 } });
    ok(res, { unreadCount: 0 });
  }),
);

conversationsRouter.post(
  '/:id/pin',
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const { pinned } = parseBody(req, z.object({ pinned: z.boolean() }));
    await loadConversation(req.workspace!.id, id);
    await prisma.conversation.update({ where: { id }, data: { isPinned: pinned } });
    ok(res, { isPinned: pinned });
  }),
);

conversationsRouter.post(
  '/:id/archive',
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const { archived } = parseBody(req, z.object({ archived: z.boolean() }));
    await loadConversation(req.workspace!.id, id);
    await prisma.conversation.update({ where: { id }, data: { isArchived: archived } });
    ok(res, { isArchived: archived });
  }),
);

/** Per-thread AI mute. Takes effect on the next inbound message. */
conversationsRouter.post(
  '/:id/ai-mute',
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const { muted } = parseBody(req, z.object({ muted: z.boolean() }));
    await loadConversation(req.workspace!.id, id);

    await prisma.conversation.update({
      where: { id },
      data: { aiMutedAt: muted ? new Date() : null },
    });

    ok(res, { muted });
  }),
);

conversationsRouter.put(
  '/:id/labels',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const { labelIds } = parseBody(req, z.object({ labelIds: z.array(z.string()).max(20) }));

    const conversation = await loadConversation(req.workspace!.id, id);

    const valid = await prisma.label.findMany({
      where: { id: { in: labelIds }, connectedAccountId: conversation.connectedAccountId },
      select: { id: true },
    });

    await prisma.$transaction([
      prisma.conversationLabel.deleteMany({ where: { conversationId: id } }),
      prisma.conversationLabel.createMany({
        data: valid.map((l) => ({ conversationId: id, labelId: l.id })),
      }),
    ]);

    ok(res, { labelIds: valid.map((l) => l.id) });
  }),
);

// ─── Saved replies & labels ──────────────────────────────────────────────────

export const inboxRouter: Router = Router();
inboxRouter.use(requireAuth, attachWorkspace);

inboxRouter.get(
  '/saved-replies',
  handler(async (req, res) => {
    const { connectedAccountId } = parseQuery(req, z.object({ connectedAccountId: z.string() }));
    await loadAccountOrThrow(req.workspace!.id, connectedAccountId);

    const replies = await prisma.savedReply.findMany({
      where: { connectedAccountId },
      orderBy: [{ usageCount: 'desc' }, { createdAt: 'desc' }],
    });
    ok(res, { savedReplies: replies });
  }),
);

inboxRouter.post(
  '/saved-replies',
  requireRole('manager'),
  handler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({
        connectedAccountId: z.string().min(1),
        title: z.string().trim().min(1).max(80),
        body: z.string().trim().min(1).max(2000),
        shortcut: z.string().trim().max(24).optional(),
      }),
    );
    await loadAccountOrThrow(req.workspace!.id, body.connectedAccountId);

    const reply = await prisma.savedReply.create({
      data: {
        connectedAccountId: body.connectedAccountId,
        title: body.title,
        body: body.body,
        shortcut: body.shortcut ?? null,
      },
    });
    created(res, reply);
  }),
);

inboxRouter.delete(
  '/saved-replies/:id',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const reply = await prisma.savedReply.findFirst({
      where: { id, connectedAccount: { workspaceId: req.workspace!.id } },
    });
    if (!reply) throw notFound('That saved reply does not exist.');

    await prisma.savedReply.delete({ where: { id } });
    ok(res, { deleted: true });
  }),
);

inboxRouter.get(
  '/labels',
  handler(async (req, res) => {
    const { connectedAccountId } = parseQuery(req, z.object({ connectedAccountId: z.string() }));
    await loadAccountOrThrow(req.workspace!.id, connectedAccountId);

    const labels = await prisma.label.findMany({
      where: { connectedAccountId },
      orderBy: { name: 'asc' },
    });
    ok(res, { labels });
  }),
);

inboxRouter.post(
  '/labels',
  requireRole('manager'),
  handler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({
        connectedAccountId: z.string().min(1),
        name: z.string().trim().min(1).max(40),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748B'),
      }),
    );
    await loadAccountOrThrow(req.workspace!.id, body.connectedAccountId);

    const label = await prisma.label.create({
      data: {
        connectedAccountId: body.connectedAccountId,
        name: body.name,
        color: body.color,
      },
    });
    created(res, label);
  }),
);

inboxRouter.delete(
  '/labels/:id',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const label = await prisma.label.findFirst({
      where: { id, connectedAccount: { workspaceId: req.workspace!.id } },
    });
    if (!label) throw notFound('That label does not exist.');

    await prisma.label.delete({ where: { id } });
    ok(res, { deleted: true });
  }),
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildOutbound(body: z.infer<typeof composeSchema>): Record<string, unknown> {
  if (!body.buttons?.length) return { text: body.text };

  return {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'button',
        text: body.text.slice(0, 640),
        buttons: body.buttons.map((b) => ({
          type: 'web_url',
          title: b.label,
          url: b.url,
          webview_height_ratio: 'full',
        })),
      },
    },
  };
}

async function loadConversation(workspaceId: string, id: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id, connectedAccount: { workspaceId } },
    include: { contact: true, connectedAccount: true },
  });
  if (!conversation) throw notFound('That conversation does not exist.');
  return conversation;
}

export { describeMessage };
