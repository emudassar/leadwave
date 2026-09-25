import {
  dispositionForGraphError,
  type GraphErrorDisposition,
  type MessageTag,
  type MessagingType,
} from '@leadwave/shared';
import { env } from '../env.js';
import { appSecretProof } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

/**
 * A thin, typed client over the Facebook Graph API.
 *
 * Everything that talks to Meta goes through here so there is exactly one place
 * that knows about appsecret proofs, the error taxonomy, and which calls are
 * safe to retry. Callers get a `GraphError` carrying a disposition rather than
 * a raw HTTP failure, so the queue layer can decide what to do without
 * re-parsing Meta's error codes.
 */

const base = () => `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;

export class GraphError extends Error {
  constructor(
    readonly code: number,
    readonly subcode: number | undefined,
    readonly disposition: GraphErrorDisposition,
    message: string,
    readonly httpStatus: number,
    readonly traceId?: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }

  get isRetryable(): boolean {
    return this.disposition === 'retry';
  }

  /** Meta already did the thing; treat as success (duplicate private reply). */
  get isBenign(): boolean {
    return this.disposition === 'succeed';
  }
}

interface GraphErrorBody {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

interface RequestOptions {
  accessToken: string;
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Omit the appsecret proof (used for token exchange calls). */
  skipProof?: boolean;
  timeoutMs?: number;
}

async function request<T>(path: string, options: RequestOptions): Promise<T> {
  const {
    accessToken,
    method = 'GET',
    query = {},
    body,
    skipProof = false,
    timeoutMs = 15_000,
  } = options;

  const url = new URL(`${base()}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  url.searchParams.set('access_token', accessToken);

  if (!skipProof && env.META_APP_SECRET) {
    url.searchParams.set('appsecret_proof', appSecretProof(accessToken, env.META_APP_SECRET));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    const json = text ? (JSON.parse(text) as T & GraphErrorBody) : ({} as T & GraphErrorBody);

    if (!res.ok || json.error) {
      const err = json.error ?? {};
      const code = err.code ?? 0;
      const subcode = err.error_subcode;
      throw new GraphError(
        code,
        subcode,
        dispositionForGraphError(code, subcode),
        err.message ?? `Graph request failed (${res.status})`,
        res.status,
        err.fbtrace_id,
      );
    }

    return json as T;
  } catch (err) {
    if (err instanceof GraphError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new GraphError(0, undefined, 'retry', 'Graph request timed out', 504);
    }
    // Network-level failures are worth another attempt.
    throw new GraphError(
      0,
      undefined,
      'retry',
      err instanceof Error ? err.message : 'Graph request failed',
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

// ─── OAuth & tokens ──────────────────────────────────────────────────────────

export interface FacebookPageSummary {
  id: string;
  name: string;
  username?: string;
  access_token: string;
  category?: string;
  tasks?: string[];
  picture?: { data?: { url?: string } };
  link?: string;
}

/** Swaps the short-lived user token from the login flow for a long-lived one. */
export async function exchangeForLongLivedUserToken(shortLivedToken: string): Promise<{
  accessToken: string;
  expiresInSeconds: number | null;
}> {
  const result = await request<{ access_token: string; expires_in?: number }>(
    '/oauth/access_token',
    {
      accessToken: shortLivedToken,
      skipProof: true,
      query: {
        grant_type: 'fb_exchange_token',
        client_id: env.META_APP_ID,
        client_secret: env.META_APP_SECRET,
        fb_exchange_token: shortLivedToken,
      },
    },
  );

  return {
    accessToken: result.access_token,
    expiresInSeconds: result.expires_in ?? null,
  };
}

/**
 * Lists the Pages this user can manage. Page tokens derived from a long-lived
 * user token do not expire on their own, which is what lets automations keep
 * running without the user reconnecting every two months.
 */
export async function listManagedPages(userAccessToken: string): Promise<FacebookPageSummary[]> {
  const pages: FacebookPageSummary[] = [];
  let after: string | undefined;

  do {
    const page = await request<{
      data: FacebookPageSummary[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>('/me/accounts', {
      accessToken: userAccessToken,
      query: {
        fields: 'id,name,username,access_token,category,tasks,link,picture{url}',
        limit: 100,
        after,
      },
    });

    pages.push(...page.data);
    after = page.paging?.next ? page.paging.cursors?.after : undefined;
  } while (after);

  return pages;
}

/** Confirms a token is still valid and reports which scopes it carries. */
export async function debugToken(token: string): Promise<{
  isValid: boolean;
  scopes: string[];
  expiresAt: Date | null;
}> {
  const appToken = `${env.META_APP_ID}|${env.META_APP_SECRET}`;
  const result = await request<{
    data: { is_valid: boolean; scopes?: string[]; expires_at?: number };
  }>('/debug_token', {
    accessToken: appToken,
    skipProof: true,
    query: { input_token: token },
  });

  return {
    isValid: result.data.is_valid,
    scopes: result.data.scopes ?? [],
    expiresAt:
      result.data.expires_at && result.data.expires_at > 0
        ? new Date(result.data.expires_at * 1000)
        : null,
  };
}

// ─── Webhook subscription ────────────────────────────────────────────────────

/**
 * The fields LeadWave needs. `messages` and `messaging_postbacks` drive every
 * DM trigger; `feed` carries comments; `message_reactions` covers story
 * reactions; `mention` covers story and post mentions.
 */
export const SUBSCRIBED_FIELDS = [
  'messages',
  'messaging_postbacks',
  'messaging_optins',
  'message_reactions',
  'messaging_referrals',
  'message_deliveries',
  'message_reads',
  'feed',
  'mention',
] as const;

export async function subscribePageToWebhooks(
  pageId: string,
  pageAccessToken: string,
): Promise<void> {
  await request(`/${pageId}/subscribed_apps`, {
    accessToken: pageAccessToken,
    method: 'POST',
    query: { subscribed_fields: SUBSCRIBED_FIELDS.join(',') },
  });
}

export async function unsubscribePageFromWebhooks(
  pageId: string,
  pageAccessToken: string,
): Promise<void> {
  await request(`/${pageId}/subscribed_apps`, {
    accessToken: pageAccessToken,
    method: 'DELETE',
  });
}

// ─── Send API ────────────────────────────────────────────────────────────────

export interface SendMessagePayload {
  recipient: { id: string };
  message: Record<string, unknown>;
  messaging_type?: MessagingType;
  tag?: MessageTag;
}

export async function sendMessage(
  pageId: string,
  pageAccessToken: string,
  payload: SendMessagePayload,
): Promise<{ message_id: string; recipient_id: string }> {
  return request(`/${pageId}/messages`, {
    accessToken: pageAccessToken,
    method: 'POST',
    body: payload,
  });
}

/** Shows the typing bubble, so an instant automated reply feels less abrupt. */
export async function sendSenderAction(
  pageId: string,
  pageAccessToken: string,
  psid: string,
  action: 'mark_seen' | 'typing_on' | 'typing_off',
): Promise<void> {
  await request(`/${pageId}/messages`, {
    accessToken: pageAccessToken,
    method: 'POST',
    body: { recipient: { id: psid }, sender_action: action },
  }).catch((err: unknown) => {
    // Never let a cosmetic call fail a real send.
    logger.debug({ err, psid }, 'sender action failed');
  });
}

// ─── Comments ────────────────────────────────────────────────────────────────

/**
 * The comment → DM primitive. Meta allows exactly one private reply per
 * comment, ever, and only while the comment is less than 7 days old. Both
 * limits are why Retrigger works the way it does.
 */
export async function sendPrivateReply(
  commentId: string,
  pageAccessToken: string,
  message: Record<string, unknown>,
): Promise<{ id: string; recipient_id?: string }> {
  return request(`/${commentId}/private_replies`, {
    accessToken: pageAccessToken,
    method: 'POST',
    body: { message },
  });
}

export async function replyToComment(
  commentId: string,
  pageAccessToken: string,
  message: string,
): Promise<{ id: string }> {
  return request(`/${commentId}/comments`, {
    accessToken: pageAccessToken,
    method: 'POST',
    body: { message },
  });
}

export async function deleteComment(commentId: string, pageAccessToken: string): Promise<void> {
  await request(`/${commentId}`, { accessToken: pageAccessToken, method: 'DELETE' });
}

export interface GraphComment {
  id: string;
  message?: string;
  created_time: string;
  from?: { id: string; name?: string };
}

/** One page of a post's existing comments — the input to a Retrigger run. */
export async function listPostComments(
  postId: string,
  pageAccessToken: string,
  options: { after?: string; limit?: number } = {},
): Promise<{ comments: GraphComment[]; nextCursor: string | null }> {
  const result = await request<{
    data: GraphComment[];
    paging?: { cursors?: { after?: string }; next?: string };
  }>(`/${postId}/comments`, {
    accessToken: pageAccessToken,
    query: {
      fields: 'id,message,created_time,from{id,name}',
      filter: 'toplevel',
      order: 'chronological',
      limit: options.limit ?? 100,
      after: options.after,
    },
  });

  return {
    comments: result.data ?? [],
    nextCursor: result.paging?.next ? (result.paging.cursors?.after ?? null) : null,
  };
}

// ─── Posts & stories ─────────────────────────────────────────────────────────

export interface GraphPost {
  id: string;
  message?: string;
  created_time: string;
  permalink_url?: string;
  full_picture?: string;
  /** "status" | "photo" | "video" | "reel" | ... */
  status_type?: string;
  attachments?: { data?: Array<{ media_type?: string; media?: { image?: { src?: string } } }> };
}

export async function listPagePosts(
  pageId: string,
  pageAccessToken: string,
  options: { after?: string; limit?: number } = {},
): Promise<{ posts: GraphPost[]; nextCursor: string | null }> {
  const result = await request<{
    data: GraphPost[];
    paging?: { cursors?: { after?: string }; next?: string };
  }>(`/${pageId}/posts`, {
    accessToken: pageAccessToken,
    query: {
      fields:
        'id,message,created_time,permalink_url,full_picture,status_type,attachments{media_type,media}',
      limit: options.limit ?? 25,
      after: options.after,
    },
  });

  return {
    posts: result.data ?? [],
    nextCursor: result.paging?.next ? (result.paging.cursors?.after ?? null) : null,
  };
}

export interface GraphStory {
  id: string;
  media_type?: string;
  media_url?: string;
  post_id?: string;
  status?: string;
  creation_time?: string;
}

export async function listPageStories(
  pageId: string,
  pageAccessToken: string,
): Promise<GraphStory[]> {
  const result = await request<{ data: GraphStory[] }>(`/${pageId}/stories`, {
    accessToken: pageAccessToken,
    query: { fields: 'id,media_type,media_url,post_id,status,creation_time', limit: 50 },
  });
  return result.data ?? [];
}

// ─── Contacts ────────────────────────────────────────────────────────────────

export interface GraphUserProfile {
  id: string;
  first_name?: string;
  last_name?: string;
  profile_pic?: string;
  locale?: string;
  timezone?: number;
}

/**
 * Profile lookups fail routinely — the person may have blocked the Page or
 * restricted their profile. A missing profile must never stop a send, so this
 * returns null instead of throwing.
 */
export async function fetchUserProfile(
  psid: string,
  pageAccessToken: string,
): Promise<GraphUserProfile | null> {
  try {
    return await request<GraphUserProfile>(`/${psid}`, {
      accessToken: pageAccessToken,
      query: { fields: 'first_name,last_name,profile_pic,locale,timezone' },
    });
  } catch (err) {
    logger.debug({ err, psid }, 'profile lookup failed');
    return null;
  }
}

// ─── Messenger Profile API ───────────────────────────────────────────────────

export interface IceBreakerEntry {
  question: string;
  payload: string;
}

/**
 * Ice breakers are a native Messenger feature: tappable question chips shown
 * when someone opens a brand-new conversation. Meta allows up to 4.
 */
export async function setIceBreakers(
  pageId: string,
  pageAccessToken: string,
  iceBreakers: IceBreakerEntry[],
  locale = 'default',
): Promise<void> {
  if (iceBreakers.length === 0) {
    await request(`/${pageId}/messenger_profile`, {
      accessToken: pageAccessToken,
      method: 'DELETE',
      body: { fields: ['ice_breakers'] },
    });
    return;
  }

  await request(`/${pageId}/messenger_profile`, {
    accessToken: pageAccessToken,
    method: 'POST',
    body: {
      ice_breakers: [{ locale, call_to_actions: iceBreakers.slice(0, 4) }],
    },
  });
}

export async function setGetStarted(
  pageId: string,
  pageAccessToken: string,
  payload: string,
): Promise<void> {
  await request(`/${pageId}/messenger_profile`, {
    accessToken: pageAccessToken,
    method: 'POST',
    body: { get_started: { payload } },
  });
}

export async function setGreeting(
  pageId: string,
  pageAccessToken: string,
  text: string,
): Promise<void> {
  await request(`/${pageId}/messenger_profile`, {
    accessToken: pageAccessToken,
    method: 'POST',
    body: { greeting: [{ locale: 'default', text: text.slice(0, 160) }] },
  });
}

export async function setPersistentMenu(
  pageId: string,
  pageAccessToken: string,
  menu: unknown,
): Promise<void> {
  await request(`/${pageId}/messenger_profile`, {
    accessToken: pageAccessToken,
    method: 'POST',
    body: { persistent_menu: menu },
  });
}

export const graph = {
  request,
  exchangeForLongLivedUserToken,
  listManagedPages,
  debugToken,
  subscribePageToWebhooks,
  unsubscribePageFromWebhooks,
  sendMessage,
  sendSenderAction,
  sendPrivateReply,
  replyToComment,
  deleteComment,
  listPostComments,
  listPagePosts,
  listPageStories,
  fetchUserProfile,
  setIceBreakers,
  setGetStarted,
  setGreeting,
  setPersistentMenu,
};
