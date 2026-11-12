import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallState } from '../../state/chatTypes';
import { parseCreatedScheduledJob } from './ScheduledJobReceipt';
import { TurnReceipts } from './TurnReceipts';

const nav = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('./scheduled/scheduledNav', () => ({ requestScheduledJobDetail: nav.open }));

const NEXT_RUN = Date.parse('2026-11-06T09:00:00Z');

const created = {
  status: 'created',
  job: {
    jobId: 'job-1',
    name: 'Morning digest',
    state: 'active',
    schedule: { kind: 'every', everySeconds: 86_400 },
    scheduleText: 'Every 1 day',
    nextRun: { at: new Date(NEXT_RUN).toISOString(), local: 'Nov 6, 2026, 18:00 GMT+9' },
    lastRun: null,
    permissionMode: 'ask',
    sessionMode: 'persistent',
    notify: true,
    timeoutSeconds: 1800,
    promptPreview: 'Summarize what changed overnight.',
  },
  next: 'Created without asking (the user\'s setting).',
};

/** An MCP result envelope, as Kiro/Claude/Codex report it. */
function tool(result: unknown, patch: Partial<ToolCallState> = {}): ToolCallState {
  return {
    id: 't1',
    title: 'mcp__michi__create_scheduled_job',
    status: 'completed',
    inputJson: JSON.stringify({ name: 'Morning digest' }),
    output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }] }),
    ...patch,
  };
}

afterEach(() => { cleanup(); nav.open.mockReset(); });

describe('parseCreatedScheduledJob', () => {
  it('reads the saved job from an MCP envelope or plain JSON', () => {
    const job = parseCreatedScheduledJob(tool(created));
    expect(job).toMatchObject({
      jobId: 'job-1', name: 'Morning digest', paused: false, nextRunAt: NEXT_RUN,
      permissionMode: 'ask', sessionMode: 'persistent', notify: true, timeoutSeconds: 1800,
      schedule: { kind: 'every', everySeconds: 86_400 },
    });
    expect(parseCreatedScheduledJob(tool(created, { title: 'create_scheduled_job', output: JSON.stringify(created) }))?.jobId).toBe('job-1');
  });

  it('reads the job a Crew michi_call_tool created, and nothing another wrapped tool returned', () => {
    const crew = (name: string) => tool(created, { title: 'michi_call_tool', inputJson: JSON.stringify({ tool: name, arguments: { name: 'Morning digest' } }) });
    expect(parseCreatedScheduledJob(crew('create_scheduled_job'))?.jobId).toBe('job-1');
    expect(parseCreatedScheduledJob(crew('update_scheduled_job'))).toBeNull();
  });

  it('ignores declined, failed, running and other tools', () => {
    expect(parseCreatedScheduledJob(tool({ status: 'declined', next: 'The user declined' }))).toBeNull();
    expect(parseCreatedScheduledJob(tool(created, { status: 'failed' }))).toBeNull();
    expect(parseCreatedScheduledJob(tool(created, { status: 'in_progress' }))).toBeNull();
    expect(parseCreatedScheduledJob(tool(created, { title: 'update_scheduled_job' }))).toBeNull();
    expect(parseCreatedScheduledJob(tool(created, { output: 'INVALID_ARGUMENT: Interval must be at least 1 minute' }))).toBeNull();
  });
});

describe('scheduled job rows under a reply', () => {
  it('says when the job runs and with what permission, opens it, and keeps the rest behind its chevron', () => {
    const dispatched = vi.spyOn(window, 'dispatchEvent');
    render(<TurnReceipts tools={[tool(created)]} backendConnectionId="local" />);
    const row = document.querySelector('[data-receipt="scheduled-job"]')!;
    expect(row.querySelector('.receipt-row__verb')!.textContent).toBe('Scheduled');
    expect(row.querySelector('.receipt-row__object')!.textContent).toBe('Morning digest');
    expect(row.querySelector('.receipt-row__meta')!.textContent).toBe('Every day · Ask');
    expect(row.querySelector('dl')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show job details' }));
    const facts = row.querySelector('dl')!;
    expect(facts.textContent).toMatch(/First run/);
    expect(facts.textContent).toContain('Ask · tool approvals wait for you');
    expect(facts.textContent).toContain('One ongoing thread · notify when done · 30 min limit');
    expect(facts.textContent).toContain('“Summarize what changed overnight.”');
    expect(screen.getByRole('button', { name: 'Hide job details' }).getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(nav.open).toHaveBeenCalledWith('job-1');
    expect(dispatched.mock.calls.some(([event]) => event.type === 'michi:nav-page'
      && (event as CustomEvent).detail?.page === 'scheduled')).toBe(true);
    dispatched.mockRestore();
  });

  it('names the workspace and a paused start, and offers no View for another computer', () => {
    const paused = { ...created, job: { ...created.job, state: 'paused', nextRun: null, workspace: { id: 'ws-a', name: 'Research' } } };
    render(<TurnReceipts tools={[tool(paused)]} backendConnectionId="remote-1" />);
    const row = document.querySelector('[data-receipt="scheduled-job"]')!;
    expect(row.querySelector('.receipt-row__meta')!.textContent).toBe('Every day · paused · Ask');
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show job details' }));
    expect(row.querySelector('dl')!.textContent).toContain('Research');
    expect(row.querySelector('dl')!.textContent).not.toContain('First run');
  });

  it('renders nothing without a created job', () => {
    const { container } = render(<TurnReceipts tools={[tool({ status: 'declined' })]} />);
    expect(container.innerHTML).toBe('');
  });
});
