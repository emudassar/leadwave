import { prisma, type Plan as DbPlan, type UsageCounter } from '@leadwave/db';
import {
  hasFeature,
  limitsFor,
  minimumPlanFor,
  planDefinition,
  withinLimit,
  type Feature,
  type Plan,
} from '@leadwave/shared';
import { limitReached, upgradeRequired } from '../lib/errors.js';

/**
 * Plan enforcement. The SPA renders locks from the same table in
 * @leadwave/shared, but this module is the only thing that actually decides —
 * a client that ignores its own UI still hits these checks.
 */

export function planOf(workspace: { plan: DbPlan }): Plan {
  return workspace.plan as Plan;
}

/** Throws a 402 the SPA can turn into the right upgrade prompt. */
export function assertFeature(plan: Plan, feature: Feature, what: string): void {
  if (hasFeature(plan, feature)) return;
  const required = minimumPlanFor(feature);
  throw upgradeRequired(
    `${what} is available on ${required ? planDefinition(required).name : 'a paid plan'}.`,
    required ?? 'pro',
    feature,
  );
}

export function canUseFeature(plan: Plan, feature: Feature): boolean {
  return hasFeature(plan, feature);
}

// ─── Usage counters ──────────────────────────────────────────────────────────

/**
 * Usage is tracked per billing cycle. The row is created on first use and reset
 * (never carried forward) at rollover — which is what makes "no rollover, no
 * overage" true by construction rather than by policy.
 */
export async function currentUsage(workspaceId: string): Promise<UsageCounter> {
  const { periodStart, periodEnd } = await currentPeriod(workspaceId);

  const existing = await prisma.usageCounter.findUnique({
    where: { workspaceId_periodStart: { workspaceId, periodStart } },
  });
  if (existing) return existing;

  return prisma.usageCounter.create({
    data: { workspaceId, periodStart, periodEnd },
  });
}

/**
 * The active billing window. Paid workspaces follow the provider's period;
 * free workspaces roll on the calendar month.
 */
export async function currentPeriod(
  workspaceId: string,
): Promise<{ periodStart: Date; periodEnd: Date }> {
  const subscription = await prisma.subscription.findUnique({ where: { workspaceId } });

  if (subscription?.currentPeriodEnd && subscription.currentPeriodEnd > new Date()) {
    return {
      periodStart: startOfMinute(subscription.currentPeriodStart),
      periodEnd: subscription.currentPeriodEnd,
    };
  }

  const now = new Date();
  return {
    periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

function startOfMinute(d: Date): Date {
  const copy = new Date(d);
  copy.setSeconds(0, 0);
  return copy;
}

// ─── Limit checks ────────────────────────────────────────────────────────────

/**
 * Checks the monthly message cap before an outbound send. Returns rather than
 * throws, because the send pipeline needs to record *why* a message was held.
 */
export async function checkMessageQuota(
  workspaceId: string,
  plan: Plan,
): Promise<{ allowed: boolean; limit: number | null; used: number }> {
  const limit = limitsFor(plan).messagesPerMonth;
  if (limit === null) return { allowed: true, limit, used: 0 };

  const usage = await currentUsage(workspaceId);
  return { allowed: withinLimit(limit, usage.messagesSent), limit, used: usage.messagesSent };
}

export async function assertMessageQuota(workspaceId: string, plan: Plan): Promise<void> {
  const { allowed, limit, used } = await checkMessageQuota(workspaceId, plan);
  if (!allowed && limit !== null) {
    throw limitReached(
      `You have used all ${limit.toLocaleString()} messages on your plan this month.`,
      limit,
      used,
    );
  }
}

export async function recordMessagesSent(workspaceId: string, count = 1): Promise<void> {
  const { periodStart } = await currentPeriod(workspaceId);
  await prisma.usageCounter.update({
    where: { workspaceId_periodStart: { workspaceId, periodStart } },
    data: { messagesSent: { increment: count } },
  });
}

/** Contacts and leads are capped on Free only; both are unlimited above it. */
export async function assertContactQuota(workspaceId: string, plan: Plan): Promise<void> {
  const limit = limitsFor(plan).contacts;
  if (limit === null) return;

  const used = await prisma.contact.count({
    where: { connectedAccount: { workspaceId } },
  });
  if (!withinLimit(limit, used)) {
    throw limitReached(
      `The Free plan stores ${limit} contacts. Upgrade to keep every conversation.`,
      limit,
      used,
    );
  }
}

export async function checkLeadQuota(
  workspaceId: string,
  plan: Plan,
): Promise<{ allowed: boolean; limit: number | null; used: number }> {
  const limit = limitsFor(plan).leads;
  if (limit === null) return { allowed: true, limit, used: 0 };

  const usage = await currentUsage(workspaceId);
  return { allowed: withinLimit(limit, usage.leadsCaptured), limit, used: usage.leadsCaptured };
}

export async function assertPageQuota(workspaceId: string, plan: Plan): Promise<void> {
  const limit = limitsFor(plan).connectedPages;
  if (limit === null) return;

  const used = await prisma.connectedAccount.count({
    where: { workspaceId, status: { not: 'disabled' } },
  });
  if (!withinLimit(limit, used)) {
    throw limitReached(
      `Your plan connects ${limit} Facebook ${limit === 1 ? 'Page' : 'Pages'}.`,
      limit,
      used,
    );
  }
}

export async function assertAutomationQuota(workspaceId: string, plan: Plan): Promise<void> {
  const limit = limitsFor(plan).automations;
  if (limit === null) return;

  const used = await prisma.automation.count({
    where: { connectedAccount: { workspaceId } },
  });
  if (!withinLimit(limit, used)) {
    throw limitReached(`The Free plan runs ${limit} automations at a time.`, limit, used);
  }
}

export async function assertSeatQuota(workspaceId: string, plan: Plan): Promise<void> {
  const limit = limitsFor(plan).teamSeats;
  const used =
    (await prisma.workspaceMember.count({ where: { workspaceId } })) +
    (await prisma.invite.count({ where: { workspaceId, acceptedAt: null } }));

  if (!withinLimit(limit, used)) {
    throw limitReached(
      limit <= 1
        ? 'Team seats are available on the Business plan.'
        : `Your plan includes ${limit} seats.`,
      limit,
      used,
    );
  }
}

export function assertIceBreakerQuota(plan: Plan, used: number): void {
  const limit = limitsFor(plan).iceBreakers;
  if (!withinLimit(limit, used)) {
    throw limitReached(`Your plan allows ${limit} ice breakers.`, limit, used);
  }
}

/**
 * Analytics retention. Free sees 30 days; paid plans see everything. Returns
 * the earliest timestamp a query may reach back to.
 */
export function analyticsFloor(plan: Plan): Date | null {
  const days = limitsFor(plan).analyticsRetentionDays;
  if (days === null) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
