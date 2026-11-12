import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITY_KEYS } from 'michi-shared';
import { UNKNOWN_HARNESS } from 'michi-runtime/internal/core/descriptors';
import { ANTIGRAVITY_RUNTIME_DESCRIPTOR } from '../src/agents/antigravity/antigravityDescriptor';
const ANTIGRAVITY_HARNESS = ANTIGRAVITY_RUNTIME_DESCRIPTOR.harness;
import { CREW_HARNESS } from 'michi-runtime/internal/adapters/crew/crewDescriptor';
import { KIRO_HARNESS } from 'michi-runtime/internal/adapters/kiro/kiroDescriptor';
import { staticRuntimeDescriptor } from '../src/agents/runtimeStaticDescriptors';

const RUNTIMES = ['pi', 'codex', 'claude', 'kiro', 'crew', 'antigravity', 'cursor', 'grok'] as const;

describe('capabilityDescriptor', () => {
  test('every registered runtime has all capability slots', () => {
    for (const id of RUNTIMES) {
      const descriptor = staticRuntimeDescriptor(id).harness;
      for (const key of CAPABILITY_KEYS) {
        assert.equal(typeof descriptor[key].availability, 'string', `${id}.${key}`);
        assert.equal(typeof descriptor[key].confidence, 'string', `${id}.${key}`);
      }
    }
  });

  test('crew keeps Kiro basics; compaction goes through its Gateway, and App callers cannot steer', () => {
    // The static Kiro descriptor builds its v2 harness from KIRO_HARNESS, so it is an equal copy.
    assert.deepEqual(staticRuntimeDescriptor('kiro').harness, KIRO_HARNESS);
    assert.equal(staticRuntimeDescriptor('crew').harness, CREW_HARNESS);
    assert.equal(KIRO_HARNESS.compact.availability, 'native');
    // Gateway /compact on the App's own idle slot, not Kiro's private extension.
    assert.equal(CREW_HARNESS.compact.availability, 'native');
    assert.equal(CREW_HARNESS.compact.confidence, 'projected');
    assert.equal(CREW_HARNESS.steer.availability, 'invisible');
  });

  test('public Antigravity retains print CLI capabilities', () => {
    assert.equal(staticRuntimeDescriptor('antigravity').harness, ANTIGRAVITY_HARNESS);
    for (const key of ['nativeResume'] as const) {
      assert.equal(ANTIGRAVITY_HARNESS[key].availability, 'native', key);
    }
    for (const key of ['steer', 'compact', 'subagents', 'usage', 'permissions'] as const) {
      assert.equal(ANTIGRAVITY_HARNESS[key].availability, 'invisible', key);
    }
  });

  test('unregistered runtime ids fall back to the unknown descriptor', () => {
    for (const id of ['agy', 'nope', 'constructor', '__proto__']) {
      assert.equal(staticRuntimeDescriptor(id).harness, UNKNOWN_HARNESS, id);
    }
  });
});
