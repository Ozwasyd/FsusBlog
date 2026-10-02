import crypto from 'node:crypto'

import { FINAL_SCHEMA } from './release-rollout-evidence-constants.mjs'
import { validateCurrentRolloutEvidenceBindings } from './release-rollout-auxiliary-evidence-contract.mjs'
import {
  validateRolloutArtifacts,
  validateRolloutAuxiliary,
  validateRolloutRecoveries,
  validateRolloutStages
} from './release-rollout-evidence-sections.mjs'

/** Replay sealed rollout bytes with an explicit reader and verification time; never produce evidence. */
export function verifyReleaseRolloutEvidence(evidence, { evidencePath, readBytes, now })
{
  if (!Number.isFinite(now) || typeof readBytes !== 'function')
  {
    throw new Error('rollout verification requires explicit time and byte reader')
  }
  const snapshots = new Map()
  const bytesFor = (file) => {
    if (!snapshots.has(file)) snapshots.set(file, Buffer.from(readBytes(file)))
    return snapshots.get(file)
  }
  const readers = {
    fileMetadata(file)
    {
      const bytes = bytesFor(file)
      return { path: file, bytes: bytes.length, sha256: sha256Text(bytes) }
    },
    readJson: (file) => JSON.parse(bytesFor(file).toString('utf8'))
  }
  const errors = []
  if (evidence.schema !== FINAL_SCHEMA) errors.push(`schema must be ${FINAL_SCHEMA}`)
  validateCurrentRolloutEvidenceBindings(evidence, errors)
  if (evidence.status !== 'pass') errors.push('rollout evidence status must be pass')
  if (!Array.isArray(evidence.errors) || evidence.errors.length !== 0)
  {
    errors.push('rollout evidence errors must be empty')
  }
  validateRolloutStages(evidence, errors, readers)
  validateRolloutRecoveries(evidence, errors, readers.fileMetadata)
  validateRolloutArtifacts(evidence, errors, readers)
  validateRolloutAuxiliary(evidence, errors, readers, now)
  return {
    schema: 'fsusblog.release-rollout-evidence-verification.v1',
    status: errors.length === 0 ? 'pass' : 'fail',
    rolloutId: evidence.rolloutId ?? null,
    evidence: evidencePath,
    errors
  }
}

function sha256Text(value)
{
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}
