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
const appVue = read('src/frontend/src/App.vue')
const publicShell = read('src/frontend/src/components/public/PublicBlogLayoutShell.vue')
const runtimeGatePath = path.join(repoRoot, 'src/frontend/src/bootstrap/runtimeGate.ts')
const runtimeActivation = read('src/frontend/src/bootstrap/runtimeActivation.ts')
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
const routeTitleChunkIndex = viteConfig.indexOf("id.includes('/src/router/routeTitleContract.ts')")
const fullAppRouterChunkIndex = viteConfig.indexOf(
  "id.includes('/src/bootstrap/fullApp.ts') || id.includes('/src/router/')"
)
assert(routeTitleChunkIndex >= 0, 'route title contract must share the public route core chunk')
assert(
  routeTitleChunkIndex < fullAppRouterChunkIndex,
  'route title contract chunk rule must precede the generic full-app router rule to avoid a production cycle'
)

assert(
  !fullApp.includes("import { FsuMotion } from '@ozwasyd/element-plus/motion'"),
  'FsuMotion must not be a static fullApp import'
)
assert(fullApp.includes('installDeferredFsusMotion'), 'fullApp must defer FsuMotion installation')
assert(fullApp.includes('scheduleRuntimeActivation'), 'full app runtime must stay behind runtimeActivation policy')
assert(fullApp.includes("scheduleRuntimeActivation('takeover')"), 'public takeover must activate runtime without a second intent')
assert(fullApp.includes("scheduleRuntimeActivation('after-first-paint')"), 'direct SPA must use after-first-paint runtime activation')
assert(fullApp.includes('renderFullAppComposition'), 'FullApp composition root must own AppRuntime mounting')
assert(!fullApp.includes('scheduleFullAppRuntime'), 'legacy scheduleFullAppRuntime must not remain')
assert(!fullApp.includes('runtimeGate'), 'legacy runtimeGate must not remain')
assert(!fs.existsSync(runtimeGatePath), 'runtimeGate.ts must be deleted')
assert(runtimeActivation.includes("dormant"), 'runtimeActivation must expose dormant phase')
assert(runtimeActivation.includes('scheduleRuntimeActivation'), 'runtimeActivation must own schedule API')
assert(runtimeActivation.includes('activateRuntime'), 'runtimeActivation must own activate API')
assert(runtimeActivation.includes('resetRuntimeActivationForTests'), 'runtimeActivation must export test reset')
assert(!appVue.includes('AppRuntime'), 'App.vue must not host AppRuntime')
assert(!appVue.includes('runtimeGate'), 'App.vue must not import runtimeGate')
assert(!publicShell.includes('AppRuntime'), 'PublicBlogLayoutShell must not host AppRuntime')
assert(!publicShell.includes('clientRuntimeEnabled'), 'PublicBlogLayoutShell must not keep local runtime enable state')
assert(!publicShell.includes('MutationObserver'), 'PublicBlogLayoutShell must not observe hydration for runtime activation')
assert(!publicShell.includes('showRuntime'), 'PublicBlogLayoutShell must not accept showRuntime host prop')

console.log('[check-route-asset-budget-governance] ok')
