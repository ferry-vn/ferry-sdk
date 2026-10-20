# Project Overview and Product Development Requirements (PDR)

Ferry VN SDK is an npm-workspaces monorepo that ships three deliverables for the Ferry VN partner API: a TypeScript SDK (`@ferryvn/sdk`), a command-line tool (`@ferryvn/cli`, binary `ferry`) and an MCP server (`@ferryvn/mcp`, binary `ferry-mcp`). This document states what the product is for, who uses it, and the functional and non-functional requirements each package must meet. Requirement IDs (`FR-*`, `NFR-*`, `SAF-*`) are stable references for other docs and reviews.

Status at the time of writing: v1.0.0, released on GitHub; the npm packages are not published yet (see [project-roadmap.md](project-roadmap.md)).

## 1. Product purpose

Ferry VN is Vietnam's ferry booking platform: tickets from 10+ operators, instant 24/7 issuance, secure card payments and AI-powered search (organization description supplied for this project). This repository does not implement that platform. It is the **official client toolkit** for the partner API (`/api/v1/...`, Bearer API key) that lets integrators:

- search locations, routes, operators, voyages, calendars, route prices and seat maps;
- create and manage customers and bookings, request cancellations, read vouchers, disruptions, organization balance, transactions and debt ledger;
- do so from code (SDK), a terminal or spreadsheet workflow (CLI), or an AI agent (MCP).

Source of the purpose statement: [README.md](../README.md) (intro paragraph), [packages/sdk/package.json](../packages/sdk/package.json).

Core value propositions, as stated in the repo:

| Proposition | Where it is realised |
|---|---|
| Types match the real API, not the Swagger | `openapi/partner.json` is extracted from backend source; `scripts/filter-openapi.ts` corrects wrong responses; types are generated into `packages/sdk/src/generated/` (README "How the types stay correct") |
| Invalid bookings are caught before any request | Booking builder (`bookingDrafts.prepare`) validates seats, ticket types, passengers, vouchers locally ([CHANGELOG.md](../CHANGELOG.md) 1.0.0 "Booking builder") |
| Safe by default for money | No POST retries, MCP never exposes issuance, MCP writes opt-in ([README.md](../README.md) "What moves money") |
| Works for non-developers | CLI reads passenger lists from CSV/JSON, outputs table/JSON/NDJSON/CSV |

## 2. Target users

| User | Typical need | Primary deliverable |
|---|---|---|
| Travel agencies | Book on behalf of customers from spreadsheets, export bookings for accounting | CLI (`ferry booking draft --passengers x.csv`, `ferry booking list --output csv`) |
| OTAs / integrators | Embed search and booking in a server-side product, handle webhooks | SDK |
| Ferry VN internal staff | Inspect bookings, orders, disruptions, balances; ad-hoc API calls | CLI (`ferry api`, `ferry doctor`), SDK |
| AI agents / assistants (Claude Desktop, Claude Code, other MCP clients) | Plan trips, quote and (opt-in) create bookings with human confirmation | MCP server |

Source: [README.md](../README.md) intro and Vietnamese section.

Assumptions about users (from [SECURITY.md](../SECURITY.md) and README): the API key is created by an organization admin in the Ferry VN dashboard, shown once, does not expire, and carries organization-admin power. Users are therefore expected to keep it server-side.

## 3. Deliverables

| Package | Binary | Version | Node engine | Runtime deps | Distribution |
|---|---|---|---|---|---|
| `@ferryvn/sdk` | none | 1.0.0 | `>=20` | none | npm (ESM + CJS + `.d.ts`/`.d.cts`), `sideEffects: false` |
| `@ferryvn/cli` | `ferry` | 1.0.0 | `>=22.12` | `@ferryvn/sdk` (exact 1.0.0), `commander ^15.0.0` | npm |
| `@ferryvn/mcp` | `ferry-mcp` | 1.0.0 | `>=22.12` | `@ferryvn/sdk` (exact 1.0.0), `@modelcontextprotocol/sdk ^1.32.1`, `zod ^4.6.5` | npm, Claude Desktop `.mcpb` bundle, Docker image (HTTP mode, build-it-yourself), MCP Registry `server.json` |

All three are versioned in lockstep (`npm run version:set`, `scripts/version.mjs`) and licensed Apache-2.0, Copyright 2026 Ferry VN JSC. The repo root is a private workspace (`ferry-sdk-monorepo`). Details: [codebase-summary.md](codebase-summary.md).

## 4. Functional requirements

### 4.1 SDK (`@ferryvn/sdk`)

| ID | Requirement | Evidence |
|---|---|---|
| FR-SDK-01 | `FerryClient` accepts `apiKey`, `baseUrl`, `environment` (`production` = `https://api.ferry.vn`, `uat` = `https://api.ferryvn.net`), `timeoutMs` (default 30 000), `retry`, `fetch`, `language`, `headers`, `userAgent`, `hooks`, `debug`, `cache.locationsTtlMs`, `dangerouslyAllowBrowser`. Invalid options throw `FerryConfigError` synchronously. | `packages/sdk/src/client.ts` |
| FR-SDK-02 | Typed resources for supply (`locations`, `routes`, `operators`, `voyages`, `voyageCounts`, `boatLayouts`), bookings and orders (`bookings`, `orders`, `cancelTicketRequests`, `vouchers`, `disruptions`) and account (`customers`, `organization`, `transactions`, `debtLedger`). | `src/resources/*.ts` |
| FR-SDK-03 | Every method accepts per-request `signal`, `timeoutMs`, `maxRetries`, `headers`, `requestId`. An `x-request-id` is sent on every request (stable across retries) and exposed on errors. | `src/http.ts` |
| FR-SDK-04 | Typed error hierarchy (`FerryError` → `FerryConfigError`, `FerryApiError` → Auth/Permission/NotFound/Conflict/Validation/RateLimit/Server, `FerryConnectionError` → Timeout/Network/Abort, `FerryBookingDraftError`), backend domain codes via `FerryErrorCode` / `errorCodeName()`, Vietnamese `userMessage` preserved. | `src/errors.ts`, `src/error-codes.ts` |
| FR-SDK-05 | Cursor pagination: `iterate()` on every cursor list returns an `AsyncGenerator`; `collect()` materialises it; loop guard stops on repeated or empty cursors. | `src/pagination.ts` |
| FR-SDK-06 | Booking builder: `bookingDrafts.prepare/create` and pure `buildLegTickets` pick ticket types by age/nationality using operator rules, match prices, check free seats, duplicate social ids, passenger input-length rules, vouchers and harbor fees, and report every issue locally before any write. | `src/booking-builder.ts` |
| FR-SDK-07 | Route prices: `prices.forRoute` returns selling price (VAT, harbor fee) per voyage × seat type × ticket type for a date or range; `live` (max 10, `MAX_LIVE_SEAT_MAPS`) re-prices from seat maps. | `src/prices.ts` |
| FR-SDK-08 | Seat-map helpers: `flattenSeatMap`, `seatRef` (`NAME#POSITION_ID`), `isVehicleSeatType`, `voyageHarborFee`. | `src/seat-map.ts`, `src/booking-builder.ts` |
| FR-SDK-09 | Vietnam calendar semantics (fixed UTC+7): `toYmd`, `todayInVietnam`, `addDays`, `vietnamDayStart/End`; bare-date `createdAtFrom/To` filters mean Vietnam days. | `src/dates.ts` |
| FR-SDK-10 | Webhook helpers: `parseWebhook` (typed by `x-event-type`), `WEBHOOK_EVENTS`, constant-time `safeEqual`. | `src/webhooks.ts` |
| FR-SDK-11 | Escape hatch `client.request()` for endpoints the SDK does not wrap (`path` must start with `/`). | `src/client.ts` |
| FR-SDK-12 | Locations cache (default TTL 600 000 ms): shared promise, failures never cached, per-caller array copy; `locations.find` matches id, abbreviation or accent-insensitive name. | `src/resources/supply-resources.ts` |
| FR-SDK-13 | Utility exports: `normalizeText`, `formatVnd`, `isVoyageBookable`, `voyageUnbookableReason`, `voyageDeparture`, `ticketFileUrls`, `statusLabel`, status enums, `SDK_VERSION`. | `src/index.ts` |
| FR-SDK-14 | Hooks (`onRequest`, `onResponse`, `onRetry`) receive redacted headers; hook exceptions are swallowed and logged via `debug`. | `src/http.ts` |

### 4.2 CLI (`@ferryvn/cli`, `ferry`)

| ID | Requirement | Evidence |
|---|---|---|
| FR-CLI-01 | Auth and profiles: `login` (hidden prompt, `--api-key-stdin`, verifies key via `organization.me()` unless `--no-verify`), `logout`, `whoami [--check]`, `profiles list` / `profiles use`. | `src/commands/auth-commands.ts` |
| FR-CLI-02 | Supply commands: `locations`, `routes`, `operators list` / `operators nationals`, `voyages search`, `prices`, `calendar`, `seats`. Unbookable voyages hidden unless `--include-unavailable`. `--date` accepts `today` and `tomorrow`. | `src/commands/supply-commands.ts` |
| FR-CLI-03 | Booking commands: `booking` subcommands `create`, `draft`, `get`, `public`, `list`, `update`, `issue`, `tickets`; `orders list` / `orders get`; `cancel request` / `cancel list` / `cancel get`. | `src/commands/booking-commands.ts`, `draft-command.ts` |
| FR-CLI-04 | `booking draft` builds a valid create-booking payload from seat names plus passengers in CSV (RFC 4180, `;` auto-detect, Vietnamese header aliases, UTF-8 only) or JSON, via `bookingDrafts.prepare`; `--out` writes payload, `--create` creates the booking. | `src/commands/draft-command.ts` |
| FR-CLI-05 | Account commands: `account`, `customers list` / `get` / `create`, `transactions`, `debts`, `vouchers`, `disruptions list` / `get`. | `src/commands/account-commands.ts` |
| FR-CLI-06 | Utility commands: `api <METHOD> <path>` raw requests, `doctor` diagnostics, `completion` for bash and zsh. | `src/commands/util-commands.ts` |
| FR-CLI-07 | Output formats `table`, `json`, `ndjson`, `csv` (`--output`, `--json`); format validated before any request; CSV has UTF-8 BOM, numeric VND and formula-injection neutralisation. | `src/output.ts`, `src/cli-context.ts` |
| FR-CLI-08 | Distinct exit codes: 0 ok, 1 error, 2 usage, 3 auth/permission, 4 not found, 5 rate limited. | `src/cli-context.ts` (`EXIT`, `reportError`) |
| FR-CLI-09 | Credential/endpoint resolution: profile name `--profile` > `FERRY_PROFILE` > stored current > `default`; a profile's key keeps its own endpoint; env endpoint vars are ignored (with a warning) when an explicit profile key is used. | `src/cli-context.ts` |
| FR-CLI-10 | Config store: per-OS `config.json`, dir mode 0700, file mode 0600, atomic write; corrupt files raise an error and are never overwritten; legacy 0.x flat config read as profile `default`. | `src/config-store.ts` |
| FR-CLI-11 | Confirmation for `booking issue`, `cancel request` and write calls through `api`: `--yes` or typing the id/method on a TTY; otherwise exit 2. | `CliContext.confirm` |

### 4.3 MCP server (`@ferryvn/mcp`, `ferry-mcp`)

| ID | Requirement | Evidence |
|---|---|---|
| FR-MCP-01 | 14 read tools: `search_locations`, `list_routes`, `search_voyages`, `get_route_prices`, `get_voyage_calendar`, `get_seat_map`, `quote_booking`, `find_customers`, `get_booking`, `list_bookings`, `list_cancel_requests`, `get_disruptions`, `get_account`, `list_vouchers`. All annotated read-only. | `packages/mcp/src/read-tools.ts` |
| FR-MCP-02 | 3 write tools, registered only when opted in: `create_customer`, `create_booking`, `request_cancellation` (the last is `destructiveHint: true`). | `src/write-tools.ts` |
| FR-MCP-03 | Prompts `plan_ferry_trip`, `check_booking`; resource `ferry://locations`. | `src/server.ts` |
| FR-MCP-04 | Strict input schemas: unknown tool arguments are rejected (`additionalProperties: false`). | `src/server.ts`, `test/mcp-tools.test.ts` |
| FR-MCP-05 | Results return compact JSON text plus `structuredContent`; failures return `isError: true` with hints for 401, 403, 429 and known seat-map error codes. | `src/tool-helpers.ts` |
| FR-MCP-06 | Transports: stdio (default) and stateless Streamable HTTP (`--http`, `--port`, default 3333) with `/healthz` and `/mcp`. | `src/index.ts`, `src/http-server.ts` |
| FR-MCP-07 | Write lifecycle: read-only validation → confirmation (MCP elicitation if the client supports it, else `user_confirmed: true`) → write budget (`FERRY_MCP_MAX_WRITES`, default 20) → SDK call → audit line (ids and counts only; sink stderr, plus `FERRY_MCP_AUDIT_FILE` mode 0600). | `src/tool-helpers.ts`, `src/index.ts` |
| FR-MCP-08 | `FERRY_MCP_DISABLED_TOOLS` hides named tools; unknown names fail startup. | `src/server.ts` (`configFromEnv`) |
| FR-MCP-09 | Packaging: npm bin, `.mcpb` bundle for Claude Desktop (`user_config`: `api_key`, `environment`, `enable_writes`), Dockerfile for HTTP mode, `server.json` for the MCP Registry. | `packages/mcp/` |

### 4.4 Repository-level (tooling)

| ID | Requirement | Evidence |
|---|---|---|
| FR-REPO-01 | OpenAPI pipeline: `openapi:extract` (needs a backend checkout) → `partner.json`/`public.json`; `openapi:filter` → `sdk.json`; `generate` → `partner-api.d.ts`. | `scripts/`, root `package.json` |
| FR-REPO-02 | Lockstep versioning with `version:set` / `version:check` across manifests, `version.ts` files, `server.json`, `mcpb/manifest.json`. | `scripts/version.mjs` |
| FR-REPO-03 | Release workflow: tag `vX.Y.Z` → CI → version check → build + `.mcpb` → npm publish (gated by `NPM_PUBLISH == 'true'`) → GitHub release with notes from CHANGELOG. | `.github/workflows/release.yml` |
| FR-REPO-04 | Nightly read-only contract tests against UAT (or production via `FERRY_CONTRACT_ENV=production`), skipped without a key. | `.github/workflows/contract.yml`, `contract/uat.contract.ts` |

## 5. Non-functional requirements

| ID | Category | Requirement | Evidence |
|---|---|---|---|
| NFR-01 | Runtimes | SDK runs on Node ≥ 20, Bun, Deno, edge runtimes and browsers (browser needs opt-in); platform-neutral bundle (no Node built-ins, no JSON import). | `packages/sdk/package.json`, `tsup.config.ts` (`platform: 'neutral'`), `src/version.ts` |
| NFR-02 | Zero-dependency SDK | `@ferryvn/sdk` declares no runtime dependencies; built on `fetch`. | `packages/sdk/package.json`, [CONTRIBUTING.md](../CONTRIBUTING.md) |
| NFR-03 | Module formats | SDK ships ESM and CJS with separate `.d.ts`/`.d.cts`; `target es2022`. Checked by publint and are-the-types-wrong (`attw --profile node16`). | `tsup.config.ts`, `scripts/pack-check.mjs` |
| NFR-04 | Node engines | Root, CLI and MCP require Node ≥ 22.12; SDK requires ≥ 20 (smoke-tested on Node 20 in CI). | package manifests, `ci.yml` |
| NFR-05 | Type correctness | Types generated from `openapi/sdk.json` (39 operations, 123 schemas) derived from backend v3.2.16; `generate:check` fails CI on stale generated output; response corrections tagged `x-ferry-sdk-patch`. | `scripts/filter-openapi.ts`, `ci.yml` |
| NFR-06 | TypeScript strictness | `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `isolatedModules`, NodeNext resolution (`.js` import extensions). | `tsconfig.base.json` |
| NFR-07 | Lint | Biome `recommended`; `noExplicitAny` is an error. | `biome.json` |
| NFR-08 | Coverage floors | v8 coverage thresholds: lines 78, statements 75, functions 65, branches 65 (index files and generated code excluded). | root `vitest.config.ts` |
| NFR-09 | Test isolation | Unit tests use mocked `fetch` / injected deps; no network or API key. Contract tests are separate (`vitest.contract.config.ts`). | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| NFR-10 | Security posture | See section 6. | — |
| NFR-11 | Timeouts | Default request timeout 30 s; `confirmToIssue` at least 10 min; `refreshTicketFiles` at least 120 s; timeouts capped below `setTimeout` overflow (`MAX_TIMEOUT_MS`). | `src/client.ts`, `src/resources/booking-resources.ts`, `src/http.ts` |
| NFR-12 | Licensing | Apache-2.0; `LICENSE`, `NOTICE`, `README.md` in every package tarball; `THIRD_PARTY_NOTICES.txt` in the `.mcpb` and Docker image. | `scripts/pack-check.mjs`, `scripts/pack-mcpb.mjs` |
| NFR-13 | Observability | `debug` logger, `hooks`, `x-request-id`; CLI `--debug`/`FERRY_DEBUG=1` to stderr; MCP logs to stderr only (stdout is the JSON-RPC channel). | `src/http.ts`, `packages/mcp/src/index.ts` |
| NFR-14 | Localisation | Vietnamese-aware: accent-insensitive search (`normalizeText`), VND formatting (`1.250.000 ₫`), Vietnam time (UTC+7), Vietnamese CSV headers, `x-custom-lang` header. | `src/text.ts`, `src/dates.ts` |

## 6. Constraints and safety model

### 6.1 Safety requirements (inviolable)

| ID | Requirement | Enforcement |
|---|---|---|
| SAF-01 | **No POST retries.** The backend has no idempotency keys. Only GET/HEAD are retried (network errors, timeouts, 408/429/502/503/504). `bookings.create` is documented as not idempotent; after a network error, look the booking up (`bookings.list` / `ferry booking list`) before sending again. | `packages/sdk/src/http.ts` (`IDEMPOTENT`), `errors-retries-pagination.test.ts` |
| SAF-02 | **`confirmToIssue` moves money** (charges organization balance and credit; a customer shortfall may be recorded as debt; limited to 5 attempts per booking per minute). It is **never exposed over MCP**. In the CLI it requires explicit confirmation. | `packages/mcp/src/write-tools.ts` header; guardrail test in `packages/mcp/test/mcp-tools.test.ts`: no called path may match the regex for `confirmToIssue`, `payments`, `transactions`, `withdraw`, `top-up`, `debt`, `settings`, `api-keys`; the only non-GET paths are `/api/v1/bookings`, `/api/v1/cancel-ticket-request`, `/api/v1/customers` |
| SAF-03 | **MCP writes are opt-in**: `FERRY_MCP_ENABLE_WRITES=true` (exact string). Over `--http` a second opt-in `FERRY_MCP_HTTP_ALLOW_WRITES=true` is required because stateless HTTP has no confirmation dialog. | `packages/mcp/src/server.ts` (`writesFor`, `configFromEnv`) |
| SAF-04 | **UAT is not a sandbox.** Issuing tickets on `api.ferryvn.net` reaches the real operator and spends the organization's real balance. | [README.md](../README.md) ("Before you start") |
| SAF-05 | **Webhooks are unsigned and delivered once** (no retries; documented 2-second timeout). Integrators put a secret token in the URL (`safeEqual`) and reconcile through the API. | `packages/sdk/src/webhooks.ts`, [README.md](../README.md) |
| SAF-06 | Creating a booking charges nothing and holds no seats; creating a cancellation request holds the cancellation fee immediately. | `packages/sdk/src/resources/booking-resources.ts`, README |
| SAF-07 | API key has organization-admin power: SDK refuses to start with a key in a browser unless `dangerouslyAllowBrowser: true`; keys never logged (`Authorization` redacted to `Bearer [redacted]`; cookies and `x-api-key` fully hidden). | `src/client.ts`, `src/http.ts` |
| SAF-08 | `FerryApiError.toJSON()` omits response bodies (may contain personal data) and strips query strings from URLs. | `src/errors.ts` |
| SAF-09 | MCP HTTP mode: Host and Origin allow-lists, bearer token (≥ 16 chars, mandatory for non-loopback binds or non-loopback allow-list entries), POST only, 1 MB body limit, request timeout 120 s, headers timeout 30 s. | `packages/mcp/src/http-server.ts` |
| SAF-10 | MCP audit entries contain ids and counts only, never passenger personal data; write budget per process (default 20). | `packages/mcp/src/tool-helpers.ts` |
| SAF-11 | CLI protects credentials and state: config file 0600 in a 0700 directory; a rejected key is never stored; a corrupt config is never overwritten; raw `ferry api` writes need confirmation; CSV neutralises formula injection. | `packages/cli/src/config-store.ts`, `output.ts`, `util-commands.ts` |

### 6.2 Other constraints

- **Backend dependency.** Domain rules mirror "backend v3.2.16" (comments in `booking-builder.ts`, `error-codes.ts`, `webhooks.ts`, `account-resources.ts`). Re-extraction needs a separate backend checkout with `node_modules` (`npm run openapi:extract -- --backend <dir>`); no database is needed.
- **Prices are indicative until re-priced.** Search prices come from pre-synced data; `live` / seat-map prices are authoritative; FerryVN re-prices at creation.
- **Seats are not held** by booking creation.
- **`baseUrl` must not include `/api/v1`.**
- **Intentionally unwrapped endpoints** (reachable through `ferry.request()` / `ferry api`): `/bookings/sync`, passengers, partner `GET /cancel-ticket-request/:id`, and admin endpoints.
- **Sources of truth.** `openapi/*.json` and `packages/sdk/src/generated/` are generated; do not edit by hand.

## 7. Success and acceptance criteria

The release gate is `npm run verify` ("what CI runs", [CONTRIBUTING.md](../CONTRIBUTING.md)). It chains: `version:check` → `lint` → `typecheck` → `test:coverage` → `build` → `smoke:cli` → `smoke:mcp` → `smoke:sdk` → `pack:check`. CI (`.github/workflows/ci.yml`) additionally enforces the generated-types check and platform matrix.

| # | Criterion | Gate |
|---|---|---|
| AC-1 | All package, `src/version.ts`, `server.json` and `mcpb/manifest.json` versions agree (and match the tag on release) | `npm run version:check` (`-- --tag vX.Y.Z` in release) |
| AC-2 | `openapi/sdk.json` and `packages/sdk/src/generated/` are up to date | `generate:check` (`git diff --exit-code`) in CI `verify` job |
| AC-3 | Biome clean | `npm run lint` |
| AC-4 | Typecheck passes for root and every workspace | `npm run typecheck` |
| AC-5 | Tests pass and coverage ≥ floors (78/75/65/65) | `npm run test:coverage` |
| AC-6 | Builds succeed in order sdk → cli → mcp | `npm run build` |
| AC-7 | SDK built ESM and CJS load, send `Bearer` auth, a UUID `x-request-id`, default base URL `https://api.ferry.vn/api/v1/...`, Vietnam-day `toYmd`, and `FerryApiError instanceof FerryError` | `smoke:sdk` |
| AC-8 | SDK works on the oldest supported Node with no dev toolchain | CI job `sdk-oldest-node` (Node 20, built `dist`) |
| AC-9 | CLI starts (`--help`) on Ubuntu (Node 22, 24), Windows and macOS (Node 24) | `smoke:cli`, CI `cross-os` job runs `npm test`, build, smoke |
| AC-10 | MCP initialises over stdio and HTTP; write tools present only when opted in; over HTTP they stay hidden without the second opt-in; foreign Host/Origin → 403; missing/wrong token → 401 | `smoke:mcp` (three runs) |
| AC-11 | MCP never calls issuance/payment/admin endpoints | guardrail test in `packages/mcp/test/mcp-tools.test.ts` |
| AC-12 | Tarballs contain `LICENSE`, `NOTICE`, `README.md`, `package.json`, no `src/` or `test/`; publint `--strict` and attw (SDK) pass; packed packages install and run (`ferry --version`, `ferry-mcp --help`, ESM import, CJS require) | `npm run pack:check` (CI Node 24) |
| AC-13 | No drift between backend and `sdk.json` on read paths | Nightly `contract.yml` (only runs when `FERRY_UAT_API_KEY` is set) |
| AC-14 | Release notes exist for the version | Release job fails if `## [x.y.z]` is missing in CHANGELOG |

1.0.0 acceptance evidence recorded in [CHANGELOG.md](../CHANGELOG.md): read-only runs against UAT and production on 2026-10-07 (production: 478 voyages on 51 routes), two real `Requested` production bookings whose server totals matched the builder quote to the đồng, and a pre-release audit on 2026-10-18.

## 8. Out of scope

| Out of scope | Basis |
|---|---|
| MCP tools for payments, ticket issuance (`confirmToIssue`), top-ups/withdrawals, balance adjustment, debt, settings, API-key management and organization administration | README "What moves money"; header of `write-tools.ts`; guardrail test |
| SDK retries of non-idempotent calls (POST/PATCH/DELETE) | SAF-01 |
| Webhook receiver/server, signature verification (the API does not sign) | SDK exposes only `parseWebhook`, `safeEqual`, `WEBHOOK_EVENTS` |
| First-class SDK wrappers for `/bookings/sync`, passengers, partner `GET /cancel-ticket-request/:id`, admin endpoints | `booking-resources.ts` header, `scripts/filter-openapi.ts`; use `request()` / `ferry api` |
| Running a Ferry VN backend, sandbox or mock server | Not defined in repo; UAT is a real environment |
| Browser use of the API key | Guarded; opt-in only |
| Publishing the Docker image or registering `server.json` in the MCP Registry via CI | No workflow does it (scout grep of `.github`, `scripts`, docs found no `docker push`, `ghcr`, `mcp-publisher`) |
| CLI `customers update` | Not registered (a stale comment in `account-commands.ts` mentions it) |
| Plans, pricing tiers, SLAs, rate-limit guarantees | Not defined in repo |

## References

- [README.md](../README.md), [CONTRIBUTING.md](../CONTRIBUTING.md), [CHANGELOG.md](../CHANGELOG.md), [SECURITY.md](../SECURITY.md)
- Package docs: [SDK](../packages/sdk/README.md), [CLI](../packages/cli/README.md), [MCP](../packages/mcp/README.md)
- Workflows: [ci.yml](../.github/workflows/ci.yml), [release.yml](../.github/workflows/release.yml), [contract.yml](../.github/workflows/contract.yml)
- Config: [package.json](../package.json), [vitest.config.ts](../vitest.config.ts), [biome.json](../biome.json), [tsconfig.base.json](../tsconfig.base.json)
- Sibling docs: [codebase-summary.md](codebase-summary.md), [code-standards.md](code-standards.md), [system-architecture.md](system-architecture.md), [project-roadmap.md](project-roadmap.md), [deployment-guide.md](deployment-guide.md)
