import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADULT, CHILD, LAYOUT, NATIONALS, VOYAGE, VOYAGE_ID } from '../../sdk/test/fixtures.js';
import { parseCsv, parsePassengers } from '../src/commands/draft-command.js';
import { ConfigStore } from '../src/config-store.js';
import { csvField, renderCsv } from '../src/output.js';
import { LOCATIONS, runCli } from './cli-harness.js';

const KEY = { env: { FERRY_API_KEY: 'ferry_key123_secretsecret' } };
const tmpStore = () => new ConfigStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ferry-cli-1x-')));

describe('endpoint + profile resolution', () => {
  it('--env wins over a base URL stored at login (0.x bug: the stored URL silently won)', async () => {
    const login = await runCli([
      '--api-key',
      'k_0123456789abc',
      '--base-url',
      'http://localhost:3000',
      'login',
      '--no-verify',
    ]);
    expect(login.store.getProfile('default')).toMatchObject({ baseUrl: 'http://localhost:3000' });
    const who = await runCli(['--env', 'uat', 'whoami', '--json'], {}, { store: login.store });
    expect(JSON.parse(who.stdout)).toMatchObject({ baseUrl: 'https://api.ferryvn.net', endpointSource: 'flag' });
    // FERRY_ENV does not move a profile's key to another endpoint (it would leak a production key to UAT).
    const fromEnv = await runCli(['whoami', '--json'], {}, { store: login.store, env: { FERRY_ENV: 'uat' } });
    expect(JSON.parse(fromEnv.stdout)).toMatchObject({ baseUrl: 'http://localhost:3000', endpointSource: 'profile' });
    expect(fromEnv.stderr).toContain('FERRY_ENV/FERRY_BASE_URL ignored');
    // …but it applies to a key that comes from the environment too.
    const envKey = await runCli(
      ['whoami', '--json'],
      {},
      { store: login.store, env: { FERRY_ENV: 'uat', FERRY_API_KEY: 'env_key_0123456789' } },
    );
    expect(JSON.parse(envKey.stdout)).toMatchObject({ baseUrl: 'https://api.ferryvn.net', apiKeySource: 'env' });
    const stored = await runCli(['whoami', '--json'], {}, { store: login.store });
    expect(JSON.parse(stored.stdout)).toMatchObject({ baseUrl: 'http://localhost:3000', endpointSource: 'profile' });
  });

  it('keeps production and UAT keys in named profiles', async () => {
    const store = tmpStore();
    await runCli(['--api-key', 'prod_key_0123456789', 'login', '--no-verify'], {}, { store });
    await runCli(
      ['--profile', 'uat', '--env', 'uat', '--api-key', 'uat_key_0123456789', 'login', '--no-verify'],
      {},
      { store },
    );
    expect(store.getProfile('uat')).toEqual({ apiKey: 'uat_key_0123456789', environment: 'uat' });
    const list = await runCli(['profiles', '--json'], {}, { store });
    expect(JSON.parse(list.stdout)).toEqual([
      { name: 'default', current: true, endpoint: 'https://api.ferry.vn', apiKey: 'prod_k…6789' },
      { name: 'uat', current: false, endpoint: 'https://api.ferryvn.net', apiKey: 'uat_ke…6789' },
    ]);
    const viaFlag = await runCli(['--profile', 'uat', 'locations'], { 'GET /api/v1/locations': LOCATIONS }, { store });
    expect(viaFlag.calls[0]!.url.origin).toBe('https://api.ferryvn.net');
    await runCli(['profiles', 'use', 'uat'], {}, { store });
    const who = await runCli(['whoami', '--json'], {}, { store });
    expect(JSON.parse(who.stdout)).toMatchObject({ profile: 'uat', apiKey: 'uat_ke…6789' });
    expect((await runCli(['profiles', 'use', 'nope'], {}, { store })).code).toBe(2);
    expect(
      (await runCli(['--profile', 'bad name!', 'login', '--no-verify', '--api-key', 'x'], {}, { store })).code,
    ).toBe(2);
    const out = await runCli(['--profile', 'uat', 'logout'], {}, { store });
    expect(out.code).toBe(0);
    expect(store.getProfile('uat')).toBeUndefined();
  });

  it('reads a 0.x flat config file as the default profile', async () => {
    const store = tmpStore();
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(store.file, JSON.stringify({ apiKey: 'legacy_key_0123456789' }));
    const who = await runCli(['whoami', '--json'], {}, { store });
    expect(JSON.parse(who.stdout)).toMatchObject({
      profile: 'default',
      apiKey: 'legacy…6789',
      apiKeySource: 'profile',
    });
  });

  it('rejects an invalid --env, FERRY_ENV or --timeout as usage errors', async () => {
    expect((await runCli(['--env', 'staging', 'locations'])).code).toBe(2);
    expect((await runCli(['locations'], {}, { env: { FERRY_ENV: 'prod' } })).code).toBe(2);
    expect((await runCli(['--timeout', 'abc', 'locations'])).code).toBe(2);
  });
});

describe('output formats', () => {
  it('csv: header row, UTF-8 BOM, quoting and spreadsheet-formula neutralisation', async () => {
    const r = await runCli(['--output', 'csv', 'locations'], { 'GET /api/v1/locations': LOCATIONS });
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('﻿ID,ABBR,NAME,DISABLED\r\n')).toBe(true);
    expect(r.stdout).toContain('Phú Quốc');
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('-5')).toBe('-5');
    expect(renderCsv([], [{ header: 'A', get: () => 1 }])).toBe('﻿A\r\n');
  });

  it('ndjson prints one raw object per line; json wraps pages with next_cursor', async () => {
    const page = { data: [{ id: 'BK1' }, { id: 'BK2' }], next_cursor: 'c2' };
    const nd = await runCli(['-o', 'ndjson', 'booking', 'list'], { 'GET /api/v1/bookings': page }, KEY);
    expect(
      nd.stdout
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).id),
    ).toEqual(['BK1', 'BK2']);
    const js = await runCli(['--json', 'booking', 'list'], { 'GET /api/v1/bookings': page }, KEY);
    expect(JSON.parse(js.stdout)).toEqual(page);
  });
});

describe('money-moving confirmations and exit codes', () => {
  const routes = {
    'GET /api/v1/bookings/BK1': { id: 'BK1', booking_status: 2, payment_status: 1, total_price: 660000, no_tickets: 2 },
    'GET /api/v1/organizations/reservable-credit': new Response('9000000', { status: 200 }),
    'POST /api/v1/bookings/confirmToIssue/BK1': new Response('', { status: 200 }),
  };

  it('booking issue on a TTY shows the amount and needs the booking id typed back', async () => {
    let asked = '';
    const wrong = await runCli(['booking', 'issue', 'BK1'], routes, {
      ...KEY,
      stdinIsTTY: true,
      prompt: async (q) => {
        asked = q;
        return 'nope';
      },
    });
    expect(wrong.code).toBe(2);
    expect(asked).toContain('BK1');
    expect(wrong.stderr).toContain('660.000 ₫');
    expect(wrong.calls.some((c) => c.method === 'POST')).toBe(false);

    const right = await runCli(['booking', 'issue', 'BK1'], routes, {
      ...KEY,
      stdinIsTTY: true,
      prompt: async () => 'BK1',
    });
    expect(right.code).toBe(0);
    expect(right.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('maps 401/403 → 3, 404 → 4, 429 → 5 and prints the request id', async () => {
    const auth = await runCli(
      ['booking', 'get', 'X'],
      { 'GET /api/v1/bookings/X': [403, { statusCode: 403, message: 'Access denied' }] },
      KEY,
    );
    expect(auth.code).toBe(3);
    expect(auth.stderr).toMatch(/request id: [0-9a-f-]{36}/);
    expect((await runCli(['orders', 'get', 'X'], {}, KEY)).code).toBe(4);
    const limited = await runCli(
      ['booking', 'list'],
      {
        'GET /api/v1/bookings': () =>
          new Response('{"statusCode":429}', { status: 429, headers: { 'retry-after': '30' } }),
      },
      KEY,
    );
    expect(limited.code).toBe(5);
    expect(limited.stderr).toContain('retry in 30 s');
  });

  it('cancel request on a TTY needs the order id typed back', async () => {
    const r = await runCli(
      ['cancel', 'request', '--order', 'O1', '--positions', '3', '--reason', 'đổi lịch'],
      { 'POST /api/v1/cancel-ticket-request': [201, { id: 'CR1', process_status: 'processing' }] },
      { ...KEY, stdinIsTTY: true, prompt: async () => 'O1' },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('CR1');
  });
});

describe('booking draft', () => {
  const routes = {
    'GET /api/v1/boatLayouts/latestByVoyageId': LAYOUT,
    [`GET /api/v1/voyages/${VOYAGE_ID}`]: VOYAGE,
    'GET /api/v1/operators/nationals/OP1': NATIONALS,
    'POST /api/v1/bookings': [201, { id: 'BK777777' }],
    'GET /api/v1/bookings/BK777777': {
      id: 'BK777777',
      booking_status: 2,
      payment_status: 1,
      total_price: 580000,
      no_tickets: 2,
    },
  };
  const csv = `﻿name,date_of_birth,social_id,home_town,gender\r\n"${ADULT.name}",${ADULT.dateOfBirth},${ADULT.socialId},Cần Thơ,nam\r\n${CHILD.name},${CHILD.dateOfBirth},${CHILD.socialId},"Cần Thơ",nữ\r\n`;
  const base = [
    'booking',
    'draft',
    '--customer',
    '1001',
    '--orderer-name',
    'Nguyễn Văn A',
    '--email',
    'a@example.com',
    '--voyage',
    VOYAGE_ID,
  ];

  it('builds the payload from a spreadsheet CSV and writes it with --out (no POST)', async () => {
    const r = await runCli([...base, '--seats', 'A1,A3', '--passengers', 'p.csv', '--out', 'booking.json'], routes, {
      ...KEY,
      files: { 'p.csv': csv },
    });
    expect(r.code).toBe(0);
    expect(r.calls.some((c) => c.method === 'POST')).toBe(false);
    const payload = JSON.parse(r.written['booking.json']!);
    expect(
      payload.depart_order.tickets.map((t: { seat_name: string; ticket_type_id: number }) => [
        t.seat_name,
        t.ticket_type_id,
      ]),
    ).toEqual([
      ['A1', 1],
      ['A3', 4],
    ]);
    expect(payload.depart_order.tickets[1].gender).toBe(0);
    expect(r.stdout).toContain('580.000 ₫');
  });

  it('--create posts the draft; draft problems are usage errors before any write', async () => {
    const ok = await runCli([...base, '--passengers', 'p.json', '--create', '--json'], routes, {
      ...KEY,
      files: { 'p.json': JSON.stringify([ADULT, CHILD]) },
    });
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).booking.id).toBe('BK777777');
    const bad = await runCli([...base, '--seats', 'A2', '--passengers', 'p.json', '--create'], routes, {
      ...KEY,
      files: { 'p.json': JSON.stringify([ADULT]) },
    });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('seat A2 is booked');
    expect(bad.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('uses one CSV delimiter per file (a ";" inside a comma-separated value stays in the value)', () => {
    expect(parseCsv('name,home_town\nA,Phường 1; Quận 3')).toEqual([
      ['name', 'home_town'],
      ['A', 'Phường 1; Quận 3'],
    ]);
    expect(parseCsv('name;home_town\nA;Cần Thơ')).toEqual([
      ['name', 'home_town'],
      ['A', 'Cần Thơ'],
    ]);
  });

  it('parses CSV quoting and passenger column aliases', () => {
    expect(parseCsv('a,"b ""q"", c"\n1,2')).toEqual([
      ['a', 'b "q", c'],
      ['1', '2'],
    ]);
    expect(parsePassengers('ho_ten,ngay_sinh,cccd,que_quan\nA,1990-01-01,1,CT')).toEqual([
      { name: 'A', dateOfBirth: '1990-01-01', socialId: '1', homeTown: 'CT' },
    ]);
    expect(() => parsePassengers('name,unknown_col\nA,1')).toThrow(/unknown column/);
  });
});

describe('organization commands', () => {
  it('customers search, create (VN country code) and account', async () => {
    const list = await runCli(
      ['customers', '--search', '0901234567', '--json'],
      { 'GET /api/v1/customers': { data: [], next_cursor: null } },
      KEY,
    );
    expect(JSON.parse(list.calls[0]!.url.searchParams.get('filters')!)).toEqual({ namePhoneEmail: '0901234567' });
    const created = await runCli(
      ['customers', 'create', '--first-name', 'An', '--phone', '0901234567'],
      { 'POST /api/v1/customers': (c: { body: unknown }) => [201, { id: 42, ...(c.body as object) }] },
      KEY,
    );
    expect(created.code).toBe(0);
    expect(created.calls[0]!.body).toEqual({ first_name: 'An', phone: '0901234567', phone_country_code: 'VN' });
    const account = await runCli(
      ['account'],
      {
        'GET /api/v1/organizations/me': {
          id: 'O',
          name: 'Nụ Cười Mê Kông',
          slug: 'ncmk',
          credit: 1000000,
          upward_balance: 0,
          downward_balance: 0,
        },
        'GET /api/v1/organizations/reservable-credit': new Response('750000', { status: 200 }),
      },
      KEY,
    );
    expect(account.stdout).toContain('750.000 ₫');
  });

  it('calendar, disruptions and transactions map flags to query params', async () => {
    const cal = await runCli(
      ['calendar', '--from', 'RG', '--to', 'PQ', '--start', '2026-10-20', '--days', '3'],
      {
        'GET /api/v1/locations': LOCATIONS,
        'GET /api/v1/voyage-counts': [{ departure_date: '2026-10-20', total_voyage: 6, total_available_voyage: 4 }],
      },
      KEY,
    );
    const c = cal.calls.at(-1)!.url.searchParams;
    expect([c.get('depart_date_from'), c.get('depart_date_to')]).toEqual(['2026-10-20', '2026-10-22']);
    const dis = await runCli(
      ['disruptions', '--state', 'active', '--since', '2026-10-01T00:00:00Z'],
      { 'GET /api/v1/disruptions': { data: [] } },
      KEY,
    );
    expect(dis.calls[0]!.url.searchParams.get('state')).toBe('active');
    expect((await runCli(['disruptions', '--state', 'weird'], {}, KEY)).code).toBe(2);
    const tx = await runCli(
      ['transactions', '--type', 'pb,rf', '--booking', 'BK1'],
      { 'GET /api/v1/transactions': { data: [], next_cursor: null } },
      KEY,
    );
    expect(JSON.parse(tx.calls[0]!.url.searchParams.get('filters')!)).toEqual({
      booking_id: 'BK1',
      types: ['PB', 'RF'],
    });
  });
});

describe('not found exit code', () => {
  it('cancel get of an unknown id exits 4', async () => {
    const r = await runCli(
      ['cancel', 'get', 'NOPE'],
      { 'GET /api/v1/cancel-ticket-request': { data: [], next_cursor: null } },
      KEY,
    );
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('cancel ticket request NOPE not found');
  });
});

describe('utilities', () => {
  it('ferry api calls any path with the configured key', async () => {
    const r = await runCli(
      ['api', 'get', 'ticket-price-additions', '-q', 'limit=5'],
      { 'GET /api/v1/ticket-price-additions': { data: [{ id: 'T1' }] } },
      KEY,
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]!.url.searchParams.get('limit')).toBe('5');
    expect(JSON.parse(r.stdout).data[0].id).toBe('T1');
    expect((await runCli(['api', 'TRACE', '/x'], {}, KEY)).code).toBe(2);
  });

  it('doctor reports failing checks with exit 1', async () => {
    const r = await runCli(
      ['doctor', '--json'],
      { 'GET /api/v1/locations': LOCATIONS, 'GET /api/v1/organizations/me': [401, { statusCode: 401 }] },
      KEY,
    );
    expect(r.code).toBe(1);
    const checks = JSON.parse(r.stdout).checks as Array<{ check: string; ok: boolean }>;
    expect(checks.find((c) => c.check === 'connectivity')!.ok).toBe(true);
    expect(checks.find((c) => c.check === 'authentication')!.ok).toBe(false);
  });

  it('prints bash completion covering subcommands', async () => {
    const r = await runCli(['completion', 'bash']);
    expect(r.stdout).toContain('complete -F _ferry ferry');
    expect(r.stdout).toContain('"booking") opts="create draft get public list update issue tickets');
  });
});

describe('audit regressions (2026-10-18)', () => {
  it('validates --output before any request, so a write is never followed by a usage error', async () => {
    const r = await runCli(
      ['-o', 'xml', 'booking', 'create', '--file', 'b.json'],
      { 'POST /api/v1/bookings': { id: 'B1' } },
      {
        ...KEY,
        files: { 'b.json': '{}' },
      },
    );
    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(0);
    expect((await runCli(['-o', 'JSON', 'whoami'], {}, KEY)).code).toBe(0);
  });

  it('an explicit profile wins over FERRY_API_KEY and an unknown profile is refused', async () => {
    const store = tmpStore();
    await runCli(
      ['--profile', 'uat', '--env', 'uat', '--api-key', 'uat_key_0123456789', 'login', '--no-verify'],
      {},
      { store },
    );
    const env = { FERRY_API_KEY: 'prod_key_0123456789' };
    const who = JSON.parse((await runCli(['--profile', 'uat', 'whoami', '--json'], {}, { store, env })).stdout);
    expect(who).toMatchObject({ baseUrl: 'https://api.ferryvn.net', apiKey: 'uat_ke…6789', apiKeySource: 'profile' });
    const typo = await runCli(['--profile', 'uta', 'whoami'], {}, { store, env });
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain('unknown profile "uta"');
  });

  it('login saves the environment given by FERRY_ENV', async () => {
    const store = tmpStore();
    await runCli(
      ['--profile', 'staging', '--api-key', 'k_0123456789abc', 'login', '--no-verify'],
      {},
      { store, env: { FERRY_ENV: 'uat' } },
    );
    expect(store.getProfile('staging')).toEqual({ apiKey: 'k_0123456789abc', environment: 'uat' });
  });

  it('refuses a config file it cannot parse instead of wiping it on the next save', async () => {
    const store = tmpStore();
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(store.file, '// comment\n{"profiles":{"default":{"apiKey":"x"}}}');
    const r = await runCli(['profiles'], {}, { store });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('is not valid JSON');
    fs.writeFileSync(store.file, '\uFEFF{"profiles":{"default":{"apiKey":"k_0123456789abc"}}}');
    expect((await runCli(['profiles', '--json'], {}, { store })).code).toBe(0);
  });

  it('ndjson prints single objects as one compact line', async () => {
    const r = await runCli(['-o', 'ndjson', 'whoami'], {}, KEY);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('a missing input file is a usage error (exit 2)', async () => {
    const r = await runCli(['booking', 'create', '--file', 'missing.json'], {}, KEY);
    expect(r.code).toBe(2);
  });
});

describe('audit regressions — input and output (2026-10-18)', () => {
  it('reads Vietnamese headers, Excel trailing columns, stray quotes and NFD text', () => {
    const csv =
      'Họ tên;Ngày sinh;Số CCCD;Quê quán;Giới tính;;\nNguyen "Ti;1990-01-01;079090000001;Cần Thơ;nũ;;\nB;2018-01-01;079090000002;Cần Thơ;Nam;;';
    expect(parsePassengers(csv)).toEqual([
      {
        name: 'Nguyen "Ti',
        dateOfBirth: '1990-01-01',
        socialId: '079090000001',
        homeTown: 'Cần Thơ',
        gender: 'female',
      },
      { name: 'B', dateOfBirth: '2018-01-01', socialId: '079090000002', homeTown: 'Cần Thơ', gender: 'male' },
    ]);
  });

  it('refuses a passenger file that is not UTF-8 instead of booking garbled names', () => {
    expect(() => parsePassengers('name,date_of_birth,social_id,home_town\nNguy�n,1990-01-01,1,C')).toThrow(/CSV UTF-8/);
  });

  it('validates transaction dates and sends Vietnam-day bounds', async () => {
    const routes = { 'GET /api/v1/transactions': { data: [], next_cursor: null } };
    expect((await runCli(['transactions', '--from-date', '18/10/2026'], routes, KEY)).code).toBe(2);
    const r = await runCli(['transactions', '--from-date', '2026-10-18', '--to-date', '2026-10-18'], routes, KEY);
    expect(JSON.parse(r.calls[0]!.url.searchParams.get('filters')!)).toEqual({
      createdAtFrom: '2026-10-18T00:00:00.000+07:00',
      createdAtTo: '2026-10-18T23:59:59.999+07:00',
    });
  });

  it('writes raw numbers for amounts in CSV and keeps the formatted value in tables', async () => {
    const routes = {
      'GET /api/v1/transactions': {
        data: [{ id: 'T1', amount: -1250000, type: 'RF', createdAt: '2026-10-18T01:00:00.000Z' }],
        next_cursor: null,
      },
    };
    const csv = await runCli(['transactions', '-o', 'csv'], routes, KEY);
    expect(csv.stdout).toContain(',-1250000');
    expect(csv.stdout).not.toContain("'-");
    expect((await runCli(['transactions'], routes, KEY)).stdout).toContain('-1.250.000 ₫');
  });

  it('raw API writes need --yes; --return-seats needs --return-voyage; --country-code overrides --data', async () => {
    const post = await runCli(['api', 'POST', '/bookings/confirmToIssue/BK1'], {}, KEY);
    expect(post.code).toBe(2);
    expect(post.calls).toHaveLength(0);
    const ret = await runCli(
      [
        'booking',
        'draft',
        '--customer',
        '1',
        '--orderer-name',
        'A',
        '--email',
        'a@b.co',
        '--voyage',
        'V1',
        '--passengers',
        'p.json',
        '--return-seats',
        'A1',
      ],
      {},
      { ...KEY, files: { 'p.json': '[]' } },
    );
    expect(ret.stderr).toContain('--return-seats needs --return-voyage');
    const created = await runCli(
      [
        'customers',
        'create',
        '--data',
        '{"first_name":"A","phone_country_code":"US"}',
        '--country-code',
        'KR',
        '--json',
      ],
      { 'POST /api/v1/customers': (c: { body: unknown }) => ({ id: 1, ...(c.body as object) }) },
      KEY,
    );
    expect(created.calls[0]!.body).toMatchObject({ phone_country_code: 'KR' });
  });

  it('bash completion skips the values of global options', async () => {
    const r = await runCli(['completion', 'bash']);
    expect(r.stdout).toMatch(/case "\$w" in [^)]*--profile[^)]*\) skip=1/);
  });
});
