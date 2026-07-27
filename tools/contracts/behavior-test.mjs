import test from 'node:test'
import { allowedTestKinds } from './behavior-contract-catalog.mjs'

export const behaviorTestHelperName = 'behaviorTest'
export const concurrencyHarnessId = 'fsusblog.real-concurrency.v1'
export const allowedConcurrencyHarnesses = new Set([concurrencyHarnessId])
export const behaviorIdPattern = /^[a-z][a-z0-9-]*$/u
export const stableIdPattern = /^[a-z][a-z0-9._-]*$/u

const fail = (message) => {
  throw new Error(`[behavior-test] ${message}`)
}

function normalizeOptions(titleOrOptions) {
  if (typeof titleOrOptions === 'string') {
    const title = titleOrOptions.trim()
    if (!title) fail('title must be a non-empty string')
    return { title, invariantIds: [], reasonId: null, concurrencyHarness: null }
  }
  if (titleOrOptions === null || typeof titleOrOptions !== 'object' || Array.isArray(titleOrOptions)) {
    fail('third argument must be a title string or options object')
  }
  const title = String(titleOrOptions.title ?? '').trim()
  if (!title) fail('options.title must be a non-empty string')
  const invariantIds = titleOrOptions.invariantIds === undefined
    ? []
    : Array.isArray(titleOrOptions.invariantIds)
      ? titleOrOptions.invariantIds
      : fail('options.invariantIds must be an array of strings')
  if (invariantIds.some((value) => typeof value !== 'string' || !stableIdPattern.test(value))) {
    fail('options.invariantIds must be stable non-empty IDs')
  }
  if (new Set(invariantIds).size !== invariantIds.length) fail('options.invariantIds must be unique')
  const reasonId = titleOrOptions.reasonId === undefined || titleOrOptions.reasonId === null
    ? null
    : String(titleOrOptions.reasonId)
  if (reasonId !== null && !stableIdPattern.test(reasonId)) fail('options.reasonId must be a stable ID')
  const concurrencyHarness = titleOrOptions.concurrencyHarness === undefined || titleOrOptions.concurrencyHarness === null
    ? null
    : String(titleOrOptions.concurrencyHarness)
  if (concurrencyHarness !== null && !allowedConcurrencyHarnesses.has(concurrencyHarness)) {
    fail(`options.concurrencyHarness must be a registered real harness; got ${concurrencyHarness}`)
  }
  for (const key of Object.keys(titleOrOptions)) {
    if (!['title', 'invariantIds', 'reasonId', 'concurrencyHarness'].includes(key)) {
      fail(`options contains unsupported field ${key}`)
    }
  }
  return { title, invariantIds, reasonId, concurrencyHarness }
}

export function validateBehaviorTestDeclaration(behaviorId, testKind, options) {
  if (typeof behaviorId !== 'string' || !behaviorIdPattern.test(behaviorId)) {
    fail(`behaviorId is invalid: ${behaviorId}`)
  }
  if (typeof testKind !== 'string' || !allowedTestKinds.has(testKind)) {
    fail(`testKind must be a catalog kind; got ${testKind}`)
  }
  if ((testKind === 'negative' || testKind === 'migration')
    && options.invariantIds.length === 0
    && !options.reasonId) {
    fail(`${testKind} proofs require invariantIds or reasonId`)
  }
  if (testKind === 'concurrency' && !options.concurrencyHarness) {
    fail('concurrency proofs require concurrencyHarness set to a real harness identity')
  }
  if (testKind !== 'concurrency' && options.concurrencyHarness) {
    fail('concurrencyHarness is only valid for concurrency proofs')
  }
  return {
    behaviorId,
    testKind,
    title: options.title,
    invariantIds: options.invariantIds,
    reasonId: options.reasonId,
    concurrencyHarness: options.concurrencyHarness
  }
}

/**
 * Real concurrency harness. Name-only "concurrency" tests cannot substitute this API.
 * Runs workers concurrently and returns settled results in input order.
 */
export async function runRealConcurrencyHarness(workers) {
  if (!Array.isArray(workers) || workers.length < 2) {
    fail('real concurrency harness requires at least two workers')
  }
  const started = workers.map((worker, index) => {
    if (typeof worker !== 'function') fail(`concurrency worker[${index}] must be a function`)
    return Promise.resolve().then(() => worker())
  })
  return Promise.all(started)
}

/**
 * Formal Node/Vitest/Playwright registration helper.
 * Only this call form (or C# [CoversBehavior]) may bind tests to Behavior IDs.
 *
 * AST-scannable shapes:
 *   behaviorTest('behavior-id', 'positive', 'title', fn)
 *   behaviorTest('behavior-id', 'negative', { title, invariantIds|reasonId }, fn)
 *   behaviorTest('behavior-id', 'concurrency', { title, concurrencyHarness }, fn)
 */
export function createBehaviorTest(runner = test) {
  if (typeof runner !== 'function') fail('runner must be a test registration function')
  return function behaviorTest(behaviorId, testKind, titleOrOptions, fn) {
    if (typeof fn !== 'function') fail('behaviorTest requires a test function as the fourth argument')
    const options = normalizeOptions(titleOrOptions)
    const declaration = validateBehaviorTestDeclaration(behaviorId, testKind, options)
    // Preserve a machine-readable suffix only for diagnostics; identity remains the title string.
    return runner(declaration.title, fn)
  }
}

export const behaviorTest = createBehaviorTest(test)
