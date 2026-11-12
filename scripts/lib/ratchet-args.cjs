'use strict';
// Flags shared by the baseline ratchets: scripts/knip-baseline.mjs,
// backend/scripts/dependencyRules.cjs and backend/scripts/runtimeBoundary.cjs.
//
// Baselines only shrink. A check fails on new entries and on entries that no longer occur.
//   --prune                 drop entries that no longer occur; never adds
//   --accept-new "<reason>" add the current new entries; the reason goes in the commit body
//   --write                 deprecated alias of --prune

const RATCHET_FLAGS = '[--prune] [--accept-new "<reason>"]';

/**
 * @param {string[]} argv
 * @returns {{ prune: boolean, acceptNew: string | null, deprecatedWrite: boolean, rest: string[], error: string | null }}
 *   `rest` holds the arguments that are not ratchet flags, in order.
 */
function parseRatchetArgs(argv) {
  const parsed = { prune: false, acceptNew: null, deprecatedWrite: false, rest: [], error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--prune') {
      parsed.prune = true;
    } else if (arg === '--write') {
      parsed.prune = true;
      parsed.deprecatedWrite = true;
    } else if (arg === '--accept-new' || arg.startsWith('--accept-new=')) {
      const reason = arg === '--accept-new' ? argv[++i] : arg.slice('--accept-new='.length);
      if (typeof reason !== 'string' || reason.trim() === '' || reason.startsWith('--')) {
        parsed.error = '--accept-new needs a non-empty reason: --accept-new "<why these entries are unavoidable>"';
        return parsed;
      }
      parsed.acceptNew = reason.trim();
    } else {
      parsed.rest.push(arg);
    }
  }
  return parsed;
}

function writeDeprecation(command) {
  return `${command}: --write is deprecated and now means --prune (drop entries that no longer occur; never adds).\n`
    + `Usage: ${command} ${RATCHET_FLAGS}`;
}

function pruneHint(command) {
  return `Run \`${command} --prune\` to drop them; it never adds entries.`;
}

function formatAccepted(file, reason, entries) {
  return [
    `Accepted ${entries.length} new entr${entries.length === 1 ? 'y' : 'ies'} into ${file}.`,
    'Put the reason and the entries in the commit body:',
    `  Reason: ${reason}`,
    ...entries.map((entry) => `    ${entry}`),
  ].join('\n');
}

module.exports = { RATCHET_FLAGS, parseRatchetArgs, writeDeprecation, pruneHint, formatAccepted };
