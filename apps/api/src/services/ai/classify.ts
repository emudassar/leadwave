import { z } from 'zod';
import {
  COMMENT_LABELS,
  MESSAGE_LABELS,
  type CommentLabel,
  type MessageLabel,
} from '@leadwave/shared';
import { generateStructured, responseSchema } from './gemini.js';

/**
 * The intent gate.
 *
 * Nothing is ever written before a message has been classified. That ordering
 * is the whole design: it means a greeting, a friend's banter or a spam blast
 * costs nothing at all, and only genuine questions, buying intent and support
 * issues ever reach the generator.
 *
 * Classification is free — skips are logged in full and billed at zero — so
 * this runs on the cheap model with a single retry.
 */

const messageSchema = z.object({
  label: z.enum(MESSAGE_LABELS),
  confidence: z.number().min(0).max(1),
  /** Short justification, shown verbatim in the activity feed. */
  reason: z.string().max(200),
  /** BCP-47-ish tag the reply should be written in. */
  language: z.string().max(40),
});

export type MessageClassification = z.infer<typeof messageSchema>;

const MESSAGE_INSTRUCTION = `You classify inbound Facebook Messenger messages for a business.

Return exactly one label:
- greeting_only: just "hi", "hello", an emoji, or a wave with no question.
- friend_chat: casual banter, compliments, or personal chat with no request.
- question: a genuine question about the business, its products, hours, process or availability.
- buy_intent: they want to buy, book, order, or are asking about price or how to pay.
- support_issue: an existing customer with a problem — a late order, a complaint, something broken.
- spam_or_abuse: promotional spam, scams, harassment, or abuse.
- other: anything that fits none of the above.

Rules:
- Judge only what the latest message asks for. Prior turns are context, not the subject.
- A greeting attached to a real question is a question, not greeting_only.
- Anger about a product they already bought is support_issue, not spam_or_abuse.
- "language" is the language the LATEST message is written in, e.g. "English", "Urdu", "Hinglish", "Roman Urdu", "Spanish". Report the script actually used: a Hindi sentence typed in Latin letters is "Hinglish".
- Be conservative. When genuinely unsure between a replyable label and a non-replyable one, choose the non-replyable one — staying quiet is cheaper than a wrong reply.`;

export async function classifyMessage(input: {
  text: string;
  recentTurns?: Array<{ role: 'contact' | 'business'; text: string }>;
  businessContext?: string;
}): Promise<{ classification: MessageClassification; usage: { model: string } }> {
  const history = (input.recentTurns ?? [])
    .slice(-6)
    .map((t) => `${t.role === 'contact' ? 'Them' : 'Us'}: ${t.text}`)
    .join('\n');

  const prompt = [
    input.businessContext ? `The business: ${input.businessContext}` : '',
    history ? `Recent conversation:\n${history}` : '',
    `Latest message to classify:\n"""${input.text.slice(0, 2000)}"""`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const { data, usage } = await generateStructured(
    prompt,
    messageSchema,
    responseSchema.object(
      {
        label: responseSchema.enum(MESSAGE_LABELS),
        confidence: responseSchema.number('0 to 1'),
        reason: responseSchema.string('One short sentence'),
        language: responseSchema.string('Language of the latest message'),
      },
      ['label', 'confidence', 'reason', 'language'],
    ),
    {
      tier: 'fast',
      systemInstruction: MESSAGE_INSTRUCTION,
      temperature: 0,
      maxOutputTokens: 256,
      retries: 1,
    },
  );

  return { classification: data, usage };
}

// ─── Comments ────────────────────────────────────────────────────────────────

const commentSchema = z.object({
  label: z.enum(COMMENT_LABELS),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(200),
  language: z.string().max(40),
  /** Whether this comment wants a link, which routes it to a private reply. */
  hasBuyIntent: z.boolean(),
});

export type CommentClassification = z.infer<typeof commentSchema>;

const COMMENT_INSTRUCTION = `You classify public comments on a business's Facebook post.

Return exactly one label:
- emoji_only: only emoji, or a single word like "nice", "wow", "🔥".
- tag_a_friend: mostly an @mention or a name, tagging someone else.
- negative: criticism, an insult, or an attempt to start an argument.
- spam: promotion, scams, "check my page", bot output.
- substantive: a real question, a request for details, or a reaction with actual words worth answering.

Rules:
- Only substantive comments get a public reply. Everything else is skipped, which costs nothing.
- Never label a complaint as spam. Negative is negative — and negative is never replied to either, so the business is not baited into a public argument.
- Set hasBuyIntent to true when they ask for a price, a link, where to buy, or how to order. Those are answered with a short public nudge and a private message carrying the link.
- "language" is the language the comment is written in; report the script actually used.`;

export async function classifyComment(input: {
  text: string;
  postContext?: string;
  businessContext?: string;
}): Promise<{ classification: CommentClassification; usage: { model: string } }> {
  const prompt = [
    input.businessContext ? `The business: ${input.businessContext}` : '',
    input.postContext ? `The post they commented on: ${input.postContext.slice(0, 500)}` : '',
    `Comment to classify:\n"""${input.text.slice(0, 1000)}"""`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const { data, usage } = await generateStructured(
    prompt,
    commentSchema,
    responseSchema.object(
      {
        label: responseSchema.enum(COMMENT_LABELS),
        confidence: responseSchema.number('0 to 1'),
        reason: responseSchema.string('One short sentence'),
        language: responseSchema.string('Language of the comment'),
        hasBuyIntent: responseSchema.boolean('Do they want a price or a link?'),
      },
      ['label', 'confidence', 'reason', 'language', 'hasBuyIntent'],
    ),
    {
      tier: 'fast',
      systemInstruction: COMMENT_INSTRUCTION,
      temperature: 0,
      maxOutputTokens: 256,
      retries: 1,
    },
  );

  return { classification: data, usage };
}

export type { CommentLabel, MessageLabel };
