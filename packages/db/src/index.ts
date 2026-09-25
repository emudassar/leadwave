import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

/**
 * A single client per process. Vite/tsx reload the module graph on every edit,
 * so in development we stash the instance on globalThis to avoid exhausting the
 * connection pool with a new client per reload.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['warn', 'error']
        : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
