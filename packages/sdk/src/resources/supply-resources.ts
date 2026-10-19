/**
 * Read-only supply endpoints: locations, routes, operators, voyages,
 * voyage counts and boat layouts (seat maps).
 *
 * Locations, routes and operators are anonymous (`*.public.controller.ts`);
 * the rest require the partner API key.
 */
import { type DateLike, toYmd } from '../dates.js';
import { FerryAbortError } from '../errors.js';
import type { RequestOptions, Transport } from '../http.js';
import { type PaginateOptions, paginate } from '../pagination.js';
import { normalizeText } from '../text.js';
import type {
  BoatLayout,
  BoatLayoutWithAdditions,
  CursorPage,
  CursorParams,
  Location,
  Operator,
  OperatorNational,
  Route,
  RouteFilters,
  SortOrder,
  Voyage,
  VoyageCountSummary,
  VoyageSearchFilters,
  VoyageWithAdditions,
} from '../types.js';
import { requireBody } from './account-resources.js';

const V1 = '/api/v1';
const enc = encodeURIComponent;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

/** Settle with `promise`, or reject with `FerryAbortError` as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal, path: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new FerryAbortError('GET', path, signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new FerryAbortError('GET', path, signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export class LocationsResource {
  private cache: { at: number; value: Promise<Location[]> } | undefined;

  constructor(
    private readonly t: Transport,
    /** How long `list()` results are reused, in ms (0 disables caching). */
    private readonly cacheTtlMs: number,
  ) {}

  /**
   * `GET /api/v1/locations` — all ports/islands/cities. Anonymous.
   * Cached in memory for `cache.locationsTtlMs` (default 10 minutes) because
   * locations change rarely and every name lookup needs the full list
   * (the backend only sorts by creation, so no sort option is offered).
   */
  list(opts: RequestOptions = {}): Promise<Location[]> {
    const { signal, ...rest } = opts;
    // Per-call options other than the signal (timeouts, headers, request id) bypass the shared cache.
    if (this.cacheTtlMs <= 0 || Object.values(rest).some((v) => v !== undefined)) return this.fetchList(opts);
    if (signal?.aborted) return Promise.reject(new FerryAbortError('GET', `${V1}/locations`, signal.reason));
    const now = Date.now();
    if (!this.cache || now - this.cache.at > this.cacheTtlMs) {
      // The shared request is made without any caller's signal, so one caller aborting cannot fail the others.
      const value = this.fetchList({});
      this.cache = { at: now, value };
      // Never cache a failure.
      value.catch(() => {
        if (this.cache?.value === value) this.cache = undefined;
      });
    }
    // Hand every caller its own array: one caller sorting it must not reorder it for the others.
    const copy = this.cache.value.then((list) => [...list]);
    return signal ? abortable(copy, signal, `${V1}/locations`) : copy;
  }

  private fetchList(opts: RequestOptions): Promise<Location[]> {
    return this.t.request<Location[]>({ method: 'GET', path: `${V1}/locations`, ...opts });
  }

  /** Drop the cached location list. */
  clearCache(): void {
    this.cache = undefined;
  }

  /**
   * Find locations by id, abbreviation or (accent-insensitive) name.
   * Exact id/abbreviation/name matches win over substring matches.
   * e.g. `find('phu quoc')`, `find('Rạch Giá')`, `find('PQ')`.
   */
  async find(query: string, opts: RequestOptions = {}): Promise<Location[]> {
    const q = normalizeText(query);
    if (!q) return [];
    const all = await this.list(opts);
    const exact = all.filter(
      (l) => l.id === query || normalizeText(l.abbreviation ?? '') === q || normalizeText(l.location_name ?? '') === q,
    );
    if (exact.length) return exact;
    if (OBJECT_ID.test(query)) return [];
    return all.filter((l) => normalizeText(l.location_name ?? '').includes(q));
  }
}

export class RoutesResource {
  constructor(private readonly t: Transport) {}

  /** `GET /api/v1/routes` — cursor-paginated routes (max 100 per page). Anonymous. */
  list(
    params: CursorParams & { filters?: RouteFilters; order?: SortOrder } = {},
    opts: RequestOptions = {},
  ): Promise<CursorPage<Route>> {
    return this.t.request({
      method: 'GET',
      path: `${V1}/routes`,
      query: {
        cursor: params.cursor,
        limit: params.limit,
        filters: params.filters,
        sort: params.order ? `_id:${params.order}` : undefined,
      },
      ...opts,
    });
  }

  /** Iterate every route across pages. */
  iterate(
    params: Omit<CursorParams, 'cursor'> & { filters?: RouteFilters; order?: SortOrder } & PaginateOptions = {},
    opts: RequestOptions = {},
  ): AsyncGenerator<Route, void, undefined> {
    const { maxPages, maxItems, ...rest } = params;
    return paginate((cursor) => this.list({ ...rest, cursor }, opts), { maxPages, maxItems });
  }

  /** `GET /api/v1/routes/:id` (numeric route id). Anonymous. */
  async get(id: number | string, opts: RequestOptions = {}): Promise<Route> {
    // An unknown id answers an empty 200 (`null`).
    const path = `${V1}/routes/${enc(String(id))}`;
    return requireBody(await this.t.request<Route>({ method: 'GET', path, ...opts }), `route ${id}`, path);
  }
}

export class OperatorsResource {
  constructor(private readonly t: Transport) {}

  /** `GET /api/v1/operators` — ferry operators (hãng tàu). Anonymous. */
  list(params: { filters?: Record<string, unknown> } = {}, opts: RequestOptions = {}): Promise<Operator[]> {
    return this.t.request({ method: 'GET', path: `${V1}/operators`, query: { filters: params.filters }, ...opts });
  }

  /** `GET /api/v1/operators/nationals/:operatorId` — nationality list for `national_id` on tickets. Anonymous. */
  nationals(operatorId: string, opts: RequestOptions = {}): Promise<OperatorNational[]> {
    return this.t.request({ method: 'GET', path: `${V1}/operators/nationals/${enc(operatorId)}`, ...opts });
  }
}

export interface VoyageSearchParams extends CursorParams {
  /** Departure location id (from `locations.list()` / `locations.find()`). */
  departureId?: string | undefined;
  /** Destination location id. Omit together with `departureId` to query every voyage. */
  destinationId?: string | undefined;
  filters?: VoyageSearchFilters | undefined;
}

export class VoyagesResource {
  constructor(private readonly t: Transport) {}

  /**
   * `GET /api/v1/voyages/findAllRelateByLocationAndDate` — voyages on one date
   * (Vietnam calendar day; `Date` objects are converted to Vietnam time).
   * Data is pre-synced from operators (not real-time). Max 50 per page.
   */
  search(
    params: VoyageSearchParams & { date: DateLike },
    opts: RequestOptions = {},
  ): Promise<CursorPage<VoyageWithAdditions>> {
    return this.t.request({
      method: 'GET',
      path: `${V1}/voyages/findAllRelateByLocationAndDate`,
      query: {
        departure_date: toYmd(params.date),
        departure_id: params.departureId,
        destination_id: params.destinationId,
        // The backend DTO marks `filters` as required; send `{}` when unused.
        filters: params.filters ?? {},
        cursor: params.cursor,
        limit: params.limit,
      },
      ...opts,
    });
  }

  /** `GET /api/v1/voyages/findAllRelateByLocationAndDateRange` — voyages between two dates (inclusive). */
  searchRange(
    params: VoyageSearchParams & { from: DateLike; to: DateLike },
    opts: RequestOptions = {},
  ): Promise<CursorPage<VoyageWithAdditions>> {
    return this.t.request({
      method: 'GET',
      path: `${V1}/voyages/findAllRelateByLocationAndDateRange`,
      query: {
        from: toYmd(params.from),
        to: toYmd(params.to),
        departure_id: params.departureId,
        destination_id: params.destinationId,
        filters: params.filters ?? {},
        cursor: params.cursor,
        limit: params.limit,
      },
      ...opts,
    });
  }

  /** Iterate every voyage of a date (or a range when `to` is given) across pages. */
  iterate(
    params: Omit<VoyageSearchParams, 'cursor'> &
      ({ date: DateLike } | { from: DateLike; to: DateLike }) &
      PaginateOptions,
    opts: RequestOptions = {},
  ): AsyncGenerator<VoyageWithAdditions, void, undefined> {
    const { maxPages, maxItems, ...rest } = params;
    return paginate(
      (cursor) =>
        'date' in rest ? this.search({ ...rest, cursor }, opts) : this.searchRange({ ...rest, cursor }, opts),
      { maxPages, maxItems },
    );
  }

  /** `GET /api/v1/voyages/:id`. */
  get(id: string, opts: RequestOptions = {}): Promise<Voyage> {
    return this.t.request({ method: 'GET', path: `${V1}/voyages/${enc(id)}`, ...opts });
  }
}

export class VoyageCountsResource {
  constructor(private readonly t: Transport) {}

  /**
   * `GET /api/v1/voyage-counts` — number of voyages (and available ones) per
   * departure date between `from` and `to` (both required by the backend).
   */
  list(
    params: { departureId?: string; destinationId?: string; from: DateLike; to: DateLike },
    opts: RequestOptions = {},
  ): Promise<VoyageCountSummary[]> {
    return this.t.request({
      method: 'GET',
      path: `${V1}/voyage-counts`,
      query: {
        departure_id: params.departureId,
        destination_id: params.destinationId,
        depart_date_from: toYmd(params.from),
        depart_date_to: toYmd(params.to),
      },
      ...opts,
    });
  }
}

function requireLayout(
  body: BoatLayoutWithAdditions | undefined,
  voyageId: string,
  path: string,
): BoatLayoutWithAdditions {
  // An empty body — or, defensively, a wrapper without a layout — means "no seat map".
  const layout = typeof body === 'object' && body !== null && !body.boatLayout ? undefined : body;
  return requireBody(layout, `seat map of voyage ${voyageId}`, path);
}

export class BoatLayoutsResource {
  constructor(private readonly t: Transport) {}

  /**
   * `GET /api/v1/boatLayouts/latestByVoyageId` — freshest seat map (cached
   * server-side, cron-refreshed). A disabled voyage answers 422 `VoyageIsDisabled`;
   * a voyage without a seat map answers an empty body → `FerryNotFoundError`.
   */
  async latestByVoyageId(voyageId: string, opts: RequestOptions = {}): Promise<BoatLayoutWithAdditions> {
    const path = `${V1}/boatLayouts/latestByVoyageId`;
    const body = await this.t.request<BoatLayoutWithAdditions>({
      method: 'GET',
      path,
      query: { voyage_id: voyageId },
      ...opts,
    });
    return requireLayout(body, voyageId, path);
  }

  /**
   * `GET /api/v1/boatLayouts/byVoyageId` — stored seat map of a voyage (also for
   * disabled voyages). No stored map → `FerryNotFoundError`.
   */
  async byVoyageId(voyageId: string, opts: RequestOptions = {}): Promise<BoatLayoutWithAdditions> {
    const path = `${V1}/boatLayouts/byVoyageId`;
    const body = await this.t.request<BoatLayoutWithAdditions>({
      method: 'GET',
      path,
      query: { voyage_id: voyageId },
      ...opts,
    });
    return requireLayout(body, voyageId, path);
  }

  /** `GET /api/v1/boatLayouts/:id` (an unknown id answers an empty 204 → `FerryNotFoundError`). */
  async get(id: string, opts: RequestOptions = {}): Promise<BoatLayout> {
    const path = `${V1}/boatLayouts/${enc(id)}`;
    return requireBody(await this.t.request<BoatLayout>({ method: 'GET', path, ...opts }), `boat layout ${id}`, path);
  }
}
