import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SourceTrace } from './SourceTrace';

describe('SourceTrace', () => {
  it('keeps maintenance execution separate and marks an unavailable evidence message', async () => {
    const onOpenSource = vi.fn().mockResolvedValue(false);
    render(<SourceTrace source={{
      kind: 'maintenance', jobId: 'job-1', runId: 'run-1', nodeId: 'maintainer', turnId: 't-run', assistantId: 'a-run',
      evidence: [{ nodeId: 'source-node', turnId: 't-source', assistantId: 'a-source' }],
    }} onOpenSource={onOpenSource} />);
    expect(screen.getByText('Maintenance run')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Source · Open exact message' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Source unavailable'));
    expect(onOpenSource).toHaveBeenCalledWith({ kind: 'chat', nodeId: 'source-node', turnId: 't-source', assistantId: 'a-source' });
    fireEvent.click(screen.getByRole('button', { name: 'Open maintenance run' }));
    await waitFor(() => expect(screen.getByText('Run unavailable')).toBeTruthy());
    expect(onOpenSource).toHaveBeenLastCalledWith({ kind: 'chat', nodeId: 'maintainer', turnId: 't-run', assistantId: 'a-run' });
  });

  const run = { kind: 'maintenance', jobId: 'job-1', runId: 'run-1', nodeId: 'maintainer', turnId: 't-run', assistantId: 'a-run' } as const;

  it('names no message for an old first run that listed every conversation it read', () => {
    render(<SourceTrace source={{ ...run, evidence: [
      { nodeId: 'n1', turnId: 't1', assistantId: 'a1' }, { nodeId: 'n2', turnId: 't2', assistantId: 'a2' }, { nodeId: 'n3', turnId: 't3', assistantId: 'a3' },
    ] }} onOpenSource={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Source · Open exact message' })).toBeNull();
    expect(screen.getByText('Read 3 conversations')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open maintenance run' })).toBeTruthy();
  });

  it('opens each cited message of a run that names what it read', () => {
    const onOpenSource = vi.fn();
    render(<SourceTrace source={{ ...run, read: { kind: 'conversations', count: 5 }, evidence: [
      { nodeId: 'n1', turnId: 't1', assistantId: 'a1' }, { nodeId: 'n2', turnId: 't2', assistantId: 'a2' },
    ] }} onOpenSource={onOpenSource} />);
    const buttons = screen.getAllByRole('button', { name: 'Source · Open exact message' });
    expect(buttons).toHaveLength(2);
    expect(screen.queryByText(/^Read /)).toBeNull();
    fireEvent.click(buttons[1]!);
    expect(onOpenSource).toHaveBeenCalledWith({ kind: 'chat', nodeId: 'n2', turnId: 't2', assistantId: 'a2' });
  });

  it('says what a run with no cited message read', () => {
    render(<SourceTrace source={{ ...run, read: { kind: 'workspace-homes', count: 2 }, evidence: [] }} onOpenSource={vi.fn()} />);
    expect(screen.getByText('Read 2 workspace homes')).toBeTruthy();
  });

  it('marks a cited question unavailable when it cannot be opened', async () => {
    const onOpenSource = vi.fn().mockResolvedValue(false);
    render(<SourceTrace source={{ ...run, read: { kind: 'conversations', count: 1 }, evidence: [
      { nodeId: 'n1', turnId: 't1', assistantId: 'a1', messageId: 'u1' },
    ] }} onOpenSource={onOpenSource} />);
    fireEvent.click(screen.getByRole('button', { name: 'Source · Open exact message' }));
    expect(onOpenSource).toHaveBeenCalledWith({ kind: 'chat', nodeId: 'n1', turnId: 't1', assistantId: 'u1' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Source unavailable'));
  });
});
