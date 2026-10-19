#!/usr/bin/env node
/**
 * Lockstep versioning for the three published packages.
 *
 *   node scripts/version.mjs set 1.2.3        write the version everywhere
 *   node scripts/version.mjs check [--tag v1.2.3]
 *                                             fail if any location disagrees
 *                                             (or differs from the git tag)
 *
 * Locations: root + package manifests, the internal `@ferryvn/sdk` dependency
 * of cli/mcp, the `version.ts` constants (kept as source so the SDK bundle
 * stays platform-neutral), the MCP registry `server.json` and the MCPB
 * `manifest.json`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const manifests = [
  'package.json',
  'packages/sdk/package.json',
  'packages/cli/package.json',
  'packages/mcp/package.json',
];
const versionFiles = ['packages/sdk/src/version.ts', 'packages/cli/src/version.ts', 'packages/mcp/src/version.ts'];
const jsonVersionFiles = ['packages/mcp/server.json', 'packages/mcp/mcpb/manifest.json'];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const write = (rel, text) => fs.writeFileSync(path.join(ROOT, rel), text);
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

function collect() {
  const found = [];
  for (const rel of manifests) {
    const pkg = JSON.parse(read(rel));
    found.push([rel, pkg.version]);
    const dep = pkg.dependencies?.['@ferryvn/sdk'];
    if (dep) found.push([`${rel} → dependencies["@ferryvn/sdk"]`, dep]);
  }
  for (const rel of versionFiles) {
    const m = /VERSION = '([^']+)'/.exec(read(rel));
    found.push([rel, m?.[1]]);
  }
  for (const rel of jsonVersionFiles.filter(exists)) {
    const doc = JSON.parse(read(rel));
    found.push([rel, doc.version]);
    for (const [i, p] of (doc.packages ?? []).entries()) found.push([`${rel} → packages[${i}].version`, p.version]);
  }
  return found;
}

function set(version) {
  if (!SEMVER.test(version)) throw new Error(`not a semver version: ${version}`);
  for (const rel of manifests) {
    const pkg = JSON.parse(read(rel));
    pkg.version = version;
    if (pkg.dependencies?.['@ferryvn/sdk']) pkg.dependencies['@ferryvn/sdk'] = version;
    write(rel, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  for (const rel of versionFiles) write(rel, read(rel).replace(/VERSION = '[^']+'/, `VERSION = '${version}'`));
  for (const rel of jsonVersionFiles.filter(exists)) {
    const doc = JSON.parse(read(rel));
    doc.version = version;
    for (const p of doc.packages ?? []) p.version = version;
    write(rel, `${JSON.stringify(doc, null, 2)}\n`);
  }
  console.log(`version set to ${version} — run \`npm install\` to refresh package-lock.json`);
}

function check(tag) {
  const found = collect();
  const expected = tag ? tag.replace(/^v/, '') : found[0][1];
  const bad = found.filter(([, v]) => v !== expected);
  for (const [where, v] of found) console.log(`${v === expected ? 'ok ' : 'BAD'} ${v ?? '(missing)'}  ${where}`);
  if (bad.length) {
    console.error(`version:check failed — expected ${expected} everywhere`);
    process.exit(1);
  }
  console.log(`version:check OK (${expected})`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'set' && arg) set(arg);
else if (cmd === 'check') {
  const i = process.argv.indexOf('--tag');
  check(i > 0 ? process.argv[i + 1] : undefined);
} else {
  console.error('usage: version.mjs set <x.y.z> | check [--tag vX.Y.Z]');
  process.exit(2);
}
