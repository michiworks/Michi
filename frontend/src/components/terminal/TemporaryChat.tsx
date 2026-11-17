import { GhostIcon, iconPx, type IconSize } from './icons';
import './temporaryChat.css';

/**
 * The temporary chat's ghost (ChatNodeState.temporary): before its title in
 * the sidebar and wherever its pane is named, and on Home's switch.
 * Decorative: what names the chat says "temporary chat" itself.
 */
export function TemporaryChatGlyph({ size, inline = false, filled = false }: {
  size?: IconSize;
  /** Before plain title text rather than in a flex row. */
  inline?: boolean;
  /** Solid, for the phone's top bar of solid glyphs. */
  filled?: boolean;
}) {
  const className = inline ? 'temporary-chat-mark temporary-chat-mark--inline' : 'temporary-chat-mark';
  if (filled) {
    const px = iconPx(size);
    return (
      <svg width={px} height={px} viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-temporary-chat-mark="" className={className}>
        <path fill="currentColor" fillRule="evenodd" d={FILLED_GHOST_PATH} />
      </svg>
    );
  }
  return (
    <GhostIcon size={size} data-temporary-chat-mark="" className={className} />
  );
}

/** Lucide's ghost outline filled in, with its eyes cut out (evenodd). */
const FILLED_GHOST_PATH = [
  'M7.528 20.472a1.6 1.6 0 012.277 0l1.057 1.056a1.6 1.6 0 002.276 0l1.057-1.056a1.6 1.6 0 012.277 0',
  'l1.114 1.114a1.4 1.4 0 002.414-1V10a8 8 0 00-16 0v10.586a1.4 1.4 0 002.414 1z',
  'M7.9 10.1a1.1 1.1 0 0 1 2.2 0v.8a1.1 1.1 0 0 1-2.2 0z',
  'M13.9 10.1a1.1 1.1 0 0 1 2.2 0v.8a1.1 1.1 0 0 1-2.2 0z',
].join('');

/**
 * One line at the top of a temporary chat's pane, as wide as its composer.
 * Nothing to close or change: a chat is temporary from its first message on.
 */
export function TemporaryChatNote({ contentMaxWidth }: { contentMaxWidth: number | null }) {
  return (
    <div className="temporary-chat-note" role="note">
      <div className="temporary-chat-note__body" style={contentMaxWidth != null ? { maxWidth: contentMaxWidth } : undefined}>
        <TemporaryChatGlyph />
        <p className="temporary-chat-note__text">
          <strong>Temporary chat</strong>{' '}
          <span className="temporary-chat-note__detail">· Memory is off here, and other chats can’t read it.</span>
        </p>
      </div>
    </div>
  );
}
