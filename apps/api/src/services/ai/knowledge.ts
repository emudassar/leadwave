import { z } from 'zod';
import { prisma } from '@leadwave/db';
import { AI_LIMITS } from '@leadwave/shared';
import { badRequest } from '../../lib/errors.js';
import { generateStructured, generateText, responseSchema } from './gemini.js';

/**
 * The knowledge base.
 *
 * Three ways in — paste a link, type it, or answer a short interview — and one
 * rule: what lands here is the *only* thing the AI may answer from. Editing is
 * always free, nothing is cached in a way that keeps quoting last month's
 * price, and there is deliberately no mode that reads the business's private
 * messages.
 */

// ─── Scanning a page ─────────────────────────────────────────────────────────

const scanSchema = z.object({
  title: z.string().max(120),
  content: z.string(),
});

/**
 * Fetches a URL and distils it into facts worth answering from. The result is
 * shown for editing *before* it is saved — an extraction the owner has not read
 * is not knowledge, it is a guess.
 */
export async function scanUrl(url: string): Promise<{ title: string; content: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest('That does not look like a valid URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw badRequest('Only http and https pages can be scanned.');
  }
  // Block requests that would reach the machine or network we run on.
  if (isPrivateHost(parsed.hostname)) {
    throw badRequest('That address cannot be reached.');
  }

  const html = await fetchPage(parsed.toString());
  const text = htmlToText(html);

  if (text.length < 80) {
    throw badRequest("We couldn't read enough from that page. Try pasting the text instead.");
  }

  const { data } = await generateStructured(
    `Below is the text of a business's web page. Pull out the facts a customer would ask about — what they sell, what it costs, what is included, how to book or order, delivery, timings, policies.

Write it as short plain statements, one per line. No marketing language, no headings, no bullets characters. Keep only what is factual and specific. If a price appears, keep it exactly as written.

Page text:
"""
${text.slice(0, 30_000)}
"""`,
    scanSchema,
    responseSchema.object(
      {
        title: responseSchema.string('A short label for this source, e.g. "Pricing page"'),
        content: responseSchema.string('The extracted facts, one per line'),
      },
      ['title', 'content'],
    ),
    { tier: 'standard', temperature: 0.2, maxOutputTokens: 2048 },
  );

  return {
    title: data.title.slice(0, 120) || parsed.hostname,
    content: data.content.slice(0, AI_LIMITS.maxKnowledgeCharsPerSource),
  };
}

async function fetchPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'LeadWaveBot/1.0 (+https://leadwave.co)' },
    });

    if (!res.ok) throw badRequest(`That page returned ${res.status}.`);

    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('html') && !type.includes('text')) {
      throw badRequest('That link is not a web page.');
    }

    return (await res.text()).slice(0, 500_000);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw badRequest('That page took too long to respond.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Blocks loopback, link-local and private ranges — a basic SSRF guard. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return true;
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;

  const parts = host.split('.').map(Number);
  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// ─── The interview ───────────────────────────────────────────────────────────

/**
 * Five to eight questions, tuned to the role. Opt-in only — it never launches
 * on its own, because being interrogated by your own tool is unpleasant.
 */
export function interviewQuestions(role: string | null): string[] {
  const base = [
    'What exactly do you sell or offer?',
    'Who is it for?',
    'What does it cost? Include any packages or starting prices.',
    'How does someone order, book, or get started?',
    'What do people ask you most often — and what is the answer?',
    'What will you NOT do, or what do you want the AI to avoid promising?',
  ];

  if (!role) return base;

  const lower = role.toLowerCase();
  if (/shop|store|ecom|product|seller|boutique/.test(lower)) {
    base.push('How does delivery work — cost, timing, and which areas?');
    base.push('What is your returns or exchange policy?');
  } else if (/coach|consult|trainer|academy|course|institute/.test(lower)) {
    base.push('How long is a session or programme, and how is it delivered?');
    base.push('Do you offer a free call or trial first?');
  } else if (/salon|clinic|studio|gym|restaurant|dentist/.test(lower)) {
    base.push('Where are you located, and what are your opening hours?');
    base.push('Do people need an appointment, or can they walk in?');
  }

  return base.slice(0, AI_LIMITS.interviewMaxQuestions);
}

const compiledSchema = z.object({
  title: z.string().max(120),
  content: z.string(),
});

/**
 * Turns the interview answers into a draft source. The draft is editable line
 * by line before saving, so the owner always has the last word on what the AI
 * is allowed to claim.
 */
export async function compileInterview(
  answers: Array<{ question: string; answer: string }>,
): Promise<{ title: string; content: string }> {
  const transcript = answers
    .filter((a) => a.answer.trim())
    .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
    .join('\n\n');

  if (!transcript) throw badRequest('Answer at least one question first.');

  const { data } = await generateStructured(
    `Turn these answers into a clean set of facts about the business, written as short plain statements, one per line.

Rules:
- Keep every specific detail: prices, timings, locations, policies, names.
- Do not invent anything that is not in the answers.
- Do not add marketing language.
- Drop anything vague or empty.

${transcript}`,
    compiledSchema,
    responseSchema.object(
      {
        title: responseSchema.string('A short label, e.g. "About the business"'),
        content: responseSchema.string('The facts, one per line'),
      },
      ['title', 'content'],
    ),
    { tier: 'standard', temperature: 0.2, maxOutputTokens: 2048 },
  );

  return {
    title: data.title.slice(0, 120) || 'About the business',
    content: data.content.slice(0, AI_LIMITS.maxKnowledgeCharsPerSource),
  };
}

// ─── Limits ──────────────────────────────────────────────────────────────────

/**
 * Enforces the per-account ceilings. Knowledge that is too big stops being
 * useful long before it stops fitting — most accounts get excellent answers
 * from three or four sources.
 */
export async function assertKnowledgeCapacity(
  connectedAccountId: string,
  incomingChars: number,
  excludeSourceId?: string,
): Promise<void> {
  const sources = await prisma.aiKnowledgeSource.findMany({
    where: {
      connectedAccountId,
      ...(excludeSourceId ? { id: { not: excludeSourceId } } : {}),
    },
    select: { charCount: true },
  });

  if (!excludeSourceId && sources.length >= AI_LIMITS.maxKnowledgeSources) {
    throw badRequest(
      `You can keep ${AI_LIMITS.maxKnowledgeSources} knowledge sources. Delete one to add another.`,
    );
  }

  if (incomingChars > AI_LIMITS.maxKnowledgeCharsPerSource) {
    throw badRequest(
      `That source is too long. Keep each one under ${AI_LIMITS.maxKnowledgeCharsPerSource.toLocaleString()} characters.`,
    );
  }

  const total = sources.reduce((sum, s) => sum + s.charCount, 0) + incomingChars;
  if (total > AI_LIMITS.maxKnowledgeCharsPerAccount) {
    throw badRequest(
      `That would take you over the ${AI_LIMITS.maxKnowledgeCharsPerAccount.toLocaleString()} character limit for this Page.`,
    );
  }
}

export { generateText };
