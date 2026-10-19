#!/usr/bin/env node
/**
 * Smoke test for the built SDK on the current Node version (CI also runs it on
 * the oldest supported Node, where the dev toolchain itself cannot run).
 * Loads both the ESM and the CJS bundle and performs a mocked request — no network.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const esm = await import('../packages/sdk/dist/index.js');
const cjs = createRequire(import.meta.url)('../packages/sdk/dist/index.cjs');

for (const [label, sdk] of [
  ['esm', esm],
  ['cjs', cjs],
]) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify([{ id: 'a'.repeat(24), location_name: 'Phú Quốc', abbreviation: 'PQ' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const ferry = new sdk.FerryClient({ apiKey: 'smoke_key_123', fetch });
  const [loc] = await ferry.locations.find('phu quoc');
  assert.equal(loc.abbreviation, 'PQ', `${label}: locations.find`);
  assert.equal(calls[0].url, 'https://api.ferry.vn/api/v1/locations', `${label}: url`);
  assert.equal(calls[0].init.headers.authorization, 'Bearer smoke_key_123', `${label}: auth header`);
  assert.match(calls[0].init.headers['x-request-id'], /^[0-9a-f-]{36}$/, `${label}: request id`);
  assert.equal(sdk.toYmd(new Date('2026-10-19T17:30:00Z')), '2026-10-20', `${label}: Vietnam date`);
  assert.ok(new sdk.FerryApiError({ status: 500, message: 'x', method: 'GET', url: 'u' }) instanceof sdk.FerryError);
  console.log(`smoke-sdk: ${label} OK (sdk ${sdk.SDK_VERSION}, node ${process.version})`);
}
