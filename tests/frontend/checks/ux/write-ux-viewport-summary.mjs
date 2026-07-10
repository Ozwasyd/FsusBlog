#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const validModes = new Set(['smoke', 'visual', 'boundaries'])

export async function writeUxViewportSummary({ root = defaultRoot, mode = 'smoke' } = {}) {
  const resolvedRoot = path.resolve(root)
  if (!validModes.has(mode)) {
    throw new Error(`unknown UX viewport summary mode: ${mode}`)
  }

  const matrixFile = path.join(resolvedRoot, 'tests/frontend/fixtures/ux-viewport-matrix.json')
  const corpusFile = path.join(resolvedRoot, 'tests/frontend/fixtures/ux-content-boundary-corpus.json')
  const matrix = readJson(matrixFile)
  const corpus = readJson(corpusFile)
  const errors = validateMatrix(matrix, corpus)
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }

  const pointerFile = path.join(resolvedRoot, '.tmp/ux', `current-${mode}-run.json`)
  const pointer = readJson(pointerFile)
  if (pointer.mode !== mode || !pointer.progressFile || !pointer.planFingerprint) {
    throw new Error(`invalid current UX viewport run pointer: ${relative(resolvedRoot, pointerFile)}`)
  }

  const progressFile = resolveInsideRoot(resolvedRoot, pointer.progressFile)
  const progress = readJson(progressFile)
  validateProgress(progress, pointer, matrix, mode)

  const config = matrix.modes[mode]
  const artifactRoot = resolveInsideRoot(resolvedRoot, progress.artifacts?.root)
  const outputDir = progress.artifacts?.outputDir
    ? resolveInsideRoot(resolvedRoot, progress.artifacts.outputDir)
    : null
  const screenshots = listFiles(path.join(artifactRoot, 'screenshots'))
    .filter(isScreenshot)
    .map((file) => relative(resolvedRoot, file))
    .sort()
  const outputFiles = outputDir ? listFiles(outputDir) : []
  const failureScreenshots = outputFiles
    .filter(isScreenshot)
    .map((file) => relative(resolvedRoot, file))
    .sort()
  const traces = outputFiles
    .filter((file) => /(?:^|[/\\])trace\.zip$/iu.test(file))
    .map((file) => relative(resolvedRoot, file))
    .sort()
  const plannedScreenshotCount = config.screenshots === true ? progress.planned.navigations : 0
  const summaryStatus = deriveSummaryStatus(progress, {
    screenshotsRequired: config.screenshots === true,
    screenshotCount: screenshots.length,
    plannedScreenshotCount
  })
  const passedResults = progress.groupResults.filter((result) => result.status === 'passed')
  const testedRouteIds = unique(passedResults.map((result) => result.routeId).filter(Boolean))
  const testedThemes = unique(passedResults.map((result) => result.theme).filter(Boolean))
  const testedViewportIds = unique(passedResults.flatMap((result) => result.viewportIds ?? []))
  const testedMedia = unique(passedResults.flatMap((result) => result.media ?? []))
  const plannedSelection = progress.selection ?? {
    routeIds: config.routes === 'all' ? [] : config.routes,
    themes: config.themes,
    viewportIds: config.viewports,
    media: config.media
  }

  const summary = {
    status: summaryStatus,
    mode,
    runId: progress.runId,
    generatedAt: new Date().toISOString(),
    startedAt: progress.startedAt,
    updatedAt: progress.updatedAt,
    matrixVersion: matrix.version,
    routeMatrixVersion: 'route-audit-matrix-v1',
    contentCorpusVersion: corpus.version,
    planFingerprint: progress.planFingerprint,
    viewports: plannedSelection.viewportIds,
    testedViewports: testedViewportIds,
    testedViewportCount: testedViewportIds.length,
    themes: plannedSelection.themes,
    testedThemes,
    media: plannedSelection.media,
    testedMedia,
    routeCount: progress.planned.routes,
    completedRouteCount: testedRouteIds.length,
    routeSelection: plannedSelection.routeIds,
    plannedRouteThemeGroupCount: progress.planned.routeThemeGroups,
    completedRouteThemeGroupCount: progress.actual.completedRouteThemeGroups,
    failedRouteThemeGroupCount: progress.actual.failedRouteThemeGroups,
    pendingRouteThemeGroupCount: Math.max(
      0,
      progress.planned.routeThemeGroups
        - progress.actual.completedRouteThemeGroups
        - progress.actual.failedRouteThemeGroups
    ),
    plannedNavigationCount: progress.planned.navigations,
    completedNavigationCount: progress.actual.navigations,
    plannedCaseCount: progress.planned.cases,
    completedCaseCount: progress.actual.cases,
    contentBoundaryCaseCount: corpus.cases.length,
    assertions: [
      'collectViewportBoundaryReport',
      'assertStickyHeaderDoesNotCoverFocusedInput',
      'assertFocusOutlineVisible',
      'assertNoDuplicateStickyBars',
      'assertThemeReadable',
      'assertUxViewportMediaMode'
    ],
    screenshotCount: screenshots.length,
    plannedScreenshotCount,
    screenshots,
    failureScreenshotCount: failureScreenshots.length,
    failureScreenshots,
    traceCount: traces.length,
    traces,
    failures: progress.groupResults
      .filter((result) => result.status === 'failed')
      .map((result) => ({
        groupId: result.groupId,
        routeId: result.routeId,
        theme: result.theme,
        error: result.error
      })),
    skippedExtremeCases: []
  }

  const artifact = path.join(resolvedRoot, config.artifact)
  writeJson(artifact, summary)
  const releaseArtifact = writeReleaseSummary({
    root: resolvedRoot,
    matrix,
    corpus,
    mode,
    artifact,
    summary
  })
  return { artifact, releaseArtifact, summary }
}

function validateMatrix(matrix, corpus) {
  const errors = []
  const viewportNames = new Set()

  if (matrix.version !== 'fsusblog-ux-viewport-matrix-v1') {
    errors.push(`unexpected viewport matrix version: ${matrix.version}`)
  }
  for (const viewport of matrix.viewports ?? []) {
    if (!viewport.name || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)) {
      errors.push(`invalid viewport entry: ${JSON.stringify(viewport)}`)
      continue
    }
    if (viewportNames.has(viewport.name)) {
      errors.push(`duplicate viewport name: ${viewport.name}`)
    }
    viewportNames.add(viewport.name)
  }
  for (const [modeName, config] of Object.entries(matrix.modes ?? {})) {
    if (!validModes.has(modeName)) {
      errors.push(`unknown mode: ${modeName}`)
    }
    if (!config.artifact || !Array.isArray(config.themes) || !Array.isArray(config.media)) {
      errors.push(`mode ${modeName} is missing artifact/themes/media`)
    }
    for (const viewportName of config.viewports ?? []) {
      if (!viewportNames.has(viewportName)) {
        errors.push(`mode ${modeName} references unknown viewport: ${viewportName}`)
      }
    }
  }

  for (const viewportName of [
    'xs-mobile',
    'narrow-mobile',
    'mobile',
    'short-mobile',
    'mobile-landscape',
    'tablet',
    'tablet-landscape',
    'laptop-short',
    'desktop',
    'desktop-hd',
    'wide-desktop',
    'ultra-wide',
    'tall-desktop',
    'four-k'
  ]) {
    if (!viewportNames.has(viewportName)) {
      errors.push(`missing required viewport: ${viewportName}`)
    }
  }

  if (corpus.version !== 'fsusblog-ux-content-boundary-corpus-v1') {
    errors.push(`unexpected content corpus version: ${corpus.version}`)
  }
  const corpusKinds = new Set((corpus.cases ?? []).map((item) => item.kind))
  for (const kind of [
    'title',
    'inline',
    'paragraph',
    'taxonomy',
    'username',
    'comment',
    'message',
    'code',
    'katex',
    'mermaid',
    'image',
    'state'
  ]) {
    if (!corpusKinds.has(kind)) {
      errors.push(`content corpus missing kind: ${kind}`)
    }
  }
  return errors
}

function validateProgress(progress, pointer, matrix, mode) {
  if (progress.version !== 'fsusblog-ux-viewport-progress-v1') {
    throw new Error(`unexpected UX viewport progress version: ${progress.version}`)
  }
  if (
    progress.runId !== pointer.runId
    || progress.mode !== mode
    || progress.planFingerprint !== pointer.planFingerprint
  ) {
    throw new Error('current UX viewport progress does not match its run pointer')
  }
  if (progress.matrixVersion !== matrix.version) {
    throw new Error(
      `current UX viewport progress matrix mismatch: ${progress.matrixVersion} != ${matrix.version}`
    )
  }
  if (!progress.planned || !progress.actual || !Array.isArray(progress.groupResults)) {
    throw new Error('current UX viewport progress is missing result counts')
  }
}

function deriveSummaryStatus(progress, screenshotEvidence) {
  const isComplete = progress.status === 'passed'
    && progress.actual.failedRouteThemeGroups === 0
    && progress.actual.completedRouteThemeGroups === progress.planned.routeThemeGroups
    && progress.actual.navigations === progress.planned.navigations
    && progress.actual.cases === progress.planned.cases
    && (!screenshotEvidence.screenshotsRequired || screenshotEvidence.screenshotCount === screenshotEvidence.plannedScreenshotCount)
  if (isComplete) {
    return 'ok'
  }
  if (progress.status === 'failed' || progress.actual.failedRouteThemeGroups > 0) {
    return 'failed'
  }
  return 'incomplete'
}

function writeReleaseSummary({ root, matrix, corpus, mode, artifact, summary }) {
  const artifacts = Object.fromEntries(
    Object.keys(matrix.modes).map((modeName) => [
      modeName,
      modeName === mode ? relative(root, artifact) : null
    ])
  )
  const releaseSummary = {
    status: summary.status,
    runId: summary.runId,
    generatedAt: new Date().toISOString(),
    latestMode: mode,
    matrixVersion: matrix.version,
    routeMatrixVersion: 'route-audit-matrix-v1',
    contentCorpusVersion: corpus.version,
    planFingerprint: summary.planFingerprint,
    testedThemes: summary.testedThemes,
    testedViewportCount: summary.testedViewportCount,
    plannedCaseCount: summary.plannedCaseCount,
    completedCaseCount: summary.completedCaseCount,
    plannedNavigationCount: summary.plannedNavigationCount,
    completedNavigationCount: summary.completedNavigationCount,
    completedRouteThemeGroupCount: summary.completedRouteThemeGroupCount,
    failedRouteThemeGroupCount: summary.failedRouteThemeGroupCount,
    contentBoundaryCaseCount: summary.contentBoundaryCaseCount,
    screenshots: summary.screenshots,
    failureScreenshots: summary.failureScreenshots,
    traces: summary.traces,
    failures: summary.failures,
    skippedExtremeCases: summary.skippedExtremeCases,
    artifacts
  }
  const outFile = path.join(root, '.tmp/release-evidence/ux-viewport-summary.json')
  writeJson(outFile, releaseSummary)
  return outFile
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? listFiles(file) : [file]
  })
}

function resolveInsideRoot(root, relativeFile) {
  if (!relativeFile || path.isAbsolute(relativeFile)) {
    throw new Error(`invalid current UX viewport artifact path: ${String(relativeFile)}`)
  }
  const resolved = path.resolve(root, relativeFile)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`current UX viewport artifact path escapes root: ${relativeFile}`)
  }
  return resolved
}

function relative(root, file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function unique(values) {
  return [...new Set(values)]
}

function isScreenshot(file) {
  return /\.(?:png|jpe?g)$/iu.test(file)
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const requestedMode = validModes.has(process.argv[2]) ? process.argv[2] : 'smoke'
  try {
    const result = await writeUxViewportSummary({ mode: requestedMode })
    console.log(
      `[ux-viewport-summary] status=${result.summary.status} mode=${requestedMode} `
      + `artifact=${relative(defaultRoot, result.artifact)} `
      + `release=${relative(defaultRoot, result.releaseArtifact)}`
    )
    if (result.summary.status !== 'ok') {
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`[ux-viewport-summary] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
