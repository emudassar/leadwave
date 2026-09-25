import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// ─── Numbers ─────────────────────────────────────────────────────────────────

/** 1,284 · 12.4k · 1.2M — short enough to sit in a stat tile at 40px. */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) < 1_000) return String(Math.round(value));
  if (Math.abs(value) < 1_000_000) {
    const k = value / 1_000;
    return `${k % 1 === 0 || Math.abs(k) >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function full(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

export function usd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

export function percent(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * Some endpoints return a rate already expressed as a percentage (`38.5`), not
 * as a ratio. Passing one of those through `percent` is how you end up showing
 * a click-through rate of 3850%, so they get their own formatter.
 */
export function percentValue(value: number, digits = 1): string {
  const rounded = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(digits);
  return `${rounded}%`;
}

/** `null` in a plan limit means unlimited — say so rather than printing null. */
export function limitLabel(limit: number | null): string {
  return limit === null ? 'Unlimited' : full(limit);
}

// ─── Time ────────────────────────────────────────────────────────────────────

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const date = typeof input === 'string' ? new Date(input) : input;
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);

  if (abs < 45) return 'just now';
  if (abs < 3_600) return RELATIVE.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return RELATIVE.format(Math.round(seconds / 3_600), 'hour');
  if (abs < 7 * 86_400) return RELATIVE.format(Math.round(seconds / 86_400), 'day');
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clockTime(input: string | Date): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function dayLabel(input: string | Date): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  if (isToday) return 'Today';
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Messenger closes the standard messaging window 24h after the contact's last
 * message. The countdown is the single most consequential number in the inbox,
 * so it gets its own formatter rather than a generic relative time.
 */
export function windowCountdown(expiresAt: string | null): string {
  if (!expiresAt) return 'Closed';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'Closed';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 1) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

// ─── Text ────────────────────────────────────────────────────────────────────

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Turns snake_case labels from the API into something a person would read. */
export function humanize(value: string): string {
  return value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function randomId(prefix = 'step'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Renders merge fields for a preview. The real substitution happens server-side
 * at send time; this is only so the builder shows a name instead of `{{...}}`.
 */
export function renderMergeFields(
  text: string,
  values: Record<string, string> = {},
): string {
  const defaults: Record<string, string> = {
    first_name: 'Ayesha',
    last_name: 'Khan',
    full_name: 'Ayesha Khan',
    username: 'ayesha.khan',
    page_name: 'your Page',
    ...values,
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => defaults[key] ?? match);
}
