import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FerryClient } from '@ferryvn/sdk';
import { vi } from 'vitest';
import type { CliDeps } from '../src/cli-context.js';
import { ConfigStore } from '../src/config-store.js';
import { run } from '../src/program.js';

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Route = (call: Call) => unknown;

/** Run the CLI in-process with a fake API. `routes` maps "METHOD /path" to a JSON body (or [status, body]). */
export async function runCli(
  args: string[],
  routes: Record<string, Route | unknown> = {},
  extra: Partial<CliDeps> & { env?: NodeJS.ProcessEnv; files?: Record<string, string> } = {},
) {
  const dir = extra.store?.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ferry-cli-test-'));
  let stdout = '';
  let stderr = '';
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${url.pathname}`;
    if (!(key in routes))
      return new Response(JSON.stringify({ statusCode: 404, message: `no mock for ${key}` }), { status: 404 });
    const r = routes[key];
    const out = typeof r === 'function' ? (r as Route)(call) : r;
    if (out instanceof Response) return out;
    const [status, body] = Array.isArray(out) && typeof out[0] === 'number' && out.length === 2 ? out : [200, out];
    return new Response(JSON.stringify(body), {
      status: status as number,
      headers: { 'content-type': 'application/json' },
    });
  });
  const written: Record<string, string> = {};
  const deps: CliDeps = {
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    env: extra.env ?? {},
    store: extra.store ?? new ConfigStore(dir),
    createClient: (opts) =>
      new FerryClient({ ...opts, fetch: fetchImpl as unknown as typeof fetch, retry: { maxRetries: 0 } }),
    readFile: (p) => {
      const f = extra.files?.[p];
      if (f === undefined) {
        // Same shape as fs: the CLI maps `code: 'ENOENT'` to a usage error.
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
      }
      return f;
    },
    writeFile: (p, data) => {
      written[p] = data;
    },
    readStdin: extra.readStdin ?? (async () => ''),
    readSecret: extra.readSecret ?? (async () => ''),
    prompt: extra.prompt ?? (async () => ''),
    stdinIsTTY: extra.stdinIsTTY ?? false,
  };
  const code = await run(args, deps);
  return { code, stdout, stderr, calls, store: deps.store, written };
}

export { LOCATIONS } from '../../sdk/test/fixtures.js';
