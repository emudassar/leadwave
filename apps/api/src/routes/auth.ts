import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@leadwave/db';
import { env, configured, isDevelopment } from '../env.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { handler, ok, parseBody, parseQuery } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
  destroySession,
  setSessionCookie,
} from '../middleware/auth.js';
import { ensureWorkspaceFor } from '../services/workspace-setup.js';

/**
 * Sign-in is Google-only, matching the product's "Continue with Google" entry
 * point. The OAuth `state` is a one-time token held in Redis, which both proves
 * the callback belongs to a flow we started (CSRF) and carries the post-login
 * redirect without trusting the query string.
 */

export const authRouter: Router = Router();

const STATE_TTL_SECONDS = 600;
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const redirectUri = () => `${env.API_URL}/api/v1/auth/google/callback`;
const stateKey = (state: string) => `oauth:google:${sha256(state)}`;

authRouter.get(
  '/me',
  handler(async (req, res) => {
    if (!req.user) throw unauthorized();

    const membership = await prisma.workspaceMember.findFirst({
      where: { userId: req.user.id },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });

    ok(res, {
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        avatarUrl: req.user.avatarUrl,
        isAdmin: req.user.isAdmin,
      },
      workspace: membership
        ? {
            id: membership.workspace.id,
            name: membership.workspace.name,
            plan: membership.workspace.plan,
            timezone: membership.workspace.timezone,
            role: membership.role,
            onboardedAt: membership.workspace.onboardedAt,
          }
        : null,
    });
  }),
);

/** Kicks off the Google flow. */
authRouter.get(
  '/google',
  handler(async (req, res) => {
    if (!configured.googleAuth) {
      throw badRequest(
        'Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      );
    }

    const { next } = parseQuery(req, z.object({ next: z.string().optional() }));
    const state = randomToken(24);

    await redis.setex(
      stateKey(state),
      STATE_TTL_SECONDS,
      JSON.stringify({ next: safeNext(next) }),
    );

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');

    res.redirect(url.toString());
  }),
);

authRouter.get(
  '/google/callback',
  handler(async (req, res) => {
    const query = parseQuery(
      req,
      z.object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      }),
    );

    if (query.error || !query.code || !query.state) {
      return res.redirect(`${env.APP_URL}/login?error=${encodeURIComponent(query.error ?? 'cancelled')}`);
    }

    // Single-use: consume the state before doing anything with the code.
    const raw = await redis.getdel(stateKey(query.state));
    if (!raw) {
      return res.redirect(`${env.APP_URL}/login?error=expired`);
    }
    const { next } = JSON.parse(raw) as { next: string };

    const profile = await exchangeCodeForProfile(query.code);
    if (!profile.email) {
      return res.redirect(`${env.APP_URL}/login?error=no_email`);
    }

    const user = await upsertUser(profile);
    await ensureWorkspaceFor(user);

    const token = await createSession(user.id, {
      userAgent: req.get('user-agent') ?? undefined,
      ip: req.ip,
    });
    setSessionCookie(res, token);

    logger.info({ userId: user.id }, 'signed in with google');
    res.redirect(`${env.APP_URL}${next}`);
  }),
);

/**
 * Development-only sign-in.
 *
 * Google OAuth needs a real client id and a callback that a browser can reach,
 * which is more ceremony than a developer wants before they can look at a
 * screen. This signs in the seeded account instead. It is compiled into the
 * same file on purpose: one `isDevelopment` guard, in plain sight, rather than
 * a parallel auth path nobody remembers to check.
 */
authRouter.post(
  '/dev-login',
  handler(async (req, res) => {
    if (!isDevelopment) throw unauthorized();

    const { email } = parseBody(
      req,
      z.object({ email: z.string().email().optional() }),
    );

    // Without an email, prefer a workspace admin — signing in as a seeded
    // viewer and then wondering why every button is disabled is a bad hour.
    const user = email
      ? await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
      : ((
          await prisma.workspaceMember.findFirst({
            where: { role: 'admin' },
            include: { user: true },
            orderBy: { createdAt: 'asc' },
          })
        )?.user ?? (await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } })));

    if (!user) {
      throw badRequest('No user to sign in as. Run `pnpm db:seed` first.');
    }

    await ensureWorkspaceFor(user);
    const token = await createSession(user.id, {
      userAgent: req.get('user-agent') ?? undefined,
      ip: req.ip,
    });
    setSessionCookie(res, token);

    logger.warn({ userId: user.id }, 'signed in with the development bypass');
    ok(res, { user: { id: user.id, email: user.email, name: user.name } });
  }),
);

authRouter.post(
  '/logout',
  handler(async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (token) await destroySession(token);
    clearSessionCookie(res);
    ok(res, { signedOut: true });
  }),
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface GoogleProfile {
  sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  emailVerified: boolean;
}

async function exchangeCodeForProfile(code: string): Promise<GoogleProfile> {
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    logger.warn({ status: tokenRes.status, body: await tokenRes.text() }, 'google token exchange failed');
    throw unauthorized('Could not complete Google sign-in.');
  }

  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const profileRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!profileRes.ok) throw unauthorized('Could not read your Google profile.');

  const profile = (await profileRes.json()) as {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };

  return {
    sub: profile.sub,
    email: profile.email?.toLowerCase() ?? null,
    name: profile.name ?? null,
    picture: profile.picture ?? null,
    emailVerified: profile.email_verified ?? false,
  };
}

async function upsertUser(profile: GoogleProfile) {
  const email = profile.email!;
  const isAdmin = env.ADMIN_EMAILS.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);

  const existing = await prisma.user.findFirst({
    where: { OR: [{ googleId: profile.sub }, { email }] },
  });

  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        googleId: profile.sub,
        name: existing.name ?? profile.name,
        avatarUrl: profile.picture ?? existing.avatarUrl,
        isAdmin: existing.isAdmin || isAdmin,
        lastSeenAt: new Date(),
      },
    });
  }

  return prisma.user.create({
    data: {
      email,
      googleId: profile.sub,
      name: profile.name,
      avatarUrl: profile.picture,
      isAdmin,
      lastSeenAt: new Date(),
    },
  });
}

/** Only ever redirect within the app, never to an attacker-supplied origin. */
function safeNext(next: string | undefined): string {
  if (!next) return '/home';
  if (!next.startsWith('/') || next.startsWith('//')) return '/home';
  return next;
}
