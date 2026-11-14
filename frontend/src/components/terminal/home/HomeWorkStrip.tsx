import type { HomeWorkCounts } from '../../../state/home/homeWork';
import { CompanionGlyph } from '../companion/CompanionGlyph';
import { ChevronRightIcon } from '../icons';
import './homeCards.css';

/**
 * Home's one line about Michi's work (Q44), while Michi is on: what it is
 * working on, what waits for the user and what it finished today. Open
 * Today shows them in its panel.
 */
export function HomeWorkStrip({ name, counts, onOpenToday }: { name: string; counts: HomeWorkCounts; onOpenToday: () => void }) {
  return (
    <div className="home-work" role="group" aria-label={`${name}’s work`}>
      <span className="home-work__who"><CompanionGlyph size={13} /><span className="home-work__name">{name}</span></span>
      <span className="home-work__count" data-kind="working">
        <i aria-hidden="true" /><span className="home-work__long">Working on</span><span className="home-work__short">Working</span> <b>{counts.working}</b>
      </span>
      <span className="home-work__count" data-kind="waiting">
        <i aria-hidden="true" /><span className="home-work__long">Waiting for you</span><span className="home-work__short">Waiting</span> <b>{counts.waiting}</b>
      </span>
      <span className="home-work__count" data-kind="done">
        <i aria-hidden="true" /><span className="home-work__long">Done today</span><span className="home-work__short">Done</span> <b>{counts.doneToday}</b>
      </span>
      <button type="button" className="home-work__open" onClick={onOpenToday}>
        <span className="home-work__long">Open Today</span><span className="home-work__short">Today</span><ChevronRightIcon size={12} />
      </button>
    </div>
  );
}
