/**
 * File size for UI labels: "512 B", "9.8 KB", "512 KB", "4.0 MB", "12 MB".
 * A missing, zero or invalid size gives `empty`.
 */
export function formatBytes(n: number | undefined, { empty = '' }: { empty?: string } = {}): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return empty;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
