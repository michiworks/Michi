import { createHash, timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { RequestHandler } from 'express';
import { isLoopbackAddress } from 'michi-runtime/internal/core/loopback';
import { resolveAccessPolicy } from './accessPolicy';
import { getMichiDataDir } from './dataDir';

const MIN_REMOTE_TOKEN_LENGTH = 16;

const INTERNAL_RUNTIME_PATHS = [
  /^(?:\/api)?\/mcp\/[^/]+$/,
  /^(?:\/api)?\/mcp-session\/[^/]+$/,
];

export function remoteAccessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MICHI_REMOTE_ACCESS === '1';
}

export function remoteAccessToken(): string | null {
  const token = process.env.MICHI_REMOTE_TOKEN?.trim();
  return token ? token : null;
}

/**
 * The address the backend listens on. Loopback unless MICHI_BIND_HOST names
 * another; cloud defaults to every interface, as it runs in a container behind
 * enforced auth where publishing the port is the deployment's decision. Remote
 * access stays on loopback, reached through an SSH tunnel; a wider bind needs
 * an explicit MICHI_BIND_HOST (the launcher's --public).
 *
 * Without auth the API, agent shell tools included, trusts whoever reaches it
 * (the host and origin guards stop web pages, not other machines). So any
 * address that is not loopback throws unless something verifies each caller:
 * the remote-access bearer token or session auth (MICHI_REQUIRE_AUTH=true,
 * which MICHI_CLOUD=1 requires).
 */
export function resolveListenHost(): string {
  const explicit = process.env.MICHI_BIND_HOST?.trim();
  if (explicit && (explicit.length > 255 || /[\s/]/.test(explicit))) {
    throw new Error('MICHI_BIND_HOST is invalid');
  }
  const host = explicit || (process.env.MICHI_CLOUD === '1' ? '0.0.0.0' : '127.0.0.1');
  if (!isLoopbackHost(host) && !callersAreAuthenticated()) {
    throw new Error(
      `Michi will not listen on ${host}${explicit ? ' (MICHI_BIND_HOST)' : ''}: without authentication, ` +
        'anyone who can reach that address could use its API, agent shell tools included. ' +
        'Listen on loopback (unset MICHI_BIND_HOST or set it to 127.0.0.1) and connect through an SSH tunnel, ' +
        `or require credentials: MICHI_REMOTE_ACCESS=1 with a MICHI_REMOTE_TOKEN of at least ${MIN_REMOTE_TOKEN_LENGTH} characters ` +
        '(npm run remote:launch sets both), or MICHI_REQUIRE_AUTH=true.',
    );
  }
  return host;
}

/** localhost, 127.0.0.0/8 and ::1, also bracketed or IPv4-mapped. */
export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (name === 'localhost') return true;
  if (isIPv4(name)) return name.startsWith('127.');
  if (!isIPv6(name)) return false;
  // The URL parser writes IPv6 in its shortest form ([::1], [::ffff:7f00:1])
  // but takes no zone index (%lo).
  const canonical = new URL(`http://[${name.replace(/%.*$/, '')}]`).hostname;
  if (canonical === '[::1]') return true;
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}\]$/.exec(canonical);
  return !!mapped && parseInt(mapped[1], 16) >> 8 === 127;
}

/**
 * One person's own backend: no session auth or cloud, no remote access, on a
 * loopback listener. An access configuration resolveAccessPolicy rejects is
 * not one.
 */
function isPersonalLocalBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (resolveAccessPolicy(env).mode !== 'local') return false;
  } catch {
    return false;
  }
  return !remoteAccessEnabled(env) && isLoopbackHost(env.MICHI_BIND_HOST?.trim() || '127.0.0.1');
}

/**
 * The base URL at which this backend reaches its own listener: a wildcard
 * bind maps to loopback and a loopback address is dialed as is. `localhost`
 * is only passed before the listener has bound one of its addresses.
 * Null for any other address: what dials it (agents' MCP, phone access,
 * page previews) is answered only for a loopback caller.
 */
export function selfLoopbackBase(listenHost: string, port: number): string | null {
  const name = listenHost.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (name === '0.0.0.0' || name === 'localhost') return `http://127.0.0.1:${port}`;
  if (name === '::') return `http://[::1]:${port}`;
  if (!isLoopbackHost(name)) return null;
  if (isIPv4(name)) return `http://${name}:${port}`;
  // An IPv4-mapped address takes IPv4 connections only.
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(new URL(`http://[${name.replace(/%.*$/, '')}]`).hostname);
  if (!mapped) return `http://[::1]:${port}`;
  const [high, low] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
  return `http://${high >> 8}.${high & 255}.${low >> 8}.${low & 255}:${port}`;
}

/** Whether every API request must carry a credential the backend verifies. */
function callersAreAuthenticated(): boolean {
  // createRemoteAccessMiddleware checks every /api request against the token.
  if (remoteAccessEnabled() && (remoteAccessToken()?.length ?? 0) >= MIN_REMOTE_TOKEN_LENGTH) return true;
  // Session middleware; resolveAccessPolicy throws for an incomplete auth setup.
  return resolveAccessPolicy().requireAuth;
}

/** Called at startup before databases open: throws for any configuration the server must not run with. */
export function validateRemoteAccessConfiguration(): void {
  if (remoteAccessEnabled()) {
    const token = remoteAccessToken();
    if (!token) {
      throw new Error('MICHI_REMOTE_ACCESS=1 requires MICHI_REMOTE_TOKEN');
    }
    if (token.length < MIN_REMOTE_TOKEN_LENGTH) {
      throw new Error(`MICHI_REMOTE_TOKEN must be at least ${MIN_REMOTE_TOKEN_LENGTH} characters`);
    }
    if ((process.env.MICHI_REQUIRE_AUTH || '').toLowerCase() === 'true') {
      throw new Error('MICHI_REMOTE_ACCESS and MICHI_REQUIRE_AUTH cannot be enabled together');
    }
  }
  // An address beyond loopback without authentication.
  resolveListenHost();
}

function secureEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export { isLoopbackAddress };

export function isInternalRuntimeRequest(path: string, remoteAddress: string | undefined): boolean {
  return isLoopbackAddress(remoteAddress)
    && INTERNAL_RUNTIME_PATHS.some((pattern) => pattern.test(path));
}

export function createRemoteAccessMiddleware(): RequestHandler {
  return (req, res, next) => {
    if (!remoteAccessEnabled()) return next();
    // Claude, Kiro, and Codex call Michi's per-session MCP capability URL from
    // child processes on this host. Those requests must keep working when the
    // external API is protected by MICHI_REMOTE_TOKEN. The exception is narrow:
    // loopback only, internal routes only, and the MCP layer still requires the
    // unguessable per-session slot id. Normal API calls arriving through an SSH
    // tunnel are also loopback, but do not match these paths and still require
    // the external bearer token below.
    if (isInternalRuntimeRequest(req.path, req.socket?.remoteAddress)) return next();
    // A loopback GET that a page preview cookie covers (services/pages/pagePreview.ts).
    if (res.locals.pagePreviewRead === true) return next();
    const expected = remoteAccessToken();
    if (!expected) return res.status(503).json({ error: 'remote access is misconfigured' });
    const header = req.headers.authorization;
    const actual = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : '';
    if (!actual || !secureEqual(actual, expected)) {
      return res.status(401).json({ error: 'invalid remote access token' });
    }
    res.locals.remoteAccessAuthenticated = true;
    next();
  };
}

export function remoteServerId(): string {
  return createHash('sha256').update(getMichiDataDir()).digest('hex').slice(0, 16);
}
