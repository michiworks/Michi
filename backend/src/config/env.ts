/**
 * A positive integer setting, or `fallback` when it is unset or not a
 * positive number: a timer given NaN or 0 would fire at once.
 */
export function envPositiveInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
