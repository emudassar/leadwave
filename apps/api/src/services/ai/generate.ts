import { z } from 'zod';
import {
  AI_LIMITS,
  DEFAULT_GUARDRAILS,
  SYSTEM_GUARDRAILS,
  type GoalType,
  type MessageLabel,
} from '@leadwave/shared';
import { generateStructured, generateText, responseSchema } from './gemini.js';

/**
 * Reply generation.
 *
 * The model answers only from the knowledge the business wrote down. Two rules
 * are enforced outside the prompt as well as inside it, because a prompt is a
 * request and not a guarantee:
 *
 *   - **the allowed-links list** — a URL that is not in knowledge or a live
 *     share-link goal is stripped before sending, so there is no path for the
 *     model to send a link nobody approved;
 *   - **the length caps** — 500 characters for a message, 150 for a public
 *     comment reply — applied after generation, not trusted to the model.
 */

export interface BrandContext {
  role: string | null;
  brandVoice: string | null;
  guardrails: string[];
  knowledge: string;
  /** Every URL the reply is permitted to contain. */
  allowedLinks: string[];
  pageName: string;
  /** null means "match the sender". */
  fixedLanguage: string | null;
}

export interface GoalDirective {
  type: GoalType;
  /** The tracked short link for a share-link goal. */
  link?: string;
  /** "email" or "phone" for a capture-lead goal. */
  field?: string;
  pageUrl?: string;
}

const replySchema = z.object({
  /** Empty when the model decides it should not answer. */
  reply: z.string().max(1200),
  /** True when it declined — logged as a skip, billed at zero. */
  declined: z.boolean(),
  declineReason: z.string().max(200).optional(),
});

function systemInstruction(brand: BrandContext): string {
  const guardrails = brand.guardrails.length > 0 ? brand.guardrails : [...DEFAULT_GUARDRAILS];

  return [
    `You write short replies on behalf of a business on Facebook Messenger.`,
    brand.role ? `The business: ${brand.role}.` : '',
    brand.brandVoice ? `Write in this voice: ${brand.brandVoice}` : '',
    '',
    'What you know about this business — this is the ONLY source you may answer from:',
    brand.knowledge.trim() || '(nothing recorded yet)',
    '',
    'Rules from the business owner:',
    ...guardrails.map((g) => `- ${g}`),
    '',
    'Rules you must follow regardless:',
    ...SYSTEM_GUARDRAILS.map((g) => `- ${g}`),
    '',
    brand.allowedLinks.length > 0
      ? `The only URLs you may ever include:\n${brand.allowedLinks.map((l) => `- ${l}`).join('\n')}`
      : 'You may not include any URL. None have been approved.',
    '',
    `Hard limits:`,
    `- Under ${AI_LIMITS.maxReplyChars} characters. Shorter is better.`,
    `- No markdown, no bullet lists, no headings. This is a chat message.`,
    `- If the answer is not in what you know, do not guess. Say the team will confirm, and set declined to false — that is still a useful reply.`,
    `- If you cannot say anything useful and honest at all, set declined to true and leave reply empty.`,
    brand.fixedLanguage
      ? `- Always write in ${brand.fixedLanguage}.`
      : `- Write in the same language and script the person used. If they wrote Roman Urdu, reply in Roman Urdu.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function goalLine(goal: GoalDirective | null): string {
  if (!goal) return '';

  switch (goal.type) {
    case 'share_link':
      return goal.link
        ? `\nIf it fits naturally, point them to this link: ${goal.link}. Do not force it.`
        : '';
    case 'capture_lead':
      return `\nIf it fits naturally, ask for their ${goal.field ?? 'email'} so the team can follow up. Ask once, politely, and only if it makes sense here.`;
    case 'grow_followers':
      return `\nIf it fits naturally, invite them to follow the Page for updates. One short line at most.`;
    default:
      return '';
  }
}

export async function generateReply(input: {
  brand: BrandContext;
  label: MessageLabel;
  language: string;
  message: string;
  recentTurns: Array<{ role: 'contact' | 'business'; text: string }>;
  goal: GoalDirective | null;
  contactFirstName?: string | null;
}): Promise<{
  reply: string | null;
  declineReason: string | null;
  usage: { model: string; promptTokens: number; outputTokens: number };
}> {
  const history = input.recentTurns
    .slice(-AI_LIMITS.threadContextTurns)
    .map((t) => `${t.role === 'contact' ? 'Them' : 'Us'}: ${t.text}`)
    .join('\n');

  const prompt = [
    `This message was classified as: ${input.label.replace(/_/g, ' ')}.`,
    input.contactFirstName ? `Their first name is ${input.contactFirstName}.` : '',
    history ? `\nRecent conversation:\n${history}` : '',
    `\nTheir latest message:\n"""${input.message.slice(0, 1500)}"""`,
    goalLine(input.goal),
    `\nWrite the reply.`,
  ]
    .filter(Boolean)
    .join('\n');

  const { data, usage } = await generateStructured(
    prompt,
    replySchema,
    responseSchema.object(
      {
        reply: responseSchema.string('The message to send, or empty if declining'),
        declined: responseSchema.boolean('True if you should not reply at all'),
        declineReason: responseSchema.string('Why, if declined'),
      },
      ['reply', 'declined'],
    ),
    {
      tier: 'standard',
      systemInstruction: systemInstruction(input.brand),
      temperature: 0.6,
      maxOutputTokens: 512,
    },
  );

  if (data.declined || !data.reply.trim()) {
    return {
      reply: null,
      declineReason: data.declineReason ?? 'The model had nothing useful to say.',
      usage,
    };
  }

  const cleaned = enforceLinkPolicy(
    tidy(data.reply, AI_LIMITS.maxReplyChars),
    input.brand.allowedLinks,
  );

  if (!cleaned.trim()) {
    return { reply: null, declineReason: 'Reply was empty after link filtering.', usage };
  }

  return { reply: cleaned, declineReason: null, usage };
}

// ─── Public comment replies ──────────────────────────────────────────────────

const commentReplySchema = z.object({
  reply: z.string().max(400),
  declined: z.boolean(),
});

/**
 * A public reply. Never contains a link — links travel by private message only,
 * where they can be tracked and where they do not read as spam under a post.
 */
export async function generateCommentReply(input: {
  brand: BrandContext;
  comment: string;
  language: string;
  postContext?: string;
  /** True when a private message with the link is going out alongside this. */
  pairedWithPrivateReply: boolean;
}): Promise<{
  reply: string | null;
  usage: { model: string; promptTokens: number; outputTokens: number };
}> {
  const instruction = [
    systemInstruction({ ...input.brand, allowedLinks: [] }),
    '',
    'This is a PUBLIC reply under a comment, visible to everyone.',
    `- Under ${AI_LIMITS.maxCommentReplyChars} characters. One or two sentences.`,
    '- Never include a URL, a phone number, or an email address in a public reply.',
    '- Sound like a person, not a support macro.',
    input.pairedWithPrivateReply
      ? '- A private message with the details is being sent to them at the same time, so point them to their inbox in a natural way.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const prompt = [
    input.postContext ? `The post: ${input.postContext.slice(0, 400)}` : '',
    `Their comment:\n"""${input.comment.slice(0, 800)}"""`,
    `\nWrite the public reply.`,
  ]
    .filter(Boolean)
    .join('\n');

  const { data, usage } = await generateStructured(
    prompt,
    commentReplySchema,
    responseSchema.object(
      {
        reply: responseSchema.string('The public reply'),
        declined: responseSchema.boolean('True if you should not reply'),
      },
      ['reply', 'declined'],
    ),
    {
      tier: 'standard',
      systemInstruction: instruction,
      temperature: 0.7,
      maxOutputTokens: 256,
    },
  );

  if (data.declined || !data.reply.trim()) {
    return { reply: null, usage };
  }

  // Strip every URL unconditionally. A public reply carrying a link is the one
  // thing this feature must never do.
  const cleaned = tidy(data.reply, AI_LIMITS.maxCommentReplyChars).replace(
    /https?:\/\/\S+|www\.\S+/gi,
    '',
  );

  return { reply: cleaned.trim() || null, usage };
}

// ─── Voice drafting ──────────────────────────────────────────────────────────

/** Drafts the brand-voice paragraph from a one-line role. Always editable after. */
export async function generateBrandVoice(role: string): Promise<string> {
  const { text } = await generateText(
    `Write one short paragraph — 2 to 3 sentences, under 350 characters — describing how this business should sound when replying to customers on Facebook Messenger.

The business: ${role}

Write it as an instruction to whoever is replying ("Be warm and direct. Use short sentences..."). Do not use bullet points. Do not mention AI or automation.`,
    { tier: 'fast', temperature: 0.8, maxOutputTokens: 256 },
  );

  return tidy(text, 400);
}

// ─── Output hygiene ──────────────────────────────────────────────────────────

/**
 * Trims to a sentence boundary rather than mid-word. A reply cut off at
 * character 500 reads as broken; one that stops at the last full sentence
 * reads as brief.
 */
function tidy(text: string, limit: number): string {
  const cleaned = text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (cleaned.length <= limit) return cleaned;

  const truncated = cleaned.slice(0, limit);
  const lastStop = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? '),
    truncated.lastIndexOf('\n'),
  );

  if (lastStop > limit * 0.5) return truncated.slice(0, lastStop + 1).trim();
  return `${truncated.slice(0, truncated.lastIndexOf(' ')).trim()}…`;
}

/**
 * The allowed-links list, enforced.
 *
 * Any URL the model produced that is not on the list is removed. This runs
 * after generation precisely because the prompt cannot be trusted to hold —
 * there is no path for a URL nobody approved to reach a customer.
 */
export function enforceLinkPolicy(text: string, allowedLinks: string[]): string {
  const allowed = new Set(allowedLinks.map(normaliseUrl));

  return text
    .replace(/https?:\/\/\S+|www\.\S+/gi, (match) => {
      // Trailing punctuation is part of the sentence, not the URL.
      const trailing = match.match(/[.,!?)\]]+$/)?.[0] ?? '';
      const url = trailing ? match.slice(0, -trailing.length) : match;
      return allowed.has(normaliseUrl(url)) ? match : trailing;
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normaliseUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}
