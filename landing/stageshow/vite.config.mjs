// Builds the stageshow hero into one self-contained IIFE + one CSS file in
// ../assets/ss/ (React, react-dom and lucide-react bundled in). No plugin:
// Vite's own esbuild compiles the TSX. Dependencies come from the stageshow
// workspace's node_modules (SS_NODE_MODULES overrides), so landing/ needs no
// package.json of its own.
//
//   node <ss>/node_modules/vite/bin/vite.js build --config landing/stageshow/vite.config.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NM = process.env.SS_NODE_MODULES
  || path.resolve(HERE, '../../node_modules')
const dep = (name) => ({ find: new RegExp(`^${name}(/.*)?$`), replacement: path.join(NM, name) + '$1' })

export default defineConfig({
  root: HERE,
  logLevel: 'warn',
  define: { 'process.env.NODE_ENV': '"production"' },
  esbuild: { jsx: 'automatic' },
  resolve: { alias: [dep('react-dom'), dep('react'), dep('lucide-react')] },
  build: {
    outDir: path.resolve(HERE, '../assets/ss'),
    emptyOutDir: true,
    target: 'es2020',
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(HERE, 'main.tsx'),
      formats: ['iife'],
      name: 'MichiStageshowHero',
      fileName: () => 'stageshow-hero.js',
      cssFileName: 'stageshow-hero',
    },
  },
})
