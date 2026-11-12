import type { RuntimeWarning } from 'michi-shared';

// Michi's product text for the Claude adapter: the adapter reaches the stderr
// notice through ClaudeAdapterOptions.stderrWarning.

/** The warning for a line Claude Code wrote to stderr: its AWS credential helper returned no credentials. */
export function claudeStderrWarning(stderr: string): RuntimeWarning | undefined {
  if (!/awsCredentialExport did not return a valid value/i.test(stderr)) return undefined;
  return { source: 'auth', category: 'configuration',
    message: 'AWS credentials unavailable. Refresh your credentials in your terminal, then retry.' };
}
