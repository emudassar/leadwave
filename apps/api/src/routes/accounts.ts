import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@leadwave/db';
import { PLAN_DEFINITIONS, hasAi, limitsFor, type Plan } from '@leadwave/shared';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { randomToken } from '../lib/crypto.js';
import { created, handler, ok, parseBody, parseParams } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { attachWorkspace, requireRole } from '../middleware/workspace.js';
import { assertSeatQuota, currentUsage } from '../services/entitlements.js';
import { creditBalance } from '../services/ai/credits.js';

/**
 * The workspace: connected Pages, plan and usage, team seats, onboarding.
 *
 * `/accounts/me` is the first call the dashboard makes and drives nearly all of
 * its gating, so it returns limits and live usage together — the SPA should
 * never have to derive what the plan allows from three separate endpoints.
 */

export const accountsRouter: Router = Router();
accountsRouter.use(requireAuth, attachWorkspace);

const idParam = z.object({ id: z.string().min(1) });

accountsRouter.get(
  '/me',
  handler(async (req, res) => {
    const workspace = req.workspace!;
    const plan = workspace.plan as Plan;

    const [accounts, usage, credits, subscription, memberCount, contactCount] = await Promise.all([
      prisma.connectedAccount.findMany({
        where: { workspaceId: workspace.id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          pageId: true,
          pageName: true,
          pageUsername: true,
          pagePictureUrl: true,
          pageUrl: true,
          status: true,
          statusDetail: true,
          color: true,
          webhookSubscribedAt: true,
          createdAt: true,
        },
      }),
      currentUsage(workspace.id),
      creditBalance(workspace.id, plan),
      prisma.subscription.findUnique({ where: { workspaceId: workspace.id } }),
      prisma.workspaceMember.count({ where: { workspaceId: workspace.id } }),
      prisma.contact.count({ where: { connectedAccount: { workspaceId: workspace.id } } }),
    ]);

    const limits = limitsFor(plan);

    ok(res, {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        timezone: workspace.timezone,
        plan,
        persona: workspace.persona,
        onboardedAt: workspace.onboardedAt,
        role: req.workspaceRole,
      },
      connectedAccounts: accounts,
      plan: {
        id: plan,
        name: PLAN_DEFINITIONS[plan].name,
        features: PLAN_DEFINITIONS[plan].features,
        limits,
        hasAi: hasAi(plan),
      },
      usage: {
        messagesSent: usage.messagesSent,
        leadsCaptured: usage.leadsCaptured,
        contacts: contactCount,
        connectedPages: accounts.filter((a) => a.status !== 'disabled').length,
        seats: memberCount,
        periodStart: usage.periodStart,
        periodEnd: usage.periodEnd,
      },
      credits,
      subscription: subscription
        ? {
            status: subscription.status,
            interval: subscription.interval,
            currency: subscription.currency,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            provider: subscription.provider,
          }
        : null,
    });
  }),
);

accountsRouter.patch(
  '/me',
  requireRole('admin'),
  handler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        timezone: z.string().min(1).max(64).optional(),
      }),
    );

    if (body.timezone && !isValidTimezone(body.timezone)) {
      throw badRequest('That is not a recognised time zone.');
    }

    const workspace = await prisma.workspace.update({
      where: { id: req.workspace!.id },
      data: body,
    });

    ok(res, { id: workspace.id, name: workspace.name, timezone: workspace.timezone });
  }),
);

/** Records what kind of business this is; tunes AI copy and template picks. */
accountsRouter.post(
  '/onboarding/persona',
  handler(async (req, res) => {
    const { persona } = parseBody(req, z.object({ persona: z.string().trim().min(1).max(60) }));

    await prisma.workspace.update({
      where: { id: req.workspace!.id },
      data: { persona, onboardedAt: req.workspace!.onboardedAt ?? new Date() },
    });

    ok(res, { persona });
  }),
);

// ─── Team ────────────────────────────────────────────────────────────────────

accountsRouter.get(
  '/me/members',
  handler(async (req, res) => {
    const [members, invites] = await Promise.all([
      prisma.workspaceMember.findMany({
        where: { workspaceId: req.workspace!.id },
        include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.invite.findMany({
        where: { workspaceId: req.workspace!.id, acceptedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    ok(res, {
      members: members.map((m) => ({
        id: m.id,
        role: m.role,
        joinedAt: m.createdAt,
        user: m.user,
        isYou: m.userId === req.user!.id,
      })),
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt,
        /** The link to hand over; we do not send email ourselves. */
        url: `${process.env.APP_URL ?? ''}/join/${i.token}`,
      })),
      seatLimit: limitsFor(req.workspace!.plan as Plan).teamSeats,
    });
  }),
);

accountsRouter.post(
  '/me/invites',
  requireRole('admin'),
  handler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({
        email: z.string().email().toLowerCase(),
        role: z.enum(['admin', 'manager', 'viewer']).default('manager'),
      }),
    );

    const workspace = req.workspace!;
    await assertSeatQuota(workspace.id, workspace.plan as Plan);

    const alreadyMember = await prisma.workspaceMember.findFirst({
      where: { workspaceId: workspace.id, user: { email: body.email } },
    });
    if (alreadyMember) throw conflict('That person is already on your team.');

    const token = randomToken(24);
    const invite = await prisma.invite.upsert({
      where: { workspaceId_email: { workspaceId: workspace.id, email: body.email } },
      create: {
        workspaceId: workspace.id,
        email: body.email,
        role: body.role,
        token,
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      },
      update: {
        role: body.role,
        token,
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        acceptedAt: null,
      },
    });

    created(res, {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      url: `${process.env.APP_URL ?? ''}/join/${invite.token}`,
    });
  }),
);

accountsRouter.delete(
  '/me/invites/:id',
  requireRole('admin'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const invite = await prisma.invite.findFirst({
      where: { id, workspaceId: req.workspace!.id },
    });
    if (!invite) throw notFound('That invite does not exist.');

    await prisma.invite.delete({ where: { id } });
    ok(res, { revoked: true });
  }),
);

accountsRouter.patch(
  '/me/members/:id',
  requireRole('admin'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const { role } = parseBody(req, z.object({ role: z.enum(['admin', 'manager', 'viewer']) }));

    const member = await prisma.workspaceMember.findFirst({
      where: { id, workspaceId: req.workspace!.id },
    });
    if (!member) throw notFound('That member does not exist.');

    // Never let the last admin demote themselves out of the workspace.
    if (member.role === 'admin' && role !== 'admin') {
      const admins = await prisma.workspaceMember.count({
        where: { workspaceId: req.workspace!.id, role: 'admin' },
      });
      if (admins <= 1) throw badRequest('A workspace needs at least one admin.');
    }

    const updated = await prisma.workspaceMember.update({ where: { id }, data: { role } });
    ok(res, { id: updated.id, role: updated.role });
  }),
);

accountsRouter.delete(
  '/me/members/:id',
  requireRole('admin'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);

    const member = await prisma.workspaceMember.findFirst({
      where: { id, workspaceId: req.workspace!.id },
    });
    if (!member) throw notFound('That member does not exist.');

    if (member.role === 'admin') {
      const admins = await prisma.workspaceMember.count({
        where: { workspaceId: req.workspace!.id, role: 'admin' },
      });
      if (admins <= 1) throw badRequest('A workspace needs at least one admin.');
    }

    await prisma.workspaceMember.delete({ where: { id } });
    ok(res, { removed: true });
  }),
);

/** Accepting an invite. The token is the credential, so it is single-use. */
accountsRouter.post(
  '/join',
  handler(async (req, res) => {
    const { token } = parseBody(req, z.object({ token: z.string().min(1) }));

    const invite = await prisma.invite.findUnique({
      where: { token },
      include: { workspace: true },
    });

    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      throw notFound('That invite has expired.');
    }
    if (invite.email !== req.user!.email) {
      throw badRequest(`This invite was sent to ${invite.email}.`);
    }

    await prisma.$transaction([
      prisma.workspaceMember.upsert({
        where: {
          workspaceId_userId: { workspaceId: invite.workspaceId, userId: req.user!.id },
        },
        create: { workspaceId: invite.workspaceId, userId: req.user!.id, role: invite.role },
        update: { role: invite.role },
      }),
      prisma.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
    ]);

    ok(res, { workspaceId: invite.workspaceId, name: invite.workspace.name });
  }),
);

// ─── Home dashboard ──────────────────────────────────────────────────────────

/**
 * The numbers on the Home screen. A "setup score" nudges people through the
 * steps that actually make the product work, rather than leaving an empty
 * dashboard and hoping.
 */
accountsRouter.get(
  '/me/home',
  handler(async (req, res) => {
    const workspace = req.workspace!;
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const scope = { connectedAccount: { workspaceId: workspace.id } };

    const [pages, liveAutomations, runs, clicks, leads, conversations, bioPages] =
      await Promise.all([
        prisma.connectedAccount.count({ where: { workspaceId: workspace.id, status: 'active' } }),
        prisma.automation.count({ where: { ...scope, status: 'live' } }),
        // A run hangs off an automation, not off the Page directly.
        prisma.automationRun.count({
          where: { automation: scope, startedAt: { gte: weekAgo } },
        }),
        prisma.linkClick.count({
          where: { shortLink: { connectedAccount: { workspaceId: workspace.id } }, createdAt: { gte: weekAgo } },
        }),
        prisma.lead.count({ where: { ...scope, createdAt: { gte: weekAgo } } }),
        prisma.conversation.count({ where: { ...scope, unreadCount: { gt: 0 } } }),
        prisma.bioPage.count({ where: { workspaceId: workspace.id, isPublished: true } }),
      ]);

    const steps = [
      { id: 'connect_page', label: 'Connect a Facebook Page', done: pages > 0 },
      { id: 'create_automation', label: 'Publish your first automation', done: liveAutomations > 0 },
      { id: 'first_trigger', label: 'Get your first trigger', done: runs > 0 },
      { id: 'bio_page', label: 'Publish your link-in-bio page', done: bioPages > 0 },
    ];

    ok(res, {
      stats: {
        triggersThisWeek: runs,
        clicksThisWeek: clicks,
        leadsThisWeek: leads,
        unreadConversations: conversations,
        livePages: pages,
        liveAutomations,
      },
      setup: {
        steps,
        score: Math.round((steps.filter((s) => s.done).length / steps.length) * 100),
      },
    });
  }),
);

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
