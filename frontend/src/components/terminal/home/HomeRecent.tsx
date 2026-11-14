import React from 'react';
import { homeRecentStatus, type HomeRecentThread } from '../../../state/home/homeRecent';
import { CompanionGlyph } from '../companion/CompanionGlyph';
import { ChevronRightIcon } from '../icons';
import './homeCards.css';

const ICON_SIZE = 12;

/**
 * "Jump back in" (Q44, Q46): the three latest conversations, each a card
 * with its workspace, title, the last line its own agent wrote about it and
 * what it is doing; a click opens it.
 */
export function HomeRecent({ threads, now, name, onOpen }: {
  threads: readonly HomeRecentThread[];
  now: number;
  /** The agent's name, for "Started by <name>". */
  name: string;
  onOpen: (thread: HomeRecentThread) => void;
}) {
  return (
    <section className="home-cards" aria-label="Jump back in">
      <div className="home-cards__head"><span className="michi-home-caption">Jump back in</span></div>
      <div className="home-cards__grid" data-count={threads.length}>
        {threads.map((thread, index) => (
          <button key={`${thread.projectId}:${thread.treeId}`} type="button" className="home-card home-card--recent" data-tone="accent"
            data-testid="home-recent" style={{ ['--home-card-index' as string]: index } as React.CSSProperties} onClick={() => onOpen(thread)}>
            <span className="home-card__kind"><ChevronRightIcon size={ICON_SIZE} /><span className="home-card__label">{thread.workspaceName}</span></span>
            <span className="home-card__title">{thread.title}</span>
            {thread.overview && <span className="home-card__overview">{thread.overview}</span>}
            <span className="home-card__status" data-state={thread.running ? 'running' : thread.unread ? 'done' : undefined}>
              {thread.startedByMichi ? <CompanionGlyph size={11} /> : thread.unread && !thread.running ? <i className="home-card__dot" aria-hidden="true" /> : null}
              {homeRecentStatus(thread, now, name)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
