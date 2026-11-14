import { Ghost } from 'lucide-react';
import './temporaryChat.css';

/**
 * The temporary chat's ghost (ChatNodeState.temporary): before its title in
 * the sidebar and wherever its pane is named, and on Home's switch.
 * Decorative: what names the chat says "temporary chat" itself.
 */
export function TemporaryChatGlyph({ size = 13, inline = false }: {
  size?: number;
  /** Before plain title text rather than in a flex row. */
  inline?: boolean;
}) {
  return (
    <Ghost size={size} strokeWidth={1.5} absoluteStrokeWidth aria-hidden="true" focusable="false"
      data-temporary-chat-mark="" className={inline ? 'temporary-chat-mark temporary-chat-mark--inline' : 'temporary-chat-mark'} />
  );
}

/**
 * One line at the top of a temporary chat's pane, as wide as its composer.
 * Nothing to close or change: a chat is temporary from its first message on.
 */
export function TemporaryChatNote({ contentMaxWidth }: { contentMaxWidth: number | null }) {
  return (
    <div className="temporary-chat-note" role="note">
      <div className="temporary-chat-note__body" style={contentMaxWidth != null ? { maxWidth: contentMaxWidth } : undefined}>
        <TemporaryChatGlyph size={15} />
        <p className="temporary-chat-note__text">
          <strong>Temporary chat</strong>{' '}
          <span className="temporary-chat-note__detail">· Memory is off here, and other chats can’t read it.</span>
        </p>
      </div>
    </div>
  );
}
