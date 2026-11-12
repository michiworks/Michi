/**
 * A Kiro chat turn tells its page tools whether its session holds Approve
 * for me (KiroPageTurnAttribution.approveForMe): Kiro seeds that preset only
 * when it opens a session, so a host that hands the turn check-in material
 * mid-turn cannot make Kiro ask again (W3-K). The flag is what the session's
 * Kiro process opened it with, read when the tool asks; a chat whose session
 * the process does not know counts as holding it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultHost } from '../src/core/defaultHost';
import { AcpAgentSession } from '../src/adapters/kiro/AcpAgentSession';
import type { AcpAgentRuntime } from '../src/adapters/kiro/AcpAgentRuntime';
import { KIRO_FLAVOR } from '../src/adapters/kiro/acpAgentFlavor';
import type { KiroPageTurnAttribution } from '../src/adapters/kiro/kiroProtocol';
import type { RuntimeToolProfile } from '../src/contract/types';
import { headless, interactive } from './owners';

type Seen = { session: KiroPageTurnAttribution | null; slot: KiroPageTurnAttribution | null };

/**
 * A Kiro runtime stand-in over one fake process. `presets` is what the
 * process opened the session with (undefined: it does not know the session);
 * the chat asks for the same, so no turn reopens it. Its one prompt records
 * what the session and its MCP turn window report mid-turn.
 */
function harness(options: { presets: readonly string[] | undefined; approveForMe?: boolean; toolProfile?: RuntimeToolProfile; owner?: 'interactive' | 'headless' }) {
    const seen: Seen = { session: null, slot: null };
    let slotGetter: (() => KiroPageTurnAttribution | null) | undefined;
    let session: AcpAgentSession;
    const client = {
        policyPresets: () => options.presets,
        async *prompt() {
            seen.session = session.getActivePageTurnAttribution();
            seen.slot = slotGetter?.() ?? null;
            yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
        },
    };
    const runtime = {
        host: createDefaultHost({ logLevel: 'silent', approveForMe: true }),
        engine: 'v3',
        flavor: KIRO_FLAVOR,
        standardAcp: false,
        approveForMe: options.approveForMe ?? true,
        policyPresetsFor: () => [...(options.presets ?? [])],
        ensureClient: async () => client,
        getClient: () => client,
        getCurrentMode: () => null,
        getCurrentModel: () => null,
        beginMcpSessionTurn: (_sid: string, getter: () => KiroPageTurnAttribution | null) => { slotGetter = getter; return () => { slotGetter = undefined; }; },
    } as unknown as AcpAgentRuntime;
    const owner = options.owner === 'headless' ? headless('node') : interactive('node');
    session = new AcpAgentSession('node', 'sid', runtime, '/w', { owner, ...(options.toolProfile ? { toolProfile: options.toolProfile } : {}) });
    return {
        session,
        async turn(): Promise<Seen> {
            for await (const _event of session.send('go', { turnId: 'turn-1', assistantMessageId: 'a-1' })) { /* drain */ }
            return seen;
        },
    };
}

const TURN = { turnId: 'turn-1', assistantId: 'a-1' };

describe('a Kiro chat turn reports whether its session holds Approve for me', () => {
    it('a session opened with the preset says so, to the session and to its MCP turn window', async () => {
        const h = harness({ presets: ['approve-for-me'] });
        const seen = await h.turn();
        assert.deepEqual(seen.session, { ...TURN, approveForMe: true });
        assert.deepEqual(seen.slot, { ...TURN, approveForMe: true }, 'the getter the MCP turn window reads');
        assert.equal(h.session.getActivePageTurnAttribution(), null, 'no turn, no attribution');
    });

    it('a session opened without it reports the turn alone', async () => {
        const seen = await harness({ presets: [] }).turn();
        assert.deepEqual(seen.session, TURN);
        assert.equal('approveForMe' in seen.session!, false);
        assert.deepEqual(seen.slot, TURN);
    });

    it('a session its Kiro process does not know counts as holding it', async () => {
        assert.deepEqual((await harness({ presets: undefined }).turn()).session, { ...TURN, approveForMe: true });
    });

    it('V (a tool-profile session) never holds it, whatever the process says', async () => {
        for (const presets of [['approve-for-me'], undefined]) {
            assert.deepEqual((await harness({ presets, toolProfile: { assistant: true } }).turn()).session, TURN, JSON.stringify(presets));
        }
    });

    it('a runtime without Approve for me (Kiro v2, Crew, another ACP agent) never reports it', async () => {
        for (const presets of [['approve-for-me'], undefined]) {
            assert.deepEqual((await harness({ presets, approveForMe: false }).turn()).session, TURN);
        }
    });

    it('an Agent Run has no page turn to report', async () => {
        assert.equal((await harness({ presets: ['approve-for-me'], owner: 'headless' }).turn()).session, null);
    });
});
