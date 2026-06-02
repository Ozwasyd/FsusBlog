#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const pkg = JSON.parse(readFileSync(resolve(root, 'src/frontend/package.json'), 'utf8'))
const matrix = readFileSync(resolve(root, 'tests/matrix.yml'), 'utf8')
const testSh = readFileSync(resolve(root, 'tools/test.sh'), 'utf8')
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
  'check:frontend-test-governance'
]) {
  requireScript(script)
}

for (const dir of ['tests/frontend/property', 'tests/frontend/model', 'tests/frontend/benchmarks']) {
  requireFile(dir)
}

for (const token of [
  'npm run test:property',
  'npm run check:frontend-state-machines',
  'npm run check:worker-contracts',
  'npm run check:frontend-perf-regression',
  'npm run check:a11y:deep',
  'npm run check:frontend-test-governance'
]) {
  if (!testSh.includes(token)) {
    fail(`fast gate does not run ${token}`)
  }
}

if (!matrix.includes('requirements:') || !matrix.includes('risk:') || !matrix.includes('coverage:')) {
  fail('tests/matrix.yml lacks requirements/risk/coverage traceability fields')
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[frontend-test-governance] ${error}`)
  }
  process.exit(1)
}

console.log(`[frontend-test-governance] ok profiles=${coverageProfiles.length}`)
