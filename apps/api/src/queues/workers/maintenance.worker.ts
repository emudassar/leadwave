import { prisma } from '@leadwave/db';
import { AI_LIMITS, MESSAGING_WINDOW_HOURS } from '@leadwave/shared';
import { logger } from '../../lib/logger.js';
import { expireGate } from '../../services/executor.js';
import { snapshotDailyMetrics } from '../../services/analytics.js';
import { enqueueRunResume } from '../index.js';

/**
 * The ten-minute sweep.
 *
 * Delayed jobs can be lost — Redis is flushed, a deploy drops a worker
 * mid-flight, a job is evicted. Nothing in the product should depend on a
 * single timer surviving, so this reconciles state from the database instead:
 * anything that has been waiting longer than it should is finished here.
 */
export async function runMaintenance(): Promise<void> {
  await Promise.allSettled([
    expireStaleGates(),
    resumeStalledRuns(),
    releaseHeldMessages(),
    closeExpiredWindows(),
    pruneWebhookEvents(),
    flagExpiringTokens(),
    snapshotDailyMetrics().catch((err: unknown) => {
      logger.warn({ err }, 'could not snapshot daily metrics');
    }),
  ]);
}

/** Follow Gates whose timeout job never fired. */
async function expireStaleGates(): Promise<void> {
  const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000);

  const stale = await prisma.automationRun.findMany({
    where: { status: 'waiting', waitingFor: 'follow_gate', waitingSince: { lt: cutoff } },
    select: { id: true },
    take: 200,
  });

  for (const run of stale) {
    await expireGate(run.id).catch((err: unknown) => {
      logger.warn({ err, runId: run.id }, 'could not expire stale gate');
    });
  }
}

/**
 * Runs parked on a transient send failure, and lead-capture prompts nobody ever
 * answered. Both are abandoned rather than left waiting forever.
 */
async function resumeStalledRuns(): Promise<void> {
  const retryable = await prisma.automationRun.findMany({
    where: {
      status: 'waiting',
      waitingFor: 'send_retry',
      waitingSince: { lt: new Date(Date.now() - 5 * 60 * 1000) },
    },
    select: { id: true, retryCount: true },
    take: 100,
  });

  for (const run of retryable) {
    if (run.retryCount >= 5) {
      await prisma.automationRun.update({
        where: { id: run.id },
        data: { status: 'abandoned', error: 'Gave up after repeated send failures', completedAt: new Date() },
      });
      continue;
    }
    await prisma.automationRun.update({
      where: { id: run.id },
      data: { status: 'running', waitingFor: null, retryCount: { increment: 1 } },
    });
    await enqueueRunResume(run.id);
  }

  // A lead-capture prompt that went unanswered past the messaging window can
  // never be answered, so the run is closed out.
  await prisma.automationRun.updateMany({
    where: {
      status: 'waiting',
      waitingFor: { in: ['ask_email', 'ask_phone'] },
      waitingSince: { lt: new Date(Date.now() - MESSAGING_WINDOW_HOURS * 60 * 60 * 1000) },
    },
    data: { status: 'abandoned', error: 'No reply before the messaging window closed', completedAt: new Date() },
  });
}

/** Messages held on a transient budget block get one more chance. */
async function releaseHeldMessages(): Promise<void> {
  const held = await prisma.message.findMany({
    where: {
      status: 'held',
      failureReason: { contains: 'paced' },
      createdAt: { gt: new Date(Date.now() - 6 * 60 * 60 * 1000) },
    },
    select: { id: true },
    take: 100,
  });

  if (held.length === 0) return;

  const { enqueueScheduledMessage } = await import('../index.js');
  for (const message of held) {
    await prisma.message.update({ where: { id: message.id }, data: { status: 'scheduled' } });
    await enqueueScheduledMessage(message.id, 0);
  }
}

/**
 * Scheduled messages whose window closed before their send time. They are held
 * rather than sent, which is the behaviour that keeps the Page compliant.
 */
async function closeExpiredWindows(): Promise<void> {
  const cutoff = new Date(Date.now() - MESSAGING_WINDOW_HOURS * 60 * 60 * 1000);

  await prisma.message.updateMany({
    where: {
      status: 'scheduled',
      scheduledFor: { lt: new Date(Date.now() - 60 * 60 * 1000) },
      conversation: { contact: { lastInboundAt: { lt: cutoff } } },
    },
    data: {
      status: 'held',
      failureReason: 'The 24-hour messaging window closed before this was due.',
    },
  });
}

/** Processed webhook events are only useful for a short debugging window. */
async function pruneWebhookEvents(): Promise<void> {
  await prisma.webhookEvent.deleteMany({
    where: {
      processedAt: { not: null, lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
  });

  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

/**
 * Page tokens derived from a long-lived user token do not usually expire, but
 * when one carries an expiry we surface it before automations start failing.
 */
async function flagExpiringTokens(): Promise<void> {
  const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

  const expiring = await prisma.connectedAccount.updateMany({
    where: { status: 'active', tokenExpiresAt: { not: null, lt: soon } },
    data: {
      status: 'needs_reconnect',
      statusDetail: 'Facebook access is about to expire. Reconnect this Page to keep it running.',
    },
  });

  if (expiring.count > 0) {
    logger.info({ count: expiring.count }, 'flagged Pages with expiring tokens');
  }
}

export { AI_LIMITS };
