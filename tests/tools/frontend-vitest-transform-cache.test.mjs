import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildTransformCacheIdentity,
  frontendVitestTransformCacheSchemas,
  invalidateTransformCache,
  openTransformCacheForPerf,
  prepareTransformCache,
  sealTransformCache,
  transformCacheConfigFiles,
  transformCacheEnvironment
} from '../../tools/test/frontend-vitest-transform-cache.mjs'
import {
  parseTransformCacheDebug,
  requireTransformCacheReuse,
  validateIsolatedPerfExecution
} from '../../tools/test/run-frontend-vitest-perf-isolated.mjs'
import transformCacheCoverageRuntime from '../../src/frontend/vitest.transform-cache-coverage.mjs'

function fixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-vitest-cache-'))
  fs.mkdirSync(path.join(rootDir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(rootDir, 'config/vitest.ts'), 'export default {}\n')
  const env = {
    FSUSBLOG_TEST_RUN_ID: 'run-1068',
    FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40),
    FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'b'.repeat(64),
    NODE_ENV: 'test',
    VITE_PUBLIC_SHELL_PROXY: '0'
  }
  const options = {
    rootDir,
    env,
    configFiles: ['config/vitest.ts'],
    packageVersions: { node: 'v24.0.0', vitest: '4.1.5', vite: '8.0.16' }
  }
  return { rootDir, env, options }
}

function changed(base, changes) {
  return buildTransformCacheIdentity({ ...base, ...changes })
}

test('transform cache identity invalidates every required source, config, toolchain, environment, and target input', () => {
  const { rootDir, options } = fixture()
  try {
    const baseline = buildTransformCacheIdentity(options)
    const mutations = [
      { sourceCommit: 'c'.repeat(40) },
      { sourceFingerprint: 'd'.repeat(64) },
      { packageVersions: { node: 'v25.0.0', vitest: '4.1.5', vite: '8.0.16' } },
      { packageVersions: { node: 'v24.0.0', vitest: '4.2.0', vite: '8.0.16' } },
      { packageVersions: { node: 'v24.0.0', vitest: '4.1.5', vite: '9.0.0' } },
      { env: { ...options.env, VITE_PUBLIC_SHELL_PROXY: '1' } },
      { env: { ...options.env, FSUSBLOG_USE_LOCAL_FSUSUI: '0' } },
      { targetIdentity: 'production:other-project' }
    ]
    for (const mutation of mutations) {
      assert.notEqual(changed(options, mutation).identityDigest, baseline.identityDigest)
    }
    fs.writeFileSync(path.join(rootDir, 'config/vitest.ts'), 'export default { changed: true }\n')
    assert.notEqual(buildTransformCacheIdentity(options).identityDigest, baseline.identityDigest)
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})

test('transform cache identity owns both canonical unit support inputs and retires the secondary source root', () => {
  assert.ok(transformCacheConfigFiles.includes('tests/frontend/support/unit/setup.ts'))
  assert.ok(transformCacheConfigFiles.includes('tests/frontend/support/unit/animationFrameEnvironment.ts'))
  assert.equal(transformCacheConfigFiles.some((file) => file.startsWith('src/frontend/tests/')), false)

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-vitest-support-cache-'))
  const supportFiles = [
    'tests/frontend/support/unit/setup.ts',
    'tests/frontend/support/unit/animationFrameEnvironment.ts'
  ]
  try {
    for (const file of supportFiles) {
      fs.mkdirSync(path.dirname(path.join(rootDir, file)), { recursive: true })
      fs.writeFileSync(path.join(rootDir, file), `export const identity = ${JSON.stringify(file)}\n`)
    }
    const options = {
      rootDir,
      configFiles: supportFiles,
      sourceCommit: 'a'.repeat(40),
      sourceFingerprint: 'b'.repeat(64),
      packageVersions: { node: 'v24.0.0', vitest: '4.1.5', vite: '8.0.16' }
    }
    const baseline = buildTransformCacheIdentity(options).identityDigest

    for (const file of supportFiles) {
      const absolute = path.join(rootDir, file)
      const original = fs.readFileSync(absolute, 'utf8')
      fs.appendFileSync(absolute, '// changed\n')
      assert.notEqual(buildTransformCacheIdentity(options).identityDigest, baseline)
      fs.writeFileSync(absolute, original)
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})

test('ordinary lifecycle seals before perf and exposes only cache path and immutable identity', () => {
  const { rootDir, options } = fixture()
  try {
    const context = prepareTransformCache(options)
    const cacheEnv = transformCacheEnvironment(context)
    assert.equal(cacheEnv.FSUSBLOG_VITEST_TRANSFORM_CACHE_IDENTITY, context.identity.identityDigest)
    assert.equal(cacheEnv.FSUSBLOG_VITEST_TRANSFORM_CACHE_PATH, context.cachePath)
    assert.throws(() => openTransformCacheForPerf(options), /completed ordinary run/u)
    fs.writeFileSync(path.join(context.cachePath, '_metadata.json'), JSON.stringify({ lockfileHash: 'lock' }))
    sealTransformCache(context)
    const opened = openTransformCacheForPerf(options)
    assert.equal(opened.identity.identityDigest, context.identity.identityDigest)
    assert.equal(opened.repair.rebuiltEntries, 0)
    const lifecycle = JSON.parse(fs.readFileSync(opened.lifecycleFile, 'utf8'))
    assert.equal(lifecycle.status, 'perf-active')
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})

test('missing and corrupt cache content is rebuilt safely while identity corruption fails closed', () => {
  const { rootDir, options } = fixture()
  try {
    let context = prepareTransformCache(options)
    fs.writeFileSync(path.join(context.cachePath, 'corrupt-entry'), 'not transformed code')
    sealTransformCache(context)
    let opened = openTransformCacheForPerf(options)
    assert.equal(opened.repair.rebuiltEntries, 1)

    context = prepareTransformCache({ ...options, env: { ...options.env, FSUSBLOG_TEST_RUN_ID: 'run-missing' } })
    sealTransformCache(context)
    fs.rmSync(context.cachePath, { recursive: true, force: true })
    opened = openTransformCacheForPerf({ ...options, env: { ...options.env, FSUSBLOG_TEST_RUN_ID: 'run-missing' } })
    assert.equal(opened.repair.recreatedDirectory, true)

    context = prepareTransformCache({ ...options, env: { ...options.env, FSUSBLOG_TEST_RUN_ID: 'run-identity' } })
    sealTransformCache(context)
    fs.writeFileSync(context.identityFile, '{"schema":"broken"}\n')
    assert.throws(() => openTransformCacheForPerf({
      ...options,
      env: { ...options.env, FSUSBLOG_TEST_RUN_ID: 'run-identity' }
    }), /identity is missing, corrupt, or does not match/u)
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})

test('valid Vitest entries may omit optional url metadata and are retained for cross-process hits', () => {
  const { rootDir, options } = fixture()
  try {
    const context = prepareTransformCache(options)
    const metadata = Buffer.from(JSON.stringify([
      { id: '1', file: '1', importedUrls: '2', mappings: false },
      '/repo/source.ts',
      []
    ])).toString('base64')
    fs.writeFileSync(path.join(context.cachePath, 'valid-entry'), `export const value = 1\n//# vitestCache=${metadata}`)
    sealTransformCache(context)
    const opened = openTransformCacheForPerf(options)
    assert.equal(opened.repair.rebuiltEntries, 0)
    assert.equal(fs.existsSync(path.join(opened.cachePath, 'valid-entry')), true)
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})

test('failure or cancellation invalidates active cache and next preparation cannot reuse it', () => {
  const { rootDir, options } = fixture()
  try {
    const context = prepareTransformCache(options)
    fs.writeFileSync(path.join(context.cachePath, 'partial'), 'partial')
    invalidateTransformCache(context, 'test-cancelled')
    assert.equal(fs.existsSync(context.cachePath), false)
    const failed = JSON.parse(fs.readFileSync(context.lifecycleFile, 'utf8'))
    assert.equal(failed.status, 'failed')
    assert.equal(failed.reason, 'test-cancelled')
    const next = prepareTransformCache(options)
    assert.equal(JSON.parse(fs.readFileSync(next.lifecycleFile, 'utf8')).status, 'ordinary-active')
    assert.deepEqual(fs.readdirSync(next.cachePath), [])
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})

test('perf execution is exact, disjoint from ordinary IDs, and cannot mutate coverage evidence', () => {
  const report = (file, id) => ({
    testResults: [{ name: file, assertionResults: [{ fullName: id, status: 'passed' }] }]
  })
  const perf = report('/repo/tests/frontend/benchmarks/perf.test.ts', 'perf case')
  const ordinary = report('/repo/tests/frontend/unit/unit.test.ts', 'unit case')
  assert.deepEqual(validateIsolatedPerfExecution(perf, ordinary, 'coverage-a', 'coverage-a'), {
    perfTestIdCount: 1,
    ordinaryTestIdCount: 1,
    exactOnce: true,
    disjointFromOrdinary: true,
    coverageUnchanged: true
  })
  assert.throws(() => validateIsolatedPerfExecution(perf, perf, 'coverage-a', 'coverage-a'), /overlap=1/u)
  assert.throws(() => validateIsolatedPerfExecution(perf, ordinary, 'coverage-a', 'coverage-b'), /modified ordinary/u)
})

test('cache debug timing parser records hits, misses, and writes without depending on ANSI color', () => {
  const stats = parseTransformCacheDebug([
    '\u001b[32m[read]\u001b[0m one',
    '[read] two',
    '\u001b[31m[empty]\u001b[0m three',
    '\u001b[33m[write]\u001b[0m four'
  ].join('\n'))
  assert.deepEqual(stats, { hits: 2, misses: 1, writes: 1 })
  assert.deepEqual(requireTransformCacheReuse(stats), {
    hits: 2, misses: 1, writes: 1, requests: 3, hitRate: 2 / 3, reused: true, safeRebuild: false
  })
  assert.throws(() => requireTransformCacheReuse({ hits: 0, misses: 4, writes: 4 }), /did not reuse/u)
  assert.deepEqual(requireTransformCacheReuse({ hits: 0, misses: 4, writes: 4 }, { allowSafeRebuild: true }), {
    hits: 0, misses: 4, writes: 4, requests: 4, hitRate: 0, reused: false, safeRebuild: true
  })
  assert.deepEqual(frontendVitestTransformCacheSchemas, {
    identitySchema: 'fsusblog.frontend-vitest-transform-cache-identity.v1',
    lifecycleSchema: 'fsusblog.frontend-vitest-transform-cache-lifecycle.v1'
  })
})

test('perf cache-key compatibility provider never starts profiling or emits coverage', async () => {
  assert.equal(await transformCacheCoverageRuntime.takeCoverage(), null)
  const provider = await transformCacheCoverageRuntime.getProvider()
  provider.initialize({
    _coverageOptions: { reportsDirectory: '/tmp/unused' }
  })
  assert.equal(provider.name, 'transform-cache-key-compatibility')
  assert.deepEqual(await provider.generateCoverage(), null)
  assert.deepEqual(provider.resolveOptions().reporter, [])
  assert.equal(provider.requiresTransform, undefined)
})

test('production wiring keeps perf in an independent process after ordinary settlement', () => {
  const ordinaryRunner = fs.readFileSync('tools/test/run-frontend-vitest-rolling-shards.mjs', 'utf8')
  const perfRunner = fs.readFileSync('tools/test/run-frontend-vitest-perf-isolated.mjs', 'utf8')
  const bundle = fs.readFileSync('tools/test/bundles/run-bundle.mjs', 'utf8')
  const config = fs.readFileSync('src/frontend/vitest.production.config.ts', 'utf8')
  assert.match(ordinaryRunner, /sealTransformCache\(cache\)/u)
  assert.match(bundle, /vitest-production-perf-isolated'[\s\S]*?dependsOn: \['frontend-build-ready', 'vitest-settled'\]/u)
  assert.match(bundle, /async function executeFrontendStep[\s\S]*?step\.id === 'frontend-build-ready'[\s\S]*?waitForFrontendBuildReady/u)
  assert.doesNotMatch(bundle, /waitForSiblingBundleSummaries\(\['build-static'\]\)[\s\S]*?run-frontend-vitest-perf-isolated\.mjs/u)
  assert.match(perfRunner, /spawn\('npx',[\s\S]*?'--project=perf'/u)
  assert.match(perfRunner, /process\.kill\(process\.platform === 'win32' \? activeChild\.pid : -activeChild\.pid/u)
  assert.doesNotMatch(perfRunner, /--no-isolate/u)
  assert.match(perfRunner, /ordinaryWorkersSettledBeforeStart: true/u)
  assert.match(perfRunner, /coverageUnchanged/u)
  assert.match(config, /fsModuleCache: true, fsModuleCachePath: transformCachePath/u)
  assert.match(config, /FSUSBLOG_VITEST_PERF_TRANSFORM_CACHE_CONSUMER/u)
  assert.match(perfRunner, /coverageCollectionEnabled: false/u)
  assert.match(bundle, /perf-isolated-timing\.json/u)
})
