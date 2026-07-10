import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createLocalBundleTiers,
  collectLogicalTierIds,
  localProfileSystemResources,
  validateLocalBundleSummary,
  validateLocalProfiles
} from '../../tools/test-matrix/local-profile.mjs'
import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs'
import { cleanLocalProductionOutputs } from '../../tools/test-matrix/fresh-production.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function tier(id, dependsOn = []) {
  return { id, dependsOn }
}

function profile(overrides = {}) {
  return {
    budgetMs: 300_000,
    maxParallel: 6,
    memoryGiB: 12,
    bundles: [
      { id: 'build-static', command: 'build', budgetMs: 70_000, dependsOn: [], members: ['a'] },
      { id: 'backend', command: 'backend', budgetMs: 60_000, dependsOn: ['build-static'], members: ['b'] },
      { id: 'frontend', command: 'frontend', budgetMs: 60_000, dependsOn: ['build-static'], members: ['c'] },
      { id: 'runtime-browser', command: 'runtime', budgetMs: 150_000, dependsOn: ['backend', 'frontend'], members: ['d'] },
      { id: 'performance-evidence', command: 'performance', budgetMs: 75_000, dependsOn: ['runtime-browser'], members: ['production'] }
    ],
    summaryOnly: [],
    ...overrides
  }
}

test('collectLogicalTierIds returns the complete dependency closure', () => {
  const tiers = [
    tier('production', ['summary']),
    tier('summary', ['a', 'b']),
    tier('a'),
    tier('b', ['c']),
    tier('c'),
    tier('unrelated')
  ]

  assert.deepEqual(
    collectLogicalTierIds(tiers, 'production'),
    ['a', 'b', 'c', 'production', 'summary']
  )
})

test('production profile requires exact fresh logical-tier coverage', () => {
  const tiers = [tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')]
  assert.deepEqual(validateLocalProfiles({ production: profile() }, tiers), [])

  const duplicate = profile({
    bundles: profile().bundles.map((bundle) => bundle.id === 'backend'
      ? { ...bundle, members: ['a', 'b'] }
      : bundle)
  })
  assert.ok(validateLocalProfiles({ production: duplicate }, tiers).some((error) => error.includes('mapped more than once: a')))

  const missing = profile({
    bundles: profile().bundles.map((bundle) => bundle.id === 'runtime-browser'
      ? { ...bundle, members: [] }
      : bundle)
  })
  assert.ok(validateLocalProfiles({ production: missing }, tiers).some((error) => error.includes('missing logical tier: d')))
})

test('production profile fixes the approved local resource and bundle contract', () => {
  const errors = validateLocalProfiles({ production: profile({ budgetMs: 299_999 }) }, [
    tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')
  ])
  assert.ok(errors.some((error) => error.includes('budgetMs must be 300000')))

  const wrongCount = profile({ bundles: profile().bundles.slice(0, 4) })
  assert.ok(validateLocalProfiles({ production: wrongCount }, [
    tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')
  ]).some((error) => error.includes('exactly 5 bundles')))
})

test('local production reserves the declared profile memory budget for independent bundles', () => {
  assert.deepEqual(
    localProfileSystemResources(profile(), { cpuCount: 8, load1: 3.5 }),
    { cpuCount: 8, availableMemoryGiB: 12, load1: 0 }
  )
})

test('repository production profile maps all 77 logical tiers exactly once', () => {
  const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
  const logicalTierIds = collectLogicalTierIds(matrix.tiers, 'production')

  assert.equal(logicalTierIds.length, 77)
  assert.equal(matrix.localProfiles.production.bundles.length, 5)
  assert.deepEqual(validateLocalProfiles(matrix.localProfiles, matrix.tiers), [])
})

test('post-build production evidence stays out of the build bundle without being omitted', () => {
  const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'))
  const bundles = new Map(matrix.localProfiles.production.bundles.map((bundle) => [bundle.id, bundle.members]))
  const deferred = [
    'cross-stack-contract',
    'privacy-zk-comment-matrix',
    'static-governance',
    'aeds-frame-cost',
    'aeds-compression-profile'
  ]

  for (const tierId of deferred) assert.equal(bundles.get('build-static').includes(tierId), false, tierId)
  for (const tierId of ['cross-stack-contract', 'privacy-zk-comment-matrix', 'static-governance']) {
    assert.ok(bundles.get('runtime-browser').includes(tierId), tierId)
  }
  for (const tierId of ['aeds-frame-cost', 'aeds-compression-profile']) {
    assert.ok(bundles.get('performance-evidence').includes(tierId), tierId)
  }
})

test('fresh production cleanup removes outputs and preserves dependency caches', () => {
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-fresh-production-'))
  const generated = [
    '.tmp/stale/result.json',
    'src/frontend/coverage/unit/result.json',
    'src/frontend/test-results/result.json',
    'src/frontend/dist/index.html',
    'src/frontend/public/wasm/aeds_decoder.wasm',
    'src/frontend/wasm/build-basic/aeds_decoder.wasm',
    'src/backend/wwwroot/index.html',
    'src/backend/bin/Debug/server.dll',
    'src/core/obj/project.assets.json',
    'tests/backend/bin/Debug/tests.dll'
  ]
  const caches = [
    'src/frontend/node_modules/vitest/package.json',
    'src/frontend/wasm/.emscripten-cache/sysroot/cache.txt',
    '.tmp/emscripten-cache/sysroot/cache.txt',
    '.nuget/packages/cache.txt'
  ]
  for (const file of [...generated, ...caches]) {
    fs.mkdirSync(path.dirname(path.join(temp, file)), { recursive: true })
    fs.writeFileSync(path.join(temp, file), 'fixture')
  }

  cleanLocalProductionOutputs(temp)

  for (const file of generated) assert.equal(fs.existsSync(path.join(temp, file)), false, file)
  for (const file of caches) assert.equal(fs.existsSync(path.join(temp, file)), true, file)
})

test('physical bundle DAG preserves dependencies, resources, and exact budgets', () => {
  const bundles = createLocalBundleTiers('production', profile())
  assert.deepEqual(bundles.map((bundle) => bundle.id), [
    'local-production-build-static',
    'local-production-backend',
    'local-production-frontend',
    'local-production-runtime-browser',
    'local-production-performance-evidence'
  ])
  assert.deepEqual(bundles[3].dependsOn, ['local-production-backend', 'local-production-frontend'])
  assert.equal(bundles[0].budgetMs, 70_000)
  assert.equal(bundles[0].artifacts[0], '.tmp/local-production/build-static/summary.json')
})

test('bundle evidence must prove every member with executed IDs and digests', () => {
  const valid = {
    schema: 'fsusblog.local-production.bundle.v1',
    physicalBundleId: 'backend',
    executionSource: 'fresh',
    status: 'success',
    members: {
      a: { status: 'success', testIds: ['backend:A'], artifactDigests: { trx: `sha256:${'a'.repeat(64)}` } },
      b: { status: 'success', testIds: ['backend:B'], artifactDigests: { trx: `sha256:${'b'.repeat(64)}` } }
    }
  }
  assert.deepEqual(validateLocalBundleSummary(valid, { id: 'backend', members: ['a', 'b'] }), [])
  assert.ok(validateLocalBundleSummary({ ...valid, members: { a: valid.members.a } }, {
    id: 'backend', members: ['a', 'b']
  }).some((error) => error.includes('missing member evidence: b')))
  assert.ok(validateLocalBundleSummary({
    ...valid,
    members: { ...valid.members, a: { ...valid.members.a, testIds: [] } }
  }, { id: 'backend', members: ['a', 'b'] }).some((error) => error.includes('a.testIds')))
})
