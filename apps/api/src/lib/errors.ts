/**
 * Errors that carry an HTTP status and a stable machine code. Anything thrown
 * that is not an ApiError becomes a 500 with a generic message, so an
 * unexpected failure can never leak internals to a client.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Sign in to continue.') =>
  new ApiError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have access to that.') =>
  new ApiError(403, 'forbidden', message);

export const notFound = (message = 'Not found.') => new ApiError(404, 'not_found', message);

export const conflict = (message: string, details?: unknown) =>
  new ApiError(409, 'conflict', message, details);

export const tooManyRequests = (message = 'Slow down a moment.') =>
  new ApiError(429, 'rate_limited', message);

/**
 * A plan gate. The client uses `requiredPlan` to render the right upgrade
 * prompt instead of a generic error toast.
 */
export const upgradeRequired = (message: string, requiredPlan: string, feature: string) =>
  new ApiError(402, 'upgrade_required', message, { requiredPlan, feature });

/** A plan limit, as opposed to a plan feature. */
export const limitReached = (message: string, limit: number, used: number) =>
  new ApiError(402, 'limit_reached', message, { limit, used });
