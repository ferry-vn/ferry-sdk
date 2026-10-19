import fs from 'node:fs';
import { BookingStatus } from '@ferryvn/sdk';
import { describe, expect, it } from 'vitest';
import { parseStatuses } from '../src/commands/booking-commands.js';
import { maskKey } from '../src/config-store.js';
import { renderTable } from '../src/output.js';
import { LOCATIONS, runCli } from './cli-harness.js';

const KEY = { env: { FERRY_API_KEY: 'ferry_key123_secretsecret' } };

describe('global behaviour', () => {
  it('prints help and exits 0', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('voyages');
    expect(r.stdout).toContain('booking');
    expect(r.stdout).toContain('login');
  });

  it('rejects unknown commands with exit 2', async () => {
    const r = await runCli(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown command/);
  });

  it('requires an API key for authenticated commands', async () => {
    const r = await runCli(['booking', 'get', 'B1']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('ferry login');
    expect(r.calls).toHaveLength(0);
  });
});

describe('locations / voyages / seats', () => {
  it('locations works anonymously and prints a table', async () => {
    const r = await runCli(['locations'], { 'GET /api/v1/locations': LOCATIONS });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Phú Quốc');
    expect(r.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('voyages search resolves location names and maps flags to query params', async () => {
    const r = await runCli(
      ['voyages', 'search', '--from', 'rach gia', '--to', 'PQ', '--date', '2026-10-20', '--after', '07:30', '--json'],
      {
        'GET /api/v1/locations': LOCATIONS,
        'GET /api/v1/voyages/findAllRelateByLocationAndDate': {
          data: [{ voyage: { id: 'V1', depart_time: '08:00', no_remain: 12 } }],
          next_cursor: null,
        },
      },
      KEY,
    );
    expect(r.code).toBe(0);
    const search = r.calls.find((c) => c.url.pathname.endsWith('findAllRelateByLocationAndDate'))!;
    expect(search.url.searchParams.get('departure_id')).toBe(LOCATIONS[1]!.id);
    expect(search.url.searchParams.get('destination_id')).toBe(LOCATIONS[0]!.id);
    expect(search.url.searchParams.get('departure_date')).toBe('2026-10-20');
    expect(JSON.parse(search.url.searchParams.get('filters')!)).toEqual({ min_depart_time: '07:30:00' });
    expect(search.headers.authorization).toBe('Bearer ferry_key123_secretsecret');
    expect(JSON.parse(r.stdout).data[0].voyage.id).toBe('V1');
  });

  it('voyages search --until uses the date-range endpoint', async () => {
    const r = await runCli(
      ['voyages', 'search', '--from', 'RG', '--to', 'PQ', '--date', '2026-10-20', '--until', '2026-10-22'],
      {
        'GET /api/v1/locations': LOCATIONS,
        'GET /api/v1/voyages/findAllRelateByLocationAndDateRange': { data: [], next_cursor: null },
      },
      KEY,
    );
    expect(r.code).toBe(0);
    const c = r.calls.at(-1)!;
    expect(c.url.searchParams.get('from')).toBe('2026-10-20');
    expect(c.url.searchParams.get('to')).toBe('2026-10-22');
  });

  it('validates the date format before calling the API', async () => {
    const r = await runCli(['voyages', 'search', '--from', 'RG', '--to', 'PQ', '--date', '20/10/2026'], {}, KEY);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('YYYY-MM-DD');
    expect(r.calls).toHaveLength(0);
  });

  it('reports ambiguous / unknown locations', async () => {
    const r = await runCli(
      ['voyages', 'search', '--from', 'nowhere', '--to', 'PQ', '--date', '2026-10-20'],
      {
        'GET /api/v1/locations': LOCATIONS,
      },
      KEY,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no location matches "nowhere"');
  });

  it('seats prints availability per floor', async () => {
    const r = await runCli(
      ['seats', 'V1'],
      {
        'GET /api/v1/boatLayouts/latestByVoyageId': {
          additions: [],
          boatLayout: {
            voyage_id: 'V1',
            prices: [
              { id: 5, seat_type: 'ECO', ticket_type_id: 1, ticket_type_label: 'Người lớn', price_with_VAT: 340000 },
            ],
            floors: [
              {
                floor_id: 'F1',
                floor_name: 'Tầng 1',
                SeatNames: ['A1', 'A2'],
                SeatIds: [1, 2],
                PositionIds: [11, 12],
                IsSeats: [true, true],
                IsBookeds: [false, true],
              },
            ],
          },
        },
      },
      KEY,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Tầng 1: 1/2 available');
    expect(r.stdout).toContain('A1');
    expect(r.stdout).not.toMatch(/\bA2\b/);
    expect(r.calls[0]!.url.searchParams.get('voyage_id')).toBe('V1');
  });
});

describe('bookings', () => {
  const payload = {
    customer_id: 1,
    orderer_name: 'Nguyễn Văn A',
    contact_email: 'a@example.com',
    depart_order: { voyage_id: 'V1', tickets: [] },
  };

  it('booking create posts the JSON file', async () => {
    const r = await runCli(
      ['booking', 'create', '--file', 'b.json', '--json'],
      {
        'POST /api/v1/bookings': (c: { body: unknown }) => [201, { id: 'BK1', ...(c.body as object) }],
      },
      { ...KEY, files: { 'b.json': JSON.stringify(payload) } },
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]!.body).toEqual(payload);
    expect(JSON.parse(r.stdout).id).toBe('BK1');
  });

  it('booking create --dry-run does not call the API; bad JSON is a usage error', async () => {
    const dry = await runCli(
      ['booking', 'create', '--file', 'b.json', '--dry-run'],
      {},
      { ...KEY, files: { 'b.json': JSON.stringify(payload) } },
    );
    expect(dry.code).toBe(0);
    expect(dry.calls).toHaveLength(0);
    const bad = await runCli(['booking', 'create', '--file', 'b.json'], {}, { ...KEY, files: { 'b.json': '{nope' } });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('not valid JSON');
  });

  it('booking list maps --status names to numeric filters', async () => {
    const r = await runCli(
      ['booking', 'list', '--status', 'Requested,booked', '--limit', '5'],
      {
        'GET /api/v1/bookings': {
          data: [{ id: 'BK1', booking_status: 2, payment_status: 1, total_price: 680000 }],
          next_cursor: 'c2',
        },
      },
      KEY,
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.calls[0]!.url.searchParams.get('filters')!)).toEqual({ booking_statuses: [2, 10] });
    expect(r.calls[0]!.url.searchParams.get('limit')).toBe('5');
    expect(r.stdout).toContain('BK1');
    expect(r.stdout).toContain('Requested');
    expect(r.stdout).toContain('--cursor c2');
  });

  it('booking issue refuses without --yes (money-moving)', async () => {
    const r = await runCli(['booking', 'issue', 'BK1'], {}, KEY);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--yes');
    expect(r.calls).toHaveLength(0);
    const ok = await runCli(
      ['booking', 'issue', 'BK1', '--yes'],
      {
        'POST /api/v1/bookings/confirmToIssue/BK1': new Response('', { status: 200 }),
        'GET /api/v1/bookings/BK1': {
          id: 'BK1',
          booking_status: 10,
          payment_status: 5,
          total_price: 660000,
          no_tickets: 2,
        },
      },
      KEY,
    );
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('Tickets issued');
  });

  it('maps API errors to exit 1 with status and errorCode', async () => {
    const r = await runCli(
      ['booking', 'get', 'BK9'],
      {
        'GET /api/v1/bookings/BK9': [
          422,
          {
            status: 422,
            errors: { name: 'InternalErrorResponse', errorCode: 120120, message: 'OrganizationBalanceNotEnough' },
          },
        ],
      },
      KEY,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('HTTP 422 errorCode=120120');
  });

  it('cancel request requires --yes and sends positions', async () => {
    const no = await runCli(
      ['cancel', 'request', '--order', 'O1', '--positions', '3,4', '--reason', 'đổi lịch'],
      {},
      KEY,
    );
    expect(no.code).toBe(2);
    expect(no.calls).toHaveLength(0);
    const r = await runCli(
      ['cancel', 'request', '--order', 'O1', '--positions', '3, 4', '--reason', 'đổi lịch', '--yes'],
      {
        'POST /api/v1/cancel-ticket-request': [201, { id: 'CR1', process_status: 'processing' }],
      },
      KEY,
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]!.body).toEqual({
      order_id: 'O1',
      cancel_ticket_by_positions: ['3', '4'],
      cancel_reason: 'đổi lịch',
    });
  });
});

describe('login', () => {
  it('stores the key with 0600 permissions after verifying it', async () => {
    const r = await runCli(['--api-key', 'ferry_abc123_secretvalue', 'login'], {
      'GET /api/v1/organizations/me': { id: 'ORG1', name: 'Nụ Cười Mê Kông', slug: 'ncmk' },
    });
    expect(r.code).toBe(0);
    const stat = fs.statSync(r.store.file);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    expect(r.store.getProfile('default')?.apiKey).toBe('ferry_abc123_secretvalue');
    expect(r.store.currentProfile()).toBe('default');
    expect(r.stdout).toContain('Nụ Cười Mê Kông');
    expect(r.stdout).not.toContain('secretvalue');
  });

  it('does not store a key the API rejects', async () => {
    const r = await runCli(['--api-key', 'bad', 'login'], {
      'GET /api/v1/organizations/me': [401, { statusCode: 401, message: 'Invalid API Key' }],
    });
    expect(r.code).toBe(3); // auth failure, as documented
    expect(r.store.read().profiles).toEqual({});
  });

  it('reads the key from stdin and then uses it for later commands; env var wins over file', async () => {
    const first = await runCli(
      ['login', '--api-key-stdin', '--no-verify'],
      {},
      { readStdin: async () => 'from_stdin_key_1234\n' },
    );
    expect(first.store.getProfile('default')?.apiKey).toBe('from_stdin_key_1234');
    const who = await runCli(['whoami', '--json'], {}, { store: first.store });
    expect(JSON.parse(who.stdout)).toMatchObject({ apiKeySource: 'profile', baseUrl: 'https://api.ferry.vn' });
    const envWins = await runCli(
      ['whoami', '--json', '--env', 'uat'],
      {},
      { store: first.store, env: { FERRY_API_KEY: 'k_env_000000000' } },
    );
    expect(JSON.parse(envWins.stdout)).toMatchObject({ apiKeySource: 'env', baseUrl: 'https://api.ferryvn.net' });
  });
});

describe('helpers', () => {
  it('parseStatuses accepts names and numbers, rejects unknown', () => {
    expect(parseStatuses('booked, 2', BookingStatus, '--status')).toEqual([10, 2]);
    expect(() => parseStatuses('Nope', BookingStatus, '--status')).toThrow(/unknown status/);
  });
  it('maskKey hides the middle of the key', () => {
    expect(maskKey('ferry_abcdef_0123456789')).toBe('ferry_…6789');
  });
  it('renderTable aligns columns', () => {
    expect(
      renderTable(
        [{ a: 'x', b: 10 }],
        [
          { header: 'A', get: (r) => r.a },
          { header: 'BB', get: (r) => r.b },
        ],
      ),
    ).toBe('A  BB\n─  ──\nx  10');
  });
});
