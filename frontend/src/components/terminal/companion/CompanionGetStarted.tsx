import React, { useState } from 'react';
import { toast } from 'sonner';
import { Check, Minus } from 'lucide-react';
import type { CompanionGetStartedDto, CompanionSettings } from 'michi-shared';
import { Button } from '../../ui/controls';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../config/backendIdentity';
import {
  CompanionApiError,
  postponeCompanionGetStarted,
  startCompanionGetStarted,
} from '../../../services/api/companion';
import { useMemoryLearning } from '../../../state/memory/learningStatus';
import { adoptCompanionSnapshot, useCompanion } from '../../../state/companion/companionStore';
import { useCompanionName } from '../../../state/companion/companionName';
import { firstRunActive, firstRunProgress, refreshSpacesFirstRun, useSpacesFirstRun } from '../../../state/metaAgent/spacesFirstRun';
import { navPageEvent } from '../../../state/appEvents';
import { OPEN_SETTINGS_SECTION_EVENT } from '../scheduled/metaAgent/metaAgentNav';

/** What Watch covers: local Michi conversations, in the card's order (D17). */
const WATCHED = [{ kind: 'michi', label: 'Michi conversations' }] as const;

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Weekdays", "Every day", "Weekends" or the days themselves. */
export function workdaysLabel(days: readonly number[]): string {
  const key = [...days].sort((a, b) => a - b).join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,1,2,3,4,5,6') return 'Every day';
  if (key === '0,6') return 'Weekends';
  return [...days].sort((a, b) => a - b).map((day) => WEEKDAY[day]).join(', ');
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function openPages(): void {
  navPageEvent.dispatch({ page: 'spaces' });
}

function openMemorySettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: 'memory' } }));
}

/** The first run's progress on the card after Start, and its end: "Workspace homes are ready · Open Pages". */
function HomesProgress() {
  const { data } = useSpacesFirstRun(LOCAL_BACKEND_CONNECTION_ID);
  if (!data || data.requestedAt === null) return <p className="companion-get-started__progress" aria-busy="true">Starting…</p>;
  if (data.haltedReason) {
    return (
      <p className="companion-get-started__progress" data-tone="stopped">
        Stopped: {data.haltedReason} · <button type="button" className="companion-link-btn" onClick={openPages}>Open Pages</button>
      </p>
    );
  }
  const progress = firstRunProgress(data);
  if (firstRunActive(data)) {
    const reading = progress.current
      ? `Reading ${progress.current.workspaceName}: ${progress.read} of ${plural(progress.total, 'conversation')}`
      : data.summary.state === 'running' ? 'Writing the Pages Home…'
        : progress.total > 0 ? `${progress.read} of ${plural(progress.total, 'conversation')} read` : 'Waiting for its turn…';
    return <p className="companion-get-started__progress" role="status" aria-busy="true"><span className="agent-spinner" aria-hidden="true" /> {reading}</p>;
  }
  return (
    <p className="companion-get-started__progress" role="status" data-tone="done">
      Workspace homes are ready
      {progress.failed.length > 0 && <> ({plural(progress.failed.length, 'workspace')} could not be written)</>}
      {' · '}<button type="button" className="companion-link-btn" onClick={openPages}>Open Pages</button>
    </p>
  );
}

function Mark({ on }: { on: boolean }) {
  return on
    ? <Check size={13} className="companion-get-started__mark" data-on="" aria-label="On" />
    : <Minus size={13} className="companion-get-started__mark" aria-label="Off" />;
}

/**
 * The first open of the panel (unification design D17, §3.1): a model-free
 * introduction and the Get started card in V. Nothing runs before Start;
 * the choice follows local conversation watching. After Start the same card shows the
 * first run's progress and its end. Not now folds it to one line that
 * opens it again.
 */
export function CompanionGetStarted({ getStarted, settings, name }: {
  getStarted: CompanionGetStartedDto;
  settings: CompanionSettings;
  name: string;
}) {
  const watchedNow = WATCHED.filter((source) => settings.sources[source.kind].enabled);
  const allWatched = watchedNow.length === WATCHED.length;
  const [homes, setHomes] = useState(getStarted.homesOn);
  const [watch, setWatch] = useState(allWatched);
  const [busy, setBusy] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const memory = useMemoryLearning();
  const started = getStarted.state === 'started';

  const decide = async (choice: 'start' | 'later') => {
    // Put off already: Not now only folds the card again.
    if (choice === 'later' && getStarted.state === 'later') { setUnfolded(false); return; }
    setBusy(true);
    try {
      // Watch is sent when it says something: ticked, or unticked from all on. A mixed set the user left alone stays.
      const next = choice === 'later' ? await postponeCompanionGetStarted()
        : await startCompanionGetStarted({ homes, ...(watch || allWatched ? { watch } : {}) });
      adoptCompanionSnapshot(next);
      if (choice === 'start') void refreshSpacesFirstRun(LOCAL_BACKEND_CONNECTION_ID);
      else setUnfolded(false);
    } catch (error) {
      const message = error instanceof CompanionApiError || error instanceof Error ? error.message : 'unknown error';
      toast.error(choice === 'start' ? `Couldn’t start: ${message}` : `Couldn’t put it off: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const intro = (
    <p className="companion-get-started__intro">
      I’m {name}. I keep a home page for each workspace from its conversations, list what needs you in Today, and write you a
      morning brief.{started ? '' : ' Choose what I may do; nothing starts until you press Start.'}
    </p>
  );

  if (getStarted.state === 'later' && !unfolded) {
    return (
      <div className="companion-get-started" data-state="later">
        {intro}
        <p className="companion-get-started__later">
          Nothing is running yet.{' '}
          <button type="button" className="companion-link-btn" onClick={() => setUnfolded(true)}>Get started</button>
        </p>
      </div>
    );
  }

  const brief = settings.brief.enabled ? `${workdaysLabel(settings.workdays)} ${settings.brief.time}` : 'Off';
  const homesShown = started ? getStarted.homesOn : homes;
  const watchLabel = (started && watchedNow.length > 0 && !allWatched ? watchedNow : WATCHED).map((source) => source.label).join(' · ');
  return (
    <div className="companion-get-started" data-state={getStarted.state}>
      {intro}
      <section className="companion-card companion-get-started__card" aria-label="Get started">
        <h3 className="companion-get-started__title">Get started</h3>
        <ul className="companion-get-started__rows">
          <li>
            {started ? (
              <span className="companion-get-started__choice" data-off={homesShown ? undefined : ''}>
                <Mark on={homesShown} /> Keep workspace homes up to date
              </span>
            ) : (
              <label className="companion-get-started__choice">
                <input type="checkbox" checked={homes} disabled={busy} onChange={(event) => setHomes(event.target.checked)} />
                Keep workspace homes up to date <span className="companion-get-started__hint">(reads the last {getStarted.firstRunDays} days)</span>
              </label>
            )}
          </li>
          <li>
            {started ? (
              <span className="companion-get-started__choice" data-off={watchedNow.length > 0 ? undefined : ''}>
                <Mark on={watchedNow.length > 0} /> Watch: {watchLabel}
              </span>
            ) : (
              <label className="companion-get-started__choice">
                <input type="checkbox" checked={watch} disabled={busy} onChange={(event) => setWatch(event.target.checked)} />
                Watch: {watchLabel}
              </label>
            )}
          </li>
          <li className="companion-get-started__fact">Morning brief: {brief}</li>
          <li className="companion-get-started__fact">
            Learn from conversations: {memory === null ? '…' : memory.learning ? 'On' : 'Off'} ·{' '}
            <button type="button" className="companion-link-btn" onClick={openMemorySettings}>Settings › Memory</button>
          </li>
        </ul>
        {started ? (getStarted.homes !== false && getStarted.homesOn && <HomesProgress />) : (
          <div className="companion-card__actions">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => { void decide('start'); }}>Start</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void decide('later'); }}>Not now</Button>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * V's leading slot (MetaChatDecorations.leading): the card while the
 * snapshot has one and the agent is on. It reads the snapshot itself, so the
 * conversation's decorations stay the same object while the card changes.
 */
export function CompanionGetStartedSlot() {
  const { snapshot } = useCompanion();
  const name = useCompanionName();
  const getStarted = snapshot?.getStarted;
  if (!snapshot || !getStarted || !snapshot.settings.enabled) return null;
  return <CompanionGetStarted key={getStarted.state} getStarted={getStarted} settings={snapshot.settings} name={name} />;
}
