#!/usr/bin/env node
/**
 * Smoke test for the built MCP server. No Ferry API calls are made.
 *
 *   node scripts/smoke-mcp.mjs            stdio: initialize + tools/list (read-only tool set)
 *   node scripts/smoke-mcp.mjs --writes   stdio, with FERRY_MCP_ENABLE_WRITES=true
 *   node scripts/smoke-mcp.mjs --http     Streamable HTTP (writes requested but not opted in for HTTP,
 *                                         so they must stay hidden): tools/list works for a loopback
 *                                         Host, and DNS-rebinding style requests (foreign
 *                                         Host / Origin) and missing tokens are rejected
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../packages/mcp/dist/index.js', import.meta.url));
const mode = process.argv.includes('--http') ? 'http' : process.argv.includes('--writes') ? 'writes' : 'read';
let child;

function fail(reason) {
  console.error(`smoke-mcp[${mode}]: FAIL — ${reason}`);
  child?.kill();
  process.exit(1);
}
const timer = setTimeout(() => fail('timed out'), 20_000);

const INIT = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'smoke-mcp', version: '0.0.0' },
};

function checkTools(tools, expectWrites) {
  const names = tools.map((t) => t.name);
  for (const t of tools) console.log(`  - ${t.name}${t.annotations?.readOnlyHint ? '' : '  [WRITE]'}`);
  const hasWrites = names.includes('create_booking');
  if (hasWrites !== expectWrites) fail(`write tools ${hasWrites ? 'present' : 'missing'}`);
  if (names.length < 10) fail(`expected at least 10 tools, got ${names.length}`);
  return names.length;
}

async function stdio() {
  child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      FERRY_API_KEY: 'smoke-test-dummy',
      FERRY_MCP_ENABLE_WRITES: mode === 'writes' ? 'true' : '',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  const rpc = (id, method, params) =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const init = await rpc(1, 'initialize', INIT);
  if (!init.result?.serverInfo) fail(`bad initialize response: ${JSON.stringify(init)}`);
  const { name, version } = init.result.serverInfo;
  console.log(`initialize: ${name}@${version} (protocol ${init.result.protocolVersion})`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const list = await rpc(2, 'tools/list', {});
  const n = checkTools(list.result?.tools ?? [], mode === 'writes');
  const prompts = await rpc(3, 'prompts/list', {});
  if (!prompts.result?.prompts?.length) fail('no prompts registered');
  console.log(`smoke-mcp[${mode}]: OK (${n} tools, ${prompts.result.prompts.length} prompts)`);
}

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function http() {
  const port = await freePort();
  const token = 'smoke-token-0123456789abcdef';
  child = spawn(process.execPath, [entry, '--http', '--port', String(port)], {
    env: {
      ...process.env,
      FERRY_API_KEY: 'smoke-test-dummy',
      FERRY_MCP_HTTP_TOKEN: token,
      FERRY_MCP_ENABLE_WRITES: 'true',
      FERRY_MCP_HTTP_ALLOW_WRITES: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await new Promise((resolve) => {
    child.stderr.on('data', (d) => {
      if (String(d).includes('listening')) resolve();
    });
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  const post = (headers, body) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body ?? { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

  const ok = await post({});
  if (ok.status !== 200) fail(`loopback request: HTTP ${ok.status}`);
  const text = await ok.text();
  const json = JSON.parse(
    text.startsWith('{')
      ? text
      : text
          .split('\n')
          .find((l) => l.startsWith('data:'))
          .slice(5),
  );
  checkTools(json.result.tools, false);

  // `fetch` forbids overriding Host, so use node:http for the rebinding probe.
  const { request } = await import('node:http');
  const probe = (headers) =>
    new Promise((resolve) => {
      const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) =>
        resolve(res.statusCode),
      );
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    });
  const auth = { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' };
  const checks = [
    ['foreign Host (DNS rebinding)', await probe({ ...auth, host: `attacker.example:${port}` }), 403],
    ['foreign Origin', await probe({ ...auth, origin: 'http://attacker.example' }), 403],
    ['missing token', await probe({ accept: auth.accept }), 401],
    ['wrong token', await probe({ ...auth, authorization: 'Bearer nope-nope-nope-nope' }), 401],
  ];
  for (const [label, got, want] of checks) {
    if (got !== want) fail(`${label}: expected HTTP ${want}, got ${got}`);
    console.log(`  rejected ${label} → ${got}`);
  }
  console.log('smoke-mcp[http]: OK');
}

await (mode === 'http' ? http() : stdio());
clearTimeout(timer);
child.kill();
