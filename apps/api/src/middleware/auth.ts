import type { NextFunction, Request, Response } from 'express';
import { prisma, type User } from '@leadwave/db';
import { env, isProduction } from '../env.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';

/**
 * Sessions are opaque random tokens stored in an httpOnly cookie. Only the
 * SHA-256 of the token is written to the database, so a database read cannot be
 * replayed as a login.
 */

export const SESSION_COOKIE = 'lw_session';
const SESSION_TTL_DAYS = 30;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      sessionId?: string;
    }
  }
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string; ip?: string },
): Promise<string> {
  const token = randomToken();
  await prisma.session.create({
    data: {
      id: sha256(token),
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
      ip: meta.ip ?? null,
    },
  });
  return token;
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    // The SPA and API can sit on different subdomains in production.
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
  });
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id: sha256(token) } });
}

/**
 * Attaches `req.user` when a valid session cookie is present. Never rejects —
 * routes that require a user use `requireAuth` on top of this.
 */
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!token) return next();

    const session = await prisma.session.findUnique({
      where: { id: sha256(token) },
      include: { user: true },
    });

    if (!session || session.expiresAt < new Date()) {
      if (session) await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
      return next();
    }

    req.user = session.user;
    req.sessionId = session.id;

    // Cheap liveness signal; only written once an hour per user.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (!session.user.lastSeenAt || session.user.lastSeenAt < hourAgo) {
      void prisma.user
        .update({ where: { id: session.user.id }, data: { lastSeenAt: new Date() } })
        .catch(() => {});
    }

    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  if (!req.user.isAdmin) return next(unauthorized('Not available.'));
  next();
}

export { env };
