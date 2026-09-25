/**
 * Messenger Platform rules that every send path in LeadWave has to respect.
 *
 * These are Meta's constraints, not ours. Encoding them here means the runtime,
 * the scheduler and the AI layer all make the same call about whether a message
 * is allowed to go out — and an AI reply is never sent when a normal one
 * couldn't be.
 */

export const MESSAGING_WINDOW_HOURS = 24;

/**
 * Message tags extend the standard window for specific, narrow purposes.
 * `HUMAN_AGENT` is the one this product uses: it allows a human (or a tool
 * acting for one) to answer up to 7 days after the last inbound message.
 */
export const MESSAGE_TAGS = [
  'HUMAN_AGENT',
  'CONFIRMED_EVENT_UPDATE',
  'POST_PURCHASE_UPDATE',
  'ACCOUNT_UPDATE',
] as const;
export type MessageTag = (typeof MESSAGE_TAGS)[number];

export const HUMAN_AGENT_WINDOW_DAYS = 7;

export const MESSAGING_TYPES = ['RESPONSE', 'UPDATE', 'MESSAGE_TAG'] as const;
export type MessagingType = (typeof MESSAGING_TYPES)[number];

/** How far out a message may be scheduled. Matches the human-agent ceiling. */
export const MAX_SCHEDULE_DAYS = 7;

/** The follow-up nudge ceiling — always lands inside the 24h window. */
export const MAX_FOLLOW_UP_MINUTES = 20 * 60;
export const MIN_FOLLOW_UP_MINUTES = 30;

/**
 * A private reply to a comment is allowed only while the comment is recent.
 * This is why Retrigger reaches back a week and no further.
 */
export const PRIVATE_REPLY_WINDOW_DAYS = 7;

/** One private reply per comment, ever — enforced by Meta and by us. */
export const MAX_PRIVATE_REPLIES_PER_COMMENT = 1;

// ─── Window arithmetic ───────────────────────────────────────────────────────

export interface WindowState {
  /** When the contact last messaged the Page. */
  lastInboundAt: Date | null;
}

export function windowExpiresAt(lastInboundAt: Date | null): Date | null {
  if (!lastInboundAt) return null;
  return new Date(lastInboundAt.getTime() + MESSAGING_WINDOW_HOURS * 60 * 60 * 1000);
}

export function isWithinStandardWindow(state: WindowState, now = new Date()): boolean {
  const expiry = windowExpiresAt(state.lastInboundAt);
  return expiry !== null && now < expiry;
}

export function isWithinHumanAgentWindow(state: WindowState, now = new Date()): boolean {
  if (!state.lastInboundAt) return false;
  const expiry = new Date(
    state.lastInboundAt.getTime() + HUMAN_AGENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  return now < expiry;
}

export type SendEligibility =
  | { allowed: true; messagingType: MessagingType; tag?: MessageTag }
  | { allowed: false; reason: 'window_closed' };

/**
 * Decides how — or whether — a message may be sent right now.
 *
 * Automated sends only ever use the standard 24h window. A human typing in the
 * Inbox, or a message they scheduled themselves, may use the HUMAN_AGENT tag,
 * which is exactly what that tag is for.
 */
export function resolveSendEligibility(
  state: WindowState,
  options: { humanInitiated?: boolean } = {},
  now = new Date(),
): SendEligibility {
  if (isWithinStandardWindow(state, now)) {
    return { allowed: true, messagingType: 'RESPONSE' };
  }
  if (options.humanInitiated && isWithinHumanAgentWindow(state, now)) {
    return { allowed: true, messagingType: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' };
  }
  return { allowed: false, reason: 'window_closed' };
}

// ─── Pacing ──────────────────────────────────────────────────────────────────

/**
 * The shared hourly send budget. Every outbound action on a Page draws from the
 * same bucket — automations, retrigger backfills, AI replies and public comment
 * replies alike — so a viral post can't burn through the Page's rate limits.
 */
export const SEND_BUDGET = {
  perPagePerHour: 600,
  perPagePerMinute: 30,
  /** Retrigger is a backfill, so it gets a smaller slice and always yields. */
  retriggerPerHour: 120,
  retriggerPerDay: 800,
  /** Minimum gap between two retrigger sends, in milliseconds. */
  retriggerMinGapMs: 4_000,
  retriggerMaxGapMs: 12_000,
} as const;

/** Live traffic always preempts a backfill. */
export const QUEUE_PRIORITY = {
  live: 1,
  aiReply: 5,
  followUp: 10,
  scheduled: 10,
  retrigger: 50,
} as const;

// ─── Graph API error taxonomy ────────────────────────────────────────────────

/**
 * The Graph errors worth reacting to rather than blindly retrying. Everything
 * else falls through to the generic backoff.
 */
export const GRAPH_ERRORS = {
  /** Outside the messaging window. Stop; do not retry. */
  OUTSIDE_WINDOW: 10,
  /** Rate limited. Back off and retry later. */
  RATE_LIMIT: 613,
  APP_RATE_LIMIT: 4,
  PAGE_RATE_LIMIT: 32,
  /** Token expired or revoked. Mark the Page as needing reconnection. */
  INVALID_TOKEN: 190,
  /** The person is no longer reachable — blocked, deleted, or opted out. */
  UNAVAILABLE_USER: 551,
  /** Already replied privately to this comment. Treat as success. */
  DUPLICATE_PRIVATE_REPLY: 10903,
  /** The object (comment/post) is gone. Stop. */
  OBJECT_NOT_FOUND: 100,
} as const;

export type GraphErrorDisposition = 'retry' | 'stop' | 'reconnect' | 'succeed';

export function dispositionForGraphError(code: number, subcode?: number): GraphErrorDisposition {
  switch (code) {
    case GRAPH_ERRORS.RATE_LIMIT:
    case GRAPH_ERRORS.APP_RATE_LIMIT:
    case GRAPH_ERRORS.PAGE_RATE_LIMIT:
      return 'retry';
    case GRAPH_ERRORS.INVALID_TOKEN:
      return 'reconnect';
    case GRAPH_ERRORS.UNAVAILABLE_USER:
    case GRAPH_ERRORS.OUTSIDE_WINDOW:
    case GRAPH_ERRORS.OBJECT_NOT_FOUND:
      return 'stop';
    default:
      if (subcode === GRAPH_ERRORS.DUPLICATE_PRIVATE_REPLY) return 'succeed';
      return 'retry';
  }
}
