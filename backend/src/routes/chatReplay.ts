import { TURN_ERROR_CODES } from 'michi-shared';
import { getSavedTurn } from '../services/dbRepository';
import { BACKEND_RESTARTED_ERROR, BACKEND_RESTARTED_MESSAGE } from '../services/turnPersistence.recipes';

/** Called only after the route authorizes the chat; match the exact node/turn. */
export function chatReplayUnavailable(nodeId: string, turnId: string, selfTurn = false): { error: string; code: string } {
    // Not lost: the window's shared background feed delivers runtime self-turns.
    if (selfTurn) return { error: 'This reply arrives on the background feed.', code: 'turn_background_owned' };
    const turn = getSavedTurn(nodeId, turnId)?.turn;
    if (turn?.status === 'error' && turn.error === BACKEND_RESTARTED_ERROR) {
        return { error: BACKEND_RESTARTED_MESSAGE, code: BACKEND_RESTARTED_ERROR };
    }
    if (turn?.status === 'error' && turn.error) {
        return { error: turn.error, code: TURN_ERROR_CODES.replayUnavailable };
    }
    return {
        error: 'The live reply is no longer available. Reopen the conversation to check its saved state before retrying.',
        code: TURN_ERROR_CODES.replayUnavailable,
    };
}
