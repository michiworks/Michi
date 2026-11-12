import { AgentRunContractError } from 'michi-shared';
import { ExecutionEnvironmentError } from '../agents/runs/executionEnvironment';
import { AgentEnableBlockedError } from '../services/agentDefinitionService';
import { AgentRunActionError } from '../services/agentRunActions';
import { DomainError } from '../services/domainErrors';
import { log } from '../services/logger';

const CODES: Record<number, string> = { 400: 'invalid_request', 401: 'unauthenticated', 409: 'conflict' };

/**
 * How the Custom Agent, Agent Run and Run action routes answer an error.
 * Their services refuse a request with a plain Error that names the reason;
 * anything else, including the coded Errors SQLite and the file system throw,
 * is internal: logged, and answered 500 without its text.
 */
export function agentRouteError(error: unknown, route: string): { status: number; code: string; message: string } {
  if (error instanceof AgentRunActionError) {
    return { status: error.code === 'not_found' ? 404 : 400, code: error.code, message: error.message };
  }
  // A reused operation id with another request (withCommandReceipt), or another refused command.
  if (error instanceof DomainError) {
    const status = error.kind === 'conflict' ? 409 : 400;
    return { status, code: CODES[status], message: error.message };
  }
  if (error instanceof AgentRunContractError || error instanceof AgentEnableBlockedError || error instanceof ExecutionEnvironmentError) {
    return { status: 400, code: CODES[400], message: error.message };
  }
  if (error instanceof Error && error.constructor === Error && !('code' in error)) {
    const status = /authentication required|ownerUserId is required/.test(error.message) ? 401
      : /conflict|reused with a different payload|expected Attempt/.test(error.message) ? 409 : 400;
    return { status, code: CODES[status], message: error.message };
  }
  log.error('http', `${route} failed`, { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  return { status: 500, code: 'internal_error', message: 'Internal server error' };
}
