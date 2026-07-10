import assert from 'node:assert/strict'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const configFile = path.join(repoRoot, 'src/frontend/playwright.config.ts')
const specFile = path.join(repoRoot, 'tests/frontend/e2e/ux/viewport-boundaries.spec.ts')
const sharedFile = path.join(repoRoot, 'tests/frontend/support/playwright/acceptance-shared.ts')

test('Playwright has no suite timeout or maximum failure cutoff during diagnostics', async () => {
  const source = await readFile(configFile, 'utf8')

  assert.match(source, /timeout:\s*0/u)
  assert.doesNotMatch(source, /maxFailures/u)
  assert.doesNotMatch(source, /FSUSBLOG_PLAYWRIGHT_DIAGNOSTIC_ALL_FAILURES/u)
  assert.match(source, /FSUSBLOG_PLAYWRIGHT_TRACE/u)
  assert.match(source, /trace:\s*traceMode/u)

  const spec = await readFile(specFile, 'utf8')
  const describeConfig = sliceBetween(
    spec,
    'test.describe(`UX viewport boundaries',
    'const testGroups = parityBatch'
  )
  assert.doesNotMatch(describeConfig, /timeout/u)
})

test('viewport runner owns one route-theme context and one cold page navigation per viewport', async () => {
  const source = await readFile(specFile, 'utf8')

  assert.match(source, /buildUxViewportPlan/u)
  assert.match(source, /openUxViewportProgress/u)
  assert.match(source, /const testGroups = parityBatch[\s\S]*?: plan\.groups/u)
  assert.match(source, /for \(const group of testGroups\)/u)
  assert.match(source, /openThemedAuditedContext\(browser, group\.theme/u)
  assert.match(source, /for \(const viewportPlan of group\.viewports\)/u)
  assert.match(source, /auditedContext\.newPage\(\)/u)
  assert.match(source, /test\.step\(step\.id/u)
  assert.match(source, /resetUxViewportMediaMode/u)
  assert.match(source, /assertUxViewportMediaMode/u)
  assert.match(source, /recordUxViewportGroupResult/u)
  assert.doesNotMatch(source, /groupNumber|buildCaseGroups/u)

  const groupRunner = sliceBetween(source, 'async function runUxRouteThemeGroup', 'async function storageStateFor')
  assert.equal((groupRunner.match(/\.goto\(/gu) ?? []).length, 1)
  assert.match(groupRunner, /finally\s*\{[\s\S]*resetUxViewportMediaMode/u)
})

test('viewport boundary contract uses one structural evaluate and retains focus-sticky probes separately', async () => {
  const source = await readFile(sharedFile, 'utf8')
  const collector = sliceBetween(
    source,
    'export async function collectViewportBoundaryReport',
    'export async function assertViewportBoundaryContract'
  )
  const contract = sliceBetween(
    source,
    'export async function assertViewportBoundaryContract',
    'export async function assertThemeReadable'
  )

  assert.equal((collector.match(/page\.evaluate\(/gu) ?? []).length, 1)
  for (const key of [
    'horizontalOverflow',
    'verticalTrap',
    'interactiveControls',
    'modalActions',
    'drawerHeight',
    'dropdownClipping',
    'readableLineWidth',
    'dashboardGrid',
    'editorPanel',
    'tableResponsive',
    'richContentScroll',
    'touchTargets',
    'mobileLandscape'
  ]) {
    assert.match(collector, new RegExp(`${key}:`))
  }
  assert.match(contract, /collectViewportBoundaryReport/u)
  assert.match(contract, /assertStickyHeaderDoesNotCoverFocusedInput/u)
  assert.match(contract, /assertFocusOutlineVisible/u)
  assert.match(contract, /assertNoDuplicateStickyBars/u)
  assert.doesNotMatch(contract, /page\.evaluate\(/u)
})

test('media helpers make every matrix state explicit and resettable', async () => {
  const source = await readFile(sharedFile, 'utf8')
  const mediaHelpers = sliceBetween(
    source,
    'export async function resetUxViewportMediaMode',
    'export async function collectViewportBoundaryReport'
  )

  assert.match(mediaHelpers, /reducedMotion:\s*'no-preference'/u)
  assert.match(mediaHelpers, /forcedColors:\s*'none'/u)
  assert.match(mediaHelpers, /contrast:\s*'no-preference'/u)
  assert.match(mediaHelpers, /data-ux-viewport-media/u)
  assert.match(mediaHelpers, /document\.activeElement/u)
  assert.match(mediaHelpers, /\.blur\(\)/u)
  assert.match(mediaHelpers, /scrollTo\(0, 0\)/u)
  assert.match(mediaHelpers, /removeAllRanges\(\)/u)
  assert.match(mediaHelpers, /export async function applyUxViewportMediaMode/u)
  assert.match(mediaHelpers, /export async function assertUxViewportMediaMode/u)
  assert.match(mediaHelpers, /scrollX/u)
  assert.match(mediaHelpers, /scrollY/u)
  assert.match(mediaHelpers, /hasFocusedElement/u)
  assert.match(mediaHelpers, /should reset page scroll/u)
  assert.match(mediaHelpers, /should clear probe focus/u)
})

test('readable-width checks compare logical width instead of injected zoom geometry', async () => {
  const source = await readFile(sharedFile, 'utf8')
  const focusedContract = sliceBetween(
    source,
    'export async function assertReadableLineWidthWithinBounds',
    'export async function assertDashboardGridWidthBounds'
  )
  const aggregateContract = sliceBetween(
    source,
    'export async function collectViewportBoundaryReport',
    'export async function assertViewportBoundaryContract'
  )

  for (const contract of [focusedContract, aggregateContract]) {
    assert.match(contract, /getComputedStyle\(document\.documentElement\)\.zoom/u)
    assert.match(contract, /const logicalWidth = rect\.width \/ rootZoom/u)
    assert.match(contract, /logicalWidth > maxReadableWidth \+ 8/u)
  }
  assert.match(aggregateContract, /header\.closest\('main, article, footer'\)/u)
})

test('acceptance storage states use the namespaced auth fixture directory', async () => {
  const source = await readFile(sharedFile, 'utf8')

  assert.match(source, /resolveAuthFixtureDirectory/u)
  assert.match(source, /path\.join\(resolveAuthFixtureDirectory\(\), storageStateFile\)/u)
  assert.match(source, /path\.join\(resolveAuthFixtureDirectory\(\), userStorageStateFile\)/u)
  assert.doesNotMatch(source, /acceptanceFixtureRoot|src\/frontend\/\.playwright-fixtures/u)
})

test('summary reports current progress counts and never collects stale artifacts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fsusblog-ux-summary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'tests/frontend/fixtures'), { recursive: true })
  await copyFile(
    path.join(repoRoot, 'tests/frontend/fixtures/ux-viewport-matrix.json'),
    path.join(root, 'tests/frontend/fixtures/ux-viewport-matrix.json')
  )
  await copyFile(
    path.join(repoRoot, 'tests/frontend/fixtures/ux-content-boundary-corpus.json'),
    path.join(root, 'tests/frontend/fixtures/ux-content-boundary-corpus.json')
  )

  const runRoot = path.join(root, '.tmp/ux/runs/current-run/smoke')
  const outputDir = path.join(runRoot, 'playwright')
  await mkdir(path.join(runRoot, 'screenshots/mobile/light'), { recursive: true })
  await mkdir(path.join(outputDir, 'failed-case'), { recursive: true })
  await mkdir(path.join(root, '.tmp/ux/screenshots/smoke'), { recursive: true })
  await writeFile(path.join(runRoot, 'screenshots/mobile/light/public-home.png'), 'current default screenshot')
  await writeFile(path.join(outputDir, 'failed-case/test-failed-1.png'), 'current failure screenshot')
  await writeFile(path.join(outputDir, 'failed-case/trace.zip'), 'current trace')
  await writeFile(path.join(root, '.tmp/ux/screenshots/smoke/old.png'), 'stale screenshot')

  const progressFile = path.join(runRoot, 'progress.json')
  await writeFile(progressFile, `${JSON.stringify({
    version: 'fsusblog-ux-viewport-progress-v1',
    runId: 'current-run',
    mode: 'smoke',
    planFingerprint: 'current-fingerprint',
    matrixVersion: 'fsusblog-ux-viewport-matrix-v1',
    status: 'failed',
    startedAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:10:00.000Z',
    finishedAt: '2026-07-10T00:10:00.000Z',
    planned: { routes: 10, routeThemeGroups: 20, navigations: 120, cases: 336 },
    actual: {
      completedRouteThemeGroups: 1,
      navigations: 6,
      cases: 24,
      failedRouteThemeGroups: 1
    },
    completedGroupIds: ['route-theme:public-article:light'],
    groupResults: [
      { groupId: 'route-theme:public-article:light', routeId: 'public-article', theme: 'light', status: 'passed' },
      { groupId: 'route-theme:public-login:dark', routeId: 'public-login', theme: 'dark', status: 'failed', error: 'assertion failed' }
    ],
    artifacts: {
      root: '.tmp/ux/runs/current-run/smoke',
      outputDir: '.tmp/ux/runs/current-run/smoke/playwright'
    }
  }, null, 2)}\n`)
  await mkdir(path.join(root, '.tmp/ux'), { recursive: true })
  await writeFile(path.join(root, '.tmp/ux/current-smoke-run.json'), `${JSON.stringify({
    version: 'fsusblog-ux-viewport-run-pointer-v1',
    runId: 'current-run',
    mode: 'smoke',
    planFingerprint: 'current-fingerprint',
    progressFile: '.tmp/ux/runs/current-run/smoke/progress.json'
  }, null, 2)}\n`)

  const { writeUxViewportSummary } = await import(
    `../frontend/checks/ux/write-ux-viewport-summary.mjs?test=${Date.now()}`
  )
  const result = await writeUxViewportSummary({ root, mode: 'smoke' })
  const modeSummary = JSON.parse(await readFile(result.artifact, 'utf8'))
  const releaseSummary = JSON.parse(await readFile(result.releaseArtifact, 'utf8'))

  assert.equal(modeSummary.status, 'failed')
  assert.equal(modeSummary.plannedCaseCount, 336)
  assert.equal(modeSummary.completedCaseCount, 24)
  assert.equal(modeSummary.plannedNavigationCount, 120)
  assert.equal(modeSummary.completedNavigationCount, 6)
  assert.equal(modeSummary.completedRouteThemeGroupCount, 1)
  assert.equal(modeSummary.failedRouteThemeGroupCount, 1)
  assert.deepEqual(modeSummary.screenshots, [
    '.tmp/ux/runs/current-run/smoke/screenshots/mobile/light/public-home.png'
  ])
  assert.deepEqual(modeSummary.failureScreenshots, [
    '.tmp/ux/runs/current-run/smoke/playwright/failed-case/test-failed-1.png'
  ])
  assert.deepEqual(modeSummary.traces, [
    '.tmp/ux/runs/current-run/smoke/playwright/failed-case/trace.zip'
  ])
  assert.equal(JSON.stringify(modeSummary).includes('old.png'), false)
  assert.equal(releaseSummary.status, 'failed')
  assert.deepEqual(releaseSummary.failureScreenshots, modeSummary.failureScreenshots)
  assert.deepEqual(releaseSummary.traces, modeSummary.traces)

  const completedProgress = JSON.parse(await readFile(progressFile, 'utf8'))
  completedProgress.status = 'passed'
  completedProgress.actual = {
    completedRouteThemeGroups: 20,
    navigations: 120,
    cases: 336,
    failedRouteThemeGroups: 0
  }
  completedProgress.groupResults = completedProgress.groupResults
    .filter((entry) => entry.status === 'passed')
  await writeFile(progressFile, `${JSON.stringify(completedProgress, null, 2)}\n`)

  const completedResult = await writeUxViewportSummary({ root, mode: 'smoke' })
  assert.equal(completedResult.summary.status, 'ok')
  assert.equal(completedResult.summary.completedCaseCount, 336)
})

test('visual summary requires exactly one screenshot per planned cold navigation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fsusblog-ux-visual-summary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'tests/frontend/fixtures'), { recursive: true })
  for (const fixture of ['ux-viewport-matrix.json', 'ux-content-boundary-corpus.json']) {
    await copyFile(path.join(repoRoot, 'tests/frontend/fixtures', fixture), path.join(root, 'tests/frontend/fixtures', fixture))
  }
  const runRoot = path.join(root, '.tmp/ux/runs/visual-run/visual')
  const screenshotRoot = path.join(runRoot, 'screenshots')
  await mkdir(screenshotRoot, { recursive: true })
  const progressFile = path.join(runRoot, 'progress.json')
  await writeFile(progressFile, `${JSON.stringify({
    version: 'fsusblog-ux-viewport-progress-v1',
    runId: 'visual-run',
    mode: 'visual',
    planFingerprint: 'visual-fingerprint',
    matrixVersion: 'fsusblog-ux-viewport-matrix-v1',
    status: 'passed',
    startedAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:10:00.000Z',
    finishedAt: '2026-07-10T00:10:00.000Z',
    planned: { routes: 9, routeThemeGroups: 18, navigations: 126, cases: 378 },
    actual: { completedRouteThemeGroups: 18, navigations: 126, cases: 378, failedRouteThemeGroups: 0 },
    completedGroupIds: [],
    groupResults: [],
    artifacts: { root: '.tmp/ux/runs/visual-run/visual', outputDir: '.tmp/ux/runs/visual-run/visual/playwright' }
  }, null, 2)}\n`)
  await mkdir(path.join(root, '.tmp/ux'), { recursive: true })
  await writeFile(path.join(root, '.tmp/ux/current-visual-run.json'), `${JSON.stringify({
    version: 'fsusblog-ux-viewport-run-pointer-v1',
    runId: 'visual-run',
    mode: 'visual',
    planFingerprint: 'visual-fingerprint',
    progressFile: '.tmp/ux/runs/visual-run/visual/progress.json'
  }, null, 2)}\n`)
  const { writeUxViewportSummary } = await import(`../frontend/checks/ux/write-ux-viewport-summary.mjs?visual=${Date.now()}`)
  const missing = await writeUxViewportSummary({ root, mode: 'visual' })
  assert.equal(missing.summary.status, 'incomplete')
  assert.equal(missing.summary.plannedScreenshotCount, 126)
  for (let index = 0; index < 126; index += 1) {
    await writeFile(path.join(screenshotRoot, `${index}.png`), 'screenshot')
  }
  const complete = await writeUxViewportSummary({ root, mode: 'visual' })
  assert.equal(complete.summary.status, 'ok')
  assert.equal(complete.summary.screenshotCount, 126)
})

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`)
  return source.slice(start, end)
}
