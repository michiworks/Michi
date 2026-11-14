import type { HomeGreeting as Greeting } from 'michi-shared';
import { michiHomeEyebrow } from '../content/home/michiHomeFormat';
import { TemporaryChatGlyph } from '../TemporaryChat';
import '../content/home/michiHome.css';
import './homeCards.css';

/**
 * Today's date, then the greeting (Michi's latest line or the time of day,
 * Q45) and its second line when it has one. While Home loads, bars stand
 * where a greeting goes.
 */
export function HomeGreeting({ greeting, now, pending = false }: { greeting: Greeting | null; now: number; pending?: boolean }) {
  return (
    <div className="michi-home-hero home-greeting">
      <div className="michi-home-eyebrow">{michiHomeEyebrow(now, null)}</div>
      {pending ? (
        <div className="home-greeting__skeleton" aria-hidden="true"><span /><span /><span /></div>
      ) : greeting && (
        <h1 className="home-greeting__text">
          <span className="michi-home-headline__mark">_ </span>
          {greeting.text}
          {greeting.detail && <small className="home-greeting__detail">{greeting.detail}</small>}
        </h1>
      )}
    </div>
  );
}

/** Home while its temporary-chat switch is on: what the chat it starts will and won't do. */
export function TemporaryChatGreeting() {
  return (
    <div className="michi-home-hero home-greeting home-greeting--temporary">
      <div className="michi-home-eyebrow home-greeting__eyebrow-mark">
        <TemporaryChatGlyph size={13} />
        <span>Temporary chat</span>
      </div>
      <h1 className="home-greeting__text">
        <span className="michi-home-headline__mark">_ </span>
        Nothing here goes into memory.
      </h1>
      <p className="home-greeting__detail">
        Michi won’t use your memories, and other chats can’t read this one. It stays in your history. This can’t be changed after you send.
      </p>
    </div>
  );
}
