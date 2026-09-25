import {
  renderMergeFields,
  type Button,
  type CarouselCard,
  type MergeContext,
} from '@leadwave/shared';

/**
 * Translates LeadWave steps into Messenger Send API payloads.
 *
 * Kept free of I/O and database access so the dashboard's message preview and
 * the runtime can render from the same code — what the builder shows really is
 * what the recipient gets.
 */

export interface ResolvedButton {
  kind: 'url' | 'postback';
  label: string;
  /** For url buttons this is the *tracked* URL, already minted. */
  value: string;
}

export interface BuildContext extends MergeContext {
  /** Maps a step/card/button address to its tracked short URL. */
  resolveUrl?: (address: LinkAddress) => string | undefined;
}

export interface LinkAddress {
  stepId: string;
  cardId: string | null;
  buttonIndex: number;
}

/** Messenger's cap on a single text bubble. */
const TEXT_LIMIT = 2000;

export function renderText(template: string, ctx: MergeContext): string {
  return renderMergeFields(template, ctx).slice(0, TEXT_LIMIT);
}

function resolveButton(
  button: Button,
  address: LinkAddress,
  ctx: BuildContext,
): Record<string, unknown> | null {
  if (button.kind === 'postback') {
    return {
      type: 'postback',
      title: renderMergeFields(button.label, ctx).slice(0, 20),
      payload: button.payload,
    };
  }

  // A URL button always goes out as its tracked short link when one exists, so
  // a click can be attributed back to this exact button on this exact card.
  const tracked = ctx.resolveUrl?.(address) ?? button.url;
  return {
    type: 'web_url',
    title: renderMergeFields(button.label, ctx).slice(0, 20),
    url: tracked,
    // Opening inside Messenger keeps the person one tap from the conversation.
    webview_height_ratio: 'full',
    messenger_extensions: false,
  };
}

function buildButtons(
  buttons: readonly Button[],
  stepId: string,
  cardId: string | null,
  ctx: BuildContext,
): Array<Record<string, unknown>> {
  return buttons
    .map((b, i) => resolveButton(b, { stepId, cardId, buttonIndex: i }, ctx))
    .filter((b): b is Record<string, unknown> => b !== null)
    .slice(0, 3);
}

/**
 * A text message, optionally with buttons. Messenger has two shapes for this:
 * a plain `text` message, or a button template when buttons are attached.
 */
export function buildTextMessage(
  options: {
    stepId: string;
    text: string;
    buttons?: readonly Button[];
    quickReplies?: ReadonlyArray<{ label: string; payload: string }>;
    imageUrl?: string | null;
  },
  ctx: BuildContext,
): Record<string, unknown> {
  const text = renderText(options.text, ctx);
  const buttons = buildButtons(options.buttons ?? [], options.stepId, null, ctx);

  const message: Record<string, unknown> =
    buttons.length > 0
      ? {
          attachment: {
            type: 'template',
            payload: { template_type: 'button', text: text.slice(0, 640), buttons },
          },
        }
      : { text };

  if (options.quickReplies?.length) {
    message.quick_replies = options.quickReplies.slice(0, 13).map((qr) => ({
      content_type: 'text',
      title: renderMergeFields(qr.label, ctx).slice(0, 20),
      payload: qr.payload,
    }));
  }

  return message;
}

export function buildImageMessage(url: string): Record<string, unknown> {
  return {
    attachment: { type: 'image', payload: { url, is_reusable: true } },
  };
}

/**
 * The product carousel: Messenger's generic template. Up to 10 cards, each with
 * an image, a title, a subtitle and up to 3 buttons. Tapping the card itself
 * opens the first button's link, so people who never notice buttons still land
 * on the product page.
 *
 * The whole carousel is one message — it costs one send against the plan's
 * monthly cap, not ten.
 */
export function buildCarouselMessage(
  stepId: string,
  cards: readonly CarouselCard[],
  ctx: BuildContext,
): Record<string, unknown> {
  const elements = cards.slice(0, 10).map((card) => {
    const buttons = buildButtons(card.buttons, stepId, card.id, ctx);
    const element: Record<string, unknown> = {
      title: renderMergeFields(card.title, ctx).slice(0, 80),
    };

    if (card.subtitle) {
      element.subtitle = renderMergeFields(card.subtitle, ctx).slice(0, 80);
    }
    if (card.imageUrl) {
      element.image_url = card.imageUrl;
    }
    if (buttons.length > 0) {
      element.buttons = buttons;

      const first = buttons[0];
      if (first?.type === 'web_url' && typeof first.url === 'string') {
        element.default_action = {
          type: 'web_url',
          url: first.url,
          webview_height_ratio: 'full',
        };
      }
    }

    return element;
  });

  return {
    attachment: {
      type: 'template',
      payload: { template_type: 'generic', image_aspect_ratio: 'square', elements },
    },
  };
}

/**
 * Lead capture. Messenger has native chips that fill the value straight from
 * the person's profile — one tap instead of typing an address. We still parse
 * free text, because plenty of people type it anyway.
 */
export function buildLeadCaptureMessage(
  options: { stepId: string; prompt: string; field: 'email' | 'phone'; useNative: boolean },
  ctx: BuildContext,
): Record<string, unknown> {
  const message: Record<string, unknown> = { text: renderText(options.prompt, ctx) };

  if (options.useNative) {
    message.quick_replies = [
      {
        content_type: options.field === 'email' ? 'user_email' : 'user_phone_number',
      },
    ];
  }

  return message;
}

/**
 * The Follow Gate message: a link to the Page plus the confirm button.
 *
 * Facebook exposes no per-user follow signal, so the unlock is a tap. The Page
 * link is a plain URL button (never a tracked one) because it is navigation,
 * not a conversion we want to attribute.
 */
export function buildFollowGateMessage(
  options: {
    stepId: string;
    gateText: string;
    unlockButtonLabel: string;
    pageUrl: string | null;
    unlockPayload: string;
  },
  ctx: BuildContext,
): Record<string, unknown> {
  const buttons: Array<Record<string, unknown>> = [];

  if (options.pageUrl) {
    buttons.push({
      type: 'web_url',
      title: 'Open the Page',
      url: options.pageUrl,
      webview_height_ratio: 'full',
    });
  }

  buttons.push({
    type: 'postback',
    title: renderMergeFields(options.unlockButtonLabel, ctx).slice(0, 20),
    payload: options.unlockPayload,
  });

  return {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'button',
        text: renderText(options.gateText, ctx).slice(0, 640),
        buttons: buttons.slice(0, 3),
      },
    },
  };
}

/**
 * A plain-language summary of a payload, for the conversation list preview and
 * the activity feed. Never shows raw JSON to a user.
 */
export function describeMessage(payload: Record<string, unknown> | null, text: string | null): string {
  if (text) return text.slice(0, 140);
  if (!payload) return '';

  const attachment = payload.attachment as { type?: string; payload?: Record<string, unknown> } | undefined;
  if (!attachment) return '';

  if (attachment.type === 'image') return '📷 Photo';
  if (attachment.type === 'video') return '🎬 Video';
  if (attachment.type === 'audio') return '🎵 Audio';
  if (attachment.type === 'file') return '📎 File';

  const template = attachment.payload?.template_type as string | undefined;
  if (template === 'generic') {
    const count = (attachment.payload?.elements as unknown[] | undefined)?.length ?? 0;
    return `🛍️ ${count} product card${count === 1 ? '' : 's'}`;
  }
  if (template === 'button') {
    return String(attachment.payload?.text ?? 'Message with buttons').slice(0, 140);
  }

  return 'Message';
}
