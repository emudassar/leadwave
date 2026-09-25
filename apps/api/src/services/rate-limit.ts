import { SEND_BUDGET } from '@leadwave/shared';
import { redis } from '../lib/redis.js';

/**
 * The shared send budget.
 *
 * Every outbound action on a Page draws from the same buckets — automations,
 * Retrigger backfills, AI replies and public comment replies alike. That is
 * what stops a viral post from burning through a Page's rate limits: the AI
 * cannot spend budget that an automation is already using.
 *
 * Implemented as fixed windows in Redis. Approximate at the boundaries, which
 * is fine — the point is to stay well under Meta's ceiling, not to meter to
 * the exact message.
 */

interface BucketSpec {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface BudgetDecision {
  allowed: boolean;
  /** Which bucket said no. */
  blockedBy?: string;
  /** Seconds until that bucket has room again. */
  retryAfterSeconds?: number;
}

/**
 * Atomically increments every bucket, then rolls all of them back if any one
 * is over its limit — so a rejected send never silently consumes budget.
 */
async function consume(buckets: BucketSpec[]): Promise<BudgetDecision> {
  const pipeline = redis.pipeline();
  for (const bucket of buckets) {
    pipeline.incr(bucket.key);
    pipeline.expire(bucket.key, bucket.windowSeconds, 'NX');
  }
  const results = await pipeline.exec();
  if (!results) return { allowed: true };

  for (let i = 0; i < buckets.length; i += 1) {
    const bucket = buckets[i]!;
    const countResult = results[i * 2];
    const count = Number(countResult?.[1] ?? 0);

    if (count > bucket.limit) {
      const rollback = redis.pipeline();
      for (const b of buckets) rollback.decr(b.key);
      await rollback.exec();

      const ttl = await redis.ttl(bucket.key);
      return {
        allowed: false,
        blockedBy: bucket.key,
        retryAfterSeconds: ttl > 0 ? ttl : bucket.windowSeconds,
      };
    }
  }

  return { allowed: true };
}

function minuteWindow(): string {
  return String(Math.floor(Date.now() / 60_000));
}

function hourWindow(): string {
  return String(Math.floor(Date.now() / 3_600_000));
}

function dayWindow(): string {
  return String(Math.floor(Date.now() / 86_400_000));
}

/** The budget every ordinary send draws from. */
export function checkSendBudget(pageId: string): Promise<BudgetDecision> {
  return consume([
    {
      key: `budget:page:${pageId}:min:${minuteWindow()}`,
      limit: SEND_BUDGET.perPagePerMinute,
      windowSeconds: 120,
    },
    {
      key: `budget:page:${pageId}:hour:${hourWindow()}`,
      limit: SEND_BUDGET.perPagePerHour,
      windowSeconds: 3_900,
    },
  ]);
}

/**
 * Retrigger is a backfill, so it draws from the shared budget *and* from its
 * own smaller allowance. Live traffic is never starved by a catch-up run.
 */
export function checkRetriggerBudget(pageId: string): Promise<BudgetDecision> {
  return consume([
    {
      key: `budget:page:${pageId}:min:${minuteWindow()}`,
      limit: SEND_BUDGET.perPagePerMinute,
      windowSeconds: 120,
    },
    {
      key: `budget:page:${pageId}:hour:${hourWindow()}`,
      limit: SEND_BUDGET.perPagePerHour,
      windowSeconds: 3_900,
    },
    {
      key: `budget:retrigger:${pageId}:hour:${hourWindow()}`,
      limit: SEND_BUDGET.retriggerPerHour,
      windowSeconds: 3_900,
    },
    {
      key: `budget:retrigger:${pageId}:day:${dayWindow()}`,
      limit: SEND_BUDGET.retriggerPerDay,
      windowSeconds: 90_000,
    },
  ]);
}

/**
 * Public comment replies share the Page budget too — this is what keeps the AI
 * from posting 200 replies to a post with 200 comments in the same minute.
 */
export function checkCommentReplyBudget(pageId: string): Promise<BudgetDecision> {
  return checkSendBudget(pageId);
}

/** How long a Retrigger worker waits between sends, so a backfill paces itself. */
export function retriggerGapMs(): number {
  const { retriggerMinGapMs: min, retriggerMaxGapMs: max } = SEND_BUDGET;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Distributed locks ───────────────────────────────────────────────────────

/**
 * A short-lived lock, used to make "exactly one reply per comment" and "one run
 * per contact per automation" hold even when two workers race on the same
 * webhook redelivery.
 */
export async function withLock<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const token = Math.random().toString(36).slice(2);
  const acquired = await redis.set(`lock:${key}`, token, 'EX', ttlSeconds, 'NX');
  if (!acquired) return null;

  try {
    return await fn();
  } finally {
    // Only release the lock if it is still ours.
    const current = await redis.get(`lock:${key}`);
    if (current === token) await redis.del(`lock:${key}`);
  }
}

/** Generic fixed-window limiter for public endpoints (short links, bio pages). */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const bucket = `rl:${key}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
  const count = await redis.incr(bucket);
  if (count === 1) await redis.expire(bucket, windowSeconds);
  return count <= limit;
}
