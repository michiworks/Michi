import { envPositiveInt } from '../config/env';

/**
 * How long every runtime's approvals and questions wait for an answer
 * (MICHI_APPROVE_TIMEOUT_MS, default 5 minutes).
 */
export function approveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    return envPositiveInt('MICHI_APPROVE_TIMEOUT_MS', 5 * 60 * 1000, env);
}
