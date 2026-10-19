/**
 * Credential + profile storage for `ferry login`.
 *
 * Location (per OS conventions):
 *   Linux   $XDG_CONFIG_HOME/ferry/config.json (default ~/.config/ferry/config.json)
 *   macOS   ~/Library/Application Support/ferry/config.json
 *   Windows %APPDATA%\ferry\config.json
 * Override with FERRY_CONFIG_DIR. The directory is created 0700 and the file
 * written 0600 (owner read/write only; on Windows the file inherits the ACL
 * of your profile directory).
 *
 * Profiles let one machine hold e.g. a production and a UAT key:
 *   { "currentProfile": "default", "profiles": { "default": {...}, "uat": {...} } }
 * The pre-1.0 flat shape `{ apiKey, baseUrl }` is read as the "default" profile.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ProfileConfig {
  apiKey?: string;
  /** `production` | `uat` */
  environment?: string;
  /** Explicit API origin; wins over `environment` within the same profile. */
  baseUrl?: string;
}

export interface StoredConfig {
  currentProfile?: string;
  profiles: Record<string, ProfileConfig>;
}

export const DEFAULT_PROFILE = 'default';

/** Bad profile name / unknown profile — reported as a usage error (exit 2). */
export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/;

export function assertProfileName(name: string): string {
  if (!PROFILE_NAME.test(name)) {
    throw new ProfileError(`invalid profile name "${name}" (letters, digits, "_", "-", "." — max 41 chars)`);
  }
  return name;
}

export function configDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.FERRY_CONFIG_DIR) return env.FERRY_CONFIG_DIR;
  const home = os.homedir();
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'ferry');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'ferry');
  // An empty or relative XDG_CONFIG_HOME must be ignored (spec) — it would put keys in the current directory.
  const xdg = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : undefined;
  return path.join(xdg ?? path.join(home, '.config'), 'ferry');
}

function normalize(raw: unknown): StoredConfig {
  if (!raw || typeof raw !== 'object') return { profiles: {} };
  const r = raw as Record<string, unknown>;
  if (r.profiles && typeof r.profiles === 'object') {
    return {
      ...(typeof r.currentProfile === 'string' ? { currentProfile: r.currentProfile } : {}),
      profiles: r.profiles as Record<string, ProfileConfig>,
    };
  }
  // Legacy 0.x flat file.
  const legacy: ProfileConfig = {};
  if (typeof r.apiKey === 'string') legacy.apiKey = r.apiKey;
  if (typeof r.baseUrl === 'string') legacy.baseUrl = r.baseUrl;
  return { profiles: Object.keys(legacy).length ? { [DEFAULT_PROFILE]: legacy } : {} };
}

export class ConfigStore {
  constructor(readonly dir: string) {}

  get file(): string {
    return path.join(this.dir, 'config.json');
  }

  read(): StoredConfig {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      // Only a missing file means "no profiles yet".
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: {} };
      throw new ProfileError(`cannot read ${this.file}: ${(e as Error).message}`);
    }
    try {
      return normalize(JSON.parse(text.replace(/^\uFEFF/, '')));
    } catch (e) {
      // Never treat a broken file as empty: the next save would wipe every profile.
      throw new ProfileError(`${this.file} is not valid JSON (${(e as Error).message}) — fix or delete it`);
    }
  }

  write(config: StoredConfig): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    // Enforce perms even if the file pre-existed with looser ones.
    fs.chmodSync(this.file, 0o600);
  }

  /** Name of the profile to use when none is given. */
  currentProfile(config: StoredConfig = this.read()): string {
    return config.currentProfile ?? DEFAULT_PROFILE;
  }

  listProfiles(config: StoredConfig = this.read()): string[] {
    return Object.keys(config.profiles);
  }

  getProfile(name: string, config: StoredConfig = this.read()): ProfileConfig | undefined {
    return config.profiles[name];
  }

  setProfile(name: string, profile: ProfileConfig, { makeCurrent = false } = {}): void {
    const config = this.read();
    config.profiles[assertProfileName(name)] = profile;
    if (makeCurrent) config.currentProfile = name;
    this.write(config);
  }

  /** Remove one profile; returns whether it existed. Deletes the file when nothing is left. */
  removeProfile(name: string): boolean {
    const config = this.read();
    if (!config.profiles[name]) return false;
    delete config.profiles[name];
    if (config.currentProfile === name) delete config.currentProfile;
    if (Object.keys(config.profiles).length === 0) {
      fs.rmSync(this.file, { force: true });
    } else {
      this.write(config);
    }
    return true;
  }

  useProfile(name: string): void {
    const config = this.read();
    if (!config.profiles[name])
      throw new ProfileError(`no profile named "${name}" (run \`ferry login --profile ${name}\`)`);
    config.currentProfile = name;
    this.write(config);
  }
}

/** Mask a key for display: keep the first 6 and last 4 characters. */
export function maskKey(key: string): string {
  if (key.length <= 12) return '*'.repeat(key.length);
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
