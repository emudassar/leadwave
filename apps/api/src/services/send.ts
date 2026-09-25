import {
  prisma,
  type ConnectedAccount,
  type Contact,
  type MessageSource,
  type Prisma,
} from '@leadwave/db';
import { resolveSendEligibility, type Plan } from '@leadwave/shared';
import { tryDecrypt } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { GraphError, sendMessage, sendPrivateReply, sendSenderAction } from './graph.js';
import { checkMessageQuota, recordMessagesSent } from './entitlements.js';
import { checkSendBudget } from './rate-limit.js';
import { describeMessage } from './message-builder.js';

/**
 * The one path every outbound message takes.
 *
 * Automations, the Inbox, scheduled sends, follow-up nudges and LeadWave AI all
 * call `deliver`. That is deliberate: the messaging-window check, the plan
 * quota, the shared send budget and idempotency are enforced once, so an AI
 * reply is never sent in a situation where an ordinary message could not be.
 */

export type SendOutcome =
  | { status: 'sent'; messageId: string; externalId: string }
  | { status: 'duplicate'; messageId: string }
  | {
      status: 'held' | 'failed';
      reason: SendBlockReason;
      message: string;
      retryAfterSeconds?: number;
    };

export type SendBlockReason =
  | 'window_closed'
  | 'quota_exhausted'
  | 'budget_exhausted'
  | 'contact_unreachable'
  | 'contact_opted_out'
  | 'account_disconnected'
  | 'graph_error';

export interface DeliverInput {
  account: ConnectedAccount;
  contact: Contact;
  conversationId: string;
  /** The Send API `message` object, already built. */
  message: Record<string, unknown>;
  source: MessageSource;
  plan: Plan;
  workspaceId: string;

  /** Makes a retry safe: the same key can never send twice. */
  idempotencyKey: string;

  /** A person typing in the Inbox may use the human-agent window. */
  humanInitiated?: boolean;
  automationId?: string | null;
  senderId?: string | null;
  isAiGenerated?: boolean;
  aiEventId?: string | null;
  /** Plain text of the message, when there is one, for previews and search. */
  text?: string | null;
  /** Show the typing bubble first, so an instant reply feels less abrupt. */
  showTyping?: boolean;
}

export async function deliver(input: DeliverInput): Promise<SendOutcome> {
  const {
    account,
    contact,
    conversationId,
    message,
    source,
    plan,
    workspaceId,
    idempotencyKey,
  } = input;

  // 1. Idempotency. A redelivered webhook or a retried job must never double-send.
  const existing = await prisma.message.findUnique({ where: { idempotencyKey } });
  if (existing) {
    return { status: 'duplicate', messageId: existing.id };
  }

  // 2. The person has to be reachable at all.
  if (contact.optedOutAt) {
    return blocked('contact_opted_out', 'This contact asked not to be messaged.');
  }
  if (contact.isBlocked) {
    return blocked('contact_unreachable', 'This contact can no longer be reached.');
  }

  // 3. The Page has to still be connected.
  const token = tryDecrypt(account.accessTokenCipher);
  if (!token || account.status === 'disabled') {
    return blocked('account_disconnected', 'Reconnect this Facebook Page to keep sending.');
  }

  // 4. Messenger's messaging window. Automated sends only ever use the standard
  //    24 hours; a human in the Inbox may use the human-agent window.
  const eligibility = resolveSendEligibility(
    { lastInboundAt: contact.lastInboundAt },
    { humanInitiated: input.humanInitiated },
  );
  if (!eligibility.allowed) {
    await recordHeld(input, 'window_closed');
    return blocked(
      'window_closed',
      'The 24-hour messaging window has closed for this contact.',
    );
  }

  // 5. The plan's monthly message cap.
  const quota = await checkMessageQuota(workspaceId, plan);
  if (!quota.allowed) {
    await recordHeld(input, 'quota_exhausted');
    return blocked(
      'quota_exhausted',
      `You have used all ${quota.limit?.toLocaleString()} messages on your plan this month.`,
    );
  }

  // 6. The shared per-Page send budget.
  const budget = await checkSendBudget(account.pageId);
  if (!budget.allowed) {
    return {
      status: 'held',
      reason: 'budget_exhausted',
      message: 'Sending is paced to stay inside Facebook’s limits. This will retry shortly.',
      retryAfterSeconds: budget.retryAfterSeconds,
    };
  }

  // 7. Reserve the row first. Writing it before the Graph call means a crash
  //    mid-send leaves a `pending` row to reconcile, never a silent double-send.
  let row;
  try {
    row = await prisma.message.create({
      data: {
        conversationId,
        direction: 'outbound',
        status: 'pending',
        source,
        text: input.text ?? null,
        payload: message as Prisma.InputJsonValue,
        idempotencyKey,
        automationId: input.automationId ?? null,
        senderId: input.senderId ?? null,
        isAiGenerated: input.isAiGenerated ?? false,
        aiEventId: input.aiEventId ?? null,
      },
    });
  } catch (err) {
    // Lost a race on the unique idempotency key — the other worker has it.
    const winner = await prisma.message.findUnique({ where: { idempotencyKey } });
    if (winner) return { status: 'duplicate', messageId: winner.id };
    throw err;
  }

  if (input.showTyping) {
    await sendSenderAction(account.pageId, token, contact.psid, 'typing_on');
  }

  // 8. The actual send.
  try {
    const result = await sendMessage(account.pageId, token, {
      recipient: { id: contact.psid },
      message,
      messaging_type: eligibility.messagingType,
      ...(eligibility.tag ? { tag: eligibility.tag } : {}),
    });

    const now = new Date();
    await prisma.$transaction([
      prisma.message.update({
        where: { id: row.id },
        data: { status: 'sent', externalId: result.message_id, sentAt: now },
      }),
      prisma.contact.update({
        where: { id: contact.id },
        data: { lastOutboundAt: now },
      }),
      prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: now,
          lastMessagePreview: describeMessage(message, input.text ?? null),
          ...(input.isAiGenerated ? { hasAiActivity: true } : {}),
        },
      }),
    ]);

    await recordMessagesSent(workspaceId, 1);

    return { status: 'sent', messageId: row.id, externalId: result.message_id };
  } catch (err) {
    return handleSendFailure(err, row.id, account, contact);
  }
}

async function handleSendFailure(
  err: unknown,
  messageId: string,
  account: ConnectedAccount,
  contact: Contact,
): Promise<SendOutcome> {
  const graphErr = err instanceof GraphError ? err : null;
  const reason = graphErr?.message ?? 'Send failed.';

  await prisma.message.update({
    where: { id: messageId },
    data: { status: 'failed', failureReason: reason.slice(0, 500) },
  });

  if (graphErr) {
    // The token is gone — surface it so the user can reconnect, and stop
    // hammering Meta with calls that cannot succeed.
    if (graphErr.disposition === 'reconnect') {
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: {
          status: 'needs_reconnect',
          statusDetail: 'Facebook revoked access. Reconnect this Page.',
        },
      });
      return blocked('account_disconnected', 'Reconnect this Facebook Page to keep sending.');
    }

    // The person blocked the Page or deleted their account.
    if (graphErr.code === 551) {
      await prisma.contact.update({ where: { id: contact.id }, data: { isBlocked: true } });
      return blocked('contact_unreachable', 'This contact can no longer be reached.');
    }

    if (graphErr.isRetryable) {
      return {
        status: 'held',
        reason: 'graph_error',
        message: reason,
        retryAfterSeconds: 60,
      };
    }
  }

  logger.warn({ err, pageId: account.pageId }, 'send failed');
  return blocked('graph_error', reason);
}

function blocked(reason: SendBlockReason, message: string): SendOutcome {
  return { status: 'failed', reason, message };
}

/**
 * Records a message that was composed but deliberately not sent, so the Inbox
 * can show "held — the window closed" instead of the message vanishing.
 */
async function recordHeld(input: DeliverInput, reason: SendBlockReason): Promise<void> {
  await prisma.message
    .create({
      data: {
        conversationId: input.conversationId,
        direction: 'outbound',
        status: 'held',
        source: input.source,
        text: input.text ?? null,
        payload: input.message as Prisma.InputJsonValue,
        idempotencyKey: input.idempotencyKey,
        automationId: input.automationId ?? null,
        senderId: input.senderId ?? null,
        isAiGenerated: input.isAiGenerated ?? false,
        failureReason: reason,
      },
    })
    .catch(() => {
      // A duplicate key here just means another worker already recorded it.
    });
}

// ─── Private replies (comment → DM) ──────────────────────────────────────────

export interface PrivateReplyInput {
  account: ConnectedAccount;
  commentId: string;
  message: Record<string, unknown>;
  plan: Plan;
  workspaceId: string;
}

export type PrivateReplyOutcome =
  | { status: 'sent'; psid: string | null }
  | { status: 'duplicate' }
  | { status: 'failed'; reason: SendBlockReason; message: string; retryable: boolean };

/**
 * Opens a DM thread from a public comment. This is the Facebook primitive that
 * makes comment-to-DM work: Meta allows exactly one private reply per comment,
 * ever, and only while the comment is under 7 days old.
 */
export async function deliverPrivateReply(
  input: PrivateReplyInput,
): Promise<PrivateReplyOutcome> {
  const { account, commentId, message, plan, workspaceId } = input;

  const token = tryDecrypt(account.accessTokenCipher);
  if (!token || account.status === 'disabled') {
    return {
      status: 'failed',
      reason: 'account_disconnected',
      message: 'Reconnect this Facebook Page.',
      retryable: false,
    };
  }

  const quota = await checkMessageQuota(workspaceId, plan);
  if (!quota.allowed) {
    return {
      status: 'failed',
      reason: 'quota_exhausted',
      message: 'Monthly message limit reached.',
      retryable: false,
    };
  }

  const budget = await checkSendBudget(account.pageId);
  if (!budget.allowed) {
    return {
      status: 'failed',
      reason: 'budget_exhausted',
      message: 'Paced to stay inside Facebook’s limits.',
      retryable: true,
    };
  }

  try {
    const result = await sendPrivateReply(commentId, token, message);
    await recordMessagesSent(workspaceId, 1);
    return { status: 'sent', psid: result.recipient_id ?? null };
  } catch (err) {
    const graphErr = err instanceof GraphError ? err : null;

    // Meta says we already replied to this comment. That is the outcome we
    // wanted, so treat it as success rather than retrying forever.
    if (graphErr?.isBenign) return { status: 'duplicate' };

    if (graphErr?.disposition === 'reconnect') {
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: { status: 'needs_reconnect', statusDetail: 'Facebook revoked access.' },
      });
    }

    return {
      status: 'failed',
      reason: 'graph_error',
      message: graphErr?.message ?? 'Private reply failed.',
      retryable: graphErr?.isRetryable ?? false,
    };
  }
}
