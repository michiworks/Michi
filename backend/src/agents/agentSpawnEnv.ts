/**
 * The environment of the processes Michi starts for its agents: the agent
 * CLIs (Claude, Kiro and its Meta agent, Codex), the Crew adapter, agy, Pi's
 * bash and the external MCP servers Pi connects to. Desktop and cloud are two
 * policies of one module, so they cannot drift apart again.
 */

import { getUserSandboxRoot } from '../services/workspaceSandbox';

/**
 * The only MICHI_* variables an agent process gets: the Crew adapter reads
 * these four itself, to find its App, the agent and memory mode of new slots,
 * and the lease directory it shares with the App's relay
 * (runtime/src/adapters/crew/acp/main.ts, crewMcpBinding.ts). No other process
 * Michi starts reads a MICHI_* variable. Every other one configures this
 * backend (its data, config and log directories, its remote token and
 * exposure, its cloud secrets, the settings it reads itself), and a Michi or
 * test run in an agent's shell would act on it as the live backend. So the
 * rest stays here, and so does any MICHI_* added later.
 */
export const AGENT_MICHI_ENV: readonly string[] = Object.freeze([
  'MICHI_CREW_APP', 'MICHI_CREW_AGENT', 'MICHI_CREW_MEMORY_MODE', 'MICHI_CREW_MCP_DIR',
]);

/**
 * This backend's own variables outside MICHI_*: PORT, the port it listens on,
 * which a server started in an agent's shell would try to bind (bin/michi's
 * remote control unsets it too), and BETTER_AUTH_SECRET, which signs cloud
 * mode's session cookies. selfUpdate.ts keeps its own list for the updater's
 * build: that one keeps MICHI_DATA_DIR, where bin/michi installs, and drops
 * NODE_ENV of any value and systemd's service variables.
 */
export const BACKEND_ENV: readonly string[] = Object.freeze(['PORT', 'BETTER_AUTH_SECRET']);

const AGENT_MICHI = new Set(AGENT_MICHI_ENV);
const BACKEND = new Set(BACKEND_ENV);

/**
 * `base` less every MICHI_* outside AGENT_MICHI_ENV, less BACKEND_ENV, and
 * less a production NODE_ENV (the backend's own; inherited, it loads React's
 * production build in an agent's test run). The rest, credentials included,
 * is kept: the CLIs sign in with it. A new object, read when called. Names
 * compare in upper case, as Windows does.
 */
export function agentSpawnEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const name = key.toUpperCase();
    if (name.startsWith('MICHI_') ? !AGENT_MICHI.has(name) : BACKEND.has(name)) continue;
    if (name === 'NODE_ENV' && value === 'production') continue;
    env[key] = value;
  }
  return env;
}

/**
 * Cloud mode's explicit allowlist for one owner's process: PATH, LANG and
 * NODE_NO_WARNINGS from here, then the owner-scoped `extra`, then HOME, always
 * the owner's sandbox root. Nothing else of this process's environment (secrets
 * such as MICHI_ENCRYPTION_KEY or BETTER_AUTH_SECRET) reaches the child.
 */
export function cloudSubprocessEnv(ownerUserId: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    NODE_NO_WARNINGS: '1',
    ...extra,
    HOME: getUserSandboxRoot(ownerUserId),
  };
}
