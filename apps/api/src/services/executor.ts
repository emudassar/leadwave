import {
  prisma,
  type AutomationRun,
  type ConnectedAccount,
  type Contact,
  type Prisma,
} from '@leadwave/db';
import {
  automationDefinitionSchema,
  parseEmail,
  parsePhone,
  type AutomationDefinition,
  type Plan,
  type Step,
} from '@leadwave/shared';
import { logger } from '../lib/logger.js';
import {
  buildCarouselMessage,
  buildFollowGateMessage,
  buildLeadCaptureMessage,
  buildImageMessage,
  buildTextMessage,
  renderText,
  type BuildContext,
} from './message-builder.js';
import { deliver, type SendOutcome } from './send.js';
import { linkResolver, loadAutomationLinks } from './shortlinks.js';
import { recordLead } from './leads.js';

/**
 * The step-tree interpreter.
 *
 * A run walks the steps in order, and can *park* on a step that needs something
 * from the contact — a Follow Gate tap, or an email. Its position lives in the
 * database, not in memory, so a run survives a restart and resumes exactly
 * where it stopped rather than replaying messages the contact already got.
 */

export interface RunContext {
  run: AutomationRun;
  account: ConnectedAccount;
  contact: Contact;
  conversationId: string;
  plan: Plan;
  workspaceId: string;
  definition: AutomationDefinition;
  build: BuildContext;
}

/** Scratch space carried on the run between steps. */
interface RunState {
  capturedEmail?: string;
  capturedPhone?: string;
  /** Retries used on the step currently being awaited. */
  retries?: number;
  /** Postback payload the Follow Gate is waiting for. */
  gatePayload?: string;
  gateUnlockedAt?: string;
  /** Buttons from the last message, so a follow-up can re-attach them. */
  lastButtons?: unknown[];
}

export const GATE_PAYLOAD_PREFIX = 'lw_gate';
export const gatePayloadFor = (runId: string) => `${GATE_PAYLOAD_PREFIX}:${runId}`;

// ─── Entry points ────────────────────────────────────────────────────────────

/** Starts or continues a run until it finishes or parks. */
export async function advanceRun(runId: string): Promise<void> {
  const ctx = await loadContext(runId);
  if (!ctx) return;

  if (ctx.run.status !== 'running' && ctx.run.status !== 'waiting') return;

  await execute(ctx);
}

/**
 * Called when a contact taps the Follow Gate's unlock button. The gate is
 * confirmed by tap because Facebook exposes no per-user follow signal, so this
 * is recorded as a self-confirmed unlock.
 */
export async function unlockGate(runId: string): Promise<void> {
  const ctx = await loadContext(runId);
  if (!ctx || ctx.run.waitingFor !== 'follow_gate') return;

  const state = readState(ctx.run);
  state.gateUnlockedAt = new Date().toISOString();

  await prisma.$transaction([
    prisma.contact.update({
      where: { id: ctx.contact.id },
      data: { followConfirmedAt: ctx.contact.followConfirmedAt ?? new Date() },
    }),
    prisma.automationRun.update({
      where: { id: runId },
      data: {
        status: 'running',
        waitingFor: null,
        waitingSince: null,
        stepIndex: ctx.run.stepIndex + 1,
        state: state as Prisma.InputJsonValue,
      },
    }),
  ]);

  await advanceRun(runId);
}

/**
 * Called when a contact replies while a run is parked on a lead-capture step.
 * Returns true when the reply was consumed by the run, so the caller knows not
 * to also treat it as a fresh trigger.
 */
export async function resumeWithReply(runId: string, replyText: string): Promise<boolean> {
  const ctx = await loadContext(runId);
  if (!ctx) return false;

  const waitingFor = ctx.run.waitingFor;
  if (waitingFor !== 'ask_email' && waitingFor !== 'ask_phone') return false;

  const step = ctx.definition.steps[ctx.run.stepIndex];
  if (!step || (step.type !== 'ask_email' && step.type !== 'ask_phone')) return false;

  const state = readState(ctx.run);
  const value =
    step.type === 'ask_email'
      ? parseEmail(replyText)
      : parsePhone(replyText, step.defaultCountry);

  if (value) {
    if (step.type === 'ask_email') state.capturedEmail = value;
    else state.capturedPhone = value;

    await recordLead({
      account: ctx.account,
      contact: ctx.contact,
      workspaceId: ctx.workspaceId,
      plan: ctx.plan,
      type: step.type === 'ask_email' ? 'email' : 'phone',
      value,
      rawValue: replyText,
      automationId: ctx.run.automationId,
      sourcePostId: ctx.run.sourcePostId,
    });

    if (step.successText) {
      await send(ctx, buildTextMessage({ stepId: step.id, text: step.successText }, ctx.build), {
        text: renderText(step.successText, ctx.build),
      });
    }

    state.retries = 0;
    await moveTo(ctx, ctx.run.stepIndex + 1, state);
    await advanceRun(runId);
    return true;
  }

  // Not parseable. Offer another go, then move on rather than trapping them in
  // a loop — an automation that will not take "no" for an answer is a bad one.
  const used = (state.retries ?? 0) + 1;
  state.retries = used;

  if (used <= step.maxRetries) {
    const retryText = step.retryText || defaultRetryText(step.type);
    await send(ctx, buildTextMessage({ stepId: step.id, text: retryText }, ctx.build), {
      text: renderText(retryText, ctx.build),
    });
    await prisma.automationRun.update({
      where: { id: runId },
      data: { state: state as Prisma.InputJsonValue },
    });
    return true;
  }

  if (step.continueOnFailure) {
    state.retries = 0;
    await moveTo(ctx, ctx.run.stepIndex + 1, state);
    await advanceRun(runId);
  } else {
    await finish(ctx, 'abandoned', 'Lead capture failed');
  }
  return true;
}

/** The Follow Gate ran out of time without a tap. */
export async function expireGate(runId: string): Promise<void> {
  const ctx = await loadContext(runId);
  if (!ctx || ctx.run.waitingFor !== 'follow_gate') return;

  const step = ctx.definition.steps[ctx.run.stepIndex];
  if (!step || step.type !== 'follow_gate') return;

  const onTimeout = step.onTimeout;

  if (onTimeout.action === 'message') {
    await send(ctx, buildTextMessage({ stepId: step.id, text: onTimeout.text }, ctx.build), {
      text: renderText(onTimeout.text, ctx.build),
    });
  }

  if (onTimeout.action === 'unlock') {
    await moveTo(ctx, ctx.run.stepIndex + 1, readState(ctx.run));
    await advanceRun(runId);
    return;
  }

  await finish(ctx, 'abandoned', 'Follow Gate timed out');
}

// ─── The loop ────────────────────────────────────────────────────────────────

async function execute(ctx: RunContext): Promise<void> {
  let index = ctx.run.stepIndex;
  const state = readState(ctx.run);

  while (index < ctx.definition.steps.length) {
    const step = ctx.definition.steps[index]!;
    const result = await runStep(ctx, step, index, state);

    if (result.kind === 'stop') {
      await finish(ctx, result.status, result.reason);
      return;
    }

    if (result.kind === 'park') {
      await prisma.automationRun.update({
        where: { id: ctx.run.id },
        data: {
          status: 'waiting',
          stepIndex: index,
          waitingFor: result.waitingFor,
          waitingSince: new Date(),
          state: state as Prisma.InputJsonValue,
        },
      });
      return;
    }

    index += 1;
    ctx.run = { ...ctx.run, stepIndex: index };
  }

  await prisma.automationRun.update({
    where: { id: ctx.run.id },
    data: {
      status: 'completed',
      stepIndex: index,
      completedAt: new Date(),
      state: state as Prisma.InputJsonValue,
    },
  });
}

type StepResult =
  | { kind: 'next' }
  | { kind: 'park'; waitingFor: string }
  | { kind: 'stop'; status: 'completed' | 'abandoned' | 'failed'; reason?: string };

async function runStep(
  ctx: RunContext,
  step: Step,
  index: number,
  state: RunState,
): Promise<StepResult> {
  switch (step.type) {
    case 'send_message': {
      if (step.imageUrl) {
        await send(ctx, buildImageMessage(step.imageUrl), { text: null });
      }
      const message = buildTextMessage(
        {
          stepId: step.id,
          text: step.text,
          buttons: step.buttons,
          quickReplies: step.quickReplies,
        },
        ctx.build,
      );
      const outcome = await send(ctx, message, { text: renderText(step.text, ctx.build) });
      state.lastButtons = extractButtons(message);
      return outcomeToResult(outcome);
    }

    case 'product_carousel': {
      if (step.introText) {
        await send(ctx, buildTextMessage({ stepId: step.id, text: step.introText }, ctx.build), {
          text: renderText(step.introText, ctx.build),
        });
      }
      // One message, whatever the card count — ten cards cost one send.
      const outcome = await send(ctx, buildCarouselMessage(step.id, step.cards, ctx.build), {
        text: null,
      });
      return outcomeToResult(outcome);
    }

    case 'follow_gate': {
      // Someone who already confirmed a follow should never be asked twice.
      if (step.skipForKnownFollowers && ctx.contact.followConfirmedAt) {
        return { kind: 'next' };
      }

      const payload = gatePayloadFor(ctx.run.id);
      state.gatePayload = payload;

      const outcome = await send(
        ctx,
        buildFollowGateMessage(
          {
            stepId: step.id,
            gateText: step.gateText,
            unlockButtonLabel: step.unlockButtonLabel,
            pageUrl: step.pageUrl ?? ctx.account.pageUrl,
            unlockPayload: payload,
          },
          ctx.build,
        ),
        { text: renderText(step.gateText, ctx.build) },
      );

      if (outcome.status === 'failed') return outcomeToResult(outcome);

      const { enqueueGateTimeout } = await import('../queues/index.js');
      await enqueueGateTimeout(ctx.run.id, step.timeoutHours * 60 * 60 * 1000);

      return { kind: 'park', waitingFor: 'follow_gate' };
    }

    case 'ask_email':
    case 'ask_phone': {
      const field = step.type === 'ask_email' ? 'email' : 'phone';
      const outcome = await send(
        ctx,
        buildLeadCaptureMessage(
          {
            stepId: step.id,
            prompt: step.prompt,
            field,
            useNative: step.useNativeQuickReply,
          },
          ctx.build,
        ),
        { text: renderText(step.prompt, ctx.build) },
      );

      if (outcome.status === 'failed') return outcomeToResult(outcome);
      return { kind: 'park', waitingFor: step.type };
    }

    case 'delay': {
      const { enqueueRunResume } = await import('../queues/index.js');
      await prisma.automationRun.update({
        where: { id: ctx.run.id },
        data: { stepIndex: index + 1, state: state as Prisma.InputJsonValue },
      });
      await enqueueRunResume(ctx.run.id, step.seconds * 1000);
      return { kind: 'stop', status: 'completed', reason: undefined };
    }

    case 'follow_up': {
      // The nudge is scheduled, not sent. It re-checks at send time and cancels
      // itself if the contact replied or clicked in the meantime.
      const buttons = step.resendButtons && state.lastButtons?.length
        ? state.lastButtons
        : extractButtons(
            buildTextMessage(
              { stepId: step.id, text: step.text, buttons: step.buttons },
              ctx.build,
            ),
          );

      await prisma.followUpJob.upsert({
        where: {
          automationId_contactId_stepId: {
            automationId: ctx.run.automationId,
            contactId: ctx.contact.id,
            stepId: step.id,
          },
        },
        create: {
          automationId: ctx.run.automationId,
          contactId: ctx.contact.id,
          runId: ctx.run.id,
          stepId: step.id,
          dueAt: new Date(Date.now() + step.delayMinutes * 60 * 1000),
          payload: {
            text: renderText(step.text, ctx.build),
            buttons,
          } as Prisma.InputJsonValue,
        },
        update: {},
      });

      const { enqueueFollowUp } = await import('../queues/index.js');
      await enqueueFollowUp(
        ctx.run.automationId,
        ctx.contact.id,
        step.id,
        step.delayMinutes * 60 * 1000,
      );

      return { kind: 'next' };
    }

    default: {
      const exhaustive: never = step;
      logger.error({ step: exhaustive }, 'unknown step type');
      return { kind: 'stop', status: 'failed', reason: 'Unknown step type' };
    }
  }
}

function outcomeToResult(outcome: SendOutcome): StepResult {
  if (outcome.status === 'sent' || outcome.status === 'duplicate') return { kind: 'next' };

  // A held send is transient — the job will retry, so leave the run in place.
  if (outcome.status === 'held') {
    return { kind: 'park', waitingFor: 'send_retry' };
  }

  return { kind: 'stop', status: 'abandoned', reason: outcome.message };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function send(
  ctx: RunContext,
  message: Record<string, unknown>,
  opts: { text: string | null },
): Promise<SendOutcome> {
  return deliver({
    account: ctx.account,
    contact: ctx.contact,
    conversationId: ctx.conversationId,
    message,
    text: opts.text,
    source: ctx.run.isBackfill ? 'retrigger' : 'automation',
    plan: ctx.plan,
    workspaceId: ctx.workspaceId,
    automationId: ctx.run.automationId,
    // One key per run + step, so a retried job re-sends nothing.
    idempotencyKey: `run:${ctx.run.id}:${ctx.run.stepIndex}:${hash(message)}`,
    showTyping: true,
  });
}

/** Short, stable digest so the same step content yields the same key. */
function hash(value: unknown): string {
  const json = JSON.stringify(value);
  let h = 2166136261;
  for (let i = 0; i < json.length; i += 1) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function extractButtons(message: Record<string, unknown>): unknown[] {
  const attachment = message.attachment as
    | { payload?: { buttons?: unknown[] } }
    | undefined;
  return attachment?.payload?.buttons ?? [];
}

async function moveTo(ctx: RunContext, index: number, state: RunState): Promise<void> {
  await prisma.automationRun.update({
    where: { id: ctx.run.id },
    data: {
      stepIndex: index,
      status: 'running',
      waitingFor: null,
      waitingSince: null,
      state: state as Prisma.InputJsonValue,
    },
  });
  ctx.run = { ...ctx.run, stepIndex: index, status: 'running', waitingFor: null };
}

async function finish(
  ctx: RunContext,
  status: 'completed' | 'abandoned' | 'failed',
  reason?: string,
): Promise<void> {
  await prisma.automationRun.update({
    where: { id: ctx.run.id },
    data: {
      status,
      error: reason?.slice(0, 500) ?? null,
      completedAt: new Date(),
    },
  });
}

function readState(run: AutomationRun): RunState {
  return (run.state as RunState | null) ?? {};
}

function defaultRetryText(type: 'ask_email' | 'ask_phone'): string {
  return type === 'ask_email'
    ? "That doesn't look like an email — mind sending it again?"
    : "That doesn't look like a phone number — mind sending it again?";
}

async function loadContext(runId: string): Promise<RunContext | null> {
  const run = await prisma.automationRun.findUnique({
    where: { id: runId },
    include: {
      automation: {
        include: {
          connectedAccount: { include: { workspace: true } },
        },
      },
      contact: { include: { conversation: true } },
    },
  });

  if (!run) return null;

  // A paused automation stops mid-run; nobody wants a "live" flow they paused
  // to keep messaging people.
  if (run.automation.status !== 'live') {
    await prisma.automationRun.update({
      where: { id: runId },
      data: { status: 'abandoned', error: 'Automation is no longer live', completedAt: new Date() },
    });
    return null;
  }

  const parsed = automationDefinitionSchema.safeParse(run.automation.definition);
  if (!parsed.success) {
    logger.error({ runId, automationId: run.automationId }, 'automation definition is invalid');
    await prisma.automationRun.update({
      where: { id: runId },
      data: { status: 'failed', error: 'Automation definition is invalid', completedAt: new Date() },
    });
    return null;
  }

  const conversationId = run.conversationId ?? run.contact.conversation?.id;
  if (!conversationId) return null;

  const account = run.automation.connectedAccount;
  const links = await loadAutomationLinks(run.automationId);

  return {
    run,
    account,
    contact: run.contact,
    conversationId,
    plan: account.workspace.plan,
    workspaceId: account.workspaceId,
    definition: parsed.data,
    build: {
      firstName: run.contact.firstName,
      lastName: run.contact.lastName,
      username: run.contact.firstName,
      pageName: account.pageName,
      resolveUrl: linkResolver(links),
    },
  };
}
