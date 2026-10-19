/**
 * Derive `openapi/sdk.json` — the API surface the published SDK is typed
 * against — from the full extracted document `openapi/partner.json`.
 *
 *  1. Keep only the operations an API key can actually call (verified against
 *     backend v3.2.16: AuthGuard('bearer-header') + Permify grants for the
 *     `api_key` relation; see docs in packages/sdk/README.md). Admin-power
 *     endpoints that keys can technically reach (organization settings, child
 *     org management, price-addition / voucher CRUD, …) are deliberately left
 *     out of the typed surface; `ferry.request()` still reaches them.
 *  2. Keep only the component schemas those operations reference (transitively).
 *  3. Apply response-shape corrections verified in the backend source, marked
 *     with `x-ferry-sdk-patch` so they are easy to audit and drop once the
 *     backend's Swagger decorators are fixed.
 *
 * Usage: npm run openapi:filter   (part of `npm run generate`)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Json = Record<string, unknown>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'openapi', 'partner.json');
const OUT = path.join(ROOT, 'openapi', 'sdk.json');

/** `METHOD path` of every operation in the SDK surface. */
export const SDK_OPERATIONS = [
  // Supply (locations/routes/operators are anonymous)
  'GET /api/v1/locations',
  'GET /api/v1/routes',
  'GET /api/v1/routes/{id}',
  'GET /api/v1/operators',
  'GET /api/v1/operators/nationals/{id}',
  'GET /api/v1/voyages/findAllRelateByLocationAndDate',
  'GET /api/v1/voyages/findAllRelateByLocationAndDateRange',
  'GET /api/v1/voyages/{id}',
  'GET /api/v1/voyage-counts',
  'GET /api/v1/boatLayouts/latestByVoyageId',
  'GET /api/v1/boatLayouts/byVoyageId',
  'GET /api/v1/boatLayouts/{id}',
  // Bookings & orders
  'POST /api/v1/bookings',
  'GET /api/v1/bookings',
  'GET /api/v1/bookings/{id}',
  'PATCH /api/v1/bookings/{id}',
  'POST /api/v1/bookings/confirmToIssue/{id}',
  'GET /api/v1/bookings/download-ticket/{id}',
  'GET /api/v1/bookings/public/{id}',
  'GET /api/v1/bookings/child-orgs/bookings',
  'GET /api/v1/orders',
  'GET /api/v1/orders/{id}',
  'POST /api/v1/cancel-ticket-request',
  'GET /api/v1/cancel-ticket-request',
  // Customers, organization, money (read-only)
  'POST /api/v1/customers',
  'GET /api/v1/customers',
  'GET /api/v1/customers/{id}',
  'PATCH /api/v1/customers/{id}',
  'GET /api/v1/organizations/me',
  'GET /api/v1/organizations/reservable-credit',
  'GET /api/v1/transactions',
  'GET /api/v1/transactions/{id}',
  'GET /api/v1/debt-ledger',
  // Vouchers & disruptions
  'GET /api/v1/vouchers',
  'GET /api/v1/vouchers/{id}',
  'POST /api/v1/vouchers/check-aplicability',
  'GET /api/v1/disruptions',
  'GET /api/v1/disruptions/{id}',
  'GET /api/v1/bookings/{id}/disruptions',
] as const;

/**
 * Response corrections (status code → JSON schema), verified in backend source.
 * Keys are `METHOD path`.
 */
export const RESPONSE_PATCHES: Record<string, { status: string; schema: Json; reason: string }> = {
  'GET /api/v1/organizations/reservable-credit': {
    status: '200',
    schema: { type: 'number', description: 'Credit (VND) the organization can still reserve from its parent chain.' },
    reason:
      'OrganizationsController.getReservableCredit returns a bare number (organizations.service.ts); the decorator claims OrganizationSettings',
  },
};

/**
 * Property corrections (`Schema.property` → JSON schema), verified in backend
 * source. `@ApiProperty({ nullable: true })` without a type renders as an empty
 * object schema (`Record<string, never>` in TypeScript) although the field is a
 * string at runtime; free-form objects get `additionalProperties`.
 */
const NULLABLE_STRING = { type: 'string', nullable: true };
const FREE_OBJECT = { type: 'object', additionalProperties: true };
export const SCHEMA_PATCHES: Record<string, { schema: Json; reason: string }> = {
  'PublicDisruptionDto.public_reason': { schema: NULLABLE_STRING, reason: 'public-disruption.dto.ts: string | null' },
  'PublicDisruptionDto.revised_departure_at': {
    schema: { ...NULLABLE_STRING, format: 'date-time' },
    reason: 'public-disruption.dto.ts: ISO string | null',
  },
  'PublicDisruptionDto.closed_at': {
    schema: { ...NULLABLE_STRING, format: 'date-time' },
    reason: 'public-disruption.dto.ts: ISO string | null',
  },
  'PublicDisruptionRouteDto.departure_name': {
    schema: NULLABLE_STRING,
    reason: 'public-disruption.dto.ts: string | null',
  },
  'PublicDisruptionRouteDto.destination_name': {
    schema: NULLABLE_STRING,
    reason: 'public-disruption.dto.ts: string | null',
  },
  'PublicDisruptionVoyageDto.boat_name': { schema: NULLABLE_STRING, reason: 'public-disruption.dto.ts: string | null' },
  'PublicDisruptionVoyageDto.operator_name': {
    schema: NULLABLE_STRING,
    reason: 'public-disruption.dto.ts: string | null',
  },
  'CancelTicketRequestOperatorRefund.operator_id': { schema: { type: 'string' }, reason: "Operator['id'] (string)" },
  'CancelTicketRequestOperatorRefund.operator_name': {
    schema: { type: 'string' },
    reason: "Operator['operator_name'] (string)",
  },
  'CancelTicketRequestOrganizationRelated.org_id': {
    schema: { type: 'string' },
    reason: "Organization['id'] (string)",
  },
  'OrganizationRelatedForOrder.org_id': { schema: { type: 'string' }, reason: "Organization['id'] (string)" },
  'Voucher.condition': { schema: FREE_OBJECT, reason: 'free-form condition object' },
  'TicketPriceAddition.condition': { schema: FREE_OBJECT, reason: 'free-form condition object' },
};

function applySchemaPatches(schemas: Record<string, Json>): void {
  for (const [key, patch] of Object.entries(SCHEMA_PATCHES)) {
    const [name, prop] = key.split('.') as [string, string];
    const props = schemas[name]?.properties as Record<string, Json> | undefined;
    if (!props?.[prop]) throw new Error(`schema patch target missing: ${key}`);
    const { description, example } = props[prop];
    props[prop] = {
      ...patch.schema,
      ...(description ? { description } : {}),
      ...(example !== undefined ? { example } : {}),
      'x-ferry-sdk-patch': patch.reason,
    };
  }
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

function collectRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectRefs(n, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node as Json)) {
    if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/')) {
      out.add(v.slice('#/components/schemas/'.length));
    } else {
      collectRefs(v, out);
    }
  }
}

export function filterSpec(doc: Json): Json {
  const paths = doc.paths as Record<string, Record<string, Json>>;
  const outPaths: Record<string, Record<string, Json>> = {};
  const missing: string[] = [];

  for (const op of SDK_OPERATIONS) {
    const [method, p] = op.split(' ') as [string, string];
    const operation = paths[p]?.[method.toLowerCase()];
    if (!operation) {
      missing.push(op);
      continue;
    }
    const copy = structuredClone(operation);
    const patch = RESPONSE_PATCHES[op];
    if (patch) {
      const responses = (copy.responses ?? {}) as Record<string, Json>;
      const existing = responses[patch.status] ?? { description: '' };
      responses[patch.status] = {
        ...existing,
        content: { 'application/json': { schema: patch.schema } },
        'x-ferry-sdk-patch': patch.reason,
      };
      copy.responses = responses;
    }
    outPaths[p] ??= {};
    outPaths[p][method.toLowerCase()] = copy;
  }
  if (missing.length) throw new Error(`operations missing from partner.json: ${missing.join(', ')}`);

  const schemas = (doc.components as Json).schemas as Record<string, Json>;
  const keep = new Set<string>();
  collectRefs(outPaths, keep);
  // Transitive closure over schema → schema references.
  for (let size = -1; size !== keep.size; ) {
    size = keep.size;
    for (const name of [...keep]) collectRefs(schemas[name], keep);
  }
  const outSchemas: Record<string, Json> = Object.fromEntries(
    [...keep].sort().map((n) => [n, structuredClone(schemas[n]) as Json]),
  );
  applySchemaPatches(outSchemas);

  const info = { ...(doc.info as Json), title: 'FerryVN partner API (SDK surface)' };
  return sortKeys({
    ...doc,
    info,
    paths: outPaths,
    components: { ...(doc.components as Json), schemas: outSchemas },
    tags: undefined,
  }) as Json;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const doc = JSON.parse(fs.readFileSync(SRC, 'utf8')) as Json;
  const out = filterSpec(doc);
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  const ops = Object.values(out.paths as Json).reduce<number>((n, m) => n + Object.keys(m as Json).length, 0);
  const schemaCount = Object.keys(((out.components as Json).schemas as Json) ?? {}).length;
  console.log(`openapi/sdk.json: ${ops} operations, ${schemaCount} schemas`);
}
