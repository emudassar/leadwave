import type { KeywordRule, MergeField } from './automation.js';

/**
 * Pure matching and parsing helpers used by the runtime. Kept free of I/O so
 * they can be unit tested directly against fixture strings.
 */

// ─── Text normalisation ──────────────────────────────────────────────────────

/**
 * Lowercase, strip accents, collapse whitespace, and drop the punctuation that
 * people scatter around a keyword ("LINK!!", "link.", "#link").
 */
export function normalise(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s@._+-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word-boundary aware `includes`, so "link" doesn't match "linkedin". */
function containsWord(haystack: string, needle: string): boolean {
  if (needle.includes(' ')) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, 'u').test(haystack);
}

export interface KeywordMatch {
  matched: boolean;
  /** Which keyword fired, for analytics and the activity log. */
  keyword: string | null;
}

export function matchKeywords(rule: KeywordRule, rawText: string): KeywordMatch {
  const text = normalise(rawText);
  if (!text) return { matched: false, keyword: null };

  for (const excluded of rule.excludeKeywords) {
    if (containsWord(text, normalise(excluded))) {
      return { matched: false, keyword: null };
    }
  }

  if (rule.mode === 'any') return { matched: true, keyword: null };

  for (const raw of rule.keywords) {
    const keyword = normalise(raw);
    if (!keyword) continue;

    const hit =
      rule.mode === 'exact'
        ? text === keyword
        : rule.mode === 'starts_with'
          ? text.startsWith(keyword)
          : containsWord(text, keyword);

    if (hit) return { matched: true, keyword: raw };
  }

  return { matched: false, keyword: null };
}

// ─── Email parsing ───────────────────────────────────────────────────────────

/**
 * Pulls an address out of a free-text reply. People send "sarah@hello.co",
 * "it's sarah@hello.co!", "Sarah @ hello . co" and worse.
 */
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,63}/u;

export function parseEmail(raw: string): string | null {
  const text = raw.trim();

  const direct = text.match(EMAIL_RE);
  if (direct?.[0]) return cleanEmail(direct[0]);

  // Spaced-out forms: "sarah @ hello . co"
  const despaced = text.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.');
  const spaced = despaced.match(EMAIL_RE);
  if (spaced?.[0]) return cleanEmail(spaced[0]);

  // "sarah at hello dot co"
  const spelled = text
    .replace(/\s+\(?at\)?\s+/gi, '@')
    .replace(/\s+\(?dot\)?\s+/gi, '.')
    .replace(/\s+/g, '');
  const viaWords = spelled.match(EMAIL_RE);
  if (viaWords?.[0]) return cleanEmail(viaWords[0]);

  return null;
}

function cleanEmail(value: string): string | null {
  const trimmed = value.toLowerCase().replace(/[.,;:!?)\]}'"]+$/, '');
  const [local, domain] = trimmed.split('@');
  if (!local || !domain) return null;
  if (!domain.includes('.')) return null;
  if (domain.startsWith('.') || domain.endsWith('.')) return null;
  if (trimmed.length > 254) return null;
  return trimmed;
}

// ─── Phone parsing ───────────────────────────────────────────────────────────

/** Dial codes for the markets this product actually sells into. */
const DIAL_CODES: Record<string, { code: string; nationalLength: number }> = {
  PK: { code: '92', nationalLength: 10 },
  IN: { code: '91', nationalLength: 10 },
  US: { code: '1', nationalLength: 10 },
  CA: { code: '1', nationalLength: 10 },
  GB: { code: '44', nationalLength: 10 },
  AE: { code: '971', nationalLength: 9 },
  SA: { code: '966', nationalLength: 9 },
  BD: { code: '880', nationalLength: 10 },
  AU: { code: '61', nationalLength: 9 },
  DE: { code: '49', nationalLength: 10 },
  BR: { code: '55', nationalLength: 11 },
};

/**
 * Reads a phone number out of a free-text reply, in whatever shape it arrives:
 * "03001234567", "+92 300 1234567", "(555) 123-4567", "300-1234567".
 * Returns E.164 (`+923001234567`) or null.
 */
export function parsePhone(raw: string, defaultCountry = 'PK'): string | null {
  const country = DIAL_CODES[defaultCountry.toUpperCase()] ?? DIAL_CODES.PK!;

  // Keep only the first plausible run of digits (plus an optional leading +).
  const candidate = raw.match(/\+?[\d][\d\s().-]{6,20}\d/);
  if (!candidate?.[0]) return null;

  const hadPlus = candidate[0].trim().startsWith('+');
  let digits = candidate[0].replace(/\D/g, '');
  if (!digits) return null;

  if (hadPlus) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  // Trim an international prefix typed as 00.
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  // Already carries the country's dial code.
  if (
    digits.startsWith(country.code) &&
    digits.length === country.code.length + country.nationalLength
  ) {
    return `+${digits}`;
  }

  // National format with a trunk zero: 0300 1234567 -> +92 300 1234567
  if (digits.startsWith('0') && digits.length === country.nationalLength + 1) {
    return `+${country.code}${digits.slice(1)}`;
  }

  // Bare national number.
  if (digits.length === country.nationalLength) {
    return `+${country.code}${digits}`;
  }

  // Anything else that is still a plausible international number.
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;

  return null;
}

// ─── Merge fields ────────────────────────────────────────────────────────────

export interface MergeContext {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  pageName?: string | null;
}

/**
 * Replaces `{first_name}` and `{{first_name}}` (both spellings are in the wild)
 * with the contact's details. An unknown or empty field collapses to a neutral
 * fallback so a message never ships a literal `{first_name}`.
 */
export function renderMergeFields(template: string, ctx: MergeContext): string {
  const first = ctx.firstName?.trim() || '';
  const last = ctx.lastName?.trim() || '';
  const full = [first, last].filter(Boolean).join(' ');

  const values: Record<MergeField, string> = {
    first_name: first || 'there',
    last_name: last,
    full_name: full || first || 'there',
    username: ctx.username?.trim() || first || 'there',
    page_name: ctx.pageName?.trim() || 'us',
  };

  return template
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) => replace(match, key, values))
    .replace(/\{\s*([a-z_]+)\s*\}/gi, (match, key: string) => replace(match, key, values));
}

function replace(match: string, key: string, values: Record<string, string>): string {
  const value = values[key.toLowerCase()];
  return value === undefined ? match : value;
}

// ─── Misc ────────────────────────────────────────────────────────────────────

/** Picks a random entry — used to rotate public comment reply variants. */
export function pickVariant<T>(variants: readonly T[]): T | null {
  if (variants.length === 0) return null;
  return variants[Math.floor(Math.random() * variants.length)] ?? null;
}

/** Inclusive random integer, used for the AI comment reply jitter. */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
