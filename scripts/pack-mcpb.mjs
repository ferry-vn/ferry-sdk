#!/usr/bin/env node
/**
 * Build `packages/mcp/ferry-mcp.mcpb` — a one-click Claude Desktop bundle.
 * Bundles the built server and all its dependencies into a single CommonJS
 * file (no node_modules needed), then validates and packs with the official
 * `@anthropic-ai/mcpb` CLI. Requires a prior `npm run build`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { thirdPartyNotices } from './third-party-notices.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'packages', 'mcp');
const out = path.join(MCP, 'ferry-mcp.mcpb');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ferry-mcpb-'));

try {
  const { metafile } = await build({
    entryPoints: [path.join(MCP, 'dist', 'index.js')],
    outfile: path.join(stage, 'server', 'index.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    legalComments: 'linked',
    metafile: true,
    logLevel: 'warning',
  });
  for (const f of ['LICENSE', 'NOTICE', 'README.md']) fs.copyFileSync(path.join(MCP, f), path.join(stage, f));
  fs.writeFileSync(path.join(stage, 'THIRD_PARTY_NOTICES.txt'), thirdPartyNotices(metafile, ROOT));
  fs.copyFileSync(path.join(MCP, 'mcpb', 'manifest.json'), path.join(stage, 'manifest.json'));

  // The bundle must start and answer --version on its own.
  const version = execFileSync(process.execPath, [path.join(stage, 'server', 'index.cjs'), '--version'], {
    encoding: 'utf8',
  }).trim();
  const expected = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8')).version;
  if (version !== expected) throw new Error(`bundle reports ${version}, manifest says ${expected}`);

  // Exact version: npm versions are immutable, so the packer cannot change under us.
  const mcpb = ['-y', '@anthropic-ai/mcpb@2.1.2'];
  execFileSync('npx', [...mcpb, 'validate', path.join(stage, 'manifest.json')], { stdio: 'inherit' });
  fs.rmSync(out, { force: true });
  execFileSync('npx', [...mcpb, 'pack', stage, out], { stdio: 'inherit' });
  console.log(`mcpb: wrote ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} kB)`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
