import os from 'node:os';
import path from 'node:path';
import type { SkillScanRoot } from '../../core/skills';

/** kiro-cli's skill folders for a cwd: a workspace skill wins over the user's of the same name. */
export function kiroSkillRoots(cwd: string): SkillScanRoot[] {
    return [
        { dir: path.join(cwd, '.kiro', 'skills'), scope: 'workspace' },
        { dir: path.join(os.homedir(), '.kiro', 'skills'), scope: 'user' },
    ];
}
