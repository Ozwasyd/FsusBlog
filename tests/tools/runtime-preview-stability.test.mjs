import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateDistArtifacts } from '../frontend/checks/public/check-sw-search-runtime.mjs'
import { resolveRuntimeBrowserTimeoutPlan } from '../frontend/support/runtime-browser-timeout.mjs'
import { resolvePublicAotConcurrency } from '../../tools/test/resolve-public-aot-concurrency.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function createSearchDist(t, swSource) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runtime-preview-'))
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dist, 'wasm'), { recursive: true })
  for (const relative of [
    'wasm/search_basic.js',
    'wasm/search_basic.wasm',
    'wasm/search_simd.js',
    'wasm/search_simd.wasm'
  ]) fs.writeFileSync(path.join(dist, relative), 'fixture')
  fs.writeFileSync(path.join(dist, 'sw.js'), swSource)
  return dist
}

test('service worker runtime validation accepts the build-aware manifest path and rejects an absent default path', t => {
  const valid = createSearchDist(t, `
const SEARCH_PUBLIC_BASE = FRONTEND_BUILD_ID
  ? \`/release-derived/\${FRONTEND_BUILD_ID}/search\`
  : '/search'
const SEARCH_MANIFEST_PATH = \`\${SEARCH_PUBLIC_BASE}/index.manifest.aeds\`
// search-index.updated
// shell.invalidate
`)
  assert.doesNotThrow(() => validateDistArtifacts(valid))

  const invalid = createSearchDist(t, `
const SEARCH_PUBLIC_BASE = '/somewhere-else'
const SEARCH_MANIFEST_PATH = '/manifest.bin'
// search-index.updated
// shell.invalidate
`)
  assert.throws(() => validateDistArtifacts(invalid), /build-aware search manifest path/u)
})

test('browser runtime timeouts scale from machine contention while remaining bounded by the step deadline', () => {
  const unconstrained = resolveRuntimeBrowserTimeoutPlan({ env: {}, cpuCount: 8 })
  assert.equal(unconstrained.cpuGrant, 8)
  assert.equal(unconstrained.navigationTimeoutMs, 20_000)
  assert.equal(unconstrained.activeParallelWorkers, 1)
  assert.equal(unconstrained.requestTimeoutMs, 25_000)

  const contended = resolveRuntimeBrowserTimeoutPlan({
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '1',
      FSUSBLOG_STEP_DEADLINE_MS: '102000'
    },
    cpuCount: 8
  })
  assert.equal(contended.cpuGrant, 1)
  assert.ok(contended.navigationTimeoutMs > unconstrained.navigationTimeoutMs)
  assert.ok(contended.navigationTimeoutMs <= 102000 * 0.6)
  assert.ok(contended.requestTimeoutMs > unconstrained.requestTimeoutMs)
  assert.ok(contended.requestTimeoutMs <= 102000 * 0.7)
  assert.ok(contended.pageAuditTimeoutMs <= 102000 * 0.5)

  const pooled = resolveRuntimeBrowserTimeoutPlan({
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '8',
      FSUSBLOG_PARALLEL_ACTIVE_WORKERS: '8',
      FSUSBLOG_STEP_DEADLINE_MS: '120000'
    },
    cpuCount: 8
  })
  assert.equal(pooled.activeParallelWorkers, 8)
  assert.equal(pooled.effectiveCpuGrant, 1)
  assert.ok(pooled.navigationTimeoutMs > unconstrained.navigationTimeoutMs)
  assert.ok(pooled.navigationTimeoutMs <= 120000 * 0.6)
})

test('public AOT warmup concurrency derives independently bounded backend and I/O fanout from live grants', () => {
  const env = {
    FSUSBLOG_STEP_CPU_BUDGET: '2',
    FSUSBLOG_STEP_MEMORY_GIB: '4'
  }
  assert.equal(resolvePublicAotConcurrency({ env, cpuCount: 8, freeMemoryGiB: 8 }), 2)
  assert.equal(resolvePublicAotConcurrency({
    env,
    cpuCount: 8,
    freeMemoryGiB: 8,
    workersPerCpu: 2,
    memoryPerWorkerGiB: 0.125
  }), 4)
  assert.equal(resolvePublicAotConcurrency({
    env: { FSUSBLOG_STEP_CPU_BUDGET: '8', FSUSBLOG_STEP_MEMORY_GIB: '1' },
    cpuCount: 16,
    freeMemoryGiB: 16
  }), 2)
})

test('production runtime keeps hydration writes exact-once and gates all release-dist readers', () => {
  const legacy = fs.readFileSync(path.join(root, 'tools/test/legacy-test.sh'), 'utf8')
  const bundle = fs.readFileSync(path.join(root, 'tools/test/bundles/bundle-steps.mjs'), 'utf8')
  assert.equal((legacy.match(/npm run rebuild:public-hydration/gu) ?? []).length, 1)
  assert.match(legacy, /run_release_public_hydration_prepare_only\(\)[\s\S]*check:public-hydration-rebuild[\s\S]*rebuild:public-hydration/u)
  assert.match(legacy, /FSUSBLOG_RELEASE_HYDRATION_PREPARED_BY_DAG[\s\S]*reuse same-run release hydration write barrier/u)
  assert.match(bundle, /step\('release-public-hydration',[\s\S]*dependsOn: needsRuntime/u)
  const bootstrap = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8')
  const warmup = fs.readFileSync(path.join(root, 'tools/frontend/warm-public-aot-cache.mjs'), 'utf8')
  assert.match(bootstrap, /PublicAot__BackfillConcurrency=\$PUBLIC_AOT_BACKFILL_CONCURRENCY/u)
  assert.match(bootstrap, /PublicAot__SsrWorkerCount=\$PUBLIC_AOT_SSR_WORKER_COUNT/u)
  assert.equal((bootstrap.match(/ActiveReleaseFence__AllowSyntheticLocalFence=true/gu) ?? []).length, 2)
  assert.match(bootstrap, /server-public-ssr\.bundle\.mjs/u)
  assert.match(warmup, /workersPerCpu: 2/u)
  assert.match(warmup, /warm-public-aot-timing/u)
  for (const id of ['release-public']) {
    const start = bundle.indexOf(`step('${id}'`)
    assert.ok(start >= 0, `${id} step missing`)
    assert.match(bundle.slice(start, start + 500), /dependsOn: (?:\[\.\.\.)?needsStableReleaseHydration/u)
  }
  const integrationStart = bundle.indexOf("step('runtime-integration'")
  assert.match(bundle.slice(integrationStart, integrationStart + 500), /dependsOn: \['security-runtime-core'\]/u)
  const uxStart = bundle.indexOf("step('ux-risk-matrix'")
  assert.match(bundle.slice(uxStart, uxStart + 500), /dependsOn: \['release-public'\]/u)
})
