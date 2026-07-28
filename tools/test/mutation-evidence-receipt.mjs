/**
 * Mutation evidence receipt schema and sealing.
 *
 * A mutation evidence receipt is a sealed public receipt that records
 * per-behavior mutant attribution and qualification results.
 * It is consumed by the BehaviorGraph join as an optional input.
 */
import { createHash } from 'node:crypto'

export const mutationEvidenceSchema = 'fsusblog.mutation-evidence-receipt.v1'

const digestPattern = /^[a-f0-9]{64}$/u

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

export function digestValue(value) {
  return createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex')
}

/**
 * Seal a mutation evidence receipt from attribution and qualification results.
 *
 * @param {object} options
 * @param {string} options.sourceCommit - 40-char git SHA
 * @param {string} options.worktreeFingerprint - SHA-256 worktree fingerprint
 * @param {string} options.catalogDigest - BehaviorCatalog digest
 * @param {string} options.selectionDigest - Mutation selection closure digest
 * @param {string} options.ownerReceiptDigest - ImplementationOwner receipt digest
 * @param {string} options.testBindingScanDigest - BehaviorTestBinding scan digest
 * @param {string} options.rawReportDigest - Digest of the Stryker raw report set
 * @param {string} options.rawTraceDigest - Digest of the Stryker trace set
 * @param {object[]} options.attributions - Per-mutant attributions
 * @param {object[]} options.qualifications - Per-behavior qualifications
 * @param {number} options.blockedCount - Number of blocked (ambiguous) mutants
 * @param {string} options.status - 'ok' or 'failed'
 * @param {string[]} options.failureReasons
 */
export function sealMutationEvidenceReceipt({
  sourceCommit,
  worktreeFingerprint,
  catalogDigest,
  selectionDigest,
  ownerReceiptDigest,
  testBindingScanDigest,
  rawReportDigest,
  rawTraceDigest,
  attributions = [],
  qualifications = [],
  blockedCount = 0,
  status,
  failureReasons = []
}) {
  if (status !== 'ok' && status !== 'failed') {
    throw new Error('[mutation-evidence] status must be ok or failed')
  }
  for (const [label, value] of Object.entries({
    catalogDigest,
    selectionDigest,
    ownerReceiptDigest,
    testBindingScanDigest,
    rawReportDigest,
    rawTraceDigest
  })) {
    if (!digestPattern.test(String(value ?? ''))) {
      throw new Error(`[mutation-evidence] ${label} must be a SHA-256 digest`)
    }
  }
  if (status === 'ok' && failureReasons.length !== 0) {
    throw new Error('[mutation-evidence] status=ok cannot include failureReasons')
  }
  if (status === 'failed' && failureReasons.length === 0) {
    throw new Error('[mutation-evidence] status=failed requires failureReasons')
  }

  const payload = {
    schema: mutationEvidenceSchema,
    sourceCommit,
    worktreeFingerprint: worktreeFingerprint.replace(/^sha256:/u, ''),
    catalogDigest,
    selectionDigest,
    ownerReceiptDigest,
    testBindingScanDigest,
    rawReportDigest,
    rawTraceDigest,
    attributions: [...attributions]
      .map((a) => ({
        mutantId: a.mutantId,
        behaviorId: a.behaviorId,
        sourcePath: a.sourcePath,
        symbol: a.symbol,
        mutator: a.mutator,
        status: a.status,
        coveredTestIds: [...(a.coveredTestIds ?? [])].sort(),
        killedTestIds: [...(a.killedTestIds ?? [])].sort()
      }))
      .sort((left, right) => left.mutantId.localeCompare(right.mutantId)),
    qualifications: [...qualifications]
      .map((q) => ({
        behaviorId: q.behaviorId,
        mutationRequired: q.mutationRequired,
        executed: q.executed,
        killed: q.killed,
        survived: q.survived,
        timeout: q.timeout,
        noCoverage: q.noCoverage,
        score: q.score,
        minimumMutationScore: q.minimumMutationScore,
        qualified: q.qualified,
        failures: [...(q.failures ?? [])].sort()
      }))
      .sort((left, right) => left.behaviorId.localeCompare(right.behaviorId)),
    blockedCount,
    status,
    failureReasons: [...failureReasons].sort()
  }

  payload.contentDigest = digestValue(payload)
  return payload
}
