import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, type Plan as DbPlan } from '@leadwave/db';
import { PLANS, PLAN_DEFINITIONS, limitsFor, type Plan } from '@leadwave/shared';
import { env } from '../env.js';
import { badRequest, notFound } from '../lib/errors.js';
import { handler, ok, parseBody } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { attachWorkspace, requireRole } from '../middleware/workspace.js';
import { currentPeriod } from '../services/entitlements.js';
import { lemonSqueezyAdapter } from '../services/billing/lemonsqueezy.js';
import { paddleAdapter } from '../services/billing/paddle.js';
import type { BillingProviderAdapter, SubscriptionEvent } from '../services/billing/provider.js';

/**
 * Billing.
 *
 * The provider is chosen by one environment variable and everything else is
 * written against the adapter interface, so moving between Paddle and Lemon
 * Squeezy does not touch a single line of product code.
 */

function adapter(): BillingProviderAdapter {
  if (env.BILLING_PROVIDER === 'lemonsqueezy') return lemonSqueezyAdapter;
  if (env.BILLING_PROVIDER === 'paddle') return paddleAdapter;

  // "manual" — plan changes are made by an admin. Useful before the merchant
  // account is approved, which can take a while.
  return {
    name: 'manual',
    isConfigured: false,
    async createCheckout() {
      throw badRequest('Checkout is not available yet. Contact support to change your plan.');
    },
    async createPortalSession() {
      throw badRequest('There is no billing portal on this deployment.');
    },
    parseWebhook: () => null,
  };
}

export const billingRouter: Router = Router();

/** The pricing table, straight from the shared plan definitions. */
billingRouter.get(
  '/plans',
  handler(async (_req, res) => {
    ok(res, {
      provider: env.BILLING_PROVIDER,
      configured: adapter().isConfigured,
      clientToken: env.BILLING_PROVIDER === 'paddle' ? (env.PADDLE_CLIENT_TOKEN ?? null) : null,
      environment: env.PADDLE_ENV,
      plans: PLANS.map((id) => {
        const def = PLAN_DEFINITIONS[id];
        return {
          id,
          name: def.name,
          tagline: def.tagline,
          priceMonthlyUsd: def.priceMonthlyUsd,
          priceYearlyUsd: def.priceYearlyUsd,
          features: def.features,
          limits: def.limits,
        };
      }),
    });
  }),
);

billingRouter.use(requireAuth, attachWorkspace);

billingRouter.post(
  '/checkout',
  requireRole('admin'),
  handler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({
        plan: z.enum(['pro', 'growth', 'business']),
        interval: z.enum(['month', 'year']).default('month'),
      }),
    );

    const workspace = req.workspace!;
    if (workspace.plan === body.plan) {
      throw badRequest(`You are already on ${PLAN_DEFINITIONS[body.plan].name}.`);
    }

    const session = await adapter().createCheckout({
      workspaceId: workspace.id,
      plan: body.plan,
      interval: body.interval,
      email: req.user!.email,
      successUrl: `${env.APP_URL}/settings?upgraded=1`,
    });

    ok(res, {
      ...session,
      /** Paddle's overlay needs these passed through to Paddle.js. */
      customData: { workspaceId: workspace.id },
      email: req.user!.email,
    });
  }),
);

billingRouter.post(
  '/portal',
  requireRole('admin'),
  handler(async (req, res) => {
    const subscription = await prisma.subscription.findUnique({
      where: { workspaceId: req.workspace!.id },
    });

    if (!subscription?.providerCustomerId) {
      throw notFound('There is no subscription to manage yet.');
    }

    const session = await adapter().createPortalSession(subscription.providerCustomerId);
    ok(res, session);
  }),
);

/**
 * What a downgrade would cost you.
 *
 * Shown before the user confirms, because losing a feature silently after the
 * fact is the worst possible way to find out.
 */
billingRouter.get(
  '/downgrade-impact',
  handler(async (req, res) => {
    const workspace = req.workspace!;
    const target: Plan = 'free';
    const current = workspace.plan as Plan;
    const targetLimits = limitsFor(target);

    const [pages, contacts, automations, seats] = await Promise.all([
      prisma.connectedAccount.count({ where: { workspaceId: workspace.id } }),
      prisma.contact.count({ where: { connectedAccount: { workspaceId: workspace.id } } }),
      prisma.automation.count({ where: { connectedAccount: { workspaceId: workspace.id } } }),
      prisma.workspaceMember.count({ where: { workspaceId: workspace.id } }),
    ]);

    const warnings: string[] = [];
    if (targetLimits.connectedPages !== null && pages > targetLimits.connectedPages) {
      warnings.push(
        `You have ${pages} Pages connected. The Free plan allows ${targetLimits.connectedPages}.`,
      );
    }
    if (targetLimits.contacts !== null && contacts > targetLimits.contacts) {
      warnings.push(
        `You have ${contacts.toLocaleString()} contacts. The Free plan stores ${targetLimits.contacts}.`,
      );
    }
    if (targetLimits.automations !== null && automations > targetLimits.automations) {
      warnings.push(
        `You have ${automations} automations. The Free plan runs ${targetLimits.automations}.`,
      );
    }
    if (seats > targetLimits.teamSeats) {
      warnings.push(`Your ${seats} team members would lose access.`);
    }

    const lost = PLAN_DEFINITIONS[current].features.filter(
      (f) => !PLAN_DEFINITIONS[target].features.includes(f),
    );

    ok(res, { from: current, to: target, warnings, featuresLost: lost });
  }),
);

// ─── Webhook ─────────────────────────────────────────────────────────────────

/**
 * The provider's webhook. Mounted outside the authenticated router because it
 * is authenticated by signature over the raw body.
 */
export function handleBillingWebhook(
  req: Request & { rawBody?: Buffer },
  res: Response,
): void {
  const event = adapter().parseWebhook(
    req.rawBody ?? Buffer.alloc(0),
    req.headers as Record<string, string | undefined>,
  );

  // Always 200: a rejected or uninteresting event is not something the provider
  // should keep retrying.
  res.sendStatus(200);

  if (!event) return;

  void applySubscriptionEvent(event).catch((err: unknown) => {
    logger.error({ err, type: event.type }, 'could not apply billing event');
  });
}

async function applySubscriptionEvent(event: SubscriptionEvent): Promise<void> {
  // Prefer the workspace id we passed through checkout; fall back to matching
  // the provider's customer id for renewals, where custom data is not resent.
  const workspaceId =
    event.workspaceId ??
    (
      await prisma.subscription.findFirst({
        where: { providerCustomerId: event.providerCustomerId },
        select: { workspaceId: true },
      })
    )?.workspaceId;

  if (!workspaceId) {
    logger.warn(
      { customerId: event.providerCustomerId },
      'billing event could not be matched to a workspace',
    );
    return;
  }

  const plan: DbPlan = event.type === 'canceled' ? 'free' : (event.plan as DbPlan);

  await prisma.$transaction([
    prisma.subscription.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        provider: adapter().name === 'manual' ? 'manual' : (adapter().name as 'paddle' | 'lemonsqueezy'),
        providerCustomerId: event.providerCustomerId,
        providerSubscriptionId: event.providerSubscriptionId,
        priceId: event.priceId,
        plan,
        status: event.status,
        interval: event.interval,
        currency: event.currency,
        currentPeriodStart: event.currentPeriodStart,
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
      },
      update: {
        providerCustomerId: event.providerCustomerId,
        providerSubscriptionId: event.providerSubscriptionId,
        priceId: event.priceId,
        plan,
        status: event.status,
        interval: event.interval,
        currency: event.currency,
        currentPeriodStart: event.currentPeriodStart,
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
      },
    }),
    // The plan on the workspace is what every gate reads, so it must move in
    // the same transaction as the subscription row.
    prisma.workspace.update({ where: { id: workspaceId }, data: { plan } }),
  ]);

  // An upgrade should unlock its AI allowance immediately rather than at the
  // next cycle — which means the counter for the current period resets now.
  if (event.type === 'activated' || event.type === 'updated') {
    const { periodStart, periodEnd } = await currentPeriod(workspaceId);
    await prisma.usageCounter.upsert({
      where: { workspaceId_periodStart: { workspaceId, periodStart } },
      create: { workspaceId, periodStart, periodEnd },
      update: { aiCreditsUsed: 0 },
    });

    await prisma.aiCreditLedger.create({
      data: {
        workspaceId,
        delta: limitsFor(plan as Plan).aiCreditsPerMonth,
        reason: 'plan_change',
        note: `Moved to ${PLAN_DEFINITIONS[plan as Plan].name}`,
      },
    });
  }

  logger.info({ workspaceId, plan, type: event.type }, 'applied billing event');
}
