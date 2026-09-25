import { z } from 'zod';

/**
 * The automation schema: what fires an automation (trigger) and what it does
 * (an ordered step tree). Shared verbatim by the builder UI and the runtime
 * executor so a saved automation can never mean two different things.
 */

// ─── Keyword matching ────────────────────────────────────────────────────────

export const keywordMatchModeSchema = z.enum([
  'contains', // default: the message contains the word anywhere
  'exact', // the whole message is the keyword
  'starts_with',
  'any', // no keyword filter — fire on every matching event
]);
export type KeywordMatchMode = z.infer<typeof keywordMatchModeSchema>;

export const keywordRuleSchema = z.object({
  mode: keywordMatchModeSchema.default('contains'),
  /** Comma-separated in the UI, normalised to lowercase here. */
  keywords: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  /** Never fire when one of these appears. */
  excludeKeywords: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
});
export type KeywordRule = z.infer<typeof keywordRuleSchema>;

// ─── Triggers ────────────────────────────────────────────────────────────────

export const TRIGGER_TYPES = [
  'comment', // someone comments on a Page post / video / Reel
  'story_reply', // text reply to a Page story
  'story_reaction', // emoji reaction to a Page story
  'story_mention', // someone mentions the Page in their own story
  'dm_keyword', // inbound Messenger message matching a keyword
  'ice_breaker', // a native Messenger ice breaker chip was tapped
  'welcome', // the Get Started button / first-ever message
] as const;
export const triggerTypeSchema = z.enum(TRIGGER_TYPES);
export type TriggerType = z.infer<typeof triggerTypeSchema>;

/** Which posts a comment automation watches. */
export const postScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('specific'), postIds: z.array(z.string()).min(1).max(50) }),
  /** Every post, including ones published after the automation goes live. */
  z.object({ kind: z.literal('all_posts') }),
  /** The next post published on this Page, then pins itself to it. */
  z.object({ kind: z.literal('next_post'), resolvedPostId: z.string().nullable().default(null) }),
]);
export type PostScope = z.infer<typeof postScopeSchema>;

export const commentTriggerSchema = z.object({
  type: z.literal('comment'),
  scope: postScopeSchema,
  keywords: keywordRuleSchema,
  /** Also post a public reply under the comment. */
  publicReply: z
    .object({
      enabled: z.boolean().default(false),
      /** Rotated at random so 400 replies don't read like one bot. */
      variants: z.array(z.string().trim().min(1).max(280)).max(20).default([]),
    })
    .default({ enabled: false, variants: [] }),
  /** Skip comments left by the Page itself. Always on; surfaced for clarity. */
  ignoreOwnComments: z.literal(true).default(true),
  /** Only reply once per commenter per post. */
  oncePerCommenterPerPost: z.boolean().default(true),
});

export const storyReplyTriggerSchema = z.object({
  type: z.literal('story_reply'),
  keywords: keywordRuleSchema,
  /** `null` = every story from this Page. */
  storyIds: z.array(z.string()).max(50).nullable().default(null),
});

export const storyReactionTriggerSchema = z.object({
  type: z.literal('story_reaction'),
  storyIds: z.array(z.string()).max(50).nullable().default(null),
  /** `null` = any emoji. */
  reactions: z.array(z.string()).max(20).nullable().default(null),
});

export const storyMentionTriggerSchema = z.object({
  type: z.literal('story_mention'),
});

export const dmKeywordTriggerSchema = z.object({
  type: z.literal('dm_keyword'),
  keywords: keywordRuleSchema,
  /** Fire only on the contact's first ever message, or on every match. */
  firstMessageOnly: z.boolean().default(false),
});

export const iceBreakerTriggerSchema = z.object({
  type: z.literal('ice_breaker'),
  /** The question text shown as a tappable chip in Messenger. */
  question: z.string().trim().min(1).max(80),
  /** Stable payload sent back on tap; generated on save. */
  payload: z.string().min(1).max(1000),
  locale: z.string().default('default'),
});

export const welcomeTriggerSchema = z.object({
  type: z.literal('welcome'),
});

export const triggerSchema = z.discriminatedUnion('type', [
  commentTriggerSchema,
  storyReplyTriggerSchema,
  storyReactionTriggerSchema,
  storyMentionTriggerSchema,
  dmKeywordTriggerSchema,
  iceBreakerTriggerSchema,
  welcomeTriggerSchema,
]);
export type Trigger = z.infer<typeof triggerSchema>;

// ─── Message building blocks ─────────────────────────────────────────────────

export const MAX_BUTTONS_PER_MESSAGE = 3;
export const MAX_CAROUSEL_CARDS = 10;
export const MAX_BUTTONS_PER_CARD = 3;
/** Messenger hard limit on a text message body. */
export const MAX_MESSAGE_TEXT = 2000;

/**
 * A button. `url` buttons are minted as tracked short links at publish time;
 * `postback` buttons drive the runtime (gate unlocks, quick choices).
 */
export const buttonSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    label: z.string().trim().min(1).max(20),
    url: z.string().url(),
    /** Filled in by the API when the automation is published. */
    shortLinkId: z.string().nullable().default(null),
  }),
  z.object({
    kind: z.literal('postback'),
    label: z.string().trim().min(1).max(20),
    payload: z.string().min(1).max(1000),
  }),
]);
export type Button = z.infer<typeof buttonSchema>;

export const quickReplySchema = z.object({
  label: z.string().trim().min(1).max(20),
  payload: z.string().min(1).max(1000),
});

/**
 * Supported merge fields. Resolved against the contact at send time; an unknown
 * or missing value collapses to a sensible fallback rather than printing `{}`.
 */
export const MERGE_FIELDS = [
  'first_name',
  'last_name',
  'full_name',
  'username',
  'page_name',
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

// ─── Steps ───────────────────────────────────────────────────────────────────

export const STEP_TYPES = [
  'send_message',
  'product_carousel',
  'follow_gate',
  'ask_email',
  'ask_phone',
  'delay',
  'follow_up',
] as const;
export const stepTypeSchema = z.enum(STEP_TYPES);
export type StepType = z.infer<typeof stepTypeSchema>;

const stepBase = { id: z.string().min(1) };

export const sendMessageStepSchema = z.object({
  ...stepBase,
  type: z.literal('send_message'),
  text: z.string().trim().min(1).max(MAX_MESSAGE_TEXT),
  buttons: z.array(buttonSchema).max(MAX_BUTTONS_PER_MESSAGE).default([]),
  quickReplies: z.array(quickReplySchema).max(13).default([]),
  imageUrl: z.string().url().nullable().default(null),
});

export const carouselCardSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(80),
  /** The price / shipping / scarcity line under the title. */
  subtitle: z.string().trim().max(80).default(''),
  imageUrl: z.string().url().nullable().default(null),
  buttons: z.array(buttonSchema).max(MAX_BUTTONS_PER_CARD).default([]),
});
export type CarouselCard = z.infer<typeof carouselCardSchema>;

export const productCarouselStepSchema = z.object({
  ...stepBase,
  type: z.literal('product_carousel'),
  /** Optional lead-in message sent just before the carousel. */
  introText: z.string().trim().max(MAX_MESSAGE_TEXT).default(''),
  cards: z.array(carouselCardSchema).min(1).max(MAX_CAROUSEL_CARDS),
});

/**
 * Follow Gate. Facebook exposes no per-user "is a follower" signal, so the gate
 * is confirmed by tap: the contact opens the Page, comes back, taps the unlock
 * button, and the steps after the gate run. Unlocks are recorded as
 * `self_confirmed` so analytics never overclaim.
 */
export const followGateStepSchema = z.object({
  ...stepBase,
  type: z.literal('follow_gate'),
  gateText: z.string().trim().min(1).max(MAX_MESSAGE_TEXT),
  unlockButtonLabel: z.string().trim().min(1).max(20).default('I followed ✅'),
  /** Shown on the gate message so they can reach the Page in one tap. */
  pageUrl: z.string().url().nullable().default(null),
  /** Skip the gate for contacts already known to engage with the Page. */
  skipForKnownFollowers: z.boolean().default(true),
  /** How long to wait for the tap before giving up, in hours. */
  timeoutHours: z.number().int().min(1).max(20).default(20),
  onTimeout: z
    .discriminatedUnion('action', [
      z.object({ action: z.literal('drop') }),
      z.object({
        action: z.literal('message'),
        text: z.string().trim().min(1).max(MAX_MESSAGE_TEXT),
      }),
      /** Give up on the gate and deliver the rest anyway. */
      z.object({ action: z.literal('unlock') }),
    ])
    .default({ action: 'drop' }),
});

const leadCaptureBase = {
  ...stepBase,
  prompt: z.string().trim().min(1).max(MAX_MESSAGE_TEXT),
  /** Messenger's native chip that fills the value from the profile. */
  useNativeQuickReply: z.boolean().default(true),
  /** Sent once a valid value is parsed. */
  successText: z.string().trim().max(MAX_MESSAGE_TEXT).default(''),
  /** Sent when the reply can't be parsed. */
  retryText: z.string().trim().max(MAX_MESSAGE_TEXT).default(''),
  maxRetries: z.number().int().min(0).max(3).default(1),
  /** Continue the remaining steps even if nothing valid was given. */
  continueOnFailure: z.boolean().default(true),
};

export const askEmailStepSchema = z.object({
  ...leadCaptureBase,
  type: z.literal('ask_email'),
});

export const askPhoneStepSchema = z.object({
  ...leadCaptureBase,
  type: z.literal('ask_phone'),
  /** ISO-3166 alpha-2 used to interpret numbers typed without a country code. */
  defaultCountry: z.string().length(2).default('PK'),
});

export const delayStepSchema = z.object({
  ...stepBase,
  type: z.literal('delay'),
  seconds: z.number().int().min(1).max(60 * 60 * 20),
});

/**
 * The follow-up nudge. One reminder, never a drip. Cancels itself if the
 * contact replies or clicks — re-checked at send time, not only at schedule
 * time. Capped at 20h so it always lands inside Messenger's 24h window.
 */
export const followUpStepSchema = z.object({
  ...stepBase,
  type: z.literal('follow_up'),
  delayMinutes: z.number().int().min(30).max(20 * 60).default(60),
  text: z.string().trim().min(1).max(MAX_MESSAGE_TEXT),
  /** Re-attach the original link so they don't have to scroll back. */
  resendButtons: z.boolean().default(true),
  buttons: z.array(buttonSchema).max(MAX_BUTTONS_PER_MESSAGE).default([]),
});

export const stepSchema = z.discriminatedUnion('type', [
  sendMessageStepSchema,
  productCarouselStepSchema,
  followGateStepSchema,
  askEmailStepSchema,
  askPhoneStepSchema,
  delayStepSchema,
  followUpStepSchema,
]);
export type Step = z.infer<typeof stepSchema>;

// ─── The automation ──────────────────────────────────────────────────────────

export const AUTOMATION_STATUSES = ['draft', 'live', 'paused'] as const;
export const automationStatusSchema = z.enum(AUTOMATION_STATUSES);
export type AutomationStatus = z.infer<typeof automationStatusSchema>;

export const automationDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1).max(25),
});
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;

// ─── Structural validation the zod schema can't express ──────────────────────

export interface DefinitionIssue {
  path: string;
  message: string;
}

/**
 * Rules that depend on how the steps relate to each other. Run on save and
 * again on publish; the builder surfaces these inline.
 */
export function validateDefinition(def: AutomationDefinition): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];

  const ids = new Set<string>();
  def.steps.forEach((step, i) => {
    if (ids.has(step.id)) {
      issues.push({ path: `steps.${i}.id`, message: 'Duplicate step id.' });
    }
    ids.add(step.id);
  });

  const followUps = def.steps.filter((s) => s.type === 'follow_up');
  if (followUps.length > 1) {
    issues.push({
      path: 'steps',
      message: 'An automation can have at most one follow-up nudge.',
    });
  }
  if (followUps.length === 1 && def.steps.at(-1)?.type !== 'follow_up') {
    issues.push({
      path: 'steps',
      message: 'The follow-up nudge must be the last step.',
    });
  }

  const gates = def.steps.filter((s) => s.type === 'follow_gate');
  if (gates.length > 1) {
    issues.push({ path: 'steps', message: 'Only one Follow Gate per automation.' });
  }
  const gateIndex = def.steps.findIndex((s) => s.type === 'follow_gate');
  if (gateIndex !== -1 && gateIndex === def.steps.length - 1) {
    issues.push({
      path: `steps.${gateIndex}`,
      message: 'Add at least one step after the Follow Gate — that is what the gate unlocks.',
    });
  }

  /**
   * The first step must be something we can actually send as the opening
   * message. On the comment → DM path that first step *is* the private reply
   * that opens the thread, so it has to be a message, not a question or a gate.
   * It is also just better design: say something before you ask for something.
   */
  const first = def.steps[0];
  if (first && first.type !== 'send_message' && first.type !== 'product_carousel') {
    issues.push({
      path: 'steps.0',
      message: 'Start with a message or a product carousel — that is the first thing they receive.',
    });
  }

  const deliversSomething = def.steps.some(
    (s) => s.type === 'send_message' || s.type === 'product_carousel',
  );
  if (!deliversSomething) {
    issues.push({ path: 'steps', message: 'Add a message or a product carousel to send.' });
  }

  if (def.trigger.type === 'comment' && def.trigger.publicReply.enabled) {
    if (def.trigger.publicReply.variants.length === 0) {
      issues.push({
        path: 'trigger.publicReply.variants',
        message: 'Add at least one public reply variant.',
      });
    }
  }

  if (def.trigger.type === 'comment' || def.trigger.type === 'dm_keyword') {
    const rule = def.trigger.keywords;
    if (rule.mode !== 'any' && rule.keywords.length === 0) {
      issues.push({
        path: 'trigger.keywords',
        message: 'Add at least one keyword, or switch the match mode to "any".',
      });
    }
  }

  return issues;
}

/** Every URL button in a definition, with a stable address for attribution. */
export function collectLinks(def: AutomationDefinition): Array<{
  stepId: string;
  cardId: string | null;
  buttonIndex: number;
  url: string;
}> {
  const links: Array<{ stepId: string; cardId: string | null; buttonIndex: number; url: string }> =
    [];
  for (const step of def.steps) {
    if (step.type === 'send_message' || step.type === 'follow_up') {
      step.buttons.forEach((b, i) => {
        if (b.kind === 'url') {
          links.push({ stepId: step.id, cardId: null, buttonIndex: i, url: b.url });
        }
      });
    }
    if (step.type === 'product_carousel') {
      for (const card of step.cards) {
        card.buttons.forEach((b, i) => {
          if (b.kind === 'url') {
            links.push({ stepId: step.id, cardId: card.id, buttonIndex: i, url: b.url });
          }
        });
      }
    }
  }
  return links;
}
