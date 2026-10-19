/**
 * `ferry login`, `ferry logout`, `ferry whoami`, `ferry profiles`.
 */
import { FERRY_ENVIRONMENTS } from '@ferryvn/sdk';
import type { Command } from 'commander';
import { type CliContext, UsageError } from '../cli-context.js';
import { assertProfileName, maskKey, type ProfileConfig } from '../config-store.js';

type GetCtx = (cmd: Command) => CliContext;

export function registerAuthCommands(program: Command, getCtx: GetCtx): void {
  program
    .command('login')
    .description('Verify and store a partner API key in a profile (file mode 0600)')
    .option('--api-key-stdin', 'read the key from stdin (e.g. `echo $KEY | ferry login --api-key-stdin`)')
    .option('--no-verify', 'save without checking the key against the API')
    .addHelpText(
      'after',
      `
The key comes from --api-key, --api-key-stdin or a hidden prompt. Use the
global --profile / --env / --base-url flags to save it to a named profile:
  ferry login --profile uat --env uat
Alternatively skip login entirely and export FERRY_API_KEY.`,
    )
    .action(async (opts: { apiKeyStdin?: boolean; verify: boolean }, cmd: Command) => {
      const ctx = getCtx(cmd);
      ctx.allowNewProfile = true;
      const profileName = assertProfileName(ctx.profileName);
      let key = ctx.opts.apiKey;
      if (!key && opts.apiKeyStdin) key = (await ctx.deps.readStdin()).trim();
      if (!key && ctx.deps.stdinIsTTY) key = await ctx.deps.readSecret('FerryVN API key: ');
      if (!key) throw new UsageError('no API key given (use --api-key, --api-key-stdin or an interactive terminal)');

      const endpoint = ctx.resolveEndpoint({ forLogin: true });
      let organization: string | undefined;
      if (opts.verify) {
        // A rejected key surfaces as the API error itself (exit 3, with a hint).
        const client = ctx.deps.createClient(ctx.clientOptions({ apiKey: key, baseUrl: endpoint.baseUrl }));
        const org = await client.organization.me();
        organization = org?.name;
      }
      const previous = ctx.deps.store.getProfile(profileName) ?? {};
      const profile: ProfileConfig = { ...previous, apiKey: key };
      // Remember where the key belongs when it was said explicitly (flag or FERRY_ENV / FERRY_BASE_URL).
      if (endpoint.source === 'flag' || endpoint.source === 'env') {
        delete profile.baseUrl;
        delete profile.environment;
        if (endpoint.environment) profile.environment = endpoint.environment;
        else profile.baseUrl = endpoint.baseUrl;
      }
      const store = ctx.deps.store;
      const makeCurrent = Object.keys(store.read().profiles).length === 0;
      store.setProfile(profileName, profile, { makeCurrent });
      const result = {
        saved: true,
        profile: profileName,
        organization,
        endpoint: endpoint.baseUrl,
        file: store.file,
        key: maskKey(key),
      };
      ctx.emit(result, () =>
        ctx.out(
          `Saved key ${maskKey(key)} to profile "${profileName}"${organization ? ` (${organization})` : ''} → ${store.file}`,
        ),
      );
    });

  program
    .command('logout')
    .description('Remove the stored API key of a profile (the current one by default)')
    .action((_opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const name = ctx.profileName;
      const removed = ctx.deps.store.removeProfile(name);
      ctx.emit({ removed, profile: name, file: ctx.deps.store.file }, () =>
        ctx.out(removed ? `Removed profile "${name}" from ${ctx.deps.store.file}` : `No profile "${name}".`),
      );
    });

  program
    .command('whoami')
    .description('Show the profile, endpoint and API key the CLI will use (add --check to call the API)')
    .option('--check', 'verify the key and show the organization')
    .action(async (opts: { check?: boolean }, cmd: Command) => {
      const ctx = getCtx(cmd);
      const { key, source } = ctx.resolveApiKey();
      const endpoint = ctx.resolveEndpoint();
      const info: Record<string, unknown> = {
        profile: ctx.profileName,
        baseUrl: endpoint.baseUrl,
        endpointSource: endpoint.source,
        apiKey: key ? maskKey(key) : null,
        apiKeySource: source,
        configFile: ctx.deps.store.file,
      };
      if (opts.check) {
        const org = await ctx.sdk().organization.me();
        info.organization = { id: org.id, name: org.name, slug: org.slug };
      }
      ctx.emit(info, () => {
        ctx.out(`Profile  : ${info.profile}`);
        ctx.out(`Endpoint : ${endpoint.baseUrl}  [${endpoint.source}]`);
        ctx.out(`API key  : ${info.apiKey ?? '(none)'}  [${source}]`);
        if (info.organization) {
          const o = info.organization as { name: string; slug: string };
          ctx.out(`Org      : ${o.name} (${o.slug})`);
        }
        ctx.out(`Config   : ${info.configFile}`);
      });
    });

  const profiles = program.command('profiles').description('List or switch stored profiles');
  profiles
    .command('list', { isDefault: true })
    .description('List stored profiles')
    .action((_opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      const config = ctx.deps.store.read();
      const current = ctx.deps.store.currentProfile(config);
      const rows = Object.entries(config.profiles).map(([name, p]) => ({
        name,
        current: name === current,
        endpoint: p.baseUrl ?? FERRY_ENVIRONMENTS[(p.environment ?? 'production') as keyof typeof FERRY_ENVIRONMENTS],
        apiKey: p.apiKey ? maskKey(p.apiKey) : null,
      }));
      ctx.emitList(rows, [
        { header: '', get: (r) => (r.current ? '*' : '') },
        { header: 'PROFILE', get: (r) => r.name },
        { header: 'ENDPOINT', get: (r) => r.endpoint },
        { header: 'API_KEY', get: (r) => r.apiKey },
      ]);
    });
  profiles
    .command('use')
    .description('Make a profile the default')
    .argument('<name>', 'profile name')
    .action((name: string, _opts: unknown, cmd: Command) => {
      const ctx = getCtx(cmd);
      ctx.deps.store.useProfile(name);
      ctx.emit({ currentProfile: name }, () => ctx.out(`Now using profile "${name}".`));
    });
}
