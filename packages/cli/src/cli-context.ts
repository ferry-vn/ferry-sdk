/**
 * Shared CLI plumbing: injected dependencies (for tests), global options,
 * profile + endpoint resolution, client construction, output and error reporting.
 */
import fs from 'node:fs';
import readline from 'node:readline/promises';
import {
  FERRY_ENVIRONMENTS,
  FerryApiError,
  FerryAuthError,
  FerryClient,
  type FerryClientOptions,
  FerryConfigError,
  type FerryEnvironment,
  FerryError,
  FerryNotFoundError,
  FerryPermissionError,
  FerryRateLimitError,
  type Location,
} from '@ferryvn/sdk';
import { ConfigStore, configDir, type ProfileConfig, ProfileError } from './config-store.js';
import {
  type Column,
  OUTPUT_FORMATS,
  type OutputFormat,
  printJson,
  printTable,
  renderCsv,
  type Writer,
} from './output.js';
import { CLI_VERSION } from './version.js';

export interface CliDeps {
  stdout: Writer;
  stderr: Writer;
  env: NodeJS.ProcessEnv;
  store: ConfigStore;
  createClient: (opts: FerryClientOptions) => FerryClient;
  readFile: (path: string) => string;
  writeFile: (path: string, data: string) => void;
  readStdin: () => Promise<string>;
  /** Prompt for a secret without echoing it (TTY only). */
  readSecret: (prompt: string) => Promise<string>;
  /** Ask a question on the terminal (TTY only). */
  prompt: (question: string) => Promise<string>;
  stdinIsTTY: boolean;
}

export interface GlobalOptions {
  json?: boolean;
  output?: string;
  profile?: string;
  apiKey?: string;
  baseUrl?: string;
  env?: string;
  timeout?: string;
  debug?: boolean;
}

/** Process exit codes (documented in the CLI README). */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  rateLimited: 5,
} as const;

/** Exit with `code` without printing anything more (the command already reported). */
export class SilentExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = 'SilentExit';
  }
}

/** Thrown for user mistakes; exit code 2, no stack trace. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function defaultDeps(): CliDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    store: new ConfigStore(configDir()),
    createClient: (opts) => new FerryClient(opts),
    // Strip a UTF-8 BOM (PowerShell, Notepad and Excel "CSV UTF-8" add one).
    readFile: (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''),
    writeFile: (p, data) => fs.writeFileSync(p, data),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    readSecret: readSecretFromTty,
    prompt: async (question) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
    stdinIsTTY: Boolean(process.stdin.isTTY),
  };
}

/** Minimal masked prompt: raw-mode stdin, echoes nothing, Enter to finish, Ctrl-C aborts. */
function readSecretFromTty(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value.trim());
          return;
        }
        if (c === '\u0003') {
          cleanup();
          reject(new UsageError('aborted'));
          return;
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

export type Source = 'flag' | 'env' | 'profile' | 'default' | 'none';

export interface ResolvedEndpoint {
  baseUrl: string;
  source: Source;
  environment?: FerryEnvironment;
}

function asEnvironment(value: string | undefined, what: string): FerryEnvironment | undefined {
  if (value === undefined || value === '') return undefined;
  if (value in FERRY_ENVIRONMENTS) return value as FerryEnvironment;
  throw new UsageError(`${what} must be one of ${Object.keys(FERRY_ENVIRONMENTS).join(', ')} (got "${value}")`);
}

export class CliContext {
  private client: FerryClient | undefined;
  private warnedEndpoint = false;
  /** `login` may name a profile that does not exist yet. */
  allowNewProfile = false;
  readonly format: OutputFormat;

  constructor(
    readonly deps: CliDeps,
    readonly opts: GlobalOptions,
  ) {
    // Validate before any command runs: a bad value must never surface after a write succeeded.
    const f = (opts.json ? 'json' : (opts.output ?? 'table').toLowerCase()) as OutputFormat;
    if (!OUTPUT_FORMATS.includes(f)) throw new UsageError(`--output must be one of ${OUTPUT_FORMATS.join(', ')}`);
    this.format = f;
  }

  /** Whether the output is machine-readable (anything but a table). */
  get json(): boolean {
    return this.format !== 'table';
  }

  /** Profile named explicitly with --profile or FERRY_PROFILE (not the stored current one). */
  get explicitProfile(): string | undefined {
    return this.opts.profile ?? (this.deps.env.FERRY_PROFILE || undefined);
  }

  /** Profile in use: --profile > FERRY_PROFILE > stored current profile > "default". */
  get profileName(): string {
    return this.explicitProfile ?? this.deps.store.currentProfile();
  }

  get profile(): ProfileConfig {
    const stored = this.deps.store.getProfile(this.profileName);
    if (!stored && this.explicitProfile && !this.allowNewProfile) {
      const known = this.deps.store.listProfiles().join(', ') || 'none — run `ferry login --profile <name>`';
      throw new UsageError(`unknown profile "${this.profileName}" (profiles: ${known})`);
    }
    return stored ?? {};
  }

  /**
   * API key: --api-key > (an explicitly chosen profile's key) > FERRY_API_KEY > profile.
   * An explicit profile wins over FERRY_API_KEY so its key never travels to another
   * profile's endpoint.
   */
  resolveApiKey(): { key: string | undefined; source: Source } {
    if (this.opts.apiKey) return { key: this.opts.apiKey, source: 'flag' };
    if (this.explicitProfile) {
      const stored = this.profile.apiKey;
      return stored ? { key: stored, source: 'profile' } : { key: undefined, source: 'none' };
    }
    if (this.deps.env.FERRY_API_KEY) return { key: this.deps.env.FERRY_API_KEY, source: 'env' };
    const stored = this.profile.apiKey;
    if (stored) return { key: stored, source: 'profile' };
    return { key: undefined, source: 'none' };
  }

  /**
   * Endpoint, kept with the key it belongs to: flags (--base-url | --env) always
   * win; a key from FERRY_API_KEY uses FERRY_BASE_URL / FERRY_ENV; a key from a
   * profile uses that profile's endpoint (FERRY_ENV is ignored, with a warning,
   * so a production key is never sent to UAT or the other way round).
   */
  resolveEndpoint(options: { forLogin?: boolean } = {}): ResolvedEndpoint {
    const keySource = this.resolveApiKey().source;
    const envLayer: [Source, string | undefined, string | undefined, string] = [
      'env',
      this.deps.env.FERRY_BASE_URL || undefined,
      this.deps.env.FERRY_ENV || undefined,
      'FERRY_ENV',
    ];
    const profileLayer: [Source, string | undefined, string | undefined, string] = [
      'profile',
      this.profile.baseUrl,
      this.profile.environment,
      `profile "${this.profileName}" environment`,
    ];
    // `login` saves a new key: FERRY_ENV / FERRY_BASE_URL then say where it belongs.
    const useEnv =
      options.forLogin ||
      keySource === 'env' ||
      keySource === 'flag' ||
      (keySource === 'none' && !this.explicitProfile);
    if (!useEnv && (envLayer[1] || envLayer[2]) && !this.opts.baseUrl && !this.opts.env && !this.warnedEndpoint) {
      this.warnedEndpoint = true;
      this.err(
        `warning: FERRY_ENV/FERRY_BASE_URL ignored — the API key comes from profile "${this.profileName}", which uses its own endpoint (pass --env to override)`,
      );
    }
    const layers: Array<[Source, string | undefined, string | undefined, string]> = [
      ['flag', this.opts.baseUrl, this.opts.env, '--env'],
      ...(useEnv ? [envLayer, profileLayer] : [profileLayer]),
    ];
    for (const [source, baseUrl, env, label] of layers) {
      if (baseUrl) return { baseUrl, source };
      const environment = asEnvironment(env, label);
      if (environment) return { baseUrl: FERRY_ENVIRONMENTS[environment], source, environment };
    }
    return { baseUrl: FERRY_ENVIRONMENTS.production, source: 'default', environment: 'production' };
  }

  clientOptions(overrides: Partial<FerryClientOptions> = {}): FerryClientOptions {
    const timeoutRaw = this.opts.timeout ?? this.deps.env.FERRY_TIMEOUT_MS;
    const timeout = timeoutRaw ? Number(timeoutRaw) : undefined;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
      throw new UsageError('--timeout / FERRY_TIMEOUT_MS must be a positive number of milliseconds');
    }
    const debug = this.opts.debug || this.deps.env.FERRY_DEBUG === '1';
    return {
      apiKey: this.resolveApiKey().key,
      baseUrl: this.resolveEndpoint().baseUrl,
      timeoutMs: timeout,
      language: this.deps.env.FERRY_LANG || undefined,
      userAgent: `ferryvn-cli/${CLI_VERSION}`,
      ...(debug
        ? {
            debug: (message: string, details: Record<string, unknown>) =>
              this.deps.stderr.write(`[debug] ${message} ${JSON.stringify(details)}\n`),
          }
        : {}),
      ...overrides,
    };
  }

  /** SDK client; `requireKey` fails fast with a helpful message when no key is configured. */
  sdk(requireKey = true): FerryClient {
    if (requireKey && !this.resolveApiKey().key) {
      throw new UsageError(
        'No API key. Run `ferry login`, set FERRY_API_KEY, or pass --api-key (create keys in the FerryVN dashboard).',
      );
    }
    this.client ??= this.deps.createClient(this.clientOptions());
    return this.client;
  }

  out(text: string): void {
    this.deps.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  err(text: string): void {
    this.deps.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  /** Single object: pretty JSON for json, one compact line for ndjson/csv, otherwise the human renderer. */
  emit(data: unknown, human: () => void): void {
    if (this.format === 'table') human();
    else if (this.format === 'json') printJson(this.deps.stdout, data);
    else this.deps.stdout.write(`${JSON.stringify(data)}\n`);
  }

  /**
   * A list of rows: table (with footer), JSON (`data` + `next_cursor` when paginated),
   * NDJSON (one raw object per line) or CSV (the table's columns).
   */
  emitList<T>(
    rows: readonly T[],
    columns: readonly Column<T>[],
    meta: { nextCursor?: string | null; footer?: string; jsonValue?: unknown } = {},
  ): void {
    switch (this.format) {
      case 'json':
        printJson(
          this.deps.stdout,
          meta.jsonValue ?? (meta.nextCursor !== undefined ? { data: rows, next_cursor: meta.nextCursor } : rows),
        );
        return;
      case 'ndjson':
        for (const r of rows) this.deps.stdout.write(`${JSON.stringify(r)}\n`);
        return;
      case 'csv':
        this.deps.stdout.write(renderCsv(rows, columns));
        return;
      default: {
        const footer = [meta.footer, meta.nextCursor ? `next page: --cursor ${meta.nextCursor}` : '']
          .filter(Boolean)
          .join('\n');
        printTable(this.deps.stdout, rows, columns, footer || undefined);
      }
    }
  }

  /** Resolve a location id from an id, abbreviation or accent-insensitive name. */
  async resolveLocation(query: string, label: string): Promise<Location> {
    const matches = await this.sdk(false).locations.find(query);
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) {
      throw new UsageError(`${label}: no location matches "${query}" (try \`ferry locations\`)`);
    }
    const names = matches.map((l) => `${l.location_name} (${l.abbreviation}, ${l.id})`).join(', ');
    throw new UsageError(`${label}: "${query}" is ambiguous — ${names}`);
  }

  /**
   * Confirm a dangerous action: `--yes` passes; on a TTY the user must type
   * `expected`; otherwise it is a usage error.
   */
  async confirm(opts: { yes?: boolean; expected: string; message: string; flagHint: string }): Promise<void> {
    if (opts.yes) return;
    if (!this.deps.stdinIsTTY || this.json) {
      throw new UsageError(`${opts.message} Re-run with ${opts.flagHint} to confirm.`);
    }
    this.err(opts.message);
    const answer = await this.deps.prompt(`Type "${opts.expected}" to confirm: `);
    if (answer !== opts.expected) throw new UsageError('not confirmed — nothing was done');
  }
}

/** Render any error for the terminal and return the process exit code. */
export function reportError(ctx: { err(t: string): void; json: boolean; deps: CliDeps }, e: unknown): number {
  if (e instanceof SilentExit) return e.code;
  if (e instanceof UsageError || e instanceof ProfileError || e instanceof FerryConfigError) {
    if (ctx.json) printJson(ctx.deps.stderr, { error: 'UsageError', message: e.message });
    else ctx.err(`error: ${e.message}`);
    return EXIT.usage;
  }
  if (e instanceof FerryApiError) {
    if (ctx.json) {
      printJson(ctx.deps.stderr, { error: e.name, ...e.toJSON() });
    } else {
      const code = e.errorCode !== undefined ? ` errorCode=${e.errorCode}` : '';
      ctx.err(`error: HTTP ${e.status}${code} — ${e.message}`);
      if (e.fieldErrors) ctx.err(JSON.stringify(e.fieldErrors, null, 2));
      if (e.status === 401) ctx.err('hint: the API key was rejected — run `ferry login` again.');
      if (e.status === 403) {
        ctx.err(
          'hint: FerryVN answers 403 both for ids that belong to another organization (or do not exist) and for permissions your key lacks.',
        );
      }
      if (e.fieldErrors?.boatLayout === 'CanNotGetBoatVoyage') {
        ctx.err(
          "hint: the operator's live seat map could not be fetched right now — retry later or pick another voyage (bookings need a seat map).",
        );
      }
      if (e.fieldErrors?.['voyage.id'] === 'CannotFindBoatLayoutFromVoyage') {
        ctx.err(
          'hint: FerryVN has no stored seat map for this voyage yet — run `ferry seats <voyageId>` once (it fetches and stores it), then retry.',
        );
      }
      if (e.fieldErrors?.voyage === 'VoyageIsDisabled') {
        ctx.err(
          'hint: the operator disabled this voyage — it cannot be sold. `ferry seats <voyageId> --stored` still shows its stored seat map.',
        );
      }
      if (e instanceof FerryRateLimitError && e.retryAfterMs)
        ctx.err(`hint: retry in ${Math.ceil(e.retryAfterMs / 1000)} s.`);
      if (e.requestId) ctx.err(`request id: ${e.requestId}`);
    }
    if (e instanceof FerryAuthError || e instanceof FerryPermissionError) return EXIT.auth;
    if (e instanceof FerryNotFoundError) return EXIT.notFound;
    if (e instanceof FerryRateLimitError) return EXIT.rateLimited;
    return EXIT.error;
  }
  if (e instanceof FerryError) {
    if (ctx.json) printJson(ctx.deps.stderr, { error: e.name, message: e.message });
    else ctx.err(`error: ${e.message}`);
    return EXIT.error;
  }
  // Missing or unreadable input files are the caller's mistake (exit 2), not an API failure.
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'EISDIR' || code === 'EACCES') {
    const message = e instanceof Error ? e.message : String(e);
    if (ctx.json) printJson(ctx.deps.stderr, { error: 'UsageError', message });
    else ctx.err(`error: ${message}`);
    return EXIT.usage;
  }
  if (ctx.json) printJson(ctx.deps.stderr, { error: 'Error', message: e instanceof Error ? e.message : String(e) });
  else ctx.err(`error: ${e instanceof Error ? e.message : String(e)}`);
  return EXIT.error;
}
