#!/usr/bin/env node
/**
 * Write the license texts of every npm package inside an esbuild bundle.
 * Bundling drops the LICENSE files that ship in node_modules, and the MIT /
 * ISC / BSD licenses of the MCP server's dependencies require their notice to
 * travel with every copy — so the .mcpb bundle and the Docker image carry a
 * THIRD_PARTY_NOTICES.txt built from the bundle's metafile.
 *
 *   node scripts/third-party-notices.mjs <metafile.json> <out.txt>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

/** Package root directories (absolute) of the node_modules inputs of an esbuild metafile. */
function packageRoots(metafile, cwd) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const abs = path.resolve(cwd, input);
    const parts = abs.split(path.sep);
    const i = parts.lastIndexOf('node_modules');
    if (i < 0) continue; // our own workspace code
    const depth = parts[i + 1]?.startsWith('@') ? 3 : 2;
    roots.add(parts.slice(0, i + depth).join(path.sep));
  }
  return [...roots];
}

/** Notices text for the packages bundled according to `metafile` (paths relative to `cwd`). */
export function thirdPartyNotices(metafile, cwd = process.cwd()) {
  const packages = packageRoots(metafile, cwd)
    .map((dir) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const files = fs
        .readdirSync(dir)
        .filter((f) => LICENSE_FILE.test(f))
        .sort();
      return { name: pkg.name, version: pkg.version, license: pkg.license ?? 'UNKNOWN', dir, files };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const missing = packages.filter((p) => p.files.length === 0);
  if (missing.length) {
    throw new Error(`no license file in: ${missing.map((p) => `${p.name}@${p.version}`).join(', ')}`);
  }
  const header = `Third-party software bundled in this distribution (${packages.length} packages).\n`;
  const sections = packages.map((p) => {
    const texts = p.files.map((f) => fs.readFileSync(path.join(p.dir, f), 'utf8').trim()).join('\n\n');
    return `${'='.repeat(78)}\n${p.name}@${p.version} (${p.license})\n${'='.repeat(78)}\n\n${texts}\n`;
  });
  return [header, ...sections].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [metaPath, outPath] = process.argv.slice(2);
  if (!metaPath || !outPath) {
    console.error('usage: third-party-notices.mjs <metafile.json> <out.txt>');
    process.exit(2);
  }
  const text = thirdPartyNotices(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
  fs.writeFileSync(outPath, text);
  console.log(`notices: wrote ${outPath}`);
}
