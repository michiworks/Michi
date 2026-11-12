import { parseJsonAnswer } from 'michi-runtime/internal/core/structuredAnswer';
import type { StructuredCompletion, StructuredCompletionOptions } from '../types';
import { refreshBedrockCredentialsIfNeeded } from '../../services/bedrockCredentialManager';
import { resolveBedrockCredentials } from '../../services/bedrockCredentials';
import { getRuntimeDeps } from '../runtimeDeps';
import { abortable } from '../runtimeLifecycle';
import { loadPiAi } from './piAi';
import { getProviderInfo, providerUsesAwsCredentials, resolvePiModel } from './piProviders';

/**
 * PiRuntime.completeStructured: one request to the provider, with no tools
 * and no session. The provider APIs Pi speaks share no structured-output
 * switch, so the system prompt asks for the JSON object alone and the answer
 * is parsed from the reply; the host validates it. Provider, model and
 * credentials resolve as a Pi turn resolves them (PiSession.prepareTurn): the
 * caller's provider and model, else the user's configured ones.
 */

const RUNTIME_ID = 'pi';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 16_000;
const JSON_ONLY = 'Answer with the JSON object alone: no Markdown fences, no other text.';

export async function completePiStructured(opts: StructuredCompletionOptions): Promise<StructuredCompletion> {
  opts.signal?.throwIfAborted();
  // As for a Pi turn: a local backend uses the desktop's own configuration and keys.
  const ownerUserId = process.env.MICHI_CLOUD === '1' ? opts.ownerUserId ?? undefined : undefined;
  const deps = getRuntimeDeps();
  const provider = opts.provider?.trim() || deps.agentConfig.getAgentConfig(ownerUserId).provider;
  const modelId = opts.model?.trim() || deps.agentConfig.resolveModel(RUNTIME_ID, ownerUserId);
  const controller = new AbortController();
  const stop = () => controller.abort();
  opts.signal?.addEventListener('abort', stop, { once: true });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(stop, timeoutMs);
  timer.unref?.();
  try {
    const credentials: Record<string, unknown> = {};
    if (providerUsesAwsCredentials(provider)) {
      const creds = resolveBedrockCredentials();
      if (!creds) throw new Error('Amazon Bedrock credentials not configured — add them in Settings or set AWS_PROFILE + AWS_REGION env vars.');
      await abortable(refreshBedrockCredentialsIfNeeded(creds), controller.signal);
      credentials.region = creds.region;
      if (creds.bearerToken) credentials.bearerToken = creds.bearerToken;
      if (creds.profile) credentials.profile = creds.profile;
      if (creds.accessKeyId) {
        credentials.accessKeyId = creds.accessKeyId;
        credentials.secretAccessKey = creds.secretAccessKey;
      }
    } else {
      const apiKey = deps.providerKeys.getProviderApiKey(provider, ownerUserId);
      if (!apiKey) throw new Error(`${getProviderInfo(provider)?.name ?? provider} API key not configured`);
      credentials.apiKey = apiKey;
    }
    const piMod: any = await abortable(loadPiAi(), controller.signal);
    const model = await abortable(resolvePiModel(provider, modelId), controller.signal);
    const reasoning = getProviderInfo(provider)?.supportsReasoning === false ? 'off' : piMod.clampThinkingLevel(model, opts.reasoning ?? 'low');
    const context = {
      systemPrompt: `${opts.system}\n\n${JSON_ONLY}`,
      messages: [{ role: 'user', content: [{ type: 'text', text: opts.prompt }], timestamp: Date.now() }],
      tools: [],
    };
    for await (const event of piMod.streamSimple(model, context, {
      ...credentials, reasoning, maxTokens: MAX_OUTPUT_TOKENS, maxRetries: 1, timeoutMs, signal: controller.signal,
    })) {
      if (event.type === 'error') {
        throw new Error(event.reason === 'aborted' ? 'The structured answer was cancelled or timed out' : event.error?.errorMessage || 'The provider returned an error');
      }
      if (event.type !== 'done') continue;
      const message = event.message;
      const text = (message?.content ?? []).filter((part: any) => part?.type === 'text').map((part: any) => String(part.text ?? '')).join('');
      const usage = message?.usage;
      return {
        value: parseJsonAnswer(text),
        text,
        model: typeof message?.model === 'string' ? message.model : (model?.id ?? modelId ?? null),
        usage: usage ? {
          inputTokens: Number(usage.input) || 0, outputTokens: Number(usage.output) || 0,
          cacheReadTokens: Number(usage.cacheRead) || 0, cacheWriteTokens: Number(usage.cacheWrite) || 0,
        } : null,
      };
    }
    throw new Error('The provider returned no answer');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
  }
}
