function compact(value: number, precise: boolean): string {
  if (precise) return value.toFixed(1);
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');
}

/**
 * A token count as a short label: 950, 9.9k, 41k, 1.3M. The label is
 * rounded before it picks its unit, so 999,500 reads 1M, not 1000k.
 * `precise` keeps one decimal (15.0k). Callers add the word "tokens".
 */
export function formatTokenCount(value: number, { precise = false }: { precise?: boolean } = {}): string {
  if (value < 1_000) return Math.round(value).toLocaleString('en-US');
  if (value < 1_000_000) {
    const thousands = compact(value / 1_000, precise);
    if (Number(thousands) < 1_000) return `${thousands}k`;
  }
  return `${compact(value / 1_000_000, precise)}M`;
}
