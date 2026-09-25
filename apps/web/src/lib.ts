/** Shared bits the marketing pages read from, so copy lives in one place. */

export const APP_URL = import.meta.env.PUBLIC_APP_URL ?? 'http://localhost:5173';
export const SIGNUP_URL = `${APP_URL}/login`;

/** The social proof line. Update these in one place, not in nine templates. */
export const PROOF = {
  businesses: '900+',
  triggers: '61,000+',
  messages: '44,000+',
  clicks: '12,000+',
} as const;

export interface NavLink {
  href: string;
  label: string;
}

export const PRODUCT_LINKS: NavLink[] = [
  { href: '/#features', label: 'Features' },
  { href: '/for', label: 'Built for' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/use-cases', label: 'Use cases' },
  { href: '/faq', label: 'FAQ' },
];
