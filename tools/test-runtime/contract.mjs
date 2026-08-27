import { createHmac, randomBytes } from 'node:crypto'

import {
  assertDigest,
  canonicalJson,
  digestCanonical,
  freezeDeep,
  plainObject,
  sha256Bytes
} from '../test-fixtures/receipt/canonical.mjs'

export const runtimeDigestPattern = /^sha256:[0-9a-f]{64}$/u
export const runtimeBoundaries = new Set([
  'before-runtime',
  'before-mutating-step',
  'after-mutating-step',
  'after-runtime'
])

export function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

export function requireSafeId(value, label) {
  const text = requireText(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(text)) throw new Error(`${label} is not a safe identity`)
  return text
}

export function requireDigest(value, label) {
  return assertDigest(requireText(value, label), label)
}

export function requireExactKeys(value, keys, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields must be exact: expected ${expected.join(', ')}`)
  }
  return value
}

export function sortedUniqueStrings(values, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`)
  const normalized = values.map((item) => requireText(item, label))
  const sorted = [...new Set(normalized)].sort()
  if ((!allowEmpty && sorted.length === 0) || JSON.stringify(sorted) !== JSON.stringify(normalized)) {
    throw new Error(`${label} must be ${allowEmpty ? '' : 'non-empty, '}sorted and unique`)
  }
  return Object.freeze(sorted)
}

function normalizeNumber(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`)
  if (Object.is(value, -0)) return 0
  return value
}

/**
 * Runtime semantic values are deliberately narrower than arbitrary JSON.
 * Undefined, sparse arrays, non-finite numbers and non-plain objects are
 * rejected so two observers cannot silently serialize the same state in
 * incompatible ways.
 */
export function normalizeSemantic(value, label = 'semantic state') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return normalizeNumber(value, label)
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return freezeDeep({ byteLength: value.byteLength, contentDigest: sha256Bytes(value) })
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error(`${label} must not be sparse`)
    return Object.freeze(value.map((item, index) => normalizeSemantic(item, `${label}[${index}]`)))
  }
  if (!plainObject(value)) throw new Error(`${label} contains an unsupported value`)
  const normalized = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new Error(`${label}.${key} must distinguish absent from null`)
    normalized[key] = normalizeSemantic(value[key], `${label}.${key}`)
  }
  return freezeDeep(normalized)
}

export function semanticDigest(value) {
  return digestCanonical(normalizeSemantic(value))
}

export function sealDocument(body, digestField = 'contentDigest') {
  if (!plainObject(body) || Object.hasOwn(body, digestField)) throw new Error('sealDocument requires an unsealed body')
  return freezeDeep({ ...body, [digestField]: digestCanonical(body) })
}

export function verifySealedDocument(document, digestField = 'contentDigest') {
  if (!plainObject(document)) throw new Error('sealed document must be an object')
  const digest = requireDigest(document[digestField], digestField)
  const { [digestField]: _ignored, ...body } = document
  if (digestCanonical(body) !== digest) throw new Error(`${digestField} mismatch (tampered or non-canonical)`)
  return document
}

export function normalizeRuntimeIdentity(identity, { requireSession = true } = {}) {
  if (!plainObject(identity)) throw new Error('runtime identity is required')
  const normalized = {
    runId: requireSafeId(identity.runId, 'runId'),
    attemptId: requireSafeId(identity.attemptId, 'attemptId'),
    sourceCommit: requireText(identity.sourceCommit, 'sourceCommit'),
    sourceFingerprint: requireDigest(identity.sourceFingerprint, 'sourceFingerprint'),
    buildReceiptDigest: requireDigest(identity.buildReceiptDigest, 'buildReceiptDigest'),
    fixtureDigest: requireDigest(identity.fixtureDigest, 'fixtureDigest'),
    envelopeDigest: requireDigest(identity.envelopeDigest, 'envelopeDigest'),
    clockDigest: requireDigest(identity.clockDigest, 'clockDigest'),
    replayDigest: requireDigest(identity.replayDigest, 'replayDigest'),
    catalogDigest: requireDigest(identity.catalogDigest, 'catalogDigest'),
    sessionId: requireSession ? requireSafeId(identity.sessionId, 'sessionId') : null
  }
  if (!/^[0-9a-f]{40}$/u.test(normalized.sourceCommit)) throw new Error('sourceCommit must be a full commit SHA')
  return freezeDeep(normalized)
}

export function assertSameRuntimeIdentity(left, right, label = 'runtime identity') {
  const expected = normalizeRuntimeIdentity(left)
  const actual = normalizeRuntimeIdentity(right)
  if (canonicalJson(expected) !== canonicalJson(actual)) throw new Error(`${label} is stale or cross-session`)
  return actual
}

export function createProtectedFingerprint({ key = randomBytes(32), scopeId, secretClass, value }) {
  const scope = requireSafeId(scopeId, 'fingerprint scopeId')
  const type = requireSafeId(secretClass, 'secretClass')
  if (!Buffer.isBuffer(key) && !(key instanceof Uint8Array)) throw new Error('fingerprint key must be protected bytes')
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : Buffer.from(String(value), 'utf8')
  const fingerprint = `hmac-sha256:${createHmac('sha256', key)
    .update(`fsusblog-runtime-state\0${scope}\0${type}\0`, 'utf8')
    .update(bytes)
    .digest('hex')}`
  return freezeDeep({ secretClass: type, present: true, lengthClass: lengthClass(bytes.length), fingerprint })
}

export function lengthClass(length) {
  if (length === 0) return 'empty'
  if (length <= 16) return 'short'
  if (length <= 64) return 'medium'
  if (length <= 256) return 'long'
  return 'very-long'
}
