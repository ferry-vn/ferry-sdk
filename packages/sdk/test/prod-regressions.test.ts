/**
 * Regressions found by running the SDK read-only against production
 * (api.ferry.vn) on 2026-10-07. Fixtures are sanitized supply data — see
 * `fixtures/prod-supply.json` `_meta`.
 */
import { describe, expect, it } from 'vitest';
import {
  type BoatLayoutWithAdditions,
  buildLegTickets,
  type DraftLeg,
  type DraftPassenger,
  FerryBookingDraftError,
  flattenSeatMap,
  isVehicleSeatType,
  type OperatorNational,
  type Voyage,
} from '../src/index.js';
import prod from './fixtures/prod-supply.json' with { type: 'json' };

type Op = 'thanhthoi' | 'binhanhatien' | 'superdong' | 'chankhaluxury' | 'greenlines';
interface Fixture {
  voyage: Voyage;
  layout: BoatLayoutWithAdditions;
  nationals: OperatorNational[];
}
const fx = (op: Op): Fixture => structuredClone((prod as unknown as Record<Op, Fixture>)[op]);
const TODAY = '2026-10-07';
const NOW = new Date('2026-10-07T02:00:00Z'); // 09:00 in Vietnam, the capture day

const pax = (over: Partial<DraftPassenger> = {}, i = 0): DraftPassenger => ({
  name: `Khach ${i}`,
  dateOfBirth: '1990-01-01',
  socialId: `07909000000${i}`,
  homeTown: 'Cần Thơ',
  ...over,
});
const family = [
  pax({}, 1),
  pax({ name: 'Tre Em', dateOfBirth: '2018-06-01', socialId: '079090000099' }, 2),
  pax({ name: 'Cao Tuoi', dateOfBirth: '1950-01-01' }, 3),
];

function build(op: Op, leg: Omit<DraftLeg, 'voyageId'>, tweak: (f: Fixture) => void = () => {}) {
  const f = fx(op);
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

describe('vehicle places sold as seat types (Thạnh Thới, Bình An Hà Tiên)', () => {
  it('recognises vehicle seat types and leaves passenger types alone', () => {
    const types = (op: Op) => fx(op).layout.boatLayout.seat_types;
    expect(types('thanhthoi').filter(isVehicleSeatType)).toEqual([
      'Xe gắn máy',
      'Xe mô tô',
      'Xe O to 04 chổ',
      'Xe O to 04 chổ bán tải',
      'Xe O To 05 chổ',
      'Xe O to 07 chổ',
      'Xe O to 09 chổ',
      'Xe O to 12 chổ',
      'Xe O to 16 chổ',
      'Xe O to 06-09 chổ giường nằm',
    ]);
    expect(types('binhanhatien').filter((t) => !isVehicleSeatType(t))).toEqual(['ECO', 'VIP']);
    for (const t of ['ECO', 'VIP', 'thuong', 'PhoThong', 'ThuongGia', 'HoiNghi', 'CABIN1', 'Xếp hạng'])
      expect(isVehicleSeatType(t), t).toBe(false);
  });

  it('never auto-picks a vehicle place, even when it is cheaper than a seat', () => {
    // Bình An Hà Tiên: XEMAY<195 costs 115 000 ₫, an ECO seat 210 000 ₫.
    const bah = build('binhanhatien', { passengers: [pax()] });
    expect(bah.tickets[0]).toMatchObject({ seat_type_code: 'ECO', ticket_type_id: 1 });
    expect(bah.warnings.join('\n')).toMatch(/also available: VIP\)/);
    expect(bah.warnings.join('\n')).not.toMatch(/XEMAY/);
    const tt = build('thanhthoi', { passengers: family });
    expect(new Set(tt.tickets.map((t) => t.seat_type_code))).toEqual(new Set(['thuong']));
  });

  it('warns when a passenger is put on a vehicle place without a plate', () => {
    const vehicle = flattenSeatMap(fx('binhanhatien').layout).seats.find(
      (s) => s.seatType === 'XEMAY<195' && s.available,
    )!;
    const r = build('binhanhatien', { seats: [`#${vehicle.positionId}`], passengers: [pax()] });
    expect(r.warnings.join('\n')).toMatch(/is a vehicle place \(XEMAY<195\) but no plateNumber was given/);
    const withPlate = build('binhanhatien', {
      seats: [`#${vehicle.positionId}`],
      passengers: [pax({ plateNumber: '65B1-12345' })],
    });
    expect(withPlate.warnings.join('\n')).not.toMatch(/vehicle place/);
  });
});

describe('seat maps without ticket-type rules', () => {
  it('Thạnh Thới: uses the rules published on the voyage and warns that the server may refuse', () => {
    const { tickets, warnings } = build('thanhthoi', { passengers: family });
    // Voyage rules: adult 12–64, child 1–11, elderly 65+.
    expect(tickets.map((t) => t.ticket_type_id)).toEqual([1, 2, 3]);
    expect(warnings.join('\n')).toMatch(
      /seat map has no ticket-type rules; FerryVN checks ticket types against them and may refuse this booking \(InvalidTicketTypeId\) — ticket types were chosen with the rules published on the voyage/,
    );
  });

  it('Bình An Hà Tiên: no rules anywhere → the default ticket type, with a warning per passenger', () => {
    const { tickets, warnings } = build('binhanhatien', { passengers: family });
    expect(tickets.map((t) => t.ticket_type_id)).toEqual([1, 1, 1]);
    expect(warnings.filter((w) => /publishes no age rules; used the default ticket type 1/.test(w))).toHaveLength(3);
  });

  it('warns about the operator’s name-length rule the server does not check (Thạnh Thới: 4–12)', () => {
    const { warnings } = build('thanhthoi', { passengers: [pax({ name: 'Nguyen Van An Binh' })] });
    expect(warnings.join('\n')).toMatch(/rule for names is 4–12 characters \(got 18\)/);
  });
});

describe('production quotes and rules', () => {
  it('adds the 18 000 ₫ harbor fee per ticket on Superdong Côn Đảo → Sóc Trăng', () => {
    const { tickets, summary } = build('superdong', { passengers: family });
    expect(tickets.map((t) => t.ticket_type_id)).toEqual([1, 4, 2]);
    expect(summary.tickets.every((t) => t.harborFeeVnd === 18000)).toBe(true);
    expect(summary.harborFeeTotalVnd).toBe(54000);
    expect(summary.subtotalVnd).toBe(summary.ticketTotalVnd + 54000);
    // A 76-year-old foreigner counts as 35 on Superdong: adult ticket.
    const foreign = build('superdong', { passengers: [pax({ dateOfBirth: '1950-01-01', nationalId: 'GB' })] });
    expect(foreign.tickets[0]).toMatchObject({ ticket_type_id: 1, national_id: 'GB' });
  });

  it('Chân Khả Luxury: one-sided age rules, no social-id exemption for children (not in the server’s table)', () => {
    const { tickets } = build('chankhaluxury', { passengers: family });
    expect(tickets.map((t) => [t.seat_type_code, t.ticket_type_id])).toEqual([
      ['PhoThong', 1],
      ['PhoThong', 2],
      ['PhoThong', 4],
    ]);
    const kid = pax({ name: 'Be', dateOfBirth: '2019-01-01', socialId: '079090000001' });
    expect(issuesOf(() => build('chankhaluxury', { passengers: [pax({}, 1), kid] })).join()).toMatch(/also used by/);
  });

  it('GreenLines production also publishes VN without the default flag: Vietnam is still the default', () => {
    expect(build('greenlines', { passengers: [pax()] }).tickets[0]!.national_id).toBe('1');
  });
});
