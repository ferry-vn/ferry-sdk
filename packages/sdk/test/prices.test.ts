import { describe, expect, it } from 'vitest';
import {
  type BoatLayoutWithAdditions,
  FerryClient,
  FerryError,
  MAX_LIVE_SEAT_MAPS,
  type Voyage,
  voyagePriceEntries,
} from '../src/index.js';
import prod from './fixtures/prod-supply.json' with { type: 'json' };
import { json, mockFetch } from './mock-fetch.js';

interface Fixture {
  voyage: Voyage;
  layout: BoatLayoutWithAdditions;
}
const fx = (op: 'thanhthoi' | 'superdong' | 'binhanhatien'): Fixture =>
  structuredClone((prod as unknown as Record<string, Fixture>)[op]!);
// Move the captured voyages to the future so they count as bookable.
const future = (v: Voyage, time: string, extra: Partial<Voyage> = {}): Voyage => ({
  ...v,
  departure_date: '2036-10-20',
  depart_time: time,
  disable: false,
  ...extra,
});

describe('voyagePriceEntries', () => {
  it('lists passenger prices with harbor fee and age rules, hiding vehicle places and free tickets', () => {
    const sd = fx('superdong');
    const tp = sd.voyage.ticket_prices as never as { prices: never[]; ticket_type_configs: never[] };
    const entries = voyagePriceEntries(sd.voyage, tp.prices, tp.ticket_type_configs);
    expect(entries.every((e) => e.harborFeeVnd === 18000 && e.totalVnd === e.priceVnd + 18000)).toBe(true);
    expect(entries.find((e) => e.ticketTypeId === 4)).toMatchObject({ rules: 'MIN_AGE 1, MAX_AGE 11' });
    expect(entries.find((e) => e.ticketTypeId === 2)?.rules).toBe('MIN_AGE 60, MAX_AGE 250, NATIONAL_ID VN');
    // Superdong prices invitation (5) and disability (3) tickets but has no rules for them:
    // the server refuses them, so they are hidden and do not count as the cheapest ticket.
    expect(entries.map((e) => e.ticketTypeId).sort()).toEqual([1, 2, 4]);
    const all = voyagePriceEntries(sd.voyage, tp.prices, tp.ticket_type_configs, { includeAllTicketTypes: true });
    expect(
      all
        .filter((e) => !e.bookable)
        .map((e) => e.ticketTypeId)
        .sort(),
    ).toEqual([3, 5]);

    const tt = fx('thanhthoi');
    const ttp = tt.layout.boatLayout.prices;
    expect(voyagePriceEntries(tt.voyage, ttp, []).map((e) => e.seatType)).not.toContain('Xe gắn máy');
    expect(voyagePriceEntries(tt.voyage, ttp, [], { includeVehicles: true }).some((e) => e.vehicle)).toBe(true);
    const gl = [{ ...ttp.find((p) => p.seat_type === 'thuong')!, price_with_VAT: 0 }];
    expect(voyagePriceEntries(tt.voyage, gl, [])).toEqual([]);
    expect(voyagePriceEntries(tt.voyage, gl, [], { includeAllTicketTypes: true })).toMatchObject([{ bookable: false }]);
  });
});

describe('ferry.prices.forRoute', () => {
  const tt = fx('thanhthoi');
  const sd = fx('superdong');
  const voyages = [
    future(tt.voyage, '14:45:00'),
    future(sd.voyage, '08:00:00'),
    future(sd.voyage, '06:00:00', { id: 'OFF', disable: true }),
    future(sd.voyage, '08:00:00'), // the same voyage twice (range searches can repeat)
  ];
  const routes = (call: { url: URL }) => {
    const p = call.url.pathname;
    if (p === '/api/v1/voyages/findAllRelateByLocationAndDate')
      return json({ data: voyages.map((voyage) => ({ voyage })), next_cursor: null });
    if (p === '/api/v1/boatLayouts/latestByVoyageId') {
      const id = call.url.searchParams.get('voyage_id');
      if (id === tt.voyage.id) return json(tt.layout);
      return json({ status: 422, errors: { boatLayout: 'CanNotGetBoatVoyage' } }, 422);
    }
    return json({ statusCode: 404 }, 404);
  };

  it('returns one sorted, de-duplicated row per bookable voyage from search data', async () => {
    const { fetch, calls } = mockFetch(routes);
    const res = await new FerryClient({ apiKey: 'k', fetch }).prices.forRoute({
      departureId: 'A',
      destinationId: 'B',
      date: '2036-10-20',
    });
    expect(res.voyages.map((v) => [v.voyageId, v.departure, v.source])).toEqual([
      [sd.voyage.id, '2036-10-20 08:00', 'search'],
      [tt.voyage.id, '2036-10-20 14:45', 'search'],
    ]);
    expect(res.hiddenUnavailable).toBe(1);
    // Thạnh Thới's synced price for an ordinary seat is 290 000 ₫; vehicle places are left out.
    const thuong = res.voyages[1]!.prices.find((p) => p.seatType === 'thuong' && p.ticketTypeId === 1)!;
    expect(thuong.priceVnd).toBe(290000);
    expect(res.voyages[1]!.prices.some((p) => p.vehicle)).toBe(false);
    expect(res.voyages[0]!.fromVnd).toBe(Math.min(...res.voyages[0]!.prices.map((p) => p.totalVnd)));
    expect(calls.every((c) => c.url.pathname.endsWith('findAllRelateByLocationAndDate'))).toBe(true);
  });

  it('live re-prices the first voyages from their seat map and keeps search prices when it fails', async () => {
    const { fetch, calls } = mockFetch(routes);
    const res = await new FerryClient({ apiKey: 'k', fetch, retry: { maxRetries: 0 } }).prices.forRoute({
      departureId: 'A',
      destinationId: 'B',
      date: '2036-10-20',
      live: 2,
    });
    const [superdong, thanhthoi] = res.voyages;
    expect(superdong).toMatchObject({ source: 'search', liveError: 'CanNotGetBoatVoyage' });
    expect(thanhthoi!.source).toBe('seat-map');
    // The live seat map charges 365 000 ₫ for the same seat (synced: 290 000 ₫).
    expect(thanhthoi!.prices.find((p) => p.seatType === 'thuong' && p.ticketTypeId === 1)?.priceVnd).toBe(365000);
    // Rules fall back to the voyage's when the seat map has none.
    expect(thanhthoi!.prices.find((p) => p.seatType === 'thuong' && p.ticketTypeId === 2)?.rules).toBe(
      'MIN_AGE 1, MAX_AGE 11',
    );
    expect(calls.filter((c) => c.url.pathname.endsWith('latestByVoyageId'))).toHaveLength(2);
  });

  it('validates its arguments before any request', async () => {
    const { fetch, calls } = mockFetch(routes);
    const ferry = new FerryClient({ apiKey: 'k', fetch });
    await expect(
      ferry.prices.forRoute({ departureId: 'A', destinationId: 'B', date: '2036-10-20', live: MAX_LIVE_SEAT_MAPS + 1 }),
    ).rejects.toBeInstanceOf(FerryError);
    await expect(ferry.prices.forRoute({ departureId: 'A', destinationId: 'B' })).rejects.toThrow(
      /date, or from and to/,
    );
    expect(calls).toHaveLength(0);
  });
});
