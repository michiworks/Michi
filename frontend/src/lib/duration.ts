/**
 * How long something took or has been running, said one way everywhere:
 * "0.3s", "12s", "1m 12s", "1h 5m". A finished duration rounds (tenths below
 * 10s); a running one floors whole seconds, so a live clock never runs ahead.
 * The parts come from whole seconds first, so a rounded second carries into
 * the minute ("2m", never "1m 60s").
 */
export interface DurationOptions {
  /** Still running: floor whole seconds, no tenths. */
  live?: boolean;
}

interface DurationParts { h: number; m: number; s: number; tenths?: number }

function durationParts(ms: number, { live = false }: DurationOptions): DurationParts {
  if (!live) {
    const tenths = Math.round(ms / 100) / 10;
    if (tenths < 10) return { h: 0, m: 0, s: 0, tenths: Math.max(0.1, tenths) };
  }
  const whole = Math.max(0, live ? Math.floor(ms / 1000) : Math.round(ms / 1000));
  return { h: Math.floor(whole / 3600), m: Math.floor((whole % 3600) / 60), s: whole % 60 };
}

type Unit = (n: number, u: 'h' | 'm' | 's', digits?: number) => string;

/** The two largest units, the smaller one left out when it is zero. */
function join(parts: DurationParts, unit: Unit): string {
  if (parts.tenths !== undefined) return unit(parts.tenths, 's', 1);
  const { h, m, s } = parts;
  if (h) return m ? `${unit(h, 'h')} ${unit(m, 'm')}` : unit(h, 'h');
  if (m) return s ? `${unit(m, 'm')} ${unit(s, 's')}` : unit(m, 'm');
  return unit(s, 's');
}

export function formatDuration(ms: number, options: DurationOptions = {}): string {
  return join(durationParts(ms, options), (n, u, digits) => `${digits ? n.toFixed(digits) : n}${u}`);
}

const SPOKEN_UNIT = { h: 'hour', m: 'minute', s: 'second' } as const;

/** formatDuration in words, for screen readers: "1 minute 12 seconds". */
export function spokenDuration(ms: number, options: DurationOptions = {}): string {
  return join(durationParts(ms, options), (n, u, digits = 0) =>
    new Intl.NumberFormat('en', { style: 'unit', unit: SPOKEN_UNIT[u], unitDisplay: 'long', maximumFractionDigits: digits }).format(n));
}
