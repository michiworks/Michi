import { readFileSync } from 'node:fs';
import type { KnipConfig } from 'knip';

// Agent Desk's block code, mirrored under Desk's own paths (see its README.md). Only
// scripts/page-block-source-sync.mjs changes the copies, and the shims export what the Desk
// modules they stand in for export (shared/i18n.ts has Desk's LANGS, lang and setLang).
const VENDOR_BLOCKS = 'frontend/src/components/terminal/content/page/vendor-blocks';
const vendorManifest: { verbatim: string[]; patched: string[] } = JSON.parse(
  readFileSync(new URL(`./${VENDOR_BLOCKS}/manifest.json`, import.meta.url), 'utf8'),
);

const config: KnipConfig = {
  workspaces: {
    frontend: {
      entry: [
        'src/index.tsx!',
        'src/**/*.test.{ts,tsx}',
        'src/setupTests.ts',
      ],
      project: [
        'src/**/*.{ts,tsx}!',
        // Knip's Tailwind plugin reads @import and @plugin in CSS files of the project, which is
        // how index.css uses tailwindcss and @tailwindcss/typography.
        'src/**/*.css',
        // Stubs and fixtures that only tests import.
        '!src/test/**!',
        '!src/**/*TestData.ts!',
      ],
      ignoreDependencies: [
        // fonts.css loads their files by url('../../node_modules/…'), and vite.config.mts
        // resolves their directories by computed name. Knip reads neither.
        '@fontsource/geist',
        '@fontsource/geist-mono',
        '@fontsource/ibm-plex-mono',
        '@fontsource/ibm-plex-sans',
        '@fontsource/inter',
        '@fontsource-variable/source-serif-4',
        // Nothing imports it: it is declared so that npm installs this dependency of better-auth,
        // which Linux installs skipped, failing the Vite build (26ceae19).
        '@better-auth/core',
      ],
    },
    backend: {
      entry: [
        'src/server.ts!',
        'src/services/dbWorkerThread.ts!',
        'src/services/metaAgentMetricsWorker.ts!',
        'src/agents/pi/piSdkBundle.ts!',
        'test/**/*.test.ts',
        'scripts/**/*.{ts,mjs,cjs}',
      ],
      project: ['src/**/*.ts!'],
    },
    shared: {
      entry: ['src/index.ts!'],
      project: ['src/**/*.ts!'],
    },
    runtime: {
      entry: [
        'src/index.ts!',
        'src/adapters/crew/acp/main.ts!',
        'src/adapters/crew/crewMcpMain.ts!',
        'test/**/*.test.ts',
        'scripts/**/*.mjs',
      ],
      project: ['src/**/*.ts!'],
    },
    '.': {
      entry: [
        'electron/main.ts!',
        'electron/preload.ts!',
        'e2e/**/*.spec.ts',
        'e2e/playwright.config.ts',
        'scripts/**/*.test.mjs',
        // scripts/run-electron-smoke.mjs starts electron-<name>-smoke.cjs by name.
        'scripts/electron-*-smoke.cjs',
        // Pages acceptance runs, started by hand; the .mjs starts its .cjs under Electron.
        'scripts/pages-*-acceptance.{mjs,cjs}',
        'scripts/pages-real-runtime-inventory.mjs',
        'scripts/page-block-source-sync.mjs',
        'scripts/pi-baseline-run.mjs',
        'scripts/verify-claude-sdk-sidecar.mjs',
        'scripts/verification/*.mjs',
      ],
      project: ['electron/**/*.ts!', 'e2e/**/*.ts', 'scripts/**/*.{mjs,cjs}'],
      ignoreDependencies: [
        // scripts/electron-build.mjs runs it with `npm exec -- electron-builder`.
        'electron-builder',
      ],
      ignoreUnresolved: [
        // test:electron first changes cwd to backend, which owns ts-node.
        'ts-node/register',
        // A Vite dev-server URL that pages-real-ui-acceptance.mjs imports inside page.evaluate().
        '/src/state/pages/pageHelperDraft.ts',
      ],
    },
  },
  ignore: ['.claude/**', '**/dist/**', '**/build/**'],
  ignoreIssues: {
    [`${VENDOR_BLOCKS}/**`]: ['exports', 'types'],
    // A file Desk ships stays even when Michi imports none of it; an unused shim is still reported.
    ...Object.fromEntries(
      [...vendorManifest.verbatim, ...vendorManifest.patched].map((file) => [`${VENDOR_BLOCKS}/${file}`, ['files']]),
    ),
  },
  ignoreExportsUsedInFile: true,
  includeEntryExports: false,
  tags: ['-testonly'],
};

export default config;
