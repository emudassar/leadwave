import { prisma } from '@leadwave/db';
import { AI_LIMITS } from '@leadwave/shared';
import { logger } from '../../lib/logger.js';
import type { GoalEvaluationJob } from '../index.js';

/**
 * Did the goal actually work?
 *
 * Every answer here is computed from LeadWave's own instrumentation — a
 * recorded link click, a field on the contact record, a confirmed follow.
 * Nothing is stored as a counter the model could inflate, and neither number on
 * the Goals card is self-reported by the model.
 *
 * Runs twice for a grow-followers goal: once after an hour, once at the end of
 * the 7-day window.
 */
export async function evaluateGoal(job: GoalEvaluationJob): Promise<void> {
  const event = await prisma.aiEvent.findUnique({
    where: { id: job.aiEventId },
    include: { goal: true },
  });

  if (!event?.goal || !event.goalId) return;
  // Already counted; a goal succeeds at most once.
  if (event.goalSucceededAt) return;

  const succeeded = await didSucceed(event.goal.type, {
    goalId: event.goalId,
    contactId: event.contactId,
    since: event.createdAt,
  });

  if (!succeeded) return;

  await prisma.$transaction([
    prisma.aiEvent.update({
      where: { id: event.id },
      data: { goalSucceededAt: new Date() },
    }),
    prisma.aiGoal.update({
      where: { id: event.goalId },
      data: { successCount: { increment: 1 } },
    }),
  ]);

  logger.debug(
    { aiEventId: event.id, goalType: event.goal.type },
    'ai goal recorded as successful',
  );
}

async function didSucceed(
  type: string,
  ctx: { goalId: string; contactId: string | null; since: Date },
): Promise<boolean> {
  switch (type) {
    /**
     * Sharing a link is attempted when the link goes out. It succeeds only when
     * that contact actually clicked it — sending is not success.
     */
    case 'share_link': {
      const click = await prisma.linkClick.findFirst({
        where: {
          shortLink: { aiGoalId: ctx.goalId },
          createdAt: { gte: ctx.since },
          ...(ctx.contactId ? { contactId: ctx.contactId } : {}),
        },
        select: { id: true },
      });
      return Boolean(click);
    }

    /**
     * Asking for a lead is the attempt. Success is an email or phone number
     * landing on that contact's record afterwards.
     */
    case 'capture_lead': {
      if (!ctx.contactId) return false;
      const lead = await prisma.lead.findFirst({
        where: { contactId: ctx.contactId, createdAt: { gte: ctx.since } },
        select: { id: true },
      });
      return Boolean(lead);
    }

    /**
     * The follow nudge is the attempt. Success is a confirmed follow within 7
     * days — and on Facebook a confirmed follow means the contact tapped the
     * confirmation, since Meta exposes no per-user follow signal.
     */
    case 'grow_followers': {
      if (!ctx.contactId) return false;
      const contact = await prisma.contact.findUnique({
        where: { id: ctx.contactId },
        select: { followConfirmedAt: true },
      });
      if (!contact?.followConfirmedAt) return false;

      const deadline = new Date(
        ctx.since.getTime() + AI_LIMITS.followGoalWindowDays * 24 * 60 * 60 * 1000,
      );
      return contact.followConfirmedAt >= ctx.since && contact.followConfirmedAt <= deadline;
    }

    default:
      return false;
  }
}
