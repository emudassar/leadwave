/**
 * The fetch layer.
 *
 * Every API response is `{ data }` or `{ error }`, without exception, so this
 * file is the only place that has to know that. Callers get the payload or an
 * `ApiError` they can show — never a raw Response.
 */

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Array<{ path: string; message: string }>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Array<{ path: string; message: string }>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }

  /** Plan gates come back with a machine-readable code so we can upsell. */
  get isUpgradeRequired(): boolean {
    return this.code === 'plan_limit' || this.code === 'feature_locked';
  }
}

/**
 * In dev the Vite proxy forwards same-origin `/api` requests to the local API,
 * so this stays relative. In production the dashboard and the API are on
 * separate subdomains (Cloudflare Pages + Render), so a build-time origin is
 * required — CORS and the session cookie's `SameSite=None` are already set up
 * for exactly this cross-origin shape.
 */
export const API_ORIGIN = import.meta.env.VITE_API_URL ?? '';
const BASE = `${API_ORIGIN}/api/v1`;

type Query = Record<string, string | number | boolean | null | undefined>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

async function request<T>(
  method: string,
  path: string,
  options: { body?: unknown; query?: Query } = {},
): Promise<T> {
  const res = await fetch(BASE + withQuery(path, options.query), {
    method,
    credentials: 'include',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // A proxy or a crash can return HTML; fall through to the generic error.
  }

  if (!res.ok) {
    const error = (payload as { error?: ApiErrorBody } | null)?.error;
    throw new ApiError(
      res.status,
      error ?? { code: 'unknown', message: 'Something went wrong. Please try again.' },
    );
  }

  return (payload as { data: T }).data;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, { query }),
  post: <T>(path: string, body?: unknown, query?: Query) =>
    request<T>('POST', path, { body, query }),
  patch: <T>(path: string, body?: unknown, query?: Query) =>
    request<T>('PATCH', path, { body, query }),
  put: <T>(path: string, body?: unknown, query?: Query) => request<T>('PUT', path, { body, query }),
  delete: <T>(path: string, query?: Query) => request<T>('DELETE', path, { query }),
};

/** Opens a download the browser handles itself (CSV exports). */
export function downloadUrl(path: string, query?: Query): string {
  return BASE + withQuery(path, query);
}
