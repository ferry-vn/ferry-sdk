# Contributing

```bash
npm ci
npm run verify     # what CI runs: versions, lint, typecheck, tests + coverage, build, smoke, package checks
```

- Node ≥ 22.12 for development; the SDK runtime supports Node ≥ 20 (CI smoke-tests it on Node 20). Tests use a mocked `fetch` — no network or API key needed.
- Code style is enforced by Biome (`npm run lint:fix`). Keep the SDK free of runtime dependencies.
- Changes to the API surface start in `openapi/partner.json` (re-extracted from
  the backend with `npm run openapi:extract`) and `scripts/filter-openapi.ts`;
  run `npm run generate` and commit the regenerated `openapi/sdk.json` and
  `packages/sdk/src/generated/`. Response corrections must be verified in the
  backend source and marked with `x-ferry-sdk-patch`.
- Anything that moves money (ticket issuance, payments, balances) must stay out
  of the MCP server; `packages/mcp/test` enforces this.
- Add a CHANGELOG entry under `[Unreleased]`. Releases are cut by maintainers
  (see [Releasing](#releasing)).
- By contributing you agree that your contributions are licensed under Apache-2.0.

## Scripts

| Script | |
|---|---|
| `npm test`, `npm run test:coverage` | Vitest with mocked fetch, no network |
| `npm run lint` / `lint:fix` | Biome |
| `npm run smoke:sdk` / `smoke:cli` / `smoke:mcp` | Built SDK (ESM + CJS); CLI help; MCP over stdio, with writes, and over HTTP (including DNS-rebinding rejection) |
| `npm run pack:check` | publint, are-the-types-wrong, `npm pack` + install + run |
| `npm run mcpb:pack` | Claude Desktop bundle `packages/mcp/ferry-mcp.mcpb` |
| `FERRY_UAT_API_KEY=… npm run test:contract` | live read-only checks against UAT |

Regenerating the types:

```bash
npm run openapi:extract -- --backend <path-to-backend>   # a backend checkout with node_modules; boots NestJS in preview mode, no database
npm run generate                                         # filter + generate types
```

## Releasing

All three packages share one version.

```bash
npm run version:set -- 1.0.1 && npm install   # bumps manifests, version constants, server.json, MCPB manifest
# update CHANGELOG.md, commit, merge to main, then:
git tag v1.0.1 && git push origin v1.0.1
```

Pushing the tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml). It:
1. runs the full CI;
2. checks that the tag matches every package version;
3. **only when the repository variable `NPM_PUBLISH` is `true`**, publishes `@ferryvn/sdk` → `@ferryvn/cli` → `@ferryvn/mcp` to npm (`latest`; `next` for versions with a `-`, e.g. `1.1.0-rc.1`), with provenance when the repository is public — versions already on npm are skipped, so a failed run can be re-run;
4. creates the GitHub release (a pre-release for `-` versions) with the `.mcpb` bundle attached. While the packages are not on npm, its notes say so.

Running the workflow by hand on a branch is a dry run (build, `.mcpb`, `npm pack --dry-run`). To release without pushing a tag yourself, run it by hand on `main` with `release_tag` set (e.g. `v1.0.1`): it creates the tag on that commit together with the GitHub release. npm publishing only ever runs from a tag.

**GitHub first, npm later:** push the tag with `NPM_PUBLISH` unset to get only the GitHub release. When npm is ready, set `NPM_PUBLISH=true` (Settings → Secrets and variables → Actions → Variables) and run the Release workflow by hand on the tag (Actions → Release → Run workflow → `Use workflow from: Tags: vX.Y.Z`); it publishes to npm and refreshes the release notes.

One-time npm setup:
1. Create the `ferryvn` organization on npmjs.com (owns the `@ferryvn` scope).
2. In GitHub → Settings → Environments, create the `npm` environment (optionally with required reviewers, so every publish waits for an approval).
3. First release: create an npm **granular access token** with read and write access to the `@ferryvn` packages and store it as the `NPM_TOKEN` secret of that environment.
4. Once the packages exist: on npmjs.com, add a trusted publisher for each package (GitHub Actions, repository `ferry-vn/ferry-sdk`, workflow `release.yml`, environment `npm`), then delete the token.
