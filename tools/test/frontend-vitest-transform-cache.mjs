import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const frontendRoot = path.join(repositoryRoot, 'src/frontend')
const frontendRequire = createRequire(path.join(frontendRoot, 'package.json'))
const identitySchema = 'fsusblog.frontend-vitest-transform-cache-identity.v1'
const lifecycleSchema = 'fsusblog.frontend-vitest-transform-cache-lifecycle.v1'

export const transformCacheConfigFiles = [
  'src/frontend/package-lock.json',
  'src/frontend/vitest.production.config.ts',
  'src/frontend/vitest.config.ts',
  'src/frontend/vitest.property.config.ts',
  'src/frontend/vitest.model.config.ts',
  'src/frontend/vitest.perf.config.ts',
  'src/frontend/vitest.shared.mjs',
  'src/frontend/vitest.transform-cache-coverage.mjs',
  'tests/frontend/support/unit/setup.ts',
  'tests/frontend/support/unit/animationFrameEnvironment.ts',
  'tools/test/frontend-vitest-transform-cache.mjs',
  'tools/test/run-frontend-vitest-rolling-shards.mjs',
  'tools/test/run-frontend-vitest-perf-isolated.mjs'
]

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stable(entry)]))
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function digestJson(value) {
  return sha256(JSON.stringify(stable(value)))
}

function readPackageVersion(name) {
  return frontendRequire(`${name}/package.json`).version
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function fallbackSourceState(rootDir) {
  const commit = git(['rev-parse', 'HEAD'], rootDir)
  const tracked = git(['diff', '--binary', 'HEAD', '--'], rootDir)
  const untrackedNames = git(['ls-files', '--others', '--exclude-standard', '-z'], rootDir)
    .split('\0').filter(Boolean).sort()
  const untracked = untrackedNames.map((file) => ({
    file,
    digest: sha256(fs.readFileSync(path.join(rootDir, file)))
  }))
  return { commit, fingerprint: digestJson({ tracked, untracked }) }
}

export function relevantTransformEnvironment(env = process.env) {
  const fsusUiTransformKeys = new Set([
    'FSUSBLOG_USE_LOCAL_FSUSUI',
    'FSUSBLOG_LOCAL_FSUSUI_ROOT'
  ])
  return Object.fromEntries(Object.entries(env)
    .filter(([key]) => key === 'NODE_ENV'
      || key === 'VITEST_MODE'
      || key.startsWith('VITE_')
      || fsusUiTransformKeys.has(key))
    .map(([key, value]) => [key, String(value)])
    .sort(([left], [right]) => left.localeCompare(right)))
}

function digestConfigFiles(rootDir, configFiles) {
  return digestJson(configFiles.map((file) => {
    const absolute = path.resolve(rootDir, file)
    if (!fs.existsSync(absolute)) throw new Error(`Vitest transform-cache config input is missing: ${file}`)
    return { file: file.replaceAll(path.sep, '/'), digest: sha256(fs.readFileSync(absolute)) }
  }))
}

function normalizeRunId(value) {
  const normalized = String(value ?? '').trim().replace(/[^A-Za-z0-9_.-]+/gu, '-')
  if (!normalized) throw new Error('FSUSBLOG_TEST_RUN_ID is required for the run-bound Vitest transform cache')
  return normalized
}

export function buildTransformCacheIdentity({
  env = process.env,
  rootDir = repositoryRoot,
  configFiles = transformCacheConfigFiles,
  sourceCommit,
  sourceFingerprint,
  nodeVersion = process.version,
  packageVersions,
  targetIdentity = 'production:unit+property+model->perf'
} = {}) {
  let fallback
  const commit = sourceCommit ?? env.FSUSBLOG_TEST_SOURCE_COMMIT
  const fingerprint = sourceFingerprint ?? env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
  if (!commit || !fingerprint) fallback = fallbackSourceState(rootDir)
  const versions = packageVersions ?? {
    node: nodeVersion,
    vitest: readPackageVersion('vitest'),
    vite: readPackageVersion('vite')
  }
  const payload = {
    schema: identitySchema,
    source: {
      commit: String(commit || fallback.commit),
      worktreeFingerprint: String(fingerprint || fallback.fingerprint)
    },
    tools: {
      node: String(versions.node ?? nodeVersion),
      vitest: String(versions.vitest),
      vite: String(versions.vite)
    },
    configDigest: digestConfigFiles(rootDir, configFiles),
    environment: relevantTransformEnvironment(env),
    targetIdentity
  }
  return { ...payload, identityDigest: digestJson(payload) }
}

export function transformCachePaths({ env = process.env, rootDir = repositoryRoot, identity } = {}) {
  const runId = normalizeRunId(env.FSUSBLOG_TEST_RUN_ID)
  const runRoot = path.join(rootDir, '.tmp/test-runs', runId, 'frontend-vitest-transform-cache')
  return {
    runId,
    runRoot,
    cachePath: path.join(runRoot, `modules-${identity.identityDigest}`),
    identityFile: path.join(runRoot, 'identity.json'),
    lifecycleFile: path.join(runRoot, 'lifecycle.json')
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

function identityManifest(identity) {
  return {
    ...identity,
    manifestDigest: digestJson(identity)
  }
}

function validateIdentityManifest(value, expected) {
  const manifestIdentity = value && Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'manifestDigest'))
  const manifestPayload = manifestIdentity && Object.fromEntries(Object.entries(manifestIdentity)
    .filter(([key]) => key !== 'identityDigest'))
  if (!value || value.schema !== identitySchema || value.identityDigest !== expected.identityDigest
    || value.identityDigest !== digestJson(manifestPayload)
    || value.manifestDigest !== digestJson(manifestIdentity)) {
    throw new Error('Vitest transform-cache identity is missing, corrupt, or does not match this source/config/toolchain')
  }
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is missing or corrupt: ${file}`, { cause: error })
  }
}

function writeLifecycle(context, status, extra = {}) {
  atomicWriteJson(context.lifecycleFile, {
    schema: lifecycleSchema,
    runId: context.runId,
    identityDigest: context.identity.identityDigest,
    status,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    ...extra
  })
}

export function inspectTransformCache(cachePath) {
  if (!fs.existsSync(cachePath)) return { fileCount: 0, byteCount: 0 }
  let fileCount = 0
  let byteCount = 0
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) {
        fileCount += 1
        byteCount += fs.statSync(absolute).size
      }
    }
  }
  visit(cachePath)
  return { fileCount, byteCount }
}

export function prepareTransformCache(options = {}) {
  const identity = buildTransformCacheIdentity(options)
  const paths = transformCachePaths({ ...options, identity })
  fs.rmSync(paths.runRoot, { recursive: true, force: true })
  fs.mkdirSync(paths.cachePath, { recursive: true })
  const context = { ...paths, identity }
  atomicWriteJson(paths.identityFile, identityManifest(identity))
  writeLifecycle(context, 'ordinary-active', { startedAtMs: Date.now() })
  return context
}

export function transformCacheEnvironment(context) {
  return {
    FSUSBLOG_VITEST_TRANSFORM_CACHE_PATH: context.cachePath,
    FSUSBLOG_VITEST_TRANSFORM_CACHE_IDENTITY: context.identity.identityDigest
  }
}

export function sealTransformCache(context) {
  validateIdentityManifest(readJson(context.identityFile, 'Vitest transform-cache identity'), context.identity)
  const lifecycle = readJson(context.lifecycleFile, 'Vitest transform-cache lifecycle')
  if (lifecycle.status !== 'ordinary-active' || lifecycle.identityDigest !== context.identity.identityDigest) {
    throw new Error(`Vitest transform-cache cannot seal from lifecycle state ${lifecycle.status ?? 'unknown'}`)
  }
  const inventory = inspectTransformCache(context.cachePath)
  writeLifecycle(context, 'ordinary-ready', { ordinaryCompletedAtMs: Date.now(), inventory })
  return inventory
}

function isValidCacheEntry(file) {
  if (path.basename(file) === '_metadata.json') {
    try {
      const metadata = JSON.parse(fs.readFileSync(file, 'utf8'))
      return typeof metadata.lockfileHash === 'string'
    } catch {
      return false
    }
  }
  const content = fs.readFileSync(file, 'utf8')
  const marker = '\n//# vitestCache='
  const index = content.lastIndexOf(marker)
  if (index < 0) return false
  try {
    // Vitest uses its bundled `flatted` serializer. The on-disk payload is a
    // JSON array whose first object contains string references into the rest
    // of the array, rather than a plain JSON object.
    const serialized = JSON.parse(Buffer.from(content.slice(index + marker.length), 'base64').toString('utf8'))
    return Array.isArray(serialized)
      && serialized.length > 1
      && serialized[0]
      && typeof serialized[0] === 'object'
      && typeof serialized[0].id === 'string'
  } catch {
    return false
  }
}

export function repairTransformCache(cachePath) {
  let rebuiltEntries = 0
  let recreatedDirectory = false
  if (!fs.existsSync(cachePath)) {
    fs.mkdirSync(cachePath, { recursive: true })
    recreatedDirectory = true
  }
  for (const entry of fs.readdirSync(cachePath, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const absolute = path.join(cachePath, entry.name)
    if (entry.name.startsWith('.tmp-') || !isValidCacheEntry(absolute)) {
      fs.rmSync(absolute, { force: true })
      rebuiltEntries += 1
    }
  }
  return { rebuiltEntries, recreatedDirectory }
}

export function openTransformCacheForPerf(options = {}) {
  const identity = buildTransformCacheIdentity(options)
  const context = { ...transformCachePaths({ ...options, identity }), identity }
  validateIdentityManifest(readJson(context.identityFile, 'Vitest transform-cache identity'), identity)
  const lifecycle = readJson(context.lifecycleFile, 'Vitest transform-cache lifecycle')
  if (lifecycle.schema !== lifecycleSchema || lifecycle.status !== 'ordinary-ready'
    || lifecycle.identityDigest !== identity.identityDigest) {
    throw new Error(`Vitest perf cache requires a completed ordinary run; lifecycle=${lifecycle.status ?? 'invalid'}`)
  }
  const repair = repairTransformCache(context.cachePath)
  writeLifecycle(context, 'perf-active', {
    perfStartedAtMs: Date.now(),
    repair,
    inventoryBeforePerf: inspectTransformCache(context.cachePath)
  })
  return { ...context, repair }
}

export function completeTransformCache(context, timingEvidenceFile) {
  writeLifecycle(context, 'complete', {
    perfCompletedAtMs: Date.now(),
    inventory: inspectTransformCache(context.cachePath),
    timingEvidenceFile
  })
}

export function invalidateTransformCache(context, reason = 'interrupted-or-failed') {
  if (!context?.runRoot) return
  fs.rmSync(context.cachePath, { recursive: true, force: true })
  writeLifecycle(context, 'failed', { reason, invalidatedAtMs: Date.now() })
}

export const frontendVitestTransformCacheSchemas = { identitySchema, lifecycleSchema }
