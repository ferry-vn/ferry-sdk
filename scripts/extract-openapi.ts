/**
 * Extract the real OpenAPI document from the FerryVN NestJS backend WITHOUT
 * live infrastructure (no MongoDB / Redis / Permify / MeiliSearch needed).
 *
 * How it works:
 *  1. Transpile the backend `src/` with the backend's own SWC (decorator
 *     metadata on) into a throw-away temp dir. The backend checkout is never
 *     written to.
 *  2. Symlink the backend's `node_modules` next to the transpiled output so
 *     `require()` resolves exactly the dependency versions the backend uses.
 *  3. Fill every env var from `env-example-document` with a placeholder so the
 *     config validators pass at module-definition time.
 *  4. `NestFactory.create(AppModule, { preview: true })` — Nest builds the
 *     module graph but does NOT instantiate providers/controllers, so no DB
 *     or network connection is ever opened.
 *  5. Apply the same global prefix + URI versioning as `src/bootstrap-app.ts`,
 *     run `SwaggerModule.createDocument`, then apply the same `x-public`
 *     filter as `src/utils/swagger-filter-internal-routes.ts` (= what the
 *     backend serves at `/docs`, i.e. public + partner tiers).
 *  6. Normalise (security schemes, strip the doc-only `x-public` header
 *     parameter, servers, stable key order) and write:
 *       openapi/partner.json  public + partner tiers (the `/docs` document)
 *       openapi/public.json   only operations that need no credentials
 *
 * Usage (from this repo):
 *   npm run openapi:extract -- --backend ../ferry-ticket-back-end
 *   FERRY_BACKEND_DIR=/path/to/backend npm run openapi:extract
 *
 * Note: the backend does not enable the @nestjs/swagger CLI plugin
 * (`nest-cli.json` has no `plugins`), so schemas come only from explicit
 * `@ApiProperty` decorators — exactly what production `/docs` shows.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Json = Record<string, unknown>;
type Operation = Json & {
  parameters?: Array<{ in: string; name: string }>;
  security?: Array<Record<string, string[]>>;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(REPO_ROOT, 'openapi');
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Security scheme names used by `@ApiBearerAuth(...)` across partner controllers. */
const API_KEY_SCHEME_NAMES = ['API Key', 'API key'];

function parseArgs(argv: string[]): { backend: string } {
  const idx = argv.indexOf('--backend');
  const fromArg = idx >= 0 ? argv[idx + 1] : undefined;
  const backend = path.resolve(
    fromArg ?? process.env.FERRY_BACKEND_DIR ?? path.join(REPO_ROOT, '..', 'ferry-ticket-back-end'),
  );
  if (!fs.existsSync(path.join(backend, 'src', 'app.module.ts'))) {
    throw new Error(`Backend checkout not found at ${backend} (expected src/app.module.ts)`);
  }
  if (!fs.existsSync(path.join(backend, 'node_modules', '@nestjs', 'swagger'))) {
    throw new Error(`Backend dependencies missing — run "npm ci" in ${backend} first`);
  }
  return { backend };
}

/** Step 1+2: transpile backend sources into a temp dir and link node_modules. */
function transpileBackend(backend: string): string {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferry-openapi-'));
  const swcrc = path.join(outDir, '.swcrc.json');
  fs.writeFileSync(
    swcrc,
    JSON.stringify({
      sourceMaps: false,
      module: { type: 'commonjs' },
      jsc: {
        target: 'es2021',
        parser: { syntax: 'typescript', decorators: true, dynamicImport: true },
        transform: { legacyDecorator: true, decoratorMetadata: true, useDefineForClassFields: false },
        keepClassNames: true,
        baseUrl: backend,
      },
    }),
  );
  const swcBin = path.join(backend, 'node_modules', '.bin', 'swc');
  const res = spawnSync(
    swcBin,
    ['src', '-d', outDir, '--config-file', swcrc, '--copy-files', '--ignore', '**/*.spec.ts'],
    { cwd: backend, encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(`SWC transpile failed:\n${res.stdout}\n${res.stderr}`);
  }
  fs.symlinkSync(path.join(backend, 'node_modules'), path.join(outDir, 'node_modules'), 'dir');
  return outDir;
}

/** Step 3: placeholder env so `registerAs(...)` validators pass. */
function primeEnv(backend: string): void {
  const example = fs.readFileSync(path.join(backend, 'env-example-document'), 'utf8');
  for (const line of example.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    const [, name, value] = m ?? [];
    if (name && process.env[name] === undefined) process.env[name] = value || 'placeholder';
  }
  Object.assign(process.env, {
    NODE_ENV: 'development',
    API_PREFIX: 'api',
    // The S3 driver is the one whose FilesModule wiring resolves in preview mode.
    FILE_DRIVER: 's3',
    AWS_DEFAULT_S3_URL: 'https://s3.example.invalid',
    DISABLE_API_SERVER: 'true',
    ENABLE_TASK_WORKER: 'false',
  });
}

function filterByVisibility(doc: Json, header: string): Json {
  const paths = doc.paths as Record<string, Record<string, Operation>>;
  const out: Record<string, Record<string, Operation>> = {};
  for (const [p, item] of Object.entries(paths)) {
    const kept: Record<string, Operation> = {};
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      if (op.parameters?.some((x) => x.in === 'header' && x.name === header)) kept[method] = op;
    }
    if (Object.keys(kept).length) out[p] = kept;
  }
  return { ...doc, paths: out };
}

/** Step 6: make the document valid + stable for code generation. */
function normalise(doc: Json, backendVersion: string): Json {
  const paths = doc.paths as Record<string, Record<string, Operation>>;
  for (const item of Object.values(paths)) {
    for (const op of Object.values(item)) {
      op.parameters = (op.parameters ?? []).filter(
        (x) => !(x.in === 'header' && ['x-public', 'x-internal', 'x-admin'].includes(x.name)),
      );
      if (op.parameters.length === 0) delete op.parameters;
      // Every partner scheme is the same `Authorization: Bearer <api key>` header.
      if (op.security) {
        op.security = op.security.map((req) => {
          const names = Object.keys(req);
          return names.some((n) => API_KEY_SCHEME_NAMES.includes(n) || n === 'bearer') ? { apiKey: [] } : req;
        });
      }
    }
  }
  const components = (doc.components ?? {}) as Json;
  components.securitySchemes = {
    apiKey: {
      type: 'http',
      scheme: 'bearer',
      description:
        'Partner API key (created in the dashboard, internal tier `/internal/api-keys`). Sent as `Authorization: Bearer <API_KEY_PREFIX><keyId>_<secret>`. Validated by the `bearer-header` passport strategy (passport-http-bearer).',
    },
  };
  return sortKeys({
    ...doc,
    info: {
      ...(doc.info as Json),
      title: 'Ferry Ticket API (public + partner)',
      version: backendVersion,
      'x-generated-by': 'ferry-sdk/scripts/extract-openapi.ts',
    },
    servers: [
      { url: 'https://api.ferry.vn', description: 'Production' },
      { url: 'https://api.ferryvn.net', description: 'UAT' },
    ],
    components,
  }) as Json;
}

/**
 * Documented, minimal corrections where the backend's Swagger decorators do
 * not match what the handler actually returns (verified against the source).
 * Every patched node carries `x-ferry-sdk-patch` with the reason.
 */
function applyPatches(doc: Json): Json {
  const paths = doc.paths as Record<string, Record<string, Operation & { responses?: Json }>>;
  const schemas = (doc.components as Json).schemas as Record<string, Json>;
  const cursorPage = (item: string): string => {
    const name = `CursorInfinityPagination${item}ResponseDto`;
    schemas[name] ??= {
      type: 'object',
      required: ['data', 'next_cursor'],
      properties: {
        data: { type: 'array', items: { $ref: `#/components/schemas/${item}` } },
        next_cursor: { type: 'string', nullable: true, example: '66b57bjj5ef8ashc71ca30jsv9c' },
        total: { type: 'number', nullable: true },
      },
    };
    return name;
  };
  const setOk = (p: string, method: string, schema: Json, reason: string): void => {
    const op = paths[p]?.[method];
    if (!op) throw new Error(`patch target missing: ${method.toUpperCase()} ${p}`);
    op.responses = {
      ...(op.responses ?? {}),
      '200': { description: 'OK', content: { 'application/json': { schema } } },
    };
    (op as Json)['x-ferry-sdk-patch'] = reason;
  };

  const voyagePage = { $ref: `#/components/schemas/${cursorPage('VoyageWithAdditions')}` };
  const genericReason =
    'Controller passes the CursorInfinityPaginationResponse factory un-called (`type: CursorInfinityPaginationResponse<VoyageWithAdditions>`), so Swagger emitted an empty schema. Handler returns { data: VoyageWithAdditions[], next_cursor }.';
  setOk('/api/v1/voyages/findAllRelateByLocationAndDate', 'get', voyagePage, genericReason);
  setOk('/api/v1/voyages/findAllRelateByLocationAndDateRange', 'get', voyagePage, genericReason);
  setOk(
    '/api/v1/routes',
    'get',
    { $ref: `#/components/schemas/${cursorPage('Route')}` },
    'Decorator declares a single Route; handler returns routeService.findAllWithCursorPagination() = { data: Route[], next_cursor }.',
  );
  schemas.VoyageCountSummary ??= {
    type: 'object',
    required: ['departure_date', 'total_voyage', 'total_available_voyage'],
    properties: {
      departure_date: { type: 'string', format: 'date-time' },
      total_voyage: { type: 'number' },
      total_available_voyage: { type: 'number' },
    },
  };
  setOk(
    '/api/v1/voyage-counts',
    'get',
    { type: 'array', items: { $ref: '#/components/schemas/VoyageCountSummary' } },
    'No response decorator; VoyageCountsService.findAllWithRelatedRouteCheck() returns { departure_date, total_voyage, total_available_voyage }[].',
  );
  setOk(
    '/api/v1/orders/{id}',
    'get',
    { $ref: '#/components/schemas/Order' },
    'No response decorator; handler returns ordersService.findOne() → Order.',
  );
  const vwa = schemas.VoyageWithAdditions;
  if (vwa) {
    vwa.required = ['voyage'];
    vwa['x-ferry-sdk-patch'] =
      '`additions` is @Exclude({ toPlainOnly: true }) in the domain class, so it is usually absent from responses.';
  }
  return doc;
}

function onlyAnonymous(doc: Json): Json {
  const paths = doc.paths as Record<string, Record<string, Operation>>;
  const out: Record<string, Record<string, Operation>> = {};
  for (const [p, item] of Object.entries(paths)) {
    const kept = Object.fromEntries(Object.entries(item).filter(([, op]) => !op.security || op.security.length === 0));
    if (Object.keys(kept).length) out[p] = kept;
  }
  return { ...doc, info: { ...(doc.info as Json), title: 'Ferry Ticket API (public, anonymous)' }, paths: out };
}

/** Drop component schemas no operation (transitively) references. */
function pruneSchemas(doc: Json): Json {
  const schemas = ((doc.components as Json | undefined)?.schemas ?? {}) as Json;
  const used = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Json)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/')) {
        const name = v.slice('#/components/schemas/'.length);
        if (!used.has(name)) {
          used.add(name);
          visit(schemas[name]);
        }
      } else visit(v);
    }
  };
  visit(doc.paths);
  // Filter DTOs are only linked from parameter descriptions, e.g.
  // "[Check model](#model/filterbookingdto)" — keep them, they type the
  // JSON-encoded `filters` query parameters.
  const byLower = new Map(Object.keys(schemas).map((n) => [n.toLowerCase(), n]));
  for (const m of JSON.stringify(doc.paths).matchAll(/#model\/([a-z0-9_]+)/gi)) {
    const name = byLower.get(m[1]!.toLowerCase());
    if (name && !used.has(name)) {
      used.add(name);
      visit(schemas[name]);
    }
  }
  const kept = Object.fromEntries(Object.entries(schemas).filter(([name]) => used.has(name)));
  return { ...doc, components: { ...(doc.components as Json), schemas: kept } };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Json)
        .sort()
        .map((k) => [k, sortKeys((value as Json)[k])]),
    );
  }
  return value;
}

async function main(): Promise<void> {
  const { backend } = parseArgs(process.argv.slice(2));
  const backendVersion = JSON.parse(fs.readFileSync(path.join(backend, 'package.json'), 'utf8')).version;
  console.error(`[extract-openapi] backend ${backend} (v${backendVersion})`);

  const build = transpileBackend(backend);
  primeEnv(backend);

  const req = createRequire(path.join(build, 'src', 'index.js'));
  const { NestFactory } = req('@nestjs/core');
  const { VersioningType } = req('@nestjs/common');
  const { SwaggerModule, DocumentBuilder } = req('@nestjs/swagger');
  const { AppModule } = req('./app.module');

  const app = await NestFactory.create(AppModule, {
    preview: true,
    abortOnError: false,
    logger: ['error'],
  });
  // Mirrors config() in src/bootstrap-app.ts
  app.setGlobalPrefix(process.env.API_PREFIX, { exclude: ['/'] });
  app.enableVersioning({ type: VersioningType.URI });

  const raw = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Ferry Ticket API')
      .setDescription('API docs of Ferry Ticket')
      .setVersion('1.0')
      .addBearerAuth()
      .build(),
  ) as Json;

  const partner = sortKeys(
    pruneSchemas(applyPatches(normalise(filterByVisibility(raw, 'x-public'), backendVersion))),
  ) as Json;
  const pub = pruneSchemas(onlyAnonymous(partner));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'partner.json'), `${JSON.stringify(partner, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT_DIR, 'public.json'), `${JSON.stringify(pub, null, 2)}\n`);

  const count = (d: Json) =>
    Object.values(d.paths as Json).reduce<number>((n, item) => n + Object.keys(item as Json).length, 0);
  console.error(
    `[extract-openapi] wrote openapi/partner.json (${count(partner)} ops) and openapi/public.json (${count(pub)} ops)`,
  );
  fs.rmSync(build, { recursive: true, force: true });
  // Preview apps may hold timers from module-level code; exit explicitly.
  process.exit(0);
}

main().catch((err) => {
  console.error('[extract-openapi] failed:', err);
  process.exit(1);
});
