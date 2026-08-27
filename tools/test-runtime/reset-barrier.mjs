import { digestCanonical, freezeDeep, plainObject } from '../test-fixtures/receipt/canonical.mjs'
import {
  normalizeRuntimeIdentity,
  requireDigest,
  requireSafeId,
  requireText,
  sealDocument,
  verifySealedDocument
} from './contract.mjs'
import { validateRuntimeStateSnapshot } from './state-snapshot.mjs'

export const runtimeResetBarrierReceiptSchema = 'fsusblog.runtime-reset-barrier.v1'

const mutatingFields = ['writes', 'creates', 'deletes', 'invalidates']

export function resetAffectedDomains(authority, reset) {
  const producer = authority?.steps?.[reset?.producer]
  if (!producer) throw new Error(`reset producer is absent from the runtime state catalog: ${reset?.producer ?? '<missing>'}`)
  const domains = [...new Set(mutatingFields.flatMap((field) => producer[field] ?? []))].sort()
  if (domains.length === 0) throw new Error(`reset producer ${producer.stepId} has no catalog-declared affected domain`)
  return domains
}

function stepDomains(authority, stepId) {
  const entry = authority?.steps?.[stepId]
  if (!entry) throw new Error(`runtime step is absent from the state catalog: ${stepId}`)
  return new Set(['reads', ...mutatingFields, 'exclusiveStateDomains'].flatMap((field) => entry[field] ?? []))
}

export class RuntimeResetBarrierManager {
  #authority
  #identity
  #active = new Map()
  #failed = new Map()
  #generation = new Map()

  constructor({ authority, identity }) {
    this.#authority = authority
    this.#identity = normalizeRuntimeIdentity(identity)
    if (this.#identity.catalogDigest !== authority?.catalogDigest) throw new Error('reset barrier catalog identity drifted')
  }

  checkAdmission(stepId) {
    const domains = stepDomains(this.#authority, stepId)
    const blocked = []
    for (const [barrierId, barrier] of this.#active) {
      const intersections = barrier.domains.filter((domain) => domains.has(domain))
      for (const domain of intersections) blocked.push({ barrierId, domain, state: 'active' })
    }
    for (const [barrierId, barrier] of this.#failed) {
      const intersections = barrier.domains.filter((domain) => domains.has(domain))
      for (const domain of intersections) blocked.push({ barrierId, domain, state: 'failed' })
    }
    return freezeDeep({ admitted: blocked.length === 0, blocked })
  }

  begin({ consumerStepId, phase, reset }) {
    if (!['resetBefore', 'resetAfter'].includes(phase)) throw new Error('reset barrier phase is invalid')
    const consumer = this.#authority.steps?.[consumerStepId]
    if (!consumer || !(consumer[phase] ?? []).some((entry) => digestCanonical(entry) === digestCanonical(reset))) {
      throw new Error(`reset barrier is not declared by ${consumerStepId}.${phase}`)
    }
    const domains = resetAffectedDomains(this.#authority, reset)
    const barrierId = `${consumerStepId}-${phase}-${reset.producer}-${reset.assertionId}`
    if (this.#active.has(barrierId) || this.#failed.has(barrierId)) throw new Error(`reset barrier cannot be reused: ${barrierId}`)
    const barrier = freezeDeep({
      barrierId,
      consumerStepId,
      phase,
      producerStepId: reset.producer,
      assertionId: reset.assertionId,
      expectedPostcondition: reset.postcondition,
      receiptSchema: reset.receiptSchema,
      domains
    })
    this.#active.set(barrierId, barrier)
    return barrier
  }

  complete(barrier, { processReceipt, beforeCapture, afterCapture, postconditionResults }) {
    const active = this.#active.get(barrier.barrierId)
    if (!active || digestCanonical(active) !== digestCanonical(barrier)) throw new Error('reset barrier is stale or cross-session')
    if (!plainObject(processReceipt) || processReceipt.exitCode !== 0 || processReceipt.signal != null
      || processReceipt.timedOut === true || processReceipt.cancelled === true
      || !processReceipt.contentDigest) {
      return this.fail(barrier, 'reset command did not exit successfully', { processReceipt })
    }
    requireDigest(processReceipt.contentDigest, 'reset process receipt digest')
    const beforeSnapshot = beforeCapture?.snapshot
    const afterSnapshot = afterCapture?.snapshot
    validateRuntimeStateSnapshot(beforeSnapshot, {
      authority: this.#authority,
      identity: this.#identity,
      fragments: beforeCapture?.fragments
    })
    validateRuntimeStateSnapshot(afterSnapshot, {
      authority: this.#authority,
      identity: this.#identity,
      fragments: afterCapture?.fragments
    })
    if (beforeSnapshot.boundary !== 'before-mutating-step' || afterSnapshot.boundary !== 'after-mutating-step'
      || beforeSnapshot.stepId !== barrier.producerStepId || afterSnapshot.stepId !== barrier.producerStepId) {
      return this.fail(barrier, 'reset snapshots do not bind the producer boundaries', { beforeSnapshot, afterSnapshot })
    }
    const resultByDomain = new Map((postconditionResults ?? []).map((result) => [result.domain, result]))
    if (resultByDomain.size !== barrier.domains.length) return this.fail(barrier, 'reset postconditions do not exactly cover affected domains', { postconditionResults })
    for (const domain of barrier.domains) {
      const result = resultByDomain.get(domain)
      if (!result || result.status !== 'satisfied' || !result.observationDigest) {
        return this.fail(barrier, `reset postcondition failed for ${domain}`, { postconditionResults })
      }
      requireDigest(result.observationDigest, `${domain} reset postcondition observationDigest`)
    }
    const generations = barrier.domains.map((domain) => {
      const generation = (this.#generation.get(domain) ?? 0) + 1
      this.#generation.set(domain, generation)
      return { domain, generation }
    })
    const receipt = sealDocument({
      schema: runtimeResetBarrierReceiptSchema,
      status: 'released',
      identity: this.#identity,
      barrier,
      beforeSnapshotDigest: beforeSnapshot.snapshotDigest,
      afterSnapshotDigest: afterSnapshot.snapshotDigest,
      beforeFragmentDigests: beforeSnapshot.fragments.map((fragment) => fragment.fragmentDigest),
      afterFragmentDigests: afterSnapshot.fragments.map((fragment) => fragment.fragmentDigest),
      processReceiptDigest: processReceipt.contentDigest,
      postconditionResults: freezeDeep(postconditionResults),
      generations
    }, 'receiptDigest')
    this.#active.delete(barrier.barrierId)
    return receipt
  }

  fail(barrier, reason, evidence = {}) {
    const active = this.#active.get(barrier.barrierId)
    if (!active) throw new Error('reset barrier is not active')
    const failure = freezeDeep({
      barrier: active,
      domains: active.domains,
      reason: requireText(reason, 'reset failure reason'),
      evidence: freezeDeep(evidence)
    })
    this.#active.delete(barrier.barrierId)
    this.#failed.set(barrier.barrierId, failure)
    const error = new Error(`runtime reset barrier remains closed: ${reason}`)
    error.code = 'runtime-reset-postcondition-failed'
    error.barrier = failure
    throw error
  }
}

export async function executeRuntimeResetBarrier({
  manager,
  consumerStepId,
  phase,
  reset,
  captureSnapshot,
  executeReset,
  verifyPostconditions,
  signal
}) {
  if (typeof captureSnapshot !== 'function' || typeof executeReset !== 'function' || typeof verifyPostconditions !== 'function') {
    throw new Error('runtime reset barrier requires snapshot, process and postcondition authorities')
  }
  const barrier = manager.begin({ consumerStepId: requireSafeId(consumerStepId, 'consumerStepId'), phase, reset })
  try {
    const beforeCapture = await captureSnapshot({ boundary: 'before-mutating-step', stepId: barrier.producerStepId, domains: barrier.domains, signal })
    const processReceipt = await executeReset({ barrier, signal })
    const afterCapture = await captureSnapshot({ boundary: 'after-mutating-step', stepId: barrier.producerStepId, domains: barrier.domains, signal })
    const postconditionResults = await verifyPostconditions({
      barrier,
      beforeSnapshot: beforeCapture?.snapshot,
      afterSnapshot: afterCapture?.snapshot,
      processReceipt,
      signal
    })
    return manager.complete(barrier, { processReceipt, beforeCapture, afterCapture, postconditionResults })
  } catch (error) {
    if (error?.code === 'runtime-reset-postcondition-failed') throw error
    return manager.fail(barrier, error instanceof Error ? error.message : String(error), {})
  }
}

export function validateRuntimeResetBarrierReceipt(receipt, {
  authority,
  identity,
  beforeCapture,
  afterCapture
} = {}) {
  if (receipt?.schema !== runtimeResetBarrierReceiptSchema || receipt.status !== 'released') {
    throw new Error('runtime reset barrier receipt schema/status is invalid')
  }
  verifySealedDocument(receipt, 'receiptDigest')
  const actualIdentity = normalizeRuntimeIdentity(receipt.identity)
  if (identity && digestCanonical(actualIdentity) !== digestCanonical(normalizeRuntimeIdentity(identity))) {
    throw new Error('runtime reset barrier receipt is stale or cross-session')
  }
  if (authority && actualIdentity.catalogDigest !== authority.catalogDigest) throw new Error('runtime reset barrier catalog drifted')
  const domains = receipt.barrier?.domains
  if (!Array.isArray(domains) || domains.length === 0 || new Set(domains).size !== domains.length) {
    throw new Error('runtime reset barrier receipt has incomplete affected domains')
  }
  const generationDomains = (receipt.generations ?? []).map((entry) => entry?.domain)
  if (JSON.stringify([...generationDomains].sort()) !== JSON.stringify([...domains].sort())
    || receipt.generations.some((entry) => !Number.isInteger(entry?.generation) || entry.generation < 1)) {
    throw new Error('runtime reset barrier generation receipt is incomplete')
  }
  for (const field of ['beforeSnapshotDigest', 'afterSnapshotDigest', 'processReceiptDigest']) {
    requireDigest(receipt[field], `reset receipt ${field}`)
  }
  for (const [label, capture, digestField, fragmentsField] of [
    ['before', beforeCapture, 'beforeSnapshotDigest', 'beforeFragmentDigests'],
    ['after', afterCapture, 'afterSnapshotDigest', 'afterFragmentDigests']
  ]) {
    if (!capture) continue
    validateRuntimeStateSnapshot(capture.snapshot, { authority, identity: actualIdentity, fragments: capture.fragments })
    if (capture.snapshot.snapshotDigest !== receipt[digestField]
      || JSON.stringify(capture.snapshot.fragments.map((fragment) => fragment.fragmentDigest)) !== JSON.stringify(receipt[fragmentsField])) {
      throw new Error(`runtime reset barrier ${label} snapshot reference mismatch`)
    }
  }
  return true
}
