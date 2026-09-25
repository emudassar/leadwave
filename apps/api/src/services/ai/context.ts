import { prisma, type AiGoal, type ConnectedAccount } from '@leadwave/db';
import {
  AI_LIMITS,
  DEFAULT_GUARDRAILS,
  goalAllowedForLabel,
  type GoalType,
  type MessageLabel,
} from '@leadwave/shared';
import { createStandaloneLink, shortLinkUrl } from '../shortlinks.js';
import type { BrandContext, GoalDirective } from './generate.js';

/**
 * Assembling what the AI is allowed to know.
 *
 * Knowledge is per-Page and comes only from sources the business wrote or
 * approved. There is deliberately no "learn from my chats" mode — the generator
 * sees the recent turns of the one thread it is replying in, and nothing else
 * from anyone's private messages.
 */

export async function buildBrandContext(
  account: ConnectedAccount,
): Promise<BrandContext | null> {
  const settings = await prisma.aiSettings.findUnique({
    where: { connectedAccountId: account.id },
  });
  if (!settings) return null;

  const sources = await prisma.aiKnowledgeSource.findMany({
    where: { connectedAccountId: account.id, isEnabled: true },
    orderBy: { createdAt: 'asc' },
    take: AI_LIMITS.maxKnowledgeSources,
  });

  const knowledge = sources
    .map((s) => `## ${s.title}\n${s.content}`)
    .join('\n\n')
    .slice(0, AI_LIMITS.maxKnowledgeCharsPerAccount);

  return {
    role: settings.role,
    brandVoice: settings.brandVoice,
    guardrails: settings.guardrails.length > 0 ? settings.guardrails : [...DEFAULT_GUARDRAILS],
    knowledge,
    allowedLinks: extractLinks(knowledge),
    pageName: account.pageName,
    fixedLanguage: settings.languageMode === 'fixed' ? settings.fixedLanguage : null,
  };
}

/**
 * Every URL that appears anywhere in the knowledge base. This is the allowed-
 * links list: a URL not on it cannot be sent, no matter how the message is
 * phrased.
 */
function extractLinks(knowledge: string): string[] {
  const matches = knowledge.match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
  return [...new Set(matches.map((m) => m.replace(/[.,;:!?)\]]+$/, '')))].slice(0, 30);
}

// ─── Goals ───────────────────────────────────────────────────────────────────

/**
 * Picks at most one goal for this reply.
 *
 * Support issues never get a goal — enforced here, in the pipeline, rather than
 * left to the model's judgement. Somebody with a broken order does not want to
 * be sold to.
 */
export async function selectGoal(
  connectedAccountId: string,
  label: MessageLabel,
): Promise<{ goal: AiGoal; directive: GoalDirective } | null> {
  if (label === 'support_issue') return null;

  const goals = await prisma.aiGoal.findMany({
    where: { connectedAccountId, status: 'live' },
    orderBy: { createdAt: 'asc' },
    take: AI_LIMITS.maxLiveGoals,
  });

  // Buying intent is best served by a link; a plain question by a lead ask.
  const preference: GoalType[] =
    label === 'buy_intent'
      ? ['share_link', 'capture_lead', 'grow_followers']
      : ['capture_lead', 'share_link', 'grow_followers'];

  for (const type of preference) {
    const goal = goals.find((g) => g.type === type);
    if (!goal) continue;
    if (!goalAllowedForLabel(type, label)) continue;

    const directive = await directiveFor(goal);
    if (directive) return { goal, directive };
  }

  return null;
}

async function directiveFor(goal: AiGoal): Promise<GoalDirective | null> {
  const config = (goal.config as Record<string, unknown> | null) ?? {};

  if (goal.type === 'share_link') {
    const url = typeof config.url === 'string' ? config.url : null;
    if (!url) return null;

    // The goal's link is always a tracked short link, which is what makes
    // "did they click it?" answerable from our own data rather than guesswork.
    let link = await prisma.shortLink.findFirst({ where: { aiGoalId: goal.id } });
    if (!link || link.targetUrl !== url) {
      link = link
        ? await prisma.shortLink.update({ where: { id: link.id }, data: { targetUrl: url } })
        : await createStandaloneLink({
            targetUrl: url,
            connectedAccountId: goal.connectedAccountId,
            aiGoalId: goal.id,
          });
    }

    return { type: 'share_link', link: shortLinkUrl(link.slug) };
  }

  if (goal.type === 'capture_lead') {
    const field = config.field === 'phone' ? 'phone' : 'email';
    return { type: 'capture_lead', field };
  }

  return { type: 'grow_followers' };
}

/** A share-link goal's URL joins the allowed-links list for that reply. */
export function withGoalLink(brand: BrandContext, directive: GoalDirective | null): BrandContext {
  if (!directive?.link) return brand;
  return { ...brand, allowedLinks: [...brand.allowedLinks, directive.link] };
}

// ─── Thread context ──────────────────────────────────────────────────────────

/**
 * The last few turns of this one conversation. Capped deliberately: the AI is
 * answering the message in front of it, not mining a relationship history.
 */
export async function recentTurns(
  conversationId: string,
): Promise<Array<{ role: 'contact' | 'business'; text: string }>> {
  const messages = await prisma.message.findMany({
    where: {
      conversationId,
      text: { not: null },
      status: { notIn: ['held', 'failed', 'canceled'] },
    },
    orderBy: { createdAt: 'desc' },
    take: AI_LIMITS.threadContextTurns,
    select: { direction: true, text: true },
  });

  return messages
    .reverse()
    .map((m) => ({
      role: m.direction === 'inbound' ? ('contact' as const) : ('business' as const),
      text: (m.text ?? '').slice(0, 500),
    }));
}

/** A one-line description of the business, used to steer the classifier. */
export function businessSummary(brand: BrandContext | null): string | undefined {
  if (!brand?.role) return undefined;
  return brand.role;
}
