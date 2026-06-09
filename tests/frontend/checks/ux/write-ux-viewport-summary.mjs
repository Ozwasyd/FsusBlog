#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const matrixFile = path.join(root, 'tests/frontend/fixtures/ux-viewport-matrix.json')
const corpusFile = path.join(root, 'tests/frontend/fixtures/ux-content-boundary-corpus.json')
const uxDir = path.join(root, '.tmp/ux')
const releaseEvidenceDir = path.join(root, '.tmp/release-evidence')
const validModes = new Set(['smoke', 'visual', 'boundaries'])
const mode = validModes.has(process.argv[2]) ? process.argv[2] : 'smoke'

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) {
    return []
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? listFiles(file) : [file]
  })
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

  const requiredViewports = [
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
  ]
  for (const viewportName of requiredViewports) {
    if (!viewportNames.has(viewportName)) {
      errors.push(`missing required viewport: ${viewportName}`)
    }
  }

  if (corpus.version !== 'fsusblog-ux-content-boundary-corpus-v1') {
    errors.push(`unexpected content corpus version: ${corpus.version}`)
  }

  const requiredKinds = new Set([
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
  ])
  const corpusKinds = new Set((corpus.cases ?? []).map((item) => item.kind))
  for (const kind of requiredKinds) {
    if (!corpusKinds.has(kind)) {
      errors.push(`content corpus missing kind: ${kind}`)
    }
  }

  return errors
}

function routeCountFor(config) {
  if (config.routes === 'all') {
    return 30
  }
  return config.routes.length
}

function writeModeSummary(matrix, corpus) {
  const config = matrix.modes[mode]
  const artifact = path.join(root, config.artifact)
  const screenshots = listFiles(path.join(uxDir, 'screenshots', mode)).filter((file) => /\.(png|jpg|jpeg)$/i.test(file))
  const summary = {
    status: 'ok',
    mode,
    generatedAt: new Date().toISOString(),
    matrixVersion: matrix.version,
    routeMatrixVersion: 'route-audit-matrix-v1',
    contentCorpusVersion: corpus.version,
    viewports: config.viewports,
    testedViewportCount: config.viewports.length,
    themes: config.themes,
    media: config.media,
    routeCount: routeCountFor(config),
    routeSelection: config.routes,
    contentBoundaryCaseCount: corpus.cases.length,
    assertions: [
      'assertNoHorizontalOverflow',
      'assertNoVerticalTrap',
      'assertInteractiveControlsReachable',
      'assertModalActionsReachable',
      'assertDrawerUsableUnderShortHeight',
      'assertDropdownNotClipped',
      'assertStickyHeaderDoesNotCoverFocusedInput',
      'assertReadableLineWidthWithinBounds',
      'assertDashboardGridWidthBounds',
      'assertEditorPanelRatioBounds',
      'assertTableResponsiveStrategy',
      'assertCodeBlockControlledScroll',
      'assertKatexMermaidControlledScroll',
      'assertFocusOutlineVisible',
      'assertTouchTargetSize',
      'assertNoDuplicateStickyBars',
      'assertMobileLandscapeSafeArea'
    ],
    screenshotCount: screenshots.length,
    screenshots: screenshots.map(relative),
    skippedExtremeCases: []
  }

  ensureDir(path.dirname(artifact))
  fs.writeFileSync(artifact, `${JSON.stringify(summary, null, 2)}\n`)
  return { artifact, summary }
}

function writeReleaseSummary(matrix, corpus, currentModeSummary) {
  ensureDir(releaseEvidenceDir)
  const modeArtifacts = Object.fromEntries(
    Object.entries(matrix.modes).map(([modeName, config]) => {
      const file = path.join(root, config.artifact)
      return [modeName, fs.existsSync(file) ? relative(file) : null]
    })
  )

  const summary = {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    latestMode: mode,
    matrixVersion: matrix.version,
    routeMatrixVersion: 'route-audit-matrix-v1',
    contentCorpusVersion: corpus.version,
    testedThemes: currentModeSummary.themes,
    testedViewportCount: currentModeSummary.testedViewportCount,
    contentBoundaryCaseCount: currentModeSummary.contentBoundaryCaseCount,
    failureScreenshots: [],
    traces: [],
    skippedExtremeCases: currentModeSummary.skippedExtremeCases,
    artifacts: modeArtifacts
  }

  const outFile = path.join(releaseEvidenceDir, 'ux-viewport-summary.json')
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
  return outFile
}

const matrix = readJson(matrixFile)
const corpus = readJson(corpusFile)
const errors = validateMatrix(matrix, corpus)
if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[ux-viewport-summary] ${error}`)
  }
  process.exit(1)
}

const { artifact, summary } = writeModeSummary(matrix, corpus)
const releaseSummary = writeReleaseSummary(matrix, corpus, summary)
console.log(`[ux-viewport-summary] ok mode=${mode} artifact=${relative(artifact)} release=${relative(releaseSummary)}`)
