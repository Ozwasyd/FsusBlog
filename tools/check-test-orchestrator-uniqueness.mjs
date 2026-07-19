#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseMatrix } from './test-matrix/parse-matrix.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const fail = (message) => failures.push(message)

for (const relative of [
  `tools/test/${['legacy', 'test.sh'].join('-')}`,
  `tools/test/lanes/${['_legacy', 'sh'].join('.')}`,
  `tools/frontend/${['full', 'regression.sh'].join('-')}`,
  `tests/${['per', 'f'].join('')}`
]) {
  if (fs.existsSync(path.join(root, relative))) fail(`forbidden compatibility path exists: ${relative}`)
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'))
for (const alias of ['check:acceptance', 'check:full-regression']) {
  if (Object.hasOwn(packageJson.scripts ?? {}, alias)) fail(`deprecated frontend script exists: ${alias}`)
}

const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
const tiers = new Map(matrix.tiers.map((tier) => [tier.id, tier]))
if (tiers.size !== matrix.tiers.length) fail('matrix tier ids are not unique')

const migratedCommands = new Map([
  ['backend-api-integration', 'tools/test/lanes/backend-api-integration.sh'],
  ['backend-auth-state-machine', 'tools/test/lanes/backend-auth-state-machine.sh'],
  ['backend-concurrency', 'tools/test/lanes/backend-concurrency.sh'],
  ['backend-property', 'tools/test/lanes/backend-property.sh'],
  ['backend-golden', 'tools/test/lanes/backend-golden.sh'],
  ['backend-test-governance', 'tools/test/lanes/backend-test-governance.sh'],
  ['backend-mutation', 'tools/test/lanes/backend-mutation.sh'],
  ['release-mutation-critical-slice', 'tools/test/lanes/backend-mutation-critical.sh'],
  ['backend-nightly', 'tools/test/lanes/backend-nightly.sh'],
  ['cross-stack-contract', 'tools/test/lanes/cross-stack-contract.sh static']
])
const migratedExecutionKeys = new Set()
for (const [id, expectedCommand] of migratedCommands) {
  const tier = tiers.get(id)
  if (!tier) {
    fail(`migrated tier missing from matrix: ${id}`)
    continue
  }
  if (tier.command !== expectedCommand) fail(`${id} command must be ${expectedCommand}`)
  if (tier.executionKey) {
    if (migratedExecutionKeys.has(tier.executionKey)) fail(`migrated executionKey is duplicated: ${tier.executionKey}`)
    migratedExecutionKeys.add(tier.executionKey)
  }
}

const contract = tiers.get('browser-contract')
if (!contract || contract.requiredFor !== 'release-final' || !String(contract.command).includes('browser-contract')) {
  fail('browser-contract must remain the release-final browser correctness boundary')
}
for (const id of ['browser-diagnostics', 'browser-diagnostics-nightly', 'browser-diagnostics-manual']) {
  const tier = tiers.get(id)
  if (!tier || tier.requiredFor !== 'none') fail(`${id} must remain diagnostics-only`)
}

const bundleSource = fs.readFileSync(path.join(root, 'tools/test/bundles/bundle-steps.mjs'), 'utf8')
for (const command of [
  'tools/test/lanes/security-static.sh',
  'tools/test/lanes/security-runtime-core.sh',
  'tools/test/lanes/cross-stack-contract.sh static',
  'tools/test/lanes/cross-stack-contract.sh runtime'
]) {
  if (!bundleSource.includes(command)) fail(`production bundle does not reuse canonical leaf: ${command}`)
}

const supportSource = fs.readFileSync(path.join(root, 'tools/test/lanes/_suite-support.sh'), 'utf8')
for (const dispatchToken of ['\nMain() {', '\nUsage() {', 'case "$tier" in']) {
  if (supportSource.includes(dispatchToken)) fail(`source-only suite support contains tier dispatch: ${dispatchToken.trim()}`)
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[test-orchestrator] ${failure}`)
  process.exit(1)
}
console.log(`[test-orchestrator] passed: ${matrix.tiers.length} tiers, ${migratedCommands.size} migrated lanes`)
