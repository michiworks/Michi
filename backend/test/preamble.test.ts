/**
 * Tests for preamble split: buildStableSystemPrompt + buildFirstTurnPrefix.
 *
 * The stable system prompt is what Claude sees via --append-system-prompt at
 * spawn time. It MUST be a pure constant so every warm session in the pool
 * has byte-identical spawn args (otherwise the pool key (cwd, model) is
 * not well-defined).
 *
 * The first-turn prefix is what gets prepended to the user's first real
 * message. It carries per-chat context (cwd manifest, file blocks, ancestors,
 * merge blocks).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildStableSystemPrompt,
    buildMetadataSystemPrompt,
    buildFirstTurnPrefix,
    buildPreamble,
} from '../src/agents/preamble';
import { artifactToolsForProfile } from '../src/agents/artifactToolNames';
import { MICHI_PREAMBLE_HEAD, MICHI_PREAMBLE_TAIL } from 'michi-shared';
import fs from 'node:fs';
import path from 'node:path';
import { setBuiltinSkillsForTests } from '../src/services/skills/builtin';
import { skillLibraryRoot, skillStatePath } from '../src/services/skills/paths';

describe('buildStableSystemPrompt', () => {
    test('SDK sessions permit native questions without replacing legacy runtime instructions', () => {
        assert.match(buildStableSystemPrompt('sentinel', true, true), /Use AskUserQuestion or the Michi ask_user tool/);
        assert.doesNotMatch(buildStableSystemPrompt('sentinel', true), /Use AskUserQuestion or the Michi ask_user tool/);
    });
    test("the assistant's head advertises none of the ordinary chat tools", () => {
        // Tools and wording an assistant session cannot use.
        const ordinaryOnly = [/save_artifact/, /spawn_branches/, /_scheduled_job/, /show_image/, /spawn_agent/, /`bash`/, /propose_multi_model_plan/,
            /Use AskUserQuestion or the Michi ask_user tool/];
        const previous = process.env.MICHI_SCHEDULED_JOBS;
        delete process.env.MICHI_SCHEDULED_JOBS;
        try {
            const ordinary = buildStableSystemPrompt('sentinel', true, true);
            for (const pattern of ordinaryOnly) assert.match(ordinary, pattern, `ordinary chats keep ${pattern}`);
            for (const prompt of [
                buildStableSystemPrompt('sentinel', true, false, 'assistant'),
                buildStableSystemPrompt('sentinel-followups-tool-overview', true, false, 'assistant'),
                buildPreamble({ enableFollowUps: true, cwd: '/tmp/x', toolCapabilities: 'assistant' }),
            ]) {
                for (const pattern of ordinaryOnly) assert.doesNotMatch(prompt, pattern);
                assert.match(prompt, /Michi assistant's own, described in this conversation's opening instructions/);
            }
            // Its structured questions go through Michi's ask_user tool.
            assert.match(buildStableSystemPrompt('sentinel', true, false, 'assistant'), /____michi_internal____ask_user/);
        } finally {
            if (previous === undefined) delete process.env.MICHI_SCHEDULED_JOBS;
            else process.env.MICHI_SCHEDULED_JOBS = previous;
        }
    });
    test("the Companion's head is its own: not the Spaces assistant, no native or MCP tools, no ask_user", () => {
        const spacesOnly = /You are Michi|Spaces|native tools|configured MCP tools|ask_user|AskUserQuestion|\[TITLE:|\[FOLLOW-UP|\[BRANCH-OVERVIEW:/;
        for (const prompt of [
            buildStableSystemPrompt('sentinel', false, false, 'companion'),
            buildStableSystemPrompt('sentinel-followups-tool-overview', true, true, 'companion'),
            buildMetadataSystemPrompt('sentinel', true, 'companion'),
            buildPreamble({ enableFollowUps: false, cwd: '/tmp/x', toolCapabilities: 'companion' }),
        ]) {
            assert.doesNotMatch(prompt, spacesOnly);
            // A check-in's closed profile (DESIGN-v2 §2.3): reads, guarded Michi-internal changes, its own tools.
            assert.match(prompt, /your only tools are Michi's read tools, guarded changes to the user's Pages, tasks, Today and goals inside Michi, and your own tools, described in this conversation's opening instructions/);
            assert.match(prompt, /no files, commands, web, other MCP servers or tool for asking the user questions/);
        }
        // V keeps its own head.
        assert.match(buildStableSystemPrompt('sentinel', false, false, 'assistant'), /^You are Michi, the user's own assistant across their workspaces/);
    });
    test('ordinary chats are pointed at the Tasks section before organizing tasks, and the other heads are not', () => {
        for (const prompt of [buildStableSystemPrompt('sentinel', true, true), buildPreamble({ enableFollowUps: true, cwd: '/tmp/x' })]) {
            assert.match(prompt, /Tasks section of the `pages-and-components` document with `michi_docs`/);
            assert.match(prompt, /plain question about them from it, read-only, and when there are none say so/);
            assert.match(prompt, /even a short answered question, is evidence for a Done task/);
        }
        for (const toolCapabilities of ['assistant', 'maintenance'] as const) {
            assert.doesNotMatch(buildPreamble({ enableFollowUps: true, cwd: '/tmp/x', toolCapabilities }), /Tasks section/);
        }
    });
    test('Spaces replies have their own Michi prompt without ordinary conversation metadata', () => {
        const metadata = /\[TITLE:|\[FOLLOW-UP|\[BRANCH-OVERVIEW:|set_branch_overview|set_follow_ups|structured metadata tool|branch-journal/;
        for (const enableFollowUps of [true, false]) {
            for (const mode of ['sentinel', 'sentinel-followups-tool-overview'] as const) {
                const prompt = buildStableSystemPrompt(mode, enableFollowUps, false, 'assistant');
                assert.match(prompt, /^You are Michi,/);
                assert.doesNotMatch(prompt, metadata);
            }
            const preamble = buildPreamble({ enableFollowUps, cwd: '/tmp/x', toolCapabilities: 'assistant' });
            assert.match(preamble, /^You are Michi,/);
            assert.doesNotMatch(preamble, metadata);
        }
        assert.match(buildStableSystemPrompt(), /\[TITLE:|\[FOLLOW-UP|\[BRANCH-OVERVIEW:/);
        assert.match(buildStableSystemPrompt('sentinel', false, false, 'maintenance'), /Scheduled maintenance mode/);
    });
    test('the artifact tools beyond save/update are named only for sessions that have them', () => {
        const lookup = /`list_artifacts` —|`search_artifacts` —|`delete_artifact` —/;
        const saveUpdate = '`update_artifact` — revise an existing artifact.';
        // An ordinary chat (no allow-list) and a warm-pool head name all three, after save/update.
        for (const prompt of [
            buildStableSystemPrompt('sentinel', true, true),
            buildPreamble({ enableFollowUps: true, cwd: '/tmp/x' }),
            buildStableSystemPrompt('sentinel', true, true, 'michi', artifactToolsForProfile(undefined)),
        ]) {
            assert.ok(prompt.includes(`${saveUpdate} \`list_artifacts\` — list this workspace's artifacts`), prompt.slice(0, 80));
            assert.match(prompt, /`search_artifacts` — find artifacts by keywords.*`delete_artifact` — remove an artifact/);
        }
        // An Agent Run's (or a primary Agent's) allow-list leaves them out, so the line reads as before them.
        const run = artifactToolsForProfile({ allowedToolNames: ['read', 'search_messages', 'submit_agent_result'] });
        assert.deepEqual(run, []);
        for (const prompt of [
            buildStableSystemPrompt('sentinel', false, false, undefined, run),
            buildPreamble({ enableFollowUps: false, cwd: '/tmp/x', artifactTools: run }),
        ]) {
            assert.doesNotMatch(prompt, lookup);
            assert.ok(prompt.includes(`${saveUpdate}\n`));
        }
        // A list naming some of them gets those.
        const some = buildMetadataSystemPrompt('sentinel', true, 'michi', artifactToolsForProfile({ allowedToolNames: ['search_artifacts'] }));
        assert.match(some, /`search_artifacts` —/);
        assert.doesNotMatch(some, /`list_artifacts` —|`delete_artifact` —/);
    });
    test('ordinary and Crew heads name multi-model plans unless the kill switch is set', () => {
        const previous = process.env.MICHI_DISABLE_MULTI_MODEL;
        try {
            delete process.env.MICHI_DISABLE_MULTI_MODEL;
            for (const prompt of [buildStableSystemPrompt('sentinel', true, true), buildPreamble({ enableFollowUps: true, cwd: '/tmp/x' })]) {
                assert.match(prompt, /- Multi-model: `list_ready_models` — runtimes and models ready right now\. `propose_multi_model_plan` —/);
                assert.match(prompt, /End your turn after proposing\. Branches of a plan cannot propose one\./);
            }
            assert.match(buildStableSystemPrompt('sentinel', true, false, 'crew'), /branching, multi-model plans, Agent Runs/);
            process.env.MICHI_DISABLE_MULTI_MODEL = '1';
            for (const prompt of [buildStableSystemPrompt('sentinel', true, true), buildPreamble({ enableFollowUps: true, cwd: '/tmp/x' })]) {
                assert.doesNotMatch(prompt, /list_ready_models|propose_multi_model_plan|Multi-model/);
                assert.match(prompt, /only when user explicitly asks to branch\/split\)\.\n- Agent Runs:/);
            }
            assert.match(buildStableSystemPrompt('sentinel', true, false, 'crew'), /branching, Agent Runs/);
        } finally {
            if (previous === undefined) delete process.env.MICHI_DISABLE_MULTI_MODEL;
            else process.env.MICHI_DISABLE_MULTI_MODEL = previous;
        }
    });
});

describe('buildFirstTurnPrefix', () => {
    test('renders reference-kind extraContexts', () => {
        const s = buildFirstTurnPrefix({
            cwd: '/tmp/x',
            extraContexts: [{ name: 'styleguide', filePath: 'docs/style.md', kind: 'reference' }],
        });
        assert.match(s, /### @styleguide/);
        assert.match(s, /Referenced file at: docs\/style\.md/);
    });

    test('renders link-type extraContexts as [Link: url] (never reads a file)', () => {
        const s = buildFirstTurnPrefix({
            cwd: '/tmp/x',
            extraContexts: [
                { name: 'stripe-refunds', filePath: '', url: 'https://stripe.com/docs/refunds', kind: 'reference' },
            ],
        });
        assert.match(s, /### @stripe-refunds/);
        assert.match(s, /\[Link: https:\/\/stripe\.com\/docs\/refunds\]/);
        // A link must NOT be rendered as a file reference.
        assert.doesNotMatch(s, /Referenced file at:/);
    });

    test('a native fork says the session is a branch of its parent in the same tree', () => {
        const s = buildFirstTurnPrefix({ cwd: '/tmp/x', nativeForkParentNodeId: 'n-parent', nativeForkParentTitle: 'Design "v1"\nreview' });
        assert.match(s, /a branch of the thread "Design v1 review" \(node n-parent\) in the same conversation tree/);
        assert.match(s, /the parent thread has continued on its own since/);
        assert.match(buildFirstTurnPrefix({ cwd: '/tmp/x', nativeForkParentNodeId: 'n-parent' }), /thread "Untitled thread" \(node n-parent\)/);
        assert.doesNotMatch(buildFirstTurnPrefix({ cwd: '/tmp/x', workspaceInstructions: 'be brief' }), /a branch of the thread/);
    });
});

describe('the artifact manifest', () => {
    const pinned = [
        { name: 'spec', filePath: '.contexts/spec.md' },
        { name: 'site', filePath: '', url: 'https://example.com/docs' },
    ];

    test('with a count: lists the pinned artifacts, then the total and how to find the rest', () => {
        // Each part of the prefix starts on a new line.
        assert.equal(buildFirstTurnPrefix({ cwd: '/tmp/x', contextManifest: pinned, artifactCount: 120 }), [
            '',
            'Pinned workspace artifacts (read with your filesystem tools when relevant; the user can also @-mention an artifact to inject its contents directly):',
            '- spec — .contexts/spec.md',
            '- site — https://example.com/docs',
            'This workspace has 120 artifacts in total; use `list_artifacts` to browse them and `search_artifacts` to find one by keyword; reference any of them as @name.',
        ].join('\n'));
    });

    test('artifacts but none pinned: still the count line', () => {
        assert.equal(
            buildFirstTurnPrefix({ cwd: '/tmp/x', artifactCount: 1 }),
            '\nThis workspace has 1 artifact, none pinned: use `list_artifacts` to browse them and `search_artifacts` to find one by keyword; reference any of them as @name.',
        );
        assert.match(buildFirstTurnPrefix({ cwd: '/tmp/x', contextManifest: [], artifactCount: 7 }), /^\nThis workspace has 7 artifacts, none pinned/);
    });

    test('no artifacts: nothing', () => {
        assert.equal(buildFirstTurnPrefix({ cwd: '/tmp/x', artifactCount: 0 }), '');
        assert.equal(buildFirstTurnPrefix({ cwd: '/tmp/x', contextManifest: [], artifactCount: 0 }), '');
        assert.equal(buildFirstTurnPrefix({ cwd: '/tmp/x' }), '');
    });

    test('a count below the listed entries counts the entries', () => {
        assert.match(buildFirstTurnPrefix({ cwd: '/tmp/x', contextManifest: pinned, artifactCount: 0 }), /This workspace has 2 artifacts in total/);
    });

    test('the count line points only to the lookup tools the session has', () => {
        assert.equal(buildFirstTurnPrefix({ cwd: '/tmp/x', contextManifest: pinned, artifactCount: 120, artifactTools: [] }), [
            '',
            'Pinned workspace artifacts (read with your filesystem tools when relevant; the user can also @-mention an artifact to inject its contents directly):',
            '- spec — .contexts/spec.md',
            '- site — https://example.com/docs',
            'This workspace has 120 artifacts in total; only the pinned ones are listed here.',
        ].join('\n'));
        assert.equal(buildFirstTurnPrefix({ cwd: '/tmp/x', artifactCount: 3, artifactTools: ['delete_artifact'] }),
            '\nThis workspace has 3 artifacts, none pinned; the user can @-mention one to share its contents.');
        assert.match(buildFirstTurnPrefix({ cwd: '/tmp/x', artifactCount: 3, artifactTools: ['list_artifacts'] }),
            /none pinned: use `list_artifacts` to browse them; reference any of them as @name\.$/);
        assert.match(buildFirstTurnPrefix({ cwd: '/tmp/x', artifactCount: 3, artifactTools: ['search_artifacts'] }),
            /none pinned: use `search_artifacts` to find one by keyword; reference any of them as @name\.$/);
        // buildPreamble (Pi, Kiro) passes the session's tools to its manifest as well.
        const preamble = buildPreamble({ cwd: '/tmp/x', enableFollowUps: true, contextManifest: pinned, artifactCount: 9, artifactTools: [] });
        assert.match(preamble, /This workspace has 9 artifacts in total; only the pinned ones are listed here\./);
        assert.doesNotMatch(preamble, /list_artifacts|search_artifacts/);
    });

    test("without a count (an older client's whole list) the entries are listed as before", () => {
        const s = buildFirstTurnPrefix({ cwd: '/tmp/x', contextManifest: pinned });
        assert.equal(s, [
            '',
            'Workspace context files available (read with your filesystem tools when relevant; the user can also @-mention to inject contents directly):',
            '- spec — .contexts/spec.md',
            '- site — https://example.com/docs',
        ].join('\n'));
    });

    test('the ordinary head names the artifact tools', () => {
        const head = buildMetadataSystemPrompt();
        for (const tool of ['save_artifact', 'update_artifact', 'list_artifacts', 'search_artifacts', 'delete_artifact']) {
            assert.ok(head.includes(`\`${tool}\``), tool);
        }
    });
});

describe('buildPreamble (legacy composition for Pi/Kiro)', () => {
    test('with enableFollowUps=true and contextManifest, includes stable head + variable section', () => {
        const stable = buildMetadataSystemPrompt();
        const full = buildPreamble({
            enableFollowUps: true,
            cwd: '/tmp/x',
            contextManifest: [{ name: 'spec', filePath: 'docs/spec.md' }],
        });
        assert.ok(full.includes(stable), 'full preamble should contain the stable head verbatim');
        assert.match(full, /Workspace context files available/);
        assert.match(full, /spec — docs\/spec\.md/);
    });
});

describe('the preamble markers the Michi peek reads', () => {
    // The peek hides Michi's preamble in a Kiro conversation Michi read back by
    // these exact lines (shared/src/michiPreamble.ts); keep them in step.
    test('opens with MICHI_PREAMBLE_HEAD and hands over with MICHI_PREAMBLE_TAIL', () => {
        for (const enableFollowUps of [true, false]) {
            for (const toolCapabilities of ['michi', 'crew'] as const) {
                const preamble = buildPreamble({ enableFollowUps, toolCapabilities, cwd: '/tmp/x', workspaceInstructions: 'Be brief.' });
                assert.ok(preamble.startsWith(`${MICHI_PREAMBLE_HEAD}\n`), 'starts with the head line');
                assert.ok(preamble.endsWith(`\n${MICHI_PREAMBLE_TAIL}\n`), 'ends with the tail line');
                assert.equal(preamble.split(`\n${MICHI_PREAMBLE_TAIL}\n`).length, 2, 'the tail line appears once');
            }
        }
    });
});

describe('buildFirstTurnPrefix: the skills a chat may load', () => {
  const skillFile = (name: string, description: string, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody.\n`;
  const library = (name: string, description: string, extra = '') => {
    fs.mkdirSync(path.join(skillLibraryRoot(), name), { recursive: true });
    fs.writeFileSync(path.join(skillLibraryRoot(), name, 'SKILL.md'), skillFile(name, description, extra));
  };
  const reset = () => {
    fs.rmSync(skillLibraryRoot(), { recursive: true, force: true });
    fs.rmSync(skillStatePath(), { force: true });
    setBuiltinSkillsForTests();
    delete process.env.MICHI_CLOUD;
  };

  test('names the library skills a runtime does not list itself and the built-in ones, by name and description; none without the field', (t) => {
    reset();
    t.after(reset);
    library('review', 'Review a diff.');
    library('mine', 'Run by hand.', 'disable-model-invocation: true\n');
    library('compare', 'My own compare.');
    setBuiltinSkillsForTests([['compare', skillFile('compare', 'Built-in compare.')], ['tidy', skillFile('tidy', 'x'.repeat(400))], ['slash', skillFile('slash', 'Slash only.', 'disable-model-invocation: true\n')]]);

    const unmounted = buildFirstTurnPrefix({ cwd: '/w', hostSkills: { librarySkillsLoaded: false } });
    assert.equal(unmounted, '\n' + [
      'Skills you can load with michi_skills (action=read) when a task matches one:',
      '- compare: My own compare.',
      '- review: Review a diff.',
      '- compare (built-in; read it with builtin: true): Built-in compare.',
      `- tidy (built-in): ${'x'.repeat(249)}…`,
    ].join('\n'));
    const mounted = buildFirstTurnPrefix({ cwd: '/w', hostSkills: { librarySkillsLoaded: true } });
    assert.doesNotMatch(mounted, /- review:/, 'a runtime that mounts the library lists it itself');
    assert.match(mounted, /- compare \(built-in; read it with builtin: true\): Built-in compare\./);
    assert.equal(buildFirstTurnPrefix({ cwd: '/w' }), '', 'Agent Runs, the assistant and maintenance name none');
    process.env.MICHI_CLOUD = '1';
    assert.equal(buildFirstTurnPrefix({ cwd: '/w', hostSkills: { librarySkillsLoaded: false } }), '', 'cloud mode keeps no skills');
  });

  test('stops at its size cap and says how many more michi_skills lists', (t) => {
    reset();
    t.after(reset);
    setBuiltinSkillsForTests(Array.from({ length: 40 }, (_, index) => [`s${index}`, skillFile(`s${index}`, 'y'.repeat(240))] as const));
    const prefix = buildFirstTurnPrefix({ cwd: '/w', hostSkills: { librarySkillsLoaded: true } });
    const listed = prefix.split('\n').filter((line) => line.startsWith('- ')).length;
    assert.ok(listed > 0 && listed < 40);
    assert.ok(prefix.endsWith(`(${40 - listed} more: michi_skills action=list)`));
    assert.ok(prefix.length < 6500);
  });
});
