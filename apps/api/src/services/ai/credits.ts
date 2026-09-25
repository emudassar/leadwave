import { prisma, type CreditLedgerReason } from '@leadwave/db';
import { limitsFor, type Plan } from '@leadwave/shared';
import { currentPeriod, currentUsage } from '../entitlements.js';

/**
 * AI credits.
 *
 * One credit is one AI reply that actually reached someone. Everything else is
 * free — classification, skips, failed sends, keyword automations, goals,
 * language matching, knowledge editing — which is why the skip breakdown on the
 * Overview page can honestly be labelled "the credits you did not spend".
 *
 * There is no overage and no top-up, by design: a post that takes off cannot
 * produce a surprise bill. When the allowance runs out the AI pauses and every
 * non-AI automation keeps running exactly as before.
 */

export interface CreditBalance {
  included: number;
  bonus: number;
  used: number;
  remaining: number;
  periodStart: Date;
  periodEnd: Date;
  hasAi: boolean;
}

export async function creditBalance(workspaceId: string, plan: Plan): Promise<CreditBalance> {
  const usage = await currentUsage(workspaceId);
  const included = limitsFor(plan).aiCreditsPerMonth;
  const bonus = usage.aiCreditsBonus;

  return {
    included,
    bonus,
    used: usage.aiCreditsUsed,
    remaining: Math.max(0, included + bonus - usage.aiCreditsUsed),
    periodStart: usage.periodStart,
    periodEnd: usage.periodEnd,
    hasAi: included > 0,
  };
}

export async function hasCreditsRemaining(workspaceId: string, plan: Plan): Promise<boolean> {
  if (limitsFor(plan).aiCreditsPerMonth === 0) return false;
  const balance = await creditBalance(workspaceId, plan);
  return balance.remaining > 0;
}

/**
 * Charges for a reply that was sent. Called *after* delivery, never before — a
 * send that fails at Meta's end costs nothing, because nothing reached anyone.
 *
 * A comment reply and the private message it triggers are one funnel, so they
 * are charged once between them.
 */
export async function chargeCredits(input: {
  workspaceId: string;
  amount: number;
  reason: CreditLedgerReason;
  aiEventId?: string | null;
  note?: string;
}): Promise<void> {
  if (input.amount <= 0) return;

  const { periodStart } = await currentPeriod(input.workspaceId);

  await prisma.$transaction([
    prisma.usageCounter.update({
      where: { workspaceId_periodStart: { workspaceId: input.workspaceId, periodStart } },
      data: { aiCreditsUsed: { increment: input.amount } },
    }),
    prisma.aiCreditLedger.create({
      data: {
        workspaceId: input.workspaceId,
        delta: -input.amount,
        reason: input.reason,
        aiEventId: input.aiEventId ?? null,
        note: input.note ?? null,
      },
    }),
  ]);
}

/** Support and promo grants. Positive delta, recorded like everything else. */
export async function grantCredits(input: {
  workspaceId: string;
  amount: number;
  note: string;
}): Promise<void> {
  const { periodStart } = await currentPeriod(input.workspaceId);

  await prisma.$transaction([
    prisma.usageCounter.update({
      where: { workspaceId_periodStart: { workspaceId: input.workspaceId, periodStart } },
      data: { aiCreditsBonus: { increment: input.amount } },
    }),
    prisma.aiCreditLedger.create({
      data: {
        workspaceId: input.workspaceId,
        delta: input.amount,
        reason: 'admin_grant',
        note: input.note,
      },
    }),
  ]);
}

/**
 * The skip breakdown the Overview page renders. Counts only, grouped by why the
 * AI stayed out — every one of these was free.
 */
export async function skipBreakdown(
  connectedAccountId: string,
  since: Date,
): Promise<Array<{ reason: string; count: number }>> {
  const rows = await prisma.aiEvent.groupBy({
    by: ['skipReason'],
    where: {
      connectedAccountId,
      kind: { in: ['message_skip', 'comment_skip'] },
      createdAt: { gte: since },
      skipReason: { not: null },
    },
    _count: { _all: true },
  });

  return rows
    .map((r) => ({ reason: r.skipReason ?? 'unknown', count: r._count._all }))
    .sort((a, b) => b.count - a.count);
}
