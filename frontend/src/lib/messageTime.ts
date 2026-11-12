const pad = (value: number) => String(value).padStart(2, '0');

/** A message's time as shown beside it: `HH:MM` today, `M/D HH:MM` on other days. */
export function formatMessageTime(ms: number | undefined, now: Date = new Date()): string {
  if (!ms) return '';
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) return time;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/** A log entry's clock time, `HH:MM:SS`, in the same 24-hour form. */
export function formatClockTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
