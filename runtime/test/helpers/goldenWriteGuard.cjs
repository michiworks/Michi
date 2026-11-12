// Preloaded by the runtime test script. Switches that make golden tests rewrite their fixtures (UPDATE_GOLDEN
// and the like) count only with MICHI_GOLDEN_WRITE_CONFIRM=1: one left exported in a shell would re-baseline
// them silently. The backend's test/helpers/isolateUserDirs.cjs applies the same rule to backend tests.
const GOLDEN_CONFIRM = 'MICHI_GOLDEN_WRITE_CONFIRM';

if (process.env[GOLDEN_CONFIRM] !== '1') {
  for (const name of Object.keys(process.env)) {
    if (!name.includes('GOLDEN') || name === GOLDEN_CONFIRM) continue;
    delete process.env[name];
    console.error(`Ignoring ${name}: golden fixtures are rewritten only with ${GOLDEN_CONFIRM}=1 as well.`);
  }
}
