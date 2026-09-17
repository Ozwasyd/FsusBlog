#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  normalizeReleaseId,
  sha256Buffer,
  writeJsonAtomic
} from '../storage/release-assets.mjs'

export const ASSET_COMPATIBILITY_SCENARIO_SCHEMA = 'fsusblog.release-asset-compatibility-scenario.v1'
export const ASSET_COMPATIBILITY_CHECKPOINT_SCHEMA = 'fsusblog.release-asset-compatibility-checkpoint.v1'
export const ASSET_COMPATIBILITY_EVIDENCE_SCHEMA = 'fsusblog.release-asset-compatibility-evidence.v1'
export const ASSET_COMPATIBILITY_SIGNAL_SCHEMA = 'fsusblog.release-asset-compatibility-signal.v1'

const ASSET_MANIFEST_SCHEMA = 'fsusblog.release-assets.v1'
const GC_EVIDENCE_SCHEMA = 'fsusblog.release-assets.gc-evidence.v1'
const ASSET_BROWSER_BINDING_SCHEMA = 'fsusblog.release-asset-browser-binding.v1'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const REQUIRED_ASSET_KINDS = Object.freeze(['javascript', 'stylesheet', 'wasm', 'font'])
const ASSET_KIND_BY_EXTENSION = Object.freeze(new Map([
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.css', 'stylesheet'],
  ['.wasm', 'wasm'],
  ['.woff', 'font'],
  ['.woff2', 'font'],
  ['.ttf', 'font'],
  ['.otf', 'font'],
  ['.eot', 'font']
]))

export function normalizeAssetCompatibilityScenario(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('asset compatibility scenario must be an object')
  }
  if (value.schema !== ASSET_COMPATIBILITY_SCENARIO_SCHEMA) {
    throw new Error(`scenario schema must be ${ASSET_COMPATIBILITY_SCENARIO_SCHEMA}`)
  }

  const oldReleaseId = normalizeReleaseId(value.oldReleaseId)
  const newReleaseId = normalizeReleaseId(value.newReleaseId)
  if (oldReleaseId === newReleaseId) throw new Error('oldReleaseId and newReleaseId must differ')

  const requiredAssetKinds = [...new Set(value.requiredAssetKinds ?? REQUIRED_ASSET_KINDS)]
  for (const kind of requiredAssetKinds) {
    if (!REQUIRED_ASSET_KINDS.includes(kind)) throw new Error(`unsupported required asset kind: ${kind}`)
  }
  if (requiredAssetKinds.length === 0) throw new Error('requiredAssetKinds cannot be empty')

  const compatibilityRequests = value.compatibilityRequests
  if (!compatibilityRequests || typeof compatibilityRequests !== 'object' || Array.isArray(compatibilityRequests)) {
    throw new Error('compatibilityRequests must be an object')
  }

  const retentionUntilMs = Date.parse(value.retention?.untilUtc ?? '')
  if (!Number.isFinite(retentionUntilMs)) throw new Error('retention.untilUtc must be an ISO-8601 timestamp')

  return {
    schema: ASSET_COMPATIBILITY_SCENARIO_SCHEMA,
    drillId: normalizeOptionalIdentifier(value.drillId) ?? crypto.randomUUID(),
    oldReleaseId,
    newReleaseId,
    oldFrontendBaseUrl: normalizeBaseUrl(value.oldFrontendBaseUrl, 'oldFrontendBaseUrl'),
    publicBaseUrl: normalizeBaseUrl(value.publicBaseUrl, 'publicBaseUrl'),
    oldBackendBaseUrl: normalizeBaseUrl(value.oldBackendBaseUrl, 'oldBackendBaseUrl'),
    newBackendBaseUrl: normalizeBaseUrl(value.newBackendBaseUrl, 'newBackendBaseUrl'),
    oldIndexPath: normalizeHttpPath(
      value.oldIndexPath ?? `/release-assets/${oldReleaseId}/index.html`,
      'oldIndexPath'),
    oldManifestPath: normalizeHttpPath(
      value.oldManifestPath ?? `/release-assets/${oldReleaseId}/asset-manifest.json`,
      'oldManifestPath'),
    serviceWorker: {
      scriptPath: normalizeHttpPath(
        value.serviceWorker?.scriptPath ?? `/release-assets/${oldReleaseId}/sw.js?build=${encodeURIComponent(oldReleaseId)}`,
        'serviceWorker.scriptPath'),
      cachePaths: normalizeOptionalHttpPaths(value.serviceWorker?.cachePaths, 'serviceWorker.cachePaths')
    },
    browser: normalizeBrowserScenario(value.browser, {
      oldReleaseId,
      newReleaseId,
      publicBaseUrl: value.publicBaseUrl
    }),
    requiredAssetKinds,
    compatibilityRequests: {
      oldFrontendToNewBackend: normalizeCompatibilityRequests(
        compatibilityRequests.oldFrontendToNewBackend,
        'compatibilityRequests.oldFrontendToNewBackend'),
      newFrontendToOldBackend: normalizeCompatibilityRequests(
        compatibilityRequests.newFrontendToOldBackend,
        'compatibilityRequests.newFrontendToOldBackend')
    },
    retention: {
      untilUtc: new Date(retentionUntilMs).toISOString(),
      requiredProtectionReason: normalizeOptionalIdentifier(value.retention?.requiredProtectionReason)
        ?? 'retention-window'
    },
    requestTimeoutMs: boundedInteger(value.requestTimeoutMs ?? 10_000, 100, 120_000, 'requestTimeoutMs')
  }
}

export function extractIndexAssetUrls(html) {
  const source = String(html ?? '')
  const urls = []
  const tags = source.match(/<(?:script|link)\b[^>]*>/giu) ?? []
  for (const tag of tags) {
    const attribute = /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/iu.exec(tag)
    const candidate = attribute?.[1] ?? attribute?.[2] ?? attribute?.[3]
    if (candidate && !candidate.startsWith('data:')) urls.push(candidate)
  }
  return [...new Set(urls)]
}

function normalizeBrowserScenario(value, context) {
  const browser = value ?? {}
  if (!browser || typeof browser !== 'object' || Array.isArray(browser)) throw new Error('browser must be an object')
  const required = browser.required !== false
  const holdToken = normalizeOptionalIdentifier(browser.holdToken)
    ?? `asset-hold-${crypto.createHash('sha256').update(`${context.oldReleaseId}\0${context.newReleaseId}`).digest('hex').slice(0, 24)}`
  const expectedCacheNamespace = String(browser.expectedCacheNamespace ?? `fsus-static-v4:${context.oldReleaseId}`)
  if (!expectedCacheNamespace || expectedCacheNamespace.length > 256 || /[\r\n\0]/u.test(expectedCacheNamespace)) {
    throw new Error('browser.expectedCacheNamespace is invalid')
  }
  return {
    required,
    playwrightModule: path.resolve(browser.playwrightModule
      ?? process.env.FSUSBLOG_PLAYWRIGHT_MODULE
      ?? path.join(ROOT, 'src/frontend/node_modules/playwright/index.mjs')),
    bindingKeyFile: browser.bindingKeyFile === undefined && !process.env.FSUSBLOG_ASSET_BROWSER_BINDING_KEY_FILE
      ? null
      : path.resolve(process.env.FSUSBLOG_ASSET_BROWSER_BINDING_KEY_FILE ?? browser.bindingKeyFile),
    executablePath: browser.executablePath === undefined ? null : path.resolve(browser.executablePath),
    newFrontendBaseUrl: normalizeBaseUrl(browser.newFrontendBaseUrl ?? context.publicBaseUrl, 'browser.newFrontendBaseUrl'),
    newIndexPath: normalizeHttpPath(
      browser.newIndexPath ?? `/release-assets/${context.newReleaseId}/index.html`,
      'browser.newIndexPath'),
    expectedCacheNamespace,
    holdToken,
    timeoutMs: boundedInteger(browser.timeoutMs ?? 60_000, 1_000, 300_000, 'browser.timeoutMs')
  }
}

export async function captureOldReleaseCheckpoint(rawScenario, dependencies = {}) {
  const scenario = isNormalizedScenario(rawScenario)
    ? rawScenario
    : normalizeAssetCompatibilityScenario(rawScenario)
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  const now = dependencies.now ?? (() => new Date())
  const capturedAtUtc = now().toISOString()
  const errors = []

  const manifestResult = await fetchPayload({
    fetchImpl,
    baseUrl: scenario.oldFrontendBaseUrl,
    requestPath: scenario.oldManifestPath,
    timeoutMs: scenario.requestTimeoutMs,
    label: 'old asset manifest'
  })
  if (!manifestResult.ok) errors.push(...resultErrors(manifestResult))

  let manifest = null
  if (manifestResult.ok) {
    try {
      manifest = JSON.parse(manifestResult.body.toString('utf8'))
      validateAssetManifest(manifest, scenario.oldReleaseId)
    } catch (error) {
      errors.push(`old asset manifest is invalid: ${message(error)}`)
      manifest = null
    }
  }

  const indexManifestEntry = manifest?.files.find(file => file.path === 'index.html') ?? null
  if (manifest && !indexManifestEntry) errors.push('N-1 asset manifest has no index.html entry')
  const indexResult = await fetchPayload({
    fetchImpl,
    baseUrl: scenario.oldFrontendBaseUrl,
    requestPath: scenario.oldIndexPath,
    timeoutMs: scenario.requestTimeoutMs,
    expectedSha256: indexManifestEntry?.sha256 ?? null,
    label: 'N-1 index.html'
  })
  if (!indexResult.ok) errors.push(...resultErrors(indexResult))

  const selectedFiles = manifest
    ? manifest.files
      .map(file => ({ ...file, kind: assetKind(file.path) }))
      .filter(file => file.kind !== null && file.class === 'immutable-static')
    : []
  const coverage = Object.fromEntries(REQUIRED_ASSET_KINDS.map(kind => [kind, selectedFiles.filter(file => file.kind === kind).length]))
  for (const kind of scenario.requiredAssetKinds) {
    if (coverage[kind] === 0) errors.push(`N-1 asset manifest has no ${kind} resource`)
  }

  const capturedAssets = await Promise.all(selectedFiles.map(async file => {
    const result = await fetchPayload({
      fetchImpl,
      baseUrl: scenario.oldFrontendBaseUrl,
      requestPath: file.releaseUrl,
      timeoutMs: scenario.requestTimeoutMs,
      expectedSha256: file.sha256,
      label: `N-1 ${file.kind} ${file.path}`
    })
    if (!result.ok) errors.push(...resultErrors(result))
    return assetObservation(file, result, 'before-switch')
  }))

  const indexReferences = indexResult.ok
    ? extractIndexAssetUrls(indexResult.body.toString('utf8')).map(reference => resolveReference(reference, scenario.oldIndexPath))
    : []
  const manifestUrls = new Set(selectedFiles.map(file => normalizeComparablePath(file.releaseUrl)))
  for (const reference of indexReferences.filter(reference => assetKind(reference) !== null)) {
    if (!manifestUrls.has(normalizeComparablePath(reference))) {
      errors.push(`N-1 index resource is not bound by its asset manifest: ${reference}`)
    }
  }

  const serviceWorkerManifestEntry = manifest?.files.find(file =>
    normalizeComparablePathWithoutSearch(file.releaseUrl)
      === normalizeComparablePathWithoutSearch(scenario.serviceWorker.scriptPath)) ?? null
  if (manifest && !serviceWorkerManifestEntry) errors.push('N-1 Service Worker is not bound by its asset manifest')
  const serviceWorkerResult = await fetchPayload({
    fetchImpl,
    baseUrl: scenario.oldFrontendBaseUrl,
    requestPath: scenario.serviceWorker.scriptPath,
    timeoutMs: scenario.requestTimeoutMs,
    expectedSha256: serviceWorkerManifestEntry?.sha256 ?? null,
    label: 'N-1 service worker'
  })
  if (!serviceWorkerResult.ok) errors.push(...resultErrors(serviceWorkerResult))

  const cachePaths = scenario.serviceWorker.cachePaths.length > 0
    ? scenario.serviceWorker.cachePaths
    : selectedFiles.map(file => file.releaseUrl)
  const selectedByUrl = new Map(selectedFiles.map(file => [normalizeComparablePath(file.releaseUrl), file]))
  const serviceWorkerCache = []
  for (const cachePath of cachePaths) {
    const file = selectedByUrl.get(normalizeComparablePath(cachePath))
    if (!file) {
      errors.push(`service worker cache path is not bound by the N-1 manifest: ${cachePath}`)
      continue
    }
    const captured = capturedAssets.find(asset => asset.path === file.path)
    serviceWorkerCache.push({
      path: cachePath,
      manifestPath: file.path,
      expectedSha256: file.sha256,
      capturedSha256: captured?.sha256 ?? null,
      status: captured?.status === 'pass' ? 'captured' : 'fail'
    })
  }
  for (const kind of scenario.requiredAssetKinds) {
    const cachedKind = serviceWorkerCache.some(item => {
      const file = selectedByUrl.get(normalizeComparablePath(item.path))
      return file?.kind === kind && item.status === 'captured'
    })
    if (!cachedKind) errors.push(`service worker cache has no manifest-bound ${kind} entry`)
  }

  return {
    schema: ASSET_COMPATIBILITY_CHECKPOINT_SCHEMA,
    status: errors.length === 0 ? 'pass' : 'fail',
    drillId: scenario.drillId,
    capturedAtUtc,
    oldReleaseId: scenario.oldReleaseId,
    newReleaseId: scenario.newReleaseId,
    publicBaseUrl: scenario.publicBaseUrl,
    manifest: manifest
      ? {
          path: scenario.oldManifestPath,
          sha256: manifestResult.sha256,
          declaredFileCount: manifest.files.length
        }
      : null,
    index: observation(indexResult, 'before-switch', scenario.oldIndexPath),
    indexReferences,
    coverage,
    assets: capturedAssets,
    serviceWorker: {
      script: observation(serviceWorkerResult, 'before-switch', scenario.serviceWorker.scriptPath),
      cacheEntries: serviceWorkerCache
    },
    errors
  }
}

export async function runReleaseAssetCompatibilityDrill(rawScenario, dependencies = {}) {
  const scenario = isNormalizedScenario(rawScenario)
    ? rawScenario
    : normalizeAssetCompatibilityScenario(rawScenario)
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  const now = dependencies.now ?? (() => new Date())
  const waitForStage = dependencies.waitForStage ?? (async () => {})
  const onCheckpoint = dependencies.onCheckpoint ?? (async () => {})
  const getGcEvidence = dependencies.getGcEvidence ?? (async () => null)
  const rolloutId = dependencies.rolloutId ?? null
  const startedAtUtc = now().toISOString()
  let browserSession = null
  let browserEvidence = null

  const checkpoint = await captureOldReleaseCheckpoint(scenario, { fetchImpl, now })
  if (checkpoint.status === 'pass' && scenario.browser.required) {
    try {
      const startBrowserSession = dependencies.startBrowserSession
        ?? (await import('./release-asset-browser-session.mjs')).startReleaseAssetBrowserSession
      browserSession = await startBrowserSession({
        scenario,
        rolloutId,
        scenarioSha256: dependencies.scenarioSha256 ?? null,
        manifestSha256: checkpoint.manifest.sha256,
        assets: checkpoint.assets.map(asset => ({
          path: asset.path,
          releaseUrl: asset.releaseUrl,
          kind: asset.kind,
          expectedSha256: asset.expectedSha256
        })),
        cachePaths: checkpoint.serviceWorker.cacheEntries.map(item => item.path),
        expectedCacheNamespace: scenario.browser.expectedCacheNamespace,
        holdToken: scenario.browser.holdToken,
        playwrightModule: scenario.browser.playwrightModule,
        executablePath: scenario.browser.executablePath,
        newFrontendBaseUrl: scenario.browser.newFrontendBaseUrl,
        newIndexPath: scenario.browser.newIndexPath,
        timeoutMs: scenario.browser.timeoutMs
      })
      checkpoint.browser = browserSession.checkpoint
      if (checkpoint.browser.beforeSwitch?.status !== 'pass') {
        checkpoint.errors.push(...checkpoint.browser.errors.map(error => `browser: ${error}`))
      }
    } catch (error) {
      checkpoint.errors.push(`controlled browser checkpoint failed: ${message(error)}`)
    }
    checkpoint.status = checkpoint.errors.length === 0 ? 'pass' : 'fail'
  }
  await onCheckpoint(checkpoint)
  if (checkpoint.status !== 'pass') {
    await browserSession?.close().catch(() => {})
    const early = buildEarlyFailure(scenario, checkpoint, startedAtUtc, now().toISOString(), rolloutId)
    early.browser = checkpoint.browser ?? null
    return early
  }

  await waitForStage('switched', scenario.drillId)
  const switchObservedAtUtc = now().toISOString()
  const afterSwitch = await verifyRetainedResources(scenario, checkpoint, {
    fetchImpl,
    phase: 'after-switch'
  })

  let oldFrontendToNewBackend
  let newFrontendToOldBackend
  if (browserSession) {
    const browserAfterSwitch = await browserSession.afterSwitch()
    browserEvidence = browserAfterSwitch
    oldFrontendToNewBackend = browserAfterSwitch.compatibility.oldFrontendToNewBackend
    newFrontendToOldBackend = browserAfterSwitch.compatibility.newFrontendToOldBackend
  } else {
    oldFrontendToNewBackend = await runCompatibilityRequests({
      id: 'oldFrontendToNewBackend',
      requests: scenario.compatibilityRequests.oldFrontendToNewBackend,
      baseUrl: scenario.newBackendBaseUrl,
      clientReleaseId: scenario.oldReleaseId,
      expectedServerReleaseId: scenario.newReleaseId,
      timeoutMs: scenario.requestTimeoutMs,
      fetchImpl
    })
    newFrontendToOldBackend = await runCompatibilityRequests({
      id: 'newFrontendToOldBackend',
      requests: scenario.compatibilityRequests.newFrontendToOldBackend,
      baseUrl: scenario.oldBackendBaseUrl,
      clientReleaseId: scenario.newReleaseId,
      expectedServerReleaseId: scenario.oldReleaseId,
      timeoutMs: scenario.requestTimeoutMs,
      fetchImpl
    })
  }

  await waitForStage('gc-complete', scenario.drillId)
  const gcObservedAtUtc = now().toISOString()
  const gcEvidence = await getGcEvidence()
  const retention = validateRetentionEvidence(scenario, gcEvidence, gcObservedAtUtc)
  const afterGc = await verifyRetainedResources(scenario, checkpoint, {
    fetchImpl,
    phase: 'after-gc'
  })
  if (browserSession) {
    await browserSession.afterGc()
    browserEvidence = browserSession.evidence()
    browserEvidence.bindings.gcEvidenceSha256 = dependencies.getGcEvidenceSha256?.()
      ?? sha256Buffer(Buffer.from(canonicalJson(gcEvidence)))
    await browserSession.close()
  }

  const resourceObservations = [...afterSwitch.resources, ...afterGc.resources]
  const serviceWorkerObservations = [afterSwitch.serviceWorker, afterGc.serviceWorker]
  const allErrors = [
    ...checkpoint.errors,
    ...afterSwitch.errors,
    ...oldFrontendToNewBackend.errors,
    ...newFrontendToOldBackend.errors,
    ...retention.errors,
    ...afterGc.errors,
    ...(browserEvidence?.errors ?? []).map(error => `browser: ${error}`)
  ]
  const notFoundCount = [...resourceObservations, ...serviceWorkerObservations]
    .filter(item => item.httpStatus === 404).length
    + (browserEvidence?.network?.responses?.filter(item => item.status === 404).length ?? 0)
  const hashMismatchCount = [...resourceObservations, ...serviceWorkerObservations]
    .filter(item => item.hashMatches === false).length
    + (browserEvidence?.delayed?.resources?.filter(item => item.hashMatches === false).length ?? 0)
    + (browserEvidence?.errors?.filter(error => /hash mismatch/iu.test(error)).length ?? 0)
  const connectionErrorCount = [...resourceObservations, ...serviceWorkerObservations]
    .filter(item => item.error !== null).length
    + oldFrontendToNewBackend.requests.filter(item => item.error !== null).length
    + newFrontendToOldBackend.requests.filter(item => item.error !== null).length
    + (browserEvidence?.network?.failures?.filter(failure =>
      !browserEvidence.network.blockedOldAssetRequests.some(pathname => failure.path.startsWith(pathname))).length ?? 0)
  const oldServiceWorkerCache = scenarioStatus(browserEvidence
    ? browserEvidence.beforeSwitch?.serviceWorker?.controller !== null
      && browserEvidence.afterGc?.status === 'pass'
      && browserEvidence.afterGc?.cacheReads?.every(item => item.cacheHit === true)
    : checkpoint.serviceWorker.script.status === 'pass'
      && checkpoint.serviceWorker.cacheEntries.length > 0
      && checkpoint.serviceWorker.cacheEntries.every(item => item.status === 'captured')
      && afterSwitch.serviceWorkerStatus === 'pass'
      && afterGc.serviceWorkerStatus === 'pass')
  const scenarios = {
    delayedOldAssets: scenarioStatus(afterSwitch.status === 'pass'
      && (!browserEvidence || browserEvidence.delayed.resources.every(item => item.hashMatches === true))),
    oldFrontendToNewBackend: oldFrontendToNewBackend.status,
    newFrontendToOldBackend: newFrontendToOldBackend.status,
    oldServiceWorkerCache,
    retentionWindowAfterGc: scenarioStatus(retention.status === 'pass'
      && afterGc.status === 'pass'
      && (!browserEvidence || browserEvidence.afterGc.status === 'pass'))
  }
  const status = allErrors.length === 0 && Object.values(scenarios).every(value => value === 'pass')
    ? 'pass'
    : 'fail'

  return {
    schema: ASSET_COMPATIBILITY_EVIDENCE_SCHEMA,
    status,
    rolloutId,
    drillId: scenario.drillId,
    sourceReleaseId: scenario.oldReleaseId,
    targetReleaseId: scenario.newReleaseId,
    startedAtUtc,
    checkpointCapturedAtUtc: checkpoint.capturedAtUtc,
    switchObservedAtUtc,
    gcObservedAtUtc,
    completedAtUtc: now().toISOString(),
    assetCount: checkpoint.assets.length,
    requiredAssetKinds: scenario.requiredAssetKinds,
    assetKindCoverage: checkpoint.coverage,
    notFoundCount,
    hashMismatchCount,
    connectionErrorCount,
    scenarios,
    checkpoint,
    afterSwitch,
    compatibility: {
      oldFrontendToNewBackend,
      newFrontendToOldBackend
    },
    retention,
    afterGc,
    browser: browserEvidence,
    errors: allErrors
  }
}

export async function waitForLifecycleSignal(file, expectedStage, drillId, options = {}) {
  const timeoutMs = boundedInteger(options.timeoutMs ?? 900_000, 100, 86_400_000, 'signal timeout')
  const pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 100, 10, 10_000, 'signal poll interval')
  const deadline = Date.now() + timeoutMs
  let lastProblem = 'signal file does not exist'
  while (Date.now() <= deadline) {
    try {
      const signal = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (signal.schema !== ASSET_COMPATIBILITY_SIGNAL_SCHEMA) lastProblem = 'signal schema is invalid'
      else if (signal.drillId !== drillId) lastProblem = 'signal drillId does not match'
      else if (signal.stage !== expectedStage) lastProblem = `signal stage is ${String(signal.stage)}`
      else return signal
    } catch (error) {
      lastProblem = error?.code === 'ENOENT' ? 'signal file does not exist' : message(error)
    }
    await delay(pollIntervalMs)
  }
  throw new Error(`timed out waiting for ${expectedStage} signal ${file}: ${lastProblem}`)
}

async function verifyRetainedResources(scenario, checkpoint, { fetchImpl, phase }) {
  const errors = []
  const resources = await Promise.all(checkpoint.assets.map(async asset => {
    const result = await fetchPayload({
      fetchImpl,
      baseUrl: scenario.publicBaseUrl,
      requestPath: asset.releaseUrl,
      timeoutMs: scenario.requestTimeoutMs,
      expectedSha256: asset.expectedSha256,
      label: `${phase} ${asset.kind} ${asset.path}`
    })
    if (!result.ok) errors.push(...resultErrors(result))
    return assetObservation({
      path: asset.path,
      releaseUrl: asset.releaseUrl,
      sha256: asset.expectedSha256,
      kind: asset.kind
    }, result, phase)
  }))

  const serviceWorkerResult = await fetchPayload({
    fetchImpl,
    baseUrl: scenario.publicBaseUrl,
    requestPath: scenario.serviceWorker.scriptPath,
    timeoutMs: scenario.requestTimeoutMs,
    expectedSha256: checkpoint.serviceWorker.script.sha256,
    label: `${phase} N-1 service worker`
  })
  if (!serviceWorkerResult.ok) errors.push(...resultErrors(serviceWorkerResult))

  return {
    phase,
    status: errors.length === 0 ? 'pass' : 'fail',
    serviceWorkerStatus: serviceWorkerResult.ok ? 'pass' : 'fail',
    serviceWorker: observation(serviceWorkerResult, phase, scenario.serviceWorker.scriptPath),
    resources,
    errors
  }
}

async function runCompatibilityRequests({
  id,
  requests,
  baseUrl,
  clientReleaseId,
  expectedServerReleaseId,
  timeoutMs,
  fetchImpl
}) {
  const errors = []
  const observations = await Promise.all(requests.map(async request => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('request-timeout'), request.timeoutMs ?? timeoutMs)
    let response
    try {
      response = await fetchImpl(resolveSameOrigin(baseUrl, request.path), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'manual',
        signal: controller.signal
      })
      const body = Buffer.from(await response.arrayBuffer())
      const actualSha256 = sha256Buffer(body)
      const responseHeaders = selectEvidenceHeaders(response.headers)
      const requestErrors = []
      if (!request.expectedStatuses.includes(response.status)) {
        requestErrors.push(`${id}:${request.id} unexpected HTTP ${response.status}`)
      }
      const observedRelease = response.headers.get('x-fsus-release-id')
      if (request.requireReleaseHeader && observedRelease !== expectedServerReleaseId) {
        requestErrors.push(`${id}:${request.id} expected server release ${expectedServerReleaseId}, observed ${observedRelease ?? 'missing'}`)
      }
      if (request.expectedSha256 && actualSha256 !== request.expectedSha256) {
        requestErrors.push(`${id}:${request.id} response hash mismatch`)
      }
      for (const [name, expected] of Object.entries(request.expectedHeaders)) {
        const actual = response.headers.get(name)
        if (actual !== expected) requestErrors.push(`${id}:${request.id} response header ${name} mismatch`)
      }
      errors.push(...requestErrors)
      return {
        id: request.id,
        method: request.method,
        path: request.path,
        clientReleaseId,
        expectedServerReleaseId,
        observedServerReleaseId: observedRelease,
        httpStatus: response.status,
        sha256: actualSha256,
        responseHeaders,
        status: requestErrors.length === 0 ? 'pass' : 'fail',
        error: null
      }
    } catch (error) {
      const detail = `${id}:${request.id} request failed: ${message(error)}`
      errors.push(detail)
      return {
        id: request.id,
        method: request.method,
        path: request.path,
        clientReleaseId,
        expectedServerReleaseId,
        observedServerReleaseId: null,
        httpStatus: null,
        sha256: null,
        responseHeaders: {},
        status: 'fail',
        error: message(error)
      }
    } finally {
      clearTimeout(timeout)
    }
  }))
  return { id, status: errors.length === 0 ? 'pass' : 'fail', requests: observations, errors }
}

function validateRetentionEvidence(scenario, evidence, observedAtUtc) {
  const errors = []
  const observedMs = Date.parse(observedAtUtc)
  const untilMs = Date.parse(scenario.retention.untilUtc)
  if (!(observedMs <= untilMs)) {
    errors.push(`GC verification occurred outside the retention window ending ${scenario.retention.untilUtc}`)
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    errors.push('GC evidence is missing')
  } else {
    if (evidence.schema !== GC_EVIDENCE_SCHEMA) errors.push(`GC evidence schema must be ${GC_EVIDENCE_SCHEMA}`)
    if (evidence.status !== 'ok' || evidence.dryRun !== false) errors.push('GC evidence must describe an applied GC run')
    const release = Array.isArray(evidence.releaseActions)
      ? evidence.releaseActions.find(item => item.releaseId === scenario.oldReleaseId)
      : null
    if (!release || release.protected !== true || release.action !== 'retain') {
      errors.push(`GC did not retain old release ${scenario.oldReleaseId}`)
    } else if (!Array.isArray(release.reasons)
      || !release.reasons.includes(scenario.retention.requiredProtectionReason)) {
      errors.push(`GC retention reason ${scenario.retention.requiredProtectionReason} is missing for ${scenario.oldReleaseId}`)
    }
    if (!Array.isArray(evidence.after?.releases) || !evidence.after.releases.includes(scenario.oldReleaseId)) {
      errors.push(`old release ${scenario.oldReleaseId} is absent after GC`)
    }
  }
  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    releaseId: scenario.oldReleaseId,
    observedAtUtc,
    requiredUntilUtc: scenario.retention.untilUtc,
    requiredProtectionReason: scenario.retention.requiredProtectionReason,
    gcEvidenceSchema: evidence?.schema ?? null,
    gcStatus: evidence?.status ?? null,
    errors
  }
}

async function fetchPayload({ fetchImpl, baseUrl, requestPath, timeoutMs, expectedSha256 = null, label }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort('request-timeout'), timeoutMs)
  const url = resolveSameOrigin(baseUrl, requestPath)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal
    })
    const body = Buffer.from(await response.arrayBuffer())
    const sha256 = sha256Buffer(body)
    const hashMatches = expectedSha256 ? sha256 === expectedSha256 : null
    const errors = []
    if (response.status !== 200) errors.push(`${label} returned HTTP ${response.status}`)
    if (hashMatches === false) errors.push(`${label} hash mismatch: expected ${expectedSha256}, observed ${sha256}`)
    return {
      ok: errors.length === 0,
      label,
      url,
      httpStatus: response.status,
      contentType: response.headers.get('content-type'),
      frontendBuildId: response.headers.get('x-fsus-frontend-build'),
      sha256,
      expectedSha256,
      hashMatches,
      bytes: body.byteLength,
      body,
      error: null,
      errors
    }
  } catch (error) {
    return {
      ok: false,
      label,
      url,
      httpStatus: null,
      contentType: null,
      frontendBuildId: null,
      sha256: null,
      expectedSha256,
      hashMatches: null,
      bytes: 0,
      body: Buffer.alloc(0),
      error: message(error),
      errors: [`${label} request failed: ${message(error)}`]
    }
  } finally {
    clearTimeout(timeout)
  }
}

function validateAssetManifest(manifest, releaseId) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest must be an object')
  if (manifest.schema !== ASSET_MANIFEST_SCHEMA) throw new Error(`manifest schema must be ${ASSET_MANIFEST_SCHEMA}`)
  if (manifest.releaseId !== releaseId) throw new Error(`manifest releaseId must be ${releaseId}`)
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('manifest files must be a non-empty array')
  const seen = new Set()
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('manifest file entry must be an object')
    if (typeof file.path !== 'string' || !file.path || file.path.startsWith('/') || file.path.includes('..')) {
      throw new Error('manifest file path is unsafe')
    }
    if (seen.has(file.path)) throw new Error(`manifest file path is duplicated: ${file.path}`)
    seen.add(file.path)
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(file.sha256))) throw new Error(`manifest hash is invalid: ${file.path}`)
    if (!['mutable-entry', 'immutable-static'].includes(file.class)) throw new Error(`manifest class is invalid: ${file.path}`)
    const expectedPrefix = `/release-assets/${releaseId}/`
    const normalizedReleaseUrl = typeof file.releaseUrl === 'string'
      ? normalizeHttpPath(file.releaseUrl, `manifest release URL ${file.path}`)
      : ''
    if (!normalizedReleaseUrl.startsWith(expectedPrefix)) {
      throw new Error(`manifest release URL is not release-scoped: ${file.path}`)
    }
  }
}

function normalizeCompatibilityRequests(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`)
  const seen = new Set()
  return value.map((request, index) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error(`${label}[${index}] must be an object`)
    const id = normalizeOptionalIdentifier(request.id)
    if (!id) throw new Error(`${label}[${index}].id is required`)
    if (seen.has(id)) throw new Error(`${label} has duplicate id ${id}`)
    seen.add(id)
    const method = String(request.method ?? 'GET').toUpperCase()
    if (!/^(?:GET|HEAD|POST|PUT|PATCH|DELETE)$/u.test(method)) throw new Error(`${label}[${index}].method is invalid`)
    const expectedStatuses = request.expectedStatuses ?? [200]
    if (!Array.isArray(expectedStatuses) || expectedStatuses.length === 0
      || expectedStatuses.some(status => !Number.isSafeInteger(status) || status < 100 || status > 599)) {
      throw new Error(`${label}[${index}].expectedStatuses is invalid`)
    }
    const headers = normalizeHeaders(request.headers, `${label}[${index}].headers`)
    const expectedHeaders = normalizeHeaders(request.expectedHeaders, `${label}[${index}].expectedHeaders`)
    let body
    if (request.body !== undefined && request.body !== null) {
      if (method === 'GET' || method === 'HEAD') throw new Error(`${label}[${index}] cannot set a body for ${method}`)
      body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
    }
    const expectedSha256 = request.expectedSha256 ?? null
    if (expectedSha256 !== null && !/^sha256:[0-9a-f]{64}$/u.test(String(expectedSha256))) {
      throw new Error(`${label}[${index}].expectedSha256 is invalid`)
    }
    return {
      id,
      method,
      path: normalizeHttpPath(request.path, `${label}[${index}].path`),
      headers,
      body,
      expectedStatuses: [...new Set(expectedStatuses)],
      expectedHeaders,
      expectedSha256,
      requireReleaseHeader: request.requireReleaseHeader !== false,
      timeoutMs: request.timeoutMs === undefined
        ? null
        : boundedInteger(request.timeoutMs, 100, 120_000, `${label}[${index}].timeoutMs`)
    }
  })
}

function normalizeHeaders(value, label) {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const result = {}
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name)) throw new Error(`${label} has an invalid header name`)
    const headerValue = String(rawValue)
    if (/[\r\n]/u.test(headerValue)) throw new Error(`${label}.${name} contains a newline`)
    result[name] = headerValue
  }
  return result
}

function normalizeOptionalHttpPaths(value, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return [...new Set(value.map((item, index) => normalizeHttpPath(item, `${label}[${index}]`)))]
}

function normalizeHttpPath(value, label) {
  const candidate = String(value ?? '')
  if (!candidate.startsWith('/') || candidate.startsWith('//') || /[\r\n\0]/u.test(candidate)) {
    throw new Error(`${label} must be a same-origin absolute path`)
  }
  const parsed = new URL(candidate, 'https://probe.invalid')
  if (parsed.origin !== 'https://probe.invalid' || parsed.username || parsed.password) {
    throw new Error(`${label} must be a same-origin absolute path`)
  }
  return `${parsed.pathname}${parsed.search}`
}

function normalizeBaseUrl(value, label) {
  let parsed
  try {
    parsed = new URL(String(value ?? ''))
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an absolute HTTP(S) URL without credentials, query or fragment`)
  }
  const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !loopback && process.env.FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE !== '1') {
    throw new Error(`${label} must use HTTPS except for loopback or an explicit local rehearsal`)
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '') || '/'
  return parsed.href
}

function normalizeOptionalIdentifier(value) {
  if (value === undefined || value === null || value === '') return null
  const candidate = String(value)
  if (!/^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/u.test(candidate)) throw new Error('identifier is invalid')
  return candidate
}

function resolveSameOrigin(baseUrl, requestPath) {
  const base = new URL(baseUrl)
  const resolved = new URL(normalizeHttpPath(requestPath, 'request path'), base)
  if (resolved.origin !== base.origin) throw new Error('request escaped configured origin')
  return resolved.href
}

function resolveReference(reference, indexPath) {
  const base = new URL(indexPath, 'https://probe.invalid')
  const resolved = new URL(reference, base)
  if (resolved.origin !== base.origin) return resolved.href
  return `${resolved.pathname}${resolved.search}`
}

function normalizeComparablePath(value) {
  try {
    const url = new URL(value, 'https://probe.invalid')
    return url.origin === 'https://probe.invalid' ? `${url.pathname}${url.search}` : url.href
  } catch {
    return String(value)
  }
}

function normalizeComparablePathWithoutSearch(value) {
  try {
    const url = new URL(value, 'https://probe.invalid')
    return url.origin === 'https://probe.invalid' ? url.pathname : `${url.origin}${url.pathname}`
  } catch {
    return String(value).split('?')[0]
  }
}

function selectEvidenceHeaders(headers) {
  const selected = {}
  for (const name of [
    'cache-control',
    'content-encoding',
    'content-type',
    'etag',
    'x-fsus-frame-encoding',
    'x-fsus-release-id',
    'x-fsus-release-slot'
  ]) {
    const value = headers.get(name)
    if (value !== null) selected[name] = value
  }
  return selected
}

function assetKind(file) {
  const pathname = new URL(String(file), 'https://probe.invalid').pathname
  return ASSET_KIND_BY_EXTENSION.get(path.posix.extname(pathname).toLowerCase()) ?? null
}

function assetObservation(file, result, phase) {
  return {
    phase,
    path: file.path,
    releaseUrl: file.releaseUrl,
    kind: file.kind,
    expectedSha256: file.sha256,
    sha256: result.sha256,
    hashMatches: result.hashMatches,
    httpStatus: result.httpStatus,
    bytes: result.bytes,
    frontendBuildId: result.frontendBuildId,
    status: result.ok ? 'pass' : 'fail',
    error: result.error
  }
}

function observation(result, phase, requestPath) {
  return {
    phase,
    requestPath,
    httpStatus: result.httpStatus,
    contentType: result.contentType,
    expectedSha256: result.expectedSha256,
    sha256: result.sha256,
    hashMatches: result.hashMatches,
    bytes: result.bytes,
    status: result.ok ? 'pass' : 'fail',
    error: result.error
  }
}

function resultErrors(result) {
  return Array.isArray(result.errors) ? result.errors : [`${result.label} failed`]
}

function scenarioStatus(pass) {
  return pass ? 'pass' : 'fail'
}

function isNormalizedScenario(value) {
  return value?.schema === ASSET_COMPATIBILITY_SCENARIO_SCHEMA
    && typeof value.oldFrontendBaseUrl === 'string'
    && typeof value.browser?.required === 'boolean'
    && Array.isArray(value.compatibilityRequests?.oldFrontendToNewBackend)
    && typeof value.compatibilityRequests.oldFrontendToNewBackend[0]?.requireReleaseHeader === 'boolean'
}

function buildEarlyFailure(scenario, checkpoint, startedAtUtc, completedAtUtc, rolloutId = null) {
  return {
    schema: ASSET_COMPATIBILITY_EVIDENCE_SCHEMA,
    status: 'fail',
    rolloutId,
    drillId: scenario.drillId,
    sourceReleaseId: scenario.oldReleaseId,
    targetReleaseId: scenario.newReleaseId,
    startedAtUtc,
    checkpointCapturedAtUtc: checkpoint.capturedAtUtc,
    switchObservedAtUtc: null,
    gcObservedAtUtc: null,
    completedAtUtc,
    assetCount: checkpoint.assets.length,
    requiredAssetKinds: scenario.requiredAssetKinds,
    assetKindCoverage: checkpoint.coverage,
    notFoundCount: checkpoint.assets.filter(item => item.httpStatus === 404).length
      + (checkpoint.index.httpStatus === 404 ? 1 : 0)
      + (checkpoint.serviceWorker.script.httpStatus === 404 ? 1 : 0),
    hashMismatchCount: checkpoint.assets.filter(item => item.hashMatches === false).length
      + (checkpoint.index.hashMatches === false ? 1 : 0),
    connectionErrorCount: checkpoint.assets.filter(item => item.error !== null).length
      + (checkpoint.index.error !== null ? 1 : 0)
      + (checkpoint.serviceWorker.script.error !== null ? 1 : 0),
    scenarios: {
      delayedOldAssets: 'fail',
      oldFrontendToNewBackend: 'fail',
      newFrontendToOldBackend: 'fail',
      oldServiceWorkerCache: 'fail',
      retentionWindowAfterGc: 'fail'
    },
    checkpoint,
    afterSwitch: null,
    compatibility: null,
    retention: null,
    afterGc: null,
    errors: checkpoint.errors
  }
}

function boundedInteger(value, minimum, maximum, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} is invalid`)
  return parsed
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export function sealAssetBrowserEvidence(evidence, input) {
  if (!evidence?.browser || evidence.browser.schema !== 'fsusblog.release-asset-browser-evidence.v1') {
    throw new Error('controlled browser evidence is required before final binding')
  }
  const browserBindings = evidence.browser.bindings ?? {}
  for (const [name, expected] of Object.entries({
    rolloutId: evidence.rolloutId,
    sourceReleaseId: evidence.sourceReleaseId,
    targetReleaseId: evidence.targetReleaseId,
    scenarioSha256: input.scenarioSha256,
    manifestSha256: evidence.checkpoint?.manifest?.sha256
  })) {
    if (browserBindings[name] !== expected) throw new Error(`controlled browser ${name} binding mismatch`)
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(String(browserBindings.gcEvidenceSha256 ?? ''))) {
    throw new Error('controlled browser GC evidence binding is missing')
  }
  const payloadSha256 = sha256Buffer(Buffer.from(canonicalJson(evidence)))
  const binding = {
    schema: ASSET_BROWSER_BINDING_SCHEMA,
    algorithm: 'hmac-sha256',
    keyId: hmacSha256(input.key, 'fsusblog.release-asset-browser-key-id.v1'),
    rolloutId: evidence.rolloutId,
    sourceReleaseId: evidence.sourceReleaseId,
    targetReleaseId: evidence.targetReleaseId,
    browserName: evidence.browser.browser.name,
    browserVersion: evidence.browser.browser.version,
    browserExecutablePath: evidence.browser.browser.executablePath,
    browserExecutableSha256: evidence.browser.browser.executableSha256,
    scenarioSha256: input.scenarioSha256,
    manifestSha256: evidence.checkpoint?.manifest?.sha256 ?? null,
    gcEvidenceSha256: evidence.browser.bindings.gcEvidenceSha256,
    payloadSha256,
    signature: null
  }
  for (const [name, value] of Object.entries(binding)) {
    if (name !== 'signature' && (value === null || value === undefined || value === '')) throw new Error(`browser binding ${name} is missing`)
  }
  binding.signature = hmacSha256(input.key, canonicalJson({ ...binding, signature: undefined }))
  return { ...evidence, browserBinding: binding }
}

export function verifyAssetBrowserEvidenceBinding(evidence, key) {
  const errors = []
  const binding = evidence?.browserBinding
  if (!binding || binding.schema !== ASSET_BROWSER_BINDING_SCHEMA) return { status: 'fail', errors: ['browser binding schema is missing'] }
  const unsignedEvidence = { ...evidence }
  delete unsignedEvidence.browserBinding
  const payloadSha256 = sha256Buffer(Buffer.from(canonicalJson(unsignedEvidence)))
  if (binding.payloadSha256 !== payloadSha256) errors.push('browser binding payload SHA-256 mismatch')
  const expectedFields = {
    rolloutId: evidence.rolloutId,
    sourceReleaseId: evidence.sourceReleaseId,
    targetReleaseId: evidence.targetReleaseId,
    browserName: evidence.browser?.browser?.name,
    browserVersion: evidence.browser?.browser?.version,
    browserExecutablePath: evidence.browser?.browser?.executablePath,
    browserExecutableSha256: evidence.browser?.browser?.executableSha256,
    scenarioSha256: evidence.browser?.bindings?.scenarioSha256,
    manifestSha256: evidence.checkpoint?.manifest?.sha256,
    gcEvidenceSha256: evidence.browser?.bindings?.gcEvidenceSha256
  }
  for (const [name, value] of Object.entries(expectedFields)) {
    if (binding[name] !== value) errors.push(`browser binding ${name} mismatch`)
  }
  const expectedSignature = hmacSha256(key, canonicalJson({ ...binding, signature: undefined }))
  if (!safeEqual(binding.signature, expectedSignature)) errors.push('browser binding HMAC signature mismatch')
  return { status: errors.length === 0 ? 'pass' : 'fail', errors }
}

function readBrowserBindingKey(file) {
  if (!file) throw new Error('browser.bindingKeyFile or FSUSBLOG_ASSET_BROWSER_BINDING_KEY_FILE is required')
  const resolved = path.resolve(file)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('browser binding key must be a regular non-symlink file')
  if (![0o400, 0o600].includes(stat.mode & 0o777)) throw new Error('browser binding key must have mode 0400 or 0600')
  const key = fs.readFileSync(fs.realpathSync(resolved))
  if (key.length < 32 || key.length > 4096) throw new Error('browser binding key must contain 32..4096 bytes')
  return key
}

function hmacSha256(key, value) {
  return `hmac-sha256:${crypto.createHmac('sha256', key).update(value).digest('hex')}`
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left ?? ''))
  const rightBytes = Buffer.from(String(right ?? ''))
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes)
}

function canonicalJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`invalid argument near ${name ?? '<end>'}`)
    }
    parsed[name.slice(2)] = value
  }
  for (const name of ['scenario', 'checkpoint', 'ready-file', 'switch-file', 'gc-file', 'gc-evidence', 'out']) {
    if (!parsed[name]) throw new Error(`--${name} is required`)
  }
  return {
    scenario: path.resolve(parsed.scenario),
    checkpoint: path.resolve(parsed.checkpoint),
    readyFile: path.resolve(parsed['ready-file']),
    switchFile: path.resolve(parsed['switch-file']),
    gcFile: path.resolve(parsed['gc-file']),
    gcEvidence: path.resolve(parsed['gc-evidence']),
    out: path.resolve(parsed.out),
    rolloutId: parsed['rollout-id'] === undefined
      ? null
      : normalizeOptionalIdentifier(parsed['rollout-id']),
    signalTimeoutMs: boundedInteger(parsed['signal-timeout-ms'] ?? 900_000, 100, 86_400_000, 'signal-timeout-ms'),
    signalPollMs: boundedInteger(parsed['signal-poll-ms'] ?? 100, 10, 10_000, 'signal-poll-ms')
  }
}

async function main() {
  let options
  let scenario = null
  try {
    options = parseArgs(process.argv.slice(2))
    const scenarioBytes = fs.readFileSync(options.scenario)
    const scenarioSha256 = sha256Buffer(scenarioBytes)
    scenario = normalizeAssetCompatibilityScenario(JSON.parse(scenarioBytes.toString('utf8')))
    if (!scenario.browser.required) throw new Error('CLI asset compatibility evidence requires browser.required=true')
    const bindingKey = readBrowserBindingKey(scenario.browser.bindingKeyFile)
    fs.rmSync(options.readyFile, { force: true })
    const unsignedEvidence = await runReleaseAssetCompatibilityDrill(scenario, {
      rolloutId: options.rolloutId,
      scenarioSha256,
      onCheckpoint: async checkpoint => {
        writeJsonAtomic(options.checkpoint, checkpoint)
        if (checkpoint.status === 'pass') {
          writeJsonAtomic(options.readyFile, {
            schema: ASSET_COMPATIBILITY_SIGNAL_SCHEMA,
            drillId: scenario.drillId,
            stage: 'ready',
            checkpoint: options.checkpoint,
            observedAtUtc: new Date().toISOString()
          })
        }
      },
      waitForStage: async stage => await waitForLifecycleSignal(
        stage === 'switched' ? options.switchFile : options.gcFile,
        stage,
        scenario.drillId,
        { timeoutMs: options.signalTimeoutMs, pollIntervalMs: options.signalPollMs }),
      getGcEvidence: async () => JSON.parse(fs.readFileSync(options.gcEvidence, 'utf8')),
      getGcEvidenceSha256: () => sha256Buffer(fs.readFileSync(options.gcEvidence))
    })
    const evidence = sealAssetBrowserEvidence(unsignedEvidence, { key: bindingKey, scenarioSha256 })
    const bindingVerification = verifyAssetBrowserEvidenceBinding(evidence, bindingKey)
    if (bindingVerification.status !== 'pass') throw new Error(bindingVerification.errors.join('; '))
    bindingKey.fill(0)
    writeJsonAtomic(options.out, evidence)
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
    if (evidence.status !== 'pass') process.exitCode = 1
  } catch (error) {
    const errors = [message(error)]
    const evidence = {
      schema: ASSET_COMPATIBILITY_EVIDENCE_SCHEMA,
      status: 'fail',
      rolloutId: options?.rolloutId ?? null,
      drillId: scenario?.drillId ?? null,
      sourceReleaseId: scenario?.oldReleaseId ?? null,
      targetReleaseId: scenario?.newReleaseId ?? null,
      completedAtUtc: new Date().toISOString(),
      assetCount: 0,
      notFoundCount: 0,
      hashMismatchCount: 0,
      connectionErrorCount: 0,
      scenarios: {
        delayedOldAssets: 'fail',
        oldFrontendToNewBackend: 'fail',
        newFrontendToOldBackend: 'fail',
        oldServiceWorkerCache: 'fail',
        retentionWindowAfterGc: 'fail'
      },
      errors
    }
    if (options?.out) {
      try { writeJsonAtomic(options.out, evidence) } catch { }
    }
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
    process.stderr.write(`[release-asset-compatibility-probe] fatal: ${errors[0]}\n`)
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) await main()
