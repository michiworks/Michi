export type MetricAttrs = Record<string, unknown>;

const SOURCE = 'renderer';

let cachedMetricsEnabled: boolean | null = null;
let cachedStartupEnabled: boolean | null = null;
let cachedRunId: string | null = null;
const emittedStartupOnce = new Set<string>();

function readSearchParams(): URLSearchParams | null {
  try {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search);
  } catch {
    return null;
  }
}

function readLocalStorage(key: string): string | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readEnv(): Record<string, string | undefined> | undefined {
  try {
    return (import.meta as { env?: Record<string, string | undefined> }).env;
  } catch {
    return undefined;
  }
}

export function enabled(): boolean {
  if (cachedMetricsEnabled !== null) return cachedMetricsEnabled;
  const params = readSearchParams();
  const env = readEnv();
  cachedMetricsEnabled =
    params?.get('metrics') === '1' ||
    readLocalStorage('michi:metrics') === '1' ||
    env?.VITE_MICHI_METRICS === '1';
  return cachedMetricsEnabled;
}

export function startupEnabled(): boolean {
  if (cachedStartupEnabled !== null) return cachedStartupEnabled;
  const params = readSearchParams();
  const env = readEnv();
  cachedStartupEnabled =
    params?.get('startupTrace') === '1' ||
    readLocalStorage('michi:startup-trace') === '1' ||
    env?.VITE_MICHI_STARTUP_TRACE === '1';
  return cachedStartupEnabled;
}

export function runId(): string {
  if (cachedRunId !== null) return cachedRunId;
  const params = readSearchParams();
  const env = readEnv();
  cachedRunId =
    params?.get('metricsRunId') ||
    params?.get('startupRunId') ||
    readLocalStorage('michi:metrics-run-id') ||
    readLocalStorage('michi:startup-run-id') ||
    env?.VITE_MICHI_METRICS_RUN_ID ||
    env?.VITE_MICHI_STARTUP_RUN_ID ||
    '';
  return cachedRunId;
}

export function now(): number {
  return enabled() ? performance.now() : 0;
}

function writeJson(row: Record<string, unknown>): void {
  console.info(JSON.stringify(row));
}

function metricRow(kind: string, name: string, attrs?: MetricAttrs): Record<string, unknown> {
  return {
    type: 'metric',
    runId: runId(),
    source: SOURCE,
    kind,
    name,
    t: Date.now(),
    attrs: attrs ?? {},
  };
}

export function mark(name: string, attrs?: MetricAttrs): void {
  if (!enabled()) return;
  writeJson(metricRow('mark', name, attrs));
}

export function measure(name: string, startTime: number, attrs?: MetricAttrs): void {
  if (!enabled()) return;
  writeJson({
    ...metricRow('measure', name, attrs),
    durMs: Number((performance.now() - startTime).toFixed(1)),
  });
}

export function startupMark(name: string, attrs?: MetricAttrs): void {
  if (!startupEnabled()) return;
  writeJson({
    type: 'startup',
    runId: runId(),
    source: SOURCE,
    name,
    t: Date.now(),
    ...attrs,
  });
}

export function startupMarkOnce(name: string, attrs?: MetricAttrs): void {
  if (!startupEnabled()) return;
  if (emittedStartupOnce.has(name)) return;
  emittedStartupOnce.add(name);
  startupMark(name, attrs);
}
