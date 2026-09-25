import {
  prisma,
  type Automation,
  type ConnectedAccount,
  type Contact,
  type Conversation,
  type TriggerType,
} from '@leadwave/db';
import {
  automationDefinitionSchema,
  matchKeywords,
  type AutomationDefinition,
} from '@leadwave/shared';
import { logger } from '../lib/logger.js';
import { withLock } from './rate-limit.js';
import { enqueueRunStart } from '../queues/index.js';

/**
 * Trigger resolution: given an event, which automation should run?
 *
 * Two rules matter throughout. First, **a keyword automation always wins** — if
 * one matches, LeadWave AI stays out of that message entirely, so nobody ever
 * gets two replies. Second, one automation fires per event: the oldest matching
 * live automation, so behaviour is stable rather than dependent on edit order.
 */

export interface TriggerMatch {
  automation: Automation;
  definition: AutomationDefinition;
  /** Which keyword fired, for the activity log. */
  keyword: string | null;
}

/** Live automations of a given type, cheapest query first. */
async function liveAutomations(
  connectedAccountId: string,
  triggerType: TriggerType,
): Promise<Automation[]> {
  return prisma.automation.findMany({
    where: { connectedAccountId, triggerType, status: 'live' },
    orderBy: { createdAt: 'asc' },
  });
}

function parse(automation: Automation): AutomationDefinition | null {
  const parsed = automationDefinitionSchema.safeParse(automation.definition);
  if (!parsed.success) {
    logger.error({ automationId: automation.id }, 'skipping automation with invalid definition');
    return null;
  }
  return parsed.data;
}

// ─── Comment triggers ────────────────────────────────────────────────────────

/**
 * Matches a comment against the Page's comment automations. Scope is checked
 * before keywords: an automation pinned to one Reel should never fire on a
 * different post, however well the keyword matches.
 */
export async function matchCommentTrigger(
  connectedAccountId: string,
  postId: string,
  commentText: string,
): Promise<TriggerMatch | null> {
  const automations = await liveAutomations(connectedAccountId, 'comment');

  for (const automation of automations) {
    const definition = parse(automation);
    if (!definition || definition.trigger.type !== 'comment') continue;

    const { scope, keywords } = definition.trigger;

    const inScope =
      scope.kind === 'all_posts' ||
      (scope.kind === 'specific' && scope.postIds.includes(postId)) ||
      (scope.kind === 'next_post' && scope.resolvedPostId === postId);

    if (!inScope) continue;

    const match = matchKeywords(keywords, commentText);
    if (!match.matched) continue;

    return { automation, definition, keyword: match.keyword };
  }

  return null;
}

// ─── Message triggers ────────────────────────────────────────────────────────

/**
 * Matches an inbound Messenger message. Keyword automations are tried before
 * the welcome trigger, so a first message that happens to contain a keyword
 * gets the specific answer rather than the generic greeting.
 */
export async function matchMessageTrigger(
  connectedAccountId: string,
  text: string,
  options: { isFirstMessage: boolean },
): Promise<TriggerMatch | null> {
  const automations = await liveAutomations(connectedAccountId, 'dm_keyword');

  for (const automation of automations) {
    const definition = parse(automation);
    if (!definition || definition.trigger.type !== 'dm_keyword') continue;

    if (definition.trigger.firstMessageOnly && !options.isFirstMessage) continue;

    const match = matchKeywords(definition.trigger.keywords, text);
    if (!match.matched) continue;

    return { automation, definition, keyword: match.keyword };
  }

  if (options.isFirstMessage) {
    const welcomes = await liveAutomations(connectedAccountId, 'welcome');
    for (const automation of welcomes) {
      const definition = parse(automation);
      if (definition) return { automation, definition, keyword: null };
    }
  }

  return null;
}

// ─── Story triggers ──────────────────────────────────────────────────────────

/**
 * Story replies, reactions and mentions each get their own trigger type,
 * because each one means something different: a reply is a conversation already
 * started, a reaction is one-tap interest, a mention is earned reach.
 */
export async function matchStoryTrigger(
  connectedAccountId: string,
  kind: 'story_reply' | 'story_reaction' | 'story_mention',
  options: { storyId?: string | null; text?: string | null; reaction?: string | null },
): Promise<TriggerMatch | null> {
  const automations = await liveAutomations(connectedAccountId, kind);

  for (const automation of automations) {
    const definition = parse(automation);
    if (!definition) continue;
    const trigger = definition.trigger;

    if (trigger.type === 'story_reply') {
      if (trigger.storyIds && options.storyId && !trigger.storyIds.includes(options.storyId)) {
        continue;
      }
      const match = matchKeywords(trigger.keywords, options.text ?? '');
      if (!match.matched) continue;
      return { automation, definition, keyword: match.keyword };
    }

    if (trigger.type === 'story_reaction') {
      if (trigger.storyIds && options.storyId && !trigger.storyIds.includes(options.storyId)) {
        continue;
      }
      if (trigger.reactions && options.reaction && !trigger.reactions.includes(options.reaction)) {
        continue;
      }
      return { automation, definition, keyword: null };
    }

    if (trigger.type === 'story_mention') {
      return { automation, definition, keyword: null };
    }
  }

  return null;
}

// ─── Ice breakers ────────────────────────────────────────────────────────────

export const ICE_BREAKER_PREFIX = 'lw_ib';
export const iceBreakerPayload = (automationId: string) => `${ICE_BREAKER_PREFIX}:${automationId}`;

export async function matchIceBreakerTrigger(
  connectedAccountId: string,
  payload: string,
): Promise<TriggerMatch | null> {
  if (!payload.startsWith(`${ICE_BREAKER_PREFIX}:`)) return null;
  const automationId = payload.slice(ICE_BREAKER_PREFIX.length + 1);

  const automation = await prisma.automation.findFirst({
    where: { id: automationId, connectedAccountId, status: 'live', triggerType: 'ice_breaker' },
  });
  if (!automation) return null;

  const definition = parse(automation);
  if (!definition) return null;

  return { automation, definition, keyword: null };
}

// ─── Starting a run ──────────────────────────────────────────────────────────

export interface StartRunInput {
  match: TriggerMatch;
  account: ConnectedAccount;
  contact: Contact;
  conversation: Conversation;
  sourceType: string;
  sourcePostId?: string | null;
  sourceCommentId?: string | null;
  isBackfill?: boolean;
}

/**
 * Creates a run and queues it.
 *
 * Guarded by a lock plus a uniqueness check so the same trigger cannot start
 * two runs — the usual cause being Meta redelivering a webhook while the first
 * run is still being created.
 */
export async function startRun(input: StartRunInput): Promise<string | null> {
  const { match, contact, conversation } = input;

  const lockKey = input.sourceCommentId
    ? `run:comment:${input.sourceCommentId}`
    : `run:${match.automation.id}:${contact.id}`;

  return withLock(lockKey, 30, async () => {
    if (input.sourceCommentId) {
      const existing = await prisma.automationRun.findUnique({
        where: {
          automationId_sourceCommentId: {
            automationId: match.automation.id,
            sourceCommentId: input.sourceCommentId,
          },
        },
        select: { id: true },
      });
      if (existing) return null;
    } else {
      // Don't start a second run of the same automation while one is still
      // mid-flight for this person — they would get the messages twice.
      const inFlight = await prisma.automationRun.findFirst({
        where: {
          automationId: match.automation.id,
          contactId: contact.id,
          status: { in: ['running', 'waiting'] },
        },
        select: { id: true },
      });
      if (inFlight) return null;
    }

    const run = await prisma.automationRun.create({
      data: {
        automationId: match.automation.id,
        contactId: contact.id,
        conversationId: conversation.id,
        sourceType: input.sourceType,
        sourcePostId: input.sourcePostId ?? null,
        sourceCommentId: input.sourceCommentId ?? null,
        isBackfill: input.isBackfill ?? false,
      },
    });

    await prisma.automation.update({
      where: { id: match.automation.id },
      data: { lastTriggeredAt: new Date() },
    });

    await enqueueRunStart(run.id);
    return run.id;
  });
}
