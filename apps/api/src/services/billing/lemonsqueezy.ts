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
 * Lemon Squeezy — the swap-in alternative to Paddle.
 *
 * Also a merchant of record, also usable from Pakistan, but it pays out by bank
 * wire rather than Payoneer (PayPal payouts are not available to individuals
 * there), which is why Paddle is the default. Switching is a single environment
 * variable: `BILLING_PROVIDER=lemonsqueezy`.
 */

const API = 'https://api.lemonsqueezy.com/v1';

function variantMap(): Record<string, { plan: Plan; interval: BillingInterval }> {
  const entries: Array<[string | undefined, { plan: Plan; interval: BillingInterval }]> = [
    [env.LEMONSQUEEZY_VARIANT_PRO_MONTHLY, { plan: 'pro', interval: 'month' }],
    [env.LEMONSQUEEZY_VARIANT_PRO_YEARLY, { plan: 'pro', interval: 'year' }],
    [env.LEMONSQUEEZY_VARIANT_GROWTH_MONTHLY, { plan: 'growth', interval: 'month' }],
    [env.LEMONSQUEEZY_VARIANT_GROWTH_YEARLY, { plan: 'growth', interval: 'year' }],
    [env.LEMONSQUEEZY_VARIANT_BUSINESS_MONTHLY, { plan: 'business', interval: 'month' }],
    [env.LEMONSQUEEZY_VARIANT_BUSINESS_YEARLY, { plan: 'business', interval: 'year' }],
  ];

  return Object.fromEntries(
    entries.filter((e): e is [string, { plan: Plan; interval: BillingInterval }] => Boolean(e[0])),
  );
}

function variantIdFor(plan: Plan, interval: BillingInterval): string | null {
  const key = `LEMONSQUEEZY_VARIANT_${plan.toUpperCase()}_${interval === 'year' ? 'YEARLY' : 'MONTHLY'}`;
  return (env as unknown as Record<string, string | undefined>)[key] ?? null;
}

export const lemonSqueezyAdapter: BillingProviderAdapter = {
  name: 'lemonsqueezy',
  get isConfigured() {
    return configured.lemonsqueezy;
  },

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    if (!configured.lemonsqueezy) throw new BillingNotConfiguredError('lemonsqueezy');

    const variantId = variantIdFor(request.plan, request.interval);
    if (!variantId) {
      throw new Error(`No Lemon Squeezy variant configured for ${request.plan} (${request.interval}).`);
    }

    const res = await fetch(`${API}/checkouts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.LEMONSQUEEZY_API_KEY}`,
        'content-type': 'application/vnd.api+json',
        accept: 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              email: request.email,
              // Comes back on the webhook; this is how a payment finds its
              // workspace.
              custom: { workspace_id: request.workspaceId },
            },
            product_options: { redirect_url: request.successUrl },
          },
          relationships: {
            store: { data: { type: 'stores', id: String(env.LEMONSQUEEZY_STORE_ID) } },
            variant: { data: { type: 'variants', id: String(variantId) } },
          },
        },
      }),
    });

    if (!res.ok) throw new Error(`Lemon Squeezy checkout failed: ${await res.text()}`);

    const json = (await res.json()) as { data?: { attributes?: { url?: string } } };
    const url = json.data?.attributes?.url;
    if (!url) throw new Error('Lemon Squeezy did not return a checkout URL.');

    return { url, provider: 'lemonsqueezy' };
  },

  async createPortalSession(providerCustomerId: string): Promise<PortalSession> {
    if (!configured.lemonsqueezy) throw new BillingNotConfiguredError('lemonsqueezy');

    const res = await fetch(`${API}/customers/${providerCustomerId}`, {
      headers: {
        authorization: `Bearer ${env.LEMONSQUEEZY_API_KEY}`,
        accept: 'application/vnd.api+json',
      },
    });

    if (!res.ok) throw new Error(`Lemon Squeezy customer lookup failed: ${await res.text()}`);

    const json = (await res.json()) as {
      data?: { attributes?: { urls?: { customer_portal?: string } } };
    };
    const url = json.data?.attributes?.urls?.customer_portal;
    if (!url) throw new Error('Lemon Squeezy did not return a portal URL.');

    return { url };
  },

  parseWebhook(rawBody, headers) {
    if (!env.LEMONSQUEEZY_WEBHOOK_SECRET) return null;

    const signature = headers['x-signature'];
    if (!verifySignature(rawBody, signature, env.LEMONSQUEEZY_WEBHOOK_SECRET)) {
      logger.warn('rejected lemon squeezy webhook with a bad signature');
      return null;
    }

    const eventName = headers['x-event-name'] ?? '';
    const payload = JSON.parse(rawBody.toString('utf8')) as LemonEvent;
    return normalise(eventName, payload);
  },
};

function verifySignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface LemonEvent {
  meta?: { custom_data?: { workspace_id?: string } };
  data?: {
    id: string;
    attributes?: {
      customer_id?: number;
      variant_id?: number;
      status?: string;
      cancelled?: boolean;
      renews_at?: string | null;
      created_at?: string;
    };
  };
}

const STATUS_MAP: Record<string, SubscriptionEvent['status']> = {
  active: 'active',
  on_trial: 'trialing',
  past_due: 'past_due',
  paused: 'paused',
  cancelled: 'canceled',
  expired: 'canceled',
  unpaid: 'past_due',
};

function normalise(eventName: string, payload: LemonEvent): SubscriptionEvent | null {
  const type = ((): SubscriptionEvent['type'] | null => {
    switch (eventName) {
      case 'subscription_created':
        return 'activated';
      case 'subscription_updated':
      case 'subscription_resumed':
      case 'subscription_unpaused':
        return 'updated';
      case 'subscription_cancelled':
      case 'subscription_expired':
        return 'canceled';
      case 'subscription_payment_failed':
        return 'payment_failed';
      default:
        return null;
    }
  })();

  if (!type || !payload.data) return null;

  const attrs = payload.data.attributes ?? {};
  const variantId = attrs.variant_id ? String(attrs.variant_id) : null;
  const mapped = variantId ? variantMap()[variantId] : undefined;

  if (!mapped && type !== 'canceled') {
    logger.warn({ variantId, eventName }, 'lemon squeezy event with an unknown variant');
    return null;
  }

  const status = STATUS_MAP[attrs.status ?? ''] ?? 'active';

  return {
    type,
    providerCustomerId: String(attrs.customer_id ?? ''),
    providerSubscriptionId: payload.data.id,
    plan: type === 'canceled' ? 'free' : (mapped?.plan ?? 'free'),
    interval: mapped?.interval ?? 'month',
    status,
    currency: 'USD',
    currentPeriodStart: attrs.created_at ? new Date(attrs.created_at) : new Date(),
    currentPeriodEnd: attrs.renews_at ? new Date(attrs.renews_at) : null,
    cancelAtPeriodEnd: Boolean(attrs.cancelled),
    workspaceId: payload.meta?.custom_data?.workspace_id ?? null,
    priceId: variantId,
  };
}
