#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { UX_VIEWPORT_MOBILE_LANDSCAPE_CANARY_ROUTE_IDS } from '../../tests/frontend/support/playwright/uxViewportPlan.mjs'

const EVIDENCE_SCHEMA = 'fsusblog.ux-viewport-canary-parity.v1'
const LEGACY_SNAPSHOT_SCHEMA = 'fsusblog.ux-viewport-legacy-snapshot.v1'
const HISTORICAL_BASELINE_SCHEMA = 'fsusblog.ux-viewport-historical-failures.v1'
const RESULT_SOURCE = 'playwright-json-v2'
const HISTORICAL_RESULT_SOURCE = 'historical-playwright-json-v2'
const VIEWPORT_ID = 'mobile-landscape'
const EXPECTED_THEMES = Object.freeze(['light', 'dark'])
const EXPECTED_MEDIA = Object.freeze([
  'default',
  'zoom-125',
  'zoom-150',
  'zoom-200',
  'large-text',
  'reduced-motion',
  'high-contrast'
])
const EXPECTED_CASE_COUNT = 5 * 2 * 7
const defaultRoot = fileURLToPath(new URL('../..', import.meta.url))

export function buildMobileLandscapeCanaryCases(matrix) {
  const boundaries = matrix?.modes?.boundaries
  if (!boundaries) {
    throw new Error('viewport matrix is missing boundaries mode')
  }
  assertExactList(boundaries.themes, EXPECTED_THEMES, 'boundaries themes')
  assertExactList(boundaries.media, EXPECTED_MEDIA, 'boundaries media')
  if (!(boundaries.viewports ?? []).includes(VIEWPORT_ID)) {
    throw new Error(`boundaries viewport matrix is missing ${VIEWPORT_ID}`)
  }
  assertExactList(
    UX_VIEWPORT_MOBILE_LANDSCAPE_CANARY_ROUTE_IDS,
    ['public-home', 'user-profile', 'manage-dashboard', 'manage-audit', 'manage-settings'],
    'mobile-landscape canary routes'
  )

  const cases = UX_VIEWPORT_MOBILE_LANDSCAPE_CANARY_ROUTE_IDS.flatMap((routeId) => (
    EXPECTED_THEMES.flatMap((theme) => (
      EXPECTED_MEDIA.map((media) => ({
        id: `${routeId}|${theme}|${VIEWPORT_ID}|${media}`,
        routeId,
        theme,
        viewportId: VIEWPORT_ID,
        media
      }))
    ))
  ))
  if (cases.length !== EXPECTED_CASE_COUNT || new Set(cases.map((entry) => entry.id)).size !== cases.length) {
    throw new Error(`mobile-landscape canary must contain ${EXPECTED_CASE_COUNT} unique cases`)
  }
  return cases
}

export function resolveParityPaths(root = defaultRoot, overrides = {}) {
  const resolvedRoot = path.resolve(root)
  const workRoot = path.resolve(
    overrides.workRoot ?? path.join(resolvedRoot, '.tmp/ux/canary-parity')
  )
  const legacySnapshotRoot = path.resolve(
    overrides.legacySnapshotRoot
      ?? path.join(resolvedRoot, 'tests/frontend/fixtures/ux-viewport-legacy')
  )
  const legacyManifest = path.join(legacySnapshotRoot, 'manifest.json')
  const historicalBaseline = path.join(
    legacySnapshotRoot,
    'historical-failure-signatures.json'
  )
  return {
    root: resolvedRoot,
    frontendRoot: path.join(resolvedRoot, 'src/frontend'),
    playwrightCli: path.join(resolvedRoot, 'src/frontend/node_modules/@playwright/test/cli.js'),
    frontendConfig: path.join(resolvedRoot, 'src/frontend/playwright.config.ts'),
    playwrightTsconfig: path.join(resolvedRoot, 'src/frontend/tsconfig.playwright.json'),
    globalSetup: path.join(resolvedRoot, 'tests/frontend/support/playwright/global-setup.ts'),
    nodeModules: path.join(resolvedRoot, 'src/frontend/node_modules'),
    matrixFile: path.join(resolvedRoot, 'tests/frontend/fixtures/ux-viewport-matrix.json'),
    legacySpec: path.resolve(
      path.join(
        legacySnapshotRoot,
        'runtime/tests/frontend/e2e/ux/viewport-boundaries.spec.ts'
      )
    ),
    legacySnapshotRoot,
    legacyManifest,
    historicalBaseline,
    currentSpec: path.resolve(
      path.join(resolvedRoot, 'tests/frontend/e2e/ux/viewport-boundaries.spec.ts')
    ),
    outFile: path.resolve(
      overrides.outFile ?? path.join(resolvedRoot, '.tmp/release-evidence/ux-viewport-canary-parity.json')
    ),
    workRoot,
    legacyConfig: path.join(workRoot, 'playwright.legacy.config.mjs'),
    currentSources: [
      path.join(resolvedRoot, 'tests/frontend/e2e/ux/viewport-boundaries.spec.ts'),
      path.join(resolvedRoot, 'tests/frontend/support/playwright/acceptance-shared.ts'),
      path.join(resolvedRoot, 'tests/frontend/support/playwright/global-setup.ts'),
      path.join(resolvedRoot, 'tests/frontend/support/playwright/routeAuditFixtures.ts'),
      path.join(resolvedRoot, 'tests/frontend/support/playwright/routeAuditMatrix.ts'),
      path.join(resolvedRoot, 'tests/frontend/support/playwright/testSession.ts'),
      path.join(resolvedRoot, 'tests/frontend/support/playwright/uxViewportPlan.mjs'),
      path.join(resolvedRoot, 'tests/frontend/support/playwright/uxViewportProgress.mjs'),
      path.join(resolvedRoot, 'tests/frontend/support/fixture-paths.mjs'),
      path.join(resolvedRoot, 'tests/frontend/fixtures/ux-viewport-matrix.json'),
      path.join(resolvedRoot, 'tests/frontend/fixtures/ux-content-boundary-corpus.json'),
      path.join(resolvedRoot, 'src/frontend/playwright.config.ts'),
      path.join(resolvedRoot, 'src/frontend/tsconfig.playwright.json')
    ]
  }
}

export function buildPlaywrightCaseInvocation({ runner, caseInfo, paths, runId = 'canary-parity' }) {
  if (runner !== 'legacy' && runner !== 'current') {
    throw new Error(`unknown viewport canary runner: ${String(runner)}`)
  }
  requireCanaryCase(caseInfo)
  const safeCaseId = sanitizeSegment(caseInfo.id)
  const executionId = sanitizeSegment(`${runId}-${runner}-${safeCaseId}`)
  const reportFile = path.join(paths.workRoot, 'reports', `${runner}-${safeCaseId}.json`)
  const outputDir = path.join(paths.workRoot, 'playwright-output', runner, safeCaseId)
  const args = [
    'test',
    `--config=${runner === 'legacy' ? paths.legacyConfig : paths.frontendConfig}`,
    '--workers=1',
    '--reporter=json'
  ]
  if (runner === 'legacy') {
    args.push(`--grep=${VIEWPORT_ID}-${caseInfo.theme}-${caseInfo.media}-`)
  }
  args.push('ux/viewport-boundaries.spec.ts')

  return {
    command: process.execPath,
    args: [paths.playwrightCli, ...args],
    cwd: paths.frontendRoot,
    reportFile,
    outputDir,
    env: {
      FSUSBLOG_UX_VIEWPORT_MODE: 'boundaries',
      FSUSBLOG_UX_VIEWPORT_ROUTE_IDS: caseInfo.routeId,
      FSUSBLOG_UX_VIEWPORT_THEMES: caseInfo.theme,
      FSUSBLOG_UX_VIEWPORT_VIEWPORTS: caseInfo.viewportId,
      FSUSBLOG_UX_VIEWPORT_MEDIA: caseInfo.media,
      FSUSBLOG_UX_VIEWPORT_SCREENSHOTS: '0',
      FSUSBLOG_UX_VIEWPORT_RESUME: '0',
      FSUSBLOG_PLAYWRIGHT_WORKERS: '1',
      FSUSBLOG_UX_VIEWPORT_WORKERS: '1',
      FSUSBLOG_UX_VIEWPORT_RUN_ID: executionId,
      FSUSBLOG_UX_VIEWPORT_RUN_TOKEN: randomUUID(),
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
      PLAYWRIGHT_OUTPUT_DIR: outputDir,
      NODE_PATH: paths.nodeModules
    }
  }
}

export function buildPlaywrightBatchInvocation({ runner, cases, paths, runId = 'canary-parity' }) {
  if (runner !== 'legacy' && runner !== 'current') throw new Error(`unknown viewport canary runner: ${String(runner)}`)
  assertPlannedCases(cases)
  const executionId = sanitizeSegment(`${runId}-${runner}-batch`)
  const reportFile = path.join(paths.workRoot, 'reports', `${runner}-batch.json`)
  const outputDir = path.join(paths.workRoot, 'playwright-output', runner)
  return {
    command: process.execPath,
    args: [
      paths.playwrightCli,
      'test',
      `--config=${runner === 'legacy' ? paths.legacyConfig : paths.frontendConfig}`,
      '--workers=1',
      '--reporter=json',
      'ux/viewport-boundaries.spec.ts'
    ],
    cwd: paths.frontendRoot,
    reportFile,
    outputDir,
    env: {
      FSUSBLOG_UX_VIEWPORT_MODE: 'boundaries',
      FSUSBLOG_UX_VIEWPORT_ROUTE_IDS: UX_VIEWPORT_MOBILE_LANDSCAPE_CANARY_ROUTE_IDS.join(','),
      FSUSBLOG_UX_VIEWPORT_THEMES: EXPECTED_THEMES.join(','),
      FSUSBLOG_UX_VIEWPORT_VIEWPORTS: VIEWPORT_ID,
      FSUSBLOG_UX_VIEWPORT_MEDIA: EXPECTED_MEDIA.join(','),
      FSUSBLOG_UX_VIEWPORT_SCREENSHOTS: '0',
      FSUSBLOG_UX_VIEWPORT_RESUME: '0',
      FSUSBLOG_UX_VIEWPORT_PARITY_BATCH: '1',
      FSUSBLOG_PLAYWRIGHT_WORKERS: '1',
      FSUSBLOG_UX_VIEWPORT_WORKERS: '1',
      FSUSBLOG_UX_VIEWPORT_RUN_ID: executionId,
      FSUSBLOG_UX_VIEWPORT_RUN_TOKEN: randomUUID(),
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
      PLAYWRIGHT_OUTPUT_DIR: outputDir,
      NODE_PATH: paths.nodeModules
    }
  }
}

export function parsePlaywrightBatchReport(report, cases, runner) {
  assertPlannedCases(cases)
  if (!report || !Array.isArray(report.suites) || (report.errors ?? []).length > 0) {
    throw new Error(`${runner} Playwright batch report is invalid`)
  }
  const specs = report.suites.flatMap(collectReportSpecs)
  return cases.map((caseInfo) => {
    const title = `case:${caseInfo.routeId}:${caseInfo.theme}:${caseInfo.viewportId}:${caseInfo.media}`
    const matches = specs.filter((spec) => spec.title === title || spec.title.startsWith(`${title} `))
    if (matches.length !== 1 || (matches[0].tests ?? []).length !== 1) {
      throw new Error(`${runner} Playwright batch must contain exactly one test for ${caseInfo.id}`)
    }
    const results = matches[0].tests[0].results ?? []
    if (results.length !== 1) throw new Error(`${runner} Playwright batch has invalid result count for ${caseInfo.id}`)
    const result = results[0]
    if (!['passed', 'failed', 'timedOut'].includes(result.status)) {
      throw new Error(`${runner} Playwright case ${caseInfo.id} was not fully executed: ${String(result.status)}`)
    }
    if (result.status === 'passed') {
      return {
        id: caseInfo.id,
        runner,
        outcome: 'passed',
        failureSignature: 'passed',
        normalizedFailure: null,
        durationMs: finiteDuration(result.duration),
        source: RESULT_SOURCE
      }
    }
    const messages = [...new Set([
      ...(result.errors ?? []).map((error) => error?.message),
      result.error?.message
    ].filter(Boolean).map((message) => normalizeFailureMessage(message, caseInfo)).filter(Boolean))].sort()
    if (messages.length === 0) throw new Error(`${runner} Playwright failure has no error for ${caseInfo.id}`)
    const normalizedFailure = messages.join('\n---\n')
    return {
      id: caseInfo.id,
      runner,
      outcome: result.status,
      failureSignature: `sha256:${sha256Text(normalizedFailure)}`,
      normalizedFailure,
      durationMs: finiteDuration(result.duration),
      source: RESULT_SOURCE
    }
  })
}

export function renderLegacyConfig({ frontendConfig, legacyTestDir, globalSetup, tsconfig }) {
  return [
    `import baseConfig from ${JSON.stringify(frontendConfig)}`,
    '',
    'export default {',
    '  ...baseConfig,',
    `  testDir: ${JSON.stringify(legacyTestDir)},`,
    `  globalSetup: ${JSON.stringify(globalSetup)},`,
    `  tsconfig: ${JSON.stringify(tsconfig)}`,
    '}',
    ''
  ].join('\n')
}

export function normalizeFailureMessage(message, caseInfo) {
  requireCanaryCase({
    id: caseInfo.id ?? `${caseInfo.routeId}|${caseInfo.theme}|${caseInfo.viewportId}|${caseInfo.media}`,
    ...caseInfo
  })
  const stepId = `case:${caseInfo.routeId}:${caseInfo.theme}:${caseInfo.viewportId}:${caseInfo.media}`
  const legacyLabel = `${caseInfo.routeId} ${caseInfo.viewportId} ${caseInfo.theme} ${caseInfo.media}`
  return String(message ?? '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replaceAll(stepId, '<case>')
    .replaceAll(legacyLabel, '<case>')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .filter((line) => !/^\s*at\s+/u.test(line))
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

export function parsePlaywrightCaseReport(report, caseInfo, runner) {
  requireCanaryCase(caseInfo)
  if (runner !== 'legacy' && runner !== 'current') {
    throw new Error(`unknown viewport canary runner: ${String(runner)}`)
  }
  if (!report || !Array.isArray(report.suites)) {
    throw new Error(`${runner} Playwright JSON report is invalid for ${caseInfo.id}`)
  }
  if ((report.errors ?? []).length > 0) {
    throw new Error(`${runner} Playwright JSON report has global errors for ${caseInfo.id}`)
  }

  const tests = report.suites.flatMap(collectReportTests)
  if (tests.length !== 1) {
    throw new Error(
      `${runner} Playwright JSON report must contain exactly one isolated test for ${caseInfo.id}; found ${tests.length}`
    )
  }
  const results = tests[0]?.results ?? []
  if (results.length !== 1) {
    throw new Error(
      `${runner} Playwright JSON report must contain exactly one result for ${caseInfo.id}; found ${results.length}`
    )
  }
  const result = results[0]
  if (result.status !== 'passed' && result.status !== 'failed' && result.status !== 'timedOut') {
    throw new Error(`${runner} Playwright case ${caseInfo.id} was not fully executed: ${String(result.status)}`)
  }

  if (result.status === 'passed') {
    return {
      id: caseInfo.id,
      runner,
      outcome: 'passed',
      failureSignature: 'passed',
      normalizedFailure: null,
      durationMs: finiteDuration(result.duration),
      source: RESULT_SOURCE
    }
  }

  const rawMessages = [
    ...(result.errors ?? []).map((error) => error?.message),
    result.error?.message
  ].filter(Boolean)
  const normalizedMessages = [...new Set(
    rawMessages.map((message) => normalizeFailureMessage(message, caseInfo)).filter(Boolean)
  )].sort()
  if (normalizedMessages.length === 0) {
    throw new Error(`${runner} Playwright failure has no error message for ${caseInfo.id}`)
  }
  const normalizedFailure = normalizedMessages.join('\n---\n')
  return {
    id: caseInfo.id,
    runner,
    outcome: result.status,
    failureSignature: `sha256:${sha256Text(normalizedFailure)}`,
    normalizedFailure,
    durationMs: finiteDuration(result.duration),
    source: RESULT_SOURCE
  }
}

export function validateLegacySnapshotManifest(manifest, fileDigests) {
  if (manifest?.schema !== LEGACY_SNAPSHOT_SCHEMA) {
    throw new Error(`legacy snapshot schema must be ${LEGACY_SNAPSHOT_SCHEMA}`)
  }
  if (manifest.runtimeRoot !== 'runtime') {
    throw new Error('legacy snapshot runtimeRoot must be runtime')
  }
  if (manifest.historicalBaseline !== 'historical-failure-signatures.json') {
    throw new Error('legacy snapshot must bind historical-failure-signatures.json')
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('legacy snapshot manifest must bind at least one source file')
  }

  const seen = new Set()
  for (const entry of manifest.files) {
    if (
      !entry?.path
      || path.isAbsolute(entry.path)
      || entry.path.split('/').includes('..')
      || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '')
    ) {
      throw new Error(`legacy snapshot has an invalid file declaration: ${JSON.stringify(entry)}`)
    }
    if (seen.has(entry.path)) {
      throw new Error(`legacy snapshot contains duplicate source: ${entry.path}`)
    }
    seen.add(entry.path)
    const actual = fileDigests?.[entry.path]
    if (actual !== entry.sha256) {
      throw new Error(
        `legacy snapshot digest mismatch for ${entry.path}: expected=${entry.sha256} actual=${String(actual)}`
      )
    }
  }
  const unexpected = Object.keys(fileDigests ?? {}).filter((file) => !seen.has(file))
  if (unexpected.length > 0) {
    throw new Error(`legacy snapshot contains unbound runtime sources: ${unexpected.join(', ')}`)
  }
  for (const required of [
    'tests/frontend/e2e/ux/viewport-boundaries.spec.ts',
    'tests/frontend/support/playwright/acceptance-shared.ts',
    'tests/frontend/support/playwright/routeAuditFixtures.ts',
    'tests/frontend/support/playwright/routeAuditMatrix.ts',
    'tests/frontend/support/playwright/testSession.ts',
    'tests/frontend/support/fixture-paths.mjs',
    'tests/frontend/fixtures/ux-viewport-matrix.json',
    'tests/frontend/fixtures/ux-content-boundary-corpus.json'
  ]) {
    if (!seen.has(required)) {
      throw new Error(`legacy snapshot is missing required independent source: ${required}`)
    }
  }
  return manifest
}

export function validateHistoricalFailureBaseline(baseline, cases) {
  assertPlannedCases(cases)
  validateHistoricalBaselineDocument(baseline)
  const entries = Array.isArray(baseline.cases) ? baseline.cases : []
  if (baseline.status !== 'ready' || entries.length !== EXPECTED_CASE_COUNT) {
    throw blockedError(
      'historical-baseline-incomplete',
      `historical viewport failure baseline is incomplete: ${entries.length}/${EXPECTED_CASE_COUNT} signed cases`
    )
  }
  const indexed = new Map()
  for (const entry of entries) {
    if (!entry?.id || indexed.has(entry.id)) {
      throw new Error(`historical viewport failure baseline has invalid or duplicate id: ${String(entry?.id)}`)
    }
    if (entry.outcome !== 'failed' && entry.outcome !== 'timedOut') {
      throw new Error(`historical case ${entry.id} must preserve a failed or timedOut outcome`)
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(entry.failureSignature ?? '')) {
      throw new Error(`historical case ${entry.id} is missing a sha256 failure signature`)
    }
    if (!entry.normalizedFailure || typeof entry.normalizedFailure !== 'string') {
      throw new Error(`historical case ${entry.id} is missing its normalized failure message`)
    }
    if (entry.failureSignature !== `sha256:${sha256Text(entry.normalizedFailure)}`) {
      throw new Error(`historical case ${entry.id} signature does not match its normalized failure message`)
    }
    if (
      !entry.evidence?.path
      || !/^[a-f0-9]{64}$/u.test(entry.evidence?.sha256 ?? '')
      || entry.evidence?.format !== 'playwright-json-v2'
    ) {
      throw new Error(`historical case ${entry.id} is missing Playwright evidence provenance`)
    }
    indexed.set(entry.id, {
      ...entry,
      source: HISTORICAL_RESULT_SOURCE
    })
  }
  assertExactCaseIds(indexed, cases, 'historical baseline')
  return [...indexed.values()]
}

function validateHistoricalBaselineDocument(baseline) {
  if (baseline?.schema !== HISTORICAL_BASELINE_SCHEMA) {
    throw new Error(`historical viewport failure schema must be ${HISTORICAL_BASELINE_SCHEMA}`)
  }
  if (!['incomplete', 'ready'].includes(baseline.status)) {
    throw new Error(`historical viewport failure baseline status is invalid: ${String(baseline.status)}`)
  }
  if (baseline.expectedCaseCount !== EXPECTED_CASE_COUNT) {
    throw new Error(`historical viewport failure baseline must expect ${EXPECTED_CASE_COUNT} cases`)
  }
  const entries = Array.isArray(baseline.cases) ? baseline.cases : []
  if (baseline.capturedCaseCount !== entries.length) {
    throw new Error('historical viewport failure capturedCaseCount must match cases.length')
  }
  const observation = baseline.retainedObservation
  if (observation) {
    const groups = Array.isArray(baseline.observedGroupFailures)
      ? baseline.observedGroupFailures
      : []
    if (observation.groupFailureCount !== groups.length) {
      throw new Error('historical viewport retained groupFailureCount must match observedGroupFailures')
    }
    const observationSha256 = sha256Text(`${groups.join('\n')}\n`)
    if (observation.sha256 !== observationSha256) {
      throw new Error('historical viewport retained observation digest mismatch')
    }
    if (observation.containsCaseFailureMessages !== false) {
      throw new Error('incomplete historical viewport observation must not claim case failure messages')
    }
  }
}

export function buildParityEvidence({
  matrixVersion,
  cases,
  legacyResults,
  currentResults,
  historicalResults,
  runners,
  generatedAt = new Date().toISOString()
}) {
  assertPlannedCases(cases)
  const legacy = indexCompleteResults(legacyResults, cases, 'legacy')
  const current = indexCompleteResults(currentResults, cases, 'current')
  const historical = historicalResults?.length === EXPECTED_CASE_COUNT
    ? indexHistoricalResults(historicalResults, cases)
    : null
  const comparisons = cases.map((caseInfo) => {
    const legacyResult = legacy.get(caseInfo.id)
    const currentResult = current.get(caseInfo.id)
    const historicalResult = historical?.get(caseInfo.id) ?? null
    const runnersMatch = legacyResult.outcome === currentResult.outcome
      && legacyResult.failureSignature === currentResult.failureSignature
    const historicalMatches = historicalResult === null ? null : historicalResult.outcome === legacyResult.outcome
      && historicalResult.outcome === currentResult.outcome
      && historicalResult.failureSignature === legacyResult.failureSignature
      && historicalResult.failureSignature === currentResult.failureSignature
    const matches = runnersMatch && historicalMatches !== false
    return {
      ...caseInfo,
      matches,
      runnersMatch,
      historicalMatches,
      historical: historicalResult ? compactResult(historicalResult) : null,
      legacy: compactResult(legacyResult),
      current: compactResult(currentResult)
    }
  })
  const mismatches = comparisons.filter((entry) => !entry.matches)
  const matchedCaseCount = comparisons.length - mismatches.length
  const historicalMatchedCaseCount = historical === null
    ? null
    : comparisons.filter((entry) => entry.historicalMatches).length

  return {
    schema: EVIDENCE_SCHEMA,
    status: mismatches.length === 0 ? 'success' : 'failed',
    generatedAt,
    executionMode: 'two-playwright-batches-with-isolated-cases',
    comparison: historical === null
      ? 'normalized-failure-signature-v2-runner-parity'
      : 'normalized-failure-signature-v2-historical-authority',
    matrixVersion,
    selection: {
      routeIds: [...UX_VIEWPORT_MOBILE_LANDSCAPE_CANARY_ROUTE_IDS],
      themes: [...EXPECTED_THEMES],
      viewportIds: [VIEWPORT_ID],
      media: [...EXPECTED_MEDIA]
    },
    plannedCaseCount: EXPECTED_CASE_COUNT,
    executedCaseCount: {
      legacy: legacyResults.length,
      current: currentResults.length
    },
    matchedCaseCount,
    historicalMatchedCaseCount,
    mismatchCount: mismatches.length,
    runners,
    durationMs: {
      legacy: sumDurations(legacyResults),
      current: sumDurations(currentResults)
    },
    mismatches,
    cases: comparisons
  }
}

async function runCli() {
  const options = parseArgs(process.argv.slice(2))
  const paths = resolveParityPaths(options.root, options)
  const matrix = JSON.parse(await readFile(paths.matrixFile, 'utf8'))
  const cases = buildMobileLandscapeCanaryCases(matrix)
  if (options.plan) {
    let snapshot
    let snapshotError = null
    try {
      snapshot = await inspectLegacySnapshot(paths)
    } catch (error) {
      snapshotError = error instanceof Error ? error.message : String(error)
    }
    process.stdout.write(`${JSON.stringify({
      matrixVersion: matrix.version,
      plannedCaseCount: cases.length,
      cases,
      legacySnapshot: snapshot
        ? snapshotSummary(paths, snapshot)
        : { status: 'invalid', error: snapshotError }
    }, null, 2)}\n`)
    return 0
  }
  if (options.checkAuthority) {
    let snapshot = null
    let runners = null
    try {
      await assertRuntimePrerequisites(paths, { requireRuntime: false })
      snapshot = await inspectLegacySnapshot(paths)
      runners = await runnerMetadata(paths, snapshot)
      validateHistoricalFailureBaseline(snapshot.baseline, cases)
      console.log('[ux-viewport-canary-parity] historical authority is ready')
      return 0
    } catch (error) {
      const blocked = buildBlockedEvidence({
        matrixVersion: matrix.version,
        cases,
        legacyResults: [],
        currentResults: [],
        runners,
        paths,
        snapshot,
        error
      })
      await writeJsonAtomic(paths.outFile, blocked)
      console.error(`[ux-viewport-canary-parity] blocked: ${blocked.error}`)
      console.error(`[ux-viewport-canary-parity] evidence=${relative(paths.root, paths.outFile)}`)
      return 1
    }
  }

  let legacyResults = []
  let currentResults = []
  let runners = null
  let snapshot = null
  try {
    await assertRuntimePrerequisites(paths)
    snapshot = await inspectLegacySnapshot(paths)
    runners = await runnerMetadata(paths, snapshot)
    const historicalResults = snapshot.baseline.status === 'ready'
      ? validateHistoricalFailureBaseline(snapshot.baseline, cases)
      : []
    const runRoot = path.join(paths.workRoot, `run-${Date.now()}-${randomUUID()}`)
    paths.workRoot = runRoot
    paths.legacyConfig = path.join(runRoot, 'playwright.legacy.config.mjs')
    await prepareLegacyWorkspace(paths)
    await preflightServices()

    ;[legacyResults, currentResults] = await Promise.all([
      executePlaywrightBatch({ runner: 'legacy', cases, paths }),
      executePlaywrightBatch({ runner: 'current', cases, paths })
    ])

    const finalSnapshot = await inspectLegacySnapshot(paths)
    const finalRunners = await runnerMetadata(paths, finalSnapshot)
    if (
      finalRunners.legacy.sha256 !== runners.legacy.sha256
      || finalRunners.current.sha256 !== runners.current.sha256
    ) {
      throw new Error('viewport runner source changed during canary parity execution')
    }
    const evidence = buildParityEvidence({
      matrixVersion: matrix.version,
      cases,
      legacyResults,
      currentResults,
      historicalResults,
      runners
    })
    await writeJsonAtomic(paths.outFile, evidence)
    console.log(
      `[ux-viewport-canary-parity] status=${evidence.status} `
      + `matched=${evidence.matchedCaseCount}/${evidence.plannedCaseCount} out=${relative(paths.root, paths.outFile)}`
    )
    return evidence.status === 'success' ? 0 : 1
  } catch (error) {
    const blocked = buildBlockedEvidence({
      matrixVersion: matrix.version,
      cases,
      legacyResults,
      currentResults,
      runners,
      paths,
      snapshot,
      error
    })
    await writeJsonAtomic(paths.outFile, blocked)
    console.error(`[ux-viewport-canary-parity] blocked: ${blocked.error}`)
    console.error(`[ux-viewport-canary-parity] evidence=${relative(paths.root, paths.outFile)}`)
    return 1
  }
}

async function executePlaywrightBatch({ runner, cases, paths }) {
  const invocation = buildPlaywrightBatchInvocation({ runner, cases, paths, runId: `parity-${Date.now()}` })
  await mkdir(path.dirname(invocation.reportFile), { recursive: true })
  await mkdir(invocation.outputDir, { recursive: true })
  await rm(invocation.reportFile, { force: true })
  const processResult = await spawnAndCapture(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: { ...process.env, ...invocation.env }
  })
  let report
  try {
    report = JSON.parse(await readFile(invocation.reportFile, 'utf8'))
  } catch (error) {
    const tail = processResult.output.trim().split('\n').slice(-12).join('\n')
    throw new Error(`${runner} Playwright batch report missing (exit ${processResult.exitCode})${tail ? `\n${tail}` : ''}`, { cause: error })
  }
  const results = parsePlaywrightBatchReport(report, cases, runner).map((result) => ({
    ...result,
    exitCode: processResult.exitCode,
    reportPath: relative(paths.root, invocation.reportFile)
  }))
  const expectedExitCode = results.every((result) => result.outcome === 'passed') ? 0 : 1
  if (processResult.exitCode !== expectedExitCode) {
    throw new Error(`${runner} Playwright batch exit/report mismatch: exit=${processResult.exitCode}`)
  }
  return results
}

async function executePlaywrightCase({ runner, caseInfo, paths }) {
  const invocation = buildPlaywrightCaseInvocation({
    runner,
    caseInfo,
    paths,
    runId: `parity-${Date.now()}`
  })
  await mkdir(path.dirname(invocation.reportFile), { recursive: true })
  await mkdir(path.dirname(invocation.outputDir), { recursive: true })
  await rm(invocation.reportFile, { force: true })

  const processResult = await spawnAndCapture(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: {
      ...process.env,
      ...invocation.env
    }
  })
  let report
  try {
    report = JSON.parse(await readFile(invocation.reportFile, 'utf8'))
  } catch (error) {
    const tail = processResult.output.trim().split('\n').slice(-12).join('\n')
    throw new Error(
      `${runner} Playwright JSON report missing for ${caseInfo.id} (exit ${processResult.exitCode})`
      + (tail ? `\n${tail}` : ''),
      { cause: error }
    )
  }
  const result = parsePlaywrightCaseReport(report, caseInfo, runner)
  const expectedExitCode = result.outcome === 'passed' ? 0 : 1
  if (processResult.exitCode !== expectedExitCode) {
    throw new Error(
      `${runner} Playwright exit/report mismatch for ${caseInfo.id}: `
      + `exit=${processResult.exitCode} outcome=${result.outcome}`
    )
  }
  return {
    ...result,
    exitCode: processResult.exitCode,
    reportPath: relative(paths.root, invocation.reportFile)
  }
}

export async function prepareLegacyWorkspace(paths) {
  const legacyRoot = path.join(paths.workRoot, 'legacy')
  const legacyTestDir = path.join(legacyRoot, 'tests/frontend/e2e')
  const frontendLink = path.join(legacyRoot, 'src/frontend')
  const nodeModulesLink = path.join(legacyRoot, 'node_modules')
  await rm(legacyRoot, { recursive: true, force: true })
  await cp(path.join(paths.legacySnapshotRoot, 'runtime'), legacyRoot, { recursive: true })
  const legacySpec = await readFile(path.join(legacyTestDir, 'ux/viewport-boundaries.spec.ts'), 'utf8')
  const batchSpec = legacySpec
    .replace(
      "const key = [testCase.viewport.name, testCase.theme, testCase.media, testCase.route.storage].join('|')",
      "const key = [testCase.route.id, testCase.viewport.name, testCase.theme, testCase.media].join('|')"
    )
    .replace(
      'id: `group-${groupNumber}-${testCase.viewport.name}-${testCase.theme}-${testCase.media}-${testCase.route.storage}`',
      'id: `case:${testCase.route.id}:${testCase.theme}:${testCase.viewport.name}:${testCase.media}`'
    )
  if (batchSpec === legacySpec) throw new Error('legacy parity batch instrumentation did not apply')
  await writeFile(path.join(legacyTestDir, 'ux/viewport-boundaries.spec.ts'), batchSpec)
  await mkdir(path.dirname(frontendLink), { recursive: true })
  await symlink(paths.frontendRoot, frontendLink, 'dir')
  await symlink(paths.nodeModules, nodeModulesLink, 'dir')
  await writeFile(path.join(legacyRoot, 'package.json'), '{"type":"module"}\n')
  await mkdir(path.dirname(paths.legacyConfig), { recursive: true })
  await writeFile(paths.legacyConfig, renderLegacyConfig({
    frontendConfig: paths.frontendConfig,
    legacyTestDir,
    globalSetup: paths.globalSetup,
    tsconfig: paths.playwrightTsconfig
  }))
}

async function assertRuntimePrerequisites(paths, { requireRuntime = true } = {}) {
  for (const [label, file] of [
    ...(requireRuntime ? [
      ['Playwright CLI', paths.playwrightCli],
      ['frontend Playwright config', paths.frontendConfig],
      ['frontend Playwright tsconfig', paths.playwrightTsconfig]
    ] : []),
    ['tracked legacy viewport snapshot', paths.legacySnapshotRoot],
    ['legacy viewport snapshot manifest', paths.legacyManifest],
    ['historical viewport failure baseline', paths.historicalBaseline],
    ['legacy viewport runner snapshot', paths.legacySpec],
    ['current viewport runner', paths.currentSpec]
  ]) {
    try {
      await access(file)
    } catch {
      throw new Error(`${label} is missing: ${file}`)
    }
  }
  if (requireRuntime
    && process.env.FSUSBLOG_TEST_SESSION_ISOLATION === '1'
    && process.env.FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP !== '1') {
    throw new Error(
      'session isolation requires fixtures to be prepared once before parity; '
      + 'set FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP=1 after prepare_session_fixtures_once'
    )
  }
}

export async function inspectLegacySnapshot(paths) {
  const manifest = JSON.parse(await readFile(paths.legacyManifest, 'utf8'))
  const baselinePath = path.join(paths.legacySnapshotRoot, manifest.historicalBaseline ?? '')
  if (path.resolve(baselinePath) !== path.resolve(paths.historicalBaseline)) {
    throw new Error('legacy snapshot historical baseline path escaped its tracked root')
  }
  const fileDigests = {}
  const runtimeRoot = path.resolve(paths.legacySnapshotRoot, 'runtime')
  for (const file of await listFilesRecursively(runtimeRoot)) {
    fileDigests[relative(runtimeRoot, file)] = await sha256File(file)
  }
  validateLegacySnapshotManifest(manifest, fileDigests)
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
  validateHistoricalBaselineDocument(baseline)
  return {
    manifest,
    baseline,
    manifestSha256: await sha256File(paths.legacyManifest),
    baselineSha256: await sha256File(baselinePath),
    sourceSha256: sha256Text(JSON.stringify(manifest.files))
  }
}

async function listFilesRecursively(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursively(child))
    } else if (entry.isFile()) {
      files.push(child)
    } else {
      throw new Error(`legacy snapshot runtime contains unsupported filesystem entry: ${child}`)
    }
  }
  return files.sort()
}

async function preflightServices() {
  const frontendUrl = requiredUrl('PLAYWRIGHT_BASE_URL')
  const backendUrl = requiredUrl('FSUSBLOG_BASE_URL')
  await probeUrl(new URL('/', frontendUrl), {})
  await probeUrl(new URL('/api/binary/system/seo', backendUrl), {
    headers: { Accept: 'application/octet-stream' }
  })
}

async function probeUrl(url, options) {
  let response
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(5_000)
    })
  } catch (error) {
    throw new Error(`required parity service is unreachable: ${url.origin}`, { cause: error })
  }
  if (!response.ok) {
    throw new Error(`required parity service returned ${response.status}: ${url}`)
  }
}

function requiredUrl(name) {
  const raw = process.env[name]
  if (!raw) {
    throw new Error(`${name} is required for live viewport canary parity`)
  }
  try {
    return new URL(raw)
  } catch {
    throw new Error(`${name} must be an absolute URL: ${raw}`)
  }
}

async function runnerMetadata(paths, snapshot) {
  const currentSources = {}
  for (const file of paths.currentSources) {
    currentSources[relative(paths.root, file)] = await sha256File(file)
  }
  return {
    legacy: {
      spec: relative(paths.root, paths.legacySpec),
      manifest: relative(paths.root, paths.legacyManifest),
      manifestSha256: snapshot.manifestSha256,
      historicalBaseline: relative(paths.root, paths.historicalBaseline),
      historicalBaselineSha256: snapshot.baselineSha256,
      sha256: snapshot.sourceSha256,
      sourceFiles: Object.fromEntries(snapshot.manifest.files.map((entry) => [entry.path, entry.sha256]))
    },
    current: {
      spec: relative(paths.root, paths.currentSpec),
      sha256: sha256Text(JSON.stringify(currentSources)),
      sourceFiles: currentSources
    }
  }
}

function collectReportTests(suite) {
  return [
    ...(suite.specs ?? []).flatMap((spec) => spec.tests ?? []),
    ...(suite.suites ?? []).flatMap(collectReportTests)
  ]
}

function collectReportSpecs(suite) {
  return [
    ...(suite.specs ?? []),
    ...(suite.suites ?? []).flatMap(collectReportSpecs)
  ]
}

function indexCompleteResults(results, cases, runner) {
  if (!Array.isArray(results) || results.length !== EXPECTED_CASE_COUNT) {
    throw new Error(`${runner} results must contain exactly the ${EXPECTED_CASE_COUNT} planned canary cases`)
  }
  const indexed = new Map()
  for (const result of results) {
    if (result?.runner !== runner || result?.source !== RESULT_SOURCE) {
      throw new Error(`${runner} result ${String(result?.id)} is not a real Playwright JSON v2 result`)
    }
    if (!result.id || indexed.has(result.id)) {
      throw new Error(`${runner} results contain an invalid or duplicate case id: ${String(result?.id)}`)
    }
    indexed.set(result.id, result)
  }
  assertExactCaseIds(indexed, cases, `${runner} results`)
  return indexed
}

function indexHistoricalResults(results, cases) {
  if (!Array.isArray(results) || results.length !== EXPECTED_CASE_COUNT) {
    throw new Error(`historical results must contain exactly the ${EXPECTED_CASE_COUNT} planned canary cases`)
  }
  const indexed = new Map()
  for (const result of results) {
    if (result?.source !== HISTORICAL_RESULT_SOURCE || !result.id || indexed.has(result.id)) {
      throw new Error(`historical result ${String(result?.id)} is invalid or lacks authoritative provenance`)
    }
    if (result.outcome !== 'failed' && result.outcome !== 'timedOut') {
      throw new Error(`historical result ${result.id} must retain a failure outcome`)
    }
    indexed.set(result.id, result)
  }
  assertExactCaseIds(indexed, cases, 'historical results')
  return indexed
}

function assertExactCaseIds(indexed, cases, label) {
  const expected = new Set(cases.map((entry) => entry.id))
  const missing = cases.filter((entry) => !indexed.has(entry.id)).map((entry) => entry.id)
  const unexpected = [...indexed.keys()].filter((id) => !expected.has(id))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`${label} must contain exactly the ${EXPECTED_CASE_COUNT} planned canary cases`)
  }
}

function assertPlannedCases(cases) {
  if (!Array.isArray(cases) || cases.length !== EXPECTED_CASE_COUNT) {
    throw new Error(`canary comparison requires exactly ${EXPECTED_CASE_COUNT} planned cases`)
  }
  const ids = new Set()
  for (const caseInfo of cases) {
    requireCanaryCase(caseInfo)
    if (ids.has(caseInfo.id)) {
      throw new Error(`duplicate canary case id: ${caseInfo.id}`)
    }
    ids.add(caseInfo.id)
  }
}

function requireCanaryCase(caseInfo) {
  if (
    !caseInfo?.id
    || !UX_VIEWPORT_MOBILE_LANDSCAPE_CANARY_ROUTE_IDS.includes(caseInfo.routeId)
    || !EXPECTED_THEMES.includes(caseInfo.theme)
    || caseInfo.viewportId !== VIEWPORT_ID
    || !EXPECTED_MEDIA.includes(caseInfo.media)
  ) {
    throw new Error(`invalid mobile-landscape canary case: ${JSON.stringify(caseInfo)}`)
  }
}

function compactResult(result) {
  return {
    outcome: result.outcome,
    failureSignature: result.failureSignature,
    normalizedFailure: result.normalizedFailure,
    durationMs: result.durationMs,
    exitCode: result.exitCode ?? null,
    reportPath: result.reportPath ?? null,
    source: result.source
  }
}

function snapshotSummary(paths, snapshot) {
  return {
    status: snapshot.baseline.status === 'ready' ? 'ready' : 'incomplete',
    manifest: relative(paths.root, paths.legacyManifest),
    manifestSha256: snapshot.manifestSha256,
    historicalBaseline: relative(paths.root, paths.historicalBaseline),
    historicalBaselineSha256: snapshot.baselineSha256,
    expectedCaseCount: snapshot.baseline.expectedCaseCount ?? EXPECTED_CASE_COUNT,
    capturedCaseCount: Array.isArray(snapshot.baseline.cases) ? snapshot.baseline.cases.length : 0,
    observedGroupFailureCount: Array.isArray(snapshot.baseline.observedGroupFailures)
      ? snapshot.baseline.observedGroupFailures.length
      : 0,
    reason: snapshot.baseline.reason ?? null
  }
}

function buildBlockedEvidence({
  matrixVersion,
  cases,
  legacyResults,
  currentResults,
  runners,
  paths,
  snapshot,
  error
}) {
  return {
    schema: EVIDENCE_SCHEMA,
    status: 'blocked',
    generatedAt: new Date().toISOString(),
    executionMode: 'isolated-playwright-case-pairs',
    comparison: 'normalized-failure-signature-v2-historical-authority',
    matrixVersion,
    plannedCaseCount: cases.length,
    executedCaseCount: {
      legacy: legacyResults.length,
      current: currentResults.length
    },
    runners,
    blockingCode: error?.code ?? 'parity-execution-blocked',
    legacySnapshot: snapshot ? snapshotSummary(paths, snapshot) : null,
    error: error instanceof Error ? error.message : String(error)
  }
}

function blockedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function parseArgs(args) {
  const options = {
    root: defaultRoot,
    plan: false,
    checkAuthority: false
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--plan') {
      options.plan = true
      continue
    }
    if (arg === '--check-authority') {
      options.checkAuthority = true
      continue
    }
    if (['--root', '--legacy-snapshot', '--out', '--work-root'].includes(arg)) {
      const value = args[index + 1]
      if (!value) throw new Error(`${arg} requires a value`)
      index += 1
      if (arg === '--root') options.root = path.resolve(value)
      if (arg === '--legacy-snapshot') options.legacySnapshotRoot = path.resolve(value)
      if (arg === '--out') options.outFile = path.resolve(value)
      if (arg === '--work-root') options.workRoot = path.resolve(value)
      continue
    }
    throw new Error(`unknown viewport canary parity option: ${arg}`)
  }
  return options
}

function assertExactList(actual, expected, label) {
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must equal ${expected.join(', ')}`)
  }
}

function sanitizeSegment(value) {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return normalized || 'case'
}

function finiteDuration(value) {
  const duration = Number(value)
  return Number.isFinite(duration) && duration >= 0 ? duration : 0
}

function sumDurations(results) {
  return results.reduce((total, result) => total + finiteDuration(result.durationMs), 0)
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256File(file) {
  return sha256Text(await readFile(file))
}

function relative(root, file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

async function spawnAndCapture(command, args, options) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => chunks.push(chunk))
    child.once('error', reject)
    child.once('close', (exitCode, signal) => {
      resolve({
        exitCode: Number.isInteger(exitCode) ? exitCode : 1,
        signal,
        output: Buffer.concat(chunks).toString('utf8')
      })
    })
  })
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  try {
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  process.exitCode = await runCli()
}
