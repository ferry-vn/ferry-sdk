# Project Roadmap

Current status, release history and evidenced open items for the Ferry VN SDK monorepo (`@ferryvn/sdk`, `@ferryvn/cli`, `@ferryvn/mcp`). Only facts found in the repository are stated as facts. Anything forward-looking is labelled **[PROPOSED]** and is not a commitment; the repo defines no roadmap, target dates or future feature list beyond what is listed below.

## 1. Current status

| Item | Status | Evidence |
|---|---|---|
| Version | 1.0.0 for all three packages (lockstep) | `package.json` files, `src/version.ts`, [CHANGELOG.md](../CHANGELOG.md) |
| Release date | 2026-10-19 (first public release) | [CHANGELOG.md](../CHANGELOG.md) `## [1.0.0]` |
| GitHub | v1.0.0 is on GitHub Releases; the `ferry-mcp.mcpb` bundle is attached to releases | [README.md](../README.md) "Status", `release.yml` |
| npm | **Not published yet.** Users take the `.mcpb` from the release or build from source (`npm ci && npm run build`) | [README.md](../README.md) "Status" |
| npm publish gate | Publishing runs only from a tag and only when the repository variable `NPM_PUBLISH` is `true`; one-time npm setup (org `ferryvn`, environment `npm`, `NPM_TOKEN`, later trusted publishers) is described but its completion is not recorded in the repo | [CONTRIBUTING.md](../CONTRIBUTING.md) "Releasing", `.github/workflows/release.yml` |
| Unreleased changes | Copyright holder set to Ferry VN JSC; README rewritten for integrators; dev scripts and release process moved to CONTRIBUTING.md | [CHANGELOG.md](../CHANGELOG.md) `## [Unreleased]` |
| Supported versions | 1.x supported, 0.x not | [SECURITY.md](../SECURITY.md) |
| API baseline | Backend v3.2.16 (`info.version` of the OpenAPI files) | `openapi/*.json`, CHANGELOG |
| Docs | Maintainer docs live in `docs/` (this set) | [README.md](../README.md) "Contributing, security, support" |

## 2. Version history

Summarised from [CHANGELOG.md](../CHANGELOG.md) (Keep a Changelog, SemVer; the three packages are versioned together).

| Version | Date | Summary |
|---|---|---|
| Unreleased | — | Copyright holder → Ferry VN JSC (`NOTICE`, `author`, Claude Desktop bundle author); README rewritten for integrators; dev/release docs moved to `CONTRIBUTING.md` |
| 1.0.0 | 2026-10-19 | First public release under Apache-2.0; every endpoint and response shape re-verified against backend v3.2.16 |
| 0.1.0 | 2026-10-06 | Initial extraction of `openapi/partner.json` and `openapi/public.json` from backend v3.2.16; first versions of SDK, CLI, MCP; CI |

### 2.1 1.0.0 in detail

| Area | Highlights |
|---|---|
| Security | MCP Streamable HTTP: DNS-rebinding protection (Host/Origin validation, optional `FERRY_MCP_HTTP_TOKEN`, mandatory for non-loopback, POST only, 1 MB body, timeouts, `/healthz`); SDK refuses API keys in browsers without `dangerouslyAllowBrowser`; `Authorization` redacted in hooks and debug logs; `FerryApiError.toJSON()` omits bodies; CLI CSV formula-injection guard |
| SDK | New resources (`customers`, `organization`, `transactions`, `debtLedger`, `bookings.getPublic`, `bookings.listChildOrgBookings`); booking builder (`bookingDrafts`, `buildLegTickets`); `prices.forRoute`; `iterate()`/`collect()`; hooks and `debug`; `x-request-id`; locations cache; expanded error hierarchy, `FerryErrorCode`, `userMessage`; webhook helpers; date and money helpers; per-request options |
| CLI | Profiles; `--output table\|json\|ndjson\|csv`; many new commands (`booking draft`, `orders`, `customers`, `account`, `transactions`, `debts`, `vouchers`, `disruptions`, `calendar`, `operators`, `api`, `doctor`, `completion`, `prices`); `whoami --check`; interactive confirmation for `booking issue` and `cancel request`; exit codes 3/4/5; `--date today\|tomorrow`; `--debug` |
| MCP | New read tools (`get_voyage_calendar`, `find_customers`, `get_disruptions`, `get_account`, `list_vouchers`, `quote_booking`, `get_route_prices`); write tools `create_customer`, redesigned `create_booking`; elicitation-based confirmation; write budget (`FERRY_MCP_MAX_WRITES`) and audit log (`FERRY_MCP_AUDIT_FILE`); prompts and `ferry://locations`; `.mcpb` bundle, Dockerfile, `server.json` |
| Repository | Biome, coverage thresholds, publint, are-the-types-wrong, pack-and-install test; CI matrix (Node 22 and 24, Node 20 SDK smoke, Windows, macOS); tag-triggered release workflow; Dependabot; nightly read-only contract tests; lockstep versioning; `openapi/sdk.json` (generated types 412 KB → 224 KB) |
| Verification | Read-only UAT run (2026-10-07, six operators), read-only production run (2026-10-07; 478 voyages on 51 routes; one live seat map per operator; two real `Requested` bookings created, no payment or issuance), pre-release audit (2026-10-18) |
| Dependencies | zod 4, commander 15, vitest 5 |

### 2.2 Breaking changes in 1.0.0 (relative to 0.x)

| Change | Migration note (from CHANGELOG) |
|---|---|
| `toYmd(Date)` and all date parameters use the Vietnam calendar day (were UTC) | Check callers that relied on UTC days |
| `bookings.confirmToIssue()` resolves `void`; default timeout at least 10 minutes | Read the result with `bookings.get(id)` |
| `bookings.downloadTickets()` renamed `refreshTicketFiles()`, resolves `void` | — |
| `vouchers.checkApplicability()` returns `{ isApplicable, voucher }` | — |
| List `sort` strings replaced by `order: 'asc' \| 'desc'`; `locations.list({ sort })` removed | Backend sorts only by `_id` |
| 403 → `FerryPermissionError` (not `FerryAuthError`); 5xx → `FerryServerError`; caller aborts → `FerryAbortError` | 403 also covers foreign or nonexistent ids |
| MCP `create_booking` input redesigned (`passengers` + `depart`/`return` legs with seat names); MCP `search_locations` returns `{ locations: [...] }` | — |
| CLI config moves to profiles | The 0.x file is read as the `default` profile |
| CLI `login` verifies the key with `organizations/me` | — |
| Node: CLI and MCP require ≥ 22.12; SDK ≥ 20 | — |

## 3. Milestones

| # | Milestone | Status | Evidence |
|---|---|---|---|
| M1 | Extract OpenAPI from backend v3.2.16; initial three packages and CI (0.1.0) | Done, 2026-10-06 | CHANGELOG 0.1.0 |
| M2 | Read-only verification on UAT (six operators) | Done, 2026-10-07 | CHANGELOG "Verified on UAT" |
| M3 | Read-only verification on production, plus two real `Requested` bookings | Done, 2026-10-07 | CHANGELOG "Verified on production" |
| M4 | Pre-release line-by-line audit of the three packages | Done, 2026-10-18 | CHANGELOG "Pre-release audit" |
| M5 | 1.0.0 tag and GitHub release (with `.mcpb`) | Done, 2026-10-19 | CHANGELOG, README "Status" |
| M6 | Repository docs consolidated (README rewrite, CONTRIBUTING, maintainer `docs/`) | In `[Unreleased]` (README and CONTRIBUTING changes); not yet in a tagged release | CHANGELOG `[Unreleased]` |
| M7 | Publish `@ferryvn/sdk`, `@ferryvn/cli`, `@ferryvn/mcp` to npm | **Pending**: packages not published; requires one-time npm setup and `NPM_PUBLISH=true`, then a manual run of the Release workflow on the tag | README "Status", CONTRIBUTING "GitHub first, npm later" |
| M8 | Switch npm auth from granular token to trusted publishers | Pending, after M7 | CONTRIBUTING "One-time npm setup" step 4 |
| M9 | Publish Docker image / list in MCP Registry | **Not defined in repo**: Dockerfile and `server.json` exist, but no workflow or script publishes them | Scout grep of `.github`, `scripts`, docs (no `docker push`, `ghcr`, `mcp-publisher`) |
| M10 | Nightly contract tests running against UAT | Workflow present; runs only when the `FERRY_UAT_API_KEY` secret is set (otherwise steps echo a skip message). Whether the secret is configured is not recorded in the repo | `.github/workflows/contract.yml` |

## 4. Known gaps and pending items (evidenced)

A grep for `TODO|FIXME|XXX|HACK` across `packages/*/src`, `scripts`, `contract`, `.github`, `CONTRIBUTING.md` and `SECURITY.md` found **no matches**. The items below come from other evidence.

| # | Item | Evidence | Impact |
|---|---|---|---|
| G1 | npm packages not published; `npx -y @ferryvn/mcp` and `npm i @ferryvn/sdk` in README quick starts do not work until M7 | README "Status" | Distribution |
| G2 | Docker image is build-it-yourself (`docker build -f packages/mcp/Dockerfile -t ferryvn-mcp .` from repo root); `server.json` is not published to the MCP Registry by any script | `packages/mcp/Dockerfile`, workflows | Distribution |
| G3 | `tsup` `target` is `node20` in `packages/cli/tsup.config.ts` and `packages/mcp/tsup.config.ts` while their `engines` and the `ferry doctor` check require Node ≥ 22.12 (the `.mcpb` bundle targets node22). Effective floor is `engines`. Whether `node20` is intentional is [INFERENCE: looks unintentional] | tsup configs vs `package.json` | Cosmetic / build target |
| G4 | Stale comment in `packages/cli/src/commands/account-commands.ts` line 3: "All read-only except `customers create/update`", but no `customers update` command is registered (SDK has `customers.update`) | grep of `customers create/update` | Docs/code consistency |
| G5 | Contract suite only covers read paths; nothing is created (write path was verified manually before 1.0.0, per CHANGELOG) | `contract/uat.contract.ts`, CHANGELOG | Test coverage of writes against live backend |
| G6 | Unit-test coverage floors are set just under the 1.0.0 baseline (about 80% lines): lines 78, statements 75, functions 65, branches 65 | root `vitest.config.ts` comment | Regression margin |
| G7 | Backend coupling: domain rules mirror backend v3.2.16; regenerating needs a separate backend checkout with `node_modules`; drift between backend and SDK is detected only by the nightly contract run (read-only) and by manual re-extraction | `scripts/extract-openapi.ts`, CONTRIBUTING | Maintenance |
| G8 | Endpoints deliberately not wrapped by the SDK: `/bookings/sync`, passengers, partner `GET /cancel-ticket-request/:id`, admin endpoints (reachable via `ferry.request()` / `ferry api`) | `booking-resources.ts` header, `scripts/filter-openapi.ts` | Design choice, not a defect |
| G9 | Webhook limits are documented but unfixable client-side: unsigned, delivered once, 2-second timeout | `webhooks.ts`, README | Integrator burden |

## 5. Automation that keeps the project honest

| Mechanism | Cadence / trigger | Behaviour |
|---|---|---|
| CI (`ci.yml`) | push to `main`/`develop`, pull requests, `workflow_call` | `verify` (Node 22 and 24), `sdk-oldest-node` (Node 20), `cross-os` (Windows, macOS on Node 24) |
| Release (`release.yml`) | tag `v*.*.*` or manual dispatch | CI → build + `.mcpb` → optional npm publish → GitHub release; manual run without a tag is a dry run |
| Contract tests (`contract.yml`) | cron `17 20 * * *` (03:17 Vietnam time) and manual | Read-only checks against UAT; skipped without `FERRY_UAT_API_KEY`; `FERRY_CONTRACT_ENV=production` targets production |
| Dependabot | Monthly | npm (groups `dev-tooling`, `runtime`; max 5 open PRs) and github-actions |
| Stale-types guard | every CI run | `generate:check` fails if `openapi/sdk.json` or generated types are out of date |

## 6. Release procedure (pointer)

Defined in [CONTRIBUTING.md](../CONTRIBUTING.md) and detailed in [deployment-guide.md](deployment-guide.md): `npm run version:set -- X.Y.Z && npm install`, update CHANGELOG, merge to `main`, push tag `vX.Y.Z`. A `-` in the version (for example `1.1.0-rc.1`) produces a GitHub pre-release and the npm `next` dist-tag. The next version number and contents are **not defined in the repo**.

## 7. Proposed next steps

All items are **[PROPOSED]**: suggestions derived from the gaps above, not planned work.

| # | Proposal | Addresses |
|---|---|---|
| P1 | **[PROPOSED]** Complete the one-time npm setup, set `NPM_PUBLISH=true`, run the Release workflow on `v1.0.0`, then update the README status banner | M7, G1 |
| P2 | **[PROPOSED]** Cut a tagged release that includes the `[Unreleased]` documentation and copyright changes (a patch version per the SemVer note in CHANGELOG) | M6 |
| P3 | **[PROPOSED]** Align `tsup` `target` with `engines` (node22) in CLI and MCP, or document why `node20` is kept | G3 |
| P4 | **[PROPOSED]** Fix the stale `customers create/update` comment, or add a `ferry customers update` command if desired | G4 |
| P5 | **[PROPOSED]** Add a workflow to build/push the MCP Docker image and publish `server.json`, if Ferry VN wants hosted distribution | M9, G2 |
| P6 | **[PROPOSED]** Confirm the `FERRY_UAT_API_KEY` secret is set so the nightly contract run is not silently skipped | M10 |
| P7 | **[PROPOSED]** Raise coverage floors toward the actual baseline as tests grow | G6 |

## References

- [CHANGELOG.md](../CHANGELOG.md), [README.md](../README.md), [CONTRIBUTING.md](../CONTRIBUTING.md), [SECURITY.md](../SECURITY.md)
- Workflows: [ci.yml](../.github/workflows/ci.yml), [release.yml](../.github/workflows/release.yml), [contract.yml](../.github/workflows/contract.yml); [dependabot.yml](../.github/dependabot.yml)
- Source: [account-commands.ts](../packages/cli/src/commands/account-commands.ts), [CLI tsup config](../packages/cli/tsup.config.ts), [MCP tsup config](../packages/mcp/tsup.config.ts), [vitest.config.ts](../vitest.config.ts), [contract suite](../contract/uat.contract.ts)
- Sibling docs: [project-overview-pdr.md](project-overview-pdr.md), [codebase-summary.md](codebase-summary.md), [code-standards.md](code-standards.md), [system-architecture.md](system-architecture.md), [deployment-guide.md](deployment-guide.md)
