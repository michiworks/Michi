/**
 * How long Michi's latest line stays Home's greeting (Q45): check-ins come
 * at least hourly, so a line older than three of them says Michi has been
 * quiet a while.
 */
const HOME_HEADLINE_FRESH_MS = 3 * 3_600_000;

/** "Good morning" until noon, "Good afternoon" until six, "Good evening" after and before five. */
export function timeOfDayGreeting(now: number): string {
  const hour = new Date(now).getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Home's greeting (Q45): the line Michi wrote last, when it is on and the
 * line is fresh, else the time of day.
 */
export function homeGreetingText(now: number, headline: { text: string; at: number } | null): string {
  if (headline && headline.text.trim() && now - headline.at <= HOME_HEADLINE_FRESH_MS) return headline.text.trim();
  return timeOfDayGreeting(now);
}
