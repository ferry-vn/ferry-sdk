/**
 * Builds the `ferry` commander program. Dependencies are injected so tests
 * can run commands in-process with a mocked SDK fetch and temp config dir.
 */
import { SDK_VERSION } from '@ferryvn/sdk';
import { Command, CommanderError } from 'commander';
import { CliContext, type CliDeps, defaultDeps, EXIT, type GlobalOptions, reportError } from './cli-context.js';
import { registerAccountCommands } from './commands/account-commands.js';
import { registerAuthCommands } from './commands/auth-commands.js';
import { registerBookingCommands } from './commands/booking-commands.js';
import { registerSupplyCommands } from './commands/supply-commands.js';
import { registerUtilCommands } from './commands/util-commands.js';
import { CLI_VERSION } from './version.js';

export { CLI_VERSION };

export function buildProgram(deps: CliDeps): Command {
  const program = new Command('ferry')
    .description('FerryVN partner API from the command line — search voyages, seat maps, bookings, customers.')
    .version(`${CLI_VERSION} (sdk ${SDK_VERSION})`, '-v, --version')
    .option('--json', 'machine-readable JSON output (same as --output json)')
    .option('-o, --output <format>', 'table | json | ndjson | csv')
    .option('-p, --profile <name>', 'stored profile to use (env FERRY_PROFILE)')
    .option('--api-key <key>', 'API key (overrides FERRY_API_KEY and the profile; visible in shell history)')
    .option('--base-url <url>', 'API origin, e.g. http://localhost:3000 (env FERRY_BASE_URL)')
    .option('--env <name>', 'production | uat (env FERRY_ENV)')
    .option('--timeout <ms>', 'request timeout in milliseconds (env FERRY_TIMEOUT_MS)')
    .option('--debug', 'log HTTP requests to stderr, API key redacted (env FERRY_DEBUG=1)')
    .showHelpAfterError('(run with --help for usage)')
    .configureOutput({
      writeOut: (s) => deps.stdout.write(s),
      writeErr: (s) => deps.stderr.write(s),
    })
    .exitOverride();

  const getCtx = (cmd: Command) => new CliContext(deps, cmd.optsWithGlobals<GlobalOptions>());
  registerAuthCommands(program, getCtx);
  registerSupplyCommands(program, getCtx);
  registerBookingCommands(program, getCtx);
  registerAccountCommands(program, getCtx);
  registerUtilCommands(program, getCtx);

  // Sub-commands inherit output + exitOverride so errors never call process.exit in tests.
  const propagate = (cmd: Command) => {
    for (const sub of cmd.commands) {
      sub
        .configureOutput({ writeOut: (s) => deps.stdout.write(s), writeErr: (s) => deps.stderr.write(s) })
        .showHelpAfterError('(run with --help for usage)')
        .exitOverride();
      propagate(sub);
    }
  };
  propagate(program);

  program.addHelpText(
    'after',
    `
Auth:   ferry login  |  export FERRY_API_KEY=...  |  --api-key ...   (keys: FerryVN dashboard → API keys)
Examples:
  ferry locations phu
  ferry voyages search --from "Rạch Giá" --to "Phú Quốc" --date tomorrow
  ferry seats <voyageId>
  ferry customers --search 0901234567
  ferry booking draft --customer 1001 --orderer-name "Nguyễn Văn A" --email a@example.com \\
      --voyage <voyageId> --seats A1,A2 --passengers passengers.csv --out booking.json
  ferry booking create --file booking.json
  ferry booking list --status Requested,Booked --output csv > bookings.csv
Exit codes: 0 ok · 1 API/network error · 2 usage · 3 auth/permission · 4 not found · 5 rate limited`,
  );
  return program;
}

/** Run the CLI and resolve to a process exit code (never throws). */
export async function run(argv: string[], deps: CliDeps = defaultDeps()): Promise<number> {
  const program = buildProgram(deps);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return EXIT.ok;
  } catch (e) {
    if (e instanceof CommanderError) {
      // help/version print and "exit" with code 0; parse errors already printed.
      return e.exitCode === 0 || e.code === 'commander.helpDisplayed' || e.code === 'commander.version'
        ? EXIT.ok
        : EXIT.usage;
    }
    const json = argv.includes('--json') || /(^|\s)(-o|--output)[ =](json|ndjson|csv)\b/.test(argv.join(' '));
    return reportError({ err: (t) => deps.stderr.write(t.endsWith('\n') ? t : `${t}\n`), json, deps }, e);
  }
}
