export interface FollowScrollInput {
  currentScrollTop: number;
  maxScroll: number;
  tail: number;
}

export function nextFollowScrollTop({
  currentScrollTop,
  maxScroll,
  tail,
}: FollowScrollInput): number {
  const target = Math.min(maxScroll, tail);
  if (currentScrollTop > maxScroll) return maxScroll;
  if (target > currentScrollTop) return target;
  return currentScrollTop;
}
