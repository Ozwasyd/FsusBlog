import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildMobileLandscapeCanaryCases,
  buildParityEvidence,
  buildPlaywrightBatchInvocation,
  buildPlaywrightCaseInvocation,
  inspectLegacySnapshot,
  normalizeFailureMessage,
  parsePlaywrightCaseReport,
  parsePlaywrightBatchReport,
  prepareLegacyWorkspace,
  renderLegacyConfig,
  resolveParityPaths,
  validateHistoricalFailureBaseline,
  validateLegacySnapshotManifest
} from '../../tools/ux/run-viewport-canary-parity.mjs'

const matrix = JSON.parse(await readFile(
  new URL('../frontend/fixtures/ux-viewport-matrix.json', import.meta.url),
  'utf8'
))

test('canary plan is exactly 5 routes by 2 themes by 7 media at mobile-landscape', () => {
  const cases = buildMobileLandscapeCanaryCases(matrix)

  assert.equal(cases.length, 70)
  assert.equal(new Set(cases.map((entry) => entry.id)).size, 70)
  assert.deepEqual([...new Set(cases.map((entry) => entry.routeId))], [
    'public-home',
    'user-profile',
    'manage-dashboard',
    'manage-audit',
    'manage-settings'
  ])
  assert.deepEqual([...new Set(cases.map((entry) => entry.theme))], ['light', 'dark'])
  assert.deepEqual([...new Set(cases.map((entry) => entry.media))], [
    'default',
    'zoom-125',
    'zoom-150',
    'zoom-200',
    'large-text',
    'reduced-motion',
    'high-contrast'
  ])
  assert.ok(cases.every((entry) => entry.viewportId === 'mobile-landscape'))
})

test('legacy and current failure labels normalize to the same signature input', () => {
  const caseInfo = {
    routeId: 'public-home',
    theme: 'light',
    viewportId: 'mobile-landscape',
    media: 'zoom-125'
  }
  const legacy = '\u001b[31mError:\u001b[39m public-home mobile-landscape light zoom-125 touchTargets should have no violations\n    at /repo/.tmp/ux/legacy-runner/viewport-boundaries.spec.ts:241:9'
  const current = 'Error: case:public-home:light:mobile-landscape:zoom-125 touchTargets should have no violations\r\n    at /repo/tests/frontend/e2e/ux/viewport-boundaries.spec.ts:301:11'

  assert.equal(normalizeFailureMessage(legacy, caseInfo), normalizeFailureMessage(current, caseInfo))
  assert.equal(
    normalizeFailureMessage(legacy, caseInfo),
    'Error: <case> touchTargets should have no violations'
  )
})

test('Playwright JSON v2 failure becomes one normalized case result', () => {
  const caseInfo = {
    id: 'public-home|light|mobile-landscape|default',
    routeId: 'public-home',
    theme: 'light',
    viewportId: 'mobile-landscape',
    media: 'default'
  }
  const report = playwrightReport({
    status: 'failed',
    message: 'Error: public-home mobile-landscape light default horizontalOverflow should have no violations'
  })

  const result = parsePlaywrightCaseReport(report, caseInfo, 'legacy')

  assert.equal(result.id, caseInfo.id)
  assert.equal(result.runner, 'legacy')
  assert.equal(result.outcome, 'failed')
  assert.match(result.failureSignature, /^sha256:[a-f0-9]{64}$/u)
  assert.equal(
    result.normalizedFailure,
    'Error: <case> horizontalOverflow should have no violations'
  )
})

test('parity evidence succeeds only after all 70 case outcomes and signatures match', () => {
  const cases = buildMobileLandscapeCanaryCases(matrix)
  const legacyResults = cases.map((entry) => parityResult(entry, 'legacy'))
  const currentResults = cases.map((entry) => parityResult(entry, 'current'))
  const historicalResults = cases.map((entry) => historicalResult(entry))

  const evidence = buildParityEvidence({
    matrixVersion: matrix.version,
    cases,
    legacyResults,
    currentResults,
    historicalResults,
    runners: runnerMetadata(),
    generatedAt: '2026-07-10T06:00:00.000Z'
  })

  assert.equal(evidence.status, 'success')
  assert.deepEqual(evidence.executedCaseCount, { legacy: 70, current: 70 })
  assert.equal(evidence.matchedCaseCount, 70)
  assert.equal(evidence.historicalMatchedCaseCount, 70)
  assert.equal(evidence.mismatchCount, 0)
  assert.equal(evidence.cases.length, 70)
})

test('parity evidence fails closed for a mismatch and rejects a missing execution', () => {
  const cases = buildMobileLandscapeCanaryCases(matrix)
  const legacyResults = cases.map((entry) => parityResult(entry, 'legacy'))
  const currentResults = cases.map((entry) => parityResult(entry, 'current'))
  const historicalResults = cases.map((entry) => historicalResult(entry))
  currentResults[23] = {
    ...currentResults[23],
    failureSignature: `sha256:${'f'.repeat(64)}`,
    normalizedFailure: 'different failure'
  }

  const mismatch = buildParityEvidence({
    matrixVersion: matrix.version,
    cases,
    legacyResults,
    currentResults,
    historicalResults,
    runners: runnerMetadata()
  })
  assert.equal(mismatch.status, 'failed')
  assert.equal(mismatch.mismatchCount, 1)
  assert.equal(mismatch.mismatches[0].id, cases[23].id)

  assert.throws(
    () => buildParityEvidence({
      matrixVersion: matrix.version,
      cases,
      legacyResults,
      currentResults: currentResults.slice(1),
      historicalResults,
      runners: runnerMetadata()
    }),
    /current results must contain exactly the 70 planned canary cases/u
  )
})

test('historical baseline fails closed unless all 70 cases have real failure signatures', () => {
  const cases = buildMobileLandscapeCanaryCases(matrix)
  const incomplete = {
    schema: 'fsusblog.ux-viewport-historical-failures.v1',
    status: 'incomplete',
    expectedCaseCount: 70,
    capturedCaseCount: 0,
    observedGroupFailures: Array.from({ length: 20 }, (_, index) => `group-${index + 1}`),
    cases: []
  }

  assert.throws(
    () => validateHistoricalFailureBaseline(incomplete, cases),
    /historical viewport failure baseline is incomplete: 0\/70 signed cases/u
  )

  const allPassed = cases.map((entry) => ({
    id: entry.id,
    outcome: 'passed',
    failureSignature: 'passed'
  }))
  assert.throws(
    () => validateHistoricalFailureBaseline({
      ...incomplete,
      status: 'ready',
      capturedCaseCount: 70,
      cases: allPassed
    }, cases),
    /must preserve a failed or timedOut outcome/u
  )

  const ready = completeHistoricalBaseline(cases)
  assert.equal(validateHistoricalFailureBaseline(ready, cases).length, 70)
  ready.cases[12] = {
    ...ready.cases[12],
    failureSignature: `sha256:${'f'.repeat(64)}`
  }
  assert.throws(
    () => validateHistoricalFailureBaseline(ready, cases),
    /signature does not match its normalized failure message/u
  )
})

test('tracked legacy manifest binds every snapshot source by digest', () => {
  const sourcePaths = [
    'tests/frontend/e2e/ux/viewport-boundaries.spec.ts',
    'tests/frontend/support/playwright/acceptance-shared.ts',
    'tests/frontend/support/playwright/routeAuditFixtures.ts',
    'tests/frontend/support/playwright/routeAuditMatrix.ts',
    'tests/frontend/support/playwright/testSession.ts',
    'tests/frontend/support/fixture-paths.mjs',
    'tests/frontend/fixtures/ux-viewport-matrix.json',
    'tests/frontend/fixtures/ux-content-boundary-corpus.json'
  ]
  const fileDigests = Object.fromEntries(sourcePaths.map((file, index) => (
    [file, String(index + 1).repeat(64)]
  )))
  const manifest = {
    schema: 'fsusblog.ux-viewport-legacy-snapshot.v1',
    runtimeRoot: 'runtime',
    historicalBaseline: 'historical-failure-signatures.json',
    files: sourcePaths.map((file) => ({ path: file, sha256: fileDigests[file] }))
  }

  assert.deepEqual(
    validateLegacySnapshotManifest(manifest, fileDigests).files,
    manifest.files
  )
  assert.throws(
    () => validateLegacySnapshotManifest(manifest, {
      ...fileDigests,
      'tests/frontend/support/playwright/acceptance-shared.ts': 'f'.repeat(64)
    }),
    /legacy snapshot digest mismatch.*acceptance-shared/u
  )
  assert.throws(
    () => validateLegacySnapshotManifest(manifest, {
      ...fileDigests,
      'tests/frontend/support/playwright/unbound-helper.ts': 'e'.repeat(64)
    }),
    /legacy snapshot contains unbound runtime sources/u
  )
})

test('repository legacy snapshot is tracked, digest-valid, and honestly incomplete', async () => {
  const paths = resolveParityPaths(new URL('../..', import.meta.url).pathname)
  const snapshot = await inspectLegacySnapshot(paths)

  assert.equal(snapshot.manifest.files.length, 8)
  assert.equal(snapshot.baseline.status, 'incomplete')
  assert.equal(snapshot.baseline.cases.length, 0)
  assert.equal(snapshot.baseline.observedGroupFailures.length, 20)
})

test('legacy workspace copies only the tracked helper snapshot, never the current helper', async () => {
  const root = new URL('../..', import.meta.url).pathname
  const workRoot = await mkdtemp(path.join(os.tmpdir(), 'fsus-viewport-legacy-'))
  try {
    const paths = resolveParityPaths(root, { workRoot })
    await prepareLegacyWorkspace(paths)
    const copied = await readFile(path.join(
      workRoot,
      'legacy/tests/frontend/support/playwright/acceptance-shared.ts'
    ))
    const tracked = await readFile(path.join(
      paths.legacySnapshotRoot,
      'runtime/tests/frontend/support/playwright/acceptance-shared.ts'
    ))
    const current = await readFile(path.join(
      root,
      'tests/frontend/support/playwright/acceptance-shared.ts'
    ))

    assert.deepEqual(copied, tracked)
    assert.notDeepEqual(copied, current)
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
})

test('case invocations use the real legacy snapshot and current runner with exact filters', () => {
  const paths = resolveParityPaths('/repo')
  const caseInfo = {
    id: 'manage-audit|dark|mobile-landscape|high-contrast',
    routeId: 'manage-audit',
    theme: 'dark',
    viewportId: 'mobile-landscape',
    media: 'high-contrast'
  }

  assert.equal(paths.legacySnapshotRoot, '/repo/tests/frontend/fixtures/ux-viewport-legacy')
  assert.equal(paths.legacyManifest, '/repo/tests/frontend/fixtures/ux-viewport-legacy/manifest.json')
  assert.equal(paths.historicalBaseline, '/repo/tests/frontend/fixtures/ux-viewport-legacy/historical-failure-signatures.json')
  assert.equal(paths.legacySpec, '/repo/tests/frontend/fixtures/ux-viewport-legacy/runtime/tests/frontend/e2e/ux/viewport-boundaries.spec.ts')
  assert.equal(paths.currentSpec, '/repo/tests/frontend/e2e/ux/viewport-boundaries.spec.ts')
  assert.equal(paths.outFile, '/repo/.tmp/release-evidence/ux-viewport-canary-parity.json')
  assert.equal(paths.legacyConfig, '/repo/.tmp/ux/canary-parity/playwright.legacy.config.mjs')

  const legacy = buildPlaywrightCaseInvocation({ runner: 'legacy', caseInfo, paths })
  const current = buildPlaywrightCaseInvocation({ runner: 'current', caseInfo, paths })
  for (const invocation of [legacy, current]) {
    assert.equal(invocation.env.FSUSBLOG_UX_VIEWPORT_ROUTE_IDS, 'manage-audit')
    assert.equal(invocation.env.FSUSBLOG_UX_VIEWPORT_THEMES, 'dark')
    assert.equal(invocation.env.FSUSBLOG_UX_VIEWPORT_VIEWPORTS, 'mobile-landscape')
    assert.equal(invocation.env.FSUSBLOG_UX_VIEWPORT_MEDIA, 'high-contrast')
    assert.equal(invocation.env.FSUSBLOG_PLAYWRIGHT_DIAGNOSTIC_ALL_FAILURES, '1')
    assert.ok(invocation.args.includes('--reporter=json'))
  }
  assert.ok(legacy.args.some((entry) => entry.includes('mobile-landscape-dark-high-contrast-')))
  assert.ok(current.args.includes('ux/viewport-boundaries.spec.ts'))
})

test('batch invocations execute 70 isolated cases in exactly two Playwright processes', () => {
  const paths = resolveParityPaths('/repo')
  const cases = buildMobileLandscapeCanaryCases(matrix)
  const legacy = buildPlaywrightBatchInvocation({ runner: 'legacy', cases, paths })
  const current = buildPlaywrightBatchInvocation({ runner: 'current', cases, paths })

  for (const invocation of [legacy, current]) {
    assert.equal(invocation.env.FSUSBLOG_UX_VIEWPORT_PARITY_BATCH, '1')
    assert.equal(invocation.env.FSUSBLOG_UX_VIEWPORT_ROUTE_IDS.split(',').length, 5)
    assert.equal(invocation.env.FSUSBLOG_UX_VIEWPORT_MEDIA.split(',').length, 7)
    assert.ok(invocation.args.includes('--workers=1'))
  }

  const report = {
    suites: [{
      specs: cases.map((entry) => ({
        title: `case:${entry.routeId}:${entry.theme}:${entry.viewportId}:${entry.media}`,
        tests: [{ results: [{ status: 'passed', duration: 1 }] }]
      }))
    }],
    errors: []
  }
  assert.equal(parsePlaywrightBatchReport(report, cases, 'current').length, 70)
})

test('generated legacy config uses a Playwright-loadable filesystem import', () => {
  const rendered = renderLegacyConfig({
    frontendConfig: '/repo/src/frontend/playwright.config.ts',
    legacyTestDir: '/tmp/parity/tests/frontend/e2e',
    globalSetup: '/repo/tests/frontend/support/playwright/global-setup.ts',
    tsconfig: '/repo/src/frontend/tsconfig.playwright.json'
  })

  assert.match(rendered, /from "\/repo\/src\/frontend\/playwright\.config\.ts"/u)
  assert.match(rendered, /tsconfig: "\/repo\/src\/frontend\/tsconfig\.playwright\.json"/u)
  assert.doesNotMatch(rendered, /file:\/\//u)
})

function playwrightReport({ status, message = null }) {
  const result = {
    status,
    duration: 42,
    errors: message ? [{ message }] : []
  }
  return {
    suites: [{
      title: 'viewport-boundaries.spec.ts',
      specs: [{
        title: 'one canary case',
        tests: [{
          status: status === 'passed' ? 'expected' : 'unexpected',
          results: [result]
        }]
      }]
    }],
    errors: [],
    stats: {
      expected: status === 'passed' ? 1 : 0,
      unexpected: status === 'passed' ? 0 : 1,
      skipped: 0,
      flaky: 0
    }
  }
}

function parityResult(entry, runner) {
  const normalizedFailure = `Error: <case> ${entry.media} boundary mismatch`
  return {
    id: entry.id,
    runner,
    outcome: 'failed',
    failureSignature: caseSignature(entry.id),
    normalizedFailure,
    durationMs: 10,
    source: 'playwright-json-v2'
  }
}

function historicalResult(entry) {
  return {
    id: entry.id,
    outcome: 'failed',
    failureSignature: caseSignature(entry.id),
    normalizedFailure: `Error: <case> ${entry.media} boundary mismatch`,
    source: 'historical-playwright-json-v2'
  }
}

function completeHistoricalBaseline(cases) {
  return {
    schema: 'fsusblog.ux-viewport-historical-failures.v1',
    status: 'ready',
    expectedCaseCount: 70,
    capturedCaseCount: 70,
    cases: cases.map((entry) => {
      const normalizedFailure = `Error: <case> ${entry.media} boundary mismatch`
      return {
        id: entry.id,
        outcome: 'failed',
        normalizedFailure,
        failureSignature: caseSignature(normalizedFailure),
        evidence: {
          path: `historical/playwright/${entry.id}.json`,
          sha256: 'a'.repeat(64),
          format: 'playwright-json-v2'
        }
      }
    })
  }
}

function caseSignature(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function runnerMetadata() {
  return {
    legacy: {
      spec: 'tests/frontend/fixtures/ux-viewport-legacy/runtime/tests/frontend/e2e/ux/viewport-boundaries.spec.ts',
      sha256: 'legacy-hash'
    },
    current: { spec: 'tests/frontend/e2e/ux/viewport-boundaries.spec.ts', sha256: 'current-hash' }
  }
}
