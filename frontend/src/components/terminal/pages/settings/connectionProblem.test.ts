import { describe, expect, it } from 'vitest';
import { describeConnectionProblem, plainConnectionLog } from './connectionProblem';

describe('plainConnectionLog', () => {
  it('removes colour, cursor and erase codes, with or without their escape character', () => {
    expect(plainConnectionLog('\x1b[31mfailed\x1b[0m \x1b[1;32mok\x1b[m')).toBe('failed ok');
    expect(plainConnectionLog('[1G[2K[31mWSSH Proxy returned an error[0m')).toBe('WSSH Proxy returned an error');
    expect(plainConnectionLog('[?25lworking[?25h [K')).toBe('working');
    expect(plainConnectionLog('\x1b]0;window title\x07done')).toBe('done');
  });

  it('keeps bracketed text that is not a terminal code', () => {
    expect(plainConnectionLog('[sudo] password for builder; ranges [A-Z] and [1] stay; [mypy] too')).toBe('[sudo] password for builder; ranges [A-Z] and [1] stay; [mypy] too');
  });

  it('shows the last state of a line redrawn in place, and drops other control characters', () => {
    expect(plainConnectionLog('Connecting 10%\rConnecting 100%\r\nDone\x07\n\n\n\nBye  ')).toBe('Connecting 100%\nDone\n\nBye');
  });
});

describe('describeConnectionProblem', () => {
  const cause = (log: string) => describeConnectionProblem('build+', log).cause;

  it('concludes that the machine cannot be reached', () => {
    expect(describeConnectionProblem('build+', 'Something odd')).toEqual({ title: 'Can’t reach build+' });
  });

  it('names a cause it recognizes in plain words', () => {
    expect(describeConnectionProblem('build+', '[31mWSSH Proxy returned an error with code 400: Could not resolve target host[0m')).toEqual({
      title: 'Can’t reach build+', cause: 'The SSH proxy could not find the host. Check the VPN, then retry.',
    });
    expect(cause('ssh: Could not resolve hostname devbox: nodename nor servname provided, or not known')).toMatch(/^The machine’s name could not be found/);
    expect(cause('ssh: connect to host devbox port 22: Connection refused')).toMatch(/^The machine refused the connection/);
    expect(cause('ssh: connect to host devbox port 22: Operation timed out')).toMatch(/^The machine did not answer/);
    expect(cause('Reading remote workspaces timed out. Check the connection and try again.')).toMatch(/^The machine did not answer/);
    expect(cause('Host key verification failed.')).toMatch(/host key changed/);
  });

  it('says sign-in failed when the machine answered but turned it down', () => {
    expect(describeConnectionProblem('build+', 'builder@devbox: Permission denied (publickey).')).toEqual({
      title: 'Can’t sign in to build+', cause: 'SSH sign-in needs attention. Sign in with ssh in Terminal, then retry.',
    });
    expect(describeConnectionProblem('build+', 'Could not read remote workspaces (HTTP 401): Unauthorized')).toMatchObject({
      title: 'Can’t sign in to build+', cause: expect.stringMatching(/access token/),
    });
  });
});
