/**
 * Maintainer's script for P6a (unification D11): the scheduler's check-in
 * lane's shadow starts beside the check-ins the coordinator started
 * (services/companion/checkinShadow.ts reconcileCheckinShadow). Before P6b
 * flips `companion:engine`, at least seven days of heartbeats and wakes
 * should agree: each start matched within a tick or so, the same counts each
 * day, the first heartbeat at the same time.
 *
 * Read only: it opens data.db read-only and never migrates it, so the backend
 * may keep running. It refuses to run unless MICHI_DATA_DIR names the data
 * directory explicitly. It prints kinds, counts and times only. Run from
 * backend/:
 *
 *   MICHI_DATA_DIR=/path/to/data npx ts-node scripts/checkin-shadow-report.ts [--days 7] [--json]
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { reconcileCheckinShadow, type CheckinShadowStart } from '../src/services/companion/checkinShadow';

const DAY_MS = 24 * 60 * 60_000;

function parseArgs(argv: readonly string[]): { days: number; json: boolean } {
  const args = { days: 7, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--json') args.json = true;
    else if (flag === '--days') {
      const days = Number(argv[i + 1]);
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('--days must be a whole number from 1 to 30');
      args.days = days;
      i += 1;
    } else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

const clock = (at: number | null) => (at === null ? '—' : new Date(at).toTimeString().slice(0, 8));
const starts = (list: readonly CheckinShadowStart[]) => list.map((start) => `${start.kind} ${new Date(start.at).toISOString()}`).join('\n    ');

function main(): number {
  const dataDir = process.env.MICHI_DATA_DIR?.trim();
  if (!dataDir) {
    process.stderr.write('Refusing to run: set MICHI_DATA_DIR to the data directory explicitly.\n');
    return 2;
  }
  let args: { days: number; json: boolean };
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const database = new DatabaseSync(path.join(dataDir, 'data.db'), { readOnly: true });
  try {
    const to = Date.now();
    const report = reconcileCheckinShadow(database, to - args.days * DAY_MS, to);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    const lines = [`Check-in shadow, last ${args.days} days (tolerance ${report.toleranceMs / 1000} s)`, '',
      'date        wake      heartbeat  worker_report  first heartbeat (shadow / coordinator)'];
    for (const day of report.days) {
      const pair = (kind: keyof typeof day.counts) => `${day.counts[kind].shadow}/${day.counts[kind].coordinator}`.padEnd(kind === 'worker_report' ? 15 : kind === 'heartbeat' ? 11 : 10);
      lines.push(`${day.date}  ${pair('wake')}${pair('heartbeat')}${pair('worker_report')}${clock(day.firstHeartbeat.shadow)} / ${clock(day.firstHeartbeat.coordinator)}`);
    }
    const days = report.days.filter((day) => day.counts.heartbeat.coordinator > 0).length;
    lines.push('', `matched ${report.matched}, shadow only ${report.shadowOnly.length}, coordinator only ${report.coordinatorOnly.length}; ${days} days with a heartbeat`);
    if (report.shadowOnly.length > 0) lines.push(`  shadow only:\n    ${starts(report.shadowOnly)}`);
    if (report.coordinatorOnly.length > 0) lines.push(`  coordinator only:\n    ${starts(report.coordinatorOnly)}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    database.close();
  }
}

process.exitCode = main();
