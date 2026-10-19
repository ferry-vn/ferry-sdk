/**
 * `FerryClient` — entry point of the SDK.
 *
 * @example
 *   import { FerryClient } from '@ferryvn/sdk';
 *   const ferry = new FerryClient({ apiKey: process.env.FERRY_API_KEY });
 *   const { data } = await ferry.voyages.search({ date: '2026-10-20', departureId, destinationId });
 */
import { BookingDraftsResource } from './booking-builder.js';
import { FerryConfigError } from './errors.js';
import {
  type DebugOption,
  type FerryHooks,
  type HttpMethod,
  type QueryValue,
  type RequestOptions,
  type RetryOptions,
  Transport,
} from './http.js';
import { PricesResource } from './prices.js';
import {
  CustomersResource,
  DebtLedgerResource,
  OrganizationResource,
  TransactionsResource,
} from './resources/account-resources.js';
import {
  BookingsResource,
  CancelTicketRequestsResource,
  DisruptionsResource,
  OrdersResource,
  VouchersResource,
} from './resources/booking-resources.js';
import {
  BoatLayoutsResource,
  LocationsResource,
  OperatorsResource,
  RoutesResource,
  VoyageCountsResource,
  VoyagesResource,
} from './resources/supply-resources.js';

/** Known deployments. The SDK appends `/api/v1/...` itself. */
export const FERRY_ENVIRONMENTS = {
  production: 'https://api.ferry.vn',
  /** User-acceptance testing — use it with a UAT API key while integrating. */
  uat: 'https://api.ferryvn.net',
} as const;
export type FerryEnvironment = keyof typeof FERRY_ENVIRONMENTS;

export interface FerryClientOptions {
  /**
   * Partner API key, sent as `Authorization: Bearer <key>`. Create one in the
   * FerryVN dashboard (organization admins only). Optional only for the
   * anonymous endpoints (locations, routes, operators, public booking lookup).
   */
  apiKey?: string | undefined;
  /** API origin without `/api/v1`. Overrides `environment`. */
  baseUrl?: string | undefined;
  /** Shortcut for a known origin (default `production`). */
  environment?: FerryEnvironment | undefined;
  /** Per-attempt timeout in ms (default 30 000). */
  timeoutMs?: number | undefined;
  /** Retry policy — applies to GET/HEAD only; POST/PATCH/DELETE are never retried. */
  retry?: RetryOptions | undefined;
  /** Custom fetch (tests, proxies). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch | undefined;
  /** Response language for backend messages, sent as `x-custom-lang` (e.g. "vi", "en"). */
  language?: string | undefined;
  /** Extra headers on every request. */
  headers?: Record<string, string> | undefined;
  /** Override the User-Agent (ignored in browsers). */
  userAgent?: string | undefined;
  /** Observability callbacks (request, response, retry). Headers are redacted. */
  hooks?: FerryHooks | undefined;
  /** Log every request/response/retry: `true` → `console.debug`, or a custom sink. Never logs the API key. */
  debug?: DebugOption | undefined;
  /** In-memory caches. */
  cache?:
    | { /** TTL for `locations.list()` in ms (default 600 000; 0 disables). */ locationsTtlMs?: number }
    | undefined;
  /**
   * The partner API key has organization-admin power (it can create bookings,
   * issue tickets against your balance, change settings). It must never be
   * shipped to browsers. The client refuses to start in a browser with an API
   * key unless you set this — e.g. for an internal tool behind your own auth.
   */
  dangerouslyAllowBrowser?: boolean | undefined;
}

const isBrowser = (): boolean =>
  typeof (globalThis as { window?: unknown }).window !== 'undefined' &&
  typeof (globalThis as { document?: unknown }).document !== 'undefined';

function positive(name: string, value: number | undefined, { allowZero = false, integer = false } = {}): void {
  if (value === undefined) return;
  const ok = Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) && (!integer || Number.isInteger(value));
  if (!ok) {
    throw new FerryConfigError(
      `${name} must be a ${allowZero ? 'non-negative' : 'positive'} ${integer ? 'integer' : 'number'} (got ${value})`,
    );
  }
}

function validate(options: FerryClientOptions): void {
  positive('timeoutMs', options.timeoutMs);
  positive('retry.maxRetries', options.retry?.maxRetries, { allowZero: true, integer: true });
  positive('retry.baseDelayMs', options.retry?.baseDelayMs, { allowZero: true });
  positive('retry.maxDelayMs', options.retry?.maxDelayMs, { allowZero: true });
  positive('cache.locationsTtlMs', options.cache?.locationsTtlMs, { allowZero: true });
  if (options.environment !== undefined && !(options.environment in FERRY_ENVIRONMENTS)) {
    throw new FerryConfigError(`environment must be one of ${Object.keys(FERRY_ENVIRONMENTS).join(', ')}`);
  }
  if (options.baseUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new FerryConfigError(`baseUrl is not a valid URL: "${options.baseUrl}"`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new FerryConfigError(`baseUrl must use http(s) (got ${url.protocol})`);
    }
    if (/\/api\/v1\/?$/.test(url.pathname)) {
      throw new FerryConfigError('baseUrl must be the API origin without /api/v1 (the SDK adds it)');
    }
  }
  if (options.apiKey !== undefined && options.apiKey !== options.apiKey.trim()) {
    throw new FerryConfigError('apiKey has leading/trailing whitespace');
  }
  if (options.apiKey && isBrowser() && !options.dangerouslyAllowBrowser) {
    throw new FerryConfigError(
      'Refusing to use a FerryVN API key in a browser: it would expose organization-admin credentials to every visitor. Call the API from your server, or pass dangerouslyAllowBrowser: true if you understand the risk.',
    );
  }
}

export class FerryClient {
  readonly locations: LocationsResource;
  readonly routes: RoutesResource;
  readonly operators: OperatorsResource;
  readonly voyages: VoyagesResource;
  readonly voyageCounts: VoyageCountsResource;
  readonly boatLayouts: BoatLayoutsResource;
  readonly bookings: BookingsResource;
  /** Build and validate booking payloads from seat names + passengers (see `BookingDraftsResource`). */
  readonly bookingDrafts: BookingDraftsResource;
  /** Selling-price tables of a route (see `PricesResource.forRoute`). */
  readonly prices: PricesResource;
  readonly orders: OrdersResource;
  readonly cancelTicketRequests: CancelTicketRequestsResource;
  readonly customers: CustomersResource;
  readonly organization: OrganizationResource;
  readonly transactions: TransactionsResource;
  readonly debtLedger: DebtLedgerResource;
  readonly vouchers: VouchersResource;
  readonly disruptions: DisruptionsResource;

  private readonly transport: Transport;

  constructor(options: FerryClientOptions = {}) {
    validate(options);
    const fetchImpl = options.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!fetchImpl) {
      throw new FerryConfigError('global fetch is unavailable (Node 20+ required) — pass `fetch` explicitly');
    }
    const baseUrl = options.baseUrl ?? FERRY_ENVIRONMENTS[options.environment ?? 'production'];
    this.transport = new Transport({
      baseUrl,
      apiKey: options.apiKey || undefined,
      timeoutMs: options.timeoutMs ?? 30_000,
      retry: {
        maxRetries: options.retry?.maxRetries ?? 2,
        baseDelayMs: options.retry?.baseDelayMs ?? 300,
        maxDelayMs: options.retry?.maxDelayMs ?? 5_000,
      },
      // Bind so environments that require `this === globalThis` keep working.
      fetch: options.fetch ?? fetchImpl.bind(globalThis),
      language: options.language,
      headers: options.headers,
      userAgent: options.userAgent,
      hooks: options.hooks,
      debug: options.debug,
    });

    this.locations = new LocationsResource(this.transport, options.cache?.locationsTtlMs ?? 600_000);
    this.routes = new RoutesResource(this.transport);
    this.operators = new OperatorsResource(this.transport);
    this.voyages = new VoyagesResource(this.transport);
    this.voyageCounts = new VoyageCountsResource(this.transport);
    this.boatLayouts = new BoatLayoutsResource(this.transport);
    this.bookings = new BookingsResource(this.transport);
    this.orders = new OrdersResource(this.transport);
    this.cancelTicketRequests = new CancelTicketRequestsResource(this.transport);
    this.customers = new CustomersResource(this.transport);
    this.organization = new OrganizationResource(this.transport);
    this.transactions = new TransactionsResource(this.transport);
    this.debtLedger = new DebtLedgerResource(this.transport);
    this.vouchers = new VouchersResource(this.transport);
    this.disruptions = new DisruptionsResource(this.transport);
    this.prices = new PricesResource(this.voyages, this.boatLayouts);
    this.bookingDrafts = new BookingDraftsResource(
      this.boatLayouts,
      this.bookings,
      this.voyages,
      this.operators,
      this.vouchers,
    );
  }

  /** Resolved API origin. */
  get baseUrl(): string {
    return this.transport.config.baseUrl;
  }

  /** Whether an API key is configured. */
  get hasApiKey(): boolean {
    return Boolean(this.transport.config.apiKey);
  }

  /**
   * Escape hatch for endpoints without a wrapper (e.g. anything in
   * `openapi/partner.json` outside the typed surface). Same auth, timeout,
   * retry, hooks and error handling as the typed methods.
   *
   * @example
   *   await ferry.request({ method: 'GET', path: '/api/v1/ticket-price-additions', query: { limit: 10 } });
   */
  request<T = unknown>(
    args: { method: HttpMethod; path: string; query?: Record<string, QueryValue>; body?: unknown } & RequestOptions,
  ): Promise<T> {
    if (!args.path.startsWith('/')) throw new FerryConfigError('request path must start with "/"');
    return this.transport.request<T>(args);
  }
}
