import { Queue, type JobsOptions } from 'bullmq';
import { QUEUE_PRIORITY } from '@leadwave/shared';
import { createRedis } from '../lib/redis.js';

/**
 * Queue definitions and the enqueue helpers the rest of the app calls.
 *
 * Workers live in ./workers and run in a separate process, so a slow AI call or
 * a long Retrigger backfill can never block an HTTP request. Priorities are
 * shared from @leadwave/shared: live traffic always jumps ahead of a backfill.
 */

const connection = createRedis('queues');

export const QUEUE_NAMES = {
  webhook: 'webhook-events',
  run: 'automation-runs',
  comment: 'comment-processor',
  followUp: 'follow-ups',
  scheduled: 'scheduled-messages',
  retrigger: 'retrigger-runner',
  ai: 'ai-pipeline',
  aiComment: 'ai-comment-reply',
  goals: 'goal-evaluator',
  sheets: 'sheets-append',
  knowledge: 'knowledge-rescan',
  maintenance: 'maintenance',
} as const;

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

function makeQueue(name: string): Queue {
  return new Queue(name, { connection, defaultJobOptions });
}

export const queues = {
  webhook: makeQueue(QUEUE_NAMES.webhook),
  run: makeQueue(QUEUE_NAMES.run),
  comment: makeQueue(QUEUE_NAMES.comment),
  followUp: makeQueue(QUEUE_NAMES.followUp),
  scheduled: makeQueue(QUEUE_NAMES.scheduled),
  retrigger: makeQueue(QUEUE_NAMES.retrigger),
  ai: makeQueue(QUEUE_NAMES.ai),
  aiComment: makeQueue(QUEUE_NAMES.aiComment),
  goals: makeQueue(QUEUE_NAMES.goals),
  sheets: makeQueue(QUEUE_NAMES.sheets),
  knowledge: makeQueue(QUEUE_NAMES.knowledge),
  maintenance: makeQueue(QUEUE_NAMES.maintenance),
};

// ─── Job payloads ────────────────────────────────────────────────────────────

export interface WebhookJob {
  webhookEventId: string;
}

export interface RunJob {
  runId: string;
  /** "start" | "resume" | "gate_timeout" */
  action: 'start' | 'resume' | 'gate_timeout';
}

export interface CommentJob {
  connectedAccountId: string;
  commentId: string;
  postId: string;
  commenterId: string | null;
  commentText: string;
  commentCreatedAt: string | null;
  /** Set when the comment came from a Retrigger backfill. */
  retriggerRunId?: string;
}

export interface FollowUpJobData {
  automationId: string;
  contactId: string;
  stepId: string;
}

export interface ScheduledMessageJob {
  messageId: string;
}

export interface RetriggerJob {
  retriggerRunId: string;
  action: 'scan' | 'send';
}

export interface AiPipelineJob {
  kind: 'message';
  connectedAccountId: string;
  conversationId: string;
  contactId: string;
  messageId: string;
}

export interface AiCommentJob {
  connectedAccountId: string;
  commentId: string;
  postId: string;
  commenterId: string | null;
  commentText: string;
}

export interface GoalEvaluationJob {
  aiEventId: string;
}

export interface SheetsAppendJob {
  leadId: string;
}

export interface KnowledgeRescanJob {
  knowledgeSourceId: string;
}

// ─── Enqueue helpers ─────────────────────────────────────────────────────────

export async function enqueueWebhook(webhookEventId: string): Promise<void> {
  await queues.webhook.add(
    'process',
    { webhookEventId } satisfies WebhookJob,
    { priority: QUEUE_PRIORITY.live },
  );
}

export async function enqueueRunStart(runId: string): Promise<void> {
  await queues.run.add(
    'start',
    { runId, action: 'start' } satisfies RunJob,
    { priority: QUEUE_PRIORITY.live, jobId: `run-start:${runId}` },
  );
}

export async function enqueueRunResume(runId: string, delayMs = 0): Promise<void> {
  await queues.run.add(
    'resume',
    { runId, action: 'resume' } satisfies RunJob,
    { delay: delayMs, priority: QUEUE_PRIORITY.live },
  );
}

export async function enqueueGateTimeout(runId: string, delayMs: number): Promise<void> {
  await queues.run.add(
    'gate_timeout',
    { runId, action: 'gate_timeout' } satisfies RunJob,
    { delay: delayMs, jobId: `gate:${runId}`, priority: QUEUE_PRIORITY.followUp },
  );
}

export async function enqueueComment(job: CommentJob): Promise<void> {
  await queues.comment.add('process', job, {
    // One job per comment, ever — Meta redelivers webhooks freely.
    jobId: `comment:${job.commentId}`,
    priority: job.retriggerRunId ? QUEUE_PRIORITY.retrigger : QUEUE_PRIORITY.live,
  });
}

export async function enqueueFollowUp(
  automationId: string,
  contactId: string,
  stepId: string,
  delayMs: number,
): Promise<void> {
  await queues.followUp.add(
    'send',
    { automationId, contactId, stepId } satisfies FollowUpJobData,
    {
      delay: delayMs,
      jobId: `followup:${automationId}:${contactId}:${stepId}`,
      priority: QUEUE_PRIORITY.followUp,
    },
  );
}

export async function cancelFollowUp(
  automationId: string,
  contactId: string,
  stepId: string,
): Promise<void> {
  const job = await queues.followUp.getJob(`followup:${automationId}:${contactId}:${stepId}`);
  await job?.remove().catch(() => {
    // Already running or gone; the send-time re-check covers it.
  });
}

export async function enqueueScheduledMessage(messageId: string, delayMs: number): Promise<void> {
  await queues.scheduled.add(
    'send',
    { messageId } satisfies ScheduledMessageJob,
    { delay: Math.max(0, delayMs), jobId: `scheduled:${messageId}`, priority: QUEUE_PRIORITY.scheduled },
  );
}

export async function cancelScheduledMessage(messageId: string): Promise<void> {
  const job = await queues.scheduled.getJob(`scheduled:${messageId}`);
  await job?.remove().catch(() => {});
}

export async function enqueueRetrigger(
  retriggerRunId: string,
  action: 'scan' | 'send',
  delayMs = 0,
): Promise<void> {
  await queues.retrigger.add(
    action,
    { retriggerRunId, action } satisfies RetriggerJob,
    { delay: delayMs, priority: QUEUE_PRIORITY.retrigger },
  );
}

export async function enqueueAiMessage(job: AiPipelineJob): Promise<void> {
  await queues.ai.add('message', job, {
    jobId: `ai-msg:${job.messageId}`,
    priority: QUEUE_PRIORITY.aiReply,
  });
}

export async function enqueueAiComment(job: AiCommentJob, delayMs: number): Promise<void> {
  await queues.aiComment.add('comment', job, {
    delay: delayMs,
    jobId: `ai-comment:${job.commentId}`,
    priority: QUEUE_PRIORITY.aiReply,
  });
}

export async function enqueueGoalEvaluation(aiEventId: string, delayMs: number): Promise<void> {
  await queues.goals.add(
    'evaluate',
    { aiEventId } satisfies GoalEvaluationJob,
    { delay: delayMs, jobId: `goal:${aiEventId}:${delayMs}` },
  );
}

export async function enqueueSheetsAppend(leadId: string): Promise<void> {
  await queues.sheets.add(
    'append',
    { leadId } satisfies SheetsAppendJob,
    { jobId: `sheets:${leadId}` },
  );
}

export async function enqueueKnowledgeRescan(knowledgeSourceId: string): Promise<void> {
  await queues.knowledge.add('rescan', { knowledgeSourceId } satisfies KnowledgeRescanJob);
}

/**
 * Repeatable housekeeping: reconcile stuck runs, expire gates whose delayed job
 * was lost, roll usage counters, and refresh Page tokens near expiry.
 */
export async function scheduleMaintenance(): Promise<void> {
  await queues.maintenance.add(
    'sweep',
    {},
    {
      repeat: { pattern: '*/10 * * * *' },
      jobId: 'maintenance-sweep',
    },
  );
}

export async function closeQueues(): Promise<void> {
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await connection.quit();
}
