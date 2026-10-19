import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  collect,
  errorCodeName,
  FerryAbortError,
  FerryApiError,
  FerryAuthError,
  FerryClient,
  FerryConfigError,
  FerryConflictError,
  FerryErrorCode,
  FerryNotFoundError,
  FerryPermissionError,
  FerryRateLimitError,
  FerryServerError,
  FerryTimeoutError,
  FerryValidationError,
  isValidYmd,
  parseWebhook,
  type RequestInfo,
  redactHeaders,
  safeEqual,
  ticketFileUrls,
  toYmd,
} from '../src/index.js';
import { LOCATIONS } from './fixtures.js';
import { json, mockFetch } from './mock-fetch.js';

async function rejectionOf<E>(p: Promise<unknown>): Promise<E> {
  try {
    await p;
  } catch (e) {
    return e as E;
  }
  throw new Error('expected the promise to reject');
}

const client = (fetch: typeof globalThis.fetch, extra: ConstructorParameters<typeof FerryClient>[0] = {}) =>
  new FerryClient({ apiKey: 'test_key_123456', fetch, retry: { baseDelayMs: 1, maxDelayMs: 50 }, ...extra });

describe('Vietnam dates', () => {
  it('formats Date objects in Vietnam time, not UTC', () => {
    expect(toYmd(new Date('2026-10-19T17:30:00Z'))).toBe('2026-10-20'); // 00:30 in Vietnam
    expect(toYmd(new Date('2026-10-20T16:59:59Z'))).toBe('2026-10-20');
    expect(toYmd(new Date('2026-10-20T17:00:00Z'))).toBe('2026-10-21');
  });
  it('validates YYYY-MM-DD strings as real calendar dates', () => {
    expect(isValidYmd('2028-02-29')).toBe(true);
    expect(isValidYmd('2026-02-29')).toBe(false);
    expect(() => toYmd('20/10/2026')).toThrow(FerryConfigError);
    expect(() => toYmd(new Date('nope'))).toThrow(FerryConfigError);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('sends the Vietnam date for voyage search', async () => {
    const { fetch, calls } = mockFetch(() => json({ data: [], next_cursor: null }));
    await client(fetch).voyages.search({
      date: new Date('2026-10-19T18:00:00Z'),
      departureId: 'a',
      destinationId: 'b',
    });
    expect(calls[0]!.url.searchParams.get('departure_date')).toBe('2026-10-20');
  });
});

describe('client options', () => {
  it('rejects invalid configuration synchronously', () => {
    const f = mockFetch(() => json([])).fetch;
    expect(() => new FerryClient({ fetch: f, timeoutMs: Number.NaN })).toThrow(/timeoutMs/);
    expect(() => new FerryClient({ fetch: f, retry: { maxRetries: 1.5 } })).toThrow(/maxRetries/);
    expect(() => new FerryClient({ fetch: f, baseUrl: 'not a url' })).toThrow(/baseUrl/);
    expect(() => new FerryClient({ fetch: f, baseUrl: 'https://api.ferry.vn/api/v1' })).toThrow(/without \/api\/v1/);
    expect(() => new FerryClient({ fetch: f, environment: 'staging' as 'uat' })).toThrow(/environment/);
    expect(() => new FerryClient({ fetch: f, apiKey: ' key ' })).toThrow(/whitespace/);
  });

  describe('in a browser', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });
    it('refuses an API key unless dangerouslyAllowBrowser is set', () => {
      vi.stubGlobal('window', {});
      vi.stubGlobal('document', {});
      const f = mockFetch(() => json([])).fetch;
      expect(() => new FerryClient({ fetch: f, apiKey: 'k' })).toThrow(/browser/);
      expect(() => new FerryClient({ fetch: f })).not.toThrow();
      expect(() => new FerryClient({ fetch: f, apiKey: 'k', dangerouslyAllowBrowser: true })).not.toThrow();
    });
  });
});

describe('error mapping (all backend body shapes)', () => {
  const err = async (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const { fetch } = mockFetch(() => json(body, status, headers));
    return rejectionOf<FerryApiError>(client(fetch, { retry: { maxRetries: 0 } }).bookings.get('X'));
  };

  it('names domain errors whose message the backend dropped and keeps userMessage', async () => {
    const e = await err(422, {
      status: 422,
      errors: { errorCode: 120120, name: 'InternalErrorResponse' },
      userMessage: 'Số dư không đủ',
    });
    expect(e).toBeInstanceOf(FerryValidationError);
    expect(e.errorCode).toBe(FerryErrorCode.OrganizationBalanceNotEnough);
    expect(e.message).toBe('OrganizationBalanceNotEnough (120120)');
    expect(e.userMessage).toBe('Số dư không đủ');
    expect(errorCodeName(150201)).toBe('UnavailableSeats');
  });

  it('maps statuses to subclasses; 403 is a FerryPermissionError (not an auth failure: the key is fine)', async () => {
    const forbidden = await err(403, { statusCode: 403, message: 'Access denied', error: 'Forbidden' });
    expect(forbidden).toBeInstanceOf(FerryPermissionError);
    expect(forbidden).not.toBeInstanceOf(FerryAuthError);
    expect(await err(409, { status: 409, errors: { errorCode: 160142, name: 'x' } })).toBeInstanceOf(
      FerryConflictError,
    );
    expect(await err(500, { statusCode: 500, message: 'Partial issue failure with revert state' })).toBeInstanceOf(
      FerryServerError,
    );
    expect(await err(404, { statusCode: 404, message: 'x' })).toBeInstanceOf(FerryNotFoundError);
  });

  it('carries the request id and serialises without the response body', async () => {
    const e = await err(422, { status: 422, errors: { phone: 'invalid' } });
    expect(e.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const j = e.toJSON();
    expect(j).toMatchObject({ status: 422, fieldErrors: { phone: 'invalid' }, requestId: e.requestId });
    expect(j).not.toHaveProperty('body');
  });
});

describe('transport', () => {
  it('sends a stable x-request-id across retries (or the caller’s own)', async () => {
    const { fetch, calls } = mockFetch(
      () => json({}, 503),
      () => json([]),
    );
    await client(fetch).locations.list();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers['x-request-id']).toBe(calls[1]!.headers['x-request-id']);
    const own = mockFetch(() => json({ id: 'B' }));
    await client(own.fetch).bookings.get('B', { requestId: 'trace-1' });
    expect(own.calls[0]!.headers['x-request-id']).toBe('trace-1');
  });

  it('does not retry when Retry-After exceeds maxDelayMs', async () => {
    const { fetch, calls } = mockFetch(() =>
      json({ statusCode: 429, message: 'slow down' }, 429, { 'retry-after': '60' }),
    );
    const e = await rejectionOf<FerryRateLimitError>(client(fetch).bookings.list());
    expect(e).toBeInstanceOf(FerryRateLimitError);
    expect(e.retryAfterMs).toBe(60_000);
    expect(calls).toHaveLength(1);
  });

  it('wraps caller aborts in FerryAbortError, before and during the request', async () => {
    const pre = new AbortController();
    pre.abort(new Error('stop'));
    const { fetch, calls } = mockFetch(() => json([]));
    await expect(client(fetch).locations.list({ signal: pre.signal })).rejects.toBeInstanceOf(FerryAbortError);
    expect(calls).toHaveLength(0);

    const during = new AbortController();
    const slow: typeof globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        setTimeout(() => during.abort(), 5);
      });
    await expect(client(slow).bookings.get('B', { signal: during.signal })).rejects.toBeInstanceOf(FerryAbortError);
  });

  it('times out per attempt with FerryTimeoutError', async () => {
    const hang: typeof globalThis.fetch = (_url, init) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(client(hang, { timeoutMs: 10, retry: { maxRetries: 0 } }).bookings.get('B')).rejects.toBeInstanceOf(
      FerryTimeoutError,
    );
  });

  it('calls hooks with redacted headers and survives hook failures', async () => {
    const seen: RequestInfo[] = [];
    const statuses: number[] = [];
    const retries: unknown[] = [];
    const { fetch } = mockFetch(
      () => json({}, 502),
      () => json([]),
    );
    const debug = vi.fn();
    await client(fetch, {
      debug,
      hooks: {
        onRequest: (i) => {
          seen.push(i);
          throw new Error('hook bug');
        },
        onResponse: (i) => {
          statuses.push(i.status);
        },
        onRetry: (i) => {
          retries.push(i.reason);
        },
      },
    }).locations.list();
    expect(seen[0]!.headers.authorization).toBe('Bearer [redacted]');
    expect(JSON.stringify(seen)).not.toContain('test_key_123456');
    expect(statuses).toEqual([502, 200]);
    expect(retries).toEqual([502]);
    expect(JSON.stringify(debug.mock.calls)).not.toContain('test_key_123456');
    expect(redactHeaders({ Cookie: 'a=b', accept: 'x' })).toEqual({ Cookie: '[redacted]', accept: 'x' });
  });
});

describe('resources', () => {
  it('caches locations (one request for several lookups) but never caches failures', async () => {
    const { fetch, calls } = mockFetch(
      () => json({ statusCode: 500, message: 'boom' }, 500),
      () => json(LOCATIONS),
    );
    const ferry = client(fetch, { retry: { maxRetries: 0 } });
    await expect(ferry.locations.find('pq')).rejects.toBeInstanceOf(FerryServerError);
    await ferry.locations.find('phu quoc');
    await ferry.locations.find('Rạch Giá');
    await ferry.locations.list();
    expect(calls).toHaveLength(2);
    const nocache = mockFetch(() => json(LOCATIONS));
    const f2 = client(nocache.fetch, { cache: { locationsTtlMs: 0 } });
    await f2.locations.list();
    await f2.locations.list();
    expect(nocache.calls).toHaveLength(2);
  });

  it('iterates pages with maxItems and maps order to the _id sort', async () => {
    const { fetch, calls } = mockFetch(
      () => json({ data: [{ id: '1' }, { id: '2' }], next_cursor: 'c1' }),
      () => json({ data: [{ id: '3' }], next_cursor: null }),
    );
    const ids = (await collect(client(fetch).bookings.iterate({ limit: 2, order: 'asc', maxItems: 3 }))).map(
      (b) => b.id,
    );
    expect(ids).toEqual(['1', '2', '3']);
    expect(calls[0]!.url.searchParams.get('sort')).toBe('_id:asc');
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('c1');
  });

  it('confirmToIssue: empty body, never retried, 10-minute default timeout', async () => {
    const { fetch, calls } = mockFetch(() => new Response('', { status: 200 }));
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await expect(client(fetch, { timeoutMs: 1000 }).bookings.confirmToIssue('BK1')).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe('/api/v1/bookings/confirmToIssue/BK1');
    expect(spy.mock.calls.some(([, ms]) => ms === 600_000)).toBe(true);
    spy.mockRestore();

    const failing = mockFetch(() => json({}, 503));
    await expect(client(failing.fetch).bookings.confirmToIssue('BK1')).rejects.toBeInstanceOf(FerryApiError);
    expect(failing.calls).toHaveLength(1);
  });

  it('parses reservable credit sent as text, and turns empty 204 answers into FerryNotFoundError', async () => {
    const { fetch } = mockFetch(
      () => new Response('5000000', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect(await client(fetch).organization.reservableCredit()).toBe(5_000_000);
    const empty = mockFetch(() => new Response(null, { status: 204 }));
    await expect(client(empty.fetch).customers.get(7)).rejects.toBeInstanceOf(FerryNotFoundError);
  });

  it('searches customers by local phone without the leading 0 (backend stores +84…)', async () => {
    const { fetch, calls } = mockFetch(() => json({ data: [], next_cursor: null }));
    const ferry = client(fetch);
    await ferry.customers.search('0901 234 567');
    await ferry.customers.search('Nguyễn');
    const filters = calls.map((c) => JSON.parse(c.url.searchParams.get('filters')!));
    expect(filters).toEqual([{ namePhoneEmail: '901234567' }, { namePhoneEmail: 'Nguyễn' }]);
  });

  it('routes the new partner endpoints to the verified paths', async () => {
    const { fetch, calls } = mockFetch(() => json({ data: [], next_cursor: null, isApplicable: false, voucher: null }));
    const ferry = client(fetch);
    await ferry.organization.me();
    await ferry.transactions.list({ filters: { types: ['PB'] } });
    await ferry.debtLedger.list({ filters: { statuses: ['borrowing'] } });
    await ferry.bookings.getPublic('BK1');
    await ferry.bookings.listChildOrgBookings();
    await ferry.bookings.refreshTicketFiles('BK1');
    await ferry.vouchers.checkApplicability({ voucher_code: 'X', order_payload: {} as never });
    await ferry.disruptions.list({ updatedSince: new Date('2026-10-05T00:00:00Z'), state: 'active' });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /api/v1/organizations/me',
      'GET /api/v1/transactions',
      'GET /api/v1/debt-ledger',
      'GET /api/v1/bookings/public/BK1',
      'GET /api/v1/bookings/child-orgs/bookings',
      'GET /api/v1/bookings/download-ticket/BK1',
      'POST /api/v1/vouchers/check-aplicability',
      'GET /api/v1/disruptions',
    ]);
    expect(calls[7]!.url.searchParams.get('updated_since')).toBe('2026-10-05T00:00:00.000Z');
  });

  it('extracts ticket file URLs from a booking', () => {
    expect(
      ticketFileUrls({
        depart_order: { tickets_file: { id: '1', path: 'https://cdn/x.pdf' }, harbor_fee_file: null },
        return_order: null,
      } as never),
    ).toEqual({ depart: { tickets: 'https://cdn/x.pdf' } });
  });
});

describe('webhooks', () => {
  it('parses events by x-event-type (case-insensitive headers, raw or parsed body)', () => {
    const b = parseWebhook({ headers: { 'X-Event-Type': 'booking.issuedTicket' }, body: '{"id":"BK1"}' });
    expect(b).toMatchObject({ category: 'booking', type: 'booking.issuedTicket', data: { id: 'BK1' } });
    const d = parseWebhook({
      headers: new Headers({ 'x-event-type': 'disruption.updated' }),
      body: { event: 'disruption.updated', organization_id: 'o', occurred_at: 'now', data: { id: 'D1' } },
    });
    expect(d.category).toBe('disruption');
    expect(parseWebhook({ headers: { 'x-event-type': 'lead.created' }, body: {} }).category).toBe('other');
    expect(() => parseWebhook({ headers: {}, body: {} })).toThrow(/x-event-type/);
  });
  it('compares secrets in constant time', () => {
    expect(safeEqual('s3cret', 's3cret')).toBe(true);
    expect(safeEqual('s3cret', 's3cres')).toBe(false);
    expect(safeEqual('s3cret', 's3cret-longer')).toBe(false);
  });
});

describe('review regressions', () => {
  it('one caller aborting does not fail another caller sharing the cached locations request', async () => {
    let release: (r: Response) => void = () => {};
    const { fetch, calls } = mockFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const ferry = client(fetch);
    const ac = new AbortController();
    const first = ferry.locations.find('pq', { signal: ac.signal });
    const firstRejects = expect(first).rejects.toBeInstanceOf(FerryAbortError); // attach before it rejects
    const second = ferry.locations.find('phu quoc');
    ac.abort();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release(json(LOCATIONS));
    await firstRejects;
    expect((await second).map((l) => l.abbreviation)).toEqual(['PQ']);
    expect(calls).toHaveLength(1);
  });

  it('paginate stops without fetching another page once maxItems is reached on a page boundary', async () => {
    const { fetch, calls } = mockFetch(() => json({ data: [{ id: '1' }, { id: '2' }], next_cursor: 'next' }));
    const rows = await collect(client(fetch).bookings.iterate({ limit: 2, maxItems: 2 }));
    expect(rows).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });
});
