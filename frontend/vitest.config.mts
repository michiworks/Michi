import { availableParallelism } from 'node:os';
import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.mts';

// Vitest keeps an inherited NODE_ENV, and agent shells here inherit
// production from the Michi backend: React then loads its production build,
// which has no React.act. Vite reads NODE_ENV after loading this file.
process.env.NODE_ENV = 'test';

// These .ts tests still exercise React hooks or window.localStorage.
// Everything outside the audited logic directories stays in jsdom by default.
const domStateTests = [
  'chatReducers.digest',
  'digestOrchestration',
  'manageRoute',
  'navHistory',
  'perWindowActiveProject',
  'usePanePresenceIntegration',
  'usePanePresenceReporter',
  'workspacePersistence.scoped',
];
const nodeTests = [
  `src/state/!(${domStateTests.join('|')}).test.ts`,
  'src/lib/!(download|threadRowContextMenu|touchContextMenu).test.ts',
  'viteChunks.test.ts',
  'importCycles.test.ts',
];
// No CI runs these, so a stray .only must fail the run instead of narrowing it.
const commonTest = { globals: true, css: false, isolate: true, allowOnly: false };

export default mergeConfig(viteConfig, defineConfig({
  test: {
    ...commonTest,
    // Keep this limit only at the root so --maxWorkers can override it.
    maxWorkers: Math.min(4, availableParallelism()),
    forceRerunTriggers: [...configDefaults.forceRerunTriggers, '**/src/setupTests.ts'],
    projects: [
      {
        extends: './vite.config.mts',
        test: {
          ...commonTest,
          name: 'node',
          include: nodeTests,
          environment: 'node',
          pool: 'threads',
        },
      },
      {
        extends: './vite.config.mts',
        test: {
          ...commonTest,
          name: 'dom',
          exclude: [...configDefaults.exclude, ...nodeTests],
          environment: 'jsdom',
          pool: 'forks',
          setupFiles: ['./src/setupTests.ts'],
        },
      },
    ],
  },
}));
