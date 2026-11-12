import { describe, expect, it } from 'vitest';
import { metaAgentRuntimeLabel } from './runtimeCopy';

describe('metaAgentRuntimeLabel', () => {
  it('names a global runtime the Meta agent may follow even when it is not one of its own', () => {
    expect(metaAgentRuntimeLabel('antigravity')).toBe('Antigravity');
    expect(metaAgentRuntimeLabel('kiro')).toBe('Kiro');
    expect(metaAgentRuntimeLabel('mystery')).toBe('mystery');
  });
});
