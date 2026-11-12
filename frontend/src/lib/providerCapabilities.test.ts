import { describe, expect, it } from 'vitest';
import { providerRequiresUserKey, providerModelLocked, providerOptionSuffix, verifyModelFor } from './providerCapabilities';

describe('provider capability helpers', () => {
  it('treats built-in providers as keyless and model-locked', () => {
    const provider = {
      id: 'openrouter-free',
      label: 'OpenRouter Free Trial',
      keyLabel: 'Built-in OpenRouter trial',
      envVars: ['OPENROUTER_FREE_API_KEY'],
      defaultModel: 'openrouter/owl-alpha',
      supportsReasoning: false,
      requiresUserKey: false,
      modelLocked: true,
      hasKey: true,
    };

    expect(providerRequiresUserKey(provider)).toBe(false);
    expect(providerModelLocked(provider)).toBe(true);
    expect(providerOptionSuffix(provider)).toBe(' - built-in');
  });

  it('verifies a key against the selected model of the active provider and the default of any other', () => {
    const status = { provider: 'google', model: 'gemini-4-argon-pro' };
    expect(verifyModelFor({ id: 'google', defaultModel: 'gemini-4-argon' }, status)).toBe('gemini-4-argon-pro');
    expect(verifyModelFor({ id: 'cerebras', defaultModel: 'gpt-oss-120b' }, status)).toBe('gpt-oss-120b');
  });
});
