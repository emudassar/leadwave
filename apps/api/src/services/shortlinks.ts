import { customAlphabet } from 'nanoid';
import { prisma, type ShortLink } from '@leadwave/db';
import { collectLinks, type AutomationDefinition } from '@leadwave/shared';
import { env } from '../env.js';
import { visitorHash } from '../lib/crypto.js';

/**
 * Tracked short links.
 *
 * Every URL a LeadWave message sends is wrapped, which is what turns "47
 * clicks" into "the hoodie got 31, the cap got 12". A link's identity is its
 * *address* — automation + step + card + button — so per-product click data
 * falls out of the schema rather than needing a separate analytics pipeline.
 */

// No look-alike characters: a slug may be read off a screen and retyped.
const nanoid = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 7);

export function shortLinkUrl(slug: string): string {
  return `${env.SHORTLINK_URL}/r/${slug}`;
}

async function uniqueSlug(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = nanoid();
    const clash = await prisma.shortLink.findUnique({ where: { slug }, select: { id: true } });
    if (!clash) return slug;
  }
  // Astronomically unlikely; widen rather than fail the publish.
  return `${nanoid()}${nanoid()}`;
}

export interface LinkAddressKey {
  stepId: string;
  cardId: string | null;
  buttonIndex: number;
}

export function addressKey(address: LinkAddressKey): string {
  return `${address.stepId}:${address.cardId ?? '-'}:${address.buttonIndex}`;
}

/**
 * Mints (or updates) a short link for every URL button in a definition, and
 * returns a resolver the message builder can use.
 *
 * Re-publishing keeps the existing slug for an address whose URL is unchanged,
 * so historical click data survives an edit. Changing a button's destination
 * updates the target in place — the clicks still belong to that button.
 */
export async function syncAutomationLinks(
  automationId: string,
  connectedAccountId: string,
  definition: AutomationDefinition,
): Promise<Map<string, ShortLink>> {
  const wanted = collectLinks(definition);
  const existing = await prisma.shortLink.findMany({ where: { automationId } });

  const byAddress = new Map<string, ShortLink>();
  for (const link of existing) {
    byAddress.set(
      addressKey({
        stepId: link.stepId ?? '',
        cardId: link.cardId,
        buttonIndex: link.buttonIndex ?? 0,
      }),
      link,
    );
  }

  const result = new Map<string, ShortLink>();
  const keepIds = new Set<string>();

  for (const link of wanted) {
    const key = addressKey(link);
    const current = byAddress.get(key);

    if (current) {
      keepIds.add(current.id);
      const updated =
        current.targetUrl === link.url
          ? current
          : await prisma.shortLink.update({
              where: { id: current.id },
              data: { targetUrl: link.url },
            });
      result.set(key, updated);
      continue;
    }

    const created = await prisma.shortLink.create({
      data: {
        slug: await uniqueSlug(),
        targetUrl: link.url,
        connectedAccountId,
        automationId,
        stepId: link.stepId,
        cardId: link.cardId,
        buttonIndex: link.buttonIndex,
      },
    });
    keepIds.add(created.id);
    result.set(key, created);
  }

  // Links whose button was deleted are removed along with their clicks; keeping
  // orphaned rows would inflate the automation's totals.
  const orphans = existing.filter((l) => !keepIds.has(l.id)).map((l) => l.id);
  if (orphans.length > 0) {
    await prisma.shortLink.deleteMany({ where: { id: { in: orphans } } });
  }

  return result;
}

/** Builds the `resolveUrl` function the message builder expects. */
export function linkResolver(links: Map<string, ShortLink>) {
  return (address: LinkAddressKey): string | undefined => {
    const link = links.get(addressKey(address));
    return link ? shortLinkUrl(link.slug) : undefined;
  };
}

export async function loadAutomationLinks(automationId: string): Promise<Map<string, ShortLink>> {
  const links = await prisma.shortLink.findMany({ where: { automationId } });
  const map = new Map<string, ShortLink>();
  for (const link of links) {
    map.set(
      addressKey({
        stepId: link.stepId ?? '',
        cardId: link.cardId,
        buttonIndex: link.buttonIndex ?? 0,
      }),
      link,
    );
  }
  return map;
}

/** A standalone tracked link — used by bio page blocks and AI share-link goals. */
export async function createStandaloneLink(input: {
  targetUrl: string;
  connectedAccountId?: string | null;
  bioBlockId?: string | null;
  aiGoalId?: string | null;
}): Promise<ShortLink> {
  return prisma.shortLink.create({
    data: {
      slug: await uniqueSlug(),
      targetUrl: input.targetUrl,
      connectedAccountId: input.connectedAccountId ?? null,
      bioBlockId: input.bioBlockId ?? null,
      aiGoalId: input.aiGoalId ?? null,
    },
  });
}

// ─── Click recording ─────────────────────────────────────────────────────────

export interface ClickInput {
  slug: string;
  /** Present when the click came from a DM link we can attribute to a contact. */
  contactId?: string | null;
  ip: string;
  userAgent: string;
  referer?: string | null;
}

export interface ClickResult {
  targetUrl: string;
  shortLinkId: string;
  isUnique: boolean;
}

/**
 * Records a tap and returns where to send the visitor.
 *
 * "Unique" means a person we have not seen on this link before — by contact
 * where we know one, and by a salted fingerprint where we do not. That is what
 * makes the unique-clicker number mean "real people, not the same person
 * twice".
 */
export async function recordClick(input: ClickInput): Promise<ClickResult | null> {
  const link = await prisma.shortLink.findUnique({ where: { slug: input.slug } });
  if (!link) return null;

  const hash = visitorHash(input.ip, input.userAgent);

  const priorClick = await prisma.linkClick.findFirst({
    where: {
      shortLinkId: link.id,
      ...(input.contactId ? { contactId: input.contactId } : { visitorHash: hash }),
    },
    select: { id: true },
  });
  const isUnique = !priorClick;

  await prisma.$transaction([
    prisma.linkClick.create({
      data: {
        shortLinkId: link.id,
        contactId: input.contactId ?? null,
        isUnique,
        device: deviceFrom(input.userAgent),
        userAgent: input.userAgent.slice(0, 500),
        referer: input.referer?.slice(0, 500) ?? null,
        visitorHash: hash,
      },
    }),
    prisma.shortLink.update({
      where: { id: link.id },
      data: {
        clickCount: { increment: 1 },
        ...(isUnique ? { uniqueClickCount: { increment: 1 } } : {}),
      },
    }),
    ...(link.bioBlockId
      ? [
          prisma.bioBlock.update({
            where: { id: link.bioBlockId },
            data: { clickCount: { increment: 1 } },
          }),
        ]
      : []),
  ]);

  return { targetUrl: link.targetUrl, shortLinkId: link.id, isUnique };
}

function deviceFrom(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(ua)) return 'tablet';
  if (/mobi|android|iphone|ipod/.test(ua)) return 'mobile';
  return 'desktop';
}
