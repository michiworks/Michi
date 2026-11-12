// Live check (spends a few short prompts): what an idle release asks of real
// kiro-cli. Per engine, opens sessions on one process, gives each a marker,
// lets Kiro drop most of them (V3 session/close, V2 _kiro.dev/session/terminate),
// compares the process tree's memory and children, then loads a dropped
// session again and asks for its marker.
//   node --require ts-node/register test/kiroIdleClose.live.ts [v3|v2] [sessions]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from '../src/adapters/kiro/acpClient';
import type { KiroEngine } from '../src/adapters/kiro/kiroProtocol';

function tree(root: number): number[] {
    const out = [root];
    for (let i = 0; i < out.length; i += 1) {
        try {
            const kids = execFileSync('ps', ['-o', 'pid=', '--ppid', String(out[i])], { encoding: 'utf8' });
            out.push(...kids.split('\n').map((line) => Number(line.trim())).filter((pid) => pid > 0));
        } catch { /* no children */ }
    }
    return out;
}

function pssMb(pids: number[]): number {
    let kb = 0;
    for (const pid of pids) {
        try {
            const match = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
            kb += match ? Number(match[1]) : 0;
        } catch { /* exited */ }
    }
    return Math.round(kb / 1024);
}

async function reply(client: AcpClient, sid: string, text: string): Promise<string> {
    let out = '';
    for await (const update of client.prompt(sid, text)) {
        const u = (update as any).update ?? update;
        if (u?.sessionUpdate === 'agent_message_chunk') {
            const blocks = Array.isArray(u.content) ? u.content : [u.content];
            for (const block of blocks) if (block?.type === 'text') out += block.text;
        }
    }
    return out.trim();
}

async function snapshot(client: AcpClient, label: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const pids = tree((client as any).proc.pid);
    console.log(`${label.padEnd(28)} processes=${pids.length} pss=${pssMb(pids)}MB`);
}

async function main() {
    const engine = (process.argv[2] ?? 'v3') as KiroEngine;
    const count = Number(process.argv[3] ?? 4);
    const cwd = mkdtempSync(join(tmpdir(), `michi-idle-close-${engine}-`));
    const client = new AcpClient(undefined, cwd, undefined, engine, undefined, 'kiro', { spawnEnv: () => process.env });
    try {
        client.start();
        await client.initialize(60_000);
        console.log(`engine=${engine} close advertised=${!!client.capabilities?.sessionCapabilities?.close}`);
        await snapshot(client, 'started');
        const sids: string[] = [];
        for (let i = 0; i < count; i += 1) {
            const { sessionId } = await client.newSession([], {});
            sids.push(sessionId);
            const answer = await reply(client, sessionId, `Reply with exactly MARKER-${i}-${engine} and nothing else.`);
            console.log(`session ${i} ${sessionId} answered ${JSON.stringify(answer)}`);
        }
        await snapshot(client, `${count} sessions`);
        for (const sid of sids.slice(0, -1)) {
            const closed = await client.closeNativeSession(sid, 10_000);
            client.destroySession(sid);
            if (!closed) console.log(`close not available for ${sid}`);
        }
        await snapshot(client, `closed ${count - 1}`);
        // Refill as many: with the dropped sessions freed, memory returns to about the peak.
        for (let i = 1; i < count; i += 1) {
            const { sessionId } = await client.newSession([], {});
            await reply(client, sessionId, `Reply with exactly REFILL-${i} and nothing else.`);
        }
        await snapshot(client, `refilled ${count - 1}`);
        const back = sids[0];
        await client.loadSession(back, cwd, [], 60_000, {});
        const recalled = await reply(client, back, 'What exact text did you reply with in your previous message? Answer with only that text.');
        console.log(`reloaded ${back} recalled ${JSON.stringify(recalled)} expected MARKER-0-${engine}: ${recalled.includes(`MARKER-0-${engine}`) ? 'OK' : 'MISMATCH'}`);
        await snapshot(client, 'reloaded 1');
    } finally {
        await client.shutdown();
    }
}
main().then(() => process.exit(0), (error) => { console.error('FAILED', error); process.exit(1); });
