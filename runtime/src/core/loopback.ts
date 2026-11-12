import { isIPv4 } from 'node:net';

/** A peer address on this host: 127.0.0.0/8, ::1 and IPv4-mapped 127.x (`::ffff:127.0.0.1`). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address === '::1') return true;
  const lower = address.toLowerCase();
  const v4 = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
  return isIPv4(v4) && v4.startsWith('127.');
}

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * A host name (a URL hostname, IPv6 bracketed) that names this host's
 * loopback by its usual names only. Narrower than a peer address on purpose:
 * a configured URL or Host header must not name 127.0.0.2 and the like.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}
