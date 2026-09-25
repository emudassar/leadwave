import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../env.js';

/**
 * Page access tokens and OAuth refresh tokens are the keys to someone's
 * business. They are encrypted at rest with AES-256-GCM so that a leaked
 * database dump is not, by itself, a leaked set of Facebook Pages.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');

/** Stored as `v1:<iv>:<authTag>:<ciphertext>`, all base64url. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

export function decrypt(payload: string): string {
  const [version, ivPart, tagPart, dataPart] = payload.split(':');
  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) {
    throw new Error('Malformed ciphertext');
  }
  const decipher = createDecipheriv(ALGO, KEY, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Returns null instead of throwing, for read paths that must stay resilient. */
export function tryDecrypt(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    return decrypt(payload);
  } catch {
    return null;
  }
}

// ─── Signatures & hashing ────────────────────────────────────────────────────

/**
 * Meta signs every webhook body with the app secret. We verify against the
 * *raw* body — re-serialising the parsed JSON would change the bytes and break
 * the signature.
 */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header) return false;
  const [algo, signature] = header.split('=');
  if (algo !== 'sha256' || !signature) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(signature, expected);
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Appsecret proof — Meta requires it on server-side Graph calls. */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/**
 * One-way visitor fingerprint for anonymous click dedupe. Salted with the
 * session secret so the hashes are useless outside this deployment, and
 * deliberately coarse — enough to tell two clicks apart, not enough to identify
 * a person.
 */
export function visitorHash(ip: string, userAgent: string): string {
  return createHash('sha256')
    .update(`${ip}|${userAgent}|${env.SESSION_SECRET}`)
    .digest('base64url')
    .slice(0, 22);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Opaque, URL-safe token for sessions, invites and OAuth state. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
