import { prisma, type ConnectedAccount, type Contact, type LeadType } from '@leadwave/db';
import type { Plan } from '@leadwave/shared';
import { logger } from '../lib/logger.js';
import { checkLeadQuota, currentPeriod } from './entitlements.js';

/**
 * Lead capture.
 *
 * A lead is stored once per Page per value, so the same person handing over the
 * same email through two different automations updates one record rather than
 * inflating the count. Attribution — which automation, which post — is kept on
 * first capture, because that is the one that actually earned it.
 */

export interface RecordLeadInput {
  account: ConnectedAccount;
  contact?: Contact | null;
  workspaceId: string;
  plan: Plan;
  type: LeadType;
  /** Already normalised: lowercase email or E.164 phone. */
  value: string;
  /** Exactly what the person typed, for support and debugging. */
  rawValue?: string | null;
  automationId?: string | null;
  sourcePostId?: string | null;
  source?: 'automation' | 'bio_page' | 'ai_goal' | 'manual';
  bioPageId?: string | null;
}

export interface RecordLeadResult {
  status: 'created' | 'existing' | 'quota_exhausted';
  leadId?: string;
}

export async function recordLead(input: RecordLeadInput): Promise<RecordLeadResult> {
  const existing = await prisma.lead.findUnique({
    where: {
      connectedAccountId_type_value: {
        connectedAccountId: input.account.id,
        type: input.type,
        value: input.value,
      },
    },
  });

  if (existing) {
    // Link the lead to a contact if we only learned who they were later.
    if (!existing.contactId && input.contact) {
      await prisma.lead.update({
        where: { id: existing.id },
        data: { contactId: input.contact.id },
      });
    }
    return { status: 'existing', leadId: existing.id };
  }

  // The Free plan caps leads per cycle. Capturing is what the plan limits — the
  // conversation itself continues either way.
  const quota = await checkLeadQuota(input.workspaceId, input.plan);
  if (!quota.allowed) {
    logger.info(
      { workspaceId: input.workspaceId, limit: quota.limit },
      'lead not stored: plan limit reached',
    );
    return { status: 'quota_exhausted' };
  }

  const lead = await prisma.lead.create({
    data: {
      connectedAccountId: input.account.id,
      contactId: input.contact?.id ?? null,
      type: input.type,
      value: input.value,
      rawValue: input.rawValue?.slice(0, 500) ?? null,
      source: input.source ?? 'automation',
      automationId: input.automationId ?? null,
      bioPageId: input.bioPageId ?? null,
      sourcePostId: input.sourcePostId ?? null,
    },
  });

  const { periodStart } = await currentPeriod(input.workspaceId);
  await prisma.usageCounter
    .update({
      where: { workspaceId_periodStart: { workspaceId: input.workspaceId, periodStart } },
      data: { leadsCaptured: { increment: 1 } },
    })
    .catch(() => {
      // The counter row is created lazily; a miss here is not worth failing on.
    });

  // Business plan: push it straight into the connected Sheet.
  const { enqueueSheetsAppend } = await import('../queues/index.js');
  await enqueueSheetsAppend(lead.id).catch((err: unknown) => {
    logger.warn({ err, leadId: lead.id }, 'could not queue sheets append');
  });

  return { status: 'created', leadId: lead.id };
}

// ─── Export ──────────────────────────────────────────────────────────────────

export interface ExportRow {
  value: string;
  type: LeadType;
  contactName: string;
  source: string;
  capturedAt: string;
}

/**
 * CSV export. Opted-out contacts are excluded everywhere — a person who asked
 * to be left alone should not turn up in a download either.
 */
export async function buildLeadExport(
  connectedAccountId: string,
  options: { type?: LeadType } = {},
): Promise<ExportRow[]> {
  const leads = await prisma.lead.findMany({
    where: {
      connectedAccountId,
      ...(options.type ? { type: options.type } : {}),
      OR: [{ contactId: null }, { contact: { optedOutAt: null } }],
    },
    include: { contact: true, automation: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return leads.map((lead) => ({
    value: lead.value,
    type: lead.type,
    contactName: [lead.contact?.firstName, lead.contact?.lastName].filter(Boolean).join(' '),
    source: lead.automation?.name ?? lead.source,
    capturedAt: lead.createdAt.toISOString(),
  }));
}

/**
 * Meta Ads custom-audience format. The headers are exactly what Ads Manager
 * expects, so every column maps automatically on upload with no manual step.
 * Meta hashes the values in the browser during upload.
 */
export async function buildMetaAdsExport(connectedAccountId: string): Promise<string> {
  const leads = await prisma.lead.findMany({
    where: {
      connectedAccountId,
      OR: [{ contactId: null }, { contact: { optedOutAt: null } }],
    },
    include: { contact: true },
    orderBy: { createdAt: 'desc' },
  });

  const header = 'email,phone,fn,ln';
  const rows = leads.map((lead) => {
    const email = lead.type === 'email' ? lead.value : '';
    const phone = lead.type === 'phone' ? lead.value : '';
    return [
      csvCell(email),
      csvCell(phone),
      csvCell(lead.contact?.firstName ?? ''),
      csvCell(lead.contact?.lastName ?? ''),
    ].join(',');
  });

  return [header, ...rows].join('\n');
}

export function toCsv(rows: ExportRow[]): string {
  const header = 'value,type,contact,source,captured_at';
  const body = rows.map((r) =>
    [r.value, r.type, r.contactName, r.source, r.capturedAt].map(csvCell).join(','),
  );
  return [header, ...body].join('\n');
}

function csvCell(value: string): string {
  const normalised = value ?? '';
  // Guard against a value like "=cmd|..." being executed by a spreadsheet.
  const safe = /^[=+\-@]/.test(normalised) ? `'${normalised}` : normalised;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
