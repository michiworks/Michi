import { describe, expect, it } from 'vitest';
import { workflowProgress, type WorkflowNodeDto } from 'michi-shared';
import {
  cardLeafState,
  hasPhaseSteps,
  leafLabel,
  sectionDurationMs,
  sharedModel,
  splitToolLine,
  waitingNodeIds,
  workflowCardLeaves,
  workflowCardSections,
  workflowDisplayName,
} from './workflowCardModel';

const node = (id: string, patch: Partial<WorkflowNodeDto> = {}): WorkflowNodeDto => ({ id, kind: 'agent', title: id, status: 'queued', ...patch });

describe('workflowCardSections', () => {
  it('makes each Claude phase a section holding its agents', () => {
    const nodes = [
      node('phase:0', { kind: 'phase', title: 'Investigate', status: 'running' }),
      node('agent:0', { parentId: 'phase:0', status: 'completed' }),
      node('agent:1', { parentId: 'phase:0', status: 'running' }),
      node('phase:1', { kind: 'phase', title: 'Verify' }),
    ];
    const sections = workflowCardSections(nodes);
    expect(sections.map((section) => [section.node?.title, section.leaves.map((leaf) => leaf.id), section.state])).toEqual([
      ['Investigate', ['agent:0', 'agent:1'], 'running'],
      ['Verify', [], 'queued'],
    ]);
    expect(hasPhaseSteps(sections)).toBe(true);
  });

  it('keeps top-level steps between containers as untitled sections and flattens nested containers', () => {
    const nodes = [
      node('a', { kind: 'step', status: 'completed' }),
      node('fan', { kind: 'parallel', title: 'fan-out', status: 'running' }),
      node('loop', { kind: 'loop', title: 'retry', parentId: 'fan', status: 'running' }),
      node('b', { kind: 'step', parentId: 'loop', status: 'running' }),
      node('c', { kind: 'step', parentId: 'fan', status: 'completed' }),
      node('d', { kind: 'step' }),
    ];
    const sections = workflowCardSections(nodes);
    expect(sections.map((section) => [section.node?.id, section.leaves.map((leaf) => leaf.id), section.state])).toEqual([
      [undefined, ['a'], 'done'],
      ['fan', ['b', 'c'], 'running'],
      [undefined, ['d'], 'queued'],
    ]);
    expect(hasPhaseSteps(sections)).toBe(false);
  });

  it('reads a phase whose agents all ended as done, failures included', () => {
    const [section] = workflowCardSections([
      node('phase:0', { kind: 'phase', title: 'Investigate', status: 'failed' }),
      node('agent:0', { parentId: 'phase:0', status: 'completed' }),
      node('agent:1', { parentId: 'phase:0', status: 'failed' }),
    ]);
    expect(section.state).toBe('done');
  });

  it('lists a watch among its section\'s rows but counts only the steps, as the run\'s progress does', () => {
    const nodes = [
      node('wait-loop', { kind: 'loop', title: 'wait-loop', status: 'completed' }),
      node('ticker', { kind: 'watch', parentId: 'wait-loop', status: 'completed' }),
      node('react', { kind: 'step', parentId: 'wait-loop', status: 'completed' }),
      node('survey', { kind: 'parallel', title: 'survey', status: 'failed' }),
      node('count-lines', { kind: 'step', parentId: 'survey', status: 'completed' }),
      node('missing-file', { kind: 'step', parentId: 'survey', status: 'failed' }),
    ];
    expect(workflowCardSections(nodes).map((section) => section.leaves.map((leaf) => leaf.id))).toEqual([['ticker', 'react'], ['count-lines', 'missing-file']]);
    expect(workflowCardLeaves(nodes).map((leaf) => leaf.id)).toEqual(['react', 'count-lines', 'missing-file']);
    expect(workflowCardLeaves(nodes)).toHaveLength(workflowProgress({ nodes }).total);
  });
});

describe('workflow card labels', () => {
  it('drops the phase prefix the section already states', () => {
    const phase = node('phase:0', { kind: 'phase', title: 'Investigate' });
    expect(leafLabel(node('agent:0', { title: 'investigate:sdk-cli' }), phase)).toBe('sdk-cli');
    expect(leafLabel(node('agent:1', { title: 'verify:sdk-cli' }), phase)).toBe('verify:sdk-cli');
    expect(leafLabel(node('agent:2', { title: 'investigate:' }), phase)).toBe('investigate:');
    expect(leafLabel(node('agent:3', { title: 'investigate:x' }))).toBe('investigate:x');
  });

  it('humanizes slugs and leaves written names alone', () => {
    expect(workflowDisplayName('claude-runtime-ultracode-feasibility')).toBe('Claude runtime ultracode feasibility');
    expect(workflowDisplayName('read_probe')).toBe('Read probe');
    expect(workflowDisplayName('probe')).toBe('Probe');
    expect(workflowDisplayName('Audit the sidebar')).toBe('Audit the sidebar');
  });

  it('shortens Bedrock model ids and names the model every agent shares', () => {
    expect(sharedModel([node('a', { model: 'm' }), node('b', { model: 'm' }), node('c')])).toBe('m');
    expect(sharedModel([node('a', { model: 'm' }), node('b', { model: 'n' })])).toBeUndefined();
    expect(sharedModel([node('a')])).toBeUndefined();
  });

  it('splits a now line into its tool and argument', () => {
    expect(splitToolLine('Bash cd /tmp && ls -la')).toEqual({ tool: 'Bash', arg: 'cd /tmp && ls -la' });
    expect(splitToolLine('mcp__michi__read_node abc')).toEqual({ tool: 'mcp__michi__read_node', arg: 'abc' });
    expect(splitToolLine('Grep')).toEqual({ tool: 'Grep', arg: '' });
    expect(splitToolLine('running the suite')).toEqual({ arg: 'running the suite' });
  });
});

describe('workflow card states', () => {
  it('marks an open leaf an approval names as waiting', () => {
    const waiting = waitingNodeIds({ approvals: [{ id: 'a', nodeId: 'beta', title: 'Read', options: [], requestedAt: 1 }, { id: 'b', title: 'Session', options: [], requestedAt: 1 }] });
    expect([...waiting]).toEqual(['beta']);
    expect(cardLeafState(node('beta', { status: 'running' }), waiting)).toBe('waiting');
    expect(cardLeafState(node('beta', { status: 'completed' }), waiting)).toBe('completed');
    expect(cardLeafState(node('gamma', { status: 'running' }), waiting)).toBe('running');
  });

  it('times a section from its first start to its last end, live while it runs', () => {
    expect(sectionDurationMs([node('a', { startedAt: 1_000, endedAt: 4_000 }), node('b', { startedAt: 2_000, endedAt: 9_000 })], 50_000)).toBe(8_000);
    expect(sectionDurationMs([node('a', { startedAt: 1_000, status: 'running' })], 5_000)).toBe(4_000);
    expect(sectionDurationMs([node('a')], 5_000)).toBeUndefined();
  });
});
