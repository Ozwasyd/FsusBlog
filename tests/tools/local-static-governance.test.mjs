import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildLocalStaticManifest,
  extractChainedNpmScripts,
  planLocalStaticCommands
} from '../../tools/test/local-static-governance.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const staticManifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/frontend/checks/static/manifest.json'), 'utf8'))
const frontendPackage = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'))

test('local static manifest expands the production views chain without omitting a check', () => {
  const chainedScripts = extractChainedNpmScripts(frontendPackage.scripts['check:views-constraints'])
  const manifest = buildLocalStaticManifest(staticManifest, frontendPackage.scripts)
  const expanded = manifest.commands.filter((entry) => entry.id.startsWith('views-constraints:'))

  assert.deepEqual(expanded[0].command, ['node', '../../tests/frontend/checks/static/check-views-constraints.mjs'])
  assert.deepEqual(expanded.slice(1).map((entry) => entry.script), chainedScripts)
  assert.deepEqual(
    manifest.commands.filter((entry) => !entry.id.startsWith('views-constraints:')).map((entry) => entry.id),
    staticManifest.commands.filter((entry) => entry.id !== 'views-constraints').map((entry) => entry.id)
  )
  const writes = expanded.filter((entry) => entry.access === 'write').map((entry) => entry.script)
  assert.deepEqual(writes, [
    'check:dom-depth-static',
    'check:route-asset-budget',
    'check:public-performance-batch'
  ])
})

test('local static plan starts independent evidence writers with the first saturated wave', () => {
  const manifest = buildLocalStaticManifest(staticManifest, frontendPackage.scripts)
  const plan = planLocalStaticCommands(manifest)

  assert.deepEqual(plan.initial.slice(0, 6).map((entry) => entry.id), [
    'asset-size-budget',
    'views-constraints:dom-depth-static',
    'views-constraints:route-asset-budget',
    'historical-residue-fixture',
    'views-constraints:fsusui-typecheck-modes',
    'test-execution-optimization'
  ])
  assert.deepEqual(plan.final.map((entry) => entry.id), ['views-constraints:public-performance-batch'])
})
