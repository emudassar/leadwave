import { Redis } from 'ioredis';
import { env } from '../env.js';
import { logger } from './logger.js';

/**
 * BullMQ needs `maxRetriesPerRequest: null` on the connections it owns, so we
 * hand out a factory rather than sharing one client everywhere.
 */
export function createRedis(role: string): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });

  client.on('error', (err) => {
    logger.error({ err, role }, 'redis connection error');
  });

  return client;
}

/** General-purpose client for rate limits, locks and caches. */
export const redis = createRedis('app');
