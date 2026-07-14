import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const runBoundMarkerSchema = 'fsusblog.local-production.run-bound-marker.v1'

function requiredText(value, label) {
  const normalized = String(value ?? '').trim()
  if (!normalized) throw new Error(`${label} must be non-empty`)
  return normalized
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

function digest(value) {
  return crypto.createHash('sha256').update(
    Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))
  ).digest('hex')
}

function normalizeSourceState(sourceState) {
  return {
    commit: requiredText(sourceState?.commit, 'sourceState.commit'),
    worktreeFingerprint: requiredText(sourceState?.worktreeFingerprint, 'sourceState.worktreeFingerprint')
  }
}

function artifactEvidence(root, artifact) {
  const absolute = path.resolve(root, artifact)
  const relative = path.relative(path.resolve(root), absolute).replaceAll(path.sep, '/')
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`marker artifact escapes repository root: ${artifact}`)
  }
  const stat = fs.statSync(absolute)
  if (!stat.isFile()) throw new Error(`marker artifact must be a file: ${relative}`)
  return { path: relative, bytes: stat.size, sha256: digest(fs.readFileSync(absolute)) }
}

export function publishRunBoundMarker({
  file,
  root,
  markerId,
  runId,
  sourceState,
  producerBundleId,
  producerStepId,
  artifacts = [],
  generatedAt = new Date().toISOString()
}) {
  const marker = {
    schema: runBoundMarkerSchema,
    status: 'success',
    markerId: requiredText(markerId, 'markerId'),
    runId: requiredText(runId, 'runId'),
    sourceState: normalizeSourceState(sourceState),
    producer: {
      bundleId: requiredText(producerBundleId, 'producerBundleId'),
      stepId: requiredText(producerStepId, 'producerStepId')
    },
    artifacts: artifacts.map((artifact) => artifactEvidence(root, artifact)),
    generatedAt: requiredText(generatedAt, 'generatedAt')
  }
  const signed = { ...marker, digest: digest(marker) }
  const absolute = path.resolve(file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const temporary = `${absolute}.next-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(signed, null, 2)}\n`)
  fs.renameSync(temporary, absolute)
  return signed
}

export function validateRunBoundMarker(marker, {
  root,
  markerId,
  runId,
  sourceState,
  producerBundleId,
  producerStepId
}) {
  if (marker?.schema !== runBoundMarkerSchema || marker?.status !== 'success') {
    throw new Error('run-bound marker schema/status mismatch')
  }
  const expectedSource = normalizeSourceState(sourceState)
  if (marker.markerId !== markerId) throw new Error('run-bound marker identity mismatch')
  if (marker.runId !== runId) throw new Error('run-bound marker belongs to another run')
  if (marker.sourceState?.commit !== expectedSource.commit
    || marker.sourceState?.worktreeFingerprint !== expectedSource.worktreeFingerprint) {
    throw new Error('run-bound marker belongs to another source state')
  }
  if (marker.producer?.bundleId !== producerBundleId || marker.producer?.stepId !== producerStepId) {
    throw new Error('run-bound marker producer mismatch')
  }
  const { digest: markerDigest, ...unsigned } = marker
  if (markerDigest !== digest(unsigned)) throw new Error('run-bound marker digest mismatch')
  if (!Array.isArray(marker.artifacts)) throw new Error('run-bound marker artifacts must be an array')
  for (const artifact of marker.artifacts) {
    const observed = artifactEvidence(root, artifact?.path)
    if (artifact.path !== observed.path || artifact.bytes !== observed.bytes || artifact.sha256 !== observed.sha256) {
      throw new Error(`run-bound marker artifact changed: ${artifact?.path ?? '<unknown>'}`)
    }
  }
  return marker
}

export function readRunBoundMarker(file, expected) {
  let marker
  try {
    marker = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
  } catch (error) {
    throw new Error(`run-bound marker is unreadable: ${file}`, { cause: error })
  }
  return validateRunBoundMarker(marker, expected)
}

export async function waitForRunBoundMarker({
  file,
  expected,
  timeoutMs,
  pollIntervalMs = 100,
  signal,
  producerFailure
}) {
  const normalizedTimeoutMs = Number(timeoutMs)
  if (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0) {
    throw new Error('run-bound marker timeoutMs must be positive')
  }
  const deadline = Date.now() + normalizedTimeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`cancelled waiting for run-bound marker: ${expected.markerId}`)
    const failure = await producerFailure?.()
    if (failure) throw new Error(`producer failed before run-bound marker ${expected.markerId}: ${failure}`)
    if (fs.existsSync(path.resolve(file))) return readRunBoundMarker(file, expected)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error(`cancelled waiting for run-bound marker: ${expected.markerId}`))
      }, { once: true })
    })
  }
  throw new Error(`timed out waiting for run-bound marker: ${expected.markerId}`)
}
