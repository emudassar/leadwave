import {
  prisma,
  type ConnectedAccount,
  type Contact,
  type Conversation,
  type Prisma,
} from '@leadwave/db';
import { tryDecrypt } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { fetchUserProfile } from './graph.js';
import { assertContactQuota } from './entitlements.js';
import { describeMessage } from './message-builder.js';

/**
 * Turning a raw inbound event into rows.
 *
 * Every inbound message does three things that matter beyond storage: it
 * refreshes the 24-hour messaging window, it cancels any follow-up nudge
 * waiting on that person, and it may resume an automation run parked on a
 * lead-capture step. Those are handled here so no caller can forget one.
 */

export interface ContactAndConversation {
  contact: Contact;
  conversation: Conversation;
  /** True the first time we ever see this person on this Page. */
  isNew: boolean;
}

/**
 * Finds or creates the contact and their conversation.
 *
 * The Free plan caps stored contacts, but a cap must never silently drop a
 * real message — so an over-quota workspace still gets the row, and the limit
 * is enforced where it can be surfaced honestly instead.
 */
export async function upsertContact(
  account: ConnectedAccount & { workspace?: { plan: string } },
  psid: string,
  options: { fetchProfile?: boolean } = {},
): Promise<ContactAndConversation> {
  const existing = await prisma.contact.findUnique({
    where: { connectedAccountId_psid: { connectedAccountId: account.id, psid } },
    include: { conversation: true },
  });

  if (existing?.conversation) {
    return { contact: existing, conversation: existing.conversation, isNew: false };
  }

  if (existing && !existing.conversation) {
    const conversation = await prisma.conversation.create({
      data: { connectedAccountId: account.id, contactId: existing.id },
    });
    return { contact: existing, conversation, isNew: false };
  }

  // New person. Look up their profile so the inbox shows a name, not a PSID.
  let profile = null;
  if (options.fetchProfile !== false) {
    const token = tryDecrypt(account.accessTokenCipher);
    if (token) profile = await fetchUserProfile(psid, token);
  }

  const contact = await prisma.contact.create({
    data: {
      connectedAccountId: account.id,
      psid,
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
      profilePicUrl: profile?.profile_pic ?? null,
      locale: profile?.locale ?? null,
      timezoneOffset: profile?.timezone ?? null,
      conversation: { create: { connectedAccountId: account.id } },
    },
    include: { conversation: true },
  });

  return {
    contact,
    conversation: contact.conversation!,
    isNew: true,
  };
}

export interface RecordInboundInput {
  account: ConnectedAccount;
  contact: Contact;
  conversation: Conversation;
  externalId: string | null;
  text: string | null;
  payload?: Record<string, unknown> | null;
  timestamp: Date;
}

/**
 * Stores an inbound message and refreshes everything that depends on "the
 * contact just messaged us".
 *
 * Returns null when the message is a duplicate, so callers can stop rather than
 * firing an automation twice off one redelivered webhook.
 */
export async function recordInbound(
  input: RecordInboundInput,
): Promise<{ messageId: string } | null> {
  const { account, contact, conversation, externalId, text, timestamp } = input;

  if (externalId) {
    const existing = await prisma.message.findUnique({
      where: { externalId },
      select: { id: true },
    });
    if (existing) return null;
  }

  try {
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'inbound',
        status: 'delivered',
        source: 'contact',
        text,
        payload: (input.payload ?? null) as Prisma.InputJsonValue,
        externalId,
        createdAt: timestamp,
      },
    });

    await prisma.$transaction([
      // This is the write that reopens the 24-hour messaging window.
      prisma.contact.update({
        where: { id: contact.id },
        data: { lastInboundAt: timestamp, isBlocked: false },
      }),
      prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: timestamp,
          lastMessagePreview: describeMessage(input.payload ?? null, text),
          unreadCount: { increment: 1 },
          isArchived: false,
        },
      }),
    ]);

    return { messageId: message.id };
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: unknown }).code === 'P2002'
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * A reply is the clearest possible signal that a nudge is no longer needed.
 * Cancelling here means nobody is ever reminded about something they already
 * answered.
 */
export async function cancelPendingFollowUps(
  contactId: string,
  reason: string,
): Promise<void> {
  const pending = await prisma.followUpJob.findMany({
    where: { contactId, status: 'scheduled' },
  });
  if (pending.length === 0) return;

  const { cancelFollowUp } = await import('../queues/index.js');

  await prisma.followUpJob.updateMany({
    where: { contactId, status: 'scheduled' },
    data: { status: 'canceled', canceledReason: reason },
  });

  await Promise.all(
    pending.map((job) => cancelFollowUp(job.automationId, job.contactId, job.stepId)),
  );

  logger.debug({ contactId, count: pending.length, reason }, 'cancelled pending follow-ups');
}

/**
 * Finds a run parked on a lead-capture step for this contact, so the reply can
 * be consumed by the automation instead of being treated as a new trigger.
 */
export async function findWaitingRun(contactId: string): Promise<string | null> {
  const run = await prisma.automationRun.findFirst({
    where: {
      contactId,
      status: 'waiting',
      waitingFor: { in: ['ask_email', 'ask_phone'] },
    },
    orderBy: { waitingSince: 'desc' },
    select: { id: true },
  });
  return run?.id ?? null;
}

/** Marks the contact as having asked to be left alone. */
const OPT_OUT_PHRASES = ['stop', 'unsubscribe', 'opt out', 'optout', 'remove me'];

export function looksLikeOptOut(text: string | null): boolean {
  if (!text) return false;
  const normalised = text.trim().toLowerCase();
  if (normalised.length > 24) return false;
  return OPT_OUT_PHRASES.some((phrase) => normalised === phrase || normalised === `${phrase}.`);
}

export async function optOut(contactId: string): Promise<void> {
  await prisma.contact.update({
    where: { id: contactId },
    data: { optedOutAt: new Date() },
  });
  await cancelPendingFollowUps(contactId, 'contact opted out');
  await prisma.automationRun.updateMany({
    where: { contactId, status: { in: ['running', 'waiting'] } },
    data: { status: 'abandoned', error: 'Contact opted out', completedAt: new Date() },
  });
}

export { assertContactQuota };
