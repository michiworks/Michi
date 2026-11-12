/**
 * Maintainer's script: undoes what consolidation runs applied
 * (services/memory/consolidation.ts revertConsolidation), after a bug. There
 * is no route and no UI for it. A memory changed or deleted since its run is
 * never touched, so nothing removed comes back.
 *
 * It refuses to run unless MICHI_DATA_DIR names the data directory
 * explicitly, and it is a dry run unless --apply is given. It prints counts
 * and memory ids only, never memory text. Run from backend/:
 *
 *   MICHI_DATA_DIR=/path/to/data npx ts-node scripts/memory-consolidation-revert.ts --owner local --run mcr-… [--run mcr-…]
 *   MICHI_DATA_DIR=/path/to/data npx ts-node scripts/memory-consolidation-revert.ts --owner local --since 2026-11-09 --apply
 *
 * --since takes the owner's runs whose changes were logged at or after that
 * local date (or ISO time). Stop the backend first: it holds the database.
 */
import { closeDb, getDb } from '../src/services/db';
import { revertConsolidation } from '../src/services/memory/consolidation';

interface Args { owner: string | null; runs: string[]; since: number | null; apply: boolean }

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { owner: null, runs: [], since: null, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    if (flag === '--owner') args.owner = value();
    else if (flag === '--run') args.runs.push(value());
    else if (flag === '--since') {
      const text = value();
      const day = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
      const at = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime() : Date.parse(text);
      if (!Number.isFinite(at)) throw new Error('--since must be a date like 2026-11-09 or an ISO time');
      args.since = at;
    } else if (flag === '--apply') args.apply = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

function main(): number {
  if (!process.env.MICHI_DATA_DIR?.trim()) {
    process.stderr.write('Refusing to run: set MICHI_DATA_DIR to the data directory explicitly.\n');
    return 2;
  }
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  if (!args.owner || (args.runs.length === 0 && args.since === null)) {
    process.stderr.write('Usage: --owner <ownerUserId> (--run <mcr-…> ... | --since <date>) [--apply]\n');
    return 2;
  }
  try {
    const runs = new Set(args.runs);
    if (args.since !== null) {
      const rows = getDb().prepare(`SELECT DISTINCT run_id FROM memory_consolidation_log WHERE owner_user_id = ? AND outcome = 'applied'
        AND created_at >= ?`).all(args.owner, args.since) as Array<{ run_id: string }>;
      for (const row of rows) runs.add(row.run_id);
    }
    const result = revertConsolidation({ ownerUserId: args.owner, runIds: [...runs], apply: args.apply });
    process.stdout.write(`${JSON.stringify({
      mode: args.apply ? 'applied' : 'dry run', runs: [...runs], reverted: result.reverted.length, skipped: result.skipped.length,
      revertedIds: result.reverted, skippedIds: result.skipped,
    }, null, 2)}\n`);
    return 0;
  } finally {
    closeDb();
  }
}

process.exitCode = main();
