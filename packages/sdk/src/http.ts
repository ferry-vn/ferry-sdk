/**
 * Minimal fetch-based transport: URL building, auth header, request ids,
 * timeout, retries with exponential backoff (idempotent GET/HEAD only),
 * observability hooks and error mapping.
 * No runtime dependencies — works on Node 20+, Bun, Deno, browsers and edge runtimes.
 */
import { FerryAbortError, FerryApiError, FerryConfigError, FerryNetworkError, FerryTimeoutError } from './errors.js';
import { SDK_VERSION } from './version.js';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Query values. Objects/arrays are JSON-encoded (the backend parses `filters` as JSON). */
export type QueryValue = string | number | boolean | Date | null | undefined | object;

export interface RetryOptions {
  /** Max retry attempts after the first try (default 2). Applied to GET/HEAD only. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default 300). */
  baseDelayMs?: number;
  /**
   * Upper bound for a single wait in ms (default 5000). When the server asks
   * for a longer `Retry-After`, the SDK does not retry: it throws the HTTP
   * error (`FerryRateLimitError` for 429, `FerryServerError` for 503) with
   * `retryAfterMs` instead of hammering the API.
   */
  maxDelayMs?: number;
}

/** Per-call options accepted by every SDK method (last argument). */
export interface RequestOptions {
  /** Abort the call (rejects with `FerryAbortError`). */
  signal?: AbortSignal | undefined;
  /** Per-attempt timeout override in ms. */
  timeoutMs?: number | undefined;
  /** Retry override for this call (GET/HEAD only); `0` disables retries. */
  maxRetries?: number | undefined;
  /** Extra headers for this call. */
  headers?: Record<string, string> | undefined;
  /** Use this `x-request-id` instead of a generated one (e.g. to propagate your own trace id). */
  requestId?: string | undefined;
}

/** Information passed to `hooks.onRequest`. Headers are redacted (no API key). */
export interface RequestInfo {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  requestId: string;
  /** 0 for the first try, 1 for the first retry, ... */
  attempt: number;
}

/** Information passed to `hooks.onResponse` (every HTTP response, including errors). */
export interface ResponseInfo extends RequestInfo {
  status: number;
  durationMs: number;
}

/** Information passed to `hooks.onRetry`. */
export interface RetryInfo extends RequestInfo {
  /** HTTP status that triggered the retry, or the transport error. */
  reason: number | Error;
  delayMs: number;
}

export interface FerryHooks {
  onRequest?: (info: RequestInfo) => void | Promise<void>;
  onResponse?: (info: ResponseInfo) => void | Promise<void>;
  onRetry?: (info: RetryInfo) => void | Promise<void>;
}

/** Debug sink: `true` logs to `console.debug`, or pass your own function. */
export type DebugOption = boolean | ((message: string, details: Record<string, unknown>) => void);

export interface TransportConfig {
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs: number;
  retry: Required<RetryOptions>;
  fetch: typeof fetch;
  /** Value for the backend i18n header (`x-custom-lang`), e.g. "vi" or "en". */
  language?: string | undefined;
  headers?: Record<string, string> | undefined;
  userAgent?: string | undefined;
  hooks?: FerryHooks | undefined;
  debug?: DebugOption | undefined;
}

export interface TransportRequest extends RequestOptions {
  method: HttpMethod;
  /** Path relative to the API origin, e.g. `/api/v1/bookings`. */
  path: string;
  query?: Record<string, QueryValue> | undefined;
  body?: unknown;
}

const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);
const IDEMPOTENT: ReadonlySet<HttpMethod> = new Set(['GET', 'HEAD']);
/** Headers whose auth scheme is kept (`Bearer [redacted]`). */
const SCHEME_HEADERS = new Set(['authorization', 'proxy-authorization']);
/** Headers redacted entirely. */
const SECRET_HEADERS = new Set(['cookie', 'set-cookie', 'x-api-key']);
/** `setTimeout` overflows above this and fires immediately. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Serialise one query value the way the backend's DTO transformers expect. */
export function encodeQueryValue(value: Exclude<QueryValue, null | undefined>): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const base = baseUrl.replace(/\/+$/, '');
  const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, encodeQueryValue(value));
    }
  }
  return url.toString();
}

/** Parse `Retry-After` (seconds or HTTP date) into ms. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function backoffDelay(attempt: number, retry: Required<RetryOptions>, random = Math.random): number {
  const exp = retry.baseDelayMs * 2 ** attempt;
  // Jitter between 50% and 100% of the exponential delay.
  return Math.min(retry.maxDelayMs, Math.round(exp * (0.5 + random() * 0.5)));
}

/** Replace secret header values (Authorization, cookies, API keys) with a masked marker. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (SCHEME_HEADERS.has(key)) {
      const scheme = /^([A-Za-z][\w-]*)\s/.exec(v)?.[1];
      out[k] = scheme ? `${scheme} [redacted]` : '[redacted]';
    } else out[k] = SECRET_HEADERS.has(key) ? '[redacted]' : v;
  }
  return out;
}

/** Validate a per-call or client timeout (ms). */
export function checkTimeout(ms: number, label: string): number {
  if (!Number.isFinite(ms) || ms <= 0) throw new FerryConfigError(`${label} must be a positive number of ms`);
  return Math.min(ms, MAX_TIMEOUT_MS);
}

/** RFC 4122 v4 id; uses `crypto.randomUUID` when available. */
export function generateRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Resolve after `ms`, or reject with the signal's reason if it aborts first. Never leaks listeners. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json') || /^[[{"]/.test(text.trimStart())) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

const isBrowser = (): boolean =>
  typeof (globalThis as { window?: unknown }).window !== 'undefined' &&
  typeof (globalThis as { document?: unknown }).document !== 'undefined';

export class Transport {
  constructor(readonly config: TransportConfig) {}

  /** Headers sent with every request. */
  buildHeaders(extra?: Record<string, string>, hasBody = false): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json', ...this.config.headers };
    if (hasBody) h['content-type'] = 'application/json';
    // Verified in backend src/auth/strategies/bearer-header.strategy.ts:
    // passport-http-bearer → `Authorization: Bearer <api key>`.
    if (this.config.apiKey) h.authorization = `Bearer ${this.config.apiKey}`;
    if (this.config.language) h['x-custom-lang'] = this.config.language;
    // Browsers forbid setting User-Agent; only send it elsewhere.
    if (!isBrowser()) h['user-agent'] = this.config.userAgent ?? `ferryvn-sdk/${SDK_VERSION}`;
    return { ...h, ...extra };
  }

  private log(message: string, details: Record<string, unknown>): void {
    const { debug } = this.config;
    if (!debug) return;
    if (typeof debug === 'function') debug(message, details);
    else console.debug(`[ferryvn-sdk] ${message}`, details);
  }

  private async hook<K extends keyof FerryHooks>(name: K, info: Parameters<NonNullable<FerryHooks[K]>>[0]) {
    const fn = this.config.hooks?.[name] as ((i: typeof info) => void | Promise<void>) | undefined;
    if (!fn) return;
    try {
      await fn(info);
    } catch (err) {
      // Observability hooks must never break the API call itself.
      this.log(`hook ${name} threw`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async request<T>(opts: TransportRequest): Promise<T> {
    const url = buildUrl(this.config.baseUrl, opts.path, opts.query);
    const hasBody = opts.body !== undefined;
    const requestId = opts.requestId ?? generateRequestId();
    const headers = this.buildHeaders({ ...opts.headers, 'x-request-id': requestId }, hasBody);
    const safeHeaders = redactHeaders(headers);
    const timeoutMs = opts.timeoutMs === undefined ? this.config.timeoutMs : checkTimeout(opts.timeoutMs, 'timeoutMs');
    if (opts.maxRetries !== undefined && (!Number.isInteger(opts.maxRetries) || opts.maxRetries < 0)) {
      throw new FerryConfigError('maxRetries must be a non-negative integer');
    }
    const maxRetries = IDEMPOTENT.has(opts.method) ? (opts.maxRetries ?? this.config.retry.maxRetries) : 0;
    const userSignal = opts.signal;
    const aborted = () => new FerryAbortError(opts.method, url, userSignal?.reason, requestId);

    for (let attempt = 0; ; attempt++) {
      if (userSignal?.aborted) throw aborted();
      const info: RequestInfo = { method: opts.method, url, headers: safeHeaders, requestId, attempt };
      await this.hook('onRequest', info);
      // An async hook may have run while the caller aborted: the abort event will not fire again.
      if (userSignal?.aborted) throw aborted();
      this.log('request', { ...info });

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onAbort = () => controller.abort(userSignal?.reason);
      userSignal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        userSignal?.removeEventListener('abort', onAbort);
      };
      const started = Date.now();

      let res: Response;
      let body: unknown;
      try {
        res = await this.config.fetch(url, {
          method: opts.method,
          headers,
          body: hasBody ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });
        body = await readBody(res);
      } catch (err) {
        cleanup();
        if (userSignal?.aborted) throw aborted();
        const wrapped = timedOut
          ? new FerryTimeoutError(opts.method, url, timeoutMs, requestId)
          : new FerryNetworkError(opts.method, url, err, requestId);
        if (attempt < maxRetries) {
          const delayMs = backoffDelay(attempt, this.config.retry);
          await this.hook('onRetry', { ...info, reason: wrapped, delayMs });
          this.log('retry', { ...info, reason: wrapped.message, delayMs });
          await sleep(delayMs, userSignal).catch(() => {
            throw aborted();
          });
          continue;
        }
        throw wrapped;
      }
      cleanup();

      const durationMs = Date.now() - started;
      await this.hook('onResponse', { ...info, status: res.status, durationMs });
      this.log('response', { ...info, status: res.status, durationMs });
      if (res.ok) return body as T;

      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      const canWait = retryAfterMs === undefined || retryAfterMs <= this.config.retry.maxDelayMs;
      if (attempt < maxRetries && RETRYABLE_STATUS.has(res.status) && canWait) {
        const delayMs = retryAfterMs ?? backoffDelay(attempt, this.config.retry);
        await this.hook('onRetry', { ...info, reason: res.status, delayMs });
        this.log('retry', { ...info, reason: res.status, delayMs });
        await sleep(delayMs, userSignal).catch(() => {
          throw aborted();
        });
        continue;
      }
      throw FerryApiError.fromResponse({
        status: res.status,
        statusText: res.statusText,
        body,
        method: opts.method,
        url,
        retryAfterMs,
        requestId,
      });
    }
  }
}
