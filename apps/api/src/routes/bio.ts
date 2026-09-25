import { Router } from 'express';
import { z } from 'zod';
import { prisma, type Prisma } from '@leadwave/db';
import { limitsFor, type Plan } from '@leadwave/shared';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { created, handler, ok, parseBody, parseParams, parseQuery } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { attachWorkspace, requireRole } from '../middleware/workspace.js';
import { assertFeature } from '../services/entitlements.js';
import { createStandaloneLink, shortLinkUrl } from '../services/shortlinks.js';

/**
 * The link-in-bio page.
 *
 * Every link block is a tracked short link, using the same machinery as the
 * message buttons — so bio taps and DM taps are measured the same way and show
 * up side by side in analytics rather than in two separate worlds.
 */

export const bioRouter: Router = Router();
bioRouter.use(requireAuth, attachWorkspace);

const idParam = z.object({ id: z.string().min(1) });

export const BIO_THEMES = [
  { id: 'clean', name: 'Clean', premium: false },
  { id: 'midnight', name: 'Midnight', premium: false },
  { id: 'sunrise', name: 'Sunrise', premium: false },
  { id: 'grid', name: 'Grid', premium: true },
  { id: 'canvas', name: 'Canvas', premium: true },
  { id: 'spotlight', name: 'Spotlight', premium: true },
] as const;

const RESERVED_HANDLES = new Set([
  'app', 'api', 'admin', 'www', 'blog', 'help', 'support', 'login', 'signup',
  'settings', 'pricing', 'about', 'terms', 'privacy', 'u', 'r', 'static', 'assets',
]);

bioRouter.get(
  '/themes',
  handler(async (req, res) => {
    const plan = req.workspace!.plan as Plan;
    const canUsePremium = (await import('@leadwave/shared')).hasFeature(plan, 'bio_premium_themes');

    ok(res, {
      themes: BIO_THEMES.map((t) => ({ ...t, locked: t.premium && !canUsePremium })),
    });
  }),
);

bioRouter.get(
  '/pages/handle-available',
  handler(async (req, res) => {
    const { handle } = parseQuery(req, z.object({ handle: z.string().min(1).max(32) }));
    const normalised = handle.trim().toLowerCase();

    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(normalised)) {
      return ok(res, {
        available: false,
        reason: 'Use 2–32 letters, numbers, hyphens or underscores.',
      });
    }
    if (RESERVED_HANDLES.has(normalised)) {
      return ok(res, { available: false, reason: 'That name is reserved.' });
    }

    const taken = await prisma.bioPage.findUnique({
      where: { handle: normalised },
      select: { workspaceId: true },
    });

    ok(res, {
      available: !taken || taken.workspaceId === req.workspace!.id,
      reason: taken && taken.workspaceId !== req.workspace!.id ? 'That name is taken.' : null,
      handle: normalised,
    });
  }),
);

bioRouter.get(
  '/pages/me',
  handler(async (req, res) => {
    const pages = await prisma.bioPage.findMany({
      where: { workspaceId: req.workspace!.id },
      include: { _count: { select: { blocks: true, views: true } } },
      orderBy: { createdAt: 'asc' },
    });

    ok(res, {
      pages: pages.map((p) => ({
        id: p.id,
        handle: p.handle,
        displayName: p.displayName,
        isPublished: p.isPublished,
        theme: p.theme,
        blockCount: p._count.blocks,
        views: p.viewCount,
        url: `${process.env.WEB_URL ?? ''}/u/${p.handle}`,
        updatedAt: p.updatedAt,
      })),
      maxPages: limitsFor(req.workspace!.plan as Plan).bioPages,
    });
  }),
);

bioRouter.post(
  '/pages',
  requireRole('manager'),
  handler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({
        handle: z.string().trim().toLowerCase().min(2).max(32),
        displayName: z.string().trim().min(1).max(60),
        bio: z.string().trim().max(200).optional(),
      }),
    );

    const workspace = req.workspace!;
    const plan = workspace.plan as Plan;

    const existing = await prisma.bioPage.count({ where: { workspaceId: workspace.id } });
    if (existing >= limitsFor(plan).bioPages) {
      assertFeature(plan, 'bio_multiple_pages', 'More than one bio page');
    }

    if (RESERVED_HANDLES.has(body.handle)) throw badRequest('That name is reserved.');

    const taken = await prisma.bioPage.findUnique({ where: { handle: body.handle } });
    if (taken) throw conflict('That name is taken.');

    const page = await prisma.bioPage.create({
      data: {
        workspaceId: workspace.id,
        handle: body.handle,
        displayName: body.displayName,
        bio: body.bio ?? null,
        showBranding: !(await import('@leadwave/shared')).hasFeature(plan, 'remove_branding'),
      },
    });

    created(res, { id: page.id, handle: page.handle });
  }),
);

bioRouter.get(
  '/pages/:id',
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const page = await loadPage(req.workspace!.id, id);

    const blocks = await prisma.bioBlock.findMany({
      where: { bioPageId: page.id },
      include: { shortLinks: { select: { slug: true, clickCount: true, uniqueClickCount: true } } },
      orderBy: { position: 'asc' },
    });

    ok(res, {
      page: {
        id: page.id,
        handle: page.handle,
        displayName: page.displayName,
        bio: page.bio,
        avatarUrl: page.avatarUrl,
        theme: page.theme,
        themeConfig: page.themeConfig,
        isPublished: page.isPublished,
        showBranding: page.showBranding,
        seoTitle: page.seoTitle,
        seoDescription: page.seoDescription,
        seoImageUrl: page.seoImageUrl,
        seoNoIndex: page.seoNoIndex,
        url: `${process.env.WEB_URL ?? ''}/u/${page.handle}`,
      },
      blocks: blocks.map((b) => ({
        id: b.id,
        type: b.type,
        position: b.position,
        isVisible: b.isVisible,
        title: b.title,
        subtitle: b.subtitle,
        url: b.url,
        imageUrl: b.imageUrl,
        config: b.config,
        visibleFrom: b.visibleFrom,
        visibleUntil: b.visibleUntil,
        clicks: b.clickCount,
        uniqueClicks: b.shortLinks.reduce((sum, l) => sum + l.uniqueClickCount, 0),
      })),
    });
  }),
);

bioRouter.patch(
  '/pages/:id',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(
      req,
      z.object({
        displayName: z.string().trim().min(1).max(60).optional(),
        bio: z.string().trim().max(200).nullable().optional(),
        avatarUrl: z.string().url().nullable().optional(),
        theme: z.string().max(40).optional(),
        themeConfig: z.record(z.unknown()).optional(),
        isPublished: z.boolean().optional(),
        seoTitle: z.string().trim().max(80).nullable().optional(),
        seoDescription: z.string().trim().max(200).nullable().optional(),
        seoImageUrl: z.string().url().nullable().optional(),
        seoNoIndex: z.boolean().optional(),
      }),
    );

    const workspace = req.workspace!;
    const plan = workspace.plan as Plan;
    const page = await loadPage(workspace.id, id);

    if (body.theme) {
      const theme = BIO_THEMES.find((t) => t.id === body.theme);
      if (!theme) throw badRequest('That theme does not exist.');
      if (theme.premium) assertFeature(plan, 'bio_premium_themes', 'Premium themes');
    }

    const touchesSeo =
      body.seoTitle !== undefined ||
      body.seoDescription !== undefined ||
      body.seoImageUrl !== undefined ||
      body.seoNoIndex !== undefined;
    if (touchesSeo) assertFeature(plan, 'bio_seo_controls', 'SEO controls');

    const { themeConfig, ...rest } = body;
    const updated = await prisma.bioPage.update({
      where: { id: page.id },
      data: {
        ...rest,
        ...(themeConfig ? { themeConfig: themeConfig as Prisma.InputJsonValue } : {}),
      },
    });

    ok(res, { id: updated.id, updatedAt: updated.updatedAt });
  }),
);

bioRouter.delete(
  '/pages/:id',
  requireRole('admin'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const page = await loadPage(req.workspace!.id, id);
    await prisma.bioPage.delete({ where: { id: page.id } });
    ok(res, { deleted: true });
  }),
);

// ─── Blocks ──────────────────────────────────────────────────────────────────

const blockBody = z.object({
  type: z.enum(['link', 'header', 'text', 'image', 'video', 'socials', 'email_capture']),
  title: z.string().trim().max(80).nullable().optional(),
  subtitle: z.string().trim().max(160).nullable().optional(),
  url: z.string().url().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  config: z.record(z.unknown()).optional(),
  isVisible: z.boolean().optional(),
  visibleFrom: z.coerce.date().nullable().optional(),
  visibleUntil: z.coerce.date().nullable().optional(),
});

bioRouter.post(
  '/pages/:id/blocks',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, blockBody);
    const page = await loadPage(req.workspace!.id, id);

    if (body.type === 'link' && !body.url) throw badRequest('A link block needs a URL.');
    if (body.visibleFrom || body.visibleUntil) {
      assertFeature(req.workspace!.plan as Plan, 'bio_link_scheduling', 'Link scheduling');
    }

    const last = await prisma.bioBlock.findFirst({
      where: { bioPageId: page.id },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    const block = await prisma.bioBlock.create({
      data: {
        bioPageId: page.id,
        type: body.type,
        position: (last?.position ?? -1) + 1,
        title: body.title ?? null,
        subtitle: body.subtitle ?? null,
        url: body.url ?? null,
        imageUrl: body.imageUrl ?? null,
        config: (body.config ?? {}) as Prisma.InputJsonValue,
        isVisible: body.isVisible ?? true,
        visibleFrom: body.visibleFrom ?? null,
        visibleUntil: body.visibleUntil ?? null,
      },
    });

    // Link blocks are tracked exactly like DM buttons.
    if (block.type === 'link' && block.url) {
      await createStandaloneLink({ targetUrl: block.url, bioBlockId: block.id });
    }

    created(res, block);
  }),
);

bioRouter.patch(
  '/blocks/:id',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, blockBody.partial());

    const block = await prisma.bioBlock.findFirst({
      where: { id, bioPage: { workspaceId: req.workspace!.id } },
    });
    if (!block) throw notFound('That block does not exist.');

    if (body.visibleFrom || body.visibleUntil) {
      assertFeature(req.workspace!.plan as Plan, 'bio_link_scheduling', 'Link scheduling');
    }

    // `type` is immutable once a block exists; changing it would orphan its
    // tracked link and its click history.
    const { config, type: _type, ...rest } = body;
    const updated = await prisma.bioBlock.update({
      where: { id },
      data: {
        ...rest,
        ...(config ? { config: config as Prisma.InputJsonValue } : {}),
      },
    });

    // A changed destination keeps the same short link, so its clicks carry over.
    if (body.url && updated.type === 'link') {
      const link = await prisma.shortLink.findFirst({ where: { bioBlockId: updated.id } });
      if (link) {
        await prisma.shortLink.update({ where: { id: link.id }, data: { targetUrl: body.url } });
      } else {
        await createStandaloneLink({ targetUrl: body.url, bioBlockId: updated.id });
      }
    }

    ok(res, updated);
  }),
);

bioRouter.delete(
  '/blocks/:id',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const block = await prisma.bioBlock.findFirst({
      where: { id, bioPage: { workspaceId: req.workspace!.id } },
    });
    if (!block) throw notFound('That block does not exist.');

    await prisma.bioBlock.delete({ where: { id } });
    ok(res, { deleted: true });
  }),
);

bioRouter.put(
  '/pages/:id/blocks/reorder',
  requireRole('manager'),
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const { blockIds } = parseBody(req, z.object({ blockIds: z.array(z.string()).max(100) }));
    const page = await loadPage(req.workspace!.id, id);

    const owned = await prisma.bioBlock.findMany({
      where: { bioPageId: page.id },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((b) => b.id));

    await prisma.$transaction(
      blockIds
        .filter((blockId) => ownedIds.has(blockId))
        .map((blockId, position) =>
          prisma.bioBlock.update({ where: { id: blockId }, data: { position } }),
        ),
    );

    ok(res, { reordered: true });
  }),
);

// ─── Analytics ───────────────────────────────────────────────────────────────

bioRouter.get(
  '/pages/:id/summary',
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const page = await loadPage(req.workspace!.id, id);

    const fourteenDays = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const [views, recentViews, blocks, leads, devices] = await Promise.all([
      prisma.bioPageView.count({ where: { bioPageId: page.id } }),
      prisma.bioPageView.count({ where: { bioPageId: page.id, createdAt: { gte: fourteenDays } } }),
      prisma.bioBlock.findMany({
        where: { bioPageId: page.id, type: 'link' },
        include: { shortLinks: { select: { slug: true, clickCount: true, uniqueClickCount: true } } },
        orderBy: { clickCount: 'desc' },
      }),
      prisma.lead.count({ where: { bioPageId: page.id } }),
      prisma.bioPageView.groupBy({
        by: ['device'],
        where: { bioPageId: page.id },
        _count: { _all: true },
      }),
    ]);

    const totalClicks = blocks.reduce((sum, b) => sum + b.clickCount, 0);

    ok(res, {
      views,
      recentViews,
      totalClicks,
      /** Taps divided by page views — the only CTR that means anything here. */
      ctr: views > 0 ? Number(((totalClicks / views) * 100).toFixed(1)) : 0,
      leads,
      devices: Object.fromEntries(devices.map((d) => [d.device ?? 'unknown', d._count._all])),
      links: blocks.map((b) => ({
        id: b.id,
        title: b.title,
        url: b.url,
        clicks: b.clickCount,
        uniqueClicks: b.shortLinks.reduce((sum, l) => sum + l.uniqueClickCount, 0),
        shareOfClicks:
          totalClicks > 0 ? Number(((b.clickCount / totalClicks) * 100).toFixed(1)) : 0,
        shortUrl: b.shortLinks[0] ? shortLinkUrl(b.shortLinks[0].slug) : null,
      })),
    });
  }),
);

bioRouter.get(
  '/pages/:id/leads',
  handler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const page = await loadPage(req.workspace!.id, id);

    const leads = await prisma.lead.findMany({
      where: { bioPageId: page.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    ok(res, { leads });
  }),
);

async function loadPage(workspaceId: string, id: string) {
  const page = await prisma.bioPage.findFirst({ where: { id, workspaceId } });
  if (!page) throw notFound('That bio page does not exist.');
  return page;
}
