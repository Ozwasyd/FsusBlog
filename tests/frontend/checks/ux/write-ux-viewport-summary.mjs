#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const validModes = new Set(['smoke', 'visual', 'boundaries'])

export async function writeUxViewportSummary({ root = defaultRoot, mode = 'smoke', runId } = {}) {
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

  const requestedRunId = runId ? requireSafeRunId(runId) : null
  const pointerFile = path.join(resolvedRoot, '.tmp/ux', `current-${mode}-run.json`)
  const pointer = requestedRunId
    ? null
    : readJson(pointerFile)
  if (pointer && (pointer.mode !== mode || !pointer.progressFile || !pointer.planFingerprint)) {
    throw new Error(`invalid current UX viewport run pointer: ${relative(resolvedRoot, pointerFile)}`)
  }

  const progressFile = requestedRunId
    ? path.join(resolvedRoot, '.tmp/ux/runs', requestedRunId, mode, 'progress.json')
    : resolveInsideRoot(resolvedRoot, pointer.progressFile)
  const progress = readJson(progressFile)
  validateProgress(progress, pointer ?? {
    runId: requestedRunId,
    mode,
    planFingerprint: progress.planFingerprint
  }, matrix, mode)

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
  // Screenshots are captured for route-theme navigations only; safe-area cases are assertion-only.
  const plannedScreenshotCount = config.screenshots === true
    ? (progress.planned.navigations - (progress.planned.safeAreaGroups ?? 0))
    : 0
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
    media: config.media,
    safeAreaCaseIds: [],
    safeAreaBrowsers: [],
    safeAreaSurfaceIds: [],
    safeAreaProfileIds: []
  }
  const safeAreaResults = progress.groupResults.filter((result) => result.kind === 'safe-area')
  const passedSafeArea = safeAreaResults.filter((result) => result.status === 'passed')
  const sourceBinding = resolveSourceBinding(resolvedRoot)
  const safeAreaGateErrors = validateSafeAreaEvidence({
    mode,
    matrix,
    plannedSelection,
    safeAreaResults,
    progress
  })

  const summary = {
    status: safeAreaGateErrors.length > 0 ? 'failed' : summaryStatus,
    evidenceClass: 'diagnostic',
    affectsCorrectness: false,
    executionBoundary: 'real-browser-ux-viewport',
    mode,
    runId: progress.runId,
    generatedAt: new Date().toISOString(),
    startedAt: progress.startedAt,
    updatedAt: progress.updatedAt,
    matrixVersion: matrix.version,
    safeAreaVersion: matrix.safeArea?.version ?? progress.safeAreaVersion ?? null,
    routeMatrixVersion: 'route-audit-matrix-v1',
    contentCorpusVersion: corpus.version,
    planFingerprint: progress.planFingerprint,
    sourceBinding,
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
    plannedSafeAreaGroupCount: progress.planned.safeAreaGroups ?? 0,
    completedSafeAreaGroupCount: progress.actual.completedSafeAreaGroups
      ?? passedSafeArea.length,
    failedSafeAreaGroupCount: progress.actual.failedSafeAreaGroups
      ?? safeAreaResults.filter((result) => result.status === 'failed').length,
    plannedNavigationCount: progress.planned.navigations,
    completedNavigationCount: progress.actual.navigations,
    plannedCaseCount: progress.planned.cases,
    completedCaseCount: progress.actual.cases,
    plannedSafeAreaCaseCount: progress.planned.safeAreaCases
      ?? (plannedSelection.safeAreaCaseIds?.length ?? 0),
    completedSafeAreaCaseCount: progress.actual.safeAreaCases ?? passedSafeArea.length,
    safeAreaCaseIds: plannedSelection.safeAreaCaseIds ?? [],
    safeAreaBrowsers: plannedSelection.safeAreaBrowsers ?? [],
    safeAreaSurfaces: plannedSelection.safeAreaSurfaceIds ?? [],
    safeAreaProfiles: plannedSelection.safeAreaProfileIds ?? [],
    safeAreaResults: safeAreaResults.map((result) => ({
      groupId: result.groupId,
      surfaceId: result.surfaceId,
      profileId: result.profileId,
      browser: result.browser,
      routeId: result.routeId,
      theme: result.theme,
      status: result.status,
      error: result.error ?? null
    })),
    safeAreaGateErrors,
    contentBoundaryCaseCount: corpus.cases.length,
    assertions: [
      'collectViewportBoundaryReport',
      'assertStickyHeaderDoesNotCoverFocusedInput',
      'assertFocusOutlineVisible',
      'assertNoDuplicateStickyBars',
      'assertThemeReadable',
      'assertUxViewportMediaMode',
      'assertDocumentViewportMetaContract',
      'assertScrimCoversViewport',
      'assertControlsInsideSafeRect',
      'assertOverlayActionsReachable',
      'assertNoBodyOverflowLeak',
      'assertOverlayCloseRestoresFocusAndScroll'
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
        browser: result.browser ?? null,
        surfaceId: result.surfaceId ?? null,
        profileId: result.profileId ?? null,
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

function requireSafeRunId(runId) {
  const value = String(runId ?? '')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)) {
    throw new Error(`invalid UX viewport run id: ${value}`)
  }
  return value
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

  if (!matrix.safeArea || matrix.safeArea.version !== 'fsusblog-ux-safe-area-v1') {
    errors.push('matrix.safeArea.version must be fsusblog-ux-safe-area-v1')
  } else {
    for (const profileId of ['zero-inset', 'portrait-notch', 'landscape-notch', 'short-visual']) {
      if (!matrix.safeArea.profiles?.[profileId]) {
        errors.push(`safe-area profile missing: ${profileId}`)
      }
    }
    const surfaces = matrix.safeArea.overlayRiskSurfaces ?? []
    if (surfaces.length === 0) {
      errors.push('safe-area overlayRiskSurfaces must not be empty')
    }
    for (const surface of surfaces) {
      if (surface.overlayRisk !== true) {
        errors.push(`surface ${surface.id} must mark overlayRisk=true`)
      }
    }
    for (const assertion of [
      'assertScrimCoversViewport',
      'assertControlsInsideSafeRect',
      'assertOverlayActionsReachable',
      'assertNoBodyOverflowLeak',
      'assertOverlayCloseRestoresFocusAndScroll'
    ]) {
      if (!(matrix.safeArea.assertions ?? []).includes(assertion)) {
        errors.push(`safe-area assertions missing ${assertion}`)
      }
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

function validateSafeAreaEvidence({ mode, matrix, plannedSelection, safeAreaResults, progress }) {
  const errors = []
  const plannedIds = plannedSelection.safeAreaCaseIds ?? []
  const plannedBrowsers = new Set(plannedSelection.safeAreaBrowsers ?? [])
  if (!matrix.safeArea) {
    errors.push('matrix is missing safeArea integration section')
    return errors
  }

  if ((progress.planned.safeAreaGroups ?? plannedIds.length) > 0) {
    const passed = safeAreaResults.filter((result) => result.status === 'passed')
    const failed = safeAreaResults.filter((result) => result.status === 'failed')
    if (failed.length > 0) {
      errors.push(`safe-area groups failed: ${failed.map((item) => item.groupId).join(', ')}`)
    }
    if (passed.length < (progress.planned.safeAreaGroups ?? plannedIds.length)) {
      errors.push(
        `safe-area evidence incomplete: passed=${passed.length} planned=${progress.planned.safeAreaGroups ?? plannedIds.length}`
      )
    }
    if (plannedBrowsers.has('webkit')) {
      const webkitPassed = passed.filter((result) => result.browser === 'webkit')
      if (webkitPassed.length === 0) {
        errors.push(
          `safe-area release gate requires WebKit results for mode=${mode}; screenshot-only or chromium-only evidence is rejected`
        )
      }
    }
  }

  // Forbid silent conversion of safe-area matrix into screenshot-only reports.
  if ((progress.planned.safeAreaCases ?? 0) > 0 && safeAreaResults.length === 0) {
    errors.push('safe-area cases were planned but no safe-area group results were recorded')
  }

  return errors
}

function resolveSourceBinding(root) {
  const fsusblogSha = readGitHead(root)
  const packageJsonPath = path.join(root, 'src/frontend/package.json')
  let fsusuiVersion = null
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    fsusuiVersion = pkg.dependencies?.['@ozwasyd/element-plus']
      ?? pkg.devDependencies?.['@ozwasyd/element-plus']
      ?? null
  } catch {
    fsusuiVersion = null
  }

  let fsusuiResolvedSha = null
  const localFsusUi = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT
  if (localFsusUi && fs.existsSync(localFsusUi)) {
    fsusuiResolvedSha = readGitHead(localFsusUi)
  }

  return {
    fsusblogSha,
    fsusuiVersion,
    fsusuiResolvedSha,
    matrixPath: 'tests/frontend/fixtures/ux-viewport-matrix.json'
  }
}

function readGitHead(repositoryRoot) {
  try {
    const headPath = path.join(repositoryRoot, '.git/HEAD')
    if (!fs.existsSync(headPath)) {
      // worktree: .git may be a file pointing at the real git dir
      const gitFile = path.join(repositoryRoot, '.git')
      if (fs.existsSync(gitFile) && fs.statSync(gitFile).isFile()) {
        const content = fs.readFileSync(gitFile, 'utf8').trim()
        const match = content.match(/^gitdir:\s*(.+)$/u)
        if (match) {
          const gitDir = path.resolve(repositoryRoot, match[1])
          return readGitHeadFromGitDir(gitDir)
        }
      }
      return null
    }
    return readGitHeadFromGitDir(path.join(repositoryRoot, '.git'))
  } catch {
    return null
  }
}

function readGitHeadFromGitDir(gitDir) {
  const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
  if (head.startsWith('ref:')) {
    const ref = head.slice(4).trim()
    const refPath = path.join(gitDir, ref)
    if (fs.existsSync(refPath)) {
      return fs.readFileSync(refPath, 'utf8').trim()
    }
    // packed-refs fallback omitted; binding stays null rather than invent a SHA
    return null
  }
  return head
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
  const plannedSafeArea = progress.planned.safeAreaGroups ?? 0
  const completedSafeArea = progress.actual.completedSafeAreaGroups ?? 0
  const failedSafeArea = progress.actual.failedSafeAreaGroups ?? 0
  const isComplete = progress.status === 'passed'
    && progress.actual.failedRouteThemeGroups === 0
    && failedSafeArea === 0
    && progress.actual.completedRouteThemeGroups === progress.planned.routeThemeGroups
    && completedSafeArea === plannedSafeArea
    && progress.actual.navigations === progress.planned.navigations
    && progress.actual.cases === progress.planned.cases
    && (!screenshotEvidence.screenshotsRequired || screenshotEvidence.screenshotCount === screenshotEvidence.plannedScreenshotCount)
  if (isComplete) {
    return 'ok'
  }
  if (
    progress.status === 'failed'
    || progress.actual.failedRouteThemeGroups > 0
    || failedSafeArea > 0
  ) {
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
    evidenceClass: summary.evidenceClass,
    affectsCorrectness: summary.affectsCorrectness,
    executionBoundary: summary.executionBoundary,
    runId: summary.runId,
    generatedAt: new Date().toISOString(),
    latestMode: mode,
    matrixVersion: matrix.version,
    safeAreaVersion: summary.safeAreaVersion,
    routeMatrixVersion: 'route-audit-matrix-v1',
    contentCorpusVersion: corpus.version,
    planFingerprint: summary.planFingerprint,
    sourceBinding: summary.sourceBinding,
    testedThemes: summary.testedThemes,
    testedViewportCount: summary.testedViewportCount,
    plannedCaseCount: summary.plannedCaseCount,
    completedCaseCount: summary.completedCaseCount,
    plannedSafeAreaCaseCount: summary.plannedSafeAreaCaseCount,
    completedSafeAreaCaseCount: summary.completedSafeAreaCaseCount,
    safeAreaCaseIds: summary.safeAreaCaseIds,
    safeAreaBrowsers: summary.safeAreaBrowsers,
    safeAreaSurfaces: summary.safeAreaSurfaces,
    safeAreaProfiles: summary.safeAreaProfiles,
    safeAreaResults: summary.safeAreaResults,
    safeAreaGateErrors: summary.safeAreaGateErrors,
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
  const outFile = path.join(
    process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? path.join(root, '.tmp/release-evidence'),
    'ux-viewport-summary.json')
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
    if (result.summary.status !== 'ok' || (result.summary.safeAreaGateErrors?.length ?? 0) > 0) {
      for (const message of result.summary.safeAreaGateErrors ?? []) {
        console.error(`[ux-viewport-summary] ${message}`)
      }
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`[ux-viewport-summary] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
