#!/bin/bash
# CI-only: retain each attempt's output and retry only explicit network failures.
# The workflow owns the wall-clock deadline, including npm's own fetch retries.
set -uo pipefail

log_dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/michi-npm-ci.XXXXXX") || exit 1
printf 'npm ci logs: %s\n' "$log_dir"

for attempt in 1 2 3; do
  log_file="$log_dir/attempt-$attempt.log"
  printf 'npm ci attempt %s/3\n' "$attempt"
  npm ci --fetch-retries=5 --fetch-retry-factor=2 \
    --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=60000 2>&1 | tee "$log_file"
  statuses=("${PIPESTATUS[@]}")
  status=${statuses[0]}
  if [ "${statuses[1]}" -ne 0 ]; then
    echo 'Could not retain npm output; refusing to retry.' >&2
    exit 1
  fi
  if [ "$status" -eq 0 ]; then exit 0; fi
  # Do not turn cancellation into another install.
  if [ "$status" -ge 128 ]; then exit "$status"; fi

  # A deterministic failure wins even when a network warning appeared earlier.
  if grep -Eiq 'npm (error|ERR!).*(EUSAGE|ERESOLVE|ETARGET|E404|E401|E403|EINTEGRITY|EBADENGINE|ENOENT|EACCES|EPERM)|gyp ERR!|error TS[0-9]+|fatal error:' "$log_file"; then
    exit "$status"
  fi
  # Only npm error diagnostics (including nested installer errors) count, never
  # a warning, package name or a successful request elsewhere in the output.
  if ! grep -Eiq 'npm (error|ERR!).*\b(ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|E502|E503|E504)\b' "$log_file"; then
    exit "$status"
  fi
  if [ "$attempt" -eq 3 ]; then exit "$status"; fi
  delay=$((attempt * 15))
  printf 'Transient network failure (exit %s); retrying in %s seconds.\n' "$status" "$delay"
  sleep "$delay" || exit 1
done
