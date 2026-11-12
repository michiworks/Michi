import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BedrockConfigPanel } from './BedrockConfigPanel';

const api = vi.hoisted(() => ({
  getBedrockConfig: vi.fn(),
  saveBedrockConfig: vi.fn(),
  clearBedrockConfig: vi.fn(),
  verifyBedrockConfig: vi.fn(),
}));
vi.mock('../../../../services/api', () => api);
vi.mock('../../../ui/ConfirmDialog', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));

const provider = { id: 'amazon-bedrock', label: 'Amazon Bedrock', keyLabel: '', envVars: [], defaultModel: 'claude', supportsReasoning: true, requiresUserKey: false, hasKey: true };

describe('BedrockConfigPanel', () => {
  const onChanged = vi.fn();

  beforeEach(() => {
    onChanged.mockReset();
    api.getBedrockConfig.mockReset().mockResolvedValue({ configured: true, region: 'us-west-2', credentialSource: 'profile', envDetected: false });
    api.saveBedrockConfig.mockReset().mockResolvedValue({ ok: true });
    api.clearBedrockConfig.mockReset().mockResolvedValue({ ok: true });
  });

  it('uses the shared field and button styles, so keyboard focus shows a ring', async () => {
    const { container } = render(<BedrockConfigPanel provider={provider} onChanged={onChanged} />);
    await waitFor(() => expect(api.getBedrockConfig).toHaveBeenCalled());
    expect(container.querySelector('select')?.className).toBe('ui-select');
    for (const field of container.querySelectorAll<HTMLInputElement>('input:not([type="radio"])')) {
      expect(field.className).toBe('ui-input');
      expect(field.style.outline).toBe('');
    }
    for (const name of ['Save', 'Verify connection', 'Clear']) {
      expect(screen.getByRole('button', { name }).className).toContain('ui-btn');
    }
  });

  it('shows a save that throws and frees Save', async () => {
    api.saveBedrockConfig.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<BedrockConfigPanel provider={provider} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Failed to fetch')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows a clear the backend refuses and keeps the form', async () => {
    api.clearBedrockConfig.mockResolvedValueOnce({ ok: false, error: 'status 500' });
    render(<BedrockConfigPanel provider={provider} onChanged={onChanged} />);
    fireEvent.change(screen.getByPlaceholderText('Profile name (e.g. claude)'), { target: { value: 'work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(await screen.findByText('status 500')).toBeTruthy();
    expect((screen.getByPlaceholderText('Profile name (e.g. claude)') as HTMLInputElement).value).toBe('work');
    await waitFor(() => expect(onChanged).not.toHaveBeenCalled());
  });
});
