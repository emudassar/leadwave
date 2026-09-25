/**
 * The automation builder.
 *
 * Left: the trigger and the ordered steps. Right: a phone showing exactly what
 * the contact will receive, updated as you type. The preview is not decoration
 * — it is the only place the three-button limit, a truncated carousel subtitle
 * or a quick reply that reads badly become visible before four hundred people
 * see them.
 *
 * Validation runs through the same `validateDefinition` the API uses, so the
 * builder can never let you save something the server will reject, and can
 * never block something the server would accept.
 */
import * as React from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Eye,
  GripVertical,
  Info,
  Lock,
  Play,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  MAX_BUTTONS_PER_MESSAGE,
  MAX_CAROUSEL_CARDS,
  MAX_MESSAGE_TEXT,
  STEP_TYPES,
  minimumPlanFor,
  validateDefinition,
  type AutomationDefinition,
  type Button as StepButton,
  type Step,
  type StepType,
  type Trigger,
} from '@leadwave/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, randomId } from '@/lib/utils';
import { PhonePreview, stepsToBubbles } from '@/components/MessengerPreview';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  Select,
  Switch,
  Textarea,
  Tooltip,
} from '@/components/ui';
import { PLAN_LABELS, STEP_META, TRIGGER_META } from '@/lib/automation-meta';
import type { AutomationDetail, TriggerType } from '@/types';

// ─── Defaults ────────────────────────────────────────────────────────────────

function defaultTrigger(type: TriggerType): Trigger {
  const keywords = { mode: 'contains' as const, keywords: [], excludeKeywords: [] };
  switch (type) {
    case 'comment':
      return {
        type: 'comment',
        scope: { kind: 'all_posts' },
        keywords,
        publicReply: { enabled: true, variants: ['Just sent it your way 📩'] },
        ignoreOwnComments: true,
        oncePerCommenterPerPost: true,
      };
    case 'story_reply':
      return { type: 'story_reply', keywords: { ...keywords, mode: 'any' }, storyIds: null };
    case 'story_reaction':
      return { type: 'story_reaction', storyIds: null, reactions: null };
    case 'story_mention':
      return { type: 'story_mention' };
    case 'dm_keyword':
      return { type: 'dm_keyword', keywords, firstMessageOnly: false };
    case 'ice_breaker':
      return {
        type: 'ice_breaker',
        question: 'How much does it cost?',
        payload: randomId('ib'),
        locale: 'default',
      };
    case 'welcome':
    default:
      return { type: 'welcome' };
  }
}

function defaultStep(type: StepType): Step {
  const id = randomId();
  switch (type) {
    case 'send_message':
      return {
        id,
        type: 'send_message',
        text: 'Hey {{first_name}} 👋 here it is:',
        buttons: [],
        quickReplies: [],
        imageUrl: null,
      };
    case 'product_carousel':
      return {
        id,
        type: 'product_carousel',
        introText: '',
        cards: [
          {
            id: randomId('card'),
            title: 'Your product',
            subtitle: 'Price · free shipping',
            imageUrl: null,
            buttons: [],
          },
        ],
      };
    case 'follow_gate':
      return {
        id,
        type: 'follow_gate',
        gateText: 'One quick thing — follow the Page, then tap below and it unlocks 👇',
        unlockButtonLabel: 'I followed ✅',
        pageUrl: null,
        skipForKnownFollowers: true,
        timeoutHours: 20,
        onTimeout: { action: 'unlock' },
      };
    case 'ask_email':
      return {
        id,
        type: 'ask_email',
        prompt: 'Where should I send it? Drop your email below.',
        useNativeQuickReply: true,
        successText: 'Got it — on its way 🎉',
        retryText: "Hmm, that doesn't look like an email. Mind trying again?",
        maxRetries: 1,
        continueOnFailure: true,
      };
    case 'ask_phone':
      return {
        id,
        type: 'ask_phone',
        prompt: 'What number should we use?',
        useNativeQuickReply: true,
        successText: 'Thanks — saved.',
        retryText: "That number didn't come through. One more go?",
        maxRetries: 1,
        continueOnFailure: true,
        defaultCountry: 'PK',
      };
    case 'delay':
      return { id, type: 'delay', seconds: 30 };
    case 'follow_up':
    default:
      return {
        id,
        type: 'follow_up',
        delayMinutes: 90,
        text: "Still thinking it over? Here's that link again 👇",
        resendButtons: true,
        buttons: [],
      };
  }
}

function emptyDefinition(trigger: TriggerType): AutomationDefinition {
  return {
    name: `${TRIGGER_META[trigger].short} automation`,
    trigger: defaultTrigger(trigger),
    steps: [defaultStep('send_message')],
  } as AutomationDefinition;
}

// ─── Keyword chips ───────────────────────────────────────────────────────────

function KeywordInput({
  values,
  onChange,
  placeholder,
  tone = 'brand',
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  tone?: 'brand' | 'danger';
}): React.ReactElement {
  const [draft, setDraft] = React.useState('');

  const commit = () => {
    const parts = draft
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
      .filter((part) => !values.includes(part));
    if (parts.length) onChange([...values, ...parts]);
    setDraft('');
  };

  return (
    <div
      className={cn(
        'flex min-h-9.5 flex-wrap items-center gap-1.5 rounded-md border border-line bg-surface-raised px-2 py-1.5',
        'focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20',
      )}
    >
      {values.map((value) => (
        <span
          key={value}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11.5px]',
            tone === 'brand'
              ? 'bg-brand-600/12 text-brand-600 dark:text-brand-300'
              : 'bg-red-500/12 text-red-600 dark:text-red-300',
          )}
        >
          {value}
          <button
            onClick={() => onChange(values.filter((v) => v !== value))}
            aria-label={`Remove ${value}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Backspace' && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={values.length ? '' : placeholder}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-text-subtle"
      />
    </div>
  );
}

// ─── Button editor ───────────────────────────────────────────────────────────

function ButtonsEditor({
  buttons,
  onChange,
  max = MAX_BUTTONS_PER_MESSAGE,
}: {
  buttons: StepButton[];
  onChange: (buttons: StepButton[]) => void;
  max?: number;
}): React.ReactElement {
  const { can } = useSession();
  const multiAllowed = can('multiple_button_links');
  const effectiveMax = multiAllowed ? max : 1;

  return (
    <div className="space-y-2">
      {buttons.map((button, index) => (
        <div key={index} className="flex gap-2">
          <Input
            value={button.label}
            maxLength={20}
            onChange={(e) => {
              const next = [...buttons];
              next[index] = { ...button, label: e.target.value };
              onChange(next);
            }}
            placeholder="Button text"
            className="w-36 shrink-0"
          />
          <Input
            value={button.kind === 'url' ? button.url : button.payload}
            onChange={(e) => {
              const next = [...buttons];
              next[index] =
                button.kind === 'url'
                  ? { ...button, url: e.target.value }
                  : { ...button, payload: e.target.value };
              onChange(next);
            }}
            placeholder={button.kind === 'url' ? 'https://…' : 'PAYLOAD'}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onChange(buttons.filter((_, i) => i !== index))}
            aria-label="Remove button"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}

      {buttons.length < effectiveMax ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange([...buttons, { kind: 'url', label: 'Open link', url: '', shortLinkId: null }])
          }
        >
          <Plus className="size-3.5" />
          Add a button
        </Button>
      ) : !multiAllowed && buttons.length >= 1 ? (
        <p className="flex items-center gap-1.5 text-[12px] text-text-subtle">
          <Lock className="size-3.5" />
          Three links in one message is a Pro feature.
        </p>
      ) : (
        <p className="text-[12px] text-text-subtle">
          Messenger allows {max} buttons on a message. That is the ceiling, not ours.
        </p>
      )}

      {buttons.length > 0 ? (
        <p className="text-[11.5px] text-text-subtle">
          Every link becomes a tracked short link when you publish, so clicks are
          counted per button.
        </p>
      ) : null}
    </div>
  );
}

// ─── Step editors ────────────────────────────────────────────────────────────

function StepEditor({
  step,
  onChange,
}: {
  step: Step;
  onChange: (step: Step) => void;
}): React.ReactElement {
  switch (step.type) {
    case 'send_message':
      return (
        <div className="space-y-3.5">
          <Field
            label="Message"
            hint={`${step.text.length} / ${MAX_MESSAGE_TEXT} · {{first_name}} and {{page_name}} are filled in at send time.`}
          >
            <Textarea
              value={step.text}
              maxLength={MAX_MESSAGE_TEXT}
              rows={4}
              onChange={(e) => onChange({ ...step, text: e.target.value })}
            />
          </Field>
          <Field label="Image (optional)" hint="A direct link to a JPG or PNG.">
            <Input
              value={step.imageUrl ?? ''}
              placeholder="https://…"
              onChange={(e) => onChange({ ...step, imageUrl: e.target.value || null })}
            />
          </Field>
          <Field label="Buttons">
            <ButtonsEditor
              buttons={step.buttons}
              onChange={(buttons) => onChange({ ...step, buttons })}
            />
          </Field>
          <Field
            label="Quick replies"
            hint="Tappable chips under the message. They vanish once one is tapped."
          >
            <KeywordInput
              values={step.quickReplies.map((q) => q.label)}
              placeholder="Prices, Shipping, Talk to a human…"
              onChange={(labels) =>
                onChange({
                  ...step,
                  quickReplies: labels.map((label) => ({
                    label,
                    payload: label.toUpperCase().replace(/\s+/g, '_').slice(0, 40),
                  })),
                })
              }
            />
          </Field>
        </div>
      );

    case 'product_carousel':
      return (
        <div className="space-y-3.5">
          <Field label="Lead-in message (optional)">
            <Textarea
              value={step.introText}
              rows={2}
              onChange={(e) => onChange({ ...step, introText: e.target.value })}
            />
          </Field>

          <div className="space-y-2.5">
            {step.cards.map((card, index) => (
              <Card key={card.id} className="p-3">
                <div className="mb-2.5 flex items-center justify-between">
                  <p className="text-[12px] font-semibold uppercase tracking-wide text-text-subtle">
                    Card {index + 1}
                  </p>
                  {step.cards.length > 1 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        onChange({ ...step, cards: step.cards.filter((_, i) => i !== index) })
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
                <div className="space-y-2.5">
                  <Input
                    value={card.title}
                    maxLength={80}
                    placeholder="Product name"
                    onChange={(e) => {
                      const cards = [...step.cards];
                      cards[index] = { ...card, title: e.target.value };
                      onChange({ ...step, cards });
                    }}
                  />
                  <Input
                    value={card.subtitle}
                    maxLength={80}
                    placeholder="Rs 4,200 · free shipping"
                    onChange={(e) => {
                      const cards = [...step.cards];
                      cards[index] = { ...card, subtitle: e.target.value };
                      onChange({ ...step, cards });
                    }}
                  />
                  <Input
                    value={card.imageUrl ?? ''}
                    placeholder="Image URL"
                    onChange={(e) => {
                      const cards = [...step.cards];
                      cards[index] = { ...card, imageUrl: e.target.value || null };
                      onChange({ ...step, cards });
                    }}
                  />
                  <ButtonsEditor
                    buttons={card.buttons}
                    max={3}
                    onChange={(buttons) => {
                      const cards = [...step.cards];
                      cards[index] = { ...card, buttons };
                      onChange({ ...step, cards });
                    }}
                  />
                </div>
              </Card>
            ))}
          </div>

          {step.cards.length < MAX_CAROUSEL_CARDS ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                onChange({
                  ...step,
                  cards: [
                    ...step.cards,
                    {
                      id: randomId('card'),
                      title: '',
                      subtitle: '',
                      imageUrl: null,
                      buttons: [],
                    },
                  ],
                })
              }
            >
              <Plus className="size-3.5" />
              Add a card
            </Button>
          ) : null}
        </div>
      );

    case 'follow_gate':
      return (
        <div className="space-y-3.5">
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 p-3 text-[12.5px] leading-relaxed text-text-muted">
            <Info className="mt-px size-4 shrink-0 text-amber-accent" />
            <span>
              Facebook gives no per-person follow signal, so the gate is confirmed by
              tap. Everywhere it appears in your numbers it is labelled{' '}
              <strong className="text-text">self-confirmed</strong> — we would rather
              be honest than flatter you.
            </span>
          </div>
          <Field label="Gate message">
            <Textarea
              value={step.gateText}
              rows={3}
              onChange={(e) => onChange({ ...step, gateText: e.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Unlock button">
              <Input
                value={step.unlockButtonLabel}
                maxLength={20}
                onChange={(e) => onChange({ ...step, unlockButtonLabel: e.target.value })}
              />
            </Field>
            <Field label="Wait for the tap" hint="Capped at 20h to stay inside Messenger's window.">
              <Select
                value={String(step.timeoutHours)}
                onValueChange={(v) => onChange({ ...step, timeoutHours: Number(v) })}
                options={[1, 3, 6, 12, 20].map((h) => ({
                  value: String(h),
                  label: `${h} hour${h === 1 ? '' : 's'}`,
                }))}
              />
            </Field>
          </div>
          <Field label="Page link" hint="So they can reach the Page in one tap.">
            <Input
              value={step.pageUrl ?? ''}
              placeholder="https://facebook.com/yourpage"
              onChange={(e) => onChange({ ...step, pageUrl: e.target.value || null })}
            />
          </Field>
          <Field label="If they never tap">
            <Select
              value={step.onTimeout.action}
              onValueChange={(action) =>
                onChange({
                  ...step,
                  onTimeout:
                    action === 'message'
                      ? { action: 'message', text: 'No worries — here it is anyway 👇' }
                      : { action: action as 'drop' | 'unlock' },
                })
              }
              options={[
                { value: 'unlock', label: 'Send it anyway', description: 'Kinder, and converts better.' },
                { value: 'message', label: 'Send a different message' },
                { value: 'drop', label: 'Give up quietly' },
              ]}
            />
          </Field>
          <label className="flex items-center justify-between gap-3 text-[13px]">
            <span>
              Skip the gate for people who already engage with the Page
              <span className="block text-[12px] text-text-subtle">
                Regulars should not be asked to follow you twice.
              </span>
            </span>
            <Switch
              checked={step.skipForKnownFollowers}
              onCheckedChange={(v) => onChange({ ...step, skipForKnownFollowers: v })}
            />
          </label>
        </div>
      );

    case 'ask_email':
    case 'ask_phone':
      return (
        <div className="space-y-3.5">
          <Field label="What you ask">
            <Textarea
              value={step.prompt}
              rows={2}
              onChange={(e) => onChange({ ...step, prompt: e.target.value })}
            />
          </Field>
          <Field label="After they answer">
            <Input
              value={step.successText}
              onChange={(e) => onChange({ ...step, successText: e.target.value })}
            />
          </Field>
          <Field label="If you can't read it" hint={`Asked again up to ${step.maxRetries} time(s).`}>
            <Input
              value={step.retryText}
              onChange={(e) => onChange({ ...step, retryText: e.target.value })}
            />
          </Field>
          <label className="flex items-center justify-between gap-3 text-[13px]">
            <span>
              Use Messenger's one-tap chip
              <span className="block text-[12px] text-text-subtle">
                Fills the value straight from their profile — far higher completion than typing.
              </span>
            </span>
            <Switch
              checked={step.useNativeQuickReply}
              onCheckedChange={(v) => onChange({ ...step, useNativeQuickReply: v })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-[13px]">
            <span>
              Carry on if they don't give one
              <span className="block text-[12px] text-text-subtle">
                They still get everything after this step.
              </span>
            </span>
            <Switch
              checked={step.continueOnFailure}
              onCheckedChange={(v) => onChange({ ...step, continueOnFailure: v })}
            />
          </label>
        </div>
      );

    case 'delay':
      return (
        <Field label="Wait for" hint="Long enough that two messages don't land on top of each other.">
          <Select
            value={String(step.seconds)}
            onValueChange={(v) => onChange({ ...step, seconds: Number(v) })}
            options={[
              { value: '5', label: '5 seconds' },
              { value: '15', label: '15 seconds' },
              { value: '30', label: '30 seconds' },
              { value: '60', label: '1 minute' },
              { value: '300', label: '5 minutes' },
              { value: '1800', label: '30 minutes' },
              { value: '3600', label: '1 hour' },
            ]}
          />
        </Field>
      );

    case 'follow_up':
      return (
        <div className="space-y-3.5">
          <div className="flex items-start gap-2 rounded-lg border border-sky-500/25 bg-sky-500/8 p-3 text-[12.5px] leading-relaxed text-text-muted">
            <Info className="mt-px size-4 shrink-0 text-sky-500" />
            <span>
              One nudge, never a drip. It cancels itself the moment they reply or tap —
              and that is re-checked at send time, not only when it was scheduled.
            </span>
          </div>
          <Field label="Send it after">
            <Select
              value={String(step.delayMinutes)}
              onValueChange={(v) => onChange({ ...step, delayMinutes: Number(v) })}
              options={[
                { value: '30', label: '30 minutes' },
                { value: '60', label: '1 hour' },
                { value: '90', label: '90 minutes' },
                { value: '180', label: '3 hours' },
                { value: '360', label: '6 hours' },
                { value: '720', label: '12 hours' },
                { value: '1200', label: '20 hours (the maximum)' },
              ]}
            />
          </Field>
          <Field label="The nudge">
            <Textarea
              value={step.text}
              rows={3}
              onChange={(e) => onChange({ ...step, text: e.target.value })}
            />
          </Field>
          <label className="flex items-center justify-between gap-3 text-[13px]">
            <span>
              Re-attach the original link
              <span className="block text-[12px] text-text-subtle">
                So they don't have to scroll back to find it.
              </span>
            </span>
            <Switch
              checked={step.resendButtons}
              onCheckedChange={(v) => onChange({ ...step, resendButtons: v })}
            />
          </label>
        </div>
      );

    default:
      return <p className="text-[13px] text-text-muted">Nothing to configure.</p>;
  }
}

// ─── Trigger editor ──────────────────────────────────────────────────────────

function TriggerEditor({
  trigger,
  onChange,
}: {
  trigger: Trigger;
  onChange: (trigger: Trigger) => void;
}): React.ReactElement {
  const keywordFields =
    trigger.type === 'comment' || trigger.type === 'dm_keyword' || trigger.type === 'story_reply';

  return (
    <div className="space-y-3.5">
      {trigger.type === 'comment' ? (
        <Field label="Which posts" hint="“Every post” covers ones you publish later, too.">
          <Select
            value={trigger.scope.kind}
            onValueChange={(kind) =>
              onChange({
                ...trigger,
                scope:
                  kind === 'specific'
                    ? { kind: 'specific', postIds: [] }
                    : kind === 'next_post'
                      ? { kind: 'next_post', resolvedPostId: null }
                      : { kind: 'all_posts' },
              })
            }
            options={[
              { value: 'all_posts', label: 'Every post', description: 'Including future ones.' },
              {
                value: 'next_post',
                label: 'The next post I publish',
                description: 'Pins itself to it as soon as it goes up.',
              },
              { value: 'specific', label: 'Specific posts' },
            ]}
          />
        </Field>
      ) : null}

      {trigger.type === 'comment' && trigger.scope.kind === 'specific' ? (
        <Field label="Post IDs" hint="Paste the numeric ids of the posts to watch.">
          <KeywordInput
            values={trigger.scope.postIds}
            placeholder="123456789_987654321"
            onChange={(postIds) => onChange({ ...trigger, scope: { kind: 'specific', postIds } })}
          />
        </Field>
      ) : null}

      {keywordFields && 'keywords' in trigger ? (
        <>
          <Field label="Match">
            <Select
              value={trigger.keywords.mode}
              onValueChange={(mode) =>
                onChange({
                  ...trigger,
                  keywords: { ...trigger.keywords, mode: mode as 'contains' },
                } as Trigger)
              }
              options={[
                { value: 'contains', label: 'Contains the word', description: 'The forgiving default.' },
                { value: 'exact', label: 'Is exactly the word' },
                { value: 'starts_with', label: 'Starts with the word' },
                { value: 'any', label: 'Anything at all', description: 'No keyword filter.' },
              ]}
            />
          </Field>

          {trigger.keywords.mode !== 'any' ? (
            <>
              <Field
                label="Keywords"
                hint="Case and punctuation are ignored. Add the misspellings people actually type."
              >
                <KeywordInput
                  values={trigger.keywords.keywords}
                  placeholder="price, pricing, how much…"
                  onChange={(keywords) =>
                    onChange({ ...trigger, keywords: { ...trigger.keywords, keywords } } as Trigger)
                  }
                />
              </Field>
              <Field label="Never fire on" hint="A safety net for words that mean the opposite.">
                <KeywordInput
                  tone="danger"
                  values={trigger.keywords.excludeKeywords}
                  placeholder="refund, complaint…"
                  onChange={(excludeKeywords) =>
                    onChange({
                      ...trigger,
                      keywords: { ...trigger.keywords, excludeKeywords },
                    } as Trigger)
                  }
                />
              </Field>
            </>
          ) : null}
        </>
      ) : null}

      {trigger.type === 'comment' ? (
        <>
          <label className="flex items-center justify-between gap-3 border-t border-line pt-3.5 text-[13px]">
            <span>
              Also reply publicly under the comment
              <span className="block text-[12px] text-text-subtle">
                Other people see you answering. That is half the point.
              </span>
            </span>
            <Switch
              checked={trigger.publicReply.enabled}
              onCheckedChange={(enabled) =>
                onChange({ ...trigger, publicReply: { ...trigger.publicReply, enabled } })
              }
            />
          </label>

          {trigger.publicReply.enabled ? (
            <Field
              label="Public replies"
              hint="Picked at random, so four hundred replies don't read like one bot."
            >
              <div className="space-y-2">
                {trigger.publicReply.variants.map((variant, index) => (
                  <div key={index} className="flex gap-2">
                    <Input
                      value={variant}
                      maxLength={280}
                      onChange={(e) => {
                        const variants = [...trigger.publicReply.variants];
                        variants[index] = e.target.value;
                        onChange({ ...trigger, publicReply: { ...trigger.publicReply, variants } });
                      }}
                    />
                    {trigger.publicReply.variants.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          onChange({
                            ...trigger,
                            publicReply: {
                              ...trigger.publicReply,
                              variants: trigger.publicReply.variants.filter((_, i) => i !== index),
                            },
                          })
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                ))}
                {trigger.publicReply.variants.length < 20 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      onChange({
                        ...trigger,
                        publicReply: {
                          ...trigger.publicReply,
                          variants: [...trigger.publicReply.variants, ''],
                        },
                      })
                    }
                  >
                    <Plus className="size-3.5" />
                    Add a variant
                  </Button>
                ) : null}
              </div>
            </Field>
          ) : null}

          <label className="flex items-center justify-between gap-3 text-[13px]">
            <span>
              Only once per person, per post
              <span className="block text-[12px] text-text-subtle">
                Leave this on unless you enjoy complaints.
              </span>
            </span>
            <Switch
              checked={trigger.oncePerCommenterPerPost}
              onCheckedChange={(v) => onChange({ ...trigger, oncePerCommenterPerPost: v })}
            />
          </label>
        </>
      ) : null}

      {trigger.type === 'dm_keyword' ? (
        <label className="flex items-center justify-between gap-3 border-t border-line pt-3.5 text-[13px]">
          <span>
            Only on their very first message
            <span className="block text-[12px] text-text-subtle">
              Useful for a welcome flow you don't want repeating.
            </span>
          </span>
          <Switch
            checked={trigger.firstMessageOnly}
            onCheckedChange={(v) => onChange({ ...trigger, firstMessageOnly: v })}
          />
        </label>
      ) : null}

      {trigger.type === 'ice_breaker' ? (
        <Field
          label="The question"
          hint="Shown as a tappable chip before anyone has typed a word. Max 80 characters."
        >
          <Input
            value={trigger.question}
            maxLength={80}
            onChange={(e) => onChange({ ...trigger, question: e.target.value })}
          />
        </Field>
      ) : null}

      {trigger.type === 'welcome' || trigger.type === 'story_mention' ? (
        <p className="text-[13px] leading-relaxed text-text-muted">
          {TRIGGER_META[trigger.type].description} Nothing to configure — add the
          messages below.
        </p>
      ) : null}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function AutomationBuilderPage(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeAccountId, activeAccount, me, can } = useSession();

  const isNew = !id;
  const initialTrigger = (params.get('trigger') as TriggerType | null) ?? 'comment';

  const existing = useQuery({
    queryKey: ['automation', id],
    queryFn: () => api.get<AutomationDetail>(`/automations/${id}`),
    enabled: Boolean(id),
  });

  const [definition, setDefinition] = React.useState<AutomationDefinition | null>(
    isNew ? emptyDefinition(initialTrigger) : null,
  );
  const [dirty, setDirty] = React.useState(false);
  const [openStep, setOpenStep] = React.useState<string | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);

  React.useEffect(() => {
    if (existing.data && !definition) {
      setDefinition(existing.data.definition);
      setOpenStep(existing.data.definition.steps[0]?.id ?? null);
    }
  }, [existing.data, definition]);

  React.useEffect(() => {
    if (isNew && definition && !openStep) setOpenStep(definition.steps[0]?.id ?? null);
  }, [isNew, definition, openStep]);

  const update = React.useCallback((next: AutomationDefinition) => {
    setDefinition(next);
    setDirty(true);
  }, []);

  const save = useMutation({
    mutationFn: async () => {
      if (!definition) throw new Error('Nothing to save');
      if (isNew) {
        return api.post<{ id: string }>('/automations', {
          connectedAccountId: activeAccountId,
          definition,
        });
      }
      return api.patch<{ id: string }>(`/automations/${id}`, { definition });
    },
    onSuccess: async (data) => {
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['automations', activeAccountId] });
      toast.success('Saved.');
      if (isNew) navigate(`/automations/${data.id}`, { replace: true });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'Could not save.');
    },
  });

  const publish = useMutation({
    mutationFn: async () => {
      if (!definition) return;
      const target = isNew
        ? (await api.post<{ id: string }>('/automations', {
            connectedAccountId: activeAccountId,
            definition,
          })).id
        : ((await api.patch<{ id: string }>(`/automations/${id}`, { definition })), id!);
      return api.post<{ id: string }>(`/automations/${target}/publish`);
    },
    onSuccess: async (data) => {
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['automations', activeAccountId] });
      toast.success("It's live. The next matching comment gets a reply.");
      if (data?.id) navigate(`/automations/${data.id}`, { replace: true });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'Could not publish.');
    },
  });

  const issues = React.useMemo(
    () => (definition ? validateDefinition(definition) : []),
    [definition],
  );

  const bubbles = React.useMemo(
    () => (definition ? stepsToBubbles(definition.steps) : []),
    [definition],
  );

  if (!definition) {
    return (
      <div className="flex h-[70vh] items-center justify-center">
        <p className="text-[13px] text-text-subtle">Loading…</p>
      </div>
    );
  }

  const triggerMeta = TRIGGER_META[definition.trigger.type];
  const status = existing.data?.status ?? 'draft';

  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= definition.steps.length) return;
    const steps = [...definition.steps];
    const [moved] = steps.splice(index, 1);
    steps.splice(target, 0, moved!);
    update({ ...definition, steps });
  };

  return (
    <div className="grid min-h-[calc(100dvh-3.5rem)] lg:grid-cols-[minmax(0,1fr)_380px]">
      {/* ─── Editor ───────────────────────────────────────────────────── */}
      <div className="min-w-0 border-r border-line">
        <div className="sticky top-14 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-surface/90 px-4 py-2.5 backdrop-blur-md sm:px-6">
          <Button variant="ghost" size="icon" onClick={() => navigate('/automations')}>
            <ArrowLeft className="size-4" />
          </Button>
          <input
            value={definition.name}
            maxLength={80}
            onChange={(e) => update({ ...definition, name: e.target.value })}
            className="min-w-0 flex-1 bg-transparent text-[15px] font-semibold outline-none focus:underline focus:decoration-brand-500 focus:underline-offset-4"
            placeholder="Name this automation"
          />
          {status === 'live' ? <Badge tone="success">Live</Badge> : null}
          {dirty ? <Badge tone="warning">Unsaved</Badge> : null}
          <Button variant="secondary" size="sm" loading={save.isPending} onClick={() => save.mutate()}>
            <Save className="size-4" />
            Save
          </Button>
          <Tooltip content={issues.length ? 'Fix the problems below first.' : null}>
            <span>
              <Button
                variant="primary"
                size="sm"
                disabled={issues.length > 0}
                loading={publish.isPending}
                onClick={() => publish.mutate()}
              >
                <Play className="size-4" />
                {status === 'live' ? 'Update live' : 'Publish'}
              </Button>
            </span>
          </Tooltip>
        </div>

        <div className="mx-auto max-w-2xl space-y-4 px-4 py-6 sm:px-6">
          {issues.length > 0 ? (
            <Card className="border-amber-500/30 bg-amber-500/6 p-4">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-700 dark:text-amber-300">
                <AlertTriangle className="size-4" />
                {issues.length === 1 ? 'One thing to fix' : `${issues.length} things to fix`}
              </p>
              <ul className="mt-2 space-y-1">
                {issues.map((issue, i) => (
                  <li key={i} className="text-[12.5px] leading-relaxed text-text-muted">
                    • {issue.message}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {/* Trigger */}
          <Card>
            <div className="flex items-start gap-3 p-4">
              <span
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-lg',
                  triggerMeta.tint,
                )}
              >
                <triggerMeta.icon className="size-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
                  When this happens
                </p>
                <Select
                  className="mt-1.5"
                  value={definition.trigger.type}
                  onValueChange={(type) =>
                    update({ ...definition, trigger: defaultTrigger(type as TriggerType) })
                  }
                  options={(Object.keys(TRIGGER_META) as TriggerType[])
                    .filter((type) => can(TRIGGER_META[type].feature))
                    .map((type) => ({
                      value: type,
                      label: TRIGGER_META[type].label,
                    }))}
                />
                <p className="mt-2 text-[12.5px] leading-relaxed text-text-muted">
                  {triggerMeta.description}
                </p>
              </div>
            </div>
            <div className="border-t border-line p-4">
              <TriggerEditor
                trigger={definition.trigger}
                onChange={(trigger) => update({ ...definition, trigger })}
              />
            </div>
          </Card>

          {/* Steps */}
          <div className="space-y-2.5">
            <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
              Then do this
            </p>

            {definition.steps.map((step, index) => {
              const meta = STEP_META[step.type];
              const isOpen = openStep === step.id;

              return (
                <Card key={step.id} className={cn(isOpen && 'border-brand-600/40')}>
                  <div className="flex items-center gap-2.5 p-3">
                    <div className="flex flex-col">
                      <button
                        onClick={() => moveStep(index, -1)}
                        disabled={index === 0}
                        className="text-text-subtle disabled:opacity-25"
                        aria-label="Move up"
                      >
                        <ChevronUp className="size-3.5" />
                      </button>
                      <GripVertical className="size-3.5 text-text-subtle/40" />
                      <button
                        onClick={() => moveStep(index, 1)}
                        disabled={index === definition.steps.length - 1}
                        className="text-text-subtle disabled:opacity-25"
                        aria-label="Move down"
                      >
                        <ChevronDown className="size-3.5" />
                      </button>
                    </div>

                    <button
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      onClick={() => setOpenStep(isOpen ? null : step.id)}
                    >
                      <span
                        className={cn(
                          'flex size-8 shrink-0 items-center justify-center rounded-lg',
                          meta.tint,
                        )}
                      >
                        <meta.icon className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13.5px] font-medium">{meta.label}</span>
                        <span className="block truncate text-[12px] text-text-subtle">
                          {stepSummary(step)}
                        </span>
                      </span>
                    </button>

                    {definition.steps.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Remove step"
                        onClick={() =>
                          update({
                            ...definition,
                            steps: definition.steps.filter((s) => s.id !== step.id),
                          })
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </div>

                  {isOpen ? (
                    <div className="animate-fade-up border-t border-line p-4">
                      <StepEditor
                        step={step}
                        onChange={(next) => {
                          const steps = [...definition.steps];
                          steps[index] = next;
                          update({ ...definition, steps });
                        }}
                      />
                    </div>
                  ) : null}
                </Card>
              );
            })}

            <Button variant="secondary" className="w-full" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" />
              Add a step
            </Button>
          </div>
        </div>
      </div>

      {/* ─── Preview ──────────────────────────────────────────────────── */}
      <aside className="hidden bg-surface-sunken/50 lg:block">
        <div className="sticky top-14 px-5 py-6">
          <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-subtle">
            <Eye className="size-3.5" />
            What they'll see
          </p>
          <PhonePreview
            bubbles={bubbles}
            pageName={activeAccount?.pageName ?? 'Your Page'}
            pageAvatarUrl={activeAccount?.pagePictureUrl}
          />
          <p className="mx-auto mt-4 max-w-72 text-center text-[11.5px] leading-relaxed text-text-subtle">
            Rendered the way Messenger renders it — same bubble shapes, same
            three-button limit, same carousel width.
          </p>
        </div>
      </aside>

      {/* ─── Add step ─────────────────────────────────────────────────── */}
      <Dialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add a step"
        description="Everything the contact receives, in order."
      >
        <div className="space-y-2">
          {STEP_TYPES.map((type) => {
            const meta = STEP_META[type];
            const locked = meta.feature ? !can(meta.feature) : false;
            const needed = meta.feature ? minimumPlanFor(meta.feature) : null;

            return (
              <button
                key={type}
                disabled={locked}
                onClick={() => {
                  const step = defaultStep(type);
                  update({ ...definition, steps: [...definition.steps, step] });
                  setOpenStep(step.id);
                  setAddOpen(false);
                }}
                className={cn(
                  'flex w-full items-start gap-3 rounded-xl border border-line p-3 text-left transition-colors',
                  locked ? 'cursor-not-allowed opacity-60' : 'hover:border-brand-600/40 hover:bg-surface-sunken',
                )}
              >
                <span
                  className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', meta.tint)}
                >
                  <meta.icon className="size-4.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[13.5px] font-semibold">{meta.label}</span>
                    {locked && needed ? (
                      <Badge tone="brand">
                        <Lock className="size-2.5" />
                        {PLAN_LABELS[needed]}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[12.5px] leading-relaxed text-text-muted">
                    {meta.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {me.workspace.plan === 'free' ? (
          <p className="mt-3 text-center text-[12px] text-text-subtle">
            Carousels, the Follow Gate and follow-up nudges unlock on Pro.
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

function stepSummary(step: Step): string {
  switch (step.type) {
    case 'send_message':
      return step.text.slice(0, 60) || 'Empty message';
    case 'product_carousel':
      return `${step.cards.length} card${step.cards.length === 1 ? '' : 's'}`;
    case 'follow_gate':
      return step.gateText.slice(0, 60);
    case 'ask_email':
      return 'Captures an email address';
    case 'ask_phone':
      return 'Captures a phone number';
    case 'delay':
      return `Waits ${step.seconds}s`;
    case 'follow_up':
      return `After ${step.delayMinutes} minutes`;
    default:
      return '';
  }
}
