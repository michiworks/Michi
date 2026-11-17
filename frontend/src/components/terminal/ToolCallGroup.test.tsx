import { describe, expect, it } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ToolCallGroup } from './ToolCallGroup';
import type { SubagentInfo, ToolCallState } from '../../state/chatTypes';

describe('ToolCallGroup — empty', () => {
  it('returns null when tools is empty', () => {
    const { container } = render(<ToolCallGroup tools={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

function subInfo(partial: Partial<SubagentInfo> = {}): SubagentInfo {
  return {
    sessionId: partial.sessionId ?? 'sub-1',
    sessionName: partial.sessionName ?? 'sub-1',
    agentName: partial.agentName ?? 'Explore',
    initialQuery: partial.initialQuery ?? 'Explore Michi',
    status: partial.status ?? 'working',
    group: partial.group ?? 'default',
    dependsOn: partial.dependsOn ?? [],
    currentTool: partial.currentTool,
    ...(partial.activity ? { activity: partial.activity } : {}),
  };
}

describe('ToolCallGroup — relayed-tool filter', () => {
  it('hides tools relayed as subagent activity, keeps the parent\'s own running tools', () => {
    const detail = JSON.stringify({ subagent_type: 'Explore', description: 'Explore Michi' });
    const tools: ToolCallState[] = [
      { id: 't1', title: 'Agent', status: 'in_progress', kind: 'tool', detail },
      { id: 't2', title: 'Bash ls', status: 'running', kind: 'bash' },
      { id: 't3', title: 'Glob **/*.ts', status: 'running', kind: 'glob' },
      { id: 't4', title: 'Read src/index.ts', status: 'completed', kind: 'read' },
    ];
    const subagents = [subInfo({
      agentName: 'Explore',
      initialQuery: 'Explore Michi',
      activity: [{ id: 't2', kind: 'tool', title: 'Bash ls', status: 'in_progress' }],
    })];
    const { container } = render(<ToolCallGroup tools={tools} subagents={subagents} />);
    fireEvent.click(container.querySelector('button.agent-line')!);
    const steps = [...container.querySelectorAll('.agent-line-steps > li')].map((li) => li.textContent ?? '');
    expect(steps).toHaveLength(3);
    expect(steps.some((text) => text.includes('Explore'))).toBe(true);
    expect(steps.some((text) => /\bls\b/.test(text))).toBe(false);
  });

  it('keeps peers once every subagent has terminated (stale roster must not hide tools)', () => {
    const tools: ToolCallState[] = [
      { id: 't1', title: 'list_threads', status: 'completed', kind: 'tool' },
      { id: 't2', title: 'search_messages', status: 'completed', kind: 'tool' },
    ];
    const subagents = [
      subInfo({ sessionId: 's1', status: 'terminated' }),
      subInfo({ sessionId: 's2', status: 'terminated' }),
    ];
    const { container } = render(<ToolCallGroup tools={tools} subagents={subagents} />);
    fireEvent.click(container.querySelector('button.agent-line')!);
    const steps = [...container.querySelectorAll('.agent-line-steps > li')].map((li) => li.textContent ?? '');
    expect(steps).toHaveLength(2);
    expect(steps.join(' ')).toMatch(/List threads[\s\S]*Search messages/);
  });
});

describe('ToolCallGroup — permission-enriched title', () => {
  it('renders a Cursor MCP title without its permission prefix', () => {
    const tools: ToolCallState[] = [{ id: '1', title: 'michi-list_threads: list_threads', status: 'pending', kind: 'other' }];
    const { getByText, queryByText } = render(
      <ToolCallGroup tools={tools} />,
    );
    expect(getByText('Use list_threads…')).toBeTruthy();
    expect(queryByText('michi-list_threads: list_threads')).toBeNull();
  });
});
