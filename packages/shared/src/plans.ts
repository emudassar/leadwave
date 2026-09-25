/**
 * Single source of truth for plan tiers, limits and feature gates.
 *
 * Both the API and the dashboard SPA import from this file. The API is the only
 * place that *enforces* a gate; the SPA uses the same table to decide what to
 * show as locked, so the two can never drift apart.
 */

export const PLANS = ['free', 'pro', 'growth', 'business'] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_RANK: Record<Plan, number> = {
  free: 0,
  pro: 1,
  growth: 2,
  business: 3,
};

/** Every gateable capability in the product. */
export const FEATURES = [
  // Triggers
  'trigger_comment',
  'trigger_story',
  'trigger_dm_keyword',
  'trigger_ice_breaker',
  'trigger_next_post', // "any post" / future posts inherit the automation
  // Actions
  'action_product_carousel',
  'action_follow_gate',
  'action_lead_capture_email',
  'action_lead_capture_phone',
  'action_follow_up',
  'multiple_button_links', // 3 links in one message
  // Tools
  'retrigger',
  'schedule_messages',
  'lifetime_analytics',
  'remove_branding',
  // Bio page
  'bio_page',
  'bio_link_scheduling',
  'bio_seo_controls',
  'bio_premium_themes',
  'bio_multiple_pages',
  // AI
  'ai_replies',
  'ai_comments',
  'ai_goals',
  'ai_knowledge',
  // Team & integrations
  'team_seats',
  'google_sheets',
  'meta_ads_export',
] as const;
export type Feature = (typeof FEATURES)[number];

/** `null` means unlimited. */
export interface PlanLimits {
  connectedPages: number | null;
  messagesPerMonth: number | null;
  contacts: number | null;
  leads: number | null;
  automations: number | null;
  iceBreakers: number;
  teamSeats: number;
  aiCreditsPerMonth: number;
  bioPages: number;
  /** How far back analytics can be queried, in days. `null` = lifetime. */
  analyticsRetentionDays: number | null;
}

export interface PlanDefinition {
  id: Plan;
  name: string;
  tagline: string;
  /** Monthly list price in USD. Regional prices come from the billing provider. */
  priceMonthlyUsd: number;
  /** Yearly list price in USD (2 months free). */
  priceYearlyUsd: number;
  limits: PlanLimits;
  features: readonly Feature[];
}

const PRO_FEATURES = [
  'trigger_comment',
  'trigger_story',
  'trigger_dm_keyword',
  'trigger_ice_breaker',
  'trigger_next_post',
  'action_product_carousel',
  'action_follow_gate',
  'action_lead_capture_email',
  'action_lead_capture_phone',
  'action_follow_up',
  'multiple_button_links',
  'retrigger',
  'schedule_messages',
  'lifetime_analytics',
  'remove_branding',
  'bio_page',
  'bio_link_scheduling',
  'bio_seo_controls',
  'bio_premium_themes',
] as const satisfies readonly Feature[];

const GROWTH_FEATURES = [
  ...PRO_FEATURES,
  'ai_replies',
  'ai_comments',
  'ai_goals',
  'ai_knowledge',
] as const satisfies readonly Feature[];

const BUSINESS_FEATURES = [
  ...GROWTH_FEATURES,
  'team_seats',
  'google_sheets',
  'meta_ads_export',
  'bio_multiple_pages',
] as const satisfies readonly Feature[];

export const PLAN_DEFINITIONS: Record<Plan, PlanDefinition> = {
  free: {
    id: 'free',
    name: 'Free',
    tagline: 'Explore the core automations for free',
    priceMonthlyUsd: 0,
    priceYearlyUsd: 0,
    limits: {
      connectedPages: 1,
      messagesPerMonth: 1_000,
      contacts: 100,
      leads: 10,
      automations: 3,
      iceBreakers: 2,
      teamSeats: 1,
      aiCreditsPerMonth: 0,
      bioPages: 1,
      analyticsRetentionDays: 30,
    },
    features: [
      'trigger_comment',
      'trigger_story',
      'trigger_dm_keyword',
      'trigger_ice_breaker',
      'action_lead_capture_email',
      'bio_page',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: 'For scaling creators and growing brands',
    priceMonthlyUsd: 9,
    priceYearlyUsd: 90,
    limits: {
      connectedPages: 3,
      messagesPerMonth: null,
      contacts: null,
      leads: null,
      automations: null,
      iceBreakers: 4,
      teamSeats: 1,
      aiCreditsPerMonth: 0,
      bioPages: 1,
      analyticsRetentionDays: null,
    },
    features: PRO_FEATURES,
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    tagline: 'AI that answers your messages & comments for you',
    priceMonthlyUsd: 14,
    priceYearlyUsd: 140,
    limits: {
      connectedPages: 3,
      messagesPerMonth: null,
      contacts: null,
      leads: null,
      automations: null,
      iceBreakers: 4,
      teamSeats: 1,
      aiCreditsPerMonth: 1_000,
      bioPages: 1,
      analyticsRetentionDays: null,
    },
    features: GROWTH_FEATURES,
  },
  business: {
    id: 'business',
    name: 'Business',
    tagline: 'For agencies and small teams',
    priceMonthlyUsd: 29,
    priceYearlyUsd: 290,
    limits: {
      connectedPages: 10,
      messagesPerMonth: null,
      contacts: null,
      leads: null,
      automations: null,
      iceBreakers: 4,
      teamSeats: 5,
      aiCreditsPerMonth: 2_500,
      bioPages: 5,
      analyticsRetentionDays: null,
    },
    features: BUSINESS_FEATURES,
  },
};

export function planDefinition(plan: Plan): PlanDefinition {
  return PLAN_DEFINITIONS[plan];
}

export function limitsFor(plan: Plan): PlanLimits {
  return PLAN_DEFINITIONS[plan].limits;
}

export function hasFeature(plan: Plan, feature: Feature): boolean {
  return PLAN_DEFINITIONS[plan].features.includes(feature);
}

/** The cheapest plan that unlocks `feature`, or `null` if no plan has it. */
export function minimumPlanFor(feature: Feature): Plan | null {
  for (const plan of PLANS) {
    if (hasFeature(plan, feature)) return plan;
  }
  return null;
}

/**
 * `used` is the count *before* the action being attempted.
 * Returns true when one more unit still fits inside the plan.
 */
export function withinLimit(limit: number | null, used: number): boolean {
  return limit === null || used < limit;
}

export function isAtLeast(plan: Plan, minimum: Plan): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[minimum];
}

export function hasAi(plan: Plan): boolean {
  return limitsFor(plan).aiCreditsPerMonth > 0;
}
