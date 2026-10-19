/**
 * Utility commands: `ferry api` (raw requests), `ferry doctor`, `ferry completion`.
 */
import { FerryError, SDK_VERSION } from '@ferryvn/sdk';
import type { Command } from 'commander';
import { type CliContext, EXIT, SilentExit, UsageError } from '../cli-context.js';
import { maskKey } from '../config-store.js';
import { printJson } from '../output.js';
import { CLI_VERSION } from '../version.js';

type GetCtx = (cmd: Command) => CliContext;

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

export function registerUtilCommands(program: Command, getCtx: GetCtx): void {
  program
    .command('api')
    .description('Call any API path with your credentials (like `gh api`) and print the JSON response')
    .argument('<method>', METHODS.join(' | '))
    .argument('<path>', 'path such as /api/v1/bookings (the /api/v1 prefix is added when missing)')
    .option('-q, --query <key=value...>', 'query parameters (values that look like JSON are sent as-is)')
    .option('-d, --data <json|@file|->', 'JSON request body, @path to a file, or - for stdin')
    .option('--anonymous', 'do not send the API key')
    .option('-y, --yes', 'confirm a write (POST/PATCH/PUT/DELETE) without the interactive prompt')
    .addHelpText(
      'after',
      `
Examples:
  ferry api GET /bookings -q limit=5 -q 'filters={"booking_statuses":[10]}'
  ferry api GET /api/v1/ticket-price-additions
  ferry api POST /vouchers/check-aplicability -d @check.json
Writes (POST/PATCH/PUT/DELETE) act on real data — there is no undo.`,
    )
    .action(
      async (
        method: string,
        rawPath: string,
        opts: { query?: string[]; data?: string; anonymous?: boolean; yes?: boolean },
        cmd: Command,
      ) => {
        const ctx = getCtx(cmd);
        const m = method.toUpperCase();
        if (!(METHODS as readonly string[]).includes(m))
          throw new UsageError(`<method> must be one of ${METHODS.join(', ')}`);
        const path = rawPath.startsWith('/api/') ? rawPath : `/api/v1/${rawPath.replace(/^\/+/, '')}`;
        const query: Record<string, string> = {};
        for (const pair of opts.query ?? []) {
          const i = pair.indexOf('=');
          if (i <= 0) throw new UsageError(`--query expects key=value (got "${pair}")`);
          query[pair.slice(0, i)] = pair.slice(i + 1);
        }
        let body: unknown;
        if (opts.data !== undefined) {
          const raw =
            opts.data === '-'
              ? await ctx.deps.readStdin()
              : opts.data.startsWith('@')
                ? ctx.deps.readFile(opts.data.slice(1))
                : opts.data;
          try {
            body = JSON.parse(raw);
          } catch (e) {
            throw new UsageError(`--data is not valid JSON: ${(e as Error).message}`);
          }
        }
        if (m !== 'GET') {
          // Raw writes can reach money-moving endpoints (e.g. bookings/confirmToIssue).
          await ctx.confirm({
            yes: opts.yes,
            expected: m,
            message: `${m} ${path} acts on real data and cannot be undone.`,
            flagHint: '--yes',
          });
        }
        const client = opts.anonymous ? ctx.deps.createClient(ctx.clientOptions({ apiKey: undefined })) : ctx.sdk();
        const res = await client.request({ method: m as (typeof METHODS)[number], path, query, body });
        printJson(ctx.deps.stdout, res ?? null);
      },
    );

  program
    .command('doctor')
    .description('Check configuration, connectivity and the API key')
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      type Check = { check: string; ok: boolean; detail: string };
      const checks: Check[] = [];
      const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });

      const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
      const nodeOk = major > 22 || (major === 22 && minor >= 12);
      add('node', nodeOk, `v${process.versions.node}${nodeOk ? '' : ' (need >= 22.12)'}`);
      add('versions', true, `cli ${CLI_VERSION}, sdk ${SDK_VERSION}`);
      const endpoint = ctx.resolveEndpoint();
      add('profile', true, `${ctx.profileName} — ${ctx.deps.store.file}`);
      add('endpoint', true, `${endpoint.baseUrl} [${endpoint.source}]`);
      const { key, source } = ctx.resolveApiKey();
      add(
        'api key',
        Boolean(key),
        key ? `${maskKey(key)} [${source}]` : 'missing — run `ferry login` or set FERRY_API_KEY',
      );

      const client = ctx.deps.createClient(ctx.clientOptions());
      const t0 = Date.now();
      try {
        const locations = await client.locations.list();
        add('connectivity', true, `GET /locations → ${locations.length} locations in ${Date.now() - t0} ms`);
      } catch (e) {
        add('connectivity', false, e instanceof Error ? e.message : String(e));
      }
      if (key) {
        try {
          const org = await client.organization.me();
          add('authentication', true, `organization ${org.name} (${org.slug})`);
        } catch (e) {
          add('authentication', false, e instanceof FerryError ? e.message : String(e));
        }
      }
      const failed = checks.filter((c) => !c.ok).length;
      ctx.emit({ ok: failed === 0, checks }, () => {
        for (const c of checks) ctx.out(`${c.ok ? '✔' : '✘'} ${c.check.padEnd(15)} ${c.detail}`);
        ctx.out(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
      });
      if (failed) throw new SilentExit(EXIT.error);
    });

  program
    .command('completion')
    .description('Print a shell completion script (bash or zsh)')
    .argument('<shell>', 'bash | zsh')
    .addHelpText(
      'after',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal zsh syntax shown to the user
      '\n  bash: ferry completion bash >> ~/.bashrc\n  zsh:  ferry completion zsh > "${fpath[1]}/_ferry"',
    )
    .action((shell: string, _opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const tree = commandTree(program);
      // Global options that take a value: their value must not count as a command word.
      const valued = program.options
        .filter((o) => o.required || o.optional)
        .flatMap((o) => [o.short, o.long])
        .filter((x): x is string => Boolean(x));
      if (shell === 'bash') ctx.out(bashCompletion(tree, valued));
      else if (shell === 'zsh') ctx.out(zshCompletion(tree, valued));
      else throw new UsageError('<shell> must be bash or zsh');
    });
}

interface Node {
  name: string;
  subcommands: string[];
  options: string[];
}

function commandTree(program: Command): Node[] {
  const globals = program.options.map((o) => o.long).filter((x): x is string => Boolean(x));
  const nodes: Node[] = [{ name: '', subcommands: program.commands.map((c) => c.name()), options: globals }];
  for (const c of program.commands) {
    nodes.push({
      name: c.name(),
      subcommands: c.commands.map((s) => s.name()),
      options: [...c.options.map((o) => o.long).filter((x): x is string => Boolean(x)), ...globals],
    });
    for (const s of c.commands) {
      nodes.push({
        name: `${c.name()} ${s.name()}`,
        subcommands: [],
        options: [...s.options.map((o) => o.long).filter((x): x is string => Boolean(x)), ...globals],
      });
    }
  }
  return nodes;
}

function bashCompletion(nodes: Node[], valued: string[]): string {
  const cases = nodes.map((n) => `    "${n.name}") opts="${[...n.subcommands, ...n.options].join(' ')}" ;;`).join('\n');
  return `# ferry bash completion (generated by \`ferry completion bash\`)
_ferry() {
  local cur words key opts skip=0
  cur="\${COMP_WORDS[COMP_CWORD]}"
  words=()
  for w in "\${COMP_WORDS[@]:1:COMP_CWORD-1}"; do
    if (( skip )); then skip=0; continue; fi
    case "$w" in ${valued.join('|')}) skip=1; continue ;; esac
    [[ $w != -* ]] && words+=("$w")
  done
  key="\${words[*]:0:2}"
  case "$key" in
${cases}
    *) key="\${words[0]}"; case "$key" in
${cases.replace(/^/gm, '  ')}
      *) opts="" ;;
    esac ;;
  esac
  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _ferry ferry`;
}

function zshCompletion(nodes: Node[], valued: string[]): string {
  return `#compdef ferry
# ferry zsh completion (generated by \`ferry completion zsh\`)
autoload -U +X bashcompinit && bashcompinit
${bashCompletion(nodes, valued)}`;
}
