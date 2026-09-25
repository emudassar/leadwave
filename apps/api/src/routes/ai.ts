import { Router } from 'express';
import { z } from 'zod';
import { prisma, type Prisma } from '@leadwave/db';
import {
  AI_LIMITS,
  DEFAULT_GUARDRAILS,
  GOAL_SUCCESS_CRITERIA,
  SYSTEM_GUARDRAILS,
  type Plan,
} from '@leadwave/shared';
import { badRequest, notFound } from '../lib/errors.js';
import { created, handler, ok, parseBody, parseParams, parseQuery } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { attachWorkspace, loadAccountOrThrow, requireRole } from '../middleware/workspace.js';
import { assertFeature } from '../services/entitlements.js';
import { creditBalance, skipBreakdown } from '../services/ai/credits.js';
import {
  assertKnowledgeCapacity,
  compileInterview,
  interviewQuestions,
  scanUrl,
} from '../services/ai/knowledge.js';
import { generateBrandVoice } from '../services/ai/generate.js';
import { deleteComment } from '../services/graph.js';
import { tryDecrypt } from '../lib/crypto.js';
import { enqueueKnowledgeRescan } from '../queues/index.js';
import { isGeminiConfigured } from '../services/ai/gemini.js';

/**
 * LeadWave AI.
 *
 * The API mirrors the product's shape: Knowledge is what it may say, Behavior
 * is how it says it, Goals are what a good reply should lead to, and Activity
 * is the receipts — including every time it decided to stay quiet.
 */

export const aiRouter: Router = Router();
aiRouter.use(requireAuth, attachWorkspace);

const accountQuery = z.object({ connectedAccountId: z.string().min(1) });
const idParam = z.object({ id: z.string().min(1) });

/** Every AI endpoint needs both the plan feature and an owned Page. */
async function requireAiAccess(req: Parameters<Parameters<typeof handler>[0]>[0]) {
  const plan = req.workspace!.plan as Plan;
  assertFeature(plan, 'ai_replies', 'LeadWave AI');

  const connectedAccountId =
    (req.query.connectedAccountId as string | undefined) ??
    (req.body as { connectedAccountId?: string } | undefined)?.connectedAccountId;

  if (!connectedAccountId) throw badRequest('Pick a Facebook Page first.');

  const account = await loadAccountOrThrow(req.workspace!.id, connectedAccountId);
  return { account, plan };
}

// ─── Overview ────────────────────────────────────────────────────────────────

aiRouter.get(
  '/settings',
  handler(async (req, res) => {
    const { connectedAccountId } = parseQuery(req, accountQuery);
    const account = await loadAccountOrThrow(req.workspace!.id, connectedAccountId);

    const settings = await prisma.aiSettings.upsert({
      where: { connectedAccountId: account.id },
      create: { connectedAccountId: account.id, guardrails: [...DEFAULT_GUARDRAILS] },
      update: {},
    });

    ok(res, {
      settings: {
        repliesEnabled: settings.repliesEnabled,
        commentsEnabled: settings.commentsEnabled,
        globallyPaused: settings.globallyPaused,
        role: settings.role,
        brandVoice: settings.brandVoice,
        guardrails: settings.guardrails.length ? settings.guardrails : [...DEFAULT_GUARDRAILS],
        languageMode: settings.languageMode,
        fixedLanguage: settings.fixedLanguage,
        commentScope: settings.commentScope,
        scopedPostIds: settings.scopedPostIds,
      },
      /** Shown read-only in the UI so the rules are never a mystery. */
      systemGuardrails: SYSTEM_GUARDRAILS,
      limits: AI_LIMITS,
      modelAvailable: isGeminiConfigured(),
    });
  }),
);

aiRouter.patch(
  '/settings',
  requireRole('manager'),
  handler(async (req, res) => {
    const { account } = await requireAiAccess(req);
    const body = parseBody(
      req,
      z.object({
        connectedAccountId: z.string(),
        repliesEnabled: z.boolean().optional(),
        commentsEnabled: z.boolean().optional(),
        globallyPaused: z.boolean().optional(),
        commentScope: z.enum(['recent_posts', 'selected_posts']).optional(),
        scopedPostIds: z.array(z.string()).max(50).optional(),
      }),
    );

    if (body.commentsEnabled) {
      assertFeature(req.workspace!.plan as Plan, 'ai_comments', 'AI comment replies');
    }

    const { connectedAccountId: _ignored, ...data } = body;

    const settings = await prisma.aiSettings.update({
      where: { connectedAccountId: account.id },
      data,
    });

    ok(res, { settings });
  }),
);

aiRouter.get(
  '/usage',
  handler(async (req, res) => {
    const { connectedAccountId } = parseQuery(req, accountQuery);
    const account = await loadAccountOrThrow(req.workspace!.id, connectedAccountId);
    const plan = req.workspace!.plan as Plan;

    const credits = await creditBalance(req.workspace!.id, plan);
    const sevenDays = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDays = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const counts = async (since: Date) => {
      const [messages, comments] = await Promise.all([
        prisma.aiEvent.count({
          where: { connectedAccountId: account.id, kind: 'message_reply', createdAt: { gte: since } },
        }),
        prisma.aiEvent.count({
          where: {
            connectedAccountId: account.id,
            kind: { in: ['comment_reply', 'comment_funnel'] },
            createdAt: { gte: since },
          },
        }),
      ]);
      return { messageReplies: messages, commentReplies: comments };
    };

    const [last7, last30, skips, goals] = await Promise.all([
      counts(sevenDays),
      counts(thirtyDays),
      skipBreakdown(account.id, thirtyDays),
      prisma.aiGoal.findMany({ where: { connectedAccountId: account.id } }),
    ]);

    ok(res, {
      credits,
      last7Days: last7,
      last30Days: last30,
      /** The credits you did not spend. Every one of these was free. */
      skipBreakdown: skips,
      skipTotal: skips.reduce((sum, s) => sum + s.count, 0),
      goals: goals.map((g) => ({
        id: g.id,
        type: g.type,
        status: g.status,
        attempted: g.attemptedCount,
        successful: g.successCount,
      })),
    });
  }),
);

// ─── Behavior ────────────────────────────────────────────────────────────────

aiRouter.get(
  '/behavior',
  handler(async (req, res) => {
    const { connectedAccountId } = parseQuery(req, accountQuery);
    const account = await loadAccountOrThrow(req.workspace!.id, connectedAccountId);

    const settings = await prisma.aiSettings.findUnique({
      where: { connectedAccountId: account.id },
    });

    ok(res, {
      role: settings?.role ?? null,
      brandVoice: settings?.brandVoice ?? null,
      guardrails: settings?.guardrails.length ? settings.guardrails : [...DEFAULT_GUARDRAILS],
      systemGuardrails: SYSTEM_GUARDRAILS,
      languageMode: settings?.languageMode ?? 'match_sender',
      fixedLanguage: settings?.fixedLanguage ?? null,
    });
  }),
);

aiRouter.patch(
  '/behavior',
  requireRole('manager'),
  handler(async (req, res) => {
    const { account } = await requireAiAccess(req);
    const body = parseBody(
      req,
      z.object({
        connectedAccountId: z.string(),
        role: z.string().trim().max(120).nullable().optional(),
        brandVoice: z.string().trim().max(1000).nullable().optional(),
        guardrails: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
        languageMode: z.enum(['match_sender', 'fixed']).optional(),
        fixedLanguage: z.string().trim().max(40).nullable().optional(),
      }),
    );

    const { connectedAccountId: _ignored, ...data } = body;

    const settings = await prisma.aiSettings.update({
      where: { connectedAccountId: account.id },
      data,
    });

    ok(res, { settings });
  }),
);

/** Drafts a voice from the role. Always editable — never applied silently. */
aiRouter.post(
  '/behavior/generate-voice',
  requireRole('manager'),
  handler(async (req, res) => {
    const { role } = parseBody(req, z.object({ role: z.string().trim().min(2).max(120) }));
    if (!isGeminiConfigured()) throw badRequest('The AI model is not configured yet.');

    const brandVoice = await generateBrandVoice(role);
    ok(res, { brandVoice });
  }),
);

// ─── Knowledge ───────────────────────────────────────────────────────────────

aiRouter.get(
  '/knowledge',
  handler(async (req, res) => {
    const { connectedAccountId } = parseQuery(req, accountQuery);
    const account = await loadAccountOrThrow(req.workspace!.id, connectedAccountId);

    const sources = await prisma.aiKnowledgeSource.findMany({
      where: { connectedAccountId: account.id },
      orderBy: { createdAt: 'asc' },
    });

    const used = sources.reduce((sum, s) => sum + s.charCount, 0);

    ok(res, {
      sources,
      usage: {
        sources: sources.length,
        maxSources: AI_LIMITS.maxKnowledgeSources,
        characters: used,
        maxCharacters: AI_LIMITS.maxKnowledgeCharsPerAccount,
      },
      /** Editing knowledge is always free. */
      creditCost: 0,
    });
  }),
);

aiRouter.post(
  '/knowledge',
  requireRole('manager'),
  handler(async (req, res) => {
    const { account } = await requireAiAccess(req);
    const body = parseBody(
      req,
      z.object({
        connectedAccountId: z.string(),
        type: z.enum(['link', 'text', 'interview']),
        title: z.string().trim().min(1).max(120),
        content: z.string().trim().min(1),
        sourceUrl: z.string().url().nullable().optional(),
      }),
    );

    await assertKnowledgeCapacity(account.id, body.content.length);

    const source = await prisma.aiKnowledgeSource.create({
      data: {
        connectedAccountId: account.id,
        type: body.type,
        title: body.title,
        content: body.content,
        charCount: body.content.length,
        sourceUrl: body.sourceUrl ?? null,
        lastScannedAt: body.type === 'link' ? new Date() : null,
      },
    });

    created(res, source);
  }),
);

aiRouter.patch(
  '/knowledge/:id',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const { account } = await requireAiAccess(req);
    const body = parseBody(
      req,
      z.object({
        connectedAccountId: z.string(),
        title: z.string().trim().min(1).max(120).optional(),
        content: z.string().trim().min(1).optional(),
        isEnabled: z.boolean().optional(),
      }),
    );

    const existing = await prisma.aiKnowledgeSource.findFirst({
      where: { id, connectedAccountId: account.id },
    });
    if (!existing) throw notFound('That knowledge source does not exist.');

    if (body.content) await assertKnowledgeCapacity(account.id, body.content.length, id);

    const source = await prisma.aiKnowledgeSource.update({
      where: { id },
      data: {
        ...(body.title ? { title: body.title } : {}),
        ...(body.content ? { content: body.content, charCount: body.content.length } : {}),
        ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
      },
    });

    ok(res, source);
  }),
);

aiRouter.delete(
  '/knowledge/:id',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const source = await prisma.aiKnowledgeSource.findFirst({
      where: { id, connectedAccount: { workspaceId: req.workspace!.id } },
    });
    if (!source) throw notFound('That knowledge source does not exist.');

    await prisma.aiKnowledgeSource.delete({ where: { id } });
    ok(res, { deleted: true });
  }),
);

/** Reads a page and returns a draft. Nothing is saved until the user approves. */
aiRouter.post(
  '/knowledge/scan',
  requireRole('manager'),
  handler(async (req, res) => {
    const { url } = parseBody(req, z.object({ url: z.string().min(1) }));
    if (!isGeminiConfigured()) throw badRequest('The AI model is not configured yet.');

    const result = await scanUrl(url);
    ok(res, { ...result, sourceUrl: url });
  }),
);

aiRouter.post(
  '/knowledge/:id/rescan',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const source = await prisma.aiKnowledgeSource.findFirst({
      where: { id, connectedAccount: { workspaceId: req.workspace!.id } },
    });
    if (!source) throw notFound('That knowledge source does not exist.');
    if (source.type !== 'link') throw badRequest('Only link sources can be re-scanned.');

    await enqueueKnowledgeRescan(id);
    ok(res, { queued: true });
  }),
);

aiRouter.get(
  '/knowledge/interview',
  handler(async (req, res) => {
    const { connectedAccountId } = parseQuery(req, accountQuery);
    const account = await loadAccountOrThrow(req.workspace!.id, connectedAccountId);

    const settings = await prisma.aiSettings.findUnique({
      where: { connectedAccountId: account.id },
    });

    ok(res, { questions: interviewQuestions(settings?.role ?? null) });
  }),
);

aiRouter.post(
  '/knowledge/interview',
  requireRole('manager'),
  handler(async (req, res) => {
    const { answers } = parseBody(
      req,
      z.object({
        answers: z
          .array(z.object({ question: z.string().max(300), answer: z.string().max(4000) }))
          .min(1)
          .max(AI_LIMITS.interviewMaxQuestions),
      }),
    );
    if (!isGeminiConfigured()) throw badRequest('The AI model is not configured yet.');

    const result = await compileInterview(answers);
    ok(res, result);
  }),
);

// ─── Goals ───────────────────────────────────────────────────────────────────

aiRouter.get(
  '/goals',
  handler(async (req, res) => {
    const { connectedAccountId } = parseQuery(req, accountQuery);
    const account = await loadAccountOrThrow(req.workspace!.id, connectedAccountId);

    const goals = await prisma.aiGoal.findMany({
      where: { connectedAccountId: account.id },
      orderBy: { createdAt: 'asc' },
    });

    ok(res, {
      goals: goals.map((g) => ({
        id: g.id,
        type: g.type,
        status: g.status,
        config: g.config,
        attempted: g.attemptedCount,
        successful: g.successCount,
        /** What success means, spelled out so the number is never ambiguous. */
        successCriteria: GOAL_SUCCESS_CRITERIA[g.type],
        createdAt: g.createdAt,
      })),
      maxLive: AI_LIMITS.maxLiveGoals,
    });
  }),
);

const goalBody = z.object({
  connectedAccountId: z.string(),
  type: z.enum(['share_link', 'capture_lead', 'grow_followers']),
  config: z
    .object({
      url: z.string().url().optional(),
      field: z.enum(['email', 'phone']).optional(),
    })
    .default({}),
});

aiRouter.post(
  '/goals',
  requireRole('manager'),
  handler(async (req, res) => {
    const { account } = await requireAiAccess(req);
    const body = parseBody(req, goalBody);

    if (body.type === 'share_link' && !body.config.url) {
      throw badRequest('Add the link this goal should share.');
    }

    // One goal per type is the intended setup, and at most three live.
    const existing = await prisma.aiGoal.findFirst({
      where: { connectedAccountId: account.id, type: body.type },
    });
    if (existing) throw badRequest('You already have a goal of that type. Edit it instead.');

    const live = await prisma.aiGoal.count({
      where: { connectedAccountId: account.id, status: 'live' },
    });
    if (live >= AI_LIMITS.maxLiveGoals) {
      throw badRequest(`You can run ${AI_LIMITS.maxLiveGoals} goals at once. Pause one first.`);
    }

    const goal = await prisma.aiGoal.create({
      data: {
        connectedAccountId: account.id,
        type: body.type,
        config: body.config as Prisma.InputJsonValue,
      },
    });

    created(res, goal);
  }),
);

aiRouter.patch(
  '/goals/:id',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(
      req,
      z.object({
        connectedAccountId: z.string(),
        status: z.enum(['live', 'paused']).optional(),
        config: z.object({ url: z.string().url().optional(), field: z.enum(['email', 'phone']).optional() }).optional(),
      }),
    );

    const goal = await prisma.aiGoal.findFirst({
      where: { id, connectedAccount: { workspaceId: req.workspace!.id } },
    });
    if (!goal) throw notFound('That goal does not exist.');

    const updated = await prisma.aiGoal.update({
      where: { id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.config ? { config: body.config as Prisma.InputJsonValue } : {}),
      },
    });

    ok(res, updated);
  }),
);

aiRouter.delete(
  '/goals/:id',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const goal = await prisma.aiGoal.findFirst({
      where: { id, connectedAccount: { workspaceId: req.workspace!.id } },
    });
    if (!goal) throw notFound('That goal does not exist.');

    await prisma.aiGoal.delete({ where: { id } });
    ok(res, { deleted: true });
  }),
);

// ─── Activity (the receipts) ─────────────────────────────────────────────────

aiRouter.get(
  '/activity',
  handler(async (req, res) => {
    const query = parseQuery(
      req,
      z.object({
        connectedAccountId: z.string().min(1),
        kind: z.string().optional(),
        goalId: z.string().optional(),
        hasGoal: z.coerce.boolean().optional(),
        includeSkips: z.coerce.boolean().default(true),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().optional(),
      }),
    );

    const account = await loadAccountOrThrow(req.workspace!.id, query.connectedAccountId);

    const where: Prisma.AiEventWhereInput = {
      connectedAccountId: account.id,
      ...(query.kind ? { kind: query.kind as never } : {}),
      ...(query.goalId ? { goalId: query.goalId } : {}),
      ...(query.hasGoal ? { goalId: { not: null } } : {}),
      ...(query.includeSkips ? {} : { kind: { notIn: ['message_skip', 'comment_skip'] } }),
      ...(query.from || query.to
        ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
    };

    const rows = await prisma.aiEvent.findMany({
      where,
      include: {
        goal: { select: { id: true, type: true } },
        contact: { select: { id: true, firstName: true, lastName: true, profilePicUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const items = rows.slice(0, query.limit);

    ok(res, {
      events: items.map((e) => ({
        id: e.id,
        kind: e.kind,
        label: e.label,
        skipReason: e.skipReason,
        triggerText: e.triggerText,
        replyText: e.replyText,
        goal: e.goal,
        goalSucceeded: Boolean(e.goalSucceededAt),
        creditsCharged: e.creditsCharged,
        conversationId: e.conversationId,
        contact: e.contact
          ? {
              id: e.contact.id,
              name: [e.contact.firstName, e.contact.lastName].filter(Boolean).join(' ') || 'Someone',
              avatarUrl: e.contact.profilePicUrl,
            }
          : null,
        postId: e.postId,
        commentId: e.commentId,
        canDeleteComment: Boolean(e.externalReplyId),
        createdAt: e.createdAt,
      })),
      nextCursor: rows.length > query.limit ? items.at(-1)?.id ?? null : null,
    });
  }),
);

/** Removing an AI comment reply from the post, straight from the activity feed. */
aiRouter.delete(
  '/activity/:id/comment',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);

    const event = await prisma.aiEvent.findFirst({
      where: { id, connectedAccount: { workspaceId: req.workspace!.id } },
      include: { connectedAccount: true },
    });
    if (!event?.externalReplyId) throw notFound('There is no posted reply to remove.');

    const token = tryDecrypt(event.connectedAccount.accessTokenCipher);
    if (!token) throw badRequest('Reconnect this Page first.');

    await deleteComment(event.externalReplyId, token);

    await prisma.$transaction([
      prisma.aiEvent.update({ where: { id }, data: { externalReplyId: null } }),
      prisma.commentReply.deleteMany({
        where: { externalReplyId: event.externalReplyId },
      }),
    ]);

    ok(res, { deleted: true });
  }),
);
