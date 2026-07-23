import { createHash } from 'node:crypto'

const commitPattern = /^[0-9a-f]{40}$/u
const digestPattern = /^[0-9a-f]{64}$/u

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    )
  }
  return value
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function requireChangedCriticalSourceState(sourceState) {
  const commit = String(sourceState?.commit ?? '').trim()
  const worktreeFingerprint = String(sourceState?.worktreeFingerprint ?? '').trim()
  if (!commitPattern.test(commit)) {
    throw new Error('sourceState.commit must be a 40-character lowercase Git SHA')
  }
  if (!digestPattern.test(worktreeFingerprint)) {
    throw new Error('sourceState.worktreeFingerprint must be a SHA-256 digest')
  }
  return { commit, worktreeFingerprint }
}
