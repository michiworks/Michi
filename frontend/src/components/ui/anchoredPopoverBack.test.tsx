import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backTarget, hasBackLayer, registerBackLayer } from '../../lib/backStack';
import { DbPopover } from '../terminal/content/db/DbPopover';
import { MichiMenu } from '../terminal/content/page/MichiMenu';
import { SourcesPopover } from '../terminal/content/page/SourcesPopover';
import { AskPopover } from '../terminal/content/page/AskPopover';
import { LayoutRulesPopover } from '../terminal/spaces/layoutRules/LayoutRulesPopover';

const api = vi.hoisted(() => ({ fetchSourcePreview: vi.fn(() => new Promise(() => {})) }));
vi.mock('../../state/sourceNav/sourceApi', () => ({ fetchSourcePreview: api.fetchSourcePreview }));
import { SourcePopover } from '../terminal/source/SourcePopover';

type Surface = (anchor: HTMLElement, onClose: () => void) => React.ReactElement;

const surfaces: Array<[string, Surface]> = [
  ['the database Filter panel (DbPopover dialog)', (anchor, onClose) => (
    <DbPopover anchor={anchor} label="Filter" onClose={onClose}><select aria-label="Column"><option>Status</option></select></DbPopover>
  )],
  ['a database menu (DbPopover menu)', (anchor, onClose) => (
    <DbPopover anchor={anchor} label="Column" role="menu" onClose={onClose}><button type="button" role="menuitem">Hide</button></DbPopover>
  )],
  ['a page block menu (MichiMenu)', (anchor, onClose) => (
    <MichiMenu anchor={anchor} label="Block" entries={[{ id: 'a', label: 'Ask', onSelect: () => {} }]} onClose={onClose} />
  )],
  ['a block\'s Sources', (anchor, onClose) => (
    <SourcesPopover anchor={anchor} label="Plan" count={1} rows={[{ key: 'r', kind: 'file', label: 'plan.md' }]} onOpenThread={() => {}} onClose={onClose} />
  )],
  ['Ask about a block', (anchor, onClose) => (
    <AskPopover anchor={anchor} label="Plan" suggestions={[]} onSubmit={() => {}} onClose={onClose} />
  )],
  ['the layout rules', (anchor, onClose) => (
    <LayoutRulesPopover anchor={anchor} rules={[]} onDelete={async () => {}} onClose={onClose} />
  )],
  ['a source preview', (anchor, onClose) => (
    <SourcePopover popover={{ target: { backendConnectionId: 'local', nodeId: 'n1', messageId: 'm1' }, anchor, page: null, origin: null, scroll: null }}
      onClose={onClose} onGo={() => {}} />
  )],
];

function Host({ surface }: { surface: Surface }) {
  const [anchor, setAnchor] = React.useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <button type="button" ref={setAnchor}>Open</button>
      {open && anchor && surface(anchor, () => setOpen(false))}
      {!open && <p>closed</p>}
    </>
  );
}

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe("anchored popovers and the phone's Back", () => {
  it.each(surfaces)('Back closes %s and leaves the page where it is', (_name, surface) => {
    const page = vi.fn();
    const removePage = registerBackLayer(() => ({ level: 'page', back: page }));
    try {
      render(<Host surface={surface} />);
      expect(screen.queryByText('closed')).toBeNull();
      act(() => { backTarget()?.back(); });
      expect(screen.getByText('closed')).toBeTruthy();
      expect(page).not.toHaveBeenCalled();
    } finally {
      removePage();
    }
  });

  it.each(surfaces)('%s arms the system Back on a page with nothing else to go back to', (_name, surface) => {
    const view = render(<Host surface={surface} />);
    expect(hasBackLayer()).toBe(true);
    act(() => { backTarget()?.back(); });
    expect(screen.getByText('closed')).toBeTruthy();
    expect(hasBackLayer()).toBe(false);
    view.unmount();
  });
});
