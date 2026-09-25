import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Plan } from '@leadwave/shared';
import { configured, env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import {
  BillingNotConfiguredError,
  type BillingInterval,
  type BillingProviderAdapter,
  type CheckoutRequest,
  type CheckoutSession,
  type PortalSession,
  type SubscriptionEvent,
} from './provider.js';

/**
 * Paddle (Billing v2).
 *
 * Paddle is a merchant of record: it takes the payment, handles sales tax in
 * every jurisdiction, and pays out — via Payoneer, which is what makes it
 * workable from Pakistan where Stripe is not available.
 *
 * Checkout runs as an inline overlay rather than a redirect, so the price id is
 * returned to the client and the transaction is created there. The workspace id
 * travels in `custom_data` and comes back on the webhook, which is how a
 * payment finds its way to the right account.
 */

const API = () =>
  env.PADDLE_ENV === 'production'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com';

function priceMap(): Record<string, { plan: Plan; interval: BillingInterval }> {
  const entries: Array<[string | undefined, { plan: Plan; interval: BillingInterval }]> = [
    [env.PADDLE_PRICE_PRO_MONTHLY, { plan: 'pro', interval: 'month' }],
    [env.PADDLE_PRICE_PRO_YEARLY, { plan: 'pro', interval: 'year' }],
    [env.PADDLE_PRICE_GROWTH_MONTHLY, { plan: 'growth', interval: 'month' }],
    [env.PADDLE_PRICE_GROWTH_YEARLY, { plan: 'growth', interval: 'year' }],
    [env.PADDLE_PRICE_BUSINESS_MONTHLY, { plan: 'business', interval: 'month' }],
    [env.PADDLE_PRICE_BUSINESS_YEARLY, { plan: 'business', interval: 'year' }],
  ];

  return Object.fromEntries(
    entries.filter((e): e is [string, { plan: Plan; interval: BillingInterval }] => Boolean(e[0])),
  );
}

function priceIdFor(plan: Plan, interval: BillingInterval): string | null {
  const key = `PADDLE_PRICE_${plan.toUpperCase()}_${interval === 'year' ? 'YEARLY' : 'MONTHLY'}`;
  return (env as unknown as Record<string, string | undefined>)[key] ?? null;
}

export const paddleAdapter: BillingProviderAdapter = {
  name: 'paddle',
  get isConfigured() {
    return configured.paddle;
  },

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    if (!configured.paddle) throw new BillingNotConfiguredError('paddle');

    const priceId = priceIdFor(request.plan, request.interval);
    if (!priceId) {
      throw new Error(`No Paddle price configured for ${request.plan} (${request.interval}).`);
    }

    // The overlay needs only the price and the custom data; the transaction is
    // created client-side by Paddle.js.
    return { url: null, priceId, provider: 'paddle' };
  },

  async createPortalSession(providerCustomerId: string): Promise<PortalSession> {
    if (!configured.paddle) throw new BillingNotConfiguredError('paddle');

    const res = await fetch(`${API()}/customers/${providerCustomerId}/portal-sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.PADDLE_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!res.ok) throw new Error(`Paddle portal session failed: ${await res.text()}`);

    const json = (await res.json()) as {
      data?: { urls?: { general?: { overview?: string } } };
    };
    const url = json.data?.urls?.general?.overview;
    if (!url) throw new Error('Paddle did not return a portal URL.');

    return { url };
  },

  parseWebhook(rawBody, headers) {
    if (!env.PADDLE_WEBHOOK_SECRET) return null;

    const signature = headers['paddle-signature'];
    if (!verifySignature(rawBody, signature, env.PADDLE_WEBHOOK_SECRET)) {
      logger.warn('rejected paddle webhook with a bad signature');
      return null;
    }

    const event = JSON.parse(rawBody.toString('utf8')) as PaddleEvent;
    return normalise(event);
  },
};

// ─── Signature ───────────────────────────────────────────────────────────────

/**
 * Paddle signs `ts:body` with HMAC-SHA256. The timestamp is checked too, so a
 * captured webhook cannot be replayed days later.
 */
function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;

  const parts = Object.fromEntries(
    header.split(';').map((p) => {
      const [k, v] = p.split('=');
      return [k ?? '', v ?? ''];
    }),
  );

  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;

  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = createHmac('sha256', secret)
    .update(`${ts}:${rawBody.toString('utf8')}`)
    .digest('hex');

  const a = Buffer.from(h1);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Normalisation ───────────────────────────────────────────────────────────

interface PaddleEvent {
  event_type: string;
  data: {
    id: string;
    customer_id: string;
    status: string;
    currency_code?: string;
    scheduled_change?: { action?: string } | null;
    current_billing_period?: { starts_at?: string; ends_at?: string } | null;
    custom_data?: { workspaceId?: string } | null;
    items?: Array<{ price?: { id?: string } }>;
  };
}

const STATUS_MAP: Record<string, SubscriptionEvent['status']> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  paused: 'paused',
  canceled: 'canceled',
};

function normalise(event: PaddleEvent): SubscriptionEvent | null {
  const type = ((): SubscriptionEvent['type'] | null => {
    switch (event.event_type) {
      case 'subscription.created':
      case 'subscription.activated':
        return 'activated';
      case 'subscription.updated':
      case 'subscription.resumed':
        return 'updated';
      case 'subscription.canceled':
      case 'subscription.paused':
        return 'canceled';
      case 'transaction.payment_failed':
        return 'payment_failed';
      default:
        return null;
    }
  })();

  if (!type) return null;

  const { data } = event;
  const priceId = data.items?.[0]?.price?.id ?? null;
  const mapped = priceId ? priceMap()[priceId] : undefined;

  // An unrecognised price means someone added a plan in Paddle that this build
  // does not know about. Downgrading to free would be worse than ignoring it.
  if (!mapped && type !== 'canceled') {
    logger.warn({ priceId, eventType: event.event_type }, 'paddle event with an unknown price');
    return null;
  }

  return {
    type,
    providerCustomerId: data.customer_id,
    providerSubscriptionId: data.id,
    plan: type === 'canceled' ? 'free' : (mapped?.plan ?? 'free'),
    interval: mapped?.interval ?? 'month',
    status: STATUS_MAP[data.status] ?? 'active',
    currency: data.currency_code ?? 'USD',
    currentPeriodStart: data.current_billing_period?.starts_at
      ? new Date(data.current_billing_period.starts_at)
      : new Date(),
    currentPeriodEnd: data.current_billing_period?.ends_at
      ? new Date(data.current_billing_period.ends_at)
      : null,
    cancelAtPeriodEnd: data.scheduled_change?.action === 'cancel',
    workspaceId: data.custom_data?.workspaceId ?? null,
    priceId,
  };
}

export { priceIdFor as paddlePriceIdFor };
