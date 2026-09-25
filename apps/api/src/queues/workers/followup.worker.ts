import { prisma } from '@leadwave/db';
import type { Plan } from '@leadwave/shared';
import { logger } from '../../lib/logger.js';
import { deliver } from '../../services/send.js';
import type { FollowUpJobData, ScheduledMessageJob } from '../index.js';

/**
 * The follow-up nudge.
 *
 * One reminder, never a drip. The rule that makes it safe is that eligibility
 * is re-checked *here*, at send time — not when the job was scheduled. Anyone
 * who replied or tapped the link in the intervening hours is dropped silently,
 * so nobody is ever nudged about something they already dealt with.
 */
export async function processFollowUp(job: FollowUpJobData): Promise<void> {
  const record = await prisma.followUpJob.findUnique({
    where: {
      automationId_contactId_stepId: {
        automationId: job.automationId,
        contactId: job.contactId,
        stepId: job.stepId,
      },
    },
    include: {
      contact: { include: { conversation: true } },
      automation: { include: { connectedAccount: { include: { workspace: true } } } },
    },
  });

  if (!record || record.status !== 'scheduled') return;

  const cancel = async (reason: string): Promise<void> => {
    await prisma.followUpJob.update({
      where: { id: record.id },
      data: { status: 'canceled', canceledReason: reason },
    });
    logger.debug({ followUpId: record.id, reason }, 'follow-up cancelled at send time');
  };

  // The automation was paused or deleted after the nudge was queued.
  if (record.automation.status !== 'live') return cancel('automation is not live');

  const { contact } = record;
  if (contact.optedOutAt) return cancel('contact opted out');
  if (contact.isBlocked) return cancel('contact unreachable');

  // They replied. This is the common case, and the whole point of re-checking.
  if (contact.lastInboundAt && contact.lastInboundAt > record.createdAt) {
    return cancel('contact replied');
  }

  // They tapped the link. Also a reason not to nudge.
  const clicked = await prisma.linkClick.findFirst({
    where: { contactId: contact.id, createdAt: { gt: record.createdAt } },
    select: { id: true },
  });
  if (clicked) return cancel('contact clicked the link');

  const conversation = contact.conversation;
  if (!conversation) return cancel('no conversation');

  const payload = record.payload as { text?: string; buttons?: unknown[] };
  const text = payload.text ?? '';
  const buttons = payload.buttons ?? [];

  const message =
    buttons.length > 0
      ? {
          attachment: {
            type: 'template',
            payload: { template_type: 'button', text: text.slice(0, 640), buttons },
          },
        }
      : { text };

  const account = record.automation.connectedAccount;
  const outcome = await deliver({
    account,
    contact,
    conversationId: conversation.id,
    message,
    text,
    source: 'follow_up',
    plan: account.workspace.plan as Plan,
    workspaceId: account.workspaceId,
    automationId: record.automationId,
    idempotencyKey: `followup:${record.id}`,
  });

  if (outcome.status === 'held') {
    // Transient — let BullMQ retry rather than burning the one reminder.
    throw new Error(`Follow-up held: ${outcome.message}`);
  }

  await prisma.followUpJob.update({
    where: { id: record.id },
    data: {
      status: outcome.status === 'failed' ? 'skipped' : 'sent',
      canceledReason: outcome.status === 'failed' ? outcome.message.slice(0, 200) : null,
      sentAt: outcome.status === 'failed' ? null : new Date(),
    },
  });
}

/**
 * A message the user scheduled from the Inbox.
 *
 * The window is re-checked immediately before sending. If the contact has gone
 * quiet and the window has closed, the message is *held* rather than sent —
 * which is the behaviour that keeps the Page compliant without the user having
 * to think about Meta's rules.
 */
export async function processScheduledMessage(job: ScheduledMessageJob): Promise<void> {
  const message = await prisma.message.findUnique({
    where: { id: job.messageId },
    include: {
      conversation: {
        include: {
          contact: true,
          connectedAccount: { include: { workspace: true } },
        },
      },
    },
  });

  if (!message || message.status !== 'scheduled') return;

  const { conversation } = message;
  const account = conversation.connectedAccount;

  const outcome = await deliver({
    account,
    contact: conversation.contact,
    conversationId: conversation.id,
    message: (message.payload as Record<string, unknown>) ?? { text: message.text ?? '' },
    text: message.text,
    source: 'scheduled',
    plan: account.workspace.plan as Plan,
    workspaceId: account.workspaceId,
    senderId: message.senderId,
    // A person scheduled this, so the human-agent window applies.
    humanInitiated: true,
    idempotencyKey: `scheduled-send:${message.id}`,
  });

  if (outcome.status === 'sent' || outcome.status === 'duplicate') {
    await prisma.message.update({
      where: { id: message.id },
      data: { status: 'sent', sentAt: new Date() },
    });
    return;
  }

  if (outcome.status === 'held' && outcome.reason === 'budget_exhausted') {
    throw new Error('Scheduled send paced; retrying.');
  }

  await prisma.message.update({
    where: { id: message.id },
    data: {
      status: 'held',
      failureReason:
        outcome.status === 'failed' || outcome.status === 'held'
          ? outcome.message.slice(0, 500)
          : null,
    },
  });
}
