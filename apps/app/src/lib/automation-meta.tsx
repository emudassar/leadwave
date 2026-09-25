/**
 * How each trigger and step is labelled, coloured and explained.
 *
 * Kept away from the screens because the same trigger appears in the list, the
 * builder, the home page and the AI activity log, and it has to read the same
 * way in all four. The copy here is the product's voice: what it does for the
 * person, not what it is called in the Graph API.
 */
import {
  AtSign,
  Clock,
  Hand,
  Images,
  Mail,
  MessageCircle,
  MessageSquareText,
  Phone,
  Radio,
  Send,
  Smile,
  Sparkles,
  Timer,
  Zap,
} from 'lucide-react';
import type { Feature, StepType } from '@leadwave/shared';
import type { TriggerType } from '@/types';

export interface TriggerMeta {
  label: string;
  short: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  tint: string;
  feature: Feature;
}

export const TRIGGER_META: Record<TriggerType, TriggerMeta> = {
  comment: {
    label: 'Comment on a post',
    short: 'Comment',
    description:
      'Someone comments your keyword under a post, Reel or video. You reply publicly and send the real thing in their inbox.',
    icon: MessageCircle,
    tint: 'bg-brand-600/12 text-brand-600 dark:text-brand-300',
    feature: 'trigger_comment',
  },
  story_reply: {
    label: 'Reply to a story',
    short: 'Story reply',
    description: 'Someone replies to your Page story. Works on every story, or only the ones you pick.',
    icon: MessageSquareText,
    tint: 'bg-violet-500/12 text-violet-600 dark:text-violet-300',
    feature: 'trigger_story',
  },
  story_reaction: {
    label: 'React to a story',
    short: 'Story reaction',
    description: 'An emoji on your story is enough to start the conversation.',
    icon: Smile,
    tint: 'bg-amber-500/12 text-amber-600 dark:text-amber-300',
    feature: 'trigger_story',
  },
  story_mention: {
    label: 'Mention your Page in a story',
    short: 'Story mention',
    description: 'Someone tags your Page in their own story — thank them and send the link.',
    icon: AtSign,
    tint: 'bg-sky-500/12 text-sky-600 dark:text-sky-300',
    feature: 'trigger_story',
  },
  dm_keyword: {
    label: 'Message with a keyword',
    short: 'Keyword DM',
    description:
      'A message containing your keyword gets the right answer back before you have finished reading it.',
    icon: Zap,
    tint: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-300',
    feature: 'trigger_dm_keyword',
  },
  ice_breaker: {
    label: 'Ice breaker tapped',
    short: 'Ice breaker',
    description:
      'The tappable questions Messenger shows before anyone types. The lowest-effort way in.',
    icon: Hand,
    tint: 'bg-violet-500/12 text-violet-600 dark:text-violet-300',
    feature: 'trigger_ice_breaker',
  },
  welcome: {
    label: 'First ever message',
    short: 'Welcome',
    description: 'The Get Started button, and anyone who writes to you for the first time.',
    icon: Radio,
    tint: 'bg-slate-500/12 text-slate-600 dark:text-slate-300',
    feature: 'trigger_dm_keyword',
  },
};

export interface StepMeta {
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  tint: string;
  feature?: Feature;
}

export const STEP_META: Record<StepType, StepMeta> = {
  send_message: {
    label: 'Send a message',
    description: 'Text, an image, and up to three buttons.',
    icon: Send,
    tint: 'bg-brand-600/12 text-brand-600 dark:text-brand-300',
  },
  product_carousel: {
    label: 'Product carousel',
    description: 'Up to ten swipeable cards, each with its own link and its own click count.',
    icon: Images,
    tint: 'bg-violet-500/12 text-violet-600 dark:text-violet-300',
    feature: 'action_product_carousel',
  },
  follow_gate: {
    label: 'Follow Gate',
    description: 'Ask for a follow before you hand over the link.',
    icon: Sparkles,
    tint: 'bg-amber-500/12 text-amber-600 dark:text-amber-300',
    feature: 'action_follow_gate',
  },
  ask_email: {
    label: 'Ask for an email',
    description: 'One tap on their profile email, captured and attributed.',
    icon: Mail,
    tint: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-300',
    feature: 'action_lead_capture_email',
  },
  ask_phone: {
    label: 'Ask for a phone number',
    description: 'Same, for a number. Parsed and normalised before it is saved.',
    icon: Phone,
    tint: 'bg-teal-500/12 text-teal-600 dark:text-teal-300',
    feature: 'action_lead_capture_phone',
  },
  delay: {
    label: 'Wait',
    description: 'A pause, so two messages do not land on top of each other.',
    icon: Timer,
    tint: 'bg-slate-500/12 text-slate-600 dark:text-slate-300',
  },
  follow_up: {
    label: 'Follow-up nudge',
    description:
      'One polite reminder if they never opened the link. Cancels itself the moment they reply or tap.',
    icon: Clock,
    tint: 'bg-sky-500/12 text-sky-600 dark:text-sky-300',
    feature: 'action_follow_up',
  },
};

export const STATUS_META: Record<
  'draft' | 'live' | 'paused',
  { label: string; tone: 'neutral' | 'success' | 'warning' }
> = {
  draft: { label: 'Draft', tone: 'neutral' },
  live: { label: 'Live', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
};

/** Which plan a locked capability needs, in words a person can act on. */
export const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  growth: 'Growth',
  business: 'Business',
};
