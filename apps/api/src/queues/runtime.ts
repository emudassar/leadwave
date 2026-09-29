import { Worker, type Job } from 'bullmq';
import { createRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import {
  QUEUE_NAMES,
  scheduleMaintenance,
  type AiCommentJob,
  type AiPipelineJob,
  type CommentJob,
  type FollowUpJobData,
  type GoalEvaluationJob,
  type KnowledgeRescanJob,
  type RetriggerJob,
  type RunJob,
  type ScheduledMessageJob,
  type SheetsAppendJob,
  type WebhookJob,
} from './index.js';
import { processWebhookEvent } from './workers/webhook.worker.js';
import { processComment } from './workers/comment.worker.js';
import { processFollowUp, processScheduledMessage } from './workers/followup.worker.js';
import { processRetrigger } from './workers/retrigger.worker.js';
import { processAiComment, processAiMessage } from './workers/ai.worker.js';
import { evaluateGoal } from './workers/goals.worker.js';
import { runMaintenance } from './workers/maintenance.worker.js';
import { advanceRun, expireGate } from '../services/executor.js';
import { appendLead } from '../services/integrations/google-sheets.js';
import { rescanKnowledgeSource } from '../services/ai/rescan.js';

/**
 * Queue worker registration, factored out so it can run either as its own
 * process (`worker.ts`, the normal shape) or embedded inside the API process
 * (`index.ts`, when RUN_EMBEDDED_WORKER=true) for hosts whose free tier has
 * no separate background-worker service.
 */

/**
 * How often an idle worker touches Redis. BullMQ's defaults (a 5s long-poll and
 * a 30s stalled-job check) cost ~12 queues × tens of thousands of commands a
 * day with zero traffic, which burned through a free Redis tier in three days.
 *
 * Neither delays real work: a new job wakes the blocked worker immediately via
 * its marker key, and a queue holding delayed jobs caps its own block at 10s
 * regardless of `drainDelay`. A stalled job (worker crashed mid-job) is picked
 * up within 5 minutes instead of 30s; the maintenance sweep covers the rest.
 */
const IDLE_OPTIONS = {
  drainDelay: 300,
  stalledInterval: 300_000,
} as const;

export interface WorkerRuntime {
  workers: Worker[];
}

export async function startWorkers(): Promise<WorkerRuntime> {
  const connection = createRedis('workers');
  const workers: Worker[] = [];

  function register<T>(
    name: string,
    concurrency: number,
    handler: (data: T, job: Job<T>) => Promise<void>,
  ): void {
    const worker = new Worker<T>(
      name,
      async (job) => {
        await handler(job.data, job);
      },
      { connection, concurrency, ...IDLE_OPTIONS },
    );

    worker.on('failed', (job, err) => {
      logger.error(
        { queue: name, jobId: job?.id, attempt: job?.attemptsMade, err: err.message },
        'job failed',
      );
    });

    worker.on('error', (err) => {
      logger.error({ queue: name, err }, 'worker error');
    });

    workers.push(worker);
  }

  register<WebhookJob>(QUEUE_NAMES.webhook, 10, processWebhookEvent);

  register<RunJob>(QUEUE_NAMES.run, 8, async (data) => {
    if (data.action === 'gate_timeout') return expireGate(data.runId);
    return advanceRun(data.runId);
  });

  register<CommentJob>(QUEUE_NAMES.comment, 4, processComment);
  register<FollowUpJobData>(QUEUE_NAMES.followUp, 5, processFollowUp);
  register<ScheduledMessageJob>(QUEUE_NAMES.scheduled, 5, processScheduledMessage);

  // Serial on purpose: a backfill that raced would defeat its own pacing.
  register<RetriggerJob>(QUEUE_NAMES.retrigger, 1, processRetrigger);

  register<AiPipelineJob>(QUEUE_NAMES.ai, 3, processAiMessage);
  register<AiCommentJob>(QUEUE_NAMES.aiComment, 2, processAiComment);
  register<GoalEvaluationJob>(QUEUE_NAMES.goals, 5, evaluateGoal);

  register<SheetsAppendJob>(QUEUE_NAMES.sheets, 3, async (data) => {
    await appendLead(data.leadId);
  });

  register<KnowledgeRescanJob>(QUEUE_NAMES.knowledge, 2, async (data) => {
    await rescanKnowledgeSource(data.knowledgeSourceId);
  });

  register(QUEUE_NAMES.maintenance, 1, async () => {
    await runMaintenance();
  });

  await scheduleMaintenance().catch((err: unknown) => {
    logger.error({ err }, 'could not schedule the maintenance sweep');
  });

  logger.info({ queues: workers.length }, 'leadwave workers running');

  return { workers };
}

export async function stopWorkers(runtime: WorkerRuntime): Promise<void> {
  await Promise.allSettled(runtime.workers.map((w) => w.close()));
}
