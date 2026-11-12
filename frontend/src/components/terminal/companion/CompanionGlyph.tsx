/**
 * The agent's glyph: the shape of the menu-bar / notification-area icon
 * (assets/icons/tray-glyph.png, DESIGN-v2 §1.2, §5.1), drawn in currentColor
 * on a 16-unit grid (the 1024px art at 1/64): the tall ear on the left, the
 * shorter one on the right, the notch low on the right side, and the eyes
 * cut out (F1a-review #13).
 */
const COMPANION_GLYPH_PATH = [
  'M1.6 11.4C1.6 7.6 3.6 4.6 5.6 3.3C6.6 2.7 7.6 2.8 7.95 3.6C8.3 4.5 7.6 5.6 6.9 6.5',
  'C6.2 7.4 6.4 8.4 7.1 8.7C7.8 9 8.7 8.8 9.2 7.9C9.7 7 10.1 5.4 11.1 5.2C11.9 5 12.4 5.5 12.45 6.6',
  'C12.55 8 12.2 9.4 12.6 10.6C12.9 11.4 13.5 11.9 14.35 12.2C14 13.6 12.9 14.4 11.6 14.4L4.4 14.4C2.8 14.4 1.6 13.1 1.6 11.4Z',
  // The eyes, cut out of the shape (evenodd).
  'M5.08 9.6a.5.5 0 1 0 0 1a.5.5 0 1 0 0-1Z',
  'M9.45 9.6a.5.5 0 1 0 0 1a.5.5 0 1 0 0-1Z',
].join('');

export function CompanionGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-companion-glyph="">
      <path fill="currentColor" fillRule="evenodd" d={COMPANION_GLYPH_PATH} />
    </svg>
  );
}
