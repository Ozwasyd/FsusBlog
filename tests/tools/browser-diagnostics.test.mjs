import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  browserDiagnosticCatalog,
  browserDiagnosticProbeCount,
  selectBrowserDiagnostics
} from '../browser-diagnostics/catalog.mjs'
import {
  classifyDiagnosticFailure,
  diagnosticProbeEnvironment,
  resolveDiagnosticResourceState,
  resolveDiagnosticsOutputRoot,
  runBrowserDiagnostics
} from '../browser-diagnostics/run.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
const readJson = (relativePath) => JSON.parse(read(relativePath))
const localFsusUiFixture = Object.freeze({
  schema: 'fsusblog.browser-diagnostics.local-fsusui-identity.v1',
  commit: 'd'.repeat(40),
  contentDigest: `sha256:${'e'.repeat(64)}`
})

test('catalog retains every browser-only risk with lightweight replacement ownership', () => {
  const migration = readJson('tests/issue-1148-browser-diagnostics-migration.json')
  assert.equal(migration.schema, 'fsusblog.issue-1148-browser-diagnostics-migration.v1')
  assert.deepEqual(
    browserDiagnosticCatalog.map((category) => category.id),
    [
      'visual',
      'ux',
      'cross-browser',
      'geometry-motion-focus',
      'accessibility',
      'performance',
      'resilience',
      'acceptance',
      'release-runtime',
      'runtime-risk'
    ]
  )
  assert.equal(browserDiagnosticProbeCount(), 21)
  const viewportMatrix = readJson('tests/frontend/fixtures/ux-viewport-matrix.json')
  const plannedViewports = new Set(browserDiagnosticCatalog.flatMap((category) => (
    category.probes.flatMap((probe) => probe.plannedDimensions.viewports)
  )))
  const plannedThemes = new Set(browserDiagnosticCatalog.flatMap((category) => (
    category.probes.flatMap((probe) => probe.plannedDimensions.themes)
  )))
  for (const viewport of viewportMatrix.viewports) assert.ok(plannedViewports.has(viewport.name), `missing planned viewport ${viewport.name}`)
  assert.ok(plannedThemes.has('light'))
  assert.ok(plannedThemes.has('dark'))
  assert.deepEqual(selectBrowserDiagnostics(['performance']).map((category) => category.id), ['performance'])
  assert.deepEqual(selectBrowserDiagnostics(['runtime-risk']).map((category) => category.id), ['runtime-risk'])
  assert.throws(() => selectBrowserDiagnostics(['unknown']), /unknown browser diagnostic categories/u)

  const migrationByCategory = new Map(migration.records.map((record) => [record.category, record]))
  const migratedCategories = browserDiagnosticCatalog.filter((category) => migrationByCategory.has(category.id))
  assert.equal(migratedCategories.length, migration.records.length)
  for (const category of migratedCategories) {
    const record = migrationByCategory.get(category.id)
    assert.ok(record, `${category.id} is absent from the migration map`)
    assert.ok(record.sourcePaths.length > 0)
    assert.ok(record.lightweightReplacementPaths.length > 0)
    assert.ok(record.browserOnlyRisk.trim().length > 0)
    assert.deepEqual([...record.lightweightReplacementPaths].sort(), [...category.replacements].sort())
    for (const relativePath of [...record.sourcePaths, ...record.lightweightReplacementPaths]) {
      assert.ok(fs.existsSync(path.join(root, relativePath)), `missing migration path: ${relativePath}`)
    }
  }
})

test('catalog owns retained acceptance, release and runtime-risk probes without a pre-run shell', () => {
  const categories = new Map(browserDiagnosticCatalog.map((category) => [category.id, category]))
  assert.deepEqual(categories.get('acceptance').probes.map((probe) => probe.id), ['full-suite'])
  assert.deepEqual(
    categories.get('release-runtime').probes.map((probe) => probe.id),
    ['release-rbac-negative', 'release-aot-consumption']
  )
  assert.deepEqual(
    categories.get('runtime-risk').probes.map((probe) => probe.id),
    ['pow-runtime', 'search-runtime', 'zero-auth-probe', 'permission-matrix']
  )

  const commands = [...categories.values()]
    .flatMap((category) => category.probes)
    .map((probe) => probe.command.join(' '))
  for (const probe of [
    'acceptance',
    'release-rbac-negative',
    'release-aot-consumption',
    'pow-runtime',
    'search-runtime',
    'zero-auth-probe',
    'permission-matrix'
  ]) {
    assert.ok(commands.some((command) => command.endsWith(`browser-diagnostics-risk.sh ${probe}`)))
  }
  for (const categoryId of ['acceptance', 'release-runtime', 'runtime-risk']) {
    for (const replacement of categories.get(categoryId).replacements) {
      assert.ok(fs.existsSync(path.join(root, replacement)), `missing ${categoryId} replacement: ${replacement}`)
    }
  }

  const entry = read('tools/test/lanes/browser-diagnostics.sh')
  assert.doesNotMatch(entry, /browser-runtime-risk-diagnostics\.sh/u)
  assert.match(entry, /exec .*tests\/browser-diagnostics\/run\.mjs/u)
})

test('diagnostics topology is fixed, managed and independent from correctness', () => {
  const runner = read('tests/browser-diagnostics/run.mjs')
  const config = read('src/frontend/playwright.diagnostics.config.ts')
  const workflow = read('.github/workflows/browser-diagnostics.yml')
  const matrix = read('tests/matrix.yml')

  assert.doesNotMatch(runner, /os\.(?:loadavg|freemem)|maxFailures|run-flaky-governed/u)
  assert.match(runner, /affectsCorrectness:\s*false/u)
  assert.match(runner, /maxActiveBrowserLanes:\s*1/u)
  assert.match(runner, /verifyProductionBuildReceipt/u)
  assert.match(runner, /FSUSBLOG_PLAYWRIGHT_RETRIES:\s*'0'/u)
  assert.match(config, /fullyParallel:\s*false/u)
  assert.match(config, /retries:\s*0/u)
  assert.doesNotMatch(config, /executablePath|os\.(?:loadavg|freemem)/u)
  assert.match(read('src/frontend/playwright.config.ts'), /FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY/u)
  assert.match(workflow, /schedule:/u)
  assert.match(workflow, /workflow_dispatch:/u)
  assert.doesNotMatch(workflow, /^\s{2}(?:pull_request|push):/mu)
  assert.match(workflow, /playwright install --with-deps chromium firefox webkit/u)
  assert.match(workflow, /FSUSBLOG_PLAYWRIGHT_SESSION_MODE: browser-diagnostics/u)
  assert.match(workflow, /FSUSBLOG_PLAYWRIGHT_SESSION_PREP_CONCURRENCY: '1'/u)
  assert.match(workflow, /FSUSBLOG_TEST_NAMESPACE: browser-diagnostics-/u)
  assert.match(workflow, /FSUSBLOG_FIXTURE_ROOT: .*\.tmp\/browser-diagnostics\//u)
  assert.match(workflow, /FSUSBLOG_BROWSER_DIAGNOSTICS_OUTPUT_ROOT: \.tmp\/browser-diagnostics\//u)
  for (const category of browserDiagnosticCatalog) {
    assert.match(workflow, new RegExp(`^\\s+- ${category.id}$`, 'mu'))
  }
  assert.match(matrix, /id: browser-diagnostics-nightly[\s\S]*?cadence: nightly[\s\S]*?requiredFor: none/u)
  assert.match(matrix, /id: browser-diagnostics-manual[\s\S]*?cadence: release-manual[\s\S]*?requiredFor: none/u)
})

test('performance structure checks are separable from renderer diagnostics', () => {
  const aggregate = read('tools/test/lanes/frontend-render-pressure.sh')
  const structure = read('tools/test/lanes/frontend-render-structure.sh')
  const browser = read('tools/test/lanes/browser-render-diagnostics.sh')
  assert.match(aggregate, /frontend-render-structure\.sh/u)
  assert.doesNotMatch(aggregate, /browser-render-diagnostics\.sh/u)
  assert.match(structure, /check:dom-depth-static/u)
  assert.match(structure, /check:markdown-render-budget/u)
  assert.doesNotMatch(structure, /check:dom-budget|check:route-render-pressure/u)
  assert.match(browser, /check:dom-budget/u)
  assert.match(browser, /check:route-render-pressure/u)
  assert.match(
    read('tests/browser-diagnostics/catalog.mjs'),
    /probe\('render-pressure',[\s\S]*?browser-render-diagnostics\.sh/u
  )
  assert.match(read('tests/frontend/support/system-chromium.mjs'), /FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY/u)
  assert.doesNotMatch(
    read('tools/operations/check-evidence-metrics.mjs'),
    /ux-viewport-summary/u,
    'optional UX diagnostics must not be read by correctness metrics validation'
  )
})

test('ordinary correctness excludes browser-only suites and diagnostics owns them', () => {
  const defaultConfig = read('src/frontend/playwright.config.ts')
  const qualityGate = read('.github/workflows/quality-gate.yml')
  const catalog = read('tests/browser-diagnostics/catalog.mjs')

  for (const excluded of [
    /visual\/\*\*/u,
    /ux\/\*\*/u,
    /diagnostics\/\*\*/u,
    /cross-browser-smoke\.spec\.ts/u,
    /archive-sticky-geometry\.spec\.ts/u
  ]) assert.match(defaultConfig, excluded)

  assert.doesNotMatch(qualityGate, /^  (?:visual-public|visual-console|visual|ux-viewport-smoke|ux-viewport-visual|ux-viewport-boundaries|cross-browser-smoke):/mu)
  assert.doesNotMatch(qualityGate, /browser-performance-regression\.sh/u)
  assert.doesNotMatch(qualityGate, /playwright\.diagnostics\.config\.ts/u)
  assert.doesNotMatch(read('tools/test/legacy-test.sh'), /playwright\.diagnostics\.config\.ts/u)
  for (const diagnosticLane of [
    'visual-public-playwright.sh',
    'visual-console-playwright.sh',
    'cross-browser-smoke.sh',
    'browser-geometry-motion-diagnostics.sh',
    'browser-performance-regression.sh'
  ]) assert.match(catalog, new RegExp(diagnosticLane.replaceAll('.', '\\.')))
})

test('ordinary Playwright config rejects the diagnostics directory at runtime', async () => {
  const configUrl = pathToFileURL(path.join(root, 'src/frontend/playwright.config.ts'))
  configUrl.searchParams.set('browser-diagnostics-contract', String(Date.now()))
  const { default: config } = await import(configUrl.href)
  assert.ok(Array.isArray(config.testIgnore))
  assert.ok(config.testIgnore.includes('diagnostics/**'))
})

test('failure classification preserves diagnostic and infrastructure boundaries', () => {
  assert.equal(classifyDiagnosticFailure({ exitCode: 1, output: 'expect mismatch' }), 'diagnostic')
  assert.equal(classifyDiagnosticFailure({ exitCode: 1, output: 'browser disconnected' }), 'infra')
  assert.equal(classifyDiagnosticFailure({ exitCode: 1, output: 'none: no_supported_browser' }), 'infra')
  assert.equal(classifyDiagnosticFailure({ exitCode: 1, output: 'infra-failure: release preview is unavailable' }), 'infra')
  assert.equal(classifyDiagnosticFailure({ exitCode: 1, timedOut: true }), 'infra')
  assert.equal(classifyDiagnosticFailure({ exitCode: 0 }), null)

  const env = diagnosticProbeEnvironment({
    baseEnvironment: {
      FSUSBLOG_TEST_NAMESPACE: 'base',
      FSUSBLOG_FIXTURE_ROOT: '/tmp/shared-fixtures',
      FSUSBLOG_BROWSER_CONTRACT_OUTPUT: '/tmp/browser-contract'
    },
    runId: 'run',
    categoryId: 'visual',
    probeId: 'public',
    outputDir: '/tmp/diagnostic-output',
    workers: 1
  })
  assert.equal(env.FSUSBLOG_TEST_NAMESPACE, 'browser-diagnostics-run-visual-public')
  assert.equal(env.FSUSBLOG_FIXTURE_ROOT, '/tmp/diagnostic-output/fixtures')
  assert.equal(env.FSUSBLOG_PLAYWRIGHT_WORKERS, '1')
  assert.equal(env.FSUSBLOG_PLAYWRIGHT_SESSION_PREP_CONCURRENCY, '1')
  assert.equal(env.FSUSBLOG_PLAYWRIGHT_SESSION_MODE, 'browser-diagnostics')
  assert.equal(env.FSUSBLOG_BROWSER_CONTRACT_OUTPUT, undefined)
  assert.match(env.FSUSBLOG_TEST_SESSION_PREFIX, /run-visual-public/u)
  assert.match(env.FSUSBLOG_TEST_SESSION, /run-visual-public-0/u)
  assert.equal(env.FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY, '1')
  assert.equal(env.FSUSBLOG_PLAYWRIGHT_RETRIES, '0')
  assert.equal(env.FSUSBLOG_PLAYWRIGHT_CONFIG, 'playwright.diagnostics.config.ts')
  assert.match(env.FSUSBLOG_BROWSER_DIAGNOSTIC_NAMESPACE, /run-visual-public/u)

  assert.deepEqual(resolveDiagnosticResourceState({ requestedWorkers: 1, env: {} }), {
    status: 'complete',
    reason: null,
    requestedWorkers: 1,
    effectiveWorkers: 1,
    sessionCount: 1
  })
  assert.equal(resolveDiagnosticResourceState({ requestedWorkers: 3, env: {} }).status, 'incomplete')

  const scopedOutput = resolveDiagnosticsOutputRoot('', 'fixture-run')
  assert.equal(scopedOutput, path.join(root, '.tmp/browser-diagnostics/fixture-run'))
  assert.throws(
    () => resolveDiagnosticsOutputRoot('.', 'fixture-run'),
    /output must be a run directory below \.tmp\/browser-diagnostics/u
  )
  assert.throws(
    () => resolveDiagnosticsOutputRoot('.tmp/browser-diagnostics', 'fixture-run'),
    /output must be a run directory below \.tmp\/browser-diagnostics/u
  )
})

test('runner executes all independent probes and writes one aggregate receipt', async () => {
  const testOutputRoot = path.join(root, '.tmp/browser-diagnostics')
  fs.mkdirSync(testOutputRoot, { recursive: true })
  const outputRoot = fs.mkdtempSync(path.join(testOutputRoot, 'test-'))
  const categories = [{
    id: 'fixture',
    browsers: ['chromium'],
    risk: 'fixture',
    replacements: ['tests/tools/browser-diagnostics.test.mjs'],
    probes: [
      { id: 'product', command: ['fixture', 'product'], artifactPaths: [], timeoutMinutes: 1 },
      { id: 'infra', command: ['fixture', 'infra'], artifactPaths: [], timeoutMinutes: 1 },
      { id: 'success', command: ['fixture', 'success'], artifactPaths: [], timeoutMinutes: 1 }
    ]
  }]
  const executed = []
  try {
    const result = await runBrowserDiagnostics({
      mode: 'manual',
      categoryIds: [],
      planOnly: false,
      workers: 1,
      outputRoot,
      probeTimeoutMinutes: null
    }, {
      categories,
      runId: 'fixture-run',
      source: {
        commit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64),
        build: {
          contentDigest: `sha256:${'c'.repeat(64)}`,
          sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
        }
      },
      localFsusUi: localFsusUiFixture,
      executeProbe: async ({ probe }) => {
        executed.push(probe.id)
        if (probe.id === 'product') return { status: 'failure', failureClass: 'diagnostic', exitCode: 1, signal: null, timedOut: false, durationMs: 1 }
        if (probe.id === 'infra') return { status: 'failure', failureClass: 'infra', exitCode: 1, signal: 'SIGKILL', timedOut: false, durationMs: 1 }
        return { status: 'success', failureClass: null, exitCode: 0, signal: null, timedOut: false, durationMs: 1 }
      }
    })
    assert.deepEqual(executed, ['product', 'infra', 'success'])
    assert.equal(result.receipt.status, 'failure')
    assert.equal(result.receipt.executedProbeCount, 3)
    assert.deepEqual(result.receipt.failureClasses.sort(), ['diagnostic', 'infra-failure'])
    assert.equal(result.receipt.affectsCorrectness, false)
    assert.deepEqual(result.plan.localFsusUi, localFsusUiFixture)
    assert.deepEqual(result.receipt.localFsusUi, localFsusUiFixture)
    assert.ok(fs.existsSync(result.receiptFile))
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('runner precleans declared artifacts, snapshots fresh outputs and fails closed on missing evidence', async () => {
  const token = `${process.pid}-${Date.now()}`
  const canonicalRoot = path.join(root, '.tmp/browser-diagnostics-contract', token)
  const outputRoot = path.join(root, '.tmp/browser-diagnostics', `artifact-contract-${token}`)
  const freshRelative = `.tmp/browser-diagnostics-contract/${token}/fresh.json`
  const missingRelative = `.tmp/browser-diagnostics-contract/${token}/missing.json`
  const freshFile = path.join(root, freshRelative)
  const missingFile = path.join(root, missingRelative)
  fs.mkdirSync(canonicalRoot, { recursive: true })
  fs.writeFileSync(freshFile, 'stale-fresh\n')
  fs.writeFileSync(missingFile, 'stale-missing\n')

  const categories = [{
    id: 'fixture',
    browsers: ['chromium'],
    risk: 'fixture',
    replacements: ['tests/tools/browser-diagnostics.test.mjs'],
    probes: [
      { id: 'fresh', command: ['fixture', 'fresh'], artifactPaths: [freshRelative], timeoutMinutes: 1 },
      { id: 'missing', command: ['fixture', 'missing'], artifactPaths: [missingRelative], timeoutMinutes: 1 }
    ]
  }]

  try {
    const result = await runBrowserDiagnostics({
      mode: 'manual',
      categoryIds: [],
      planOnly: false,
      workers: 1,
      outputRoot,
      probeTimeoutMinutes: null
    }, {
      categories,
      runId: `artifact-contract-${token}`,
      source: {
        commit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64),
        build: {
          contentDigest: `sha256:${'c'.repeat(64)}`,
          sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
        }
      },
      localFsusUi: localFsusUiFixture,
      executeProbe: async ({ probe }) => {
        const declaredFile = probe.id === 'fresh' ? freshFile : missingFile
        assert.equal(fs.existsSync(declaredFile), false, `${probe.id} stale artifact must be removed before execution`)
        if (probe.id === 'fresh') fs.writeFileSync(freshFile, 'fresh-output\n')
        return { status: 'success', failureClass: null, exitCode: 0, signal: null, timedOut: false, durationMs: 1 }
      }
    })

    const [fresh, missing] = result.receipt.categories[0].probes
    assert.equal(result.receipt.status, 'failure')
    assert.equal(fresh.status, 'success')
    assert.deepEqual(fresh.artifactContract.materializedPaths, [freshRelative])
    assert.deepEqual(fresh.copiedArtifacts, [freshRelative])
    assert.equal(
      fs.readFileSync(path.join(outputRoot, 'categories/fixture/fresh/artifacts', freshRelative), 'utf8'),
      'fresh-output\n'
    )
    assert.equal(missing.status, 'failure')
    assert.equal(missing.failureClass, 'infra-failure')
    assert.deepEqual(missing.artifactContract.missingPaths, [missingRelative])
    assert.match(missing.artifactContractError, /did not materialize declared artifacts/u)
    assert.equal(fs.existsSync(missingFile), false)
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true })
    fs.rmSync(canonicalRoot, { recursive: true, force: true })
  }
})

test('diagnostics preserves a browser-crash retry as two canonical attempt records', async (context) => {
  const token = `infra-retry-${process.pid}-${Date.now()}`
  const outputRoot = path.join(root, '.tmp/browser-diagnostics', token)
  context.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }))
  const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
  const result = await runBrowserDiagnostics({
    mode: 'manual', categoryIds: [], planOnly: false, workers: 1, outputRoot, probeTimeoutMinutes: null
  }, {
    categories: [{
      id: 'infra-fixture', browsers: ['chromium'], risk: 'fixture', replacements: ['tests/tools/browser-diagnostics.test.mjs'],
      probes: [{ id: 'crash-once', command: ['fixture'], artifactPaths: [], timeoutMinutes: 1 }]
    }],
    runId: token,
    source: {
      ...sourceState,
      build: { contentDigest: `sha256:${'c'.repeat(64)}`, sourceState }
    },
    localFsusUi: localFsusUiFixture,
    executeProbe: async () => ({
      status: 'success',
      failureClass: null,
      crashRetryCount: 1,
      attempts: [
        {
          attempt: 1,
          status: 'failure',
          testIds: ['infra-fixture/crash-once'],
          failureClass: 'infra',
          failureKind: 'browser-process-crash',
          artifacts: ['.tmp/browser-diagnostics/infra-fixture/crash-attempt-1.log']
        },
        {
          attempt: 2,
          status: 'success',
          testIds: ['infra-fixture/crash-once'],
          failureClass: null,
          failureKind: null,
          artifacts: ['.tmp/browser-diagnostics/infra-fixture/retry-attempt-2.log']
        }
      ]
    })
  })

  const probe = result.receipt.categories[0].probes[0]
  assert.equal(result.receipt.status, 'success')
  assert.equal(result.receipt.crashRetryCount, 1)
  assert.equal(probe.failureClass, 'infra-failure')
  assert.equal(probe.attempts[0].failureClass, 'infra-failure')
  assert.equal(probe.attempts[0].failureKind, 'browser-process-crash')
  assert.equal(probe.attempts[1].failureClass, null)
  assert.equal(probe.finalStatus, 'diagnostic-passed-after-infra-retry')
  assert.equal(result.receipt.finalStatus, 'diagnostic-passed-after-infra-retry')
  assert.equal(result.receipt.failureClass, 'infra-failure')
  assert.deepEqual(result.receipt.dimensions.viewports, ['1280x800'])
  assert.deepEqual(result.receipt.dimensions.themes, ['light'])
})

test('source, build and FsusUI initialization failures still seal explicit incomplete receipts', async (context) => {
  const category = {
    id: 'initialization-fixture',
    browsers: ['chromium'],
    risk: 'fixture',
    replacements: ['tests/tools/browser-diagnostics.test.mjs'],
    probes: [{ id: 'never-runs', command: ['fixture'], artifactPaths: [], timeoutMinutes: 1 }]
  }
  const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
  const source = {
    ...sourceState,
    build: { contentDigest: `sha256:${'c'.repeat(64)}`, sourceState }
  }
  const cases = [
    {
      stage: 'source',
      dependencies: { resolveSourceAndBuild: async () => { throw new Error('git snapshot unavailable') } }
    },
    {
      stage: 'build',
      dependencies: { resolveSourceAndBuild: async () => { throw new Error('immutable build receipt missing') } }
    },
    {
      stage: 'fsusui',
      dependencies: {
        source,
        resolveLocalFsusUiIdentity: () => { throw new Error('local FsusUI alias identity missing') }
      }
    }
  ]

  for (const fixture of cases) {
    const token = `initialization-${fixture.stage}-${process.pid}-${Date.now()}`
    const outputRoot = path.join(root, '.tmp/browser-diagnostics', token)
    context.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }))
    const result = await runBrowserDiagnostics({
      mode: 'manual', categoryIds: [], planOnly: false, workers: 1, outputRoot, probeTimeoutMinutes: null
    }, {
      categories: [category],
      runId: token,
      ...fixture.dependencies
    })
    assert.equal(result.status, 'incomplete')
    assert.equal(result.receipt.initializationFailure.stage, fixture.stage)
    assert.equal(result.receipt.initializationFailure.failureClass, 'infra-failure')
    assert.match(result.receipt.incompleteReason, new RegExp(`^initialization:${fixture.stage}:`, 'u'))
    assert.deepEqual(result.receipt.categories[0].failureClasses, ['infra-failure'])
    assert.ok(fs.existsSync(result.receiptFile))
  }
})

test('cancellation accounts for every unexecuted category and probe in one incomplete receipt', async (context) => {
  const token = `cancelled-${process.pid}-${Date.now()}`
  const outputRoot = path.join(root, '.tmp/browser-diagnostics', token)
  context.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }))
  const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
  let executions = 0
  const result = await runBrowserDiagnostics({
    mode: 'manual', categoryIds: [], planOnly: false, workers: 1, outputRoot, probeTimeoutMinutes: null
  }, {
    categories: [
      {
        id: 'first', browsers: ['chromium'], risk: 'fixture', replacements: ['tests/tools/browser-diagnostics.test.mjs'],
        probes: [
          { id: 'one', command: ['fixture'], artifactPaths: [], timeoutMinutes: 1 },
          { id: 'two', command: ['fixture'], artifactPaths: [], timeoutMinutes: 1 }
        ]
      },
      {
        id: 'second', browsers: ['chromium'], risk: 'fixture', replacements: ['tests/tools/browser-diagnostics.test.mjs'],
        probes: [{ id: 'three', command: ['fixture'], artifactPaths: [], timeoutMinutes: 1 }]
      }
    ],
    runId: token,
    source: { ...sourceState, build: { contentDigest: `sha256:${'c'.repeat(64)}`, sourceState } },
    localFsusUi: localFsusUiFixture,
    executeProbe: async () => {
      executions += 1
      return { status: 'success', failureClass: null, exitCode: 0, signal: null, timedOut: false, durationMs: 1 }
    },
    afterProbe: () => 'fixture-cancelled'
  })

  assert.equal(executions, 1)
  assert.equal(result.receipt.status, 'incomplete')
  assert.deepEqual(result.receipt.counts, { planned: 3, executed: 1, skipped: 2 })
  assert.deepEqual(result.receipt.categories.map((category) => category.status), ['incomplete', 'skipped'])
  assert.deepEqual(result.receipt.failureClasses, ['infra-failure'])
  assert.match(result.receipt.incompleteReason, /fixture-cancelled/u)
})

test('browser performance diagnostic writes blocked evidence and exits nonzero without render samples', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-browser-performance-'))
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }))
  const outFile = path.join(fixture, 'browser-performance.json')
  const releaseFile = path.join(fixture, 'browser-performance-release.json')
  const result = spawnSync('bash', ['tools/test/lanes/browser-performance-regression.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FSUSBLOG_BROWSER_PERFORMANCE_OUT_FILE: outFile,
      FSUSBLOG_BROWSER_PERFORMANCE_RELEASE_SUMMARY_FILE: releaseFile,
      FSUSBLOG_BROWSER_PERFORMANCE_ROUTE_PRESSURE_FILE: path.join(fixture, 'missing-route-pressure.json'),
      FSUSBLOG_BROWSER_PERFORMANCE_DOM_BUDGET_FILE: path.join(fixture, 'missing-dom-budget.json')
    }
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /diagnostic blocked/u)
  assert.match(result.stderr, /infra-failure: missing frontend render-pressure runtime artifact/u)
  assert.equal(JSON.parse(fs.readFileSync(outFile, 'utf8')).status, 'blocked')
  assert.equal(JSON.parse(fs.readFileSync(releaseFile, 'utf8')).status, 'blocked')
})

test('browser-only raw and release summaries self-classify as non-blocking diagnostics', () => {
  const ux = read('tests/frontend/checks/ux/write-ux-viewport-summary.mjs')
  const dom = read('tests/frontend/checks/perf/check-dom-budget.mjs')
  const route = read('tests/frontend/checks/perf/check-route-render-pressure.mjs')
  const browserPerformance = read('tools/test/lanes/browser-performance-regression.sh')

  assert.match(
    ux,
    /const summary = \{[\s\S]*?evidenceClass: 'diagnostic',[\s\S]*?affectsCorrectness: false,[\s\S]*?executionBoundary: 'real-browser-ux-viewport'/u
  )
  assert.match(
    ux,
    /const releaseSummary = \{[\s\S]*?evidenceClass: summary\.evidenceClass,[\s\S]*?affectsCorrectness: summary\.affectsCorrectness,[\s\S]*?executionBoundary: summary\.executionBoundary/u
  )

  assert.match(
    dom,
    /const summary = \{[\s\S]*?evidenceClass: 'diagnostic',[\s\S]*?executionBoundary: 'real-browser-dom-budget'/u
  )
  assert.match(
    dom,
    /const next = \{[\s\S]*?evidenceClass: 'diagnostic',[\s\S]*?affectsCorrectness: false,[\s\S]*?executionBoundary: 'real-browser-render-diagnostics'/u
  )
  assert.match(
    route,
    /const summary = \{[\s\S]*?evidenceClass: 'diagnostic',[\s\S]*?executionBoundary: 'real-browser-route-render-pressure'/u
  )
  assert.match(
    route,
    /const next = \{[\s\S]*?evidenceClass: 'diagnostic',[\s\S]*?affectsCorrectness: false,[\s\S]*?executionBoundary: 'real-browser-render-diagnostics'/u
  )

  assert.equal([...browserPerformance.matchAll(/evidenceClass\s*:\s*\\?"diagnostic\\?"/gu)].length, 4)
  assert.equal([...browserPerformance.matchAll(/affectsCorrectness\s*:\s*false/gu)].length, 4)
  assert.equal([
    ...browserPerformance.matchAll(/executionBoundary\s*:\s*\\?"real-browser-performance-diagnostics\\?"/gu)
  ].length, 4)
})

test('dedicated browser wrappers reject correctness callers and self-classify marker evidence', () => {
  for (const file of [
    'tools/test/lanes/browser-a11y-diagnostics.sh',
    'tools/test/lanes/browser-render-diagnostics.sh',
    'tools/test/lanes/browser-resilience-diagnostics.sh'
  ]) {
    const source = read(file)
    assert.match(source, /diagnostics-only lane requires FSUSBLOG_BROWSER_DIAGNOSTICS=1/u)
    assert.match(source, /exactly one outer browser worker is required/u)
  }
  for (const file of [
    'tools/test/lanes/browser-a11y-diagnostics.sh',
    'tools/test/lanes/browser-resilience-diagnostics.sh'
  ]) {
    const source = read(file)
    assert.match(source, /evidenceClass:"diagnostic"/u)
    assert.match(source, /affectsCorrectness:false/u)
  }
})
