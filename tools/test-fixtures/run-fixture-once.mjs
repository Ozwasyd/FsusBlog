/**
 * Sole fixture-prepare run-once entry (#1711).
 *
 * Always injects the FixtureReceipt reuse verifier. Ordinary build/test
 * run-once callers must not use this module, and fixture producers must not
 * call tools/test/run-once.mjs without this wrapper.
 */

import path from 'node:path'
import { runOnce } from '../test/run-once.mjs'
import {
  assertFixtureReuseBypassForbidden,
  buildFixtureReuseContract,
  createFixtureReceiptReuseVerifier,
  FIXTURE_RUN_ONCE_REUSE_CONTRACT
} from './receipt/reuse-verifier.mjs'
import { readFixtureReceipt } from './receipt/fixture-receipt.mjs'
import { digestCanonical } from './receipt/canonical.mjs'
import { readFixtureCatalogs } from '../testing/fixture-catalog.mjs'

function uniqueResolved(paths) {
  return [...new Set((paths ?? []).map((item) => path.resolve(item)))].sort()
}

/**
 * @param {object} options run-once options plus fixture reuse bindings
 * @param {string} options.fixtureReceiptPath required FixtureReceipt output
 * @param {() => object|Promise<object>} options.observeCurrentState live DB/Redis/cache observations
 * @param {string|null} [options.currentStateGeneration] service/state generation for TOCTOU binding
 * @param {Function} operation producer prepare+verify that writes fixtureReceiptPath
 */
export async function runFixtureOnce(options, operation) {
  if (!options || typeof options !== 'object') throw new Error('runFixtureOnce options are required')
  if (typeof operation !== 'function') throw new Error('runFixtureOnce operation must be a function')

  assertFixtureReuseBypassForbidden(options.env ?? process.env)

  const fixtureReceiptPath = path.resolve(String(options.fixtureReceiptPath ?? '').trim())
  if (!fixtureReceiptPath || fixtureReceiptPath === path.resolve('')) {
    throw new Error('runFixtureOnce requires fixtureReceiptPath')
  }
  if (typeof options.observeCurrentState !== 'function') {
    throw new Error('runFixtureOnce requires observeCurrentState for postcondition revalidation')
  }

  const catalogs = options.catalogs ?? readFixtureCatalogs()
  const requiredOutputs = uniqueResolved([...(options.requiredOutputs ?? []), fixtureReceiptPath])
  const currentStateGeneration = options.currentStateGeneration
    ?? options.serviceGeneration
    ?? null

  const verifyReusableState = createFixtureReceiptReuseVerifier({
    fixtureReceiptPath,
    expectedExecutionIdentity: options.expectedExecutionIdentity ?? null,
    expectedCatalogDigest: options.expectedCatalogDigest ?? null,
    expectedProfileId: options.expectedProfileId ?? null,
    observeCurrentState: options.observeCurrentState,
    currentStateGeneration,
    requireStateGeneration: options.requireStateGeneration !== false,
    catalogs,
    env: options.env
  })

  return runOnce({
    root: options.root,
    namespace: options.namespace,
    key: options.key,
    fingerprint: options.fingerprint,
    requiredOutputs,
    lockTimeoutMs: options.lockTimeoutMs,
    staleLockMs: options.staleLockMs,
    heartbeatMs: options.heartbeatMs,
    verifyReusableState,
    async buildSuccessState({ state, requiredOutputStates }) {
      const receipt = readFixtureReceipt(fixtureReceiptPath, {
        catalogs,
        requireVerified: true,
        expectedExecutionIdentity: options.expectedExecutionIdentity ?? null,
        expectedCatalogDigest: options.expectedCatalogDigest ?? null,
        expectedProfileId: options.expectedProfileId ?? null
      })
      const observationDigest = digestCanonical({
        databaseObservationDigest: receipt.databaseObservationDigest,
        redisObservationDigest: receipt.redisObservationDigest,
        cacheObservationDigest: receipt.cacheObservationDigest,
        stateGeneration: currentStateGeneration
          ?? receipt.executionIdentity?.serviceGeneration
          ?? null,
        receiptDigest: receipt.receiptDigest
      })
      return buildFixtureReuseContract({
        fixtureReceiptPath,
        fixtureReceiptDigest: receipt.receiptDigest,
        observationDigest,
        stateGeneration: currentStateGeneration
          ?? receipt.executionIdentity?.serviceGeneration
          ?? null,
        catalogDigest: receipt.catalogDigest,
        profileId: receipt.profileIdentity?.profileId ?? null,
        requiredOutputStates
      })
    }
  }, async () => {
    await operation()
    // Producer must emit a verified FixtureReceipt; file presence alone is insufficient.
    readFixtureReceipt(fixtureReceiptPath, {
      catalogs,
      requireVerified: true,
      expectedExecutionIdentity: options.expectedExecutionIdentity ?? null,
      expectedCatalogDigest: options.expectedCatalogDigest ?? null,
      expectedProfileId: options.expectedProfileId ?? null
    })
  })
}

export {
  FIXTURE_RUN_ONCE_REUSE_CONTRACT,
  createFixtureReceiptReuseVerifier,
  assertFixtureReuseBypassForbidden
}

/** Catalog/governance: producers that participate in run-once must declare this verifier. */
export const REQUIRED_PRODUCER_REUSE_VERIFIER = FIXTURE_RUN_ONCE_REUSE_CONTRACT
