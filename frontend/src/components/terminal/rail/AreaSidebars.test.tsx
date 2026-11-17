import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledJobDto } from 'michi-shared';
import { ScheduledSidebar } from './AreaSidebars';
import { takeNewScheduledJobRequest } from '../scheduled/scheduledNav';

const store = vi.hoisted(() => ({
  jobs: [] as Partial<ScheduledJobDto>[],
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
}));
vi.mock('../scheduled/useScheduledJobs', () => ({
  useScheduledJobs: () => ({ jobs: store.jobs, loading: store.loading, error: store.error, unavailable: false, refresh: store.refresh }),
}));
vi.mock('../../../state/chatStore', () => ({ useChatProjects: () => ({ projects: [] }) }));
vi.mock('../../../state/metaAgent/useMetaAgentOverview', () => ({ useMetaAgentOverview: () => ({ kind: 'unavailable' }) }));

const digest = { id: 'job-1', name: 'Digest', workspaceId: 'w1', activeRunId: null, schedule: { kind: 'every', everySeconds: 3600 } } as Partial<ScheduledJobDto>;

describe('ScheduledSidebar', () => {
  beforeEach(() => {
    store.jobs = [];
    store.loading = false;
    store.error = null;
    store.refresh.mockReset();
    takeNewScheduledJobRequest();
  });

  it('says the list failed to load, keeps the jobs it had, and retries', () => {
    store.jobs = [digest];
    store.error = 'network down';
    render(<ScheduledSidebar selectedJobId={null} onSelectJob={() => {}} />);
    expect(screen.getByText('Couldn’t load jobs.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Digest' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(store.refresh).toHaveBeenCalledTimes(1);
  });

  it('offers New job on an empty list, asking the page for its editor', () => {
    const onNavigate = vi.fn();
    render(<ScheduledSidebar selectedJobId={null} onSelectJob={() => {}} onNavigate={onNavigate} />);
    expect(screen.getByText('No scheduled jobs yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New job' }));
    expect(takeNewScheduledJobRequest()).toBe(true);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
