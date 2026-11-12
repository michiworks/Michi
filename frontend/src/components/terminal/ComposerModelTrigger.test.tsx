import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerModelTrigger } from './ComposerModelTrigger';
import type { AgentCapabilities } from '../../services/api';

const capabilities: AgentCapabilities = {
  modes: true, permissions: true, models: true, providerModels: false, reasoning: true,
  supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: false, nativeResume: true, warmSessions: true, saveContext: true, spawnBranches: true,
};

function trigger(props: Partial<React.ComponentProps<typeof ComposerModelTrigger>> = {}) {
  return render(<ComposerModelTrigger toolbarTier={0} agentStatus={null}
    resolvedBinding={{ runtime: 'claude', model: 'opus', reasoning: 'high', provider: undefined, source: 'node' }}
    catalogCapabilities={{ ...capabilities, ultracode: true }} providerModels={[{ id: 'opus', label: 'Opus' }]}
    isStreaming={false} onOpenModelMenu={vi.fn()} {...props} />);
}

describe('ComposerModelTrigger — Ultracode', () => {
  // Desktop layout: the chip shows its model and effort labels.
  beforeEach(() => { vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('marks the chip while the chat runs it, and says so in its label', () => {
    const { container } = trigger({ ultracode: { enabled: true, available: true } });
    const chip = screen.getByRole('button', { name: /Model settings/ });
    expect(chip.getAttribute('aria-label')).toMatch(/High effort, Ultracode on/);
    expect(chip.getAttribute('title')).toMatch(/Ultracode on/);
    expect(container.querySelector('[data-ultracode="on"]')).not.toBeNull();
  });

  it('says when it is on but cannot run, and shows nothing while it is off or not offered', () => {
    const unavailable = trigger({ ultracode: { enabled: true, available: false } });
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(/Ultracode on, but unavailable/);
    expect(unavailable.container.querySelector('[data-ultracode="on"]')?.getAttribute('data-unavailable')).toBe('true');
    unavailable.unmount();
    const off = trigger({ ultracode: { enabled: false } });
    expect(screen.getByRole('button').getAttribute('aria-label')).not.toMatch(/Ultracode/);
    expect(off.container.querySelector('[data-ultracode]')).toBeNull();
    off.unmount();
    // A runtime without the capability ignores a stale choice.
    const other = trigger({ catalogCapabilities: capabilities, ultracode: { enabled: true } });
    expect(other.container.querySelector('[data-ultracode]')).toBeNull();
  });
});
