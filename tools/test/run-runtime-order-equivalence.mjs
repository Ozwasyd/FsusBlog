#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { runtimeSteps } from './bundles/bundle-steps.mjs'
import { loadRuntimeStateAuthority } from '../test-runtime/catalog.mjs'
import {
  runRuntimeOrderEquivalence,
  validateRuntimeOrderEquivalenceReceipt
} from '../test-runtime/order-equivalence.mjs'
import { runtimeStepCatalogDigest } from '../test-runtime/schedule-plan.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1]
}

function outputFile() {
  const explicit = option('--output')
  if (explicit) return path.resolve(explicit)
  const root = String(process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT ?? '').trim()
  if (!root) throw new Error('runtime order equivalence requires --output or the current Production Fresh output root')
  return path.join(path.resolve(root), 'runtime', 'runtime-order-equivalence.json')
}

async function loadProvider() {
  const providerPath = option('--provider') ?? String(process.env.FSUSBLOG_RUNTIME_ORDER_PROVIDER ?? '').trim()
  if (!providerPath) throw new Error('runtime order equivalence requires a real production provider module; synthetic fallback is forbidden')
  const absolute = path.resolve(providerPath)
  const provider = await import(`${pathToFileURL(absolute).href}?run=${randomUUID()}`)
  const resolved = typeof provider.createRuntimeOrderProvider === 'function'
    ? await provider.createRuntimeOrderProvider()
    : provider.default
  if (!resolved || typeof resolved.createSession !== 'function' || typeof resolved.executePlan !== 'function'
    || !resolved.immutableIdentity || !Number.isInteger(resolved.maxConcurrency)) {
    throw new Error('runtime order provider lacks session/execution/identity/capability contracts')
  }
  return resolved
}

async function main() {
  if (!process.argv.includes('--all-required-schedules')) throw new Error('partial runtime order schedule selection is forbidden')
  const authority = loadRuntimeStateAuthority()
  const steps = runtimeSteps()
  const provider = await loadProvider()
  const receipt = await runRuntimeOrderEquivalence({
    steps,
    authority,
    runtimeStepCatalogDigest: runtimeStepCatalogDigest(steps),
    ...provider
  })
  validateRuntimeOrderEquivalenceReceipt(receipt, {
    sourceCommit: provider.immutableIdentity.sourceCommit,
    sourceFingerprint: provider.immutableIdentity.sourceFingerprint
  })
  const file = outputFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(`[runtime-order-equivalence] receipt=${file} schedules=${receipt.executedPlanCount} deduplicated=${receipt.deduplicatedPlanCount}`)
}

main().catch((error) => {
  console.error(`[runtime-order-equivalence] ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
})
