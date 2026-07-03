#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(process.cwd(), '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function fail(message) {
  console.error(`[check-route-asset-budget-governance] ${message}`)
  process.exit(1)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

const packageJson = JSON.parse(read('src/frontend/package.json'))
const viteConfig = read('src/frontend/vite.config.ts')
const fullApp = read('src/frontend/src/bootstrap/fullApp.ts')
const budgetScriptPath = path.join(repoRoot, 'tools/frontend/check-route-asset-budget.mjs')

assert(
  packageJson.scripts?.['check:route-asset-budget'] === 'node ../../tools/frontend/check-route-asset-budget.mjs',
  'package.json must expose check:route-asset-budget'
)
assert(fs.existsSync(budgetScriptPath), 'tools/frontend/check-route-asset-budget.mjs must exist')

if (fs.existsSync(budgetScriptPath)) {
  const budgetScript = fs.readFileSync(budgetScriptPath, 'utf8')
  for (const token of [
    'routeBudgets',
    'public',
    'admin',
    'gzipSync',
    'brotliCompressSync',
    'asyncDependencyCount',
    'firstEntryBytes',
    'forbiddenPublicImports',
    'skipHostEntryCss',
    "routeEntry.route === 'public-shell'",
    'route-asset-budget.json'
  ]) {
    assert(budgetScript.includes(token), `route budget script missing ${token}`)
  }
}

assert(!viteConfig.includes('chunkSizeWarningLimit: 1000'), 'chunkSizeWarningLimit must not remain the only wide guardrail')
assert(!viteConfig.includes('minSize: 1'), 'manual chunk minSize must not force 1-byte chunk splitting')
assert(viteConfig.includes('minSize: 4096'), 'manual chunk minSize should use a non-trivial floor')

assert(
  !fullApp.includes("import { FsuMotion } from '@ozwasyd/element-plus/motion'"),
  'FsuMotion must not be a static fullApp import'
)
assert(fullApp.includes('installDeferredFsusMotion'), 'fullApp must defer FsuMotion installation')
assert(fullApp.includes('scheduleFullAppRuntime(Boolean(prepared.options.deferRuntime)'), 'full app runtime must stay behind runtime gate')

console.log('[check-route-asset-budget-governance] ok')
