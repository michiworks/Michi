import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetaAgentGuardStatus } from 'michi-shared';
import { MetaAgentGuardAlert } from './MetaAgentGuardAlert';
import { useZhCnDefaultLocale } from '../../../../test/zhCnLocale';

const failure: MetaAgentGuardStatus = {
  state: 'failed', runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['execute_bash'],
  checkedAt: new Date(2026, 9, 23, 9, 41).getTime(),
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('MetaAgentGuardAlert', () => {
  it('writes when the check ran in English on a Chinese browser', () => {
    useZhCnDefaultLocale();
    render(<MetaAgentGuardAlert failures={[failure]} onRetry={vi.fn()} onChangeRuntime={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const details = screen.getByRole('alert').querySelector('dl')!;
    expect(details.textContent).toContain('Kiro · checked Oct 23, 09:41');
    expect(details.textContent).not.toMatch(/[年月日]/);
  });

  it('says what stopped for the toolset that failed: pages for Pages upkeep, check-ins for the check-ins', () => {
    const body = () => screen.getByRole('alert').querySelector('p')!.textContent;
    const view = render(<MetaAgentGuardAlert failures={[failure]} onRetry={vi.fn()} onChangeRuntime={vi.fn()} />);
    expect(body()).toContain('so this run did not start and pages won’t update.');
    view.unmount();
    const checkins = render(<MetaAgentGuardAlert failures={[{ ...failure, toolset: 'chat' }]} onRetry={vi.fn()} onChangeRuntime={vi.fn()} />);
    expect(body()).toContain('so this run did not start and check-ins won’t run.');
    expect(body()).not.toContain('pages');
    checkins.unmount();
    render(<MetaAgentGuardAlert failures={[failure, { ...failure, toolset: 'chat' }]} onRetry={vi.fn()} onChangeRuntime={vi.fn()} />);
    expect(body()).toContain('so these runs did not start and pages won’t update and check-ins won’t run.');
  });
});
