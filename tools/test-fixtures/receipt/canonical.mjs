/** Canonical serialization and digests for fixture receipts (#1710). */

import { createHash } from 'node:crypto'

export function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Stable JSON: sorted object keys, array order preserved, no whitespace.
 * Matches tools/testing/fixture-catalog stableStringify so catalog digests align.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function sha256Text(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

export function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function digestCanonical(value) {
  return sha256Text(canonicalJson(value))
}

/** Body digest excludes the digest field itself. */
export function digestReceiptBody(document, digestField = 'receiptDigest') {
  if (!plainObject(document)) throw new Error('receipt body must be a plain object')
  const { [digestField]: _ignored, ...body } = document
  return digestCanonical(body)
}

export function assertDigest(value, label = 'digest') {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be sha256:<64 hex>`)
  }
  return value
}

export function freezeDeep(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeDeep(item)))
  }
  if (plainObject(value)) {
    const next = {}
    for (const key of Object.keys(value).sort()) {
      next[key] = freezeDeep(value[key])
    }
    return Object.freeze(next)
  }
  return value
}
