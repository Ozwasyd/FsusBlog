#!/usr/bin/env node

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const REGISTRY_SCHEMA = 'fsusblog.public-hydration-matrix-registry.v1'
const SUMMARY_SCHEMA = 'fsusblog.public-hydration-matrix-summary.v1'
const registryFile = join(repoRoot, 'tests/frontend/checks/public/public-hydration-matrix.registry.json')
const manifestFile = join(repoRoot, 'src/frontend/src/public-renderers/generated/publicPageManifest.ts')
const rendererCoreFile = join(repoRoot, 'src/frontend/src/public-renderers/publicEntryCore.ts')
const summaryFile = process.env.FSUSBLOG_PUBLIC_HYDRATION_MATRIX_SUMMARY_FILE
  || join(repoRoot, '.tmp/release-evidence/public-hydration-matrix-summary.json')
const requireArtifacts = process.env.FSUSBLOG_REQUIRE_PUBLIC_HYDRATION_ARTIFACTS === '1'
  || process.argv.includes('--require-artifacts')

const artifactSpecs = {
  detector: {
    file: '.tmp/release-evidence/public-hydration-detector-summary.json',
    schema: 'fsusblog.public-hydration-detector.v1',
    gate: 'publicHydrationDetector',
  },
  clock: {
    file: '.tmp/release-evidence/public-hydration-clock-matrix-summary.json',
    schema: 'fsusblog.public-hydration-clock-matrix.v1',
    gate: 'publicHydrationClockMatrix',
  },
  browserEnv: {
    file: '.tmp/release-evidence/public-hydration-browser-env-summary.json',
    schema: 'fsusblog.public-hydration-browser-env-matrix.v1',
    gate: 'publicHydrationBrowserEnv',
  },
  payloadFixture: {
    file: '.tmp/release-evidence/public-hydration-payload-fixture-summary.json',
    schema: 'fsusblog.public-hydration-payload-fixture-matrix.v1',
    gate: 'publicHydrationPayloadFixture',
  },
  domDiff: {
    file: '.tmp/release-evidence/public-hydration-dom-diff-summary.json',
    schema: 'fsusblog.public-hydration-dom-diff.v1',
    gate: 'publicHydrationDomDiff',
  },
}

function parseArgs() {
  const laneIndex = process.argv.indexOf('--lane')
  const rawLane = laneIndex >= 0 ? process.argv[laneIndex + 1] : process.env.FSUSBLOG_PUBLIC_HYDRATION_MATRIX_LANE
  if (rawLane === 'nightly') return 'nightly-full'
  return rawLane || 'fast'
}

function readText(relativePath) {
  const absolute = join(repoRoot, relativePath)
  if (!existsSync(absolute)) {
    throw new Error(`missing source file: ${relativePath}`)
  }
  return readFileSync(absolute, 'utf8')
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeSummary(summary) {
  mkdirSync(dirname(summaryFile), { recursive: true })
  writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`)
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))]
}

function sorted(values) {
  return unique(values).sort((left, right) => String(left).localeCompare(String(right)))
}

function getGitSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}

function getRendererVersion() {
  const text = readFileSync(rendererCoreFile, 'utf8')
  return text.match(/PUBLIC_RENDERER_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? 'unknown'
}

function parsePublicPageManifest() {
  const text = readFileSync(manifestFile, 'utf8')
  const entries = []
  const entryRegex = /^\s{2}([A-Za-z][A-Za-z0-9]*):\s*\{([\s\S]*?)^\s{2}\},?/gm
  let match
  while ((match = entryRegex.exec(text)) !== null) {
    const [, kind, body] = match
    entries.push({
      kind,
      aotShellReady: /aotShellReady:\s*true/.test(body),
      seoEligible: /seoEligible:\s*true/.test(body),
      requiresUserState: /requiresUserState:\s*true/.test(body),
      canonicalSlug: body.match(/canonicalSlug:\s*'([^']+)'/)?.[1] ?? null,
      fallbackBehavior: body.match(/fallbackBehavior:\s*'([^']+)'/)?.[1] ?? null,
    })
  }
  if (entries.length === 0) {
    throw new Error('could not parse PUBLIC_PAGE_MANIFEST entries')
  }
  return entries
}

function parseRouteIdentityTokens() {
  const text = readFileSync(manifestFile, 'utf8')
  const match = text.match(/PUBLIC_ROUTE_IDENTITY_TOKENS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\s+as const\)/)
  if (!match) {
    throw new Error('could not parse PUBLIC_ROUTE_IDENTITY_TOKENS')
  }

  const tokens = {}
  for (const token of match[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):\s*'([^']*)',?$/gm)) {
    tokens[token[1]] = token[2]
  }

  for (const required of ['searchPath', 'accountPath']) {
    if (!tokens[required]) {
      throw new Error(`missing generated route identity token ${required}`)
    }
  }

  return tokens
}

function validateRouteEligibilityPolicies(registry, manifestEntries, errors) {
  const routePolicies = assertArray(errors, registry, 'routePolicies')
  const tokens = parseRouteIdentityTokens()
  const accountManifest = manifestEntries.find((entry) => entry.kind === 'Account')
  if (!accountManifest) {
    errors.push('generated manifest missing Account page kind')
    return
  }

  const requiredPolicies = {
    Search: {
      kind: 'Search',
      route: tokens.searchPath,
      seoEligible: false,
      aotShellReady: false,
      requiresUserState: false,
      expectedFallbackBehavior: 'spa-public-search-fallback',
    },
    Account: {
      kind: 'Account',
      pageId: 'Account',
      route: tokens.accountPath,
      seoEligible: accountManifest.seoEligible,
      aotShellReady: accountManifest.aotShellReady,
      requiresUserState: accountManifest.requiresUserState,
      expectedFallbackBehavior: accountManifest.fallbackBehavior,
    },
  }

  for (const [routeName, expected] of Object.entries(requiredPolicies)) {
    const policy = routePolicies.find((entry) => entry.routeName === routeName)
    if (!policy) {
      errors.push(`routePolicies missing ${routeName}`)
      continue
    }

    if (policy.kind !== expected.kind) {
      errors.push(`routePolicies.${routeName}.kind mismatch: ${policy.kind ?? '<missing>'}`)
    }
    if (expected.pageId && policy.pageId !== expected.pageId) {
      errors.push(`routePolicies.${routeName}.pageId mismatch: ${policy.pageId ?? '<missing>'}`)
    }
    if (!Array.isArray(policy.routes) || !policy.routes.includes(expected.route)) {
      errors.push(`routePolicies.${routeName}.routes must include ${expected.route}`)
    }
    for (const field of ['seoEligible', 'aotShellReady', 'requiresUserState']) {
      if (policy[field] !== expected[field]) {
        errors.push(`routePolicies.${routeName}.${field} mismatch: expected ${expected[field]}, got ${policy[field]}`)
      }
    }
    if (policy.expectedFallbackBehavior !== expected.expectedFallbackBehavior) {
      errors.push(`routePolicies.${routeName}.expectedFallbackBehavior mismatch: expected ${expected.expectedFallbackBehavior}, got ${policy.expectedFallbackBehavior ?? '<missing>'}`)
    }
    if (policy.aotShellReady === false && policy.cachePolicy !== 'must-not-write-public-aot-cache') {
      errors.push(`routePolicies.${routeName}.cachePolicy must block public AOT cache writes`)
    }
  }
}

function assertArray(errors, owner, field) {
  if (!Array.isArray(owner[field])) {
    errors.push(`registry ${field} must be an array`)
    return []
  }
  return owner[field]
}

function validateRegistry(registry, lane, errors) {
  if (registry.schema !== REGISTRY_SCHEMA) {
    errors.push(`registry schema must be ${REGISTRY_SCHEMA}`)
  }

  const manifestEntries = parsePublicPageManifest()
  const manifestAotKinds = sorted(manifestEntries.filter((entry) => entry.aotShellReady).map((entry) => entry.kind))
  const manifestNonAotKinds = sorted(manifestEntries.filter((entry) => !entry.aotShellReady).map((entry) => entry.kind))
  const registryKinds = sorted(assertArray(errors, registry, 'pageKinds').map((entry) => entry.kind))
  const excludedKinds = sorted(assertArray(errors, registry, 'excludedPageKinds').map((entry) => entry.kind))

  if (manifestAotKinds.join('|') !== registryKinds.join('|')) {
    errors.push(`AOT public page kind coverage drift: manifest=${manifestAotKinds.join(',')} registry=${registryKinds.join(',')}`)
  }
  for (const kind of manifestNonAotKinds) {
    const exclusion = registry.excludedPageKinds?.find((entry) => entry.kind === kind)
    if (!exclusion?.reason) {
      errors.push(`non-AOT public page kind ${kind} must have an exclusion reason`)
    }
  }
  for (const kind of excludedKinds) {
    if (!manifestNonAotKinds.includes(kind)) {
      errors.push(`excluded page kind ${kind} is not a non-AOT manifest kind`)
    }
  }
  validateRouteEligibilityPolicies(registry, manifestEntries, errors)

  const lanes = assertArray(errors, registry, 'lanes')
  const laneIds = sorted(lanes.map((entry) => entry.id))
  for (const required of ['fast', 'release', 'nightly-full']) {
    if (!laneIds.includes(required)) {
      errors.push(`registry missing hydration lane ${required}`)
    }
  }
  const selectedLane = lanes.find((entry) => entry.id === lane)
  if (!selectedLane) {
    errors.push(`unknown hydration matrix lane: ${lane}`)
  }
  for (const laneEntry of lanes) {
    for (const field of ['costClass', 'ciTier', 'command', 'routeSet', 'phases', 'browsers', 'viewports', 'states', 'fixtures', 'requiredArtifacts', 'shardStrategyRefs', 'enforcement']) {
      if (laneEntry[field] === undefined) {
        errors.push(`lane ${laneEntry.id ?? '<missing>'} missing ${field}`)
      }
    }
    if (Array.isArray(laneEntry.routeSet)) {
      for (const kind of laneEntry.routeSet) {
        if (!registryKinds.includes(kind)) {
          errors.push(`lane ${laneEntry.id} references unknown public AOT kind ${kind}`)
        }
      }
    }
  }

  const dimensions = assertArray(errors, registry, 'dimensions')
  for (const dimension of dimensions) {
    for (const field of ['id', 'owner', 'risk', 'lanes', 'source']) {
      if (!dimension[field]) {
        errors.push(`dimension ${dimension.id ?? '<missing>'} missing ${field}`)
      }
    }
    if (Array.isArray(dimension.lanes)) {
      for (const dimensionLane of dimension.lanes) {
        if (!laneIds.includes(dimensionLane)) {
          errors.push(`dimension ${dimension.id} references unknown lane ${dimensionLane}`)
        }
      }
    }
  }

  const shardStrategies = assertArray(errors, registry, 'shardStrategies')
  const shardStrategyIds = sorted(shardStrategies.map((entry) => entry.id))
  for (const strategy of shardStrategies) {
    for (const field of ['id', 'dimensions', 'defaultShards', 'lane', 'owner', 'strategy']) {
      if (!strategy[field]) {
        errors.push(`shard strategy ${strategy.id ?? '<missing>'} missing ${field}`)
      }
    }
    if (!laneIds.includes(strategy.lane)) {
      errors.push(`shard strategy ${strategy.id} references unknown lane ${strategy.lane}`)
    }
  }
  for (const laneEntry of lanes) {
    for (const strategyRef of laneEntry.shardStrategyRefs ?? []) {
      if (!shardStrategyIds.includes(strategyRef)) {
        errors.push(`lane ${laneEntry.id} references unknown shard strategy ${strategyRef}`)
      }
    }
  }

  return {
    selectedLane,
    manifestAotKinds,
    manifestNonAotKinds,
    pageKinds: registry.pageKinds ?? [],
    dimensions,
    shardStrategies,
    lanes,
  }
}

function validateRepoWiring(errors) {
  const matrix = readText('tests/matrix.yml')
  const releaseLane = readText('tools/test/legacy-test.sh')
  const fastLane = readText('tools/test/lanes/public-hydration-fast.sh')
  const nightlyLane = readText('tools/test/lanes/public-hydration-nightly.sh')
  const workflow = readText('.github/workflows/quality-gate.yml')
  const collector = readText('tools/operations/collect-release-evidence.sh')
  const fixture = readText('tools/operations/test-release-evidence-fixture.sh')
  const docs = readText('docs/testing.md')

  for (const token of [
    'id: public-hydration-fast',
    'id: public-hydration-nightly',
    'public-hydration-matrix-fast-summary.json',
    'public-hydration-matrix-nightly-full-summary.json',
    'public-hydration-matrix-summary.json',
    'public-hydration-matrix',
  ]) {
    if (!matrix.includes(token)) {
      errors.push(`tests/matrix.yml missing ${token}`)
    }
  }
  for (const token of ['FSUSBLOG_REQUIRE_PUBLIC_HYDRATION_ARTIFACTS=1', 'check-public-hydration-matrix-governance.mjs --lane release']) {
    if (!releaseLane.includes(token)) {
      errors.push(`release lane missing ${token}`)
    }
  }
  if (!fastLane.includes('public-hydration-matrix-fast-summary.json')) {
    errors.push('fast hydration lane must own its lane-specific summary')
  }
  if (!nightlyLane.includes('public-hydration-matrix-nightly-full-summary.json')) {
    errors.push('nightly hydration lane must own its lane-specific summary')
  }
  for (const token of [
    './tools/test.sh public-hydration-fast --no-deps',
    '.tmp/release-evidence/public-hydration-matrix-fast-summary.json',
    '.tmp/release-evidence/public-hydration-matrix-summary.json',
  ]) {
    if (!workflow.includes(token)) {
      errors.push(`quality gate workflow missing ${token}`)
    }
  }
  for (const token of [
    'PUBLIC_HYDRATION_MATRIX_SUMMARY',
    'PUBLIC_HYDRATION_MATRIX_STATUS_VALUE',
    'publicHydrationMatrixSummary',
    'publicHydrationMatrix',
  ]) {
    if (!collector.includes(token)) {
      errors.push(`release evidence collector missing ${token}`)
    }
  }
  for (const token of [
    'fsusblog.public-hydration-matrix-summary.v1',
    'publicHydrationMatrixSummary',
    'publicHydrationMatrix',
  ]) {
    if (!fixture.includes(token)) {
      errors.push(`release evidence fixture missing ${token}`)
    }
  }
  for (const token of ['public-hydration-fast', 'public-hydration-nightly', 'public-hydration-matrix.registry.json']) {
    if (!docs.includes(token)) {
      errors.push(`docs/testing.md missing ${token}`)
    }
  }
}

function loadArtifact(id, errors, requireForLane) {
  const spec = artifactSpecs[id]
  const absolute = join(repoRoot, spec.file)
  if (!existsSync(absolute)) {
    if (requireForLane) {
      errors.push(`required hydration artifact missing: ${spec.file}`)
    }
    return { id, status: 'missing', file: spec.file, gate: spec.gate, data: null }
  }

  try {
    const data = readJsonFile(absolute)
    const status = data.status ?? 'missing'
    if (data.schema !== spec.schema) {
      errors.push(`${spec.file} schema must be ${spec.schema}`)
    }
    if (requireForLane && status !== 'success') {
      errors.push(`${spec.file} status must be success, got ${status}`)
    }
    validateArtifactSemantics(id, data, errors, spec.file, requireForLane)
    return { id, status, file: spec.file, gate: spec.gate, data }
  } catch (error) {
    errors.push(`failed to parse ${spec.file}: ${error instanceof Error ? error.message : String(error)}`)
    return { id, status: 'invalid', file: spec.file, gate: spec.gate, data: null }
  }
}

function validateArtifactSemantics(id, data, errors, file, requireForLane) {
  if (!requireForLane) {
    return
  }

  if (id === 'detector') {
    if (Number(data.fatalHydrationIssueCount ?? 0) !== 0) {
      errors.push(`${file} has fatalHydrationIssueCount=${data.fatalHydrationIssueCount}`)
    }
    if ((data.warnings?.length ?? 0) > 0 || (data.errors?.length ?? 0) > 0) {
      errors.push(`${file} contains hydration warnings/errors; release must not downgrade them`)
    }
    if (data.canary && data.canary.status !== 'success') {
      errors.push(`${file} detector canary did not pass`)
    }
  }

  if (id === 'payloadFixture' && (data.coverage?.missingDimensions?.length ?? 0) > 0) {
    errors.push(`${file} missing payload fixture dimensions: ${data.coverage.missingDimensions.join(',')}`)
  }

  if (id === 'domDiff') {
    const missingKinds = data.coverage?.missingPageKinds ?? []
    if (missingKinds.length > 0) {
      errors.push(`${file} missing DOM diff page kinds: ${missingKinds.join(',')}`)
    }
    const failedCases = (data.cases ?? []).filter((item) => item.status && item.status !== 'success')
    if (failedCases.length > 0) {
      errors.push(`${file} has failed DOM diff case(s): ${failedCases.map((item) => item.routeKey ?? item.pageKind).join(',')}`)
    }
    const diffCases = (data.cases ?? []).filter((item) => Number(item.diffCount ?? 0) > 0)
    if (diffCases.length > 0) {
      errors.push(`${file} has DOM diff(s): ${diffCases.map((item) => item.routeKey ?? item.pageKind).join(',')}`)
    }
  }
}

function issueRowsForStage(data, stage) {
  return [
    ...(Array.isArray(data?.warnings) ? data.warnings : []),
    ...(Array.isArray(data?.errors) ? data.errors : []),
  ].filter((issue) => !stage || String(issue.stage ?? '').includes(stage))
}

function buildCells(artifacts) {
  const cells = []
  const detector = artifacts.find((artifact) => artifact.id === 'detector')?.data
  for (const phase of detector?.phaseResults ?? []) {
    cells.push({
      source: 'detector',
      route: phase.route,
      pageKind: phase.expectedKind,
      phase: phase.phase,
      browser: phase.browser ?? 'chromium',
      viewport: phase.viewport ?? null,
      state: { session: 'anonymous' },
      clock: null,
      fixtureId: null,
      result: phase.status,
      fatalHydrationIssueCount: issueRowsForStage(detector, phase.stage).length,
      warnings: issueRowsForStage(detector, phase.stage).filter((item) => item.type === 'warning'),
      errors: issueRowsForStage(detector, phase.stage).filter((item) => item.type === 'error'),
      durationMs: phase.durationMs ?? null,
    })
  }
  for (const route of detector?.routesChecked ?? []) {
    cells.push({
      source: 'detector',
      route: route.route,
      pageKind: route.expectedKind,
      phase: 'route-complete',
      browser: route.browser ?? 'chromium',
      viewport: route.viewport ?? null,
      state: { session: 'anonymous' },
      clock: null,
      fixtureId: null,
      result: route.status,
      fatalHydrationIssueCount: route.fatalHydrationIssueCount ?? 0,
      warnings: [],
      errors: [],
      durationMs: route.durationMs ?? null,
    })
  }

  const clock = artifacts.find((artifact) => artifact.id === 'clock')?.data
  for (const clockCase of clock?.cases ?? []) {
    for (const row of clockCase.rows ?? []) {
      cells.push({
        source: 'clock',
        route: row.route ?? null,
        pageKind: row.kind,
        phase: 'ssr-hydration-clock-drift',
        browser: 'browserless',
        viewport: row.viewport ?? null,
        state: { session: 'anonymous' },
        clock: {
          ssrClock: clockCase.ssrClock,
          hydrationClock: clockCase.hydrationClock,
          serverTimeZone: clockCase.serverTimeZone,
          browserTimeZone: clockCase.browserTimeZone,
          locale: clockCase.locale,
        },
        fixtureId: clockCase.id,
        result: row.status ?? clockCase.status ?? 'success',
        fatalHydrationIssueCount: 0,
        warnings: [],
        errors: [],
        durationMs: row.durationMs ?? null,
      })
    }
  }

  const browserEnv = artifacts.find((artifact) => artifact.id === 'browserEnv')?.data
  for (const row of browserEnv?.rows ?? []) {
    cells.push({
      source: 'browserEnv',
      route: row.route ?? row.routeId ?? null,
      pageKind: row.kind ?? row.pageKind ?? null,
      phase: row.phase ?? 'browser-environment-model',
      browser: row.browser ?? 'browserless',
      viewport: row.environment?.viewport ?? row.viewport ?? null,
      state: row.environment ?? {},
      clock: null,
      fixtureId: row.environment?.id ?? null,
      result: row.status,
      fatalHydrationIssueCount: row.fatalHydrationIssueCount ?? 0,
      warnings: row.warnings ?? [],
      errors: row.errors ?? [],
      durationMs: row.durationMs ?? null,
    })
  }

  const payloadFixture = artifacts.find((artifact) => artifact.id === 'payloadFixture')?.data
  for (const fixture of payloadFixture?.fixtures ?? []) {
    cells.push({
      source: 'payloadFixture',
      route: fixture.route ?? null,
      pageKind: fixture.kind ?? fixture.pageKind ?? null,
      phase: 'payload-fixture-ssr-hydration',
      browser: fixture.browser ?? 'browserless',
      viewport: fixture.viewport ?? null,
      state: { session: 'anonymous' },
      clock: null,
      fixtureId: fixture.id,
      result: fixture.status,
      fatalHydrationIssueCount: fixture.fatalHydrationIssueCount ?? 0,
      warnings: fixture.warnings ?? [],
      errors: fixture.errors ?? [],
      durationMs: fixture.durationMs ?? null,
    })
  }

  const domDiff = artifacts.find((artifact) => artifact.id === 'domDiff')?.data
  for (const domCase of domDiff?.cases ?? []) {
    cells.push({
      source: 'domDiff',
      route: domCase.route ?? domCase.routeKey ?? null,
      pageKind: domCase.pageKind,
      phase: 'normalized-ssr-vs-csr-dom-diff',
      browser: domCase.browser ?? 'browserless',
      viewport: domCase.viewport ?? null,
      state: { session: 'anonymous' },
      clock: null,
      fixtureId: domCase.fixtureId ?? domCase.routeKey ?? null,
      result: domCase.status ?? (Number(domCase.diffCount ?? 0) === 0 ? 'success' : 'failure'),
      fatalHydrationIssueCount: Number(domCase.diffCount ?? 0),
      warnings: [],
      errors: domCase.diffs ?? [],
      durationMs: domCase.durationMs ?? null,
    })
  }

  return cells
}

function buildCoverage(registryState, selectedLane, artifacts, cells) {
  const pageKinds = selectedLane?.routeSet ?? registryState.pageKinds.map((entry) => entry.kind)
  const fixtureSummary = artifacts.find((artifact) => artifact.id === 'payloadFixture')?.data
  const browserEnvSummary = artifacts.find((artifact) => artifact.id === 'browserEnv')?.data
  const clockSummary = artifacts.find((artifact) => artifact.id === 'clock')?.data

  return {
    routes: registryState.pageKinds
      .filter((entry) => pageKinds.includes(entry.kind))
      .map((entry) => ({ kind: entry.kind, route: entry.route, routeKey: entry.routeKey })),
    pageKinds,
    phases: sorted([...(selectedLane?.phases ?? []), ...cells.map((cell) => cell.phase)]),
    browsers: sorted([...(selectedLane?.browsers ?? []), ...cells.map((cell) => cell.browser)]),
    viewports: sorted([
      ...(selectedLane?.viewports ?? []),
      ...(browserEnvSummary?.coverage?.viewports ?? []),
      ...cells.map((cell) => typeof cell.viewport === 'string' ? cell.viewport : cell.viewport?.name),
    ]),
    states: sorted([
      ...(selectedLane?.states ?? []),
      ...(browserEnvSummary?.coverage?.sessionStates ?? []),
    ]),
    clocks: sorted((clockSummary?.cases ?? []).map((item) => item.id)),
    timezones: sorted((clockSummary?.cases ?? []).flatMap((item) => [item.serverTimeZone, item.browserTimeZone])),
    fixtures: sorted([
      ...(selectedLane?.fixtures ?? []),
      ...(fixtureSummary?.fixtures ?? []).map((item) => item.id),
    ]),
    shardStrategies: selectedLane?.shardStrategyRefs ?? [],
  }
}

function main() {
  const startedAt = Date.now()
  const lane = parseArgs()
  const errors = []
  let registry
  let registryState = null
  let selectedLane = null
  let artifacts = []
  let cells = []

  try {
    registry = readJsonFile(registryFile)
    registryState = validateRegistry(registry, lane, errors)
    selectedLane = registryState.selectedLane
    validateRepoWiring(errors)

    const requiredArtifacts = selectedLane?.requiredArtifacts ?? []
    artifacts = Object.keys(artifactSpecs).map((id) => loadArtifact(id, errors, requireArtifacts && requiredArtifacts.includes(id)))
    cells = buildCells(artifacts)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  const coverage = registryState && selectedLane
    ? buildCoverage(registryState, selectedLane, artifacts, cells)
    : { routes: [], pageKinds: [], phases: [], browsers: [], states: [], fixtures: [] }

  const summary = {
    schema: SUMMARY_SCHEMA,
    status: errors.length === 0 ? 'success' : 'failure',
    lane,
    generatedAt: new Date().toISOString(),
    gitSha: getGitSha(),
    rendererVersion: getRendererVersion(),
    registry: {
      schema: registry?.schema ?? null,
      file: 'tests/frontend/checks/public/public-hydration-matrix.registry.json',
    },
    costClass: selectedLane?.costClass ?? null,
    command: selectedLane?.command ?? null,
    coverage,
    requiredArtifacts: Object.fromEntries((selectedLane?.requiredArtifacts ?? []).map((id) => [id, artifactSpecs[id]?.file ?? null])),
    artifactStatuses: Object.fromEntries(artifacts.map((artifact) => [artifact.id, artifact.status])),
    lanes: (registryState?.lanes ?? []).map((entry) => ({
      id: entry.id,
      costClass: entry.costClass,
      ciTier: entry.ciTier,
      command: entry.command,
      enforcement: entry.enforcement,
      shardStrategyRefs: entry.shardStrategyRefs,
    })),
    shardStrategies: registryState?.shardStrategies ?? [],
    cells,
    fatalHydrationIssueCount: cells.reduce((total, cell) => total + Number(cell.fatalHydrationIssueCount ?? 0), 0),
    warnings: [],
    errors: errors.map((message) => ({ stage: 'public-hydration-matrix-governance', message })),
    durationMs: Date.now() - startedAt,
  }

  writeSummary(summary)

  if (summary.status !== 'success') {
    for (const error of errors) {
      console.error(`[public-hydration-matrix] ${error}`)
    }
    console.error(`[public-hydration-matrix] summary=${summaryFile}`)
    process.exit(1)
  }

  console.log(`[public-hydration-matrix] ok lane=${lane} cells=${cells.length} summary=${summaryFile}`)
}

main()
