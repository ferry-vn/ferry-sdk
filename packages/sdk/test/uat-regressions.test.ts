/**
 * Regressions found by running the SDK against UAT (api.ferryvn.net) on
 * 2026-10-07. Fixtures are real, sanitized supply data (seat maps, voyages,
 * nationality lists) — see `fixtures/uat-supply.json` `_meta`.
 */
import { describe, expect, it } from 'vitest';
import {
  type BoatLayoutWithAdditions,
  buildLegTickets,
  type DraftLeg,
  type DraftPassenger,
  FerryBookingDraftError,
  FerryClient,
  FerryNotFoundError,
  flattenSeatMap,
  formatVnd,
  isVoyageBookable,
  type OperatorNational,
  resolveNational,
  seatRef,
  type Voyage,
  voyageDeparture,
  voyageHarborFee,
  voyageUnbookableReason,
} from '../src/index.js';
import uat from './fixtures/uat-supply.json' with { type: 'json' };
import { json, mockFetch } from './mock-fetch.js';

type Op = 'saigonwatergo' | 'superdong' | 'phuquocexpress' | 'hoabinhship' | 'lightning68' | 'greenlines';
interface Fixture {
  voyage: Voyage;
  layout: BoatLayoutWithAdditions;
  nationals: OperatorNational[];
}
const fx = (op: Op): Fixture => structuredClone((uat as unknown as Record<Op, Fixture>)[op]);
const TODAY = '2026-10-07';
const NOW = new Date('2026-10-07T02:00:00Z'); // 09:00 in Vietnam, the capture day

const pax = (over: Partial<DraftPassenger> = {}, i = 0): DraftPassenger => ({
  name: `Hanh Khach ${i}`,
  dateOfBirth: '1990-01-01',
  socialId: `07909000000${i}`,
  homeTown: 'Cần Thơ',
  ...over,
});

/** Build a leg on a UAT fixture; UAT voyages are all disabled, so enable unless told otherwise. */
function build(op: Op, leg: Omit<DraftLeg, 'voyageId'>, tweak: (f: Fixture) => void = () => {}) {
  const f = fx(op);
  f.voyage.disable = false;
  tweak(f);
  return buildLegTickets({
    leg: { voyageId: f.voyage.id, ...leg },
    layout: f.layout,
    voyage: f.voyage,
    nationals: f.nationals,
    today: TODAY,
    now: NOW,
  });
}
function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof FerryBookingDraftError) return e.issues;
    throw e;
  }
  throw new Error('expected FerryBookingDraftError');
}

describe('seat map on real layouts', () => {
  it('hides seats the operator does not render (Lightning68 IsRenders=false): available = voyage.no_remain', () => {
    const f = fx('lightning68');
    const map = flattenSeatMap(f.layout);
    expect(map.total).toBe(242);
    expect(map.available).toBe(f.voyage.no_remain);
    const hidden = f.layout.boatLayout.floors.flatMap((fl) =>
      fl.SeatNames.filter((_, i) => fl.IsSeats?.[i] !== false && fl.IsRenders?.[i] === false),
    );
    expect(hidden).toHaveLength(48);
    expect(map.seats.some((s) => hidden.includes(s.seatName!))).toBe(false);
  });

  it('gives an unambiguous NAME#POSITION reference for repeated seat names (Saigon Watergo C23/C24)', () => {
    const seats = flattenSeatMap(fx('saigonwatergo').layout).seats.filter((s) => s.seatName === 'C23');
    expect(seats).toHaveLength(2);
    expect(new Set(seats.map(seatRef)).size).toBe(2);
  });
});

describe('booking builder on real layouts', () => {
  it('builds a mixed family on every operator with server-valid ticket types and nationality ids', () => {
    const family = [
      pax({}, 1),
      pax({ name: 'Tre Em', dateOfBirth: '2019-05-05', socialId: '079090000099' }, 2),
      pax({ name: 'Cao Tuoi', dateOfBirth: '1955-01-01' }, 3),
    ];
    const expected: Record<Op, { types: number[]; national: string }> = {
      saigonwatergo: { types: [1, 1, 1], national: 'VN' }, // adult from 6, no elderly type
      superdong: { types: [1, 4, 2], national: 'VN' },
      phuquocexpress: { types: [1, 2, 3], national: '1' },
      hoabinhship: { types: [1, 2, 3], national: '1' },
      lightning68: { types: [1, 2, 3], national: 'Viet Nam' },
      greenlines: { types: [1, 2, 3], national: '1' },
    };
    for (const [op, want] of Object.entries(expected) as Array<[Op, (typeof expected)[Op]]>) {
      const { tickets, summary } = build(op, { passengers: family });
      expect(
        tickets.map((t) => t.ticket_type_id),
        op,
      ).toEqual(want.types);
      expect(new Set(tickets.map((t) => t.national_id)), op).toEqual(new Set([want.national]));
      expect(new Set(tickets.map((t) => t.seat_type_code)).size, op).toBe(1);
      expect(
        summary.tickets.every((t) => t.priceVnd > 0),
        op,
      ).toBe(true);
    }
  });

  it('defaults to Vietnam even when the operator does not flag it as default (GreenLines) or lists it last', () => {
    const greenlines = build('greenlines', { passengers: [pax()] }, (f) => {
      f.nationals.reverse(); // VN last, no `default: true` anywhere
    });
    expect(greenlines.tickets[0]!.national_id).toBe('1');
    expect(resolveNational(fx('saigonwatergo').nationals)?.national_id).toBe('VN');
  });

  it('resolves nationality given as ISO code or name to the operator’s own id', () => {
    const us = (op: Op) => resolveNational(fx(op).nationals, 'us')?.national_id;
    expect([us('saigonwatergo'), us('phuquocexpress'), us('lightning68')]).toEqual(['US', 235, 'United States']);
    expect(resolveNational(fx('lightning68').nationals, 'korea, republic of')?.abbrev).toBe('KR');
    const issues = issuesOf(() => build('superdong', { passengers: [pax({ nationalId: 'JP' })] }));
    expect(issues.join()).toMatch(/nationality "JP" is not accepted by superdong \(accepted: CN, FR, KR, US, VN\)/);
  });

  it('applies the NATIONAL_ID rule (SuperDong elderly tickets are for Vietnamese citizens only)', () => {
    // A Vietnamese 70-year-old gets the elderly ticket (type 2).
    expect(build('superdong', { passengers: [pax({ dateOfBirth: '1956-01-01' })] }).tickets[0]!.ticket_type_id).toBe(2);
    // A foreigner forced onto it is refused locally (the operator would refuse at issuance).
    const issues = issuesOf(() =>
      build('superdong', { passengers: [pax({ dateOfBirth: '1956-01-01', nationalId: 'US', ticketTypeId: 2 })] }),
    );
    expect(issues.join()).toMatch(/does not match the rules of ticket type 2 .*NATIONAL_ID VN/);
  });

  it('never offers ticket types that are priced but not configured (SuperDong 3 = disabled, 5 = invitation)', () => {
    const issues = issuesOf(() => build('superdong', { passengers: [pax({ ticketTypeId: 5 })] }));
    expect(issues.join()).toMatch(/ticket type 5 is not offered on this voyage \(types: 1 Người lớn, 4 Trẻ em/);
  });

  it('picks the cheapest type when several fit (Lightning68: exactly 60 is adult and elderly) and says so', () => {
    const { tickets, warnings } = build('lightning68', { passengers: [pax({ dateOfBirth: '1966-10-07' })] });
    expect(tickets[0]).toMatchObject({ ticket_type_id: 3, seat_type_code: 'ECO' });
    expect(warnings.join()).toMatch(/several ticket types fit \(3 Vé người cao tuổi 160000, 1 Vé người lớn 180000\)/);
  });

  it('picks the cheapest seat type with enough seats, keeps the group together, honours seatType', () => {
    const eco = build('hoabinhship', { passengers: [pax({}, 1), pax({}, 2), pax({}, 3)] });
    expect(new Set(eco.tickets.map((t) => t.seat_type_code))).toEqual(new Set(['ECO']));
    expect(eco.warnings.join()).toMatch(/picked seat type ECO .*also available: VIP/);
    const vip = build('hoabinhship', { seatType: 'vip', passengers: [pax()] });
    // Hoà Bình VIP seats only sell type 4 "Vé VIP".
    expect(vip.tickets[0]).toMatchObject({ seat_type_code: 'VIP', ticket_type_id: 4, ticket_price_id: 313 });

    // Phú Quốc Express publishes an auto-assign order (SortAutos): seats are consecutive in it.
    const pqe = build('phuquocexpress', { passengers: [pax({}, 1), pax({}, 2), pax({}, 3)] });
    const sorts = pqe.tickets.map((t) => t.sort_auto);
    expect(sorts).toEqual([sorts[0], sorts[0]! + 1, sorts[0]! + 2]);
  });

  it('resolves a repeated seat name to the free namesake, refuses it when both are free, accepts NAME#POSITION', () => {
    // On UAT, C23#23 is issued and C23#25 is free: the plain name means the free one.
    const real = build('saigonwatergo', { seats: ['C23'], passengers: [pax()] });
    expect(real.tickets[0]).toMatchObject({ seat_name: 'C23', position_id: '25' });
    expect(real.summary.tickets[0]!.seatRef).toBe('C23#25');

    const bothFree = (f: Fixture) => {
      const fl = f.layout.boatLayout.floors[0]!;
      const i = fl.PositionIds.indexOf(23);
      fl.IsBookeds[i] = false;
      fl.IsHelds[i] = false;
      fl.IsExporteds[i] = false;
    };
    const issues = issuesOf(() => build('saigonwatergo', { seats: ['c23'], passengers: [pax()] }, bothFree));
    expect(issues).toEqual([
      'leg: seat c23 is ambiguous — 2 seats share it: C23#23 (Tầng 1), C23#25 (Tầng 1); use NAME#POSITION_ID',
    ]);
    expect(build('saigonwatergo', { seats: ['C23#23'], passengers: [pax()] }, bothFree).tickets[0]!.position_id).toBe(
      '23',
    );
    expect(build('saigonwatergo', { seats: ['#23'], passengers: [pax()] }, bothFree).tickets[0]!.seat_name).toBe('C23');
    expect(issuesOf(() => build('saigonwatergo', { seats: ['C23#23'], passengers: [pax()] })).join()).toMatch(
      /seat C23#23 is booked/,
    );
    expect(issuesOf(() => build('saigonwatergo', { seats: ['C99#23'], passengers: [pax()] })).join()).toMatch(
      /seat C99#23 does not exist/,
    );
  });

  it('refuses a seat whose name is shared with a seat of another type (server checks the first match)', () => {
    const f = fx('hoabinhship');
    const floor = f.layout.boatLayout.floors[0]!;
    const vipIdx = floor.SeatTypes.indexOf('VIP');
    const ecoIdx = floor.SeatTypes.findIndex((t, i) => t === 'ECO' && floor.IsSeats[i] !== false && i > vipIdx);
    const issues = issuesOf(() =>
      build('hoabinhship', { seats: [`#${floor.PositionIds[ecoIdx]}`], passengers: [pax()] }, (g) => {
        const fl = g.layout.boatLayout.floors[0]!;
        fl.SeatNames[ecoIdx] = fl.SeatNames[vipIdx]!; // ECO seat renamed like an earlier VIP seat
      }),
    );
    expect(issues.join()).toMatch(/shares its name with a seat of another type; the server would reject it/);
  });

  it('enforces the operator’s home-town and social-id length rules', () => {
    const issues = issuesOf(() =>
      build('superdong', { passengers: [pax({ homeTown: 'Thành phố Hồ Chí Minh', socialId: '0790900000011234' })] }),
    );
    expect(issues).toEqual([
      'leg passenger 1 (Hanh Khach 0): socialId must be 1–15 characters (got 16) for superdong',
      'leg passenger 1 (Hanh Khach 0): homeTown must be 3–15 characters (got 21) for superdong — use a short province name, e.g. "TP.HCM", "Cần Thơ"',
    ]);
    // Saigon Watergo allows 13 characters only.
    expect(
      issuesOf(() => build('saigonwatergo', { passengers: [pax({ homeTown: 'Bà Rịa Vũng Tàu' })] })).join(),
    ).toMatch(/homeTown must be 3–13 characters \(got 15\)/);
  });

  it('exempts children from the duplicate social-id rule only where the server does', () => {
    const kid = pax({ name: 'Be', dateOfBirth: '2019-01-01', socialId: '079090000000' });
    expect(build('superdong', { passengers: [pax(), kid] }).tickets[1]).toMatchObject({
      ticket_type_id: 4,
      is_child: true,
    });
    // Saigon Watergo is not in the server's child table: its child tickets still need their own id.
    expect(issuesOf(() => build('saigonwatergo', { passengers: [pax(), kid] })).join()).toMatch(/also used by/);
  });

  it('explains infants (younger than every ticket type)', () => {
    const issues = issuesOf(() => build('superdong', { passengers: [pax({ dateOfBirth: '2026-03-01' })] }));
    expect(issues.join()).toMatch(/younger than every ticket type \(from 1\); infants usually travel without a ticket/);
  });

  it('refuses disabled voyages, disabled operators and past voyages', () => {
    const f = fx('greenlines');
    const leg = { voyageId: f.voyage.id, passengers: [pax()] };
    const run = (v: Voyage) =>
      issuesOf(() =>
        buildLegTickets({ leg, layout: f.layout, voyage: v, nationals: f.nationals, today: TODAY, now: NOW }),
      );
    expect(run(f.voyage).join()).toMatch(/is disabled by the operator and cannot be booked/);
    expect(run({ ...f.voyage, disable: false, operator: { ...f.voyage.operator!, is_enabled: false } }).join()).toMatch(
      /operator greenlines is disabled/,
    );
    expect(run({ ...f.voyage, disable: false, departure_date: '2026-10-01' }).join()).toMatch(
      /already departed \(2026-10-01 15:00\)/,
    );
    // Earlier the same day counts too (the server's VoyageNotExists lookup is time-aware).
    const today = { ...f.voyage, disable: false, departure_date: '2026-10-07', depart_time: '08:30:00' };
    expect(run(today).join()).toMatch(/already departed \(2026-10-07 08:30\)/);
    expect(() =>
      buildLegTickets({
        leg,
        layout: f.layout,
        voyage: { ...today, depart_time: '10:00:00' },
        nationals: f.nationals,
        today: TODAY,
        now: NOW,
      }),
    ).not.toThrow();
  });

  it('quotes the per-ticket harbor fee of the voyage’s operator on the route', () => {
    const f = fx('phuquocexpress');
    expect(voyageHarborFee(f.voyage)).toBe(0);
    const { summary } = build('phuquocexpress', { passengers: [pax({}, 1), pax({}, 2)] }, (g) => {
      // Another operator on the same route has a fee too: only the voyage's operator counts.
      for (const o of g.voyage.route!.operators as Array<{ operator_id: string; harbor_fee: number }>) {
        o.harbor_fee = o.operator_id === g.voyage.operator_id ? 15000 : 99000;
      }
    });
    expect(summary).toMatchObject({
      ticketTotalVnd: 630000,
      harborFeeTotalVnd: 30000,
      subtotalVnd: 660000,
      totalVnd: 660000,
    });
    expect(summary.tickets[0]!.harborFeeVnd).toBe(15000);
    expect(summary.departure).toBe('2026-10-10 10:20');
  });
});

describe('voyage helpers', () => {
  const now = new Date('2026-10-07T02:00:00Z'); // 09:00 in Vietnam
  it('flags unbookable voyages like the dashboard does', () => {
    const v = fx('greenlines').voyage;
    expect(voyageDeparture(v)).toBe('2026-10-10 15:00');
    expect(voyageUnbookableReason(v, { now })).toBe('disabled');
    const open = { ...v, disable: false };
    expect(isVoyageBookable(open, { now })).toBe(true);
    expect(voyageUnbookableReason({ ...open, no_remain: 0 }, { now })).toBe('sold-out');
    expect(voyageUnbookableReason({ ...open, departure_date: '2026-10-07', depart_time: '08:59:00' }, { now })).toBe(
      'departed',
    );
    expect(voyageUnbookableReason({ ...open, operator: { ...open.operator!, is_enabled: false } }, { now })).toBe(
      'operator-disabled',
    );
  });

  it('rounds VND amounts (pre-VAT prices carry decimals)', () => {
    expect(formatVnd(286363.64)).toBe(`${(286364).toLocaleString('vi-VN')} ₫`);
  });
});

describe('seat-map endpoints', () => {
  it('turn the empty 204 of a voyage without a seat map into FerryNotFoundError', async () => {
    const { fetch } = mockFetch(() => new Response(null, { status: 204 }));
    const ferry = new FerryClient({ apiKey: 'k', fetch });
    await expect(ferry.boatLayouts.byVoyageId('V1')).rejects.toBeInstanceOf(FerryNotFoundError);
    await expect(ferry.boatLayouts.latestByVoyageId('V1')).rejects.toThrow(/seat map of voyage V1 not found/);
    const wrapped = mockFetch(() => json({ boatLayout: null }));
    await expect(
      new FerryClient({ apiKey: 'k', fetch: wrapped.fetch }).boatLayouts.byVoyageId('V1'),
    ).rejects.toBeInstanceOf(FerryNotFoundError);
  });
});

describe('audit regressions (2026-10-18)', () => {
  it('refuses non-text passenger fields instead of silently dropping the passenger', () => {
    const issues = issuesOf(() =>
      build('superdong', {
        passengers: [pax({}, 1), { ...pax({}, 2), socialId: 79050000003 as unknown as string }, null as never],
      }),
    );
    expect(issues).toEqual([
      'leg passenger 2 (Hanh Khach 2): socialId must be text, got number — quote it (e.g. "079090000001")',
      'leg passenger 3: expected an object with name, dateOfBirth, socialId and homeTown',
    ]);
  });

  it('auto-picks a seat type every passenger can get a ticket for (Hoà Bình: an infant only fits the VIP type)', () => {
    const { tickets } = build('hoabinhship', {
      passengers: [pax({}, 1), pax({ name: 'Em Be', dateOfBirth: '2026-03-01' }, 2)],
    });
    expect(tickets.map((t) => [t.seat_type_code, t.ticket_type_id])).toEqual([
      ['VIP', 4],
      ['VIP', 4],
    ]);
  });

  it('compares social ids exactly, like the server', () => {
    expect(
      build('superdong', { passengers: [pax({ socialId: 'ab123' }, 1), pax({ socialId: 'AB123' }, 2)] }).tickets,
    ).toHaveLength(2);
  });

  it('says a repeated seat name is taken when none of its seats is free', () => {
    const issues = issuesOf(() =>
      build('saigonwatergo', { seats: ['C23'], passengers: [pax()] }, (f) => {
        const fl = f.layout.boatLayout.floors[0]!;
        fl.IsBookeds[fl.PositionIds.indexOf(25)] = true;
      }),
    );
    expect(issues).toEqual(['leg: seat C23 is taken (2 seats share the name, none is free)']);
  });
});
