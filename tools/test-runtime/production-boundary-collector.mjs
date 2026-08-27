import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createRuntimeStateObservers } from '../test-fixtures/observers/index.mjs'
import { loadRuntimeStateAuthority } from './catalog.mjs'
import { captureRuntimeStateSnapshot } from './state-snapshot.mjs'
import { validateRuntimeExecutionSessionReceipt } from './runtime-execution-session.mjs'
import { RuntimeResetBarrierManager } from './reset-barrier.mjs'
import { digestCanonical } from '../test-fixtures/receipt/canonical.mjs'

const mutatingFields = ['writes', 'creates', 'deletes', 'invalidates']
const accessFields = ['reads', ...mutatingFields, 'exclusiveStateDomains']

function requiredText(value, label) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${label} is required`)
  return text
}

function readJson(file, label) {
  const absolute = path.resolve(requiredText(file, label))
  const stat = fs.lstatSync(absolute)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`)
  return JSON.parse(fs.readFileSync(absolute, 'utf8'))
}

function domainsForBoundary(authority, boundary, stepId) {
  if (boundary === 'before-runtime' || boundary === 'after-runtime') return authority.accessedDomains
  const step = authority.steps?.[stepId]
  if (!step) throw new Error(`runtime boundary references an unknown production step: ${stepId}`)
  if (!mutatingFields.some((field) => (step[field] ?? []).length > 0)) {
    throw new Error(`runtime boundary references a non-mutating production step: ${stepId}`)
  }
  return [...new Set(accessFields.flatMap((field) => step[field] ?? []))].sort()
}

/**
 * The collector is deliberately a thin owner around the canonical observers.
 * A production binding supplies readonly handles/ports for the current session;
 * it cannot supply fragments or receipts and therefore cannot bypass observer
 * validation, exact domain coverage, or side-effect accounting.
 */
export async function createProductionBoundaryCollector({
  bindingModule = process.env.FSUSBLOG_RUNTIME_ORDER_BINDING_MODULE,
  sessionReceiptFile = process.env.FSUSBLOG_RUNTIME_SESSION_RECEIPT,
  authority: suppliedAuthority = null,
  observers: suppliedObservers = null
} = {}) {
  const modulePath = path.resolve(requiredText(bindingModule, 'FSUSBLOG_RUNTIME_ORDER_BINDING_MODULE'))
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  if (!modulePath.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error('runtime-order binding module must remain inside the repository')
  }
  const bindingStat = fs.lstatSync(modulePath)
  if (!bindingStat.isFile() || bindingStat.isSymbolicLink()) {
    throw new Error('runtime-order binding module must be a regular non-symlink file')
  }
  const binding = await import(`${pathToFileURL(modulePath).href}?collector=${process.pid}`)
  if (typeof binding.createProductionSnapshotContext !== 'function') {
    throw new Error('runtime-order binding must export createProductionSnapshotContext()')
  }
  if (typeof binding.verifyProductionResetPostconditions !== 'function') {
    throw new Error('runtime-order binding must export verifyProductionResetPostconditions()')
  }
  if (typeof binding.verifyProductionCoordination !== 'function') {
    throw new Error('runtime-order binding must export verifyProductionCoordination()')
  }
  const sessionReceipt = readJson(sessionReceiptFile, 'FSUSBLOG_RUNTIME_SESSION_RECEIPT')
  validateRuntimeExecutionSessionReceipt(sessionReceipt)
  const authority = suppliedAuthority ?? loadRuntimeStateAuthority()
  if (sessionReceipt.identity.catalogDigest !== authority.catalogDigest) {
    throw new Error('runtime-order session/catalog identity drifted before observation')
  }
  const observers = suppliedObservers ?? createRuntimeStateObservers()
  const captures = []
  const resetReceipts = []
  const activeResetBarriers = new Map()
  const resetManager = new RuntimeResetBarrierManager({ authority, identity: sessionReceipt.identity })
  let tail = Promise.resolve()

  async function capture(boundary, stepId = null) {
    const operation = tail.then(async () => {
      const context = await binding.createProductionSnapshotContext({
        boundary,
        stepId,
        identity: sessionReceipt.identity,
        sessionReceipt,
        authority
      })
      if (!context || typeof context !== 'object') throw new Error('production snapshot context is unavailable')
      const captured = await captureRuntimeStateSnapshot({
        authority,
        identity: sessionReceipt.identity,
        boundary,
        stepId,
        requiredDomains: domainsForBoundary(authority, boundary, stepId),
        observers,
        context
      })
      captures.push(captured)
      return captured
    })
    tail = operation.catch(() => {})
    return operation
  }

  return Object.freeze({
    capture,
    async verifyCoordination(stepId) {
      const result = await binding.verifyProductionCoordination({
        stepId,
        identity: sessionReceipt.identity,
        sessionReceipt,
        authority
      })
      if (!result || result.status !== 'verified' || !result.receiptDigest) {
        throw new Error(`runtime-order coordination authority is unverified: ${stepId}`)
      }
      return result
    },
    beginResetBarriers(producerStepId) {
      const barriers = []
      for (const consumer of Object.values(authority.steps)) {
        for (const phase of ['resetBefore', 'resetAfter']) {
          for (const reset of consumer[phase] ?? []) {
            if (reset.producer !== producerStepId) continue
            barriers.push(resetManager.begin({ consumerStepId: consumer.stepId, phase, reset }))
          }
        }
      }
      activeResetBarriers.set(producerStepId, barriers)
      return barriers
    },
    async completeResetBarriers({ producerStepId, processResult, beforeCapture, afterCapture }) {
      const barriers = activeResetBarriers.get(producerStepId) ?? []
      activeResetBarriers.delete(producerStepId)
      for (const barrier of barriers) {
        const processReceipt = {
          exitCode: Number(processResult?.code ?? 0),
          signal: processResult?.signal ?? null,
          timedOut: processResult?.timedOut === true,
          cancelled: processResult?.cancelled === true,
          contentDigest: processResult?.logEvidence?.contentDigest
            ?? digestCanonical({ producerStepId, code: processResult?.code ?? 0, signal: processResult?.signal ?? null })
        }
        const postconditionResults = await binding.verifyProductionResetPostconditions({
          barrier,
          beforeCapture,
          afterCapture,
          processReceipt,
          identity: sessionReceipt.identity,
          sessionReceipt,
          authority
        })
        resetReceipts.push(resetManager.complete(barrier, {
          processReceipt,
          beforeCapture,
          afterCapture,
          postconditionResults
        }))
      }
      return barriers.length
    },
    async finish() {
      await tail
      if (activeResetBarriers.size > 0) throw new Error('runtime reset barriers remain active at finalization')
      return Object.freeze({ captures: [...captures], resetReceipts: [...resetReceipts] })
    }
  })
}

export function stepMutatesRuntimeState(authority, stepId) {
  const step = authority?.steps?.[stepId]
  if (!step) throw new Error(`runtime state catalog does not contain production step ${stepId}`)
  return mutatingFields.some((field) => (step[field] ?? []).length > 0)
}
