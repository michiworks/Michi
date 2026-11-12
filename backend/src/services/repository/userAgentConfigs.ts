import { getDb } from '../db';

// --- user_agent_configs ---

export interface UserAgentConfigRow {
  user_id: string;
  runtime: string;
  provider: string;
  web_search_provider: string;
  provider_by_runtime: string;
  model_by_runtime: string;
  reasoning_by_runtime: string;
  native_resume_by_runtime: string;
  native_fork_by_runtime: string;
  workflows_by_runtime?: string;
  updated_at: number;
}

export function getUserAgentConfig(userId: string): UserAgentConfigRow | null {
  return (getDb().prepare('SELECT * FROM user_agent_configs WHERE user_id = ?').get(userId) as unknown as UserAgentConfigRow) ?? null;
}

export function upsertUserAgentConfig(
  userId: string,
  patch: Partial<Pick<UserAgentConfigRow, 'runtime' | 'provider' | 'web_search_provider' | 'provider_by_runtime' | 'model_by_runtime' | 'reasoning_by_runtime' | 'native_resume_by_runtime' | 'native_fork_by_runtime' | 'workflows_by_runtime'>>,
): void {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO user_agent_configs (user_id, runtime, provider, web_search_provider, provider_by_runtime, model_by_runtime, reasoning_by_runtime, native_resume_by_runtime, native_fork_by_runtime, workflows_by_runtime, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      runtime              = COALESCE(excluded.runtime, user_agent_configs.runtime),
      provider             = COALESCE(excluded.provider, user_agent_configs.provider),
      web_search_provider  = COALESCE(?, user_agent_configs.web_search_provider),
      provider_by_runtime  = COALESCE(?, user_agent_configs.provider_by_runtime),
      model_by_runtime     = COALESCE(excluded.model_by_runtime, user_agent_configs.model_by_runtime),
      reasoning_by_runtime = COALESCE(excluded.reasoning_by_runtime, user_agent_configs.reasoning_by_runtime),
      native_resume_by_runtime = COALESCE(?, user_agent_configs.native_resume_by_runtime),
      native_fork_by_runtime = COALESCE(?, user_agent_configs.native_fork_by_runtime),
      workflows_by_runtime = COALESCE(?, user_agent_configs.workflows_by_runtime),
      updated_at           = excluded.updated_at
  `).run(
    userId,
    patch.runtime ?? null,
    patch.provider ?? null,
    patch.web_search_provider ?? '',
    patch.provider_by_runtime ?? '{}',
    patch.model_by_runtime ?? null,
    patch.reasoning_by_runtime ?? null,
    patch.native_resume_by_runtime ?? '{}',
    patch.native_fork_by_runtime ?? '{}',
    patch.workflows_by_runtime ?? '{}',
    now,
    patch.web_search_provider ?? null,
    patch.provider_by_runtime ?? null,
    patch.native_resume_by_runtime ?? null,
    patch.native_fork_by_runtime ?? null,
    patch.workflows_by_runtime ?? null,
  );
}
