/** Regressions for the pre-release audit of the SDK core (2026-10-18). */
import { describe, expect, it } from 'vitest';
import {
  addDays,
  FerryAbortError,
  type FerryApiError,
  FerryClient,
  FerryConfigError,
  FerryError,
  FerryNetworkError,
  FerryNotFoundError,
  parseWebhook,
  redactHeaders,
  vietnamDayEnd,
  vietnamDayStart,
} from '../src/index.js';
import { json, mockFetch } from './mock-fetch.js';

/** The rejection of `promise` (fails the test when it resolves). */
const rejection = <E>(promise: Promise<unknown>): Promise<E> =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e as E,
  );

describe('transport', () => {
  it('redacts cookies and API keys entirely and keeps only the auth scheme', () => {
    expect(
      redactHeaders({
        Authorization: 'Bearer secret',
        'proxy-authorization': 'Basic abc',
        cookie: 'session=SECRET123; other=x',
        'x-api-key': 'k',
        accept: 'application/json',
      }),
    ).toEqual({
      Authorization: 'Bearer [redacted]',
      'proxy-authorization': 'Basic [redacted]',
      cookie: '[redacted]',
      'x-api-key': '[redacted]',
      accept: 'application/json',
    });
  });

  it('honours an abort that happens while an async onRequest hook runs', async () => {
    const { fetch, calls } = mockFetch(() => json([]));
    const controller = new AbortController();
    const ferry = new FerryClient({
      fetch,
      hooks: {
        onRequest: async () => {
          controller.abort();
          await new Promise((r) => setTimeout(r, 5));
        },
      },
    });
    await expect(ferry.locations.list({ signal: controller.signal, timeoutMs: 1000 })).rejects.toBeInstanceOf(
      FerryAbortError,
    );
    expect(calls).toHaveLength(0);
  });

  it('validates per-call timeouts and retries', async () => {
    const ferry = new FerryClient({ fetch: mockFetch(() => json([])).fetch });
    await expect(ferry.operators.list({}, { timeoutMs: -1 })).rejects.toBeInstanceOf(FerryConfigError);
    await expect(ferry.operators.list({}, { maxRetries: 1.5 })).rejects.toBeInstanceOf(FerryConfigError);
  });

  it('keeps query strings (search terms, phone numbers) out of error messages and toJSON()', async () => {
    const failing = new FerryClient({
      apiKey: 'k',
      retry: { maxRetries: 0 },
      fetch: (async () => {
        throw new TypeError('socket hang up');
      }) as typeof fetch,
    });
    const err = await failing.customers.search('0901234567').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FerryNetworkError);
    expect((err as Error).message).not.toContain('901234567');

    const { fetch } = mockFetch(() => json({ statusCode: 500, message: 'boom' }, 500));
    const api = await rejection<FerryApiError>(
      new FerryClient({ apiKey: 'k', fetch, retry: { maxRetries: 0 } }).bookings.list({
        filters: { namePhoneEmail: '0901234567' },
      }),
    );
    expect(JSON.stringify(api.toJSON())).not.toContain('0901234567');
    expect(api.url).toContain('0901234567'); // still available on purpose
  });

  it('does not turn an HTML error page into the message, and reads string error codes', async () => {
    const html = mockFetch(
      () =>
        new Response(`<html><body>${'x'.repeat(3000)}</body></html>`, {
          status: 502,
          statusText: 'Bad Gateway',
          headers: { 'content-type': 'text/html' },
        }),
    );
    const e1 = await rejection<FerryApiError>(
      new FerryClient({ fetch: html.fetch, retry: { maxRetries: 0 } }).operators.list(),
    );
    expect(e1.message).toBe('Bad Gateway');

    const nf = mockFetch(() =>
      json({ statusCode: 404, errorCode: 'DISRUPTION_NOT_FOUND', message: 'No such incident' }, 404),
    );
    const e2 = await rejection<FerryApiError>(new FerryClient({ apiKey: 'k', fetch: nf.fetch }).disruptions.get('X'));
    expect(e2).toBeInstanceOf(FerryNotFoundError);
    expect(e2.errorCode).toBe('DISRUPTION_NOT_FOUND');
  });
});

describe('resources', () => {
  it('turns the empty body of an unknown route / order / voucher / booking into FerryNotFoundError', async () => {
    const { fetch } = mockFetch(() => new Response('', { status: 200 }));
    const ferry = new FerryClient({ apiKey: 'k', fetch });
    for (const call of [
      () => ferry.routes.get(999999),
      () => ferry.orders.get('O1'),
      () => ferry.vouchers.get('V1'),
      () => ferry.bookings.get('B1'),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(FerryNotFoundError);
    }
  });

  it('cancelTicketRequests.get throws FerryNotFoundError for an unknown id', async () => {
    const { fetch } = mockFetch(() => json({ data: [], next_cursor: null }));
    await expect(new FerryClient({ apiKey: 'k', fetch }).cancelTicketRequests.get('NOPE')).rejects.toBeInstanceOf(
      FerryNotFoundError,
    );
  });

  it('sends Vietnam-day bounds for createdAt filters on bookings and transactions', async () => {
    const { fetch, calls } = mockFetch(() => json({ data: [], next_cursor: null }));
    const ferry = new FerryClient({ apiKey: 'k', fetch });
    await ferry.bookings.list({ filters: { createdAtFrom: '2026-10-18', createdAtTo: '2026-10-18' } });
    await ferry.transactions.list({ filters: { createdAtFrom: '2026-10-18T05:00:00Z' } });
    expect(JSON.parse(calls[0]!.url.searchParams.get('filters')!)).toEqual({
      createdAtFrom: '2026-10-18T00:00:00.000+07:00',
      createdAtTo: '2026-10-18T23:59:59.999+07:00',
    });
    // Exact instants pass through untouched.
    expect(JSON.parse(calls[1]!.url.searchParams.get('filters')!)).toEqual({ createdAtFrom: '2026-10-18T05:00:00Z' });
    expect([vietnamDayStart('2026-10-18'), vietnamDayEnd('2026-10-18')]).toEqual([
      '2026-10-18T00:00:00.000+07:00',
      '2026-10-18T23:59:59.999+07:00',
    ]);
  });

  it('refreshTicketFiles is never retried (it re-downloads from the operator)', async () => {
    const { fetch, calls } = mockFetch(() => json({ statusCode: 503 }, 503));
    await new FerryClient({ apiKey: 'k', fetch }).bookings.refreshTicketFiles('B1').catch(() => {});
    expect(calls).toHaveLength(1);
  });

  it('routes.list sorts with order like the other lists; locations callers get their own array', async () => {
    const { fetch, calls } = mockFetch((c) =>
      c.url.pathname.endsWith('/locations') ? json([{ id: 'b' }, { id: 'a' }]) : json({ data: [], next_cursor: null }),
    );
    const ferry = new FerryClient({ fetch });
    await ferry.routes.list({ order: 'desc' });
    expect(calls[0]!.url.searchParams.get('sort')).toBe('_id:desc');
    const first = await ferry.locations.list();
    first.sort((x, y) => x.id.localeCompare(y.id));
    expect((await ferry.locations.list()).map((l) => l.id)).toEqual(['b', 'a']);
  });
});

describe('helpers throw FerryError subclasses', () => {
  it('parseWebhook and addDays', () => {
    expect(() => parseWebhook({ headers: {}, body: {} })).toThrow(FerryError);
    expect(() => parseWebhook({ headers: { 'x-event-type': 'booking.created' }, body: '{oops' })).toThrow(FerryError);
    expect(() => addDays('2026-10-18', Number.NaN)).toThrow(FerryConfigError);
  });
});
