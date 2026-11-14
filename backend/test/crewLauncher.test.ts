import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('portable Crew launcher handles version, pinned Node, fallback and spaces', (t) => {
    const python = process.env.MICHI_CREW_TEST_PYTHON || 'python3';
    const check = spawnSync(python, ['--version']);
    if (check.error && (check.error as NodeJS.ErrnoException).code === 'ENOENT') return t.skip('Python is not installed; official Crew includes its own interpreter');
    const result = execFileSync(python, ['-I', path.join(__dirname, 'crewLauncher.test.py')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result, '');
});

test('crew-setup registers the remote current link, so the App follows michi update', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'michi-crew-setup-')));
    try {
        const home = path.join(root, 'home');
        const remote = path.join(home, '.local/share/michi/devdesktop');
        const release = (name: string) => {
            const dir = path.join(remote, 'releases', name);
            fs.mkdirSync(path.join(dir, 'backend/scripts'), { recursive: true });
            fs.mkdirSync(path.join(dir, 'backend/dist'));
            fs.copyFileSync(path.join(__dirname, '../scripts/crew-setup.cjs'), path.join(dir, 'backend/scripts/crew-setup.cjs'));
            for (const file of ['crewMcp.js', 'crewMcpHost.js']) fs.writeFileSync(path.join(dir, 'backend/dist', file), '');
            fs.cpSync(path.join(__dirname, '../../crew-app'), path.join(dir, 'crew-app'), { recursive: true });
            return dir;
        };
        const running = release(`${'a'.repeat(40)}-running`), older = release(`${'b'.repeat(40)}-older`);
        fs.symlinkSync(running, path.join(remote, 'current'));
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: root };
        delete env.MICHI_CREW_MCP_DIR;
        const prepare = (dir: string) => {
            const out = execFileSync(process.execPath, [path.join(dir, 'backend/scripts/crew-setup.cjs')], { env, encoding: 'utf8' });
            const prepared = /^Prepared App: (.+)$/m.exec(out)?.[1];
            assert.ok(prepared, out);
            const manifest = JSON.parse(fs.readFileSync(path.join(prepared, 'app.json'), 'utf8'));
            return { out, installDir: manifest.mcpServers.michi.env.MICHI_CREW_INSTALL_DIR };
        };

        const followed = prepare(running);
        assert.equal(followed.installDir, path.join(remote, 'current'));
        assert.match(followed.out, /needs no new Sync/);
        // From a build the link does not name, the App keeps that build's path.
        const pinned = prepare(older);
        assert.equal(pinned.installDir, older);
        assert.match(pinned.out, /Keep this Michi build at its current path/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
