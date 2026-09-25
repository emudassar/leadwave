import type { Plan } from '@leadwave/shared';

/**
 * The billing seam.
 *
 * LeadWave sells from Pakistan, where Stripe is not available, so it uses a
 * merchant of record. Paddle is the default because its Payoneer payouts
 * actually work there; Lemon Squeezy is a drop-in alternative. Everything above
 * this interface — plan gating, quotas, the upgrade flow — is written against
 * these four methods and knows nothing about either vendor.
 */

export type BillingInterval = 'month' | 'year';

export interface CheckoutRequest {
  workspaceId: string;
  plan: Exclude<Plan, 'free'>;
  interval: BillingInterval;
  email: string;
  /** Where to send them once payment succeeds. */
  successUrl: string;
}

export interface CheckoutSession {
  /** A hosted checkout URL, or null when the provider opens an inline overlay. */
  url: string | null;
  /** Price id for the overlay path. */
  priceId?: string;
  provider: string;
}

export interface PortalSession {
  url: string;
}

/**
 * The normalised shape every provider webhook collapses to. Adding a provider
 * means translating its events into this, and nothing else changes.
 */
export interface SubscriptionEvent {
  type: 'activated' | 'updated' | 'canceled' | 'payment_failed';
  providerCustomerId: string;
  providerSubscriptionId: string;
  /** Resolved from the price id the provider sent. */
  plan: Plan;
  interval: BillingInterval;
  status: 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled';
  currency: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** How we find the workspace: passed through checkout as custom data. */
  workspaceId: string | null;
  priceId: string | null;
}

export interface BillingProviderAdapter {
  readonly name: 'paddle' | 'lemonsqueezy' | 'manual';
  readonly isConfigured: boolean;

  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;

  /** Where the customer manages or cancels their own subscription. */
  createPortalSession(providerCustomerId: string): Promise<PortalSession>;

  /**
   * Verifies the signature over the raw body and returns the normalised event,
   * or null for events this product does not care about.
   *
   * Verification happens against the raw bytes: re-serialising parsed JSON
   * changes them and would break every signature.
   */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): SubscriptionEvent | null;
}

export class BillingNotConfiguredError extends Error {
  constructor(provider: string) {
    super(
      `Billing is not configured. Set the ${provider.toUpperCase()} credentials in your environment.`,
    );
    this.name = 'BillingNotConfiguredError';
  }
}
