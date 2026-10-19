/**
 * CLI behaviour driven by what UAT data looks like (2026-10-07): disabled
 * voyages in search results, repeated seat names, JSON-encoded issue errors.
 */
import { describe, expect, it } from 'vitest';
import { ADULT, CHILD, LAYOUT, NATIONALS, VOYAGE, VOYAGE_ID } from '../../sdk/test/fixtures.js';
import { LOCATIONS, runCli } from './cli-harness.js';

const KEY = { env: { FERRY_API_KEY: 'ferry_key123_secretsecret' } };

describe('voyages search on real-world results', () => {
  const routes = {
    'GET /api/v1/locations': LOCATIONS,
    'GET /api/v1/voyages/findAllRelateByLocationAndDate': {
      data: [
        { voyage: { ...VOYAGE, id: 'OPEN', depart_time: '08:00:00', arrive_time: '10:30:00', no_remain: 12 } },
        { voyage: { ...VOYAGE, id: 'OFF', depart_time: '09:00:00', disable: true, no_remain: 40 } },
      ],
      next_cursor: null,
    },
  };
  const args = ['voyages', 'search', '--from', 'RG', '--to', 'PQ', '--date', '2036-10-20'];

  it('hides voyages that cannot be sold and says how many were hidden; times are HH:mm', async () => {
    const r = await runCli(args, routes, KEY);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('OPEN');
    expect(r.stdout).not.toContain('OFF');
    expect(r.stdout).toMatch(/08:00\s+10:30/);
    expect(r.stdout).not.toContain('08:00:00');
    expect(r.stdout).toContain('1 bookable voyage(s) (1 unavailable hidden — --include-unavailable to list them)');
    const json = await runCli([...args, '--json'], routes, KEY);
    expect(JSON.parse(json.stdout).data.map((v: { voyage: { id: string } }) => v.voyage.id)).toEqual(['OPEN']);
  });

  it('--include-unavailable lists them with a STATUS column', async () => {
    const r = await runCli([...args, '--include-unavailable'], routes, KEY);
    expect(r.stdout).toMatch(/STATUS/);
    expect(r.stdout).toMatch(/OFF.*disabled/);
    expect(r.stdout).toMatch(/OPEN.*bookable/);
  });
});

describe('seats', () => {
  const layout = structuredClone(LAYOUT);
  layout.boatLayout.floors[0]!.SeatNames[3] = 'A1'; // A4 renamed: "A1" now names two seats

  it('shows NAME#POSITION refs, warns about repeated names and lists ticket-type rules', async () => {
    const r = await runCli(['seats', VOYAGE_ID], { 'GET /api/v1/boatLayouts/latestByVoyageId': layout }, KEY);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/A1\s+A1#101/);
    expect(r.stdout).toMatch(/A1\s+A1#104/);
    expect(r.stdout).toContain('Seat names used more than once: A1 — pass the REF (NAME#POSITION_ID)');
    expect(r.stdout).toMatch(/Trẻ em \(4\)\s+MIN_AGE 1, MAX_AGE 11/);
  });

  it('explains VoyageIsDisabled and points to --stored', async () => {
    const r = await runCli(
      ['seats', VOYAGE_ID],
      {
        'GET /api/v1/boatLayouts/latestByVoyageId': [422, { status: 422, errors: { voyage: 'VoyageIsDisabled' } }],
      },
      KEY,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('the operator disabled this voyage');
    expect(r.stderr).toContain('--stored');
  });
});

describe('booking output', () => {
  it('formats the JSON-encoded issue_ticket_error and shows harbor fees', async () => {
    const r = await runCli(
      ['booking', 'get', 'BK1'],
      {
        'GET /api/v1/bookings/BK1': {
          id: 'BK1',
          booking_status: 4,
          payment_status: 2,
          total_price: 600000,
          no_tickets: 2,
          depart_order: {
            id: 'O1',
            order_status: 1,
            voyage: { ...VOYAGE, depart_time: '08:00:00' },
            total_price: 600000,
            total_harbor_fee: 20000,
            tickets: [{}, {}],
            issue_ticket_error: JSON.stringify({
              errorCode: 110295,
              errorLabel: 'VoyageIsDisabledOrOutOfSeat',
              message: 'Voyage is disabled or out of seat',
            }),
          },
        },
      },
      KEY,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('issue error: VoyageIsDisabledOrOutOfSeat (110295): Voyage is disabled or out of seat');
    expect(r.stdout).toContain('(incl. harbor fees 20.000 ₫)');
    expect(r.stdout).toContain('2036-10-20 08:00 ');
    expect(r.stdout).not.toContain('{"errorCode"');
  });

  it('booking draft prints the estimated total incl. harbor fees', async () => {
    const r = await runCli(
      [
        'booking',
        'draft',
        '--customer',
        '1001',
        '--orderer-name',
        'A',
        '--email',
        'a@example.com',
        '--voyage',
        VOYAGE_ID,
        '--passengers',
        'p.json',
        '--out',
        'b.json',
      ],
      {
        'GET /api/v1/boatLayouts/latestByVoyageId': LAYOUT,
        [`GET /api/v1/voyages/${VOYAGE_ID}`]: {
          ...VOYAGE,
          route: { ...VOYAGE.route, operators: [{ operator_id: 'OP1', harbor_fee: 10000 }] },
        },
        'GET /api/v1/operators/nationals/OP1': NATIONALS,
      },
      { ...KEY, files: { 'p.json': JSON.stringify([ADULT, CHILD]) } },
    );
    expect(r.code).toBe(0);
    // Auto-picked adjacent seats A3+A4 (A2 is booked).
    expect(r.stdout).toMatch(/A3[\s\S]*A4/);
    expect(r.stdout).toContain('HARBOR_FEE');
    expect(r.stdout).toContain('Estimated total: 600.000 ₫ (tickets 580.000 ₫, harbor fees 20.000 ₫;');
  });
});

describe('ferry prices', () => {
  const voyage = {
    ...VOYAGE,
    depart_time: '08:00:00',
    no_remain: 9,
    route: { ...VOYAGE.route, operators: [{ operator_id: 'OP1', harbor_fee: 10000 }] },
    ticket_prices: {
      default_ticket_price: 330000,
      prices: [
        {
          id: 5,
          ticket_type_id: 1,
          ticket_type_label: 'Người lớn',
          seat_type: 'ECO',
          price_with_VAT: 330000,
          is_default: true,
        },
        {
          id: 6,
          ticket_type_id: 4,
          ticket_type_label: 'Trẻ em',
          seat_type: 'ECO',
          price_with_VAT: 250000,
          is_default: false,
        },
        {
          id: 9,
          ticket_type_id: 1,
          ticket_type_label: 'Người lớn',
          seat_type: 'XEMAY<195',
          price_with_VAT: 115000,
          is_default: false,
        },
        {
          id: 10,
          ticket_type_id: 5,
          ticket_type_label: 'Vé mời',
          seat_type: 'ECO',
          price_with_VAT: 0,
          is_default: false,
        },
      ],
      ticket_type_configs: [
        { ticket_type_id: 1, ticket_type_label: 'Người lớn', key_config: 'MIN_AGE', value_config: '12' },
        { ticket_type_id: 1, ticket_type_label: 'Người lớn', key_config: 'MAX_AGE', value_config: '59' },
        { ticket_type_id: 4, ticket_type_label: 'Trẻ em', key_config: 'MIN_AGE', value_config: '1' },
        { ticket_type_id: 4, ticket_type_label: 'Trẻ em', key_config: 'MAX_AGE', value_config: '11' },
      ],
    },
  };
  const routes = {
    'GET /api/v1/locations': LOCATIONS,
    'GET /api/v1/voyages/findAllRelateByLocationAndDate': { data: [{ voyage }], next_cursor: null },
    'GET /api/v1/boatLayouts/latestByVoyageId': LAYOUT,
  };
  const args = ['prices', '--from', 'RG', '--to', 'PQ', '--date', '2036-10-20'];

  it('lists passenger prices with ages, harbor fee and total; hides vehicle places and free tickets', async () => {
    const r = await runCli(args, routes, KEY);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/ECO\s+Người lớn \(1\)\s+12–59\s+330\.000 ₫\s+10\.000 ₫\s+340\.000 ₫/);
    expect(r.stdout).toMatch(/Trẻ em \(4\)\s+1–11\s+250\.000 ₫/);
    expect(r.stdout).not.toMatch(/XEMAY|Vé mời/);
    expect(r.stdout).toContain('Prices from synced voyage data (indicative)');
    expect(r.calls.some((c) => c.url.pathname.endsWith('latestByVoyageId'))).toBe(false);
    const vehicles = await runCli([...args, '--vehicles', '--all-ticket-types'], routes, KEY);
    expect(vehicles.stdout).toMatch(/XEMAY<195 \(vehicle\)/);
    expect(vehicles.stdout).toContain('Vé mời (5) — not bookable');
  });

  it('--live prices from the seat map; --summary prints one line per voyage; --json is the SDK result', async () => {
    const live = await runCli([...args, '--live', '1'], routes, KEY);
    expect(live.stdout).toMatch(/SOURCE/);
    expect(live.stdout).toMatch(/live\s*$/m);
    expect(live.calls.filter((c) => c.url.pathname.endsWith('latestByVoyageId'))).toHaveLength(1);
    const summary = await runCli([...args, '--summary'], routes, KEY);
    expect(summary.stdout).toMatch(new RegExp(`${VOYAGE_ID}\\s+08:00.*340\\.000 ₫\\s+260\\.000 ₫`));
    const json = JSON.parse((await runCli([...args, '--json'], routes, KEY)).stdout);
    expect(json.voyages[0]).toMatchObject({
      voyageId: VOYAGE_ID,
      harborFeeVnd: 10000,
      fromVnd: 260000,
      defaultFromVnd: 340000,
    });
    expect((await runCli([...args, '--live', '99'], routes, KEY)).code).toBe(2);
  });
});
