import { SCHEDULED_JOB_DEFAULTS, type ScheduledJobSettings } from 'michi-shared';
import { getMichiConfigPaths } from '../configPaths';
import { readJsonConfig, updateJsonConfig } from '../jsonConfigStore';
import { JobValidationError } from './validation';

const { configPath } = getMichiConfigPaths();

export function getScheduledJobSettings(): ScheduledJobSettings {
  const stored = readJsonConfig(configPath)?.scheduledJobs;
  return {
    sessionMode: stored?.sessionMode === 'fresh' || stored?.sessionMode === 'persistent' ? stored.sessionMode : SCHEDULED_JOB_DEFAULTS.sessionMode,
    requireCreateApproval: stored?.requireCreateApproval === true,
  };
}

/** Saves the fields the body names; any other field is ignored. */
export function updateScheduledJobSettings(raw: unknown): ScheduledJobSettings {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const patch: Partial<ScheduledJobSettings> = {};
  if (body.sessionMode !== undefined) {
    if (body.sessionMode !== 'fresh' && body.sessionMode !== 'persistent') {
      throw new JobValidationError('Thread mode must be fresh or persistent');
    }
    patch.sessionMode = body.sessionMode;
  }
  if (body.requireCreateApproval !== undefined) {
    if (typeof body.requireCreateApproval !== 'boolean') {
      throw new JobValidationError('requireCreateApproval must be true or false');
    }
    patch.requireCreateApproval = body.requireCreateApproval;
  }
  if (Object.keys(patch).length === 0) {
    throw new JobValidationError('Pass sessionMode or requireCreateApproval');
  }
  updateJsonConfig(configPath, (existing) => ({
    ...existing, scheduledJobs: { ...existing.scheduledJobs, ...patch },
  }));
  return getScheduledJobSettings();
}

/** Whether an agent must ask before creating a job; an unreadable config asks. */
export function scheduledJobCreateNeedsApproval(): boolean {
  try {
    return getScheduledJobSettings().requireCreateApproval;
  } catch {
    return true;
  }
}
