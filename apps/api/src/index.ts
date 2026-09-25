import { createApp } from './app.js';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { closeQueues } from './queues/index.js';
import { startWorkers, stopWorkers, type WorkerRuntime } from './queues/runtime.js';

const app = createApp();

const server = app.listen(env.API_PORT, () => {
  logger.info(
    { port: env.API_PORT, url: env.API_URL, env: env.NODE_ENV },
    'leadwave api listening',
  );
});

/**
 * On a host with no free tier for a separate background-worker process, the
 * same queue workers run inside the API process instead of `worker.ts`'s own.
 */
let workerRuntime: WorkerRuntime | undefined;
if (env.RUN_EMBEDDED_WORKER) {
  workerRuntime = await startWorkers();
}

/** Finish in-flight requests before exiting, so a deploy never cuts one short. */
function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  if (workerRuntime) {
    void stopWorkers(workerRuntime).then(() => closeQueues().catch(() => {}));
  }
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
