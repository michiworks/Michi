import { fireEvent, render, within } from '@testing-library/react';
import type { AgentProviderInfo } from 'michi-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeFieldCatalog } from '../agents/AgentRuntimeProfileFields';
import { catalogKey } from '../agents/AgentRuntimeProfileFields';
import { ScheduledJobEditor, formValueFromJob, type JobFormValue } from './ScheduledJobEditor';

const state = vi.hoisted(() => ({ catalog: null as RuntimeFieldCatalog | null }));
vi.mock('../agents/useRuntimeFieldCatalog', () => ({ useRuntimeFieldCatalog: () => state.catalog }));
vi.mock('../../../services/api/scheduledJobs', () => ({
  previewScheduledJobSchedule: vi.fn(() => new Promise(() => {})),
  createScheduledJob: vi.fn(),
  updateScheduledJob: vi.fn(),
}));

const provider = (id: string, label: string): AgentProviderInfo => ({ id, label, keyLabel: label, envVars: [], defaultModel: '', supportsReasoning: false });
const catalog = (): RuntimeFieldCatalog => ({
  runtimes: [{ id: 'claude', label: 'Claude Code', available: true }, { id: 'pi', label: 'Pi', available: true }],
  providersFor: { pi: [provider('anthropic', 'Anthropic'), provider('openai', 'OpenAI')] },
  modelsFor: { [catalogKey('pi', 'anthropic')]: [{ id: 'opus', label: 'Opus' }] } as RuntimeFieldCatalog['modelsFor'],
  request: vi.fn(),
});

function editor(patch: Partial<JobFormValue>) {
  const initial = { ...formValueFromJob(null, { workspaceId: 'ws' }), name: 'Digest', prompt: 'Summarize', ...patch };
  render(<ScheduledJobEditor job={null} initial={initial} projects={[]} defaultWorkspaceId="ws" onClose={vi.fn()} onSaved={vi.fn()} />);
}
const picker = (id: string) => document.getElementById(id) as HTMLSelectElement;
const selectedText = (select: HTMLSelectElement) => select.selectedOptions[0]?.textContent;

beforeEach(() => { state.catalog = catalog(); });

describe('Scheduled job agent fields', () => {
  it('shows a saved provider the runtime no longer lists, rather than Runtime default', () => {
    editor({ runtimeId: 'pi', providerId: 'retired' });
    expect(picker('sched-provider').value).toBe('retired');
    expect(selectedText(picker('sched-provider'))).toBe('retired');
  });

  it('shows the saved agent while the runtime list is unavailable', () => {
    state.catalog = null;
    editor({ runtimeId: 'claude' });
    expect(picker('sched-runtime').value).toBe('claude');
    expect(selectedText(picker('sched-runtime'))).toBe('claude');
  });

  it('clears provider, model and reasoning when the agent changes', () => {
    editor({ runtimeId: 'pi', providerId: 'anthropic', modelId: 'opus', reasoning: 'high' });
    expect(within(picker('sched-model')).getAllByRole('option').map((option) => option.textContent)).toEqual(['Runtime default', 'Opus']);
    fireEvent.change(picker('sched-runtime'), { target: { value: 'claude' } });
    expect(picker('sched-runtime').value).toBe('claude');
    expect(document.getElementById('sched-provider')).toBeNull();
    expect(picker('sched-model').value).toBe('');
    expect(picker('sched-reasoning').value).toBe('');
  });
});
