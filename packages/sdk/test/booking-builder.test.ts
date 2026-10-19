import { describe, expect, it } from 'vitest';
import {
  buildLegTickets,
  FerryBookingDraftError,
  FerryClient,
  satisfiesTicketTypeRule,
  type TicketTypeConfig,
} from '../src/index.js';
import { ADULT, CHILD, ELDER, LAYOUT, NATIONALS, VOYAGE, VOYAGE_ID } from './fixtures.js';
import { json, mockFetch, type RecordedCall } from './mock-fetch.js';

const TODAY = '2026-10-07';
const build = (leg: Parameters<typeof buildLegTickets>[0]['leg']) =>
  buildLegTickets({ leg, layout: LAYOUT, voyage: VOYAGE, nationals: NATIONALS, today: TODAY });

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof FerryBookingDraftError) return e.issues;
    throw e;
  }
  throw new Error('expected FerryBookingDraftError');
}

describe('buildLegTickets', () => {
  it('maps seat names + passengers to CreateTicketDto fields and picks ticket types by age', () => {
    const { tickets, summary, warnings } = build({
      voyageId: VOYAGE_ID,
      seats: ['A1', 'A3', 'a4'],
      passengers: [ADULT, CHILD, ELDER],
    });
    expect(warnings).toEqual([]);
    expect(tickets[0]).toMatchObject({
      name: 'Nguyen Van A',
      date_of_birth: '1990-05-01',
      social_id: '079090000001',
      national_id: '1',
      home_town: 'Cần Thơ',
      gender: 1,
      is_child: false,
      is_vip: false,
      seat_id: '11',
      seat_name: 'A1',
      position_id: '101',
      floor_id: 'F1',
      sort_auto: 1,
      seat_type_code: 'ECO',
      ticket_type_id: 1,
      ticket_price_id: 5,
    });
    // SuperDong child type 4 → is_child; same social id allowed for a child ticket.
    expect(tickets[1]).toMatchObject({ seat_name: 'A3', ticket_type_id: 4, ticket_price_id: 6, is_child: true });
    expect(tickets[2]).toMatchObject({ seat_name: 'A4', ticket_type_id: 2, ticket_price_id: 7, gender: 0 });
    expect(summary.ticketTotalVnd).toBe(330000 + 250000 + 280000);
    expect(summary.route).toBe('Rạch Giá → Phú Quốc');
  });

  it('auto-picks adjacent free seats of one seat type (A2 is booked → A3+A4) and honours seatType', () => {
    const auto = build({ voyageId: VOYAGE_ID, passengers: [ADULT, ELDER] });
    expect(auto.tickets.map((t) => t.seat_name)).toEqual(['A3', 'A4']);
    expect(auto.warnings).toEqual([]);
    const vip = build({ voyageId: VOYAGE_ID, seatType: 'vip', passengers: [ADULT] });
    expect(vip.tickets[0]).toMatchObject({ seat_name: 'V1', is_vip: true, ticket_price_id: 8 });
    // One passenger: ECO (330k) is cheaper than VIP (500k); the alternative is announced.
    const single = build({ voyageId: VOYAGE_ID, passengers: [ADULT] });
    expect(single.tickets[0]!.seat_name).toBe('A1');
    expect(single.warnings.join()).toMatch(/picked seat type ECO .*also available: VIP/);
    // Three passengers cannot sit together (A2 booked): seated apart, with a warning.
    const apart = build({ voyageId: VOYAGE_ID, passengers: [ADULT, ELDER, { ...ELDER, name: 'E2', socialId: '1' }] });
    expect(apart.tickets.map((t) => t.seat_name)).toEqual(['A1', 'A3', 'A4']);
    expect(apart.warnings.join()).toMatch(/no 3 adjacent free ECO seats/);
    expect(issuesOf(() => build({ voyageId: VOYAGE_ID, seatType: 'SKY', passengers: [ADULT] })).join()).toMatch(
      /no seats of type SKY on this boat \(types: ECO, VIP\)/,
    );
  });

  it('caps foreigners at 35 like the backend (a 76-year-old foreigner gets an adult ticket)', () => {
    const { tickets } = build({ voyageId: VOYAGE_ID, seats: ['A1'], passengers: [{ ...ELDER, nationalId: '2' }] });
    expect(tickets[0]).toMatchObject({ ticket_type_id: 1, national_id: '2' });
  });

  it('reports every problem at once', () => {
    const issues = issuesOf(() =>
      build({
        voyageId: VOYAGE_ID,
        seats: ['A2', 'Z9', 'A2'],
        passengers: [ADULT, { ...ADULT, name: 'Dup' }, { ...ADULT, dateOfBirth: '1990-13-01' }],
      }),
    );
    expect(issues.join('\n')).toMatch(/seat A2 is booked/);
    expect(issues.join('\n')).toMatch(/seat Z9 does not exist/);
    expect(issues.join('\n')).toMatch(/seat A2 is listed twice/);
  });

  it('rejects duplicate social ids on non-child tickets, wrong seat counts and impossible ticket types', () => {
    expect(
      issuesOf(() =>
        build({ voyageId: VOYAGE_ID, seats: ['A1', 'A3'], passengers: [ADULT, { ...ADULT, name: 'X' }] }),
      ).join(),
    ).toMatch(/also used by/);
    expect(issuesOf(() => build({ voyageId: VOYAGE_ID, seats: ['A1'], passengers: [ADULT, ELDER] })).join()).toMatch(
      /1 seat\(s\) for 2 passenger/,
    );
    expect(
      issuesOf(() => build({ voyageId: VOYAGE_ID, seats: ['A1'], passengers: [{ ...ADULT, ticketTypeId: 4 }] })).join(),
    ).toMatch(/age\/nationality does not match the rules of ticket type 4 Trẻ em \(MIN_AGE 1, MAX_AGE 11\)/);
    // VIP seats only have an adult price: a child cannot sit there.
    expect(issuesOf(() => build({ voyageId: VOYAGE_ID, seats: ['V1'], passengers: [CHILD] })).join()).toMatch(
      /no ticket type matches/,
    );
    expect(
      issuesOf(() =>
        build({ voyageId: VOYAGE_ID, seats: ['A1'], passengers: [{ ...ADULT, dateOfBirth: '2030-01-01' }] }),
      ).join(),
    ).toMatch(/in the future|no ticket type/);
  });

  it('refuses a seat map of another voyage', () => {
    expect(issuesOf(() => build({ voyageId: 'other', seats: ['A1'], passengers: [ADULT] })).join()).toMatch(
      /belongs to voyage/,
    );
  });
});

describe('satisfiesTicketTypeRule', () => {
  const rule = (key: string, value: string) => ({ key_config: key, value_config: value }) as TicketTypeConfig;
  const ctx = { today: '2026-10-07', operatorCode: 'superdong', isForeigner: false };
  it('uses year difference for MIN/MAX_AGE and exact age for the _WITH_DATE variants', () => {
    // Born 2014-12-31: 12 by year difference, 11 by exact date on 2026-10-07.
    expect(satisfiesTicketTypeRule('2014-12-31', rule('MIN_AGE', '12'), ctx)).toBe(true);
    expect(satisfiesTicketTypeRule('2014-12-31', rule('MIN_AGE_WITH_DATE', '12'), ctx)).toBe(false);
    expect(satisfiesTicketTypeRule('2014-12-31', rule('MAX_AGE_WITH_DATE', '11'), ctx)).toBe(true);
    expect(satisfiesTicketTypeRule('1990-01-01', rule('AGENT_DISCOUNT', '10'), ctx)).toBe(true);
  });
  it('does not cap foreigners for GreenLines', () => {
    const r = rule('MIN_AGE', '60');
    expect(satisfiesTicketTypeRule('1950-01-01', r, { ...ctx, isForeigner: true })).toBe(false);
    expect(satisfiesTicketTypeRule('1950-01-01', r, { ...ctx, isForeigner: true, operatorCode: 'greenlines' })).toBe(
      true,
    );
  });
});

describe('ferry.bookingDrafts', () => {
  const routes = (call: RecordedCall) => {
    const p = call.url.pathname;
    if (p === '/api/v1/boatLayouts/latestByVoyageId') return json(LAYOUT);
    if (p === `/api/v1/voyages/${VOYAGE_ID}`) return json(VOYAGE);
    if (p === '/api/v1/operators/nationals/OP1') return json(NATIONALS);
    if (p === '/api/v1/bookings' && call.method === 'POST') return json({ id: 'BK123456' }, 201);
    if (p === '/api/v1/vouchers/check-aplicability') {
      const code = (call.body as { voucher_code: string }).voucher_code;
      if (code === 'SALE') return json({ isApplicable: true, voucher: { amount_type: 'flat', amount: 30000 } });
      if (code === 'TEN') return json({ isApplicable: true, voucher: { amount_type: 'percentage', amount: 10 } });
      if (code === 'OLD') return json({ isApplicable: false, voucher: null });
      if (code === 'SOLO')
        return json({ isApplicable: true, voucher: { amount_type: 'flat', amount: 5000, is_unique: true } });
      if (code === 'ONCE') {
        const voucher = {
          amount_type: 'flat',
          amount: 5000,
          limit_per_customer: 1,
          applied_orders: [{ customer_id: 1 }],
        };
        return json({ isApplicable: true, voucher });
      }
      return json({ statusCode: 422, errors: { voucher_code: 'VoucherNotExist' } }, 422);
    }
    return json({ statusCode: 404, message: 'nope' }, 404);
  };

  it('prepare() fetches seat map, voyage and nationalities and assembles the nested payload', async () => {
    const { fetch, calls } = mockFetch(routes);
    const ferry = new FerryClient({ apiKey: 'k', fetch });
    const draft = await ferry.bookingDrafts.prepare({
      customerId: 1001,
      ordererName: 'Nguyễn Văn A',
      contactEmail: 'a@example.com',
      phoneNumber: '0901234567',
      depart: { voyageId: VOYAGE_ID, seats: ['A1'], passengers: [ADULT], voucherCodes: ['SALE'] },
    });
    // Reads only: GETs plus the read-only voucher check.
    expect(calls.filter((c) => c.method !== 'GET').map((c) => c.url.pathname)).toEqual([
      '/api/v1/vouchers/check-aplicability',
    ]);
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      voucher_code: 'SALE',
      order_payload: { voyage_id: VOYAGE_ID, tickets: [{ seat_name: 'A1' }] },
    });
    expect(draft.input).toMatchObject({
      customer_id: 1001,
      orderer_name: 'Nguyễn Văn A',
      contact_email: 'a@example.com',
      phone_number: '0901234567',
      depart_order: {
        voyage_id: VOYAGE_ID,
        customer_id: 1001,
        orderer_name: 'Nguyễn Văn A',
        vouchers: [{ voucher_code: 'SALE' }],
        tickets: [{ seat_name: 'A1', national_id: '1', ticket_price_id: 5 }],
      },
    });
    expect(draft.input).not.toHaveProperty('return_order');
    expect(draft.estimatedTicketTotalVnd).toBe(330000);
    expect(draft.depart.vouchers).toEqual([{ code: 'SALE', amountType: 'flat', amount: 30000, discountVnd: 30000 }]);
    expect(draft.estimatedTotalVnd).toBe(300000);
  });

  it('quotes percentage vouchers on tickets + harbor fee and rejects unknown or inapplicable codes', async () => {
    const voyage = {
      ...VOYAGE,
      route: { ...VOYAGE.route, operators: [{ operator_id: 'OP1', harbor_fee: 20000 }] },
    };
    const { fetch } = mockFetch((call) =>
      call.url.pathname === `/api/v1/voyages/${VOYAGE_ID}` ? json(voyage) : routes(call),
    );
    const ferry = new FerryClient({ apiKey: 'k', fetch });
    const base = { customerId: 1, ordererName: 'A', contactEmail: 'a@example.com' };
    const draft = await ferry.bookingDrafts.prepare({
      ...base,
      depart: { voyageId: VOYAGE_ID, seats: ['A1'], passengers: [ADULT], voucherCodes: ['TEN', 'TEN '] },
    });
    // (330 000 + 20 000) × 10 % = 35 000; duplicate codes are sent once.
    expect(draft.depart).toMatchObject({ harborFeeTotalVnd: 20000, subtotalVnd: 350000, voucherDiscountVnd: 35000 });
    expect(draft.estimatedTotalVnd).toBe(315000);
    expect(draft.input.depart_order?.vouchers).toEqual([{ voucher_code: 'TEN' }]);

    const err = await ferry.bookingDrafts
      .prepare({
        ...base,
        depart: { voyageId: VOYAGE_ID, seats: ['A1'], passengers: [ADULT], voucherCodes: ['OLD', 'NOPE'] },
      })
      .catch((e: FerryBookingDraftError) => e);
    expect(err).toBeInstanceOf(FerryBookingDraftError);
    expect((err as FerryBookingDraftError).issues).toEqual([
      'depart: voucher OLD is not applicable to this order (route, date, period or usage limit)',
      'depart: voucher NOPE does not exist in your organization',
    ]);

    // Server rules the check endpoint does not apply: unique vouchers and per-customer limits.
    const rules = await ferry.bookingDrafts
      .prepare({
        ...base,
        depart: { voyageId: VOYAGE_ID, seats: ['A1'], passengers: [ADULT], voucherCodes: ['SOLO', 'TEN', 'ONCE'] },
      })
      .catch((e: FerryBookingDraftError) => e);
    expect((rules as FerryBookingDraftError).issues).toEqual([
      'depart: voucher ONCE was already used 1 time(s) by this customer (limit 1)',
      'depart: voucher SOLO cannot be combined with other vouchers',
    ]);

    // checkVouchers: false skips the check (the server still validates at creation).
    const unchecked = await ferry.bookingDrafts.prepare({
      ...base,
      checkVouchers: false,
      depart: { voyageId: VOYAGE_ID, seats: ['A1'], passengers: [ADULT], voucherCodes: ['NOPE'] },
    });
    expect(unchecked.estimatedTotalVnd).toBe(350000);
  });

  it('validates the contact fields before any request and create() posts the draft', async () => {
    const { fetch, calls } = mockFetch(routes);
    const ferry = new FerryClient({ apiKey: 'k', fetch });
    await expect(
      ferry.bookingDrafts.prepare({
        customerId: 0,
        ordererName: '',
        contactEmail: 'nope',
        depart: { voyageId: VOYAGE_ID, passengers: [ADULT] },
      }),
    ).rejects.toBeInstanceOf(FerryBookingDraftError);
    expect(calls).toHaveLength(0);

    const { booking, draft } = await ferry.bookingDrafts.create({
      customerId: 1001,
      ordererName: 'A',
      contactEmail: 'a@example.com',
      depart: { voyageId: VOYAGE_ID, seats: ['A3'], passengers: [ADULT] },
      return: { voyageId: VOYAGE_ID, seats: ['A4'], passengers: [ADULT] },
    });
    expect(booking.id).toBe('BK123456');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual(draft.input);
    expect(
      (post.body as { return_order: { tickets: Array<{ seat_name: string }> } }).return_order.tickets[0]!.seat_name,
    ).toBe('A4');
  });
});

describe('review regressions', () => {
  it('reports a passenger with a missing social id as a draft issue, not a TypeError', () => {
    const issues = issuesOf(() =>
      build({
        voyageId: VOYAGE_ID,
        seats: ['A1'],
        passengers: [{ ...ADULT, socialId: undefined as unknown as string }],
      }),
    );
    expect(issues).toEqual(['leg passenger 1 (Nguyen Van A): socialId is required']);
  });

  it('keeps seats aligned with passengers when one requested seat is invalid', () => {
    const issues = issuesOf(() =>
      build({ voyageId: VOYAGE_ID, seats: ['A1', 'X9', 'A3'], passengers: [ADULT, ELDER, CHILD] }),
    );
    // Only the bad seat is reported; passenger 3 is still validated against A3 (no spurious issue).
    expect(issues).toEqual(['leg: seat X9 does not exist on this boat']);
  });

  it('propagates a failing nationality lookup instead of silently treating foreigners as Vietnamese', async () => {
    const { fetch } = mockFetch((call) => {
      const p = call.url.pathname;
      if (p === '/api/v1/boatLayouts/latestByVoyageId') return json(LAYOUT);
      if (p === `/api/v1/voyages/${VOYAGE_ID}`) return json(VOYAGE);
      return json({ statusCode: 500, message: 'boom' }, 500);
    });
    const ferry = new FerryClient({ apiKey: 'k', fetch, retry: { maxRetries: 0 } });
    await expect(
      ferry.bookingDrafts.prepare({
        customerId: 1,
        ordererName: 'A',
        contactEmail: 'a@example.com',
        depart: { voyageId: VOYAGE_ID, passengers: [ELDER] },
      }),
    ).rejects.toMatchObject({ name: 'FerryServerError' });
  });
});
