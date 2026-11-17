import http from 'node:http';
import { log } from './logger';

type ProxyEnv = { HTTP_PROXY?: string; HTTPS_PROXY?: string; NO_PROXY: string };
type SetGlobalProxyFromEnv = (proxyEnv: ProxyEnv) => unknown;

/**
 * The proxy for Node's built-in proxy support, or null when the environment
 * names none. Loopback stays direct: the backend calls its own listeners and
 * tunnels, and the MCP host rejects requests that carry proxy headers.
 */
export function outboundProxyEnv(env: NodeJS.ProcessEnv): ProxyEnv | null {
  const httpsProxy = env.https_proxy || env.HTTPS_PROXY;
  const httpProxy = env.http_proxy || env.HTTP_PROXY;
  if (!httpsProxy && !httpProxy) return null;
  const noProxy = [env.no_proxy || env.NO_PROXY, 'localhost', '127.0.0.1', '[::1]'].filter(Boolean).join(',');
  return { HTTPS_PROXY: httpsProxy, HTTP_PROXY: httpProxy, NO_PROXY: noProxy };
}

/**
 * Sends this process's fetch and http(s) requests through HTTP(S)_PROXY, as
 * Pi's CLI does at startup; Node's fetch ignores those variables otherwise.
 * Call again after loading the Pi SDK, whose undici replaces the global
 * dispatcher on load. Node 22 has no setGlobalProxyFromEnv, so nothing changes there.
 */
export function applyOutboundProxyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const proxyEnv = outboundProxyEnv(env);
  const setGlobalProxyFromEnv = (http as { setGlobalProxyFromEnv?: SetGlobalProxyFromEnv }).setGlobalProxyFromEnv;
  if (!proxyEnv || typeof setGlobalProxyFromEnv !== 'function') return false;
  try {
    setGlobalProxyFromEnv(proxyEnv);
    return true;
  } catch (err) {
    // The message repeats the proxy URL, which can hold credentials.
    log.warn('boot', 'ignoring an invalid HTTP(S)_PROXY', { code: (err as NodeJS.ErrnoException).code });
    return false;
  }
}
