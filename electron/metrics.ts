export type MetricAttrs = Record<string, unknown>;

const SOURCE = 'electron-main';
const GENERATED_RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_ID = process.env.MICHI_METRICS_RUN_ID || process.env.MICHI_STARTUP_RUN_ID || GENERATED_RUN_ID;
const METRICS_ENABLED = process.env.MICHI_METRICS === '1';
const STARTUP_ENABLED = process.env.MICHI_STARTUP_TRACE === '1';

if ((METRICS_ENABLED || STARTUP_ENABLED) && !process.env.MICHI_STARTUP_RUN_ID) {
  process.env.MICHI_STARTUP_RUN_ID = RUN_ID;
}

export function enabled(): boolean {
  return METRICS_ENABLED;
}

export function startupEnabled(): boolean {
  return STARTUP_ENABLED;
}

export function runId(): string {
  return RUN_ID;
}

function writeJson(row: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

export function startupMark(name: string, attrs?: MetricAttrs): void {
  if (!STARTUP_ENABLED) return;
  writeJson({
    type: 'startup',
    runId: RUN_ID,
    source: SOURCE,
    name,
    t: Date.now(),
    pid: process.pid,
    ...attrs,
  });
}
