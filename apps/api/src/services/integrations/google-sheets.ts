import { prisma, type Integration } from '@leadwave/db';
import { env, configured } from '../../env.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';

/**
 * Google Sheets piping (Business plan).
 *
 * Every captured lead lands in the next blank row within seconds, tagged with
 * who they were, which automation captured them and when — no Zapier in the
 * middle to break silently. A separate Sheet can be connected per Page, which
 * is what agencies running several client brands need.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export const SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

export const sheetsRedirectUri = () =>
  `${env.API_URL}/api/v1/integrations/google-sheets/callback`;

export interface SheetsConfig {
  spreadsheetId?: string;
  spreadsheetName?: string;
  /** 'monthly' creates a new tab per month; 'single' appends to one sheet. */
  tabStrategy?: 'monthly' | 'single';
  tabName?: string;
}

export function authUrl(state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.GOOGLE_SHEETS_CLIENT_ID!);
  url.searchParams.set('redirect_uri', sheetsRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SHEETS_SCOPES.join(' '));
  url.searchParams.set('state', state);
  // A refresh token is only issued with consent + offline access.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export async function exchangeCode(code: string): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
}> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_SHEETS_CLIENT_ID!,
      client_secret: env.GOOGLE_SHEETS_CLIENT_SECRET!,
      redirect_uri: sheetsRedirectUri(),
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);

  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
  };
}

/** Refreshes the access token when it is within a minute of expiry. */
async function freshAccessToken(integration: Integration): Promise<string> {
  const stillValid =
    integration.accessTokenCipher &&
    integration.tokenExpiresAt &&
    integration.tokenExpiresAt.getTime() - Date.now() > 60_000;

  if (stillValid) return decrypt(integration.accessTokenCipher!);

  if (!integration.refreshTokenCipher) {
    throw new Error('This Google connection needs to be reauthorised.');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_SHEETS_CLIENT_ID!,
      client_secret: env.GOOGLE_SHEETS_CLIENT_SECRET!,
      refresh_token: decrypt(integration.refreshTokenCipher),
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    await prisma.integration.update({
      where: { id: integration.id },
      data: { lastError: 'Google access was revoked. Reconnect the integration.' },
    });
    throw new Error('Could not refresh the Google token.');
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + json.expires_in * 1000);

  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      accessTokenCipher: encrypt(json.access_token),
      tokenExpiresAt: expiresAt,
      lastError: null,
    },
  });

  return json.access_token;
}

async function sheetsRequest<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(`${SHEETS_API}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export async function listTabs(integration: Integration): Promise<string[]> {
  const config = (integration.config as SheetsConfig) ?? {};
  if (!config.spreadsheetId) return [];

  const token = await freshAccessToken(integration);
  const result = await sheetsRequest<{ sheets?: Array<{ properties?: { title?: string } }> }>(
    token,
    `/${config.spreadsheetId}`,
    { query: { fields: 'sheets.properties.title' } },
  );

  return (result.sheets ?? []).map((s) => s.properties?.title ?? '').filter(Boolean);
}

const HEADER_ROW = ['Captured at', 'Name', 'Type', 'Value', 'Source', 'Post'];

/**
 * Appends one lead. Creates the month's tab and writes the header the first
 * time it is used, so a fresh month never produces a sheet of bare values.
 */
export async function appendLead(leadId: string): Promise<'appended' | 'skipped'> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      contact: true,
      automation: { select: { name: true } },
      connectedAccount: { include: { workspace: true } },
    },
  });

  if (!lead?.connectedAccount || lead.syncedToSheetsAt) return 'skipped';
  if (!configured.googleSheets) return 'skipped';

  const integration = await prisma.integration.findFirst({
    where: {
      connectedAccountId: lead.connectedAccountId,
      type: 'google_sheets',
      isEnabled: true,
    },
  });
  if (!integration) return 'skipped';

  const config = (integration.config as SheetsConfig) ?? {};
  if (!config.spreadsheetId) return 'skipped';

  const token = await freshAccessToken(integration);
  const tab = await ensureTab(token, config, integration.id);

  const timezone = lead.connectedAccount.workspace.timezone || 'UTC';
  const row = [
    formatInTimezone(lead.createdAt, timezone),
    [lead.contact?.firstName, lead.contact?.lastName].filter(Boolean).join(' '),
    lead.type,
    lead.value,
    lead.automation?.name ?? lead.source,
    lead.sourcePostId ?? '',
  ];

  await sheetsRequest(token, `/${config.spreadsheetId}/values/${encodeURIComponent(tab)}!A:F:append`, {
    method: 'POST',
    query: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
    body: { values: [row] },
  });

  await prisma.$transaction([
    prisma.lead.update({
      where: { id: lead.id },
      data: { syncedToSheetsAt: new Date() },
    }),
    prisma.integration.update({
      where: { id: integration.id },
      data: { lastSyncAt: new Date(), lastError: null },
    }),
  ]);

  return 'appended';
}

async function ensureTab(
  token: string,
  config: SheetsConfig,
  integrationId: string,
): Promise<string> {
  const desired =
    config.tabStrategy === 'single'
      ? (config.tabName ?? 'Leads')
      : `Leads ${new Date().toISOString().slice(0, 7)}`;

  const existing = await sheetsRequest<{ sheets?: Array<{ properties?: { title?: string } }> }>(
    token,
    `/${config.spreadsheetId}`,
    { query: { fields: 'sheets.properties.title' } },
  );

  const titles = (existing.sheets ?? []).map((s) => s.properties?.title);
  if (titles.includes(desired)) return desired;

  await sheetsRequest(token, `/${config.spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: { requests: [{ addSheet: { properties: { title: desired } } }] },
  });

  await sheetsRequest(token, `/${config.spreadsheetId}/values/${encodeURIComponent(desired)}!A1:F1`, {
    method: 'PUT',
    query: { valueInputOption: 'RAW' },
    body: { values: [HEADER_ROW] },
  });

  logger.info({ integrationId, tab: desired }, 'created a new sheets tab');
  return desired;
}

function formatInTimezone(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
