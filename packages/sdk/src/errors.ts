/**
 * Typed errors thrown by the SDK. Everything the SDK throws extends `FerryError`.
 *
 * The backend (NestJS, `src/common/filters/all-exceptions.filter.ts`) returns
 * several error body shapes (all with `timestamp`/`path`); `FerryApiError.fromResponse`
 * normalises them:
 *
 *  - Nest built-ins (401/403/404/429/500): { statusCode, message, error? }
 *  - Validation / field errors (422):      { status, errors: { <field>: "<reason>" } }
 *  - Domain errors (422, sometimes 409/429/400):
 *      { status, errors: { errorCode, name, message? }, userMessage? }
 *    `message` is missing when a controller wraps the error in an HttpException;
 *    the SDK then falls back to the code's name (see `FerryErrorCode`).
 *    `userMessage` is a Vietnamese, end-user-friendly text when present.
 */
import { errorCodeName } from './error-codes.js';

/** Base class for every error raised by `@ferryvn/sdk`. */
export class FerryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FerryError';
  }
}

/** Invalid client or request configuration (thrown synchronously, before any network call). */
export class FerryConfigError extends FerryError {
  constructor(message: string) {
    super(message);
    this.name = 'FerryConfigError';
  }
}

/** Field-level validation errors (`errors` object) as returned by the backend. */
export type FerryFieldErrors = Record<string, unknown>;

export interface FerryApiErrorInit {
  status: number;
  message: string;
  errorCode?: number | string | undefined;
  errorName?: string | undefined;
  fieldErrors?: FerryFieldErrors | undefined;
  userMessage?: string | undefined;
  body?: unknown;
  method: string;
  url: string;
  retryAfterMs?: number | undefined;
  requestId?: string | undefined;
}

/** The API answered with a non-2xx status. */
export class FerryApiError extends FerryError {
  /** HTTP status code. */
  readonly status: number;
  /**
   * Backend domain error code, when present: a number (see `FerryErrorCode`),
   * or a string on the disruption endpoints (`DISRUPTION_NOT_FOUND`, `CURSOR_INVALID`…).
   */
  readonly errorCode: number | string | undefined;
  /** Backend domain error name (e.g. "InternalErrorResponse"), when present. */
  readonly errorName: string | undefined;
  /** Field → reason map for validation errors (HTTP 422), when present. */
  readonly fieldErrors: FerryFieldErrors | undefined;
  /** Vietnamese message meant for end users (domain errors only), when present. */
  readonly userMessage: string | undefined;
  /** Raw parsed response body (JSON when possible, otherwise text). */
  readonly body: unknown;
  readonly method: string;
  /**
   * Request URL, query string included (it can contain search terms such as a
   * phone number: `message` and `toJSON()` leave the query out).
   */
  readonly url: string;
  /** Parsed `Retry-After` header in ms (HTTP 429/503), when present. */
  readonly retryAfterMs: number | undefined;
  /** `x-request-id` sent with the request — quote it when contacting FerryVN support. */
  readonly requestId: string | undefined;

  constructor(init: FerryApiErrorInit) {
    super(init.message);
    this.name = 'FerryApiError';
    this.status = init.status;
    this.errorCode = init.errorCode;
    this.errorName = init.errorName;
    this.fieldErrors = init.fieldErrors;
    this.userMessage = init.userMessage;
    this.body = init.body;
    this.method = init.method;
    this.url = init.url;
    this.retryAfterMs = init.retryAfterMs;
    this.requestId = init.requestId;
  }

  /** Build the most specific error subclass from a backend response body. */
  static fromResponse(args: {
    status: number;
    statusText?: string;
    body: unknown;
    method: string;
    url: string;
    retryAfterMs?: number | undefined;
    requestId?: string | undefined;
  }): FerryApiError {
    const parsed = parseErrorBody(args.body);
    const codeName = typeof parsed.errorCode === 'number' ? errorCodeName(parsed.errorCode) : undefined;
    const init: FerryApiErrorInit = {
      status: args.status,
      message:
        parsed.message ??
        (codeName ? `${codeName} (${parsed.errorCode})` : undefined) ??
        parsed.userMessage ??
        (args.statusText || `HTTP ${args.status}`),
      errorCode: parsed.errorCode,
      errorName: parsed.errorName,
      fieldErrors: parsed.fieldErrors,
      userMessage: parsed.userMessage,
      body: args.body,
      method: args.method,
      url: args.url,
      retryAfterMs: args.retryAfterMs,
      requestId: args.requestId,
    };
    switch (args.status) {
      case 401:
        return new FerryAuthError(init);
      case 403:
        return new FerryPermissionError(init);
      case 404:
        return new FerryNotFoundError(init);
      case 409:
        return new FerryConflictError(init);
      case 422:
        return new FerryValidationError(init);
      case 429:
        return new FerryRateLimitError(init);
      default:
        return args.status >= 500 ? new FerryServerError(init) : new FerryApiError(init);
    }
  }

  /** Log-safe representation (no response body, which may contain personal data). */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      errorCode: this.errorCode,
      errorName: this.errorName,
      fieldErrors: this.fieldErrors,
      userMessage: this.userMessage,
      method: this.method,
      url: withoutQuery(this.url),
      requestId: this.requestId,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

/** 401 — missing or invalid API key. */
export class FerryAuthError extends FerryApiError {
  constructor(init: FerryApiErrorInit) {
    super(init);
    this.name = 'FerryAuthError';
  }
}

/**
 * 403 — the API key is valid but its organization may not perform this action.
 * FerryVN also answers 403 for ids that do not exist or belong to another
 * organization, so for `get(id)` calls this often means "not found". (Not a
 * subclass of `FerryAuthError`: the key itself is fine.)
 */
export class FerryPermissionError extends FerryApiError {
  constructor(init: FerryApiErrorInit) {
    super(init);
    this.name = 'FerryPermissionError';
  }
}

/** 404 — resource not found (or not visible to this organization). */
export class FerryNotFoundError extends FerryApiError {
  constructor(init: FerryApiErrorInit) {
    super(init);
    this.name = 'FerryNotFoundError';
  }
}

/** 409 — the resource is in a state that does not allow this operation. */
export class FerryConflictError extends FerryApiError {
  constructor(init: FerryApiErrorInit) {
    super(init);
    this.name = 'FerryConflictError';
  }
}

/** 422 — validation failure or business-rule rejection (see `errorCode`). */
export class FerryValidationError extends FerryApiError {
  constructor(init: FerryApiErrorInit) {
    super(init);
    this.name = 'FerryValidationError';
  }
}

/** 429 — throttled (e.g. confirmToIssue is limited per IP and per booking). See `retryAfterMs`. */
export class FerryRateLimitError extends FerryApiError {
  constructor(init: FerryApiErrorInit) {
    super(init);
    this.name = 'FerryRateLimitError';
  }
}

/** 5xx — the FerryVN backend or an upstream ferry operator failed. */
export class FerryServerError extends FerryApiError {
  constructor(init: FerryApiErrorInit) {
    super(init);
    this.name = 'FerryServerError';
  }
}

/** Base class for failures where no HTTP response was received. */
export class FerryConnectionError extends FerryError {
  constructor(
    message: string,
    readonly method: string,
    readonly url: string,
    readonly requestId: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'FerryConnectionError';
  }
}

/** The request did not complete within `timeoutMs`. */
export class FerryTimeoutError extends FerryConnectionError {
  constructor(
    method: string,
    url: string,
    readonly timeoutMs: number,
    requestId?: string,
  ) {
    super(`${method} ${withoutQuery(url)} timed out after ${timeoutMs} ms`, method, url, requestId);
    this.name = 'FerryTimeoutError';
  }
}

/** Network-level failure (DNS, connection reset, TLS, CORS, ...). */
export class FerryNetworkError extends FerryConnectionError {
  constructor(method: string, url: string, cause: unknown, requestId?: string) {
    super(
      `${method} ${withoutQuery(url)} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      method,
      url,
      requestId,
      { cause },
    );
    this.name = 'FerryNetworkError';
  }
}

/** The caller aborted the request through its `AbortSignal`. `cause` is the signal's reason. */
export class FerryAbortError extends FerryConnectionError {
  constructor(method: string, url: string, reason: unknown, requestId?: string) {
    super(`${method} ${withoutQuery(url)} was aborted`, method, url, requestId, { cause: reason });
    this.name = 'FerryAbortError';
  }
}

/** `https://host/path?q=…` → `https://host/path` (query strings can hold personal data). */
export function withoutQuery(url: string): string {
  const i = url.indexOf('?');
  return i < 0 ? url : url.slice(0, i);
}

interface ParsedErrorBody {
  message?: string | undefined;
  errorCode?: number | string | undefined;
  errorName?: string | undefined;
  fieldErrors?: FerryFieldErrors | undefined;
  userMessage?: string | undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Normalise the backend's error body shapes (see file header). */
export function parseErrorBody(body: unknown): ParsedErrorBody {
  if (typeof body === 'string') {
    const text = body.trim();
    // Proxies and gateways answer with HTML pages: keep them out of `message`.
    if (!text || text.startsWith('<')) return {};
    return { message: text.length > 300 ? `${text.slice(0, 300)}…` : text };
  }
  if (!isRecord(body)) return {};

  const out: ParsedErrorBody = {};
  const { message, errors, userMessage } = body;
  if (typeof userMessage === 'string' && userMessage) out.userMessage = userMessage;

  if (typeof message === 'string') out.message = message;
  else if (Array.isArray(message)) out.message = message.map(String).join('; ');
  // Disruption endpoints: { errorCode: 'DISRUPTION_NOT_FOUND', message }.
  if (typeof body.errorCode === 'string' && body.errorCode) out.errorCode = body.errorCode;
  else if (typeof body.errorCode === 'number') out.errorCode = body.errorCode;

  if (isRecord(errors)) {
    // Shape 3: domain error { name, errorCode, message }
    if (typeof errors.errorCode === 'number' || typeof errors.errorCode === 'string') {
      const code = Number(errors.errorCode);
      if (Number.isFinite(code)) out.errorCode = code;
      if (typeof errors.name === 'string') out.errorName = errors.name;
      if (typeof errors.message === 'string' && errors.message) out.message = errors.message;
    } else if (Object.keys(errors).length > 0) {
      // Shape 2: { field: reason }
      out.fieldErrors = errors;
      out.message ??= Object.entries(errors)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('; ');
    }
  }
  return out;
}

/** Why the operator refused to issue an order's tickets (`order.issue_ticket_error`). */
export interface IssueTicketError {
  errorCode?: number | string | undefined;
  errorLabel?: string | undefined;
  message: string;
}

/**
 * Parse `order.issue_ticket_error`, which the backend stores as a JSON string
 * (`{"errorCode":…,"errorLabel":…,"message":…}`). Plain strings are returned as
 * the message; `undefined` when there is no error.
 */
export function parseIssueTicketError(value: unknown): IssueTicketError | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return {
      errorCode: o.errorCode as IssueTicketError['errorCode'],
      errorLabel: typeof o.errorLabel === 'string' ? o.errorLabel : undefined,
      message: typeof o.message === 'string' ? o.message : JSON.stringify(value),
    };
  }
  const text = String(value);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parseIssueTicketError(parsed);
  } catch {
    // not JSON: a plain message
  }
  return { message: text };
}

/** One-line rendering of `parseIssueTicketError()`: `LABEL (code): message`. */
export function formatIssueTicketError(value: unknown): string | undefined {
  const e = parseIssueTicketError(value);
  if (!e) return undefined;
  const head = [e.errorLabel, e.errorCode !== undefined && e.errorCode !== null ? `(${e.errorCode})` : '']
    .filter(Boolean)
    .join(' ');
  return head && e.message && e.message !== e.errorLabel ? `${head}: ${e.message}` : head || e.message;
}
