#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const pkg = JSON.parse(readFileSync(resolve(root, 'src/frontend/package.json'), 'utf8'))
const matrix = readFileSync(resolve(root, 'tests/matrix.yml'), 'utf8')
const legacyTestSh = readFileSync(resolve(root, 'tools/test/legacy-test.sh'), 'utf8')
const localBundleRunner = readFileSync(resolve(root, 'tools/test/bundles/run-bundle.mjs'), 'utf8')
const productionVitestConfig = readFileSync(resolve(root, 'src/frontend/vitest.production.config.ts'), 'utf8')
const runtimeManifest = readFileSync(resolve(root, 'tests/frontend/checks/runtime/manifest.json'), 'utf8')
const staticManifest = readFileSync(resolve(root, 'tests/frontend/checks/static/manifest.json'), 'utf8')
const viteConfig = readFileSync(resolve(root, 'src/frontend/vite.config.ts'), 'utf8')
const errors = []

function fail(message) {
  errors.push(message)
}

function requireScript(name) {
  if (!pkg.scripts?.[name]) {
    fail(`missing package script ${name}`)
  }
}

function requireFile(path) {
  if (!existsSync(resolve(root, path))) {
    fail(`missing file ${path}`)
  }
}

function legacyFastGateRuns(script) {
  return legacyTestSh.includes(`npm run ${script}`)
    || legacyTestSh.includes(`run_vitest_script ${script}`)
    || runtimeManifest.includes(`"script": "${script}"`)
    || staticManifest.includes(`"script": "${script}"`)
    || (script === 'test:property' && productionVitestConfig.includes('vitest.property.config'))
    || (script === 'check:frontend-state-machines' && productionVitestConfig.includes('vitest.model.config'))
    || (script === 'check:frontend-perf-regression' && productionVitestConfig.includes('vitest.perf.config'))
}

const coverageProfiles = [
  ['coverage:unit-core', 'src/frontend/vitest.unit-core.config.ts', 'coverage/unit-core'],
  ['coverage:public-renderers', 'src/frontend/vitest.public-renderers.config.ts', 'src/public-renderers'],
  ['coverage:bootstrap-hydration', 'src/frontend/vitest.bootstrap-hydration.config.ts', 'src/bootstrap'],
  ['coverage:workers', 'src/frontend/vitest.workers.config.ts', 'src/workers'],
  ['coverage:wasm-bridges', 'src/frontend/vitest.wasm-bridges.config.ts', 'src/wasm'],
  ['coverage:adapters-binary', 'src/frontend/vitest.adapters-binary.config.ts', 'src/adapters/binary'],
  ['coverage:composables-state', 'src/frontend/vitest.composables-state.config.ts', 'src/composables']
]

for (const [script, config, marker] of coverageProfiles) {
  requireScript(script)
  requireFile(config)
  const source = readFileSync(resolve(root, config), 'utf8')
  if (!source.includes(marker)) {
    fail(`${config} does not target ${marker}`)
  }
  if (!source.includes('thresholds')) {
    fail(`${config} has no coverage thresholds`)
  }
}

for (const script of [
  'test:property',
  'check:frontend-state-machines',
  'check:frontend-perf-regression',
  'check:worker-contracts',
  'check:a11y:deep',
  'check:frontend-test-governance',
  'prepare:playwright:fixtures',
  'capture:manual-layout-screenshots'
]) {
  requireScript(script)
}

const manualScreenshotScript = pkg.scripts?.['capture:manual-layout-screenshots'] ?? ''
if (!manualScreenshotScript.includes('prepare:playwright:fixtures')) {
  fail('capture:manual-layout-screenshots must refresh Playwright fixtures before capture')
}
if (!manualScreenshotScript.includes('manual/manual-layout-screenshots.spec.ts')) {
  fail('capture:manual-layout-screenshots must run the route-driven manual screenshot spec')
}
if (!manualScreenshotScript.includes('FSUSBLOG_DISABLE_HUMAN_READ_PROOF=1')) {
  fail('capture:manual-layout-screenshots must suppress human-read proof side effects during screenshot capture')
}
if (
  !viteConfig.includes('createServerFsAllow')
  || !viteConfig.includes('fs.realpathSync')
  || !viteConfig.includes("path.resolve(FRONTEND_ROOT, 'node_modules')")
  || !viteConfig.includes('fsusUiWasmDist')
  || !viteConfig.includes('tryRealpath(fsusUiWasmDist)')
) {
  fail('vite dev server fs allow must include real node_modules and local FsusUI wasm dist paths for manual screenshot assets')
}

for (const dir of ['tests/frontend/property', 'tests/frontend/model', 'tests/frontend/benchmarks']) {
  requireFile(dir)
}

for (const token of [
  'test:property',
  'check:frontend-state-machines',
  'check:worker-contracts',
  'check:frontend-perf-regression',
  'check:a11y:deep',
  'check:frontend-test-governance'
]) {
  if (!legacyFastGateRuns(token)) {
    fail(`fast gate does not run ${token}`)
  }
}

if (!matrix.includes('version: fsusblog-test-matrix-v2') || !matrix.includes('risk:') || !matrix.includes('coverage:')) {
  fail('tests/matrix.yml lacks v2 version/risk/coverage traceability fields')
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[frontend-test-governance] ${error}`)
  }
  process.exit(1)
}

console.log(`[frontend-test-governance] ok profiles=${coverageProfiles.length}`)
