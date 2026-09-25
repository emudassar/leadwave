import { Router } from 'express';
import { z } from 'zod';
import { prisma, type Prisma } from '@leadwave/db';
import {
  automationDefinitionSchema,
  validateDefinition,
  type AutomationDefinition,
  type Feature,
} from '@leadwave/shared';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { created, handler, ok, parseBody, parseParams, parseQuery } from '../lib/http.js';
import { tryDecrypt } from '../lib/crypto.js';
import { requireAuth } from '../middleware/auth.js';
import { attachWorkspace, loadAccountOrThrow, requireRole } from '../middleware/workspace.js';
import {
  analyticsFloor,
  assertAutomationQuota,
  assertFeature,
  assertIceBreakerQuota,
} from '../services/entitlements.js';
import { syncAutomationLinks } from '../services/shortlinks.js';
import { iceBreakerPayload } from '../services/dispatcher.js';
import { setIceBreakers } from '../services/graph.js';
import { enqueueRetrigger } from '../queues/index.js';

/**
 * Automations: build, publish, measure, and re-run over old comments.
 *
 * Feature gating happens on save *and* on publish. Checking only at save time
 * would let a downgraded workspace keep running a feature it no longer pays
 * for; checking only at publish would let the builder accept work it will
 * later reject.
 */

export const automationsRouter: Router = Router();
automationsRouter.use(requireAuth, attachWorkspace);

const accountQuery = z.object({ connectedAccountId: z.string().min(1) });

/** Which plan feature each part of a definition needs. */
function featuresUsedBy(definition: AutomationDefinition): Array<{ feature: Feature; label: string }> {
  const needed: Array<{ feature: Feature; label: string }> = [];
  const trigger = definition.trigger;

  if (trigger.type === 'comment' && trigger.scope.kind !== 'specific') {
    needed.push({ feature: 'trigger_next_post', label: 'Running on every post' });
  }
  if (trigger.type === 'ice_breaker') {
    needed.push({ feature: 'trigger_ice_breaker', label: 'Ice breakers' });
  }

  for (const step of definition.steps) {
    if (step.type === 'product_carousel') {
      needed.push({ feature: 'action_product_carousel', label: 'The product carousel' });
    }
    if (step.type === 'follow_gate') {
      needed.push({ feature: 'action_follow_gate', label: 'The Follow Gate' });
    }
    if (step.type === 'ask_phone') {
      needed.push({ feature: 'action_lead_capture_phone', label: 'Phone number capture' });
    }
    if (step.type === 'follow_up') {
      needed.push({ feature: 'action_follow_up', label: 'The follow-up nudge' });
    }
    if (
      (step.type === 'send_message' || step.type === 'follow_up') &&
      step.buttons.filter((b) => b.kind === 'url').length > 1
    ) {
      needed.push({ feature: 'multiple_button_links', label: 'More than one link in a message' });
    }
  }

  return needed;
}

function assertDefinitionAllowed(plan: string, definition: AutomationDefinition): void {
  for (const { feature, label } of featuresUsedBy(definition)) {
    assertFeature(plan as never, feature, label);
  }
}

/** Pull the hot-path filters out of the definition so webhooks stay cheap. */
function denormalise(definition: AutomationDefinition) {
  const trigger = definition.trigger;

  const keywords =
    trigger.type === 'comment' || trigger.type === 'dm_keyword' || trigger.type === 'story_reply'
      ? trigger.keywords.keywords.map((k) => k.toLowerCase())
      : [];

  const scope = trigger.type === 'comment' ? trigger.scope : null;

  return {
    keywords,
    postIds: scope?.kind === 'specific' ? scope.postIds : [],
    watchesAllPosts: scope?.kind === 'all_posts',
    watchesNextPost: scope?.kind === 'next_post',
  };
}

// ─── List & read ─────────────────────────────────────────────────────────────

automationsRouter.get(
  '/',
  handler(async (req, res) => {
    const { connectedAccountId } = parseQuery(req, accountQuery);
    await loadAccountOrThrow(req.workspace!.id, connectedAccountId);

    const automations = await prisma.automation.findMany({
      where: { connectedAccountId },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      include: {
        _count: { select: { runs: true } },
        shortLinks: { select: { clickCount: true, uniqueClickCount: true } },
      },
    });

    ok(res, {
      automations: automations.map((a) => ({
        id: a.id,
        name: a.name,
        triggerType: a.triggerType,
        status: a.status,
        keywords: a.keywords,
        runCount: a._count.runs,
        clicks: a.shortLinks.reduce((sum, l) => sum + l.clickCount, 0),
        uniqueClicks: a.shortLinks.reduce((sum, l) => sum + l.uniqueClickCount, 0),
        lastTriggeredAt: a.lastTriggeredAt,
        publishedAt: a.publishedAt,
        updatedAt: a.updatedAt,
      })),
    });
  }),
);

automationsRouter.get(
  '/:id',
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));
    const automation = await loadAutomation(req.workspace!.id, id);

    ok(res, {
      id: automation.id,
      connectedAccountId: automation.connectedAccountId,
      name: automation.name,
      status: automation.status,
      triggerType: automation.triggerType,
      definition: automation.definition,
      publishedAt: automation.publishedAt,
      updatedAt: automation.updatedAt,
    });
  }),
);

// ─── Create & update ─────────────────────────────────────────────────────────

automationsRouter.post(
  '/',
  requireRole('manager'),
  handler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({
        connectedAccountId: z.string().min(1),
        definition: automationDefinitionSchema,
      }),
    );

    const workspace = req.workspace!;
    await loadAccountOrThrow(workspace.id, body.connectedAccountId);
    await assertAutomationQuota(workspace.id, workspace.plan);
    assertDefinitionAllowed(workspace.plan, body.definition);

    const issues = validateDefinition(body.definition);
    if (issues.length > 0) throw badRequest('This automation needs a few fixes.', issues);

    const automation = await prisma.automation.create({
      data: {
        connectedAccountId: body.connectedAccountId,
        name: body.definition.name,
        triggerType: body.definition.trigger.type,
        definition: body.definition as unknown as Prisma.InputJsonValue,
        ...denormalise(body.definition),
      },
    });

    created(res, { id: automation.id });
  }),
);

automationsRouter.patch(
  '/:id',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));
    const body = parseBody(req, z.object({ definition: automationDefinitionSchema }));

    const workspace = req.workspace!;
    const existing = await loadAutomation(workspace.id, id);
    assertDefinitionAllowed(workspace.plan, body.definition);

    const issues = validateDefinition(body.definition);
    if (issues.length > 0) throw badRequest('This automation needs a few fixes.', issues);

    const automation = await prisma.automation.update({
      where: { id: existing.id },
      data: {
        name: body.definition.name,
        triggerType: body.definition.trigger.type,
        definition: body.definition as unknown as Prisma.InputJsonValue,
        ...denormalise(body.definition),
      },
    });

    // Keep the tracked links in step with the buttons. Unchanged destinations
    // keep their slug, so historical click data survives an edit.
    await syncAutomationLinks(automation.id, automation.connectedAccountId, body.definition);

    if (automation.status === 'live' && automation.triggerType === 'ice_breaker') {
      await syncIceBreakers(workspace.id, automation.connectedAccountId, workspace.plan);
    }

    ok(res, { id: automation.id, updatedAt: automation.updatedAt });
  }),
);

automationsRouter.post(
  '/:id/publish',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));
    const workspace = req.workspace!;
    const automation = await loadAutomation(workspace.id, id);

    const parsed = automationDefinitionSchema.safeParse(automation.definition);
    if (!parsed.success) throw badRequest('This automation is incomplete.');

    assertDefinitionAllowed(workspace.plan, parsed.data);
    const issues = validateDefinition(parsed.data);
    if (issues.length > 0) throw badRequest('Fix these before publishing.', issues);

    const account = await loadAccountOrThrow(workspace.id, automation.connectedAccountId);
    if (account.status !== 'active') {
      throw conflict('Reconnect this Facebook Page before publishing.');
    }

    await syncAutomationLinks(automation.id, automation.connectedAccountId, parsed.data);

    await prisma.automation.update({
      where: { id: automation.id },
      data: { status: 'live', publishedAt: automation.publishedAt ?? new Date() },
    });

    if (automation.triggerType === 'ice_breaker') {
      await syncIceBreakers(workspace.id, automation.connectedAccountId, workspace.plan);
    }

    ok(res, { id: automation.id, status: 'live' }, 'Your automation is live.');
  }),
);

automationsRouter.post(
  '/:id/pause',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));
    const workspace = req.workspace!;
    const automation = await loadAutomation(workspace.id, id);

    await prisma.automation.update({ where: { id: automation.id }, data: { status: 'paused' } });

    if (automation.triggerType === 'ice_breaker') {
      await syncIceBreakers(workspace.id, automation.connectedAccountId, workspace.plan);
    }

    ok(res, { id: automation.id, status: 'paused' });
  }),
);

automationsRouter.post(
  '/:id/duplicate',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));
    const workspace = req.workspace!;
    const original = await loadAutomation(workspace.id, id);
    await assertAutomationQuota(workspace.id, workspace.plan);

    const parsed = automationDefinitionSchema.safeParse(original.definition);
    if (!parsed.success) throw badRequest('This automation is incomplete.');

    // The copy starts as a draft, and its links are minted fresh so the two do
    // not share click attribution.
    const definition: AutomationDefinition = {
      ...parsed.data,
      name: `${parsed.data.name} (copy)`.slice(0, 80),
    };

    const copy = await prisma.automation.create({
      data: {
        connectedAccountId: original.connectedAccountId,
        name: definition.name,
        triggerType: definition.trigger.type,
        definition: definition as unknown as Prisma.InputJsonValue,
        status: 'draft',
        ...denormalise(definition),
      },
    });

    created(res, { id: copy.id });
  }),
);

automationsRouter.delete(
  '/:id',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));
    const workspace = req.workspace!;
    const automation = await loadAutomation(workspace.id, id);

    await prisma.automation.delete({ where: { id: automation.id } });

    if (automation.triggerType === 'ice_breaker') {
      await syncIceBreakers(workspace.id, automation.connectedAccountId, workspace.plan);
    }

    ok(res, { deleted: true });
  }),
);

// ─── Insights ────────────────────────────────────────────────────────────────

automationsRouter.get(
  '/:id/insights',
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));
    const workspace = req.workspace!;
    const automation = await loadAutomation(workspace.id, id);

    // Free plans see 30 days; paid plans see everything.
    const floor = analyticsFloor(workspace.plan);
    const since = floor ?? automation.createdAt;

    const [runs, completed, links, leads, gateUnlocks, followUps] = await Promise.all([
      prisma.automationRun.count({ where: { automationId: id, startedAt: { gte: since } } }),
      prisma.automationRun.count({
        where: { automationId: id, status: 'completed', startedAt: { gte: since } },
      }),
      prisma.shortLink.findMany({
        where: { automationId: id },
        select: { clickCount: true, uniqueClickCount: true },
      }),
      prisma.lead.count({ where: { automationId: id, createdAt: { gte: since } } }),
      prisma.automationRun.count({
        where: {
          automationId: id,
          startedAt: { gte: since },
          contact: { followConfirmedAt: { not: null } },
        },
      }),
      prisma.followUpJob.groupBy({
        by: ['status'],
        where: { automationId: id, createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);

    const clicks = links.reduce((sum, l) => sum + l.clickCount, 0);
    const uniqueClicks = links.reduce((sum, l) => sum + l.uniqueClickCount, 0);

    const messagesSent = await prisma.message.count({
      where: {
        automationId: id,
        direction: 'outbound',
        status: { in: ['sent', 'delivered', 'read'] },
        createdAt: { gte: since },
      },
    });

    ok(res, {
      since,
      retentionDays: floor ? 30 : null,
      triggered: runs,
      completed,
      messagesSent,
      clicks,
      uniqueClicks,
      /** Taps divided by people who received it — the number that matters. */
      ctr: runs > 0 ? Number(((uniqueClicks / runs) * 100).toFixed(1)) : 0,
      leads,
      /**
       * Follow Gate unlocks. Facebook exposes no per-user follow signal, so
       * these are confirmed by tap rather than verified against Meta.
       */
      gateUnlocks,
      gateUnlockKind: 'self_confirmed',
      followUps: Object.fromEntries(followUps.map((f) => [f.status, f._count._all])),
    });
  }),
);

/** Per-button, per-card click data — what turns "47 clicks" into real demand. */
automationsRouter.get(
  '/:id/click-intel',
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));
    await loadAutomation(req.workspace!.id, id);

    const links = await prisma.shortLink.findMany({
      where: { automationId: id },
      orderBy: { clickCount: 'desc' },
    });

    const totalClicks = links.reduce((sum, l) => sum + l.clickCount, 0);

    const deviceSplit = await prisma.linkClick.groupBy({
      by: ['device'],
      where: { shortLink: { automationId: id } },
      _count: { _all: true },
    });

    ok(res, {
      totalClicks,
      links: links.map((l) => ({
        id: l.id,
        slug: l.slug,
        targetUrl: l.targetUrl,
        stepId: l.stepId,
        cardId: l.cardId,
        buttonIndex: l.buttonIndex,
        clicks: l.clickCount,
        uniqueClicks: l.uniqueClickCount,
        shareOfClicks:
          totalClicks > 0 ? Number(((l.clickCount / totalClicks) * 100).toFixed(1)) : 0,
      })),
      devices: Object.fromEntries(
        deviceSplit.map((d) => [d.device ?? 'unknown', d._count._all]),
      ),
    });
  }),
);

// ─── Retrigger ───────────────────────────────────────────────────────────────

automationsRouter.post(
  '/:id/retrigger/scan',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));
    const body = parseBody(req, z.object({ postId: z.string().min(1) }));

    const workspace = req.workspace!;
    assertFeature(workspace.plan, 'retrigger', 'Re-running an automation on old comments');

    const automation = await loadAutomation(workspace.id, id);
    if (automation.triggerType !== 'comment') {
      throw badRequest('Only comment automations can be re-run.');
    }
    if (automation.status !== 'live') {
      throw badRequest('Publish this automation before re-running it.');
    }

    const active = await prisma.retriggerRun.findFirst({
      where: { automationId: id, status: { in: ['scanning', 'running'] } },
    });
    if (active) throw conflict('A re-run is already in progress for this automation.');

    const run = await prisma.retriggerRun.create({
      data: {
        connectedAccountId: automation.connectedAccountId,
        automationId: automation.id,
        postId: body.postId,
      },
    });

    await enqueueRetrigger(run.id, 'scan');
    created(res, { retriggerRunId: run.id, status: 'scanning' });
  }),
);

automationsRouter.get(
  '/:id/retrigger/status',
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));
    await loadAutomation(req.workspace!.id, id);

    const run = await prisma.retriggerRun.findFirst({
      where: { automationId: id },
      orderBy: { createdAt: 'desc' },
    });
    if (!run) return ok(res, { run: null });

    ok(res, {
      run: {
        id: run.id,
        postId: run.postId,
        status: run.status,
        scanned: run.scannedCount,
        matched: run.matchedCount,
        sent: run.sentCount,
        skipped: run.skippedCount,
        failed: run.failedCount,
        skipBreakdown: run.skipBreakdown,
        error: run.error,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      },
    });
  }),
);

export const retriggerRunsRouter: Router = Router();
retriggerRunsRouter.use(requireAuth, attachWorkspace, requireRole('manager'));

retriggerRunsRouter.post(
  '/:id/start',
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));

    const run = await prisma.retriggerRun.findFirst({
      where: { id, connectedAccount: { workspaceId: req.workspace!.id } },
    });
    if (!run) throw notFound('That re-run does not exist.');
    if (run.status !== 'ready' && run.status !== 'paused') {
      throw conflict('That re-run cannot be started from its current state.');
    }

    await prisma.retriggerRun.update({
      where: { id: run.id },
      data: { status: 'running', startedAt: new Date(), cursor: null },
    });
    await enqueueRetrigger(run.id, 'send');

    ok(res, { status: 'running' });
  }),
);

retriggerRunsRouter.post(
  '/:id/stop',
  handler(async (req, res) => {
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));

    const run = await prisma.retriggerRun.findFirst({
      where: { id, connectedAccount: { workspaceId: req.workspace!.id } },
    });
    if (!run) throw notFound('That re-run does not exist.');

    await prisma.retriggerRun.update({ where: { id: run.id }, data: { status: 'paused' } });
    ok(res, { status: 'paused' });
  }),
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadAutomation(workspaceId: string, id: string) {
  const automation = await prisma.automation.findFirst({
    where: { id, connectedAccount: { workspaceId } },
  });
  if (!automation) throw notFound('That automation does not exist.');
  return automation;
}

/**
 * Pushes the Page's live ice breakers to Messenger.
 *
 * Meta stores one list per Page, so the whole set is rebuilt from the live
 * ice-breaker automations every time one changes — there is no partial update.
 */
async function syncIceBreakers(
  workspaceId: string,
  connectedAccountId: string,
  plan: string,
): Promise<void> {
  const account = await loadAccountOrThrow(workspaceId, connectedAccountId);
  const token = tryDecrypt(account.accessTokenCipher);
  if (!token) return;

  const automations = await prisma.automation.findMany({
    where: { connectedAccountId, triggerType: 'ice_breaker', status: 'live' },
    orderBy: { createdAt: 'asc' },
  });

  const entries: Array<{ question: string; payload: string }> = [];
  for (const automation of automations) {
    const parsed = automationDefinitionSchema.safeParse(automation.definition);
    if (!parsed.success || parsed.data.trigger.type !== 'ice_breaker') continue;
    entries.push({
      question: parsed.data.trigger.question,
      payload: iceBreakerPayload(automation.id),
    });
  }

  assertIceBreakerQuota(plan as never, Math.max(0, entries.length - 1));
  await setIceBreakers(account.pageId, token, entries);
}
