import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  diagnosticProbeEnvironment,
  resolveDiagnosticResourceState,
  runBrowserDiagnostics
} from '../browser-diagnostics/run.mjs'
import { resolveSessionPreparationTopology } from '../frontend/fixtures/prepare-playwright-sessions.mjs'
import {
  playwrightSessionModes,
  resolveFixtureRoot
} from '../frontend/support/fixture-paths.mjs'
import { fixtureSessionSearchPathSql } from '../frontend/support/session-fixtures.mjs'
import { createProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const source = {
  commit: 'a'.repeat(40),
  worktreeFingerprint: 'b'.repeat(64),
  build: {
    contentDigest: `sha256:${'c'.repeat(64)}`,
    sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
  }
}
const localFsusUi = {
  schema: 'fsusblog.browser-diagnostics.local-fsusui-identity.v1',
  commit: 'd'.repeat(40),
  contentDigest: `sha256:${'e'.repeat(64)}`
}

test('dedicated Browser Contract bootstrap cannot publish scheduler resident leases', () => {
  const bootstrap = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8')
  const publishCall = bootstrap.indexOf('resident-resource-leases-cli.mjs" publish')
  assert.notEqual(publishCall, -1)
  const publishGate = bootstrap.slice(bootstrap.lastIndexOf('  if [[', publishCall), publishCall)

  assert.match(
    publishGate,
    /FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME:-0\}" != "1"/u
  )
  assert.match(publishGate, /FSUSBLOG_TEST_RUN_ID:-/u)
  assert.match(publishGate, /FSUSBLOG_PHYSICAL_BUNDLE_ID:-/u)
})

function sourceAdmissionEnvironment(outputRoot, overrides = {}) {
  const env = {
    ...process.env,
    FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-contract',
    FSUSBLOG_BROWSER_CONTRACT_OUTPUT: outputRoot,
    FSUSBLOG_BROWSER_CONTRACT_RECEIPT: path.join(outputRoot, 'receipt.json'),
    FSUSBLOG_BROWSER_CONTRACT_BUILD_RECEIPT: path.join(outputRoot, 'missing-build-receipt.json'),
    ...overrides
  }
  for (const key of ['FSUSBLOG_TEST_SOURCE_COMMIT', 'FSUSBLOG_TEST_SOURCE_FINGERPRINT']) {
    if (env[key] === undefined) delete env[key]
  }
  return env
}

function createFixtureBuildReceipt(context, sourceState) {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-browser-contract-build-'))
  context.after(() => fs.rmSync(artifactRoot, { recursive: true, force: true }))
  const domains = [
    ['backend-runtime', 'backend-runtime/server.dll'],
    ['frontend-dist', 'frontend-dist/index.html'],
    ['generated-contracts', 'generated-contracts/contracts.json'],
    ['wasm', 'wasm/aeds.wasm']
  ]
  for (const [, relative] of domains) {
    const file = path.join(artifactRoot, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${relative}\n`)
  }
  createProductionBuildReceipt({
    root,
    artifactRoot,
    sourceState,
    producer: { runId: 'browser-contract-source-test', runAttempt: 1, job: 'source-admission' },
    toolchain: {
      node: process.version,
      npm: 'test',
      dotnet: 'test',
      vite: 'test',
      vitest: 'test',
      playwright: 'test',
      emsdk: 'test'
    },
    inputPaths: ['tests/matrix.yml'],
    domains: domains.map(([name, relative]) => ({ name, path: relative }))
  })
  return path.join(artifactRoot, 'receipt.json')
}

test('browser contract direct and lane entry reject incomplete source identity before touching receipt', (context) => {
  const outputRoot = path.join(root, '.tmp/browser-contract', `source-admission-${process.pid}-${Date.now()}`)
  const receiptFile = path.join(outputRoot, 'receipt.json')
  const sentinel = '{"status":"sentinel"}\n'
  fs.mkdirSync(outputRoot, { recursive: true })
  context.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }))

  const invalidCases = [
    { name: 'missing', commit: undefined, fingerprint: undefined },
    { name: 'commit-only', commit: 'a'.repeat(40), fingerprint: undefined },
    { name: 'fingerprint-only', commit: undefined, fingerprint: 'b'.repeat(64) },
    { name: 'invalid-commit', commit: 'a'.repeat(39), fingerprint: 'b'.repeat(64) },
    { name: 'invalid-fingerprint', commit: 'a'.repeat(40), fingerprint: 'b'.repeat(63) }
  ]

  for (const fixture of invalidCases) {
    fs.writeFileSync(receiptFile, sentinel)
    const env = sourceAdmissionEnvironment(outputRoot, {
      FSUSBLOG_TEST_SOURCE_COMMIT: fixture.commit,
      FSUSBLOG_TEST_SOURCE_FINGERPRINT: fixture.fingerprint,
      GITHUB_SHA: 'f'.repeat(40)
    })
    const direct = spawnSync(process.execPath, ['tests/browser-contract/run.mjs'], {
      cwd: root,
      env,
      encoding: 'utf8'
    })
    assert.notEqual(direct.status, 0, `${fixture.name} direct invocation must fail`)
    assert.match(direct.stderr, /requires complete FSUSBLOG_TEST_SOURCE_COMMIT and FSUSBLOG_TEST_SOURCE_FINGERPRINT identity/u)
    assert.doesNotMatch(direct.stderr, /immutable production build receipt is missing/u)
    assert.equal(fs.readFileSync(receiptFile, 'utf8'), sentinel, `${fixture.name} touched the existing receipt`)

    const lane = spawnSync('bash', ['tools/test/lanes/browser-contract.sh'], {
      cwd: root,
      env: { ...env, FSUSBLOG_NODE: '/definitely/not-a-node-binary' },
      encoding: 'utf8'
    })
    assert.equal(lane.status, 2, `${fixture.name} lane invocation must fail at source admission`)
    assert.match(lane.stderr, /complete FSUSBLOG_TEST_SOURCE_COMMIT and FSUSBLOG_TEST_SOURCE_FINGERPRINT identity is required/u)
    assert.doesNotMatch(lane.stderr, /not-a-node-binary/u)
    assert.equal(fs.readFileSync(receiptFile, 'utf8'), sentinel, `${fixture.name} lane touched the existing receipt`)
  }
})

test('browser contract build receipt must exactly match both admitted source identity fields', (context) => {
  const outputRoot = path.join(root, '.tmp/browser-contract', `source-mismatch-${process.pid}-${Date.now()}`)
  fs.mkdirSync(outputRoot, { recursive: true })
  context.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }))
  const expected = { commit: 'c'.repeat(40), worktreeFingerprint: 'd'.repeat(64) }
  const mismatches = [
    {
      name: 'commit',
      sourceState: { ...expected, commit: 'e'.repeat(40) },
      error: /receipt commit SHA mismatch/u
    },
    {
      name: 'fingerprint',
      sourceState: { ...expected, worktreeFingerprint: 'f'.repeat(64) },
      error: /receipt worktree fingerprint mismatch/u
    }
  ]

  for (const fixture of mismatches) {
    const buildReceipt = createFixtureBuildReceipt(context, fixture.sourceState)
    const result = spawnSync(process.execPath, ['tests/browser-contract/run.mjs'], {
      cwd: root,
      env: sourceAdmissionEnvironment(outputRoot, {
        FSUSBLOG_TEST_SOURCE_COMMIT: expected.commit,
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: expected.worktreeFingerprint,
        FSUSBLOG_BROWSER_CONTRACT_BUILD_RECEIPT: buildReceipt,
        FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER: '/definitely/not-a-fixture-provider'
      }),
      encoding: 'utf8'
    })
    assert.notEqual(result.status, 0, `${fixture.name} mismatch must fail`)
    assert.match(result.stderr, fixture.error)
    assert.doesNotMatch(result.stderr, /fixture provider/u)
  }
})

test('browser contract rejects missing temporal context after source and build admission without touching receipt', (context) => {
  const outputRoot = path.join(root, '.tmp/browser-contract', `temporal-admission-${process.pid}-${Date.now()}`)
  const receiptFile = path.join(outputRoot, 'receipt.json')
  const sentinel = '{"status":"sentinel"}\n'
  const admittedSource = { commit: 'c'.repeat(40), worktreeFingerprint: 'd'.repeat(64) }
  const buildReceipt = createFixtureBuildReceipt(context, admittedSource)
  fs.mkdirSync(outputRoot, { recursive: true })
  fs.writeFileSync(receiptFile, sentinel)
  context.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }))

  const env = sourceAdmissionEnvironment(outputRoot, {
    FSUSBLOG_TEST_SOURCE_COMMIT: admittedSource.commit,
    FSUSBLOG_TEST_SOURCE_FINGERPRINT: admittedSource.worktreeFingerprint,
    FSUSBLOG_BROWSER_CONTRACT_BUILD_RECEIPT: buildReceipt,
    FSUSBLOG_BROWSER_CONTRACT_FIXTURE_PROVIDER: '/definitely/not-a-fixture-provider',
    FSUSBLOG_TEMPORAL_CONTEXT_JSON: undefined,
    FSUSBLOG_TEMPORAL_CONTEXT_FILE: undefined
  })
  delete env.FSUSBLOG_TEMPORAL_CONTEXT_JSON
  delete env.FSUSBLOG_TEMPORAL_CONTEXT_FILE

  const result = spawnSync(process.execPath, ['tests/browser-contract/run.mjs'], {
    cwd: root,
    env,
    encoding: 'utf8'
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /temporal\.context-missing: exactly one temporal context source is required/u)
  assert.doesNotMatch(result.stderr, /fixture provider/u)
  assert.equal(fs.readFileSync(receiptFile, 'utf8'), sentinel)
})

test('fixture roots separate browser contract, diagnostics, and legacy namespaces', () => {
  assert.equal(
    resolveFixtureRoot({
      repoRoot: '/repo',
      env: {
        FSUSBLOG_PLAYWRIGHT_SESSION_MODE: playwrightSessionModes.browserContract,
        FSUSBLOG_TEST_NAMESPACE: 'release-contract-7'
      }
    }),
    '/repo/.tmp/browser-contract/fixtures/release-contract-7'
  )
  assert.equal(
    resolveFixtureRoot({
      repoRoot: '/repo',
      env: {
        FSUSBLOG_PLAYWRIGHT_SESSION_MODE: playwrightSessionModes.browserDiagnostics,
        FSUSBLOG_TEST_NAMESPACE: 'diagnostics-7'
      }
    }),
    '/repo/.tmp/browser-diagnostics/fixtures/diagnostics-7'
  )
  assert.equal(
    resolveFixtureRoot({ repoRoot: '/repo', env: { FSUSBLOG_TEST_NAMESPACE: 'legacy-7' } }),
    '/repo/.tmp/fixtures/legacy-7'
  )
  assert.throws(
    () => resolveFixtureRoot({
      repoRoot: '/repo',
      env: { FSUSBLOG_PLAYWRIGHT_SESSION_MODE: playwrightSessionModes.browserContract }
    }),
    /FSUSBLOG_TEST_NAMESPACE is required for browser-contract/u
  )
})

test('legacy preparation rejects contract before URL, container, or PID admission and fixes diagnostics to one session', () => {
  assert.throws(
    () => resolveSessionPreparationTopology({
      argv: ['--workers', '8'],
      env: { FSUSBLOG_PLAYWRIGHT_SESSION_MODE: playwrightSessionModes.browserContract }
    }),
    /formal single-namespace fixture lifecycle/u
  )

  const diagnostics = resolveSessionPreparationTopology({
    argv: ['--workers', '1', '--concurrency', '1'],
    env: {
      FSUSBLOG_PLAYWRIGHT_SESSION_MODE: playwrightSessionModes.browserDiagnostics,
      FSUSBLOG_TEST_SESSION_PREFIX: 'diagnostic-fixed'
    }
  })
  assert.deepEqual(diagnostics, {
    mode: playwrightSessionModes.browserDiagnostics,
    workers: 1,
    requestedSessionPrepConcurrency: 1,
    usesDynamicPostgresPidAdmission: false,
    sessions: ['diagnostic-fixed-0']
  })
  assert.throws(
    () => resolveSessionPreparationTopology({
      argv: ['--workers', '2'],
      env: { FSUSBLOG_PLAYWRIGHT_SESSION_MODE: playwrightSessionModes.browserDiagnostics }
    }),
    /exactly one worker and one preparation slot/u
  )

  const legacy = resolveSessionPreparationTopology({
    argv: ['--workers', '3', '--concurrency', '2'],
    env: { FSUSBLOG_TEST_SESSION_PREFIX: 'legacy' }
  })
  assert.equal(legacy.usesDynamicPostgresPidAdmission, true)
  assert.equal(legacy.sessions.length, 3)
  assert.equal(legacy.requestedSessionPrepConcurrency, 2)

  const cli = spawnSync(process.execPath, ['tests/frontend/fixtures/prepare-playwright-sessions.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FSUSBLOG_PLAYWRIGHT_SESSION_MODE: playwrightSessionModes.browserContract,
      FSUSBLOG_BASE_URL: '',
      FSUSBLOG_PG_CONTAINER: 'unsafe-production',
      FSUSBLOG_REDIS_CONTAINER: 'unsafe-production'
    }
  })
  assert.notEqual(cli.status, 0)
  assert.match(cli.stderr, /formal single-namespace fixture lifecycle/u)
  assert.doesNotMatch(cli.stderr, /active namespace HTTP origin|fixture container|cgroup PID/u)
})

test('contract session SQL is schema-only and cannot fall back to public', () => {
  assert.equal(
    fixtureSessionSearchPathSql({ session: 'contract-one-0', mode: playwrightSessionModes.browserContract }),
    'set search_path to "fsus_e2e_contract_one_0";'
  )
  assert.throws(
    () => fixtureSessionSearchPathSql({ session: '', mode: playwrightSessionModes.browserContract }),
    /require one explicit FSUSBLOG_TEST_SESSION schema/u
  )
  assert.match(
    fixtureSessionSearchPathSql({ session: 'legacy-one-0', mode: playwrightSessionModes.legacyParallel }),
    /, public;/u
  )
})

test('diagnostic probe environment strips contract state and owns fixed config, namespace, session, and output', () => {
  const outputDir = path.join(root, '.tmp/browser-diagnostics/run/categories/visual/public')
  const env = diagnosticProbeEnvironment({
    baseEnvironment: {
      FSUSBLOG_TEST_NAMESPACE: 'browser-contract-shared',
      FSUSBLOG_FIXTURE_ROOT: path.join(root, '.tmp/browser-contract/fixtures/shared'),
      FSUSBLOG_BROWSER_CONTRACT_OUTPUT: path.join(root, '.tmp/browser-contract'),
      FSUSBLOG_BROWSER_CONTRACT_RECEIPT: path.join(root, '.tmp/browser-contract/receipt.json')
    },
    runId: 'run-7',
    categoryId: 'visual',
    probeId: 'public',
    outputDir,
    workers: 1
  })

  assert.equal(env.FSUSBLOG_PLAYWRIGHT_SESSION_MODE, playwrightSessionModes.browserDiagnostics)
  assert.equal(env.FSUSBLOG_PLAYWRIGHT_WORKERS, '1')
  assert.equal(env.FSUSBLOG_PLAYWRIGHT_SESSION_PREP_CONCURRENCY, '1')
  assert.equal(env.FSUSBLOG_TEST_NAMESPACE, 'browser-diagnostics-run-7-visual-public')
  assert.equal(env.FSUSBLOG_TEST_SESSION, 'run-7-visual-public-0')
  assert.equal(env.FSUSBLOG_FIXTURE_ROOT, path.join(outputDir, 'fixtures'))
  assert.equal(env.FSUSBLOG_BROWSER_DIAGNOSTICS_OUTPUT_ROOT, outputDir)
  assert.equal(env.PLAYWRIGHT_OUTPUT_DIR, path.join(outputDir, 'playwright'))
  assert.equal(env.FSUSBLOG_BROWSER_CONTRACT_OUTPUT, undefined)
  assert.equal(env.FSUSBLOG_BROWSER_CONTRACT_RECEIPT, undefined)
  assert.throws(
    () => diagnosticProbeEnvironment({
      baseEnvironment: {},
      runId: 'run-7',
      categoryId: 'visual',
      probeId: 'public',
      outputDir,
      workers: 2
    }),
    /requires one fixed worker/u
  )
})

test('resource reductions write skipped category summaries and an incomplete receipt', async (context) => {
  const category = {
    id: 'fixture',
    browsers: ['chromium'],
    risk: 'fixture',
    replacements: ['tests/tools/browser-session-isolation.test.mjs'],
    probes: [{ id: 'probe', command: ['fixture'], artifactPaths: [], timeoutMinutes: 1 }]
  }
  const cases = [
    {
      name: 'requested-workers',
      workers: 3,
      env: {},
      expectedResourceStatus: 'incomplete',
      reason: /requested-workers-3/u
    },
    {
      name: 'capacity-skipped',
      workers: 1,
      env: {
        FSUSBLOG_BROWSER_DIAGNOSTICS_RESOURCE_STATUS: 'skipped',
        FSUSBLOG_BROWSER_DIAGNOSTICS_RESOURCE_REASON: 'managed-browser-capacity-unavailable'
      },
      expectedResourceStatus: 'skipped',
      reason: /managed-browser-capacity-unavailable/u
    }
  ]

  for (const fixture of cases) {
    const token = `${fixture.name}-${process.pid}-${Date.now()}`
    const outputRoot = path.join(root, '.tmp/browser-diagnostics', token)
    context.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }))
    let executed = 0
    const result = await runBrowserDiagnostics({
      mode: 'manual',
      categoryIds: [],
      planOnly: false,
      workers: fixture.workers,
      outputRoot,
      probeTimeoutMinutes: null
    }, {
      categories: [category],
      env: fixture.env,
      runId: token,
      source,
      localFsusUi,
      executeProbe: async () => {
        executed += 1
        return { status: 'success', failureClass: null }
      }
    })

    assert.equal(executed, 0)
    assert.equal(result.receipt.status, 'incomplete')
    assert.equal(result.receipt.resources.status, fixture.expectedResourceStatus)
    assert.match(result.receipt.incompleteReason, fixture.reason)
    assert.equal(result.receipt.executedProbeCount, 0)
    assert.equal(result.receipt.skippedProbeCount, 1)
    assert.equal(result.receipt.categories[0].status, 'skipped')
    const summary = JSON.parse(fs.readFileSync(
      path.join(outputRoot, 'categories/fixture/summary.json'),
      'utf8'
    ))
    assert.equal(summary.status, 'skipped')
    assert.equal(summary.skippedProbeCount, 1)
    assert.match(summary.incompleteReason, fixture.reason)
  }

  assert.throws(
    () => resolveDiagnosticResourceState({
      requestedWorkers: 1,
      env: { FSUSBLOG_BROWSER_DIAGNOSTICS_RESOURCE_STATUS: 'incomplete' }
    }),
    /require FSUSBLOG_BROWSER_DIAGNOSTICS_RESOURCE_REASON/u
  )
})
