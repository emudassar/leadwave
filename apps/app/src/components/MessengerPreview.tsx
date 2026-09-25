/**
 * The Messenger preview.
 *
 * This renders what the *recipient* sees — not a stylised approximation of it.
 * Messenger's own shapes are copied deliberately: 18px bubbles, the blue-violet
 * gradient on outbound, button templates as a white card with hairline-divided
 * blue rows, the generic template as a 240px horizontal carousel, quick replies
 * as outlined pills above the composer.
 *
 * It matters because the single most common way an automation goes wrong is a
 * message that reads fine in a form field and looks broken in the thread: four
 * buttons where Messenger allows three, a subtitle that truncates, a carousel
 * card with no image. If the builder shows the real thing, you catch it before
 * four hundred people do.
 */
import * as React from 'react';
import { Info, Paperclip, Plus, Smile, ThumbsUp, Camera, Mic } from 'lucide-react';
import type { Button as StepButton, Step } from '@leadwave/shared';
import { cn, renderMergeFields } from '@/lib/utils';

export interface PreviewBubble {
  id: string;
  from: 'page' | 'contact';
  text?: string;
  imageUrl?: string | null;
  buttons?: Array<{ label: string; kind: 'url' | 'postback' }>;
  cards?: Array<{
    id: string;
    title: string;
    subtitle?: string;
    imageUrl?: string | null;
    buttons?: Array<{ label: string; kind: 'url' | 'postback' }>;
  }>;
  quickReplies?: string[];
  /** Renders the small "sent by LeadWave AI" marker under the bubble. */
  ai?: boolean;
  note?: string;
  timestamp?: string;
}

// ─── Turning steps into what lands in the thread ─────────────────────────────

function mapButtons(buttons: readonly StepButton[]): Array<{ label: string; kind: 'url' | 'postback' }> {
  return buttons.map((b) => ({ label: b.label, kind: b.kind }));
}

/**
 * The step tree, flattened into the messages a contact actually receives. A
 * delay produces nothing visible; a lead-capture step is one prompt bubble (the
 * success and retry texts only appear in response to what they type).
 */
export function stepsToBubbles(steps: readonly Step[], contactFirstName = 'Ayesha'): PreviewBubble[] {
  const bubbles: PreviewBubble[] = [];
  const render = (text: string) => renderMergeFields(text, { first_name: contactFirstName });

  for (const step of steps) {
    switch (step.type) {
      case 'send_message':
        bubbles.push({
          id: step.id,
          from: 'page',
          text: render(step.text),
          imageUrl: step.imageUrl,
          buttons: mapButtons(step.buttons),
          quickReplies: step.quickReplies.map((q) => q.label),
        });
        break;

      case 'product_carousel':
        if (step.introText) {
          bubbles.push({ id: `${step.id}-intro`, from: 'page', text: render(step.introText) });
        }
        bubbles.push({
          id: step.id,
          from: 'page',
          cards: step.cards.map((card) => ({
            id: card.id,
            title: card.title,
            subtitle: card.subtitle,
            imageUrl: card.imageUrl,
            buttons: mapButtons(card.buttons),
          })),
        });
        break;

      case 'follow_gate':
        bubbles.push({
          id: step.id,
          from: 'page',
          text: render(step.gateText),
          buttons: [
            ...(step.pageUrl ? [{ label: 'Open the Page', kind: 'url' as const }] : []),
            { label: step.unlockButtonLabel, kind: 'postback' as const },
          ],
          note: 'Everything after this waits until they tap the unlock button.',
        });
        break;

      case 'ask_email':
      case 'ask_phone':
        bubbles.push({
          id: step.id,
          from: 'page',
          text: render(step.prompt),
          quickReplies: step.useNativeQuickReply
            ? [step.type === 'ask_email' ? 'Send my email' : 'Send my number']
            : [],
          note:
            step.type === 'ask_email'
              ? 'Messenger fills this chip from their profile — one tap, no typing.'
              : 'Messenger fills this chip from their profile — one tap, no typing.',
        });
        break;

      case 'delay':
        bubbles.push({
          id: step.id,
          from: 'page',
          note: `Waits ${formatDelay(step.seconds)} before the next message.`,
        });
        break;

      case 'follow_up':
        bubbles.push({
          id: step.id,
          from: 'page',
          text: render(step.text),
          buttons: mapButtons(step.buttons),
          note: `Sent ${formatDelay(step.delayMinutes * 60)} later — cancelled if they reply or tap first.`,
        });
        break;

      default:
        break;
    }
  }

  return bubbles;
}

function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours}h`;
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function TemplateButtons({
  buttons,
}: {
  buttons: Array<{ label: string; kind: 'url' | 'postback' }>;
}): React.ReactElement {
  return (
    <div className="divide-y divide-black/8 border-t border-black/8 dark:divide-white/10 dark:border-white/10">
      {buttons.map((button, i) => (
        <div
          key={`${button.label}-${i}`}
          className="px-3 py-2.5 text-center text-[13.5px] font-semibold text-messenger"
        >
          {button.label}
        </div>
      ))}
    </div>
  );
}

function Bubble({ bubble }: { bubble: PreviewBubble }): React.ReactElement | null {
  const isPage = bubble.from === 'page';

  // A bare note (a delay, a gate explanation) is a rail annotation, not a message.
  if (!bubble.text && !bubble.cards && !bubble.imageUrl && bubble.note) {
    return (
      <div className="my-1 flex justify-center px-6">
        <p className="rounded-full bg-black/5 px-3 py-1 text-center text-[11px] leading-snug text-black/50 dark:bg-white/8 dark:text-white/50">
          {bubble.note}
        </p>
      </div>
    );
  }

  const hasTemplate = Boolean(bubble.buttons?.length) || Boolean(bubble.imageUrl);

  return (
    <div className={cn('flex flex-col gap-1', isPage ? 'items-start' : 'items-end')}>
      {bubble.cards?.length ? (
        <div className="-mx-3 flex w-[calc(100%+1.5rem)] snap-x gap-2 overflow-x-auto px-3 pb-1">
          {bubble.cards.map((card) => (
            <div
              key={card.id}
              className="w-[190px] shrink-0 snap-start overflow-hidden rounded-[14px] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.14)] dark:bg-[#303030]"
            >
              {card.imageUrl ? (
                <img
                  src={card.imageUrl}
                  alt=""
                  className="h-[110px] w-full bg-black/5 object-cover dark:bg-white/5"
                />
              ) : (
                <div className="flex h-[110px] w-full items-center justify-center bg-black/5 text-[11px] text-black/35 dark:bg-white/5 dark:text-white/35">
                  No image
                </div>
              )}
              <div className="px-3 py-2">
                <p className="truncate text-[13px] font-semibold text-black dark:text-white">
                  {card.title || 'Untitled'}
                </p>
                {card.subtitle ? (
                  <p className="truncate text-[12px] text-black/55 dark:text-white/55">
                    {card.subtitle}
                  </p>
                ) : null}
              </div>
              {card.buttons?.length ? <TemplateButtons buttons={card.buttons} /> : null}
            </div>
          ))}
        </div>
      ) : null}

      {bubble.imageUrl && !bubble.cards ? (
        <img
          src={bubble.imageUrl}
          alt=""
          className="max-w-[78%] rounded-[18px] object-cover"
        />
      ) : null}

      {bubble.text && !hasTemplate ? (
        <div
          className={cn(
            'max-w-[78%] whitespace-pre-wrap break-words rounded-[18px] px-3 py-2 text-[14px] leading-[1.35]',
            isPage
              ? 'bg-[#f0f0f0] text-black dark:bg-[#303030] dark:text-white'
              : 'messenger-gradient text-white',
          )}
        >
          {bubble.text}
        </div>
      ) : null}

      {bubble.text && hasTemplate ? (
        <div className="max-w-[78%] overflow-hidden rounded-[18px] bg-[#f0f0f0] dark:bg-[#303030]">
          <p className="whitespace-pre-wrap break-words px-3 py-2 text-[14px] leading-[1.35] text-black dark:text-white">
            {bubble.text}
          </p>
          {bubble.buttons?.length ? <TemplateButtons buttons={bubble.buttons} /> : null}
        </div>
      ) : null}

      {bubble.ai ? (
        <p className="px-1 text-[10.5px] font-medium text-black/40 dark:text-white/40">
          ✦ LeadWave AI
        </p>
      ) : null}

      {bubble.note && (bubble.text || bubble.cards) ? (
        <p className="max-w-[86%] px-1 text-[10.5px] leading-snug text-black/40 dark:text-white/40">
          {bubble.note}
        </p>
      ) : null}

      {bubble.quickReplies?.length ? (
        <div className="-mx-3 mt-1 flex w-[calc(100%+1.5rem)] gap-1.5 overflow-x-auto px-3 pb-1">
          {bubble.quickReplies.map((label, i) => (
            <span
              key={`${label}-${i}`}
              className="shrink-0 rounded-full border border-messenger px-3 py-1 text-[12.5px] font-medium text-messenger"
            >
              {label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ─── The frame ───────────────────────────────────────────────────────────────

export function MessengerThread({
  bubbles,
  pageName,
  pageAvatarUrl,
  className,
}: {
  bubbles: PreviewBubble[];
  pageName: string;
  pageAvatarUrl?: string | null;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn('flex flex-col', className)}>
      {/* Thread header — Messenger's own layout, minus the call buttons. */}
      <div className="flex items-center gap-2.5 border-b border-black/8 px-3 py-2.5 dark:border-white/10">
        <div className="relative">
          {pageAvatarUrl ? (
            <img src={pageAvatarUrl} alt="" className="size-8 rounded-full object-cover" />
          ) : (
            <div className="messenger-gradient size-8 rounded-full" />
          )}
          <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-white bg-emerald-500 dark:border-[#1c1c22]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold text-black dark:text-white">
            {pageName}
          </p>
          <p className="text-[11px] text-black/45 dark:text-white/45">Typically replies instantly</p>
        </div>
        <Info className="size-4.5 text-messenger" />
      </div>

      <div className="flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {bubbles.length === 0 ? (
          <div className="flex h-full min-h-40 items-center justify-center">
            <p className="max-w-[80%] text-center text-[12.5px] leading-relaxed text-black/40 dark:text-white/40">
              Add a step and it shows up here, exactly as they'll see it.
            </p>
          </div>
        ) : (
          bubbles.map((bubble) => <Bubble key={bubble.id} bubble={bubble} />)
        )}
      </div>

      {/* Composer — inert, but its presence is what makes the preview read as a
          real thread rather than a list of cards. */}
      <div className="flex items-center gap-2 border-t border-black/8 px-3 py-2 dark:border-white/10">
        <Plus className="size-5 shrink-0 text-messenger" />
        <Camera className="size-5 shrink-0 text-messenger" />
        <Mic className="size-5 shrink-0 text-messenger" />
        <div className="flex flex-1 items-center gap-1.5 rounded-full bg-black/5 px-3 py-1.5 dark:bg-white/8">
          <span className="flex-1 text-[13px] text-black/40 dark:text-white/40">Aa</span>
          <Smile className="size-4 text-black/40 dark:text-white/40" />
        </div>
        <ThumbsUp className="size-5 shrink-0 text-messenger" />
      </div>
    </div>
  );
}

/** The thread inside a phone, for the builder's right-hand rail. */
export function PhonePreview({
  bubbles,
  pageName,
  pageAvatarUrl,
  className,
  label,
}: {
  bubbles: PreviewBubble[];
  pageName: string;
  pageAvatarUrl?: string | null;
  className?: string;
  label?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={cn('flex flex-col items-center gap-3', className)}>
      <div className="relative w-[290px] rounded-[2.2rem] border-[9px] border-[#15151c] bg-white shadow-[var(--shadow-lift)] dark:border-[#26262f] dark:bg-[#1c1c22]">
        {/* Status bar + notch */}
        <div className="flex items-center justify-between rounded-t-[1.5rem] px-5 pb-1 pt-2 text-[10.5px] font-semibold text-black/70 dark:text-white/70">
          <span>9:41</span>
          <span className="absolute left-1/2 top-1.5 h-4 w-20 -translate-x-1/2 rounded-full bg-[#15151c] dark:bg-[#26262f]" />
          <span className="flex items-center gap-1">
            <span className="tracking-tighter">▮▮▮</span>
            <span className="rounded-[2px] border border-current px-0.5 text-[8px] leading-tight">
              82
            </span>
          </span>
        </div>
        <MessengerThread
          bubbles={bubbles}
          pageName={pageName}
          pageAvatarUrl={pageAvatarUrl}
          className="h-[480px] rounded-b-[1.5rem]"
        />
      </div>
      {label ? (
        <p className="flex items-center gap-1.5 text-[12px] text-text-subtle">
          <Paperclip className="size-3.5" />
          {label}
        </p>
      ) : null}
    </div>
  );
}
