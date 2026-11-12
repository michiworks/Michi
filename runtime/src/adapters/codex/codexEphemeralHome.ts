import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * An ephemeral session's own Codex home (DESIGN-v2 §2.4, §3.2; probe P3).
 * Each ephemeral session (a Companion check-in) runs its own app-server on a
 * new CODEX_HOME holding only a link to the user's auth.json and a
 * config.toml with the model and provider keys of the user's effective
 * config. The user's notify, hooks.json, memories, plugins and history live
 * in the user's home, which that app-server never reads (P3: the user's
 * notify fires after every turn in the user's home, ephemeral threads
 * included, and never from a scratch home). Discarding the session removes
 * the home, and everything Codex wrote there (logs, state databases).
 */

/**
 * `app-server` overrides of an ephemeral session's app-server, after
 * `-c mcp_servers={}`: no notify, hooks, memories, plugins or apps (whose
 * catalog sync downloads into the home), no shell snapshot (codex 0.156.1
 * has `shell_snapshot` on by default: for a new thread it runs the user's
 * login shell, which sources the rc files of the real HOME, and writes
 * `shell_snapshots/` into the home; P3 saw it on the scratch home), no
 * history file, no telemetry export, analytics or feedback. Codex 0.156.1
 * accepts each (P3, P3b).
 */
export const CODEX_EPHEMERAL_APP_SERVER_ARGS: readonly string[] = Object.freeze([
  '-c', 'notify=[]',
  '-c', 'features.hooks=false',
  '-c', 'features.memories=false',
  '-c', 'features.plugins=false',
  '-c', 'features.apps=false',
  '-c', 'features.shell_snapshot=false',
  '-c', 'features.shell_snapshot_v2=false',
  '-c', 'history.persistence="none"',
  '-c', 'otel.exporter="none"',
  '-c', 'otel.log_user_prompt=false',
  '-c', 'analytics.enabled=false',
  '-c', 'feedback.enabled=false',
]);

/** Top-level keys of the user's effective config an ephemeral home keeps: the model and how Codex signs in. */
const TOP_LEVEL_KEYS = ['model', 'model_provider', 'forced_login_method', 'forced_chatgpt_workspace_id',
  'cli_auth_credentials_store', 'chatgpt_base_url'] as const;

/**
 * Keys of the selected model provider an ephemeral home keeps: how to reach
 * it, nothing it may run or load. A literal bearer token is not copied.
 */
const PROVIDER_KEYS = ['name', 'base_url', 'env_key', 'env_key_instructions', 'wire_api', 'query_params',
  'http_headers', 'env_http_headers', 'requires_openai_auth', 'request_max_retries', 'stream_max_retries',
  'stream_idle_timeout_ms', 'supports_websockets'] as const;

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

/** A TOML value for the shapes provider keys take; undefined for anything else, which is left out. */
function tomlValue(value: unknown): string | undefined {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (Array.isArray(value)) {
    const items = value.map(tomlValue);
    return items.every((item): item is string => item !== undefined) ? `[${items.join(', ')}]` : undefined;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, tomlValue(item)] as const);
    if (!entries.every(([, item]) => item !== undefined)) return undefined;
    return `{ ${entries.map(([key, item]) => `${tomlKey(key)} = ${item}`).join(', ')} }`;
  }
  return undefined;
}

/**
 * The config.toml of an ephemeral home, from the main app-server's
 * `config/read` answer (the user's effective config): the model, the sign-in
 * keys and the selected provider's connection keys, nothing else (no
 * notify, hooks, MCP servers, plugins, projects or features).
 */
export function codexEphemeralConfigToml(read: unknown): string {
  const config = (read as { config?: unknown } | null | undefined)?.config;
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config as Record<string, unknown> : {};
  const lines: string[] = ['# Written by Michi for one ephemeral session; removed with it.'];
  for (const key of TOP_LEVEL_KEYS) {
    const value = tomlValue(source[key]);
    if (value !== undefined) lines.push(`${key} = ${value}`);
  }
  const providerId = typeof source.model_provider === 'string' ? source.model_provider : undefined;
  const providers = source.model_providers;
  const provider = providerId && providers && typeof providers === 'object' && !Array.isArray(providers)
    ? (providers as Record<string, unknown>)[providerId] : undefined;
  if (providerId && provider && typeof provider === 'object' && !Array.isArray(provider)) {
    const keep = PROVIDER_KEYS.flatMap((key) => {
      const value = tomlValue((provider as Record<string, unknown>)[key]);
      return value === undefined ? [] : [`${key} = ${value}`];
    });
    if (keep.length) lines.push('', `[model_providers.${tomlKey(providerId)}]`, ...keep);
  }
  return `${lines.join('\n')}\n`;
}

/** The home of one ephemeral session: `<root>/<hash of its public id>`, a name no id can steer. */
export function codexEphemeralHomeDir(root: string, sessionId: string): string {
  return path.join(path.resolve(root), createHash('sha256').update(sessionId).digest('hex').slice(0, 32));
}

/**
 * A new home for `sessionId` under `root` (whatever was there is removed
 * first): auth.json linked from `codexHome` (the user's, ~/.codex when
 * unset), config.toml written from `configToml`. Returns its path.
 */
export function prepareCodexEphemeralHome(input: { root: string; sessionId: string; codexHome?: string; configToml: string }): string {
  const home = codexEphemeralHomeDir(input.root, input.sessionId);
  fs.mkdirSync(path.resolve(input.root), { recursive: true, mode: 0o700 });
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { mode: 0o700 });
  shareCodexAuthFile(input.codexHome || path.join(os.homedir(), '.codex'), home);
  fs.writeFileSync(path.join(home, 'config.toml'), input.configToml, { mode: 0o600 });
  return home;
}

/** Removes `sessionId`'s home under `root`; whether there was one. */
export function removeCodexEphemeralHome(root: string, sessionId: string): boolean {
  const home = codexEphemeralHomeDir(root, sessionId);
  if (!fs.existsSync(home)) return false;
  fs.rmSync(home, { recursive: true, force: true });
  return true;
}

/** Links `sourceHome`'s auth.json into `isolatedHome` (a copy on Windows); nothing when there is none. */
function shareCodexAuthFile(sourceHome: string, isolatedHome: string): void {
  const sourceAuth = path.join(path.resolve(sourceHome), 'auth.json');
  const isolatedAuth = path.join(isolatedHome, 'auth.json');
  if (!fs.existsSync(sourceAuth) || path.resolve(sourceAuth) === path.resolve(isolatedAuth)) {
    return;
  }

  if (process.platform === 'win32') {
    fs.copyFileSync(sourceAuth, isolatedAuth);
    return;
  }

  try {
    const current = fs.lstatSync(isolatedAuth);
    if (current.isSymbolicLink() && fs.readlinkSync(isolatedAuth) === sourceAuth) return;
    fs.unlinkSync(isolatedAuth);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.symlinkSync(sourceAuth, isolatedAuth);
}
