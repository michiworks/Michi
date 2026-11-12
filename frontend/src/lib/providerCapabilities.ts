import type { AgentProviderInfo, AgentStatus } from '../services/api';

export function providerRequiresUserKey(provider: Partial<AgentProviderInfo>): boolean {
  return provider.requiresUserKey !== false;
}

export function providerModelLocked(provider: Partial<AgentProviderInfo>): boolean {
  return provider.modelLocked === true;
}

export function providerOptionSuffix(provider: Partial<AgentProviderInfo>): string {
  if (!providerRequiresUserKey(provider)) {
    // Distinguish Bedrock from built-in providers like openrouter-free.
    if (provider.id === 'amazon-bedrock') {
      return provider.hasKey ? ' - configured' : ' - not configured';
    }
    return ' - built-in';
  }
  return provider.hasKey ? ' - key saved' : ' - no key';
}

/** True when switching to this provider should open the API-key window. */
export function shouldPromptForProviderKey(provider: Partial<AgentProviderInfo>): boolean {
  return providerRequiresUserKey(provider) && !provider.hasKey;
}

/**
 * The model a key check runs against: the active provider's selected model,
 * so the check does not surprise the user, or another provider's default.
 */
export function verifyModelFor(
  provider: Pick<AgentProviderInfo, 'id' | 'defaultModel'>,
  status: Pick<AgentStatus, 'provider' | 'model'>,
): string | undefined {
  return provider.id === status.provider ? status.model : provider.defaultModel;
}
