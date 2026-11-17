import { Suspense, useRef, useState } from 'react';
import { deferredComponent } from '../../deferredComponent';
import { Button } from '../../ui/controls';
import './spaceSettings.css';

const LOADING_UPKEEP = <p role="status">Loading Pages upkeep…</p>;
/** Settings › <name> › Pages upkeep, the same settings here beside the Pages they keep up to date. */
const PagesUpkeepSettings = deferredComponent<object>(() => import('../settings/metaAgent/MetaAgentSettings').then(module => ({ default: module.PagesUpkeepSettings })), LOADING_UPKEEP);
const ComponentsSettings = deferredComponent<object>(() => import('./components/ComponentsSettings').then(module => ({ default: module.ComponentsSettings })), <p role="status">Loading components…</p>);

/** Spaces' own settings stay in its main area, beside its navigation and assistant. */
export function SpacesSettings({ onBack }: { onBack(): void }) {
  const [components, setComponents] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);
  // Leaving gives focus back to what opened these settings, the sidebar's
  // row, which stays on screen (ST-10).
  const [opener] = useState(() => document.activeElement);
  const leave = () => {
    if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
    onBack();
  };
  return <main className="area-settings michi-doc spaces-home term-scrollbar" aria-label="Pages settings">
    <div className="area-settings__doc spaces-home__doc space-settings">
      <Button ref={backRef} variant="ghost" size="sm" className="space-settings__back" onClick={components ? () => setComponents(false) : leave}>← {components ? 'Back to settings' : 'Back to Pages'}</Button>
      <h1 className="spaces-home__title">{components ? 'Components' : 'Pages settings'}</h1>
      {components ? <Suspense fallback={<p role="status">Loading components…</p>}><ComponentsSettings /></Suspense> : <>
        <Suspense fallback={LOADING_UPKEEP}><PagesUpkeepSettings /></Suspense>
        {/* The button goes with its view: focus moves to Back, which stays. */}
        <section className="space-settings__section space-settings__row"><div><h2>Components</h2><p>Browse built-in blocks and manage reusable workspace components.</p></div><button type="button" onClick={() => { backRef.current?.focus({ preventScroll: true }); setComponents(true); }}>Browse components</button></section>
      </>}
    </div>
  </main>;
}
