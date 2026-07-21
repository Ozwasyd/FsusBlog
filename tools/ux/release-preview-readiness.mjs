#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url';

import { digestDeclaredOutputs } from '../test-matrix/local-profile.mjs';
import { validateFrontendBuildStageReceiptBinding } from '../test-matrix/frontend-build-ready-marker.mjs';
import { resolveProductionBuildLayout } from '../test-matrix/production-build-layout.mjs';
import { createFrontendBuildStages } from '../frontend/build.mjs';

export const frontendBuildReadySchema = 'fsusblog.local-production.frontend-build-ready.v1';
export const releasePreviewReadySchema = 'fsusblog.release-preview-ready.v1';
export const releasePreviewReadyFileName = 'release-preview-ready.json'
export const releasePreviewHtmlCanonicalization = 'utf8-bom-crlf-trailing-newline-v1'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function requireSafeRunId(value) {
  const runId = String(value ?? '').trim()
  if (!runId || !/^[A-Za-z0-9_.-]+$/u.test(runId) || runId === '.' || runId === '..') {
    throw new Error('FSUSBLOG_TEST_RUN_ID must be a non-empty scheduler-safe identifier')
  }
  return runId
}

function requireNamespace(value) {
  const namespace = String(value ?? '').trim()
  if (!namespace || !/^[a-z0-9_.-]+$/u.test(namespace) || namespace === '.' || namespace === '..') {
    throw new Error('FSUSBLOG_TEST_NAMESPACE must be a normalized non-empty namespace')
  }
  return namespace
}

function requireBaseUrl(value, label) {
  let url
  try {
    url = new URL(String(value ?? '').trim())
  } catch {
    throw new Error(`${label} must be an absolute HTTP URL`)
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`${label} must be an origin-only HTTP URL without credentials`)
  }
  return url.origin
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} is not valid UTF-8`)
  }
}

export function canonicalizeReleasePreviewHtml(bytes, label = 'release preview HTML') {
  return `${decodeUtf8(bytes, label)
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .trimEnd()}\n`
}

export function releasePreviewReadyFile(root, runId) {
    return path.join(path.resolve(root), '.tmp/test-runs', requireSafeRunId(runId), releasePreviewReadyFileName);
}

function currentFrontendBuildStages(frontendRoot, env = process.env)
{
    const generatedOnly = env.FSUSBLOG_VALIDATE_GENERATED_ONLY === '1';
    return createFrontendBuildStages(generatedOnly ? ['--check'] : [], generatedOnly ? 'check' : 'generate', {
        frontendRoot,
        env
    });
}

function criticalFrontendBuildOutputs(layout, stages)
{
    const owned = new Set(stages.flatMap((stage) => stage.ownedOutputs));
    return [
        path.join(layout.frontendDist, 'index.html'),
        path.join(layout.frontendDist, 'server', 'public-shell-emergency.css'),
        path.join(layout.frontendDist, 'wasm'),
        path.join(layout.frontendDist, 'assets', 'fsus-spa-entry.js'),
        path.join(layout.frontendDist, 'dist'),
        path.join(layout.frontendWasm, 'wasm-manifest.aeds'),
        path.join(layout.frontendWasm, 'aeds-runtime-manifest.json'),
        layout.backendWebRoot
    ].filter((candidate) => owned.has(candidate));
}

export function validateReleasePreviewReady({ root = defaultRoot, runId, previewUrl } = {})
{
    const repositoryRoot = path.resolve(root);
    const schedulerRunId = requireSafeRunId(runId);
  const markerFile = releasePreviewReadyFile(repositoryRoot, schedulerRunId)
  let marker
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  } catch (error) {
    throw new Error(`release preview readiness marker is unreadable: ${markerFile}`, { cause: error })
  }
  if (marker.schema !== releasePreviewReadySchema
    || marker.status !== 'ready'
    || marker.schedulerRunId !== schedulerRunId) {
    throw new Error(`release preview marker identity mismatch: ${markerFile}`)
  }
  const expectedPreviewUrl = requireBaseUrl(previewUrl, 'release preview expected URL')
  const markerPreviewUrl = requireBaseUrl(marker.previewUrl, 'release preview marker previewUrl')
  if (markerPreviewUrl !== expectedPreviewUrl) {
    throw new Error(`release preview marker URL mismatch: ${markerPreviewUrl} != ${expectedPreviewUrl}`)
  }
  const backendUrl = requireBaseUrl(marker.backendUrl, 'release preview marker backendUrl')
  if (marker.servedIndex?.sourceDigestMatch !== true
    || marker.apiProbe?.namespaceBound !== true
    || marker.apiProbe?.status !== 200) {
    throw new Error(`release preview marker has incomplete served-index/API evidence: ${markerFile}`)
  }
  const distEntryPath = String(marker.distEntry?.path ?? '')
  if (!distEntryPath || path.isAbsolute(distEntryPath)
    || distEntryPath === '..' || distEntryPath.startsWith('../')) {
    throw new Error(`release preview dist entry must stay inside the repository: ${markerFile}`)
  }
  const absoluteDistEntry = path.resolve(repositoryRoot, distEntryPath)
  if (absoluteDistEntry !== repositoryRoot && !absoluteDistEntry.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error(`release preview dist entry must stay inside the repository: ${markerFile}`)
  }
  const bytes = fs.readFileSync(absoluteDistEntry)
  const actualContentDigest = sha256(bytes)
  const actualDeclaredDigest = digestDeclaredOutputs(repositoryRoot, [distEntryPath])[distEntryPath]
  if (marker.distEntry?.contentDigest !== actualContentDigest
    || marker.distEntry?.digest !== actualDeclaredDigest) {
    throw new Error(`release preview dist digest changed after readiness: ${markerFile}`)
  }
  return {
    marker,
    markerFile,
    previewUrl: markerPreviewUrl,
    backendUrl,
    distEntryPath,
    absoluteDistEntry
    };
}

export function validateFrontendBuildReady({
    root = defaultRoot,
    runId,
    expectedSourceState,
    expectedStages,
    criticalOutputPaths
} = {})
{
    const repositoryRoot = path.resolve(root);
    const schedulerRunId = requireSafeRunId(runId);
    const layout = resolveProductionBuildLayout({ root: repositoryRoot, runId: schedulerRunId });
    const resolvedExpectedStages = expectedStages ?? currentFrontendBuildStages(
        path.join(repositoryRoot, 'src/frontend')
    );
    const distEntryPath = path.relative(repositoryRoot, path.join(layout.frontendDist, 'index.html')).replaceAll(path.sep, '/');
    const frontendDistPath = path.relative(repositoryRoot, layout.frontendDist).replaceAll(path.sep, '/');
    const backendWebRootPath = path.relative(repositoryRoot, layout.backendWebRoot).replaceAll(path.sep, '/');
    const markerFile = path.join(repositoryRoot, '.tmp/test-runs', schedulerRunId, 'frontend-build-ready.json');
    if (!fs.existsSync(markerFile))
{
        throw new Error(`frontend build readiness marker is missing for scheduler run ${schedulerRunId}`);
  }

  let marker
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  } catch (error) {
    throw new Error(`frontend build readiness marker is unreadable: ${markerFile}`, { cause: error })
  }
  if (marker?.schema !== frontendBuildReadySchema
    || marker.status !== 'success'
    || marker.physicalBundleId !== 'build-static'
    || marker.producerStepId !== 'sync-static-assets'
    || marker.schedulerRunId !== schedulerRunId
    || marker.buildLayout?.sourceCommit !== expectedSourceState?.commit
    || marker.buildLayout?.sourceFingerprint !== expectedSourceState?.worktreeFingerprint
    || marker.frontendDist?.path !== frontendDistPath
    || marker.backendWebRoot?.path !== backendWebRootPath
    || marker.distEntry?.path !== distEntryPath)
{
        throw new Error(`frontend build readiness marker is not bound to current build-static run: ${schedulerRunId}`);
    }

  const absoluteDistEntry = path.join(repositoryRoot, distEntryPath)
  if (!fs.existsSync(absoluteDistEntry) || !fs.statSync(absoluteDistEntry).isFile()) {
    throw new Error(`frontend build readiness dist entry is missing: ${distEntryPath}`)
  }
  const currentDigest = digestDeclaredOutputs(repositoryRoot, [distEntryPath])[distEntryPath]
    if (!marker.distEntry.digest || marker.distEntry.digest !== currentDigest)
{
        throw new Error(`frontend build readiness dist digest does not match current ${distEntryPath}`);
    }
    const currentTreeDigests = digestDeclaredOutputs(repositoryRoot, [frontendDistPath, backendWebRootPath]);
    if (!marker.frontendDist.digest || marker.frontendDist.digest !== currentTreeDigests[frontendDistPath])
{
        throw new Error('frontend build readiness final dist tree digest mismatch');
    }
    if (!marker.backendWebRoot.digest || marker.backendWebRoot.digest !== currentTreeDigests[backendWebRootPath])
{
        throw new Error('frontend build readiness backend wwwroot tree digest mismatch');
    }
    const stageReceiptPath = path.relative(
        repositoryRoot,
        path.join(layout.generatedRoot, 'frontend-build-stages.json')
    ).replaceAll(path.sep, '/');
    validateFrontendBuildStageReceiptBinding({
        root: repositoryRoot,
        marker,
        runId: schedulerRunId,
        sourceState: expectedSourceState,
        expectedPath: stageReceiptPath,
        expectedStages: resolvedExpectedStages,
        stageCwd: path.join(repositoryRoot, 'src/frontend'),
        criticalOutputPaths: criticalOutputPaths ?? criticalFrontendBuildOutputs(layout, resolvedExpectedStages)
    });
    return {
        marker,
        markerFile,
    schedulerRunId,
    distEntryPath,
    absoluteDistEntry,
    distDigest: currentDigest
  }
}

async function fetchBody(url, { accept, fetchImpl, label }) {
  const response = await fetchImpl(url, {
    cache: 'no-store',
    headers: {
      accept,
      'cache-control': 'no-cache, no-store',
      pragma: 'no-cache'
    },
    redirect: 'error',
    signal: AbortSignal.timeout(5_000)
  })
  const body = Buffer.from(await response.arrayBuffer())
  if (response.status !== 200 || body.length === 0) {
    throw new Error(`${label} returned status=${response.status} bytes=${body.length}`)
  }
  return {
    body,
    contentType: response.headers.get('content-type') ?? '',
    status: response.status
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}-${randomUUID()}`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

export async function publishReleasePreviewReady({
  root = defaultRoot,
  runId,
    namespace,
    previewUrl,
    backendUrl,
    expectedSourceState,
    expectedStages,
    criticalOutputPaths,
    fetchImpl = globalThis.fetch,
    generatedAt = new Date().toISOString()
} = {})
{
    if (typeof fetchImpl !== 'function') {throw new Error('fetch implementation is required')};
    const markerFile = releasePreviewReadyFile(root, runId);
    fs.rmSync(markerFile, { force: true });
    const build = validateFrontendBuildReady({
        root,
        runId,
        expectedSourceState,
        expectedStages,
        criticalOutputPaths
    });
    const normalizedNamespace = requireNamespace(namespace);
    const normalizedPreviewUrl = requireBaseUrl(previewUrl, 'FSUSBLOG_RELEASE_PREVIEW_URL');
    const normalizedBackendUrl = requireBaseUrl(backendUrl, 'FSUSBLOG_DEBUG_BACKEND_URL');
  if (normalizedPreviewUrl === normalizedBackendUrl) {
    throw new Error('release preview and backend URLs must use distinct origins')
  }

  const cacheKey = encodeURIComponent(`${build.schedulerRunId}-${build.distDigest}`)
  const servedIndexUrl = `${normalizedPreviewUrl}/?fsus-preview-proof=${cacheKey}`
  const previewApiUrl = `${normalizedPreviewUrl}/api/binary/system/seo`
  const backendApiUrl = `${normalizedBackendUrl}/api/binary/system/seo`
  const [servedIndex, previewApi, backendApi] = await Promise.all([
    fetchBody(servedIndexUrl, { accept: 'text/html', fetchImpl, label: 'release preview index' }),
    fetchBody(previewApiUrl, { accept: 'application/octet-stream', fetchImpl, label: 'release preview API probe' }),
    fetchBody(backendApiUrl, { accept: 'application/octet-stream', fetchImpl, label: 'namespace backend API probe' })
  ])
  if (!servedIndex.contentType.toLowerCase().includes('text/html')) {
    throw new Error(`release preview index returned unexpected content-type: ${servedIndex.contentType || '<missing>'}`)
  }

  const distBytes = fs.readFileSync(build.absoluteDistEntry)
  const distNormalized = canonicalizeReleasePreviewHtml(distBytes, 'dist index')
  const servedNormalized = canonicalizeReleasePreviewHtml(servedIndex.body, 'served index')
  const distNormalizedDigest = sha256(distNormalized)
  const servedNormalizedDigest = sha256(servedNormalized)
  const sourceDigestMatch = servedNormalizedDigest === distNormalizedDigest
  if (!sourceDigestMatch) {
    throw new Error('release preview served index is not derived from the current run-bound dist index')
  }

  const previewApiDigest = sha256(previewApi.body)
  const backendApiDigest = sha256(backendApi.body)
  const namespaceBound = previewApiDigest === backendApiDigest
  if (!namespaceBound) {
    throw new Error('release preview API probe does not match the current namespace backend')
  }

  const marker = {
    schema: releasePreviewReadySchema,
    status: 'ready',
    schedulerRunId: build.schedulerRunId,
    namespace: normalizedNamespace,
    previewUrl: normalizedPreviewUrl,
    backendUrl: normalizedBackendUrl,
    distEntry: {
      path: build.distEntryPath,
      digest: build.distDigest,
      contentDigest: sha256(distBytes),
      normalizedDigest: distNormalizedDigest
    },
    servedIndex: {
      url: servedIndexUrl,
      status: servedIndex.status,
      contentType: servedIndex.contentType,
      contentDigest: sha256(servedIndex.body),
      normalizedDigest: servedNormalizedDigest,
      canonicalization: releasePreviewHtmlCanonicalization,
      sourceDigestMatch
    },
    apiProbe: {
      url: previewApiUrl,
      backendUrl: backendApiUrl,
      status: previewApi.status,
      backendStatus: backendApi.status,
      contentDigest: previewApiDigest,
      backendContentDigest: backendApiDigest,
      namespaceBound
    },
    generatedAt
  }
  writeJsonAtomic(markerFile, marker)
  return { marker, markerFile }
}

async function main() {
    const action = process.argv[2];
    const options = {
        root: process.env.FSUSBLOG_REPOSITORY_ROOT || defaultRoot,
        runId: process.env.FSUSBLOG_TEST_RUN_ID,
        expectedSourceState: {
            commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
            worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
        }
    };
    if (action === 'validate-build')
{
        const result = validateFrontendBuildReady(options);
    process.stdout.write(`[release-preview-ready] verified build run=${result.schedulerRunId} digest=${result.distDigest}\n`)
    return
  }
  if (action === 'publish-ready') {
    const result = await publishReleasePreviewReady({
      ...options,
      namespace: process.env.FSUSBLOG_TEST_NAMESPACE,
      previewUrl: process.env.FSUSBLOG_RELEASE_PREVIEW_URL,
      backendUrl: process.env.FSUSBLOG_DEBUG_BACKEND_URL
    })
    process.stdout.write(`[release-preview-ready] published ${path.relative(options.root, result.markerFile)}\n`)
    return
  }
  throw new Error('usage: release-preview-readiness.mjs <validate-build|publish-ready>')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main()
}
