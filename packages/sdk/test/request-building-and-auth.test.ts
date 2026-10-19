import { describe, expect, it } from 'vitest';
import { buildUrl, encodeQueryValue } from '../src/http.js';
import { FERRY_ENVIRONMENTS, FerryClient } from '../src/index.js';
import { json, mockFetch } from './mock-fetch.js';

describe('request building', () => {
  it('defaults to the production origin and prefixes /api/v1', async () => {
    const m = mockFetch(() => json([]));
    const ferry = new FerryClient({ fetch: m.fetch });
    await ferry.locations.list();
    expect(ferry.baseUrl).toBe(FERRY_ENVIRONMENTS.production);
    expect(m.calls[0]!.url.toString()).toBe('https://api.ferry.vn/api/v1/locations');
  });

  it('supports environment and baseUrl overrides (trailing slash tolerated)', async () => {
    const m = mockFetch(() => json([]));
    await new FerryClient({ fetch: m.fetch, environment: 'uat' }).locations.list();
    await new FerryClient({ fetch: m.fetch, baseUrl: 'http://localhost:3000/' }).locations.list();
    expect(m.calls[0]!.url.origin).toBe('https://api.ferryvn.net');
    expect(m.calls[1]!.url.toString()).toBe('http://localhost:3000/api/v1/locations');
  });

  it('maps voyage search params to backend query names and JSON-encodes filters', async () => {
    const m = mockFetch(() => json({ data: [], next_cursor: null }));
    const ferry = new FerryClient({ fetch: m.fetch, apiKey: 'k' });
    await ferry.voyages.search({
      date: new Date('2026-10-20T05:00:00Z'),
      departureId: 'A',
      destinationId: 'B',
      filters: { min_depart_time: '08:00:00' },
      limit: 20,
    });
    const u = m.calls[0]!.url;
    expect(u.pathname).toBe('/api/v1/voyages/findAllRelateByLocationAndDate');
    expect(u.searchParams.get('departure_date')).toBe('2026-10-20');
    expect(u.searchParams.get('departure_id')).toBe('A');
    expect(u.searchParams.get('destination_id')).toBe('B');
    expect(JSON.parse(u.searchParams.get('filters')!)).toEqual({ min_depart_time: '08:00:00' });
    expect(u.searchParams.get('limit')).toBe('20');
    expect(u.searchParams.has('cursor')).toBe(false);
  });

  it('always sends filters={} for voyage search (backend DTO requires it)', async () => {
    const m = mockFetch(() => json({ data: [], next_cursor: null }));
    await new FerryClient({ fetch: m.fetch }).voyages.searchRange({ from: '2026-10-01', to: '2026-10-03' });
    const u = m.calls[0]!.url;
    expect(u.pathname).toBe('/api/v1/voyages/findAllRelateByLocationAndDateRange');
    expect(u.searchParams.get('filters')).toBe('{}');
    expect(u.searchParams.get('from')).toBe('2026-10-01');
    expect(u.searchParams.get('to')).toBe('2026-10-03');
  });

  it('builds seat-map, booking and cancel requests with the exact backend paths', async () => {
    const m = mockFetch((c) => json(c.url.pathname.includes('boatLayouts') ? { boatLayout: { id: 'BL' } } : {}));
    const ferry = new FerryClient({ fetch: m.fetch, apiKey: 'k' });
    await ferry.boatLayouts.latestByVoyageId('V 1');
    await ferry.boatLayouts.byVoyageId('V1');
    await ferry.bookings.get('BK/1');
    await ferry.bookings.create({ customer_id: 1, orderer_name: 'A', contact_email: 'a@b.c' });
    await ferry.cancelTicketRequests.create({ order_id: 'O1', cancel_reason: 'r', cancel_ticket_by_positions: ['1'] });
    await ferry.orders.list();
    expect(m.calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      'GET /api/v1/boatLayouts/latestByVoyageId?voyage_id=V+1',
      'GET /api/v1/boatLayouts/byVoyageId?voyage_id=V1',
      'GET /api/v1/bookings/BK%2F1',
      'POST /api/v1/bookings',
      'POST /api/v1/cancel-ticket-request',
      'GET /api/v1/orders?limit=10',
    ]);
    expect(m.calls[3]!.body).toEqual({ customer_id: 1, orderer_name: 'A', contact_email: 'a@b.c' });
    expect(m.calls[3]!.headers['content-type']).toBe('application/json');
  });

  it('encodes query values', () => {
    expect(encodeQueryValue(['a'])).toBe('["a"]');
    expect(encodeQueryValue(true)).toBe('true');
    expect(buildUrl('https://x.test', '/p', { a: undefined, b: null, c: 1 })).toBe('https://x.test/p?c=1');
  });
});

describe('auth', () => {
  it('sends the API key as Authorization: Bearer (passport-http-bearer)', async () => {
    const m = mockFetch(() => json({}));
    await new FerryClient({ fetch: m.fetch, apiKey: 'ferry_abc_secret' }).bookings.get('1');
    expect(m.calls[0]!.headers.authorization).toBe('Bearer ferry_abc_secret');
    expect(m.calls[0]!.headers.accept).toBe('application/json');
  });

  it('omits Authorization when no key is configured and sends language header', async () => {
    const m = mockFetch(() => json([]));
    await new FerryClient({ fetch: m.fetch, language: 'vi' }).locations.list();
    expect(m.calls[0]!.headers.authorization).toBeUndefined();
    expect(m.calls[0]!.headers['x-custom-lang']).toBe('vi');
  });
});
