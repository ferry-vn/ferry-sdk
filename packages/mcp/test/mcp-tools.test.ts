import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { FerryClient } from '@ferryvn/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ADULT, CHILD, LAYOUT, LOCATIONS, NATIONALS, VOYAGE, VOYAGE_ID } from '../../sdk/test/fixtures.js';
import { createFerryHttpServer, resolveHttpSecurity } from '../src/http-server.js';
import {
  callTool,
  configFromEnv,
  createFerryMcpServer,
  createWriteGuard,
  type FerryTool,
  READ_TOOLS,
  selectTools,
  WRITE_TOOLS,
  writesFor,
} from '../src/server.js';

interface Call {
  method: string;
  url: URL;
  body: unknown;
}

const BASE_ROUTES: Record<string, unknown> = {
  'GET /api/v1/locations': LOCATIONS,
  'GET /api/v1/boatLayouts/latestByVoyageId': LAYOUT,
  [`GET /api/v1/voyages/${VOYAGE_ID}`]: VOYAGE,
  'GET /api/v1/operators/nationals/OP1': NATIONALS,
  'POST /api/v1/bookings': { id: 'BK123456' },
  'GET /api/v1/orders/O1': {
    id: 'O1',
    order_status: 3,
    voyage_id: VOYAGE_ID,
    voyage: VOYAGE,
    tickets: [
      { position_id: 3, name: 'Trần Thị B', seat_name: 'A1', is_cancelled: false },
      { position_id: 4, name: 'Lê Văn C', seat_name: 'A2', is_cancelled: true },
    ],
  },
  'GET /api/v1/bookings/BK123456': { id: 'BK123456', booking_status: 2, payment_status: 1, total_price: 580000 },
};

/** FerryClient whose fetch answers from a "METHOD /path" map and records calls. */
function fakeClient(routes: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const all = { ...BASE_ROUTES, ...routes };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const key = `${method} ${url.pathname}`;
    const body = key in all ? all[key] : { data: [], next_cursor: null };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const client = new FerryClient({
    apiKey: 'k',
    fetch: fetchImpl as unknown as typeof fetch,
    retry: { maxRetries: 0 },
  });
  return { client, calls };
}

const parse = (tool: FerryTool, args: unknown) => z.object(tool.inputSchema).safeParse(args);
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0]!.text!;
const posts = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

function ctxFor(client: FerryClient, opts: { maxWrites?: number; elicitation?: boolean } = {}) {
  const audit: string[] = [];
  const mcp = {
    server: {
      getClientCapabilities: () => (opts.elicitation ? { elicitation: { form: {} } } : {}),
      elicitInput: vi.fn(async () => ({ action: 'accept', content: { confirm: true } })),
    },
  };
  return {
    ctx: { sdk: client, mcp: mcp as never, writes: createWriteGuard(opts.maxWrites ?? 5, (l) => audit.push(l)) },
    audit,
    mcp,
  };
}

const READ_NAMES = [
  'search_locations',
  'list_routes',
  'search_voyages',
  'get_route_prices',
  'get_voyage_calendar',
  'get_seat_map',
  'quote_booking',
  'find_customers',
  'get_booking',
  'list_bookings',
  'list_cancel_requests',
  'get_disruptions',
  'get_account',
  'list_vouchers',
];
const tool = (name: string) => [...READ_TOOLS, ...WRITE_TOOLS].find((t) => t.name === name) as unknown as FerryTool;

const bookingArgs = {
  customer_id: 1001,
  orderer_name: 'Nguyễn Văn A',
  contact_email: 'a@example.com',
  passengers: [
    {
      name: ADULT.name,
      date_of_birth: ADULT.dateOfBirth,
      social_id: ADULT.socialId,
      home_town: 'Cần Thơ',
      gender: 'male',
    },
    { name: CHILD.name, date_of_birth: CHILD.dateOfBirth, social_id: CHILD.socialId, home_town: 'Cần Thơ' },
  ],
  depart: { voyage_id: VOYAGE_ID, seats: ['A1', 'A3'] },
};

describe('write gating', () => {
  it('exposes only read-only tools by default', () => {
    expect(selectTools(false).map((t) => t.name)).toEqual(READ_NAMES);
    expect(READ_TOOLS.every((t) => t.annotations.readOnlyHint === true && !t.write)).toBe(true);
  });

  it('adds the three write tools only when enabled', () => {
    expect(selectTools(true).map((t) => t.name)).toEqual([
      ...READ_NAMES,
      'create_customer',
      'create_booking',
      'request_cancellation',
    ]);
    expect(WRITE_TOOLS.every((t) => t.write && t.annotations.readOnlyHint === false)).toBe(true);
  });

  it('parses env strictly', () => {
    expect(configFromEnv({ FERRY_MCP_ENABLE_WRITES: 'true' }).enableWrites).toBe(true);
    for (const v of ['1', 'TRUE', 'yes', ''])
      expect(configFromEnv({ FERRY_MCP_ENABLE_WRITES: v }).enableWrites).toBe(false);
    expect(() => configFromEnv({ FERRY_TIMEOUT_MS: 'abc' })).toThrow(/FERRY_TIMEOUT_MS/);
    expect(() => configFromEnv({ FERRY_ENV: 'staging' })).toThrow(/FERRY_ENV/);
    expect(() => configFromEnv({ FERRY_MCP_MAX_WRITES: '-1' })).toThrow(/MAX_WRITES/);
    expect(configFromEnv({ FERRY_MCP_ALLOWED_HOSTS: 'a:1, b:2' }).http.allowedHosts).toEqual(['a:1', 'b:2']);
  });

  it('serves write tools over HTTP only with a second opt-in', () => {
    const on = configFromEnv({ FERRY_MCP_ENABLE_WRITES: 'true' });
    expect(writesFor(on, 'stdio')).toEqual({ enableWrites: true, warning: undefined });
    expect(writesFor(on, 'http')).toMatchObject({ enableWrites: false, warning: /FERRY_MCP_HTTP_ALLOW_WRITES/ });
    const both = configFromEnv({ FERRY_MCP_ENABLE_WRITES: 'true', FERRY_MCP_HTTP_ALLOW_WRITES: 'true' });
    expect(writesFor(both, 'http').enableWrites).toBe(true);
    // The HTTP opt-in alone never enables writes.
    expect(writesFor(configFromEnv({ FERRY_MCP_HTTP_ALLOW_WRITES: 'true' }), 'http').enableWrites).toBe(false);
  });

  it('FERRY_MCP_DISABLED_TOOLS hides tools and rejects unknown names', () => {
    const cfg = configFromEnv({ FERRY_MCP_DISABLED_TOOLS: 'list_bookings, request_cancellation' });
    expect(cfg.disabledTools).toEqual(['list_bookings', 'request_cancellation']);
    const names = selectTools(true, cfg.disabledTools).map((t) => t.name);
    expect(names).not.toContain('list_bookings');
    expect(names).not.toContain('request_cancellation');
    expect(names).toContain('create_booking');
    expect(() => configFromEnv({ FERRY_MCP_DISABLED_TOOLS: 'list_booking' })).toThrow(/unknown tool list_booking/);
  });

  it('create_booking rejects price-changing or unknown fields', () => {
    const t = tool('create_booking');
    expect(parse(t, bookingArgs).success).toBe(true);
    expect(
      parse(t, { ...bookingArgs, depart: { ...bookingArgs.depart, discount: { discount_amount: 1 } } }).success,
    ).toBe(false);
    expect(
      parse(t, { ...bookingArgs, passengers: [{ ...bookingArgs.passengers[0], ticket_price_id: 1 }] }).success,
    ).toBe(false);
  });

  it('no tool ever reaches money-moving or admin endpoints', async () => {
    const { client, calls } = fakeClient();
    const { ctx } = ctxFor(client);
    const samples: Record<string, unknown> = {
      search_locations: { query: 'pq' },
      list_routes: {},
      search_voyages: { from: 'RG', to: 'PQ', date: '2026-10-20' },
      get_route_prices: { from: 'RG', to: 'PQ', date: '2026-10-20', live: 1 },
      get_voyage_calendar: { from: 'RG', to: 'PQ' },
      get_seat_map: { voyage_id: VOYAGE_ID },
      quote_booking: bookingArgs,
      find_customers: { query: '0901234567' },
      get_booking: { booking_id: 'BK123456' },
      list_bookings: {},
      list_cancel_requests: {},
      get_disruptions: {},
      get_account: {},
      list_vouchers: {},
      create_customer: { first_name: 'An', user_confirmed: true },
      create_booking: { ...bookingArgs, user_confirmed: true },
      request_cancellation: { order_id: 'O1', positions: [3], reason: 'đổi lịch', user_confirmed: true },
    };
    for (const t of selectTools(true)) {
      expect(samples, `sample args for ${t.name}`).toHaveProperty(t.name);
      await callTool(t, ctx, samples[t.name]);
    }
    const paths = calls.map((c) => c.url.pathname);
    expect(
      paths.some((p) => /confirmToIssue|payments|transactions|withdraw|top-?up|debt|settings|api-keys/.test(p)),
    ).toBe(false);
    expect(
      posts(calls)
        .map((c) => c.url.pathname)
        .sort(),
    ).toEqual(['/api/v1/bookings', '/api/v1/cancel-ticket-request', '/api/v1/customers'].sort());
  });
});

describe('write confirmation, budget and audit', () => {
  it('without elicitation support, a write needs user_confirmed=true and shows what will happen', async () => {
    const { client, calls } = fakeClient();
    const { ctx } = ctxFor(client);
    const res = await callTool(tool('create_booking'), ctx, bookingArgs);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Confirmation required[\s\S]*A1[\s\S]*A3[\s\S]*580\.000 ₫/);
    expect(posts(calls)).toHaveLength(0);
  });

  it('builds the payload from seat names, creates the booking and audits it', async () => {
    const { client, calls } = fakeClient();
    const { ctx, audit } = ctxFor(client);
    const res = await callTool(tool('create_booking'), ctx, { ...bookingArgs, user_confirmed: true });
    expect(res.isError).toBeUndefined();
    const body = posts(calls)[0]!.body as { depart_order: { tickets: Array<Record<string, unknown>> } };
    expect(body.depart_order.tickets.map((t) => [t.seat_name, t.ticket_type_id, t.is_child, t.national_id])).toEqual([
      ['A1', 1, false, '1'],
      ['A3', 4, true, '1'],
    ]);
    expect(res.structuredContent).toMatchObject({ created: true, booking: { booking_id: 'BK123456' } });
    expect(JSON.parse(audit[0]!)).toMatchObject({
      tool: 'create_booking',
      ok: true,
      summary: { booking_id: 'BK123456', tickets: 2 },
    });
    expect(audit[0]).not.toContain(ADULT.socialId);
  });

  it('draft problems come back as actionable errors before anything is written', async () => {
    const { client, calls } = fakeClient();
    const { ctx } = ctxFor(client);
    const res = await callTool(tool('create_booking'), ctx, {
      ...bookingArgs,
      depart: { voyage_id: VOYAGE_ID, seats: ['A2', 'A3'] },
      user_confirmed: true,
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('seat A2 is booked');
    expect(posts(calls)).toHaveLength(0);
  });

  it('uses the client confirmation dialog when available (decline → nothing written)', async () => {
    const { client, calls } = fakeClient();
    const { ctx, mcp } = ctxFor(client, { elicitation: true });
    mcp.server.elicitInput.mockResolvedValueOnce({ action: 'decline' } as never);
    const declined = await callTool(tool('request_cancellation'), ctx, {
      order_id: 'O1',
      positions: ['3'],
      reason: 'đổi lịch',
      user_confirmed: true,
    });
    expect(declined.isError).toBe(true);
    expect(posts(calls)).toHaveLength(0);
    const accepted = await callTool(tool('request_cancellation'), ctx, {
      order_id: 'O1',
      positions: ['3'],
      reason: 'đổi lịch',
    });
    expect(accepted.isError).toBeUndefined();
    expect(posts(calls)).toHaveLength(1);
    expect(mcp.server.elicitInput).toHaveBeenCalledTimes(2);
  });

  it('a cancellation names the voyage and passengers and refuses unknown or cancelled positions', async () => {
    const { client, calls } = fakeClient();
    const { ctx } = ctxFor(client);
    const ask = await callTool(tool('request_cancellation'), ctx, {
      order_id: 'O1',
      positions: [3],
      reason: 'đổi lịch',
    });
    expect(text(ask)).toMatch(
      /Confirmation required[\s\S]*1 of 2 ticket\(s\) of order O1 — Rạch Giá → Phú Quốc, 2036-10-20 08:00: Trần Thị B \(seat A1\)/,
    );
    const unknown = await callTool(tool('request_cancellation'), ctx, {
      order_id: 'O1',
      positions: [9],
      reason: 'đổi lịch',
      user_confirmed: true,
    });
    expect(text(unknown)).toMatch(/no ticket at position 9\. Valid positions: 3/);
    const cancelled = await callTool(tool('request_cancellation'), ctx, {
      order_id: 'O1',
      positions: ['4'],
      reason: 'đổi lịch',
      user_confirmed: true,
    });
    expect(text(cancelled)).toMatch(/already cancelled/);
    expect(posts(calls)).toHaveLength(0);
  });

  it('stops after FERRY_MCP_MAX_WRITES write calls', async () => {
    const { client, calls } = fakeClient();
    const { ctx } = ctxFor(client, { maxWrites: 1 });
    const args = { first_name: 'An', user_confirmed: true };
    expect((await callTool(tool('create_customer'), ctx, args)).isError).toBeUndefined();
    const second = await callTool(tool('create_customer'), ctx, args);
    expect(second.isError).toBe(true);
    expect(text(second)).toMatch(/budget exhausted/);
    expect(posts(calls)).toHaveLength(1);
  });
});

describe('review regressions', () => {
  it('a failing audit sink never turns a completed write into an error (no duplicate on retry)', async () => {
    const { client, calls } = fakeClient();
    const guard = createWriteGuard(5, () => {
      throw new Error('EACCES: audit file');
    });
    const ctx = { sdk: client, mcp: ctxFor(client).mcp as never, writes: guard };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const res = await callTool(tool('create_customer'), ctx, { first_name: 'An', user_confirmed: true });
    stderr.mockRestore();
    expect(res.isError).toBeUndefined();
    expect(posts(calls)).toHaveLength(1);
  });

  it('extra allowed hosts/origins extend the loopback defaults; empty values are ignored', () => {
    const sec = resolveHttpSecurity({
      host: '127.0.0.1',
      port: 3333,
      token: 'x'.repeat(16),
      allowedHosts: ['proxy.local:3333', ''],
      allowedOrigins: [],
    });
    expect(sec.allowedHosts).toEqual(['127.0.0.1:3333', 'localhost:3333', '[::1]:3333', 'proxy.local:3333']);
    expect(sec.allowedOrigins).toContain('http://localhost:3333');
    const open = resolveHttpSecurity({
      host: '0.0.0.0',
      port: 80,
      token: 'x'.repeat(16),
      allowedHosts: ['mcp.example.com'],
    });
    expect(open.allowedHosts).toEqual(['mcp.example.com']);
  });
});

describe('read tools', () => {
  it('search_voyages resolves names and returns compact voyages', async () => {
    const { client, calls } = fakeClient({
      'GET /api/v1/voyages/findAllRelateByLocationAndDate': {
        data: [
          {
            voyage: { ...VOYAGE, arrive_time: '10:30', no_remain: 12, ticket_prices: { default_ticket_price: 330000 } },
          },
        ],
        next_cursor: null,
      },
    });
    const res = await callTool(tool('search_voyages'), ctxFor(client).ctx, {
      from: 'rach gia',
      to: 'PQ',
      date: '2026-10-20',
      depart_after: '07:00',
      operator_ids: ['OP1'],
    });
    const out = res.structuredContent as { voyages: Array<Record<string, unknown>> };
    expect(out.voyages[0]).toMatchObject({
      voyage_id: VOYAGE_ID,
      seats_left: 12,
      from_price_vnd: 330000,
      route: 'Rạch Giá → Phú Quốc',
    });
    // Compact JSON in the text block (pretty-printing wastes model tokens).
    expect(text(res)).not.toContain('\n');
    const search = calls.find((c) => c.url.pathname.endsWith('findAllRelateByLocationAndDate'))!;
    expect(JSON.parse(search.url.searchParams.get('filters')!)).toEqual({
      min_depart_time: '07:00:00',
      operator_ids: ['OP1'],
    });
    // Locations were fetched once for both lookups (SDK cache).
    expect(calls.filter((c) => c.url.pathname === '/api/v1/locations')).toHaveLength(1);
  });

  it('get_seat_map groups free seats by seat type with prices, harbor fee and ticket-type rules', async () => {
    const { client } = fakeClient({
      [`GET /api/v1/voyages/${VOYAGE_ID}`]: {
        ...VOYAGE,
        route: { ...VOYAGE.route, operators: [{ operator_id: 'OP1', harbor_fee: 10000 }] },
      },
    });
    const res = await callTool(tool('get_seat_map'), ctxFor(client).ctx, { voyage_id: VOYAGE_ID });
    expect(res.structuredContent).toMatchObject({
      departure: '2036-10-20 08:00',
      total_seats: 5,
      available_seats: 4,
      harbor_fee_per_ticket_vnd: 10000,
      seat_types: [
        { seat_type: 'ECO', free_count: 3, free_seats: ['A1', 'A3', 'A4'] },
        { seat_type: 'VIP', free_count: 1, free_seats: ['V1'], prices: [{ ticket_type_id: 1, price_vnd: 500000 }] },
      ],
      ticket_types: [
        { ticket_type_id: 1, rules: 'MIN_AGE 12, MAX_AGE 59' },
        { ticket_type_id: 4, rules: 'MIN_AGE 1, MAX_AGE 11' },
        { ticket_type_id: 2, rules: 'MIN_AGE 60' },
      ],
    });
    expect(res.structuredContent).not.toHaveProperty('seats');
    const all = await callTool(tool('get_seat_map'), ctxFor(client).ctx, {
      voyage_id: VOYAGE_ID,
      include_unavailable: true,
    });
    expect((all.structuredContent as { seats: Array<{ seat: string; available: boolean }> }).seats[1]).toMatchObject({
      seat: 'A2',
      available: false,
    });
  });

  it('search_voyages hides voyages that cannot be sold unless include_unavailable', async () => {
    const { client } = fakeClient({
      'GET /api/v1/voyages/findAllRelateByLocationAndDate': {
        data: [
          { voyage: { ...VOYAGE, id: 'OPEN', no_remain: 3, depart_time: '08:00:00' } },
          { voyage: { ...VOYAGE, id: 'OFF', disable: true, no_remain: 40 } },
          { voyage: { ...VOYAGE, id: 'FULL', no_remain: 0 } },
        ],
        next_cursor: null,
      },
    });
    const args = { from: 'RG', to: 'PQ', date: '2036-10-20' };
    const out = (await callTool(tool('search_voyages'), ctxFor(client).ctx, args)).structuredContent as {
      voyages: Array<{ voyage_id: string; depart_time: string }>;
      hidden_unavailable: number;
    };
    expect(out.voyages.map((v) => v.voyage_id)).toEqual(['OPEN']);
    expect(out.voyages[0]!.depart_time).toBe('08:00');
    expect(out.hidden_unavailable).toBe(2);
    const all = (await callTool(tool('search_voyages'), ctxFor(client).ctx, { ...args, include_unavailable: true }))
      .structuredContent as { voyages: Array<{ status: string }> };
    expect(all.voyages.map((v) => v.status)).toEqual(['bookable', 'disabled', 'sold-out']);
  });

  it('quote_booking validates and prices a booking without writing anything', async () => {
    const { client, calls } = fakeClient();
    const res = await callTool(tool('quote_booking'), ctxFor(client).ctx, bookingArgs);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      depart: {
        tickets: [
          { passenger: ADULT.name, seat: 'A1', ticket_type_id: 1, price_vnd: 330000 },
          { passenger: CHILD.name, seat: 'A3', ticket_type_id: 4, price_vnd: 250000 },
        ],
      },
      estimated_total_vnd: 580000,
    });
    expect(posts(calls)).toHaveLength(0);
    const bad = await callTool(tool('quote_booking'), ctxFor(client).ctx, {
      ...bookingArgs,
      depart: { voyage_id: VOYAGE_ID, seats: ['A2', 'A3'] },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/seat A2 is booked/);
  });

  it('list_bookings returns brief rows and parses issue_ticket_error', async () => {
    const { client } = fakeClient({
      'GET /api/v1/bookings': {
        data: [
          {
            id: 'BK1',
            booking_status: 4,
            payment_status: 2,
            orderer_name: 'A',
            no_tickets: 2,
            total_price: 580000,
            depart_order: {
              voyage: VOYAGE,
              issue_ticket_error: JSON.stringify({
                errorCode: 110295,
                errorLabel: 'VoyageIsDisabledOrOutOfSeat',
                message: 'Out of seat',
              }),
              tickets: [{ name: 'secret passenger' }],
            },
          },
        ],
        next_cursor: null,
      },
    });
    const res = await callTool(tool('list_bookings'), ctxFor(client).ctx, {});
    const row = (res.structuredContent as { bookings: Array<Record<string, unknown>> }).bookings[0]!;
    expect(row).toMatchObject({
      booking_id: 'BK1',
      depart: 'Rạch Giá → Phú Quốc 2036-10-20 08:00',
      issue_ticket_error: { errorCode: 110295, errorLabel: 'VoyageIsDisabledOrOutOfSeat', message: 'Out of seat' },
    });
    expect(text(res)).not.toContain('secret passenger');
  });

  it('returns isError with helpful text for unknown locations and API errors', async () => {
    const { client } = fakeClient();
    const unknown = await callTool(tool('search_voyages'), ctxFor(client).ctx, {
      from: 'nowhere',
      to: 'PQ',
      date: '2026-10-20',
    });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('search_locations');
    const denied = new FerryClient({
      apiKey: 'k',
      retry: { maxRetries: 0 },
      fetch: (async () =>
        new Response('{"statusCode":403,"message":"Access denied"}', { status: 403 })) as typeof fetch,
    });
    const res = await callTool(tool('get_booking'), ctxFor(denied).ctx, { booking_id: 'X' });
    expect(text(res)).toMatch(/HTTP 403[\s\S]*another organization/);
  });
});

describe('MCP protocol (in-memory)', () => {
  async function connect(enableWrites: boolean, capabilities: Record<string, unknown> = {}) {
    const fake = fakeClient();
    const server = createFerryMcpServer({ client: fake.client, enableWrites, writes: createWriteGuard(5, () => {}) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, calls: fake.calls };
  }

  it('lists read tools, prompts and the locations resource; rejects calls to unregistered write tools', async () => {
    const { client } = await connect(false);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(READ_NAMES);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['plan_ferry_trip', 'check_booking']);
    const res = await client.readResource({ uri: 'ferry://locations' });
    expect(JSON.parse(String((res.contents[0] as { text: string }).text))[0].name).toBe('Phú Quốc');
    const write = await client.callTool({ name: 'create_booking', arguments: {} }).catch(() => ({ isError: true }));
    expect((write as { isError?: boolean }).isError).toBe(true);
  });

  it('rejects unknown top-level arguments instead of silently dropping them', async () => {
    const { client, calls } = await connect(false);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'get_seat_map')?.inputSchema).toMatchObject({ additionalProperties: false });
    const res = (await client.callTool({
      name: 'get_seat_map',
      arguments: { voyage_id: VOYAGE_ID, voyageId: VOYAGE_ID },
    })) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/voyageId/);
    expect(calls).toHaveLength(0);
  });

  it('confirms writes through a real elicitation round-trip', async () => {
    const { client, calls } = await connect(true, { elicitation: {} });
    const asked: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params.message);
      return { action: 'accept', content: { confirm: true } };
    });
    const res = (await client.callTool({
      name: 'create_customer',
      arguments: { first_name: 'An', phone: '0901234567' },
    })) as {
      isError?: boolean;
      structuredContent?: unknown;
    };
    expect(res.isError).toBeFalsy();
    expect(asked[0]).toContain('An');
    expect(posts(calls)[0]!.body).toEqual({ first_name: 'An', phone: '0901234567', phone_country_code: 'VN' });
  });
});

describe('Streamable HTTP security', () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it('refuses unsafe configurations', () => {
    expect(() => resolveHttpSecurity({ host: '0.0.0.0', port: 3333 })).toThrow(/without FERRY_MCP_HTTP_TOKEN/);
    expect(() => resolveHttpSecurity({ host: '127.0.0.1', port: 3333, token: 'short' })).toThrow(/at least 16/);
    expect(() => resolveHttpSecurity({ host: '127.0.0.1', port: 0 })).toThrow(/port/);
    expect(resolveHttpSecurity({ host: '0.0.0.0', port: 80, token: 'x'.repeat(16) }).allowedHosts).toBeUndefined();
    // A loopback bind reachable through a proxy or from a web page needs the token too.
    expect(() => resolveHttpSecurity({ host: '127.0.0.1', port: 3333, allowedHosts: ['mcp.example.com'] })).toThrow(
      /required when non-loopback hosts or origins are allowed \(mcp\.example\.com\)/,
    );
    expect(() =>
      resolveHttpSecurity({ host: '127.0.0.1', port: 3333, allowedOrigins: ['https://app.example.com'] }),
    ).toThrow(/app\.example\.com/);
    expect(
      resolveHttpSecurity({
        host: '127.0.0.1',
        port: 3333,
        allowedHosts: ['localhost:4000', '[::1]:4000'],
        allowedOrigins: ['http://localhost:6274'],
      }).token,
    ).toBeUndefined();
  });

  async function start() {
    const fake = fakeClient();
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const server = createFerryHttpServer({
      host: '127.0.0.1',
      port,
      maxBodyBytes: 2_000,
      createMcpServer: () => createFerryMcpServer({ client: fake.client, enableWrites: false }),
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    servers.push(server);
    return port;
  }

  const request = (
    port: number,
    headers: Record<string, string>,
    body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
    method = 'POST',
  ) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method,
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(method === 'POST' ? body : undefined);
    });

  it('serves loopback clients without a token and rejects rebinding, foreign origins, GET and oversized bodies', async () => {
    const port = await start();
    expect(await request(port, {})).toBe(200);
    expect(await request(port, { origin: `http://localhost:${port}` })).toBe(200);
    expect(await request(port, { host: `evil.example:${port}` })).toBe(403);
    expect(await request(port, { origin: 'https://evil.example' })).toBe(403);
    expect(await request(port, {}, '', 'GET')).toBe(405);
    expect(await request(port, {}, JSON.stringify({ pad: 'x'.repeat(5_000) }))).toBe(413);
    expect(await request(port, {}, '{not json')).toBe(400);
  });
});

describe('get_route_prices', () => {
  it('returns per-voyage selling prices with harbor fee and rules, without vehicle places', async () => {
    const voyage = {
      ...VOYAGE,
      depart_time: '08:00:00',
      route: { ...VOYAGE.route, operators: [{ operator_id: 'OP1', harbor_fee: 10000 }] },
      ticket_prices: {
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
            id: 9,
            ticket_type_id: 1,
            ticket_type_label: 'Người lớn',
            seat_type: 'OTO4-5',
            price_with_VAT: 1000000,
            is_default: false,
          },
        ],
        ticket_type_configs: [{ ticket_type_id: 1, key_config: 'MIN_AGE', value_config: '12' }],
      },
    };
    const { client } = fakeClient({
      'GET /api/v1/voyages/findAllRelateByLocationAndDate': { data: [{ voyage }], next_cursor: null },
    });
    const res = await callTool(tool('get_route_prices'), ctxFor(client).ctx, {
      from: 'RG',
      to: 'PQ',
      date: '2036-10-20',
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      from: 'Rạch Giá',
      to: 'Phú Quốc',
      voyages: [
        {
          voyage_id: VOYAGE_ID,
          departure: '2036-10-20 08:00',
          harbor_fee_per_ticket_vnd: 10000,
          source: 'synced (indicative)',
          from_vnd: 340000,
          ticket_types: [{ id: 1, name: 'Người lớn', rules: 'MIN_AGE 12' }],
          prices: [{ seat_type: 'ECO', ticket_type_id: 1, price_vnd: 330000 }],
        },
      ],
    });
  });

  it('limits date ranges to a week', async () => {
    const { client, calls } = fakeClient();
    const ctx = ctxFor(client).ctx;
    const week = await callTool(tool('get_route_prices'), ctx, {
      from: 'RG',
      to: 'PQ',
      date: '2036-10-20',
      until: '2036-10-27',
    });
    expect(text(week)).toMatch(/at most 7 days/);
    const back = await callTool(tool('get_route_prices'), ctx, {
      from: 'RG',
      to: 'PQ',
      date: '2036-10-20',
      until: '2036-10-19',
    });
    expect(text(back)).toMatch(/must not be before/);
    expect(calls).toHaveLength(0);
  });
});
