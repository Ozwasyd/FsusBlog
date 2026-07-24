import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  cachePaths,
  loadBuildCacheConfiguration
} from '../../tools/test-matrix/content-addressed-build-cache-contract.mjs'
import {
  executeBuildCacheDomain,
  validateBuildCacheSummary
} from '../../tools/test-matrix/content-addressed-build-cache.mjs'

const sourceCommit = 'a'.repeat(40)
const sourceFingerprint = `sha256:${'b'.repeat(64)}`

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-build-cache-'))
  fs.mkdirSync(path.join(root, 'config/testing'), { recursive: true })
  fs.writeFileSync(path.join(root, 'input.txt'), 'source-v1\n')
  writeJson(path.join(root, 'config/testing/content-addressed-build-cache.json'), {
    schema: 'fsusblog.content-addressed-build-cache-config.v1',
    cacheRoot: '.cache/objects',
    quarantineRoot: '.cache/quarantine',
    evidenceRoot: '.evidence/domains',
    summaryFile: '.evidence/summary.json',
    lockWaitMs: 2000,
    environmentAllowlist: ['FIXTURE_PROPERTY'],
    ignoredInputSegments: ['.cache', '.evidence'],
    forbiddenOutputPrefixes: ['runtime', 'test-results', 'coverage', 'release-evidence', 'database', 'checkpoints'],
    dynamicFacts: ['TRX', 'coverage', 'runtime state', 'test outcomes'],
    domains: {
      'fixture-build': {
        phase: 'build',
        toolchainKeys: [],
        inputPaths: ['input.txt', 'config/testing/content-addressed-build-cache.json'],
        outputPaths: ['out/bin'],
        dependencies: [],
        outputReceipts: [],
        properties: { configuration: 'Release' },
        dependencyGraph: { fixture: [] }
      }
    }
  })
  return root
}

function env(runId, property = 'stable') {
  return {
    ...process.env,
    FSUSBLOG_TEST_RUN_ID: runId,
    FSUSBLOG_TEST_SOURCE_COMMIT: sourceCommit,
    FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceFingerprint,
    FIXTURE_PROPERTY: property
  }
}

function build(runRoot, value, calls) {
  return async () => {
    calls.count += 1
    const output = path.join(runRoot, 'out/bin/artifact.txt')
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, value)
  }
}

function isWritable(file) {
  return (fs.statSync(file).mode & 0o222) !== 0
}

function makeWritableTree(target) {
  if (!fs.existsSync(target)) return
  const visit = current => {
    const stat = fs.lstatSync(current)
    fs.chmodSync(current, stat.mode | 0o222)
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) visit(path.join(current, entry))
    }
  }
  visit(path.resolve(target))
}

test('identical deterministic inputs hit a sealed object in a new run root while dynamic facts remain fresh', async t => {
  const root = fixture()
  t.after(() => {
    makeWritableTree(root)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const firstRoot = path.join(root, '.runs/run-one')
  const secondRoot = path.join(root, '.runs/run-two')
  const calls = { count: 0 }
  const command = ['fixture-compiler', '--configuration', 'Release']

  const first = await executeBuildCacheDomain({
    root, runRoot: firstRoot, domainId: 'fixture-build', command, env: env('run-one'),
    execute: build(firstRoot, 'artifact-v1\n', calls)
  })
  assert.equal(first.decision, 'miss')
  assert.equal(first.metrics.compilerInvocations, 1)

  const second = await executeBuildCacheDomain({
    root, runRoot: secondRoot, domainId: 'fixture-build', command, env: env('run-two'),
    execute: async () => { throw new Error('compiler must not run on a cache hit') }
  })
  assert.equal(second.decision, 'hit')
  assert.equal(second.metrics.compilerInvocations, 0)
  assert.equal(fs.readFileSync(path.join(secondRoot, 'out/bin/artifact.txt'), 'utf8'), 'artifact-v1\n')
  assert.equal(second.dynamicFactsCached, false)
  assert.deepEqual(second.dynamicFacts, ['TRX', 'coverage', 'runtime state', 'test outcomes'])
  assert.equal(calls.count, 1)
  const summary = validateBuildCacheSummary({ root, runId: 'run-two' })
  assert.equal(summary.status, 'complete')
  assert.equal(summary.dynamicFactsCached, false)
})

test('source and allowlisted property changes invalidate only by content identity', async t => {
  const root = fixture()
  t.after(() => {
    makeWritableTree(root)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const command = ['fixture-compiler']
  const calls = { count: 0 }
  const runOne = path.join(root, '.runs/one')
  const one = await executeBuildCacheDomain({ root, runRoot: runOne, domainId: 'fixture-build', command, env: env('one'), execute: build(runOne, 'one', calls) })
  fs.writeFileSync(path.join(root, 'input.txt'), 'source-v2\n')
  const runTwo = path.join(root, '.runs/two')
  const two = await executeBuildCacheDomain({ root, runRoot: runTwo, domainId: 'fixture-build', command, env: env('two'), execute: build(runTwo, 'two', calls) })
  const runThree = path.join(root, '.runs/three')
  const three = await executeBuildCacheDomain({ root, runRoot: runThree, domainId: 'fixture-build', command, env: env('three', 'changed'), execute: build(runThree, 'three', calls) })
  assert.notEqual(one.key, two.key)
  assert.notEqual(two.key, three.key)
  assert.equal(calls.count, 3)
})

test('corrupt, partial and writable objects fail closed and are quarantined', async t => {
  const root = fixture()
  t.after(() => {
    makeWritableTree(root)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const command = ['fixture-compiler']
  const runOne = path.join(root, '.runs/one')
  const result = await executeBuildCacheDomain({ root, runRoot: runOne, domainId: 'fixture-build', command, env: env('one'), execute: build(runOne, 'sealed', { count: 0 }) })
  const config = loadBuildCacheConfiguration(root)
  const paths = cachePaths(root, config, 'fixture-build', result.key)
  assert.equal(isWritable(paths.objectRoot), false)
  assert.equal(isWritable(path.join(paths.objectRoot, 'payload')), false)
  assert.equal(isWritable(path.join(paths.objectRoot, 'payload/out/bin/artifact.txt')), false)

  fs.chmodSync(paths.objectRoot, 0o700)
  fs.chmodSync(path.join(paths.objectRoot, 'payload'), 0o700)
  fs.chmodSync(path.join(paths.objectRoot, 'payload/out'), 0o700)
  fs.chmodSync(path.join(paths.objectRoot, 'payload/out/bin'), 0o700)
  fs.chmodSync(path.join(paths.objectRoot, 'payload/out/bin/artifact.txt'), 0o600)
  fs.writeFileSync(path.join(paths.objectRoot, 'payload/out/bin/artifact.txt'), 'tampered')
  await assert.rejects(
    executeBuildCacheDomain({ root, runRoot: path.join(root, '.runs/two'), domainId: 'fixture-build', command, env: env('two'), execute: async () => {} }),
    /quarantined=/u
  )
  assert.ok(fs.existsSync(path.join(root, '.cache/quarantine')))

  fs.mkdirSync(paths.objectRoot, { recursive: true })
  fs.mkdirSync(path.join(paths.objectRoot, 'payload/out/bin'), { recursive: true })
  fs.writeFileSync(path.join(paths.objectRoot, 'payload/out/bin/artifact.txt'), 'partial')
  await assert.rejects(
    executeBuildCacheDomain({ root, runRoot: path.join(root, '.runs/three'), domainId: 'fixture-build', command, env: env('three'), execute: async () => {} }),
    /quarantined=/u
  )
})

test('concurrent producers publish one object and the follower consumes a race hit', async t => {
  const root = fixture()
  t.after(() => {
    makeWritableTree(root)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const command = ['fixture-compiler']
  const calls = { count: 0 }
  const execute = runRoot => async () => {
    calls.count += 1
    await new Promise(resolve => setTimeout(resolve, 60))
    const file = path.join(runRoot, 'out/bin/artifact.txt')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'concurrent')
  }
  const [left, right] = await Promise.all([
    executeBuildCacheDomain({ root, runRoot: path.join(root, '.runs/left'), domainId: 'fixture-build', command, env: env('left'), execute: execute(path.join(root, '.runs/left')) }),
    executeBuildCacheDomain({ root, runRoot: path.join(root, '.runs/right'), domainId: 'fixture-build', command, env: env('right'), execute: execute(path.join(root, '.runs/right')) })
  ])
  assert.equal(calls.count, 1)
  assert.deepEqual(new Set([left.decision, right.decision]), new Set(['miss', 'race-hit']))
})

test('Production entry points and governance own the cache without caching dynamic results', () => {
  const root = path.resolve(import.meta.dirname, '../..')
  const productionLayout = fs.readFileSync(path.join(root, 'tools/test-matrix/production-build-layout.mjs'), 'utf8')
  const backendEntry = fs.readFileSync(path.join(root, 'tools/build-with-data-env.sh'), 'utf8')
  const frontendEntry = fs.readFileSync(path.join(root, 'tools/test-matrix/frontend-build-cache-bootstrap.mjs'), 'utf8')
  const artifactLane = fs.readFileSync(path.join(root, 'tools/test/lanes/production-build-artifacts.sh'), 'utf8')
  const governance = fs.readFileSync(path.join(root, 'tools/test/lanes/static-governance.sh'), 'utf8')
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/content-addressed-build-cache.json'), 'utf8'))
  assert.match(productionLayout, /frontend-build-cache-bootstrap\.mjs/u)
  assert.match(productionLayout, /NODE_OPTIONS: nodeOptions/u)
  assert.match(backendEntry, /run-build-cache-command\.mjs/u)
  assert.match(frontendEntry, /frontend-release/u)
  assert.match(artifactLane, /content-addressed-build-cache\.mjs" wait-summary/u)
  assert.match(governance, /content-addressed-build-cache\.test\.mjs/u)
  assert.ok(config.dynamicFacts.includes('TRX'))
  assert.ok(config.dynamicFacts.includes('coverage'))
  assert.ok(config.dynamicFacts.includes('test outcomes'))
  for (const domain of Object.values(config.domains)) {
    assert.equal(domain.outputPaths.some(output => /(?:test-results|coverage|release-evidence|runtime|database|checkpoints)/u.test(output)), false)
  }
})
