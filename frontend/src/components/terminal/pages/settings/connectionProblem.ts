/**
 * Settings › Machines: what a failed connection says to people. A conclusion
 * ("Can’t reach build box"), a cause in plain words when the log shows one,
 * and the log itself without the terminal's colour and cursor codes.
 *
 * Logs reach here already redacted (redactRemoteLog). Some arrive with the
 * escape character gone but the rest of each code left behind ("[31m",
 * "[2K"), so those fragments are removed too.
 */

/** Whole escape sequences: CSI (colours, cursor and erase), OSC (titles, links) and two-character escapes. */
const ESCAPE_SEQUENCES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/**
 * A CSI sequence whose escape character was lost: "[31m", "[0m", "[1G",
 * "[2K", "[?25l", "[1;32m", and a bare "[m" or "[K". Numbers are required for
 * the other letters, so text such as "[A-Z]" or "[sudo]" stays.
 */
const ORPHAN_SEQUENCES = /\[(?:\??\d{1,4}(?:;\d{1,4})*[A-HJKSTfhlmnsu]|[mK](?![\w\]]))/g;
const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** The log as plain text: no terminal codes, a line redrawn in place shows its last state. */
export function plainConnectionLog(log: string): string {
  const lines = log
    .replace(ESCAPE_SEQUENCES, '')
    .replace(ORPHAN_SEQUENCES, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    // A carriage return redraws the line; keep what it showed last.
    .map((line) => (line.split('\r').filter((part) => part.trim()).pop() ?? '').replace(CONTROL_CHARACTERS, '').trimEnd());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface ConnectionProblem {
  /** One sentence: what is wrong. */
  title: string;
  /** Why, in plain words, and what to do; only when the log shows it. */
  cause?: string;
}

/** Causes Michi recognizes, first match wins; `signIn` marks a machine that answered but turned down the sign-in. */
const CAUSES: ReadonlyArray<{ pattern: RegExp; cause: string; signIn?: true }> = [
  { pattern: /proxy[\s\S]*(?:could not resolve|no such host|name or service not known)/i,
    cause: 'The SSH proxy could not find the host. Check the VPN, then retry.' },
  { pattern: /could not resolve hostname|could not resolve target host|name or service not known|nodename nor servname|no such host/i,
    cause: 'The machine’s name could not be found. Check the VPN and the SSH host, then retry.' },
  { pattern: /host key verification failed|remote host identification has changed/i,
    cause: 'The machine’s host key changed. Check it in Terminal with ssh, then retry.' },
  { pattern: /permission denied|authentication (?:failed|expired)|too many authentication failures/i, signIn: true,
    cause: 'SSH sign-in needs attention. Sign in with ssh in Terminal, then retry.' },
  { pattern: /HTTP 40[13]\b|unauthorized|invalid (?:access )?token/i, signIn: true,
    cause: 'Michi on the machine did not accept the access token. Edit the connection and enter its token again.' },
  { pattern: /connection refused/i,
    cause: 'The machine refused the connection. Check that it is on and that Michi is running there, then retry.' },
  { pattern: /timed out|no route to host|network is unreachable|host is down/i,
    cause: 'The machine did not answer. Check the VPN and that the machine is on, then retry.' },
];

export function describeConnectionProblem(name: string, log: string): ConnectionProblem {
  const text = plainConnectionLog(log);
  const known = CAUSES.find(({ pattern }) => pattern.test(text));
  return { title: known?.signIn ? `Can’t sign in to ${name}` : `Can’t reach ${name}`, ...(known ? { cause: known.cause } : {}) };
}
