import { prisma, type ConnectedAccount } from '@leadwave/db';
import { logger } from '../../lib/logger.js';
import type { ChangeEvent, MessagingEvent } from '../../webhooks/messenger.js';
import {
  GATE_PAYLOAD_PREFIX,
  resumeWithReply,
  unlockGate,
} from '../../services/executor.js';
import {
  ICE_BREAKER_PREFIX,
  matchCommentTrigger,
  matchIceBreakerTrigger,
  matchMessageTrigger,
  matchStoryTrigger,
  startRun,
} from '../../services/dispatcher.js';
import {
  cancelPendingFollowUps,
  findWaitingRun,
  looksLikeOptOut,
  optOut,
  recordInbound,
  upsertContact,
} from '../../services/inbound.js';
import { enqueueAiMessage, enqueueComment, type WebhookJob } from '../index.js';

/**
 * Turns a stored webhook event into product behaviour.
 *
 * The ordering inside `handleMessage` is the important part, and it mirrors the
 * precedence the product promises:
 *
 *   1. a run already waiting on this person consumes the reply
 *   2. a keyword automation matches and handles it
 *   3. only if neither did, LeadWave AI is even considered
 *
 * That is what guarantees nobody ever receives two replies to one message.
 */

export async function processWebhookEvent(job: WebhookJob): Promise<void> {
  const event = await prisma.webhookEvent.findUnique({ where: { id: job.webhookEventId } });
  if (!event || event.processedAt) return;

  const account = event.pageId
    ? await prisma.connectedAccount.findFirst({
        where: { pageId: event.pageId, status: { not: 'disabled' } },
        include: { workspace: true },
      })
    : null;

  if (!account) {
    await markProcessed(event.id, 'No connected Page for this event');
    return;
  }

  try {
    if (event.field === 'messaging') {
      await handleMessaging(account, event.payload as unknown as MessagingEvent);
    } else {
      await handleChange(account, event.payload as unknown as ChangeEvent);
    }
    await markProcessed(event.id);
  } catch (err) {
    logger.error({ err, eventId: event.id, field: event.field }, 'webhook processing failed');
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { error: err instanceof Error ? err.message.slice(0, 500) : 'unknown error' },
    });
    throw err;
  }
}

async function markProcessed(id: string, note?: string): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id },
    data: { processedAt: new Date(), ...(note ? { error: note } : {}) },
  });
}

// ─── Messaging events ────────────────────────────────────────────────────────

async function handleMessaging(
  account: ConnectedAccount & { workspace: { plan: string } },
  event: MessagingEvent,
): Promise<void> {
  const psid = event.sender?.id;
  if (!psid || psid === account.pageId) return;

  // Echoes are our own outbound messages coming back; delivery and read
  // receipts are handled separately and never trigger anything.
  if (event.message?.is_echo) return;
  if (event.delivery) return void handleDelivery(event);
  if (event.read) return void handleRead(account, psid, event);

  const { contact, conversation, isNew } = await upsertContact(account, psid);
  const timestamp = event.timestamp ? new Date(event.timestamp) : new Date();

  if (event.postback) {
    await handlePostback(account, contact, conversation, event, timestamp);
    return;
  }

  if (event.reaction) {
    await handleReaction(account, contact, conversation, event);
    return;
  }

  if (event.message) {
    await handleMessage(account, contact, conversation, event, timestamp, isNew);
    return;
  }

  if (event.optin?.payload) {
    logger.debug({ psid }, 'received messaging optin');
  }
}

async function handleMessage(
  account: ConnectedAccount & { workspace: { plan: string } },
  contact: Awaited<ReturnType<typeof upsertContact>>['contact'],
  conversation: Awaited<ReturnType<typeof upsertContact>>['conversation'],
  event: MessagingEvent,
  timestamp: Date,
  isNewContact: boolean,
): Promise<void> {
  const text = event.message?.text ?? null;

  const recorded = await recordInbound({
    account,
    contact,
    conversation,
    externalId: event.message?.mid ?? null,
    text,
    payload: event.message as Record<string, unknown> | null,
    timestamp,
  });

  // A duplicate delivery. Everything below would be a second reply.
  if (!recorded) return;

  // Any inbound message means a pending nudge is no longer wanted.
  await cancelPendingFollowUps(contact.id, 'contact replied');

  if (looksLikeOptOut(text)) {
    await optOut(contact.id);
    return;
  }

  // 1. A run parked on a lead-capture step gets first claim on the reply.
  const waitingRunId = await findWaitingRun(contact.id);
  if (waitingRunId && text) {
    const consumed = await resumeWithReply(waitingRunId, text);
    if (consumed) return;
  }

  // A story reply arrives as an ordinary message carrying `reply_to.story`.
  const story = event.message?.reply_to?.story;
  if (story) {
    const match = await matchStoryTrigger(account.id, 'story_reply', {
      storyId: story.id ?? null,
      text,
    });
    if (match) {
      await startRun({
        match,
        account,
        contact,
        conversation,
        sourceType: 'story_reply',
      });
      return;
    }
  }

  if (!text) return;

  // 2. Keyword automations. A match here means the AI stays out entirely.
  const match = await matchMessageTrigger(account.id, text, {
    isFirstMessage: isNewContact,
  });
  if (match) {
    await startRun({ match, account, contact, conversation, sourceType: 'dm_keyword' });
    return;
  }

  // 3. Nothing matched, so the AI may look at it. The worker re-checks every
  //    precondition itself; queueing is not permission to reply.
  await enqueueAiMessage({
    kind: 'message',
    connectedAccountId: account.id,
    conversationId: conversation.id,
    contactId: contact.id,
    messageId: recorded.messageId,
  });
}

async function handlePostback(
  account: ConnectedAccount & { workspace: { plan: string } },
  contact: Awaited<ReturnType<typeof upsertContact>>['contact'],
  conversation: Awaited<ReturnType<typeof upsertContact>>['conversation'],
  event: MessagingEvent,
  timestamp: Date,
): Promise<void> {
  const payload = event.postback?.payload ?? '';

  await recordInbound({
    account,
    contact,
    conversation,
    externalId: event.postback?.mid ?? null,
    text: event.postback?.title ?? null,
    payload: event.postback as Record<string, unknown> | null,
    timestamp,
  });

  await cancelPendingFollowUps(contact.id, 'contact tapped a button');

  // The Follow Gate unlock. Facebook gives no per-user follow signal, so this
  // tap is the confirmation, recorded as self-confirmed.
  if (payload.startsWith(`${GATE_PAYLOAD_PREFIX}:`)) {
    const runId = payload.slice(GATE_PAYLOAD_PREFIX.length + 1);
    await unlockGate(runId);
    return;
  }

  if (payload.startsWith(`${ICE_BREAKER_PREFIX}:`)) {
    const match = await matchIceBreakerTrigger(account.id, payload);
    if (match) {
      await startRun({ match, account, contact, conversation, sourceType: 'ice_breaker' });
    }
    return;
  }

  // The Get Started button.
  if (payload === 'LEADWAVE_GET_STARTED') {
    const match = await matchMessageTrigger(account.id, '', { isFirstMessage: true });
    if (match) {
      await startRun({ match, account, contact, conversation, sourceType: 'welcome' });
    }
  }
}

async function handleReaction(
  account: ConnectedAccount & { workspace: { plan: string } },
  contact: Awaited<ReturnType<typeof upsertContact>>['contact'],
  conversation: Awaited<ReturnType<typeof upsertContact>>['conversation'],
  event: MessagingEvent,
): Promise<void> {
  // Un-reacting is not a trigger.
  if (event.reaction?.action !== 'react') return;

  const match = await matchStoryTrigger(account.id, 'story_reaction', {
    storyId: null,
    reaction: event.reaction.emoji ?? event.reaction.reaction ?? null,
  });
  if (!match) return;

  await startRun({ match, account, contact, conversation, sourceType: 'story_reaction' });
}

async function handleDelivery(event: MessagingEvent): Promise<void> {
  const mids = event.delivery?.mids ?? [];
  if (mids.length === 0) return;

  await prisma.message.updateMany({
    where: { externalId: { in: mids }, status: 'sent' },
    data: { status: 'delivered' },
  });
}

async function handleRead(
  account: ConnectedAccount,
  psid: string,
  event: MessagingEvent,
): Promise<void> {
  const watermark = event.read?.watermark;
  if (!watermark) return;

  const contact = await prisma.contact.findUnique({
    where: { connectedAccountId_psid: { connectedAccountId: account.id, psid } },
    include: { conversation: true },
  });
  if (!contact?.conversation) return;

  await prisma.message.updateMany({
    where: {
      conversationId: contact.conversation.id,
      direction: 'outbound',
      status: { in: ['sent', 'delivered'] },
      createdAt: { lte: new Date(watermark) },
    },
    data: { status: 'read' },
  });
}

// ─── Change events (comments, mentions) ──────────────────────────────────────

async function handleChange(
  account: ConnectedAccount & { workspace: { plan: string } },
  change: ChangeEvent,
): Promise<void> {
  if (change.field === 'feed') return handleFeedChange(account, change);
  if (change.field === 'mention') return handleMention(account, change);
}

interface FeedCommentValue {
  item?: string;
  verb?: string;
  comment_id?: string;
  post_id?: string;
  parent_id?: string;
  message?: string;
  created_time?: number;
  from?: { id?: string; name?: string };
}

async function handleFeedChange(
  account: ConnectedAccount & { workspace: { plan: string } },
  change: ChangeEvent,
): Promise<void> {
  const value = change.value as FeedCommentValue;

  if (value.item !== 'comment' || value.verb !== 'add') return;
  if (!value.comment_id || !value.post_id) return;

  // Never react to the Page's own comments — including the public replies our
  // own automations post, which would otherwise loop.
  if (value.from?.id && value.from.id === account.pageId) return;

  await enqueueComment({
    connectedAccountId: account.id,
    commentId: value.comment_id,
    postId: value.post_id,
    commenterId: value.from?.id ?? null,
    commentText: value.message ?? '',
    commentCreatedAt: value.created_time
      ? new Date(value.created_time * 1000).toISOString()
      : null,
  });
}

async function handleMention(
  account: ConnectedAccount & { workspace: { plan: string } },
  change: ChangeEvent,
): Promise<void> {
  const value = change.value as { sender_id?: string; post_id?: string; item?: string };
  const psid = value.sender_id;
  if (!psid) return;

  const match = await matchStoryTrigger(account.id, 'story_mention', {});
  if (!match) return;

  const { contact, conversation } = await upsertContact(account, psid);
  await startRun({
    match,
    account,
    contact,
    conversation,
    sourceType: 'story_mention',
    sourcePostId: value.post_id ?? null,
  });
}

export { matchCommentTrigger };
