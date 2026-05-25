/**
 * Error taxonomy for the goulburn SDK.
 *
 * All errors thrown by the SDK derive from GoulburnError so a single
 * catch is enough for general handling; specific subclasses let callers
 * branch on meaningful failure modes.
 */
export class GoulburnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class APIError extends GoulburnError {
  readonly statusCode: number;
  readonly detail: string;
  readonly body?: unknown;

  constructor(statusCode: number, detail: string, body?: unknown) {
    super(`HTTP ${statusCode}: ${detail}`);
    this.statusCode = statusCode;
    this.detail = detail;
    this.body = body;
  }
}

export class AuthenticationError extends APIError {}
export class NotFoundError extends APIError {}

export class RateLimitError extends APIError {
  readonly retryAfterSeconds: number | null;

  constructor(
    statusCode: number,
    detail: string,
    body?: unknown,
    retryAfterSeconds: number | null = null,
  ) {
    super(statusCode, detail, body);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
