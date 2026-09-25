import { Router, type Request, type Response } from 'express';
import { prisma, type Prisma } from '@leadwave/db';
import { configured, env } from '../env.js';
import { verifyMetaSignature } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { enqueueWebhook } from '../queues/index.js';

/**
 * The Facebook webhook receiver.
 *
 * Meta expects a 200 within a couple of seconds and retries aggressively when
 * it does not get one. So this endpoint does the least possible work: verify
 * the signature, write each entry to `WebhookEvent`, queue it, and return. All
 * real processing happens in the worker.
 *
 * `WebhookEvent.eventKey` is unique, which is what makes redelivery harmless —
 * a duplicate insert fails, and the duplicate is simply dropped.
 */

export const messengerWebhookRouter: Router = Router();

/** Meta's subscription handshake. */
messengerWebhookRouter.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.META_WEBHOOK_VERIFY_TOKEN) {
    logger.info('messenger webhook verified');
    res.status(200).send(String(challenge ?? ''));
    return;
  }

  logger.warn({ mode }, 'messenger webhook verification rejected');
  res.sendStatus(403);
});

interface WebhookEntry {
  id: string;
  time?: number;
  messaging?: MessagingEvent[];
  changes?: ChangeEvent[];
  standby?: MessagingEvent[];
}

export interface MessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload?: string };
    attachments?: Array<{ type?: string; payload?: Record<string, unknown> }>;
    reply_to?: { mid?: string; story?: { url?: string; id?: string } };
  };
  postback?: { mid?: string; title?: string; payload?: string };
  reaction?: { mid?: string; action?: string; emoji?: string; reaction?: string };
  referral?: { ref?: string; source?: string; type?: string };
  optin?: { payload?: string };
  delivery?: { mids?: string[]; watermark?: number };
  read?: { watermark?: number };
}

export interface ChangeEvent {
  field: string;
  value: Record<string, unknown>;
}

messengerWebhookRouter.post('/', (req: Request & { rawBody?: Buffer }, res: Response) => {
  // Acknowledge first. Anything that fails after this is our problem to retry,
  // not a reason for Meta to redeliver the whole batch.
  if (!configured.meta) {
    logger.warn('received a webhook but META_APP_SECRET is not configured');
    res.sendStatus(200);
    return;
  }

  const valid = verifyMetaSignature(
    req.rawBody ?? Buffer.alloc(0),
    req.get('x-hub-signature-256'),
    env.META_APP_SECRET!,
  );

  if (!valid) {
    logger.warn({ ip: req.ip }, 'rejected webhook with a bad signature');
    res.sendStatus(403);
    return;
  }

  res.sendStatus(200);

  const body = req.body as { object?: string; entry?: WebhookEntry[] };
  void ingest(body).catch((err: unknown) => {
    logger.error({ err }, 'failed to ingest webhook batch');
  });
});

async function ingest(body: { object?: string; entry?: WebhookEntry[] }): Promise<void> {
  if (body.object !== 'page' || !Array.isArray(body.entry)) return;

  for (const entry of body.entry) {
    const pageId = entry.id;

    for (const event of entry.messaging ?? []) {
      await store(pageId, 'messaging', fingerprintMessaging(pageId, event), event);
    }

    for (const change of entry.changes ?? []) {
      await store(pageId, change.field, fingerprintChange(pageId, change), change);
    }
  }
}

async function store(
  pageId: string,
  field: string,
  eventKey: string,
  payload: unknown,
): Promise<void> {
  try {
    const record = await prisma.webhookEvent.create({
      data: {
        eventKey,
        object: 'page',
        field,
        pageId,
        payload: payload as Prisma.InputJsonValue,
      },
    });
    await enqueueWebhook(record.id);
  } catch (err) {
    // A unique-constraint failure means Meta redelivered something we already
    // have. That is the system working, not an error.
    if (isUniqueViolation(err)) {
      logger.debug({ eventKey }, 'dropped duplicate webhook delivery');
      return;
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2002'
  );
}

/**
 * A stable fingerprint per event. Meta gives most events a message id; the ones
 * that do not get a composite of the parts that identify them.
 */
function fingerprintMessaging(pageId: string, event: MessagingEvent): string {
  const sender = event.sender?.id ?? 'unknown';

  if (event.message?.mid) return `msg:${event.message.mid}`;
  if (event.postback?.mid) return `pb:${event.postback.mid}`;
  if (event.postback) return `pb:${pageId}:${sender}:${event.timestamp}:${event.postback.payload}`;
  if (event.reaction?.mid) return `react:${event.reaction.mid}:${event.reaction.action}`;
  if (event.optin) return `optin:${pageId}:${sender}:${event.timestamp}`;
  if (event.referral) return `ref:${pageId}:${sender}:${event.timestamp}`;
  if (event.delivery) return `delivery:${pageId}:${sender}:${event.delivery.watermark}`;
  if (event.read) return `read:${pageId}:${sender}:${event.read.watermark}`;

  return `evt:${pageId}:${sender}:${event.timestamp ?? Date.now()}`;
}

function fingerprintChange(pageId: string, change: ChangeEvent): string {
  const value = change.value as { comment_id?: string; post_id?: string; verb?: string };

  if (value.comment_id) return `comment:${value.comment_id}:${value.verb ?? 'add'}`;
  if (value.post_id) return `post:${value.post_id}:${change.field}:${value.verb ?? 'add'}`;

  // Fall back to hashing the payload so genuinely distinct changes stay distinct.
  return `change:${pageId}:${change.field}:${hashValue(change.value)}`;
}

function hashValue(value: unknown): string {
  const json = JSON.stringify(value);
  let h = 2166136261;
  for (let i = 0; i < json.length; i += 1) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
