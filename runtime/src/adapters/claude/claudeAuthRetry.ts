/**
 * When to stop waiting on the Claude CLI's own authentication retries.
 *
 * On an authentication failure (an expired Bedrock security token, a
 * rejected OAuth token) the CLI announces `api_retry` with
 * `error: 'authentication_failed'`, clears its credential caches, runs the
 * credential helper again (awsCredentialExport, apiKeyHelper, an OAuth
 * refresh) and retries. That first retry is how an expired short-lived
 * credential recovers, so the host lets it run. A second authentication
 * failure means fresh credentials were rejected too: the CLI would only keep
 * backing off through its whole retry budget, so the host stops there.
 *
 * The CLI's `attempt` counts every retry of a request (a 429 first makes an
 * authentication failure attempt 2), so the gate counts authentication
 * failures itself. Model output or a finished turn ends that count, so the
 * next expiry, maybe hours later in a long-lived process, gets its own refresh.
 * An `api_retry` without an attempt number stops at once: a CLI that does not
 * report its retries may not refresh either.
 */
export function claudeAuthRetryGate(): (envelope: Record<string, unknown>) => boolean {
  let refreshed = false;
  return (envelope) => {
    if (envelope.type === 'assistant' || envelope.type === 'stream_event' || envelope.type === 'result') {
      refreshed = false;
      return false;
    }
    if (envelope.type !== 'system' || envelope.subtype !== 'api_retry' || envelope.error !== 'authentication_failed') return false;
    if (refreshed || typeof envelope.attempt !== 'number') return true;
    refreshed = true;
    return false;
  };
}
