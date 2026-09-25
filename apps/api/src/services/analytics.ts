import { prisma } from '@leadwave/db';
import { PLAN_DEFINITIONS, PLANS, type Plan } from '@leadwave/shared';

/**
 * Founder-facing product analytics: signups, MRR, plan mix. Nothing here is
 * shown to a workspace — it is the one screen that answers "is anyone using
 * this" for the person who built it.
 */

/** Monthly-equivalent revenue of one subscription, in whole cents. */
function monthlyCents(plan: Plan, interval: string): number {
  const def = PLAN_DEFINITIONS[plan];
  const usd = interval === 'year' ? def.priceYearlyUsd / 12 : def.priceMonthlyUsd;
  return Math.round(usd * 100);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysAgo(n: number): Date {
  return startOfUtcDay(new Date(Date.now() - n * 24 * 60 * 60 * 1000));
}

/** Current MRR across every workspace, plus the plan breakdown behind it. */
export async function currentMrr(): Promise<{
  mrrCents: number;
  activeSubscriptions: number;
  byPlan: Record<Plan, { workspaces: number; mrrCents: number }>;
}> {
  const subs = await prisma.subscription.findMany({
    where: { status: { in: ['active', 'past_due'] } },
    select: { plan: true, interval: true },
  });

  const byPlan = Object.fromEntries(
    PLANS.map((p) => [p, { workspaces: 0, mrrCents: 0 }]),
  ) as Record<Plan, { workspaces: number; mrrCents: number }>;

  let mrrCents = 0;
  for (const sub of subs) {
    const plan = sub.plan as Plan;
    if (plan === 'free') continue; // free carries no revenue by definition
    const cents = monthlyCents(plan, sub.interval);
    mrrCents += cents;
    byPlan[plan].workspaces += 1;
    byPlan[plan].mrrCents += cents;
  }

  return { mrrCents, activeSubscriptions: subs.filter((s) => s.plan !== 'free').length, byPlan };
}

/** Writes (or refreshes) today's row. Safe to call repeatedly. */
export async function snapshotDailyMetrics(): Promise<void> {
  const day = startOfUtcDay(new Date());

  const [totalUsers, totalWorkspaces, mrr] = await Promise.all([
    prisma.user.count(),
    prisma.workspace.count(),
    currentMrr(),
  ]);

  await prisma.metricSnapshot.upsert({
    where: { day },
    create: {
      day,
      totalUsers,
      totalWorkspaces,
      activeSubscriptions: mrr.activeSubscriptions,
      mrrCents: mrr.mrrCents,
    },
    update: {
      totalUsers,
      totalWorkspaces,
      activeSubscriptions: mrr.activeSubscriptions,
      mrrCents: mrr.mrrCents,
    },
  });
}

export interface AdminAnalytics {
  overview: {
    totalUsers: number;
    totalWorkspaces: number;
    newUsers7d: number;
    newUsers30d: number;
    mrrUsd: number;
    arrUsd: number;
    activeSubscriptions: number;
    trialingSubscriptions: number;
  };
  planBreakdown: Array<{ plan: Plan; workspaces: number; mrrUsd: number }>;
  signups: Array<{ date: string; users: number; workspaces: number }>;
  mrrHistory: Array<{ date: string; mrrUsd: number; totalUsers: number }>;
  recentSignups: Array<{
    id: string;
    name: string | null;
    email: string;
    createdAt: string;
    plan: Plan;
  }>;
}

export async function buildAdminAnalytics(): Promise<AdminAnalytics> {
  const rangeStart = daysAgo(89); // 90-day window, inclusive of today

  const [
    totalUsers,
    totalWorkspaces,
    newUsers7d,
    newUsers30d,
    mrr,
    trialingSubscriptions,
    usersInRange,
    workspacesInRange,
    snapshots,
    recentUsers,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.workspace.count(),
    prisma.user.count({ where: { createdAt: { gte: daysAgo(6) } } }),
    prisma.user.count({ where: { createdAt: { gte: daysAgo(29) } } }),
    currentMrr(),
    prisma.subscription.count({ where: { status: 'trialing' } }),
    prisma.user.findMany({
      where: { createdAt: { gte: rangeStart } },
      select: { createdAt: true },
    }),
    prisma.workspace.findMany({
      where: { createdAt: { gte: rangeStart } },
      select: { createdAt: true },
    }),
    prisma.metricSnapshot.findMany({
      where: { day: { gte: rangeStart } },
      orderBy: { day: 'asc' },
    }),
    prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        memberships: {
          take: 1,
          orderBy: { createdAt: 'asc' },
          select: { workspace: { select: { plan: true } } },
        },
      },
    }),
  ]);

  const bucket = (rows: Array<{ createdAt: Date }>): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = startOfUtcDay(row.createdAt).toISOString().slice(0, 10);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };

  const userCounts = bucket(usersInRange);
  const workspaceCounts = bucket(workspacesInRange);

  const signups: AdminAnalytics['signups'] = [];
  for (let i = 89; i >= 0; i--) {
    const key = daysAgo(i).toISOString().slice(0, 10);
    signups.push({
      date: key,
      users: userCounts.get(key) ?? 0,
      workspaces: workspaceCounts.get(key) ?? 0,
    });
  }

  const mrrHistory = snapshots.map((s) => ({
    date: s.day.toISOString().slice(0, 10),
    mrrUsd: s.mrrCents / 100,
    totalUsers: s.totalUsers,
  }));

  return {
    overview: {
      totalUsers,
      totalWorkspaces,
      newUsers7d,
      newUsers30d,
      mrrUsd: mrr.mrrCents / 100,
      arrUsd: (mrr.mrrCents * 12) / 100,
      activeSubscriptions: mrr.activeSubscriptions,
      trialingSubscriptions,
    },
    planBreakdown: PLANS.map((plan) => ({
      plan,
      workspaces: mrr.byPlan[plan].workspaces,
      mrrUsd: mrr.byPlan[plan].mrrCents / 100,
    })),
    signups,
    mrrHistory,
    recentSignups: recentUsers.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      createdAt: u.createdAt.toISOString(),
      plan: (u.memberships[0]?.workspace.plan ?? 'free') as Plan,
    })),
  };
}
