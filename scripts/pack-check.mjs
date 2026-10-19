#!/usr/bin/env node
/**
 * Pre-publish checks on the built packages:
 *   1. publint (package.json / exports correctness) for every package
 *   2. are-the-types-wrong for the SDK (ESM + CJS type resolution)
 *   3. `npm pack` all three, install the tarballs into a throw-away project
 *      and exercise them the way a user would (import, require, run the bins).
 * Requires a prior `npm run build`. Needs registry access for third-party deps.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = ['sdk', 'cli', 'mcp'];
const bin = (name) => path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const run = (cmd, args, opts = {}) => {
  console.log(`$ ${path.basename(cmd)} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', shell: process.platform === 'win32', ...opts });
};

for (const p of PKGS) {
  const dir = path.join(ROOT, 'packages', p);
  process.stdout.write(run(bin('publint'), ['--strict'], { cwd: dir }));
  for (const f of ['LICENSE', 'NOTICE', 'README.md']) {
    if (!fs.existsSync(path.join(dir, f))) throw new Error(`packages/${p}/${f} is missing`);
  }
}
process.stdout.write(
  run(bin('attw'), ['--pack', '.', '--profile', 'node16'], { cwd: path.join(ROOT, 'packages', 'sdk') }),
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ferry-pack-'));
try {
  const tarballs = PKGS.map((p) => {
    const out = run('npm', ['pack', '--json', '--pack-destination', tmp], { cwd: path.join(ROOT, 'packages', p) });
    const [info] = JSON.parse(out);
    const files = info.files.map((f) => f.path);
    for (const required of ['LICENSE', 'NOTICE', 'README.md', 'package.json']) {
      if (!files.includes(required)) throw new Error(`${info.name}: ${required} missing from tarball`);
    }
    if (files.some((f) => f.startsWith('src/') || f.startsWith('test/'))) {
      throw new Error(`${info.name}: tarball contains sources/tests`);
    }
    console.log(`${info.name}@${info.version}: ${files.length} files, ${(info.size / 1024).toFixed(1)} kB packed`);
    return path.join(tmp, info.filename);
  });

  const app = path.join(tmp, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(
    path.join(app, 'package.json'),
    JSON.stringify({ name: 'pack-check', private: true, type: 'module' }),
  );
  run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], { cwd: app });

  fs.writeFileSync(
    path.join(app, 'esm.mjs'),
    "import { FerryClient, SDK_VERSION } from '@ferryvn/sdk'; new FerryClient({ fetch: async () => new Response('[]') }); console.log('esm', SDK_VERSION);",
  );
  fs.writeFileSync(
    path.join(app, 'cjs.cjs'),
    "const { FerryClient, SDK_VERSION } = require('@ferryvn/sdk'); new FerryClient({ fetch: async () => new Response('[]') }); console.log('cjs', SDK_VERSION);",
  );
  fs.writeFileSync(
    path.join(app, 'mcp.mjs'),
    "import { createFerryMcpServer, selectTools } from '@ferryvn/mcp'; import { FerryClient } from '@ferryvn/sdk'; createFerryMcpServer({ client: new FerryClient({ fetch: async () => new Response('[]') }), enableWrites: false }); console.log('mcp tools', selectTools(false).length);",
  );
  process.stdout.write(run(process.execPath, ['esm.mjs'], { cwd: app }));
  process.stdout.write(run(process.execPath, ['cjs.cjs'], { cwd: app }));
  process.stdout.write(run(process.execPath, ['mcp.mjs'], { cwd: app }));
  const binDir = path.join(app, 'node_modules', '.bin');
  const ext = process.platform === 'win32' ? '.cmd' : '';
  process.stdout.write(run(path.join(binDir, `ferry${ext}`), ['--version'], { cwd: app }));
  process.stdout.write(run(path.join(binDir, `ferry-mcp${ext}`), ['--help'], { cwd: app }));
  console.log('pack:check OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
