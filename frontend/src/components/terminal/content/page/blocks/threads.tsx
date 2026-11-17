import type { BlockProps } from '../blockTypes';
import { objects, str, timelineWhen } from '../michiPageModel';
import { BlockTitle } from './text';
import { ThreadStateDot } from '../../ThreadStateDot';

export function ThreadsBlock({ block, ctx }: BlockProps) {
  return <>{ctx.renderNativeThreads?.(block) ?? <p className="michi-doc-unknown" role="status">These conversations are unavailable here.</p>}</>;
}

/**
 * "You may have forgotten": things finished a while ago with how to use them,
 * and things left half done with where they stopped.
 */
export function ForgotBlock({ block }: BlockProps) {
  const items = objects(block.items).filter((it) => str(it.title).trim());
  return (
    <div data-michi-block="forgot">
      <BlockTitle text={str(block.title).trim() || 'You may have forgotten'} />
      <ul className="michi-doc-forgot">
        {items.map((it, i) => {
          const shipped = it.state === 'shipped';
          const when = it.at === undefined ? null : timelineWhen(it.at);
          const detail = str(it.detail).trim();
          return (
            <li key={i} className="michi-doc-forgot__item" data-state={shipped ? 'shipped' : 'unfinished'}>
              {/* The glyph only shows the state; the words beside it say it, and for what shipped they give the day instead. */}
              <span className="michi-doc-forgot__glyph" aria-hidden="true"><ThreadStateDot kind={shipped ? 'done' : 'stalled'} size={10} /></span>
              <span className="michi-doc-forgot__title">{str(it.title)}</span>
              <span className={shipped && !when ? 'michi-doc-forgot__meta sr-only' : 'michi-doc-forgot__meta'}>
                {shipped ? (
                  <>
                    <span className="sr-only">shipped </span>
                    {when && (when.dateTime ? <time dateTime={when.dateTime}>{when.text}</time> : when.text)}
                  </>
                ) : 'half done'}
              </span>
              {detail && <span className="michi-doc-forgot__detail">{detail}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
