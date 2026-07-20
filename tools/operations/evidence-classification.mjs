import { isValidReleaseId } from '../release/release-id.mjs'

const EVIDENCE_CLASSES = new Set([
  'contract',
  'fixture',
  'implementation-attestation',
  'historical-report',
  'fresh-run-evidence',
  'release-closeout-evidence'
])

const STATIC_CLASSES = new Set([
  'contract',
  'fixture',
  'implementation-attestation',
  'historical-report'
])

export function evidenceClassificationErrors(value, expectedClass = null) {
  const errors = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['evidence document must be a JSON object']
  }

  if (!EVIDENCE_CLASSES.has(value.evidenceClass)) {
    errors.push(`unsupported evidenceClass: ${String(value.evidenceClass)}`)
  }
  if (expectedClass && value.evidenceClass !== expectedClass) {
    errors.push(`evidenceClass must be ${expectedClass}, got ${String(value.evidenceClass)}`)
  }
  for (const field of ['freshExecution', 'releaseBound', 'productionFreshRun']) {
    if (typeof value[field] !== 'boolean') errors.push(`${field} must be boolean`)
  }
  if (!value.generatedFrom || typeof value.generatedFrom !== 'object' || Array.isArray(value.generatedFrom)) {
    errors.push('generatedFrom must be an object')
  } else {
    for (const field of ['kind', 'source']) {
      if (typeof value.generatedFrom[field] !== 'string' || value.generatedFrom[field].trim() === '') {
        errors.push(`generatedFrom.${field} must be a non-empty string`)
      }
    }
  }

  if (STATIC_CLASSES.has(value.evidenceClass)) {
    if (value.freshExecution !== false) errors.push(`${value.evidenceClass} cannot claim freshExecution`)
    if (value.releaseBound !== false) errors.push(`${value.evidenceClass} cannot claim releaseBound`)
    if (value.productionFreshRun !== false) errors.push(`${value.evidenceClass} cannot claim productionFreshRun`)
  }

  if (value.evidenceClass === 'release-closeout-evidence') {
    if (value.freshExecution !== true) errors.push('release-closeout-evidence requires freshExecution')
    if (value.releaseBound !== true) errors.push('release-closeout-evidence requires releaseBound')
    if (value.productionFreshRun !== true) errors.push('release-closeout-evidence requires productionFreshRun')
    if (!isValidReleaseId(value.releaseId, { forPublication: true })) {
      errors.push('release-closeout-evidence requires a valid releaseId')
    }
    if (!/^[0-9a-f]{40}$/u.test(String(value.commitSha ?? ''))) {
      errors.push('release-closeout-evidence requires a full commitSha')
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(value.imageDigest ?? ''))) {
      errors.push('release-closeout-evidence requires an immutable imageDigest')
    }
  }

  return errors
}

export function assertEvidenceClassification(value, expectedClass, label = 'evidence') {
  const errors = evidenceClassificationErrors(value, expectedClass)
  if (errors.length > 0) throw new Error(`${label}: ${errors.join('; ')}`)
  return value
}

export { EVIDENCE_CLASSES, STATIC_CLASSES }
