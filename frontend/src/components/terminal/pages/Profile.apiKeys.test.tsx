import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfilePage from './Profile';

const store = vi.hoisted(() => ({ projects: [] as unknown[], agentStatus: null as unknown }));
const saveProviderKey = vi.hoisted(() => vi.fn());
const clearProviderKey = vi.hoisted(() => vi.fn());

vi.mock('../../../services/auth', () => ({
  useAuthSession: () => ({ user: { name: 'Test User', email: 'test@example.com', image: null } }),
}));
vi.mock('../../../services/signOut', () => ({ signOutAndReset: vi.fn() }));
vi.mock('../../../state/chatStore', () => ({
  useChatStore: () => store,
  useNodesSelector: (selector: (nodes: Record<string, never>) => unknown) => selector({}),
}));
vi.mock('../../../state/prefs', () => ({
  usePrefs: () => ({ prefs: { terminalPalette: 'bone' }, setPref: vi.fn() }),
}));
vi.mock('../../../services/api', () => ({
  fetchProfileActivity: vi.fn().mockRejectedValue(new Error('not available')),
  saveProviderKey,
  clearProviderKey,
}));
vi.mock('../../ui/ConfirmDialog', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));

function provider(id: string, label: string, hasKey: boolean) {
  return { id, label, keyLabel: `${label} API key`, envVars: [], defaultModel: `${id}-default`, supportsReasoning: false, hasKey };
}

describe('Profile API keys', () => {
  const reloads: Array<unknown> = [];
  const onReload = (event: Event) => reloads.push((event as CustomEvent).detail);

  beforeEach(() => {
    reloads.length = 0;
    window.addEventListener('michi:reload-agent-status', onReload);
    saveProviderKey.mockReset().mockResolvedValue({ ok: true });
    clearProviderKey.mockReset().mockResolvedValue({ ok: true });
    store.agentStatus = {
      runtime: 'pi', label: 'Pi', provider: 'deepseek', hasRequiredKey: true, availableRuntimes: [], capabilities: { apiKeys: true },
      providers: [provider('deepseek', 'DeepSeek', true), provider('cerebras', 'Cerebras', false)],
    };
  });

  afterEach(() => window.removeEventListener('michi:reload-agent-status', onReload));

  async function addCerebrasKey(key: string) {
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'cerebras' } });
    fireEvent.change(screen.getByPlaceholderText('Cerebras API key'), { target: { value: key } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
  }

  it("lists the store's providers and reloads it silently after a saved key", async () => {
    render(<ProfilePage />);
    expect(await screen.findByText('DeepSeek')).toBeTruthy();

    await addCerebrasKey('csk-new');
    await waitFor(() => expect(saveProviderKey).toHaveBeenCalledExactlyOnceWith('cerebras', 'csk-new'));
    // Cerebras is not the active provider, so its key must not open the key window.
    await waitFor(() => expect(reloads).toEqual([{ silent: true }]));
  });

  it('shows a save that throws and frees the row', async () => {
    saveProviderKey.mockRejectedValueOnce(new Error('Remote connection is unavailable'));
    render(<ProfilePage />);

    await addCerebrasKey('csk-new');
    expect(await screen.findByText('Remote connection is unavailable')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect((screen.getByPlaceholderText('Cerebras API key') as HTMLInputElement).disabled).toBe(false);
    expect(reloads).toEqual([]);
  });

  it('shows a clear that throws and frees the row', async () => {
    clearProviderKey.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<ProfilePage />);

    const row = (await screen.findByText('DeepSeek')).closest('.key-row') as HTMLElement;
    await act(async () => { within(row).getByRole('button', { name: 'Remove' }).click(); });
    expect(await within(row).findByText('Failed to fetch')).toBeTruthy();
    expect((within(row).getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
