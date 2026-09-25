import { prisma, type RetriggerRun } from '@leadwave/db';
import { PRIVATE_REPLY_WINDOW_DAYS, matchKeywords, automationDefinitionSchema } from '@leadwave/shared';
import { tryDecrypt } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { listPostComments } from '../../services/graph.js';
import { checkRetriggerBudget, retriggerGapMs } from '../../services/rate-limit.js';
import { enqueueComment, enqueueRetrigger, type RetriggerJob } from '../index.js';

/**
 * Retrigger: run a live automation over comments that already exist.
 *
 * Most people set up an automation *after* a post starts working, so the
 * comments they already earned never saw it. This walks the post's history and
 * feeds matching comments through the ordinary comment pipeline — which means
 * the dedupe ledger, the plan quota and the send budget all apply unchanged.
 *
 * Two honest boundaries, both Meta's rather than ours: a private reply is only
 * allowed while a comment is under 7 days old, and only one per comment, ever.
 */

export async function processRetrigger(job: RetriggerJob): Promise<void> {
  const run = await prisma.retriggerRun.findUnique({
    where: { id: job.retriggerRunId },
    include: {
      automation: true,
      connectedAccount: true,
    },
  });
  if (!run) return;

  if (run.status === 'paused' || run.status === 'completed' || run.status === 'failed') return;

  if (job.action === 'scan') {
    await scan(run);
    return;
  }

  await dispatchBatch(run);
}

// ─── Scan ────────────────────────────────────────────────────────────────────

/**
 * Counts what a run *would* do without sending anything, so the confirmation
 * screen can tell the truth before the user commits.
 */
async function scan(
  run: RetriggerRun & {
    automation: { id: string; definition: unknown };
    connectedAccount: { id: string; accessTokenCipher: string };
  },
): Promise<void> {
  const parsed = automationDefinitionSchema.safeParse(run.automation.definition);
  if (!parsed.success || parsed.data.trigger.type !== 'comment') {
    await fail(run.id, 'This automation does not run on comments.');
    return;
  }

  const token = tryDecrypt(run.connectedAccount.accessTokenCipher);
  if (!token) {
    await fail(run.id, 'Reconnect this Facebook Page.');
    return;
  }

  const keywords = parsed.data.trigger.keywords;
  const cutoff = Date.now() - PRIVATE_REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  let scanned = 0;
  let matched = 0;
  const skips = { tooOld: 0, alreadyReplied: 0, noKeyword: 0, ownComment: 0 };
  let cursor: string | null = run.cursor;

  do {
    const page = await listPostComments(run.postId, token, { after: cursor ?? undefined });

    for (const comment of page.comments) {
      scanned += 1;

      if (comment.from?.id === run.connectedAccount.id) {
        skips.ownComment += 1;
        continue;
      }

      if (new Date(comment.created_time).getTime() < cutoff) {
        skips.tooOld += 1;
        continue;
      }

      if (!matchKeywords(keywords, comment.message ?? '').matched) {
        skips.noKeyword += 1;
        continue;
      }

      // Anyone this Page has already privately replied to is excluded before a
      // single message goes out.
      const already = await prisma.commentReply.findFirst({
        where: { commentId: comment.id },
        select: { id: true },
      });
      if (already) {
        skips.alreadyReplied += 1;
        continue;
      }

      matched += 1;
    }

    cursor = page.nextCursor;

    await prisma.retriggerRun.update({
      where: { id: run.id },
      data: {
        scannedCount: scanned,
        matchedCount: matched,
        skippedCount: skips.tooOld + skips.alreadyReplied + skips.noKeyword + skips.ownComment,
        skipBreakdown: skips,
        cursor,
      },
    });
  } while (cursor);

  await prisma.retriggerRun.update({
    where: { id: run.id },
    data: { status: 'ready', cursor: null },
  });
}

// ─── Send ────────────────────────────────────────────────────────────────────

/**
 * Works through the backlog one paced batch at a time. Each comment is queued
 * onto the ordinary comment queue at backfill priority, so live traffic always
 * jumps ahead of the catch-up.
 */
async function dispatchBatch(
  run: RetriggerRun & {
    automation: { id: string; definition: unknown };
    connectedAccount: { id: string; pageId: string; accessTokenCipher: string };
  },
): Promise<void> {
  const parsed = automationDefinitionSchema.safeParse(run.automation.definition);
  if (!parsed.success || parsed.data.trigger.type !== 'comment') {
    await fail(run.id, 'This automation does not run on comments.');
    return;
  }

  const token = tryDecrypt(run.connectedAccount.accessTokenCipher);
  if (!token) {
    await fail(run.id, 'Reconnect this Facebook Page.');
    return;
  }

  if (run.status !== 'running') {
    await prisma.retriggerRun.update({
      where: { id: run.id },
      data: { status: 'running', startedAt: run.startedAt ?? new Date() },
    });
  }

  const keywords = parsed.data.trigger.keywords;
  const cutoff = Date.now() - PRIVATE_REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const page = await listPostComments(run.postId, token, {
    after: run.cursor ?? undefined,
    limit: 50,
  });

  let sent = run.sentCount;
  let skipped = run.skippedCount;

  for (const comment of page.comments) {
    if (new Date(comment.created_time).getTime() < cutoff) {
      skipped += 1;
      continue;
    }
    if (!matchKeywords(keywords, comment.message ?? '').matched) {
      skipped += 1;
      continue;
    }

    const already = await prisma.commentReply.findFirst({
      where: { commentId: comment.id },
      select: { id: true },
    });
    if (already) {
      skipped += 1;
      continue;
    }

    // A backfill yields to the Page's live budget rather than competing with it.
    const budget = await checkRetriggerBudget(run.connectedAccount.pageId);
    if (!budget.allowed) {
      await prisma.retriggerRun.update({
        where: { id: run.id },
        data: { sentCount: sent, skippedCount: skipped },
      });
      await enqueueRetrigger(run.id, 'send', (budget.retryAfterSeconds ?? 60) * 1000);
      return;
    }

    await enqueueComment({
      connectedAccountId: run.connectedAccountId,
      commentId: comment.id,
      postId: run.postId,
      commenterId: comment.from?.id ?? null,
      commentText: comment.message ?? '',
      commentCreatedAt: comment.created_time,
      retriggerRunId: run.id,
    });

    sent += 1;
    await sleep(retriggerGapMs());
  }

  await prisma.retriggerRun.update({
    where: { id: run.id },
    data: { sentCount: sent, skippedCount: skipped, cursor: page.nextCursor },
  });

  if (page.nextCursor) {
    await enqueueRetrigger(run.id, 'send', 2_000);
    return;
  }

  await prisma.retriggerRun.update({
    where: { id: run.id },
    data: { status: 'completed', completedAt: new Date(), cursor: null },
  });

  logger.info({ retriggerRunId: run.id, sent, skipped }, 'retrigger run finished');
}

async function fail(id: string, error: string): Promise<void> {
  await prisma.retriggerRun.update({
    where: { id },
    data: { status: 'failed', error, completedAt: new Date() },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
