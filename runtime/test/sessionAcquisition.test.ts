import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession } from '../src/contract/types';
import { assertSessionReusable, sessionIdentity } from '../src/core/sessionAcquisition';
import { headless, interactive } from './owners';

describe('sessionIdentity', () => {
    it('gives a headless owner its key as the public id', () => {
        assert.deepEqual(sessionIdentity(headless('attempt'), undefined), { owner: headless('attempt'), id: 'attempt' });
        assert.deepEqual(sessionIdentity(headless('attempt'), 'attempt'), { owner: headless('attempt'), id: 'attempt' });
    });

    it('refuses a headless owner under another public id', () => {
        assert.throws(() => sessionIdentity(headless('attempt'), 'node'), /must equal attemptId/);
    });

    it('opens an interactive owner under the requested id, else its key', () => {
        assert.deepEqual(sessionIdentity(interactive('node'), 'other'), { owner: interactive('node'), id: 'other' });
        assert.deepEqual(sessionIdentity(interactive('node'), undefined), { owner: interactive('node'), id: 'node' });
    });

    it('makes the owner of a session whose host names none', () => {
        assert.deepEqual(sessionIdentity(undefined, 'node'), { owner: interactive('node'), id: 'node' });
        const minted = sessionIdentity(undefined, undefined);
        assert.ok(minted.id);
        assert.deepEqual(minted.owner, interactive(minted.id));
    });
});

describe('assertSessionReusable', () => {
    const session = (fields: Partial<AgentSession> = {}) => {
        let touches = 0;
        const value = { id: 'node', owner: interactive('node'), runtimeProfileHash: 'hash', touch: () => { touches++; }, ...fields } as AgentSession;
        return { value, touches: () => touches };
    };
    const expected = { owner: interactive('node'), ownerUserId: 'user', profileHash: 'hash' };
    const userOf = () => 'user';

    it('returns and touches a session of the same owner, user and profile', () => {
        const s = session();
        assert.equal(assertSessionReusable(s.value, expected, userOf), s.value);
        assert.equal(s.touches(), 1);
    });

    it('refuses another owner with the release wording', () => {
        const s = session();
        assert.throws(() => assertSessionReusable(s.value, { ...expected, owner: headless('node') }, userOf), /Owner mismatch/);
        assert.equal(s.touches(), 0);
    });

    it('takes a session without an owner as the interactive owner of its id', () => {
        assert.ok(assertSessionReusable(session({ owner: undefined }).value, expected, userOf));
        assert.throws(() => assertSessionReusable(session({ owner: undefined, id: 'other' }).value, expected, userOf), /Owner mismatch/);
    });

    it('refuses another user, and an unknown user even when none is expected', () => {
        assert.throws(() => assertSessionReusable(session().value, expected, () => 'other'), /user owner mismatch/);
        assert.throws(() => assertSessionReusable(session().value, { ...expected, ownerUserId: undefined }, () => 'user'), /user owner mismatch/);
        assert.ok(assertSessionReusable(session().value, { ...expected, ownerUserId: null }, () => null));
        assert.throws(() => assertSessionReusable(session().value, { ...expected, ownerUserId: null }, () => undefined), /user owner mismatch/);
    });

    it('refuses another profile hash', () => {
        assert.throws(() => assertSessionReusable(session().value, { ...expected, profileHash: 'other' }, userOf), /session node runtime profile hash mismatch/);
        assert.throws(() => assertSessionReusable(session({ runtimeProfileHash: undefined }).value, expected, userOf), /profile hash mismatch/);
        assert.ok(assertSessionReusable(session({ runtimeProfileHash: undefined }).value, { ...expected, profileHash: undefined }, userOf));
    });
});
