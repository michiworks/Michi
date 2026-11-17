import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ContextList from './ContextList';
import type { ArtifactEntry } from '../../../state/chatTypes';

const NOW = 1_716_000_000_000;
const ctx = (
  id: string,
  name: string,
  opts: Partial<ArtifactEntry> = {},
): ArtifactEntry => ({
  id,
  name,
  filePath: `path/${name}`,
  size: 1024,
  type: 'doc',
  source: 'user',
  createdAt: NOW,
  updatedAt: NOW,
  ...opts,
});

function renderRow(props: Partial<React.ComponentProps<typeof ContextList>> = {}) {
  return render(
    <ContextList
      artifacts={[ctx('1', 'a.md')]}
      filter=""
      selectedContextId={null}
      onSelect={() => {}}
      onPin={() => {}}
      onDelete={() => {}}
      onOpen={() => {}}
      onAdd={() => {}}
      {...props}
    />,
  );
}

describe('ContextList', () => {
  it('groups artifacts by type (Documents / Files / Images / Links)', () => {
    render(
      <ContextList
        artifacts={[
          ctx('1', 'a.md', { type: 'doc' }),
          ctx('2', 'b.ts', { type: 'file' }),
          ctx('3', 'diagram', { type: 'image' }),
          ctx('4', 'stripe-api', { type: 'link', filePath: '', url: 'https://stripe.com' }),
        ]}
        filter=""
        selectedContextId={null}
        onSelect={() => {}}
        onPin={() => {}}
        onDelete={() => {}}
        onOpen={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByText(/documents/i)).not.toBeNull();
    expect(screen.getByText(/^files/i)).not.toBeNull();
    expect(screen.getByText(/images/i)).not.toBeNull();
    expect(screen.getByText(/links/i)).not.toBeNull();
    // Link row renders its url as the meta line.
    expect(screen.queryByText('https://stripe.com')).not.toBeNull();
  });

  it('sorts favorite artifacts to the top of their group', () => {
    render(
      <ContextList
        artifacts={[
          ctx('1', 'older.md', { createdAt: NOW }),
          ctx('2', 'favorite.md', { createdAt: NOW - 1000, pinnedAt: NOW }),
        ]}
        filter=""
        selectedContextId={null}
        onSelect={() => {}}
        onPin={() => {}}
        onDelete={() => {}}
        onOpen={() => {}}
        onAdd={() => {}}
      />,
    );
    const names = screen.getAllByText(/\.md$/).map((n) => n.textContent);
    expect(names[0]).toBe('favorite.md');
  });

  it('describes a favorite as removable without implying auto-injection', () => {
    const onPin = vi.fn();
    renderRow({
      artifacts: [ctx('1', 'a.md', { pinnedAt: NOW })],
      onPin,
    });
    const favoriteButton = screen.getByRole('button', { name: 'Remove a.md from favorites' });
    expect(favoriteButton.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(favoriteButton);
    expect(onPin).toHaveBeenCalledWith('1');
  });

  it('deletes from the row\'s trash button, without selecting the row', () => {
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    renderRow({
      artifacts: [ctx('1', 'a.md')],
      onDelete,
      onSelect,
    });
    fireEvent.click(screen.getByLabelText(/delete a\.md/i));
    expect(onDelete).toHaveBeenCalledWith('1');
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'a.md' }));
    expect(onSelect).toHaveBeenCalledWith('1');
  });

  it('says a search found nothing, with Clear search, and what goes here when there is nothing', () => {
    const onClearFilter = vi.fn();
    const view = renderRow({ filter: 'zzz', onClearFilter });
    expect(screen.getByRole('status').textContent).toBe('No matches for “zzz”');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onClearFilter).toHaveBeenCalledOnce();
    view.unmount();
    renderRow({ artifacts: [] });
    expect(screen.getByText('no artifacts yet — add one above')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('filter hides non-matching artifacts', () => {
    render(
      <ContextList
        artifacts={[ctx('1', 'apples.md'), ctx('2', 'bananas.md')]}
        filter="app"
        selectedContextId={null}
        onSelect={() => {}}
        onPin={() => {}}
        onDelete={() => {}}
        onOpen={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.queryByText('apples.md')).not.toBeNull();
    expect(screen.queryByText('bananas.md')).toBeNull();
  });
});
