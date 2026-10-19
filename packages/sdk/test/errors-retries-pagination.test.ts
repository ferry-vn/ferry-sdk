import { describe, expect, it } from 'vitest';
import { backoffDelay, parseRetryAfter } from '../src/http.js';
import {
  FerryApiError,
  FerryAuthError,
  FerryClient,
  FerryNetworkError,
  FerryNotFoundError,
  FerryRateLimitError,
  FerryTimeoutError,
  FerryValidationError,
  paginate,
} from '../src/index.js';
import { json, mockFetch } from './mock-fetch.js';

const fast = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 };

describe('error mapping', () => {
  it('maps 401 { statusCode, message } to FerryAuthError', async () => {
    const m = mockFetch(() => json({ statusCode: 401, message: 'Invalid API Key', timestamp: 't', path: '/x' }, 401));
    const err = await new FerryClient({ fetch: m.fetch, apiKey: 'bad' }).bookings.get('1').catch((e) => e);
    expect(err).toBeInstanceOf(FerryAuthError);
    expect(err).toBeInstanceOf(FerryApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe('Invalid API Key');
    expect(err.method).toBe('GET');
  });

  it('maps a raw domain error { errors: { name, errorCode, message } } with errorCode', async () => {
    const m = mockFetch(() =>
      json(
        {
          status: 422,
          errors: { name: 'InternalErrorResponse', errorCode: 120101, message: 'CustomerBalanceNotEnough' },
        },
        422,
      ),
    );
    const err = (await new FerryClient({ fetch: m.fetch, apiKey: 'k' }).bookings
      .confirmToIssue('B1')
      .catch((e: unknown) => e)) as FerryValidationError;
    expect(err).toBeInstanceOf(FerryValidationError);
    expect(err.errorCode).toBe(120101);
    expect(err.errorName).toBe('InternalErrorResponse');
    expect(err.message).toBe('CustomerBalanceNotEnough');
  });

  it('maps validation errors { status, errors: { field: reason } } to fieldErrors', async () => {
    const m = mockFetch(() =>
      json({ status: 422, errors: { customer_id: 'customer_id must be a positive number' } }, 422),
    );
    const err = await new FerryClient({ fetch: m.fetch, apiKey: 'k' }).bookings
      .create({ customer_id: 0, orderer_name: 'a', contact_email: 'a' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(FerryValidationError);
    expect(err.fieldErrors).toEqual({ customer_id: 'customer_id must be a positive number' });
    expect(err.message).toContain('customer_id');
    expect(err.errorCode).toBeUndefined();
  });

  it('joins ValidationPipe-style message arrays, maps 404 and non-JSON bodies', async () => {
    const m = mockFetch(
      () => json({ statusCode: 400, message: ['a is bad', 'b is bad'], error: 'Bad Request' }, 400),
      () => json({ statusCode: 404, message: 'Not found' }, 404),
      () => new Response('upstream exploded', { status: 500 }),
    );
    const ferry = new FerryClient({ fetch: m.fetch, retry: { maxRetries: 0 } });
    const e1 = await ferry.routes.get(1).catch((e) => e);
    const e2 = await ferry.routes.get(2).catch((e) => e);
    const e3 = await ferry.routes.get(3).catch((e) => e);
    expect(e1.message).toBe('a is bad; b is bad');
    expect(e2).toBeInstanceOf(FerryNotFoundError);
    expect(e3.status).toBe(500);
    expect(e3.message).toBe('upstream exploded');
  });
});

describe('retries', () => {
  it('retries idempotent GETs on 503 then succeeds', async () => {
    const m = mockFetch(
      () => json({ message: 'down' }, 503),
      () => json({ message: 'down' }, 503),
      () => json([{ id: 'L1' }]),
    );
    const res = await new FerryClient({ fetch: m.fetch, retry: fast }).locations.list();
    expect(res).toEqual([{ id: 'L1' }]);
    expect(m.calls).toHaveLength(3);
  });

  it('retries GETs on network errors and gives up with FerryNetworkError', async () => {
    const m = mockFetch(() => new TypeError('fetch failed'));
    const err = await new FerryClient({ fetch: m.fetch, retry: fast }).locations.list().catch((e) => e);
    expect(err).toBeInstanceOf(FerryNetworkError);
    expect(m.calls).toHaveLength(3);
  });

  it('never retries POST (booking creation is not idempotent server-side)', async () => {
    const m = mockFetch(() => json({ message: 'down' }, 503));
    const err = await new FerryClient({ fetch: m.fetch, apiKey: 'k', retry: fast }).bookings
      .create({ customer_id: 1, orderer_name: 'a', contact_email: 'a' })
      .catch((e) => e);
    expect(err.status).toBe(503);
    expect(m.calls).toHaveLength(1);

    const n = mockFetch(() => new TypeError('reset'));
    await new FerryClient({ fetch: n.fetch, apiKey: 'k', retry: fast }).bookings.confirmToIssue('B').catch(() => {});
    expect(n.calls).toHaveLength(1);
  });

  it('does not retry 4xx (other than 408/429)', async () => {
    const m = mockFetch(() => json({ message: 'nope' }, 400));
    await new FerryClient({ fetch: m.fetch, retry: fast }).locations.list().catch(() => {});
    expect(m.calls).toHaveLength(1);
  });

  it('honours Retry-After on 429 and surfaces FerryRateLimitError when exhausted', async () => {
    const m = mockFetch(() => json({ message: 'slow down' }, 429, { 'retry-after': '0' }));
    const err = await new FerryClient({ fetch: m.fetch, retry: fast }).locations.list().catch((e) => e);
    expect(err).toBeInstanceOf(FerryRateLimitError);
    expect(err.retryAfterMs).toBe(0);
    expect(m.calls).toHaveLength(3);
  });

  it('times out slow requests with FerryTimeoutError', async () => {
    const slow: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const err = await new FerryClient({ fetch: slow, timeoutMs: 20, retry: { maxRetries: 0 } }).locations
      .list()
      .catch((e) => e);
    expect(err).toBeInstanceOf(FerryTimeoutError);
    expect(err.timeoutMs).toBe(20);
  });

  it('computes bounded jittered backoff and parses Retry-After', () => {
    const r = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 };
    expect(backoffDelay(0, r, () => 0)).toBe(50);
    expect(backoffDelay(1, r, () => 1)).toBe(200);
    expect(backoffDelay(10, r, () => 1)).toBe(1000);
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('paginate', () => {
  it('follows next_cursor until null', async () => {
    const m = mockFetch(
      () => json({ data: [{ id: 1 }, { id: 2 }], next_cursor: 'c2' }),
      () => json({ data: [{ id: 3 }], next_cursor: null }),
    );
    const ferry = new FerryClient({ fetch: m.fetch, apiKey: 'k' });
    const ids: unknown[] = [];
    for await (const b of paginate((cursor) => ferry.bookings.list({ cursor, limit: 2 }))) ids.push(b.id);
    expect(ids).toEqual([1, 2, 3]);
    expect(m.calls[1]!.url.searchParams.get('cursor')).toBe('c2');
  });

  it('cancelTicketRequests.get filters list() by id (no partner GET /:id)', async () => {
    const m = mockFetch(() => json({ data: [{ id: 'CR1' }], next_cursor: null }));
    const res = await new FerryClient({ fetch: m.fetch, apiKey: 'k' }).cancelTicketRequests.get('CR1');
    expect(res).toEqual({ id: 'CR1' });
    expect(m.calls[0]!.url.pathname).toBe('/api/v1/cancel-ticket-request');
    expect(JSON.parse(m.calls[0]!.url.searchParams.get('filters')!)).toEqual({ ids: ['CR1'] });
  });
});
