import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  browserDiagnosticCatalog,
  browserDiagnosticProbeCount
} from '../browser-diagnostics/catalog.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('ordinary AEDS frame-cost stays browserless while diagnostics retains real-engine evidence', () => {
  const ordinary = read('tools/test/lanes/aeds-frame-cost.sh')
  const diagnostic = read('tools/test/lanes/browser-aeds-diagnostics.sh')
  const browserCheck = read('tests/frontend/checks/wasm/check-aeds-tier-browser.mjs')
  const browserlessCheck = read('tests/frontend/checks/perf/check-aeds-decode-budget.mjs')

  assert.match(ordinary, /--aeds-frame-cost/u)
  assert.match(ordinary, /check-aeds-decode-budget\.mjs/u)
  assert.doesNotMatch(ordinary, /check-aeds-tier-browser\.mjs|playwright|chromium|firefox|webkit/iu)

  assert.match(diagnostic, /FSUSBLOG_BROWSER_DIAGNOSTICS:-0.*!= "1"/u)
  assert.match(diagnostic, /FSUSBLOG_PLAYWRIGHT_CONFIG=playwright\.diagnostics\.config\.ts/u)
  assert.match(diagnostic, /FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1/u)
  assert.match(diagnostic, /FSUSBLOG_AEDS_BROWSERS=chromium,firefox,webkit/u)
  assert.match(diagnostic, /check-aeds-tier-browser\.mjs/u)

  assert.match(browserCheck, /FSUSBLOG_AEDS_BROWSERS \|\| 'chromium,firefox,webkit'/u)
  assert.match(browserCheck, /const diagnosticMode = process\.env\.FSUSBLOG_BROWSER_DIAGNOSTICS === '1'/u)
  assert.match(browserCheck, /diagnosticMode \|\| result\.supported/u)
  assert.match(browserCheck, /evidenceClass: 'diagnostic'/u)
  assert.match(browserCheck, /affectsCorrectness: false/u)
  assert.match(browserCheck, /executionBoundary: 'real-browser-engines'/u)
  assert.match(browserCheck, /selectedTier !== 'speed'/u)
  assert.match(browserCheck, /fallbackCount !== 1/u)
  assert.match(browserCheck, /longTaskCount/u)
  assert.match(browserCheck, /jsToWasmCopiedBytes/u)
  assert.match(browserCheck, /wasmToJsCopiedBytes/u)

  assert.match(browserlessCheck, /evidenceClass: 'correctness'/u)
  assert.match(browserlessCheck, /affectsCorrectness: true/u)
  assert.match(browserlessCheck, /executionBoundary: 'browserless-node-wasm-runtime'/u)
  assert.doesNotMatch(browserlessCheck, /browserTierSummary|hydrationTakeoverSummary/u)

  const performance = browserDiagnosticCatalog.find((category) => category.id === 'performance')
  assert.deepEqual(performance.browsers, ['chromium', 'firefox', 'webkit'])
  const probe = performance.probes.find((candidate) => candidate.id === 'aeds-browser-boundary')
  assert.deepEqual(probe.command, ['bash', 'tools/test/lanes/browser-aeds-diagnostics.sh'])
  assert.deepEqual(probe.artifactPaths, [
    '.tmp/frontend/aeds-wasm-browser/summary.json',
    '.tmp/release-evidence/aeds-wasm-browser-summary.json'
  ])
})

test('browser diagnostics expose engine loss and browser crashes without an inner retry', () => {
  const domBudget = read('tests/frontend/checks/perf/check-dom-budget.mjs')
  const browserCheck = read('tests/frontend/checks/wasm/check-aeds-tier-browser.mjs')

  assert.match(domBudget, /const diagnosticMode = process\.env\.FSUSBLOG_BROWSER_DIAGNOSTICS === '1'/u)
  assert.match(domBudget, /const maximumAttempts = diagnosticMode \? 1 : 2/u)
  assert.match(domBudget, /attempt < maximumAttempts && isBrowserExit\(error\)/u)
  assert.match(browserCheck, /browser_not_installed/u)
  assert.match(browserCheck, /results\.filter\(result => result\.status !== 'ok' && \(diagnosticMode \|\| result\.supported\)\)/u)
})

test('release correctness ignores explicitly classified diagnostic evidence', () => {
  const manifestCheck = read('tools/operations/check-release-evidence-manifest.mjs')
  const releaseFinal = read('tools/release/check-release-final.mjs')
  const visualEvidenceWriter = read('tools/test/legacy-test.sh')

  assert.doesNotMatch(manifestCheck, /\['AEDS Wasm browser tiers'/u)
  assert.doesNotMatch(manifestCheck, /function aedsWasmBrowserOk/u)
  assert.match(manifestCheck, /report\.evidenceClass !== 'correctness'/u)
  assert.match(manifestCheck, /report\.affectsCorrectness !== true/u)
  assert.match(manifestCheck, /report\.executionBoundary !== 'browserless-node-wasm-runtime'/u)
  assert.match(releaseFinal, /function isNonBlockingDiagnosticEvidence/u)
  assert.match(releaseFinal, /summary\?\.evidenceClass === 'diagnostic'/u)
  assert.match(releaseFinal, /summary\.affectsCorrectness === false/u)
  assert.match(releaseFinal, /if \(isNonBlockingDiagnosticEvidence\(summary\)\) continue/u)
  assert.match(releaseFinal, /correctnessJobSummaryCount === 0/u)
  assert.match(releaseFinal, /at least one correctness result/u)
  assert.match(visualEvidenceWriter, /schema: 'fsusblog\.visual-gate-skip\.v1'/u)
  assert.match(visualEvidenceWriter, /MATRIX_JOB === 'browser-diagnostics'/u)
  assert.match(visualEvidenceWriter, /evidenceClass: diagnostic \? 'diagnostic' : 'correctness'/u)
  assert.match(visualEvidenceWriter, /affectsCorrectness: !diagnostic/u)
})

test('release evidence execution ignores stale diagnostics and keeps correctness fail-closed', () => {
  for (const [script, args] of [
    ['tools/release/check-release-final.mjs', ['--self-test']],
    ['tools/ci/check-flaky-evidence.mjs', ['--self-test']]
  ]) {
    const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
      cwd: root,
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, `${script}: ${result.stderr || result.stdout}`)
    assert.match(result.stdout, /self-test ok/u)
  }
})

test('CI stage job results classify browser diagnostics without weakening correctness', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-diagnostic-stage-'))
  try {
    const scriptDir = path.join(temp, 'tools/ci')
    fs.mkdirSync(scriptDir, { recursive: true })
    const script = path.join(scriptDir, 'run-stage.mjs')
    fs.copyFileSync(path.join(root, 'tools/ci/run-stage.mjs'), script)
    const run = (job) => spawnSync(process.execPath, [
      script,
      '--stage', 'install',
      '--', process.execPath, '-e', 'process.exit(0)'
    ], {
      cwd: temp,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_JOB: job, GITHUB_SHA: 'a'.repeat(40) }
    })
    const diagnosticResult = run('browser-diagnostics')
    assert.equal(diagnosticResult.status, 0, diagnosticResult.stderr)
    const diagnostic = JSON.parse(fs.readFileSync(path.join(temp, '.tmp/release-evidence/jobs/browser-diagnostics.json'), 'utf8'))
    assert.equal(diagnostic.evidenceClass, 'diagnostic')
    assert.equal(diagnostic.affectsCorrectness, false)

    const correctnessResult = run('correctness-job')
    assert.equal(correctnessResult.status, 0, correctnessResult.stderr)
    const correctness = JSON.parse(fs.readFileSync(path.join(temp, '.tmp/release-evidence/jobs/correctness-job.json'), 'utf8'))
    assert.equal(correctness.evidenceClass, 'correctness')
    assert.equal(correctness.affectsCorrectness, true)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('flaky evidence writer and release-final checker isolate diagnostics from correctness', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-diagnostic-flaky-'))
  try {
    const scriptDir = path.join(temp, 'tools/ci')
    fs.mkdirSync(scriptDir, { recursive: true })
    for (const name of ['run-flaky-governed.mjs', 'check-flaky-evidence.mjs']) {
      fs.copyFileSync(path.join(root, 'tools/ci', name), path.join(scriptDir, name))
    }
    const writer = path.join(scriptDir, 'run-flaky-governed.mjs')
    const checker = path.join(scriptDir, 'check-flaky-evidence.mjs')
    const writeFailure = (suite) => spawnSync(process.execPath, [
      writer,
      '--suite', suite,
      '--test', `${suite}-fixture`,
      '--', process.execPath, '-e', 'process.exit(1)'
    ], { cwd: temp, encoding: 'utf8' })

    for (const suite of ['visual-playwright', 'ux-viewport-smoke', 'cross-browser-smoke']) {
      const diagnosticResult = writeFailure(suite)
      assert.notEqual(diagnosticResult.status, 0)
      const diagnostic = JSON.parse(fs.readFileSync(path.join(temp, `.tmp/release-evidence/flaky/${suite}.json`), 'utf8'))
      assert.equal(diagnostic.evidenceClass, 'diagnostic')
      assert.equal(diagnostic.affectsCorrectness, false)
      assert.equal(diagnostic.retryCount, 0)
      assert.equal(diagnostic.finalStatus, 'failed-no-retry')
      assert.equal(diagnostic.attempts.length, 1)
    }
    const diagnosticCheck = spawnSync(process.execPath, [checker, '--release-final'], { cwd: temp, encoding: 'utf8' })
    assert.equal(diagnosticCheck.status, 0, diagnosticCheck.stderr)

    const correctnessResult = writeFailure('acceptance-playwright')
    assert.notEqual(correctnessResult.status, 0)
    const correctness = JSON.parse(fs.readFileSync(path.join(temp, '.tmp/release-evidence/flaky/acceptance-playwright.json'), 'utf8'))
    assert.equal(correctness.evidenceClass, 'correctness')
    assert.equal(correctness.affectsCorrectness, true)
    assert.equal(correctness.retryCount, 1)
    assert.equal(correctness.finalStatus, 'failed-after-retry')
    assert.equal(correctness.attempts.length, 2)
    const correctnessCheck = spawnSync(process.execPath, [checker, '--release-final'], { cwd: temp, encoding: 'utf8' })
    assert.notEqual(correctnessCheck.status, 0)
    assert.match(correctnessCheck.stderr, /correctness flaky retry\/skip evidence/u)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('UX risk is diagnostics-only with one fixed Playwright worker and no elastic pool', () => {
  const wrapper = read('tools/test/lanes/browser-ux-risk-diagnostics.sh')
  const runner = read('tools/ux/run-local-production-risk.mjs')

  assert.match(wrapper, /FSUSBLOG_BROWSER_DIAGNOSTICS:-0.*!= "1"/u)
  assert.match(wrapper, /FSUSBLOG_BROWSER_DIAGNOSTICS_WORKERS=1/u)
  assert.match(wrapper, /FSUSBLOG_PLAYWRIGHT_WORKERS=1/u)
  assert.match(wrapper, /FSUSBLOG_UX_VIEWPORT_WORKERS=1/u)
  assert.match(wrapper, /FSUSBLOG_PLAYWRIGHT_CONFIG=playwright\.diagnostics\.config\.ts/u)
  assert.match(wrapper, /run-local-production-risk\.mjs/u)

  assert.match(runner, /runner is diagnostics-only/u)
  assert.match(runner, /dynamicInnerPool: false/u)
  assert.match(runner, /persistentElasticPool: false/u)
  assert.match(runner, /FSUSBLOG_UX_VIEWPORT_RISK_MATRIX: '1'/u)
  assert.match(runner, /FSUSBLOG_UX_VIEWPORT_PERSISTENT_WORKER: '0'/u)
  assert.match(runner, /'--config=playwright\.diagnostics\.config\.ts'/u)
  assert.match(runner, /'--workers=1'/u)
  assert.match(runner, /'--workers', '1', '--concurrency', '1'/u)
  assert.match(runner, /schema: 'fsusblog\.browser-diagnostics\.ux-risk\.v1'/u)
  assert.match(runner, /affectsCorrectness: false/u)
  assert.doesNotMatch(runner, /os\.(?:availableParallelism|cpus|freemem|loadavg|totalmem)/u)
  assert.doesNotMatch(runner, /execute(?:Elastic|Persistent)Ux|resolveLiveWorkerCapacity|FSUSBLOG_UX_RISK_EXECUTION_MODE/u)

  const ux = browserDiagnosticCatalog.find((category) => category.id === 'ux')
  const probe = ux.probes.find((candidate) => candidate.id === 'risk-matrix')
  assert.deepEqual(probe.command, ['bash', 'tools/test/lanes/browser-ux-risk-diagnostics.sh'])
  assert.ok(probe.artifactPaths.includes('.tmp/browser-diagnostics-runtime/ux-risk/summary.json'))
  assert.equal(browserDiagnosticProbeCount(), 14)
})

test('UX risk resource planning ignores machine pressure and ordinary production has no entry point', () => {
  const result = spawnSync(process.execPath, [
    path.join(root, 'tools/ux/run-local-production-risk.mjs'),
    '--print-resource-plan'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FSUSBLOG_STEP_CPU_BUDGET: '64',
      FSUSBLOG_STEP_MEMORY_GIB: '256',
      FSUSBLOG_PLAYWRIGHT_WORKERS: '32',
      FSUSBLOG_UX_VIEWPORT_WORKERS: '32'
    }
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    diagnosticsOnly: true,
    outerBrowserLanes: 1,
    workers: 1,
    maximumWorkers: 1,
    dynamicInnerPool: false,
    persistentElasticPool: false,
    capacitySource: 'browser-diagnostics-fixed-topology'
  })

  const rejected = spawnSync(process.execPath, [
    path.join(root, 'tools/ux/run-local-production-risk.mjs')
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, FSUSBLOG_BROWSER_DIAGNOSTICS: '0' } })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /diagnostics-only/u)

  for (const relativePath of [
    'tests/matrix.yml',
    'tools/test/bundles/bundle-steps.mjs',
    '.github/workflows/quality-gate.yml'
  ]) {
    assert.doesNotMatch(read(relativePath), /run-local-production-risk\.mjs/u, relativePath)
  }
})
