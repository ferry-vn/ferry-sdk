# Contributing

```bash
npm ci
npm run verify     # what CI runs: versions, lint, typecheck, tests + coverage, build, smoke, package checks
```

- Node ≥ 22.12 for development. Tests use a mocked `fetch` — no network or API key needed.
- Code style is enforced by Biome (`npm run lint:fix`). Keep the SDK free of runtime dependencies.
- Changes to the API surface start in `openapi/partner.json` (re-extracted from
  the backend with `npm run openapi:extract`) and `scripts/filter-openapi.ts`;
  run `npm run generate` and commit the regenerated `openapi/sdk.json` and
  `packages/sdk/src/generated/`. Response corrections must be verified in the
  backend source and marked with `x-ferry-sdk-patch`.
- Anything that moves money (ticket issuance, payments, balances) must stay out
  of the MCP server; `packages/mcp/test` enforces this.
- Add a CHANGELOG entry under `[Unreleased]`. Releases are cut by maintainers
  (see "Releasing" in the README).
- By contributing you agree that your contributions are licensed under Apache-2.0.
