import { closeQueues } from './queues/index.js';
import { startWorkers, stopWorkers } from './queues/runtime.js';
import { logger } from './lib/logger.js';

/**
 * Standalone worker process entrypoint.
 *
 * Run separately from the API so a slow model call or a long Retrigger backfill
 * can never hold up an HTTP request. On a host with no free tier for a second
 * process (see index.ts's RUN_EMBEDDED_WORKER), the same registration runs
 * embedded in the API instead — this file just owns the process lifecycle.
 */

const runtime = await startWorkers();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down workers');
  // Let in-flight jobs finish so a deploy never abandons a half-sent automation.
  await stopWorkers(runtime);
  await closeQueues().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
