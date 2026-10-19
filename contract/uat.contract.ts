/**
 * Read-only contract tests against the live API: they check that the response
 * shapes the SDK relies on still hold. No booking, customer or ticket is created
 * (the voucher check is read-only); at most one live seat map is requested.
 *
 *   FERRY_UAT_API_KEY=... npm run test:contract
 *   FERRY_CONTRACT_ENV=production FERRY_CONTRACT_API_KEY=... npm run test:contract
 */
import {
  addDays,
  buildLegTickets,
  FerryApiError,
  FerryClient,
  FerryNotFoundError,
  FerryPermissionError,
  flattenSeatMap,
  isVoyageBookable,
  todayInVietnam,
  type Voyage,
} from '@ferryvn/sdk';
import { beforeAll, describe, expect, it } from 'vitest';

// UAT by default; FERRY_CONTRACT_ENV=production + FERRY_CONTRACT_API_KEY runs the same read-only checks there.
const environment = process.env.FERRY_CONTRACT_ENV === 'production' ? 'production' : 'uat';
const apiKey = process.env.FERRY_CONTRACT_API_KEY ?? process.env.FERRY_UAT_API_KEY;
const suite = apiKey ? describe : describe.skip;

suite(`${environment} contract (read-only)`, () => {
  const ferry = new FerryClient({ apiKey, environment, timeoutMs: 45_000 });
  /** An upcoming voyage that can be sold, if UAT has one this week. */
  let voyageId: string | undefined;
  /** Any upcoming voyage with seats (UAT often has only operator-disabled ones). */
  let anyVoyage: Voyage | undefined;
  /** Route and date of the first voyage found, for the price table. */
  let priced: { departureId: string; destinationId: string; date: string } | undefined;

  beforeAll(async () => {
    const routes = await ferry.routes.list({ limit: 20 });
    const today = todayInVietnam();
    for (const r of routes.data.filter((x) => !x.disable)) {
      for (let d = 1; d <= 7 && !voyageId; d++) {
        const page = await ferry.voyages.search({
          date: addDays(today, d),
          departureId: r.departure_id,
          destinationId: r.destination_id,
          limit: 10,
        });
        const voyages = page.data.map((v) => v.voyage).filter((v): v is Voyage => Boolean(v));
        anyVoyage ??= voyages.find((v) => (v.no_remain ?? 0) > 0);
        if (!priced && voyages.length) {
          priced = { departureId: r.departure_id, destinationId: r.destination_id, date: addDays(today, d) };
        }
        voyageId = voyages.find((v) => isVoyageBookable(v))?.id;
      }
      if (voyageId) break;
    }
  });

  it('locations / routes / operators (anonymous)', async () => {
    const locations = await ferry.locations.list();
    expect(locations.length).toBeGreaterThan(0);
    expect(locations[0]).toEqual(
      expect.objectContaining({ id: expect.any(String), location_name: expect.any(String) }),
    );
    const routes = await ferry.routes.list({ limit: 5 });
    expect(routes).toEqual(expect.objectContaining({ data: expect.any(Array) }));
    expect('next_cursor' in routes).toBe(true);
    expect((await ferry.operators.list()).length).toBeGreaterThan(0);
  });

  it('organization, reservable credit and paginated lists', async () => {
    const org = await ferry.organization.me();
    expect(org).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String) }));
    expect(Number.isFinite(await ferry.organization.reservableCredit())).toBe(true);
    for (const page of [
      await ferry.bookings.list({ limit: 1 }),
      await ferry.orders.list({ limit: 1 }),
      await ferry.customers.list({ limit: 1 }),
      await ferry.cancelTicketRequests.list({ limit: 1 }),
      await ferry.vouchers.list({ limit: 1 }),
      await ferry.transactions.list({ limit: 1 }),
    ]) {
      expect(Array.isArray(page.data)).toBe(true);
      expect(page.next_cursor === null || typeof page.next_cursor === 'string').toBe(true);
    }
    // Disruptions need a permission UAT keys may lack (403); the shape is checked when granted.
    const disruptions = await ferry.disruptions.list({ limit: 1 }).catch((e: unknown) => {
      if (e instanceof FerryPermissionError) return undefined;
      throw e;
    });
    if (disruptions) expect(Array.isArray(disruptions.data)).toBe(true);
  });

  it('route price table from search data (no live seat map)', async () => {
    if (!priced) return;
    const { voyages, hiddenUnavailable } = await ferry.prices.forRoute({ ...priced, includeUnavailable: true });
    expect(voyages.length).toBeGreaterThan(0);
    expect(hiddenUnavailable).toBe(0);
    for (const v of voyages) {
      expect(v.source).toBe('search');
      for (const p of v.prices) {
        expect(Number.isFinite(p.priceVnd) && p.priceVnd > 0).toBe(true);
        expect(p.totalVnd).toBe(p.priceVnd + p.harborFeeVnd);
      }
    }
  });

  it('stored seat map of any voyage builds tickets offline (also for operator-disabled voyages)', async () => {
    if (!anyVoyage) return; // no upcoming voyage on UAT this week
    const voyage = await ferry.voyages.get(anyVoyage.id);
    // Operators with on-demand seat maps have no stored copy until someone asks for the live one.
    const layout = await ferry.boatLayouts.byVoyageId(voyage.id).catch(async (e: unknown) => {
      if (e instanceof FerryNotFoundError && !voyage.disable) return ferry.boatLayouts.latestByVoyageId(voyage.id);
      throw e;
    });
    const map = flattenSeatMap(layout);
    expect(map.voyageId).toBe(voyage.id);
    expect(map.available).toBeGreaterThan(0);
    const nationals = await ferry.operators.nationals(voyage.operator_id);
    expect(nationals.some((n) => n.abbrev === 'VN')).toBe(true);
    const { tickets } = buildLegTickets({
      leg: {
        voyageId: voyage.id,
        passengers: [
          { name: 'Contract Test', dateOfBirth: '1990-01-01', socialId: '079090000001', homeTown: 'Cần Thơ' },
        ],
      },
      layout,
      voyage: { ...voyage, disable: false },
      nationals,
    });
    expect(tickets[0]).toEqual(
      expect.objectContaining({ ticket_type_id: expect.any(Number), ticket_price_id: expect.any(Number) }),
    );
    if (voyage.disable) {
      // The live seat map refuses disabled voyages with a field error the CLI/MCP explain.
      const err = await ferry.boatLayouts.latestByVoyageId(voyage.id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FerryApiError);
      expect((err as FerryApiError).fieldErrors).toEqual(expect.objectContaining({ voyage: 'VoyageIsDisabled' }));
    }
  });

  it('voyage, seat map and booking draft (no booking is created)', async () => {
    if (!voyageId) return; // no bookable voyage on UAT this week
    const voyage = await ferry.voyages.get(voyageId);
    expect(voyage).toEqual(expect.objectContaining({ id: voyageId, departure_date: expect.any(String) }));
    const layout = await ferry.boatLayouts.latestByVoyageId(voyageId);
    const map = flattenSeatMap(layout);
    expect(map.voyageId).toBe(voyageId);
    expect(layout.boatLayout.prices.length).toBeGreaterThan(0);
    expect(layout.boatLayout.ticket_type_configs.length).toBeGreaterThan(0);
    const draft = await ferry.bookingDrafts.prepare({
      customerId: 1,
      ordererName: 'Contract Test',
      contactEmail: 'contract@example.com',
      depart: {
        voyageId,
        passengers: [
          { name: 'Contract Test', dateOfBirth: '1990-01-01', socialId: '079090000001', homeTown: 'Cần Thơ' },
        ],
      },
    });
    expect(draft.input.depart_order?.tickets?.length).toBe(1);
  });
});
