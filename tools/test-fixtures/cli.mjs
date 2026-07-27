#!/usr/bin/env node
/**
 * Unique fixture orchestrator CLI (#1709).
 * Dev, acceptance, browser-contract, diagnostics, and scale share this entry.
 * No compat wrappers, feature flags, or second lifecycle.
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  fixtureReceiptDigestFromFile,
  writeFixtureProfileReceipt
} from '../testing/fixture-catalog.mjs'
import {
  cleanup,
  plan as planOrchestration,
  prepare,
  verify
} from './orchestrator.mjs'
import { createDefaultProducerPorts, createPortsForProducerIds } from './producers/catalog-ports.mjs'

function parseArgs(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      options._.push(...argv.slice(index + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq >= 0) {
        options[arg.slice(2, eq)] = arg.slice(eq + 1)
      } else {
        const key = arg.slice(2)
        const next = argv[index + 1]
        if (next != null && !next.startsWith('--')) {
          options[key] = next
          index += 1
        } else {
          options[key] = true
        }
      }
    } else {
      options._.push(arg)
    }
  }
  return options
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* best-effort */ }
  return value
}

function buildProfileIdentity(options) {
  const profileId = options.profile ?? options['profile-id']
  if (!profileId) throw new Error('--profile is required')
  const profileSource = options.source ?? options['profile-source'] ?? 'dev-cli'
  const executionClass = options['execution-class'] ?? null
  const sealed = profileSource === 'matrix'
    ? {
      fixtureProfileId: options['sealed-profile-id'] ?? profileId,
      fixtureCatalogDigest: options['sealed-catalog-digest'],
      expandedCapabilityDigest: options['sealed-capability-digest'],
      executionClass: options['sealed-execution-class'] ?? executionClass
    }
    : null
  return { profileId, profileSource, executionClass, sealed }
}

function buildExecutionIdentity(options) {
  const handles = {}
  if (options['base-url']) handles.baseUrl = options['base-url']
  if (options['debug-backend-url']) handles.debugBackendUrl = options['debug-backend-url']
  if (options['frontend-url']) handles.frontendUrl = options['frontend-url']
  if (options['pg-container']) handles.pgContainer = options['pg-container']
  if (options['redis-container']) handles.redisContainer = options['redis-container']
  if (options['pg-user']) handles.pgUser = options['pg-user']
  if (options['pg-db']) handles.pgDb = options['pg-db']
  if (options['scale-tier']) handles.scaleTier = options['scale-tier']
  return {
    runId: options['run-id'] ?? process.env.FSUSBLOG_TEST_RUN_ID ?? null,
    namespace: options.namespace ?? process.env.FSUSBLOG_TEST_NAMESPACE ?? null,
    sourceIdentity: options['source-commit']
      ? {
        commit: options['source-commit'],
        worktreeFingerprint: options['source-fingerprint'] ?? null
      }
      : null,
    handles
  }
}

function resolvePorts(planDocument, options) {
  if (options['ports-module']) {
    throw new Error('--ports-module is not supported; inject ports in-process or use default catalog ports')
  }
  const ids = planDocument.producers ?? planDocument.order ?? []
  if (ids.length === 0) return []
  if (options['all-ports'] === true) return createDefaultProducerPorts()
  return createPortsForProducerIds(ids)
}

function toLegacyFixtureReceipt(orchestratorReceipt) {
  return {
    schema: 'fsusblog.fixture-receipt.v1',
    kind: 'fixture-receipt',
    generatedAt: new Date().toISOString(),
    profileId: orchestratorReceipt.profileId,
    profileSource: orchestratorReceipt.profileSource,
    catalogDigest: orchestratorReceipt.catalogDigest,
    expandedCapabilityDigest: orchestratorReceipt.expandedCapabilityDigest,
    capabilityIds: orchestratorReceipt.plan?.capabilities ?? [],
    producerIds: orchestratorReceipt.producerIds ?? [],
    mutationPolicy: orchestratorReceipt.plan?.mutationPolicy,
    mutations: orchestratorReceipt.mutations ?? [],
    zeroData: orchestratorReceipt.zeroData === true,
    terminalState: orchestratorReceipt.terminalState,
    strategies: orchestratorReceipt.strategies ?? [],
    primaryFailure: orchestratorReceipt.primaryFailure ?? null,
    cleanupFailure: orchestratorReceipt.cleanupFailure ?? null,
    orchestratorSchema: orchestratorReceipt.schema
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const command = options._[0]
  if (!command || command === 'help' || options.help === true) {
    process.stdout.write(`Usage:
  node tools/test-fixtures/cli.mjs plan --profile <id> --source dev-cli|matrix [sealed opts] [--out plan.json]
  node tools/test-fixtures/cli.mjs prepare --plan plan.json [--out receipt.json] [--legacy-fixture-receipt path]
  node tools/test-fixtures/cli.mjs verify --receipt receipt.json [--out receipt.json]
  node tools/test-fixtures/cli.mjs cleanup --receipt receipt.json [--out receipt.json]
  node tools/test-fixtures/cli.mjs run --profile <id> --source ... [--out receipt.json]
`)
    return
  }

  if (command === 'plan') {
    const planDocument = planOrchestration(buildProfileIdentity(options), buildExecutionIdentity(options))
    if (options.out) writeJson(options.out, planDocument)
    // Also emit #1708 planned-profile receipt shape when requested.
    if (options['planned-profile-out']) {
      writeFixtureProfileReceipt(options['planned-profile-out'], {
        profileId: planDocument.profileIdentity.profileId,
        profileSource: planDocument.profileIdentity.profileSource,
        catalogDigest: planDocument.catalogDigest,
        expandedCapabilityDigest: planDocument.expandedCapabilityDigest,
        capabilities: planDocument.capabilities,
        producers: planDocument.producers,
        mutationPolicy: planDocument.mutationPolicy,
        executionClass: planDocument.profileIdentity.executionClass,
        requiresLocalAuthBypass: planDocument.requiresLocalAuthBypass,
        requiresAuthFixtures: planDocument.requiresAuthFixtures,
        requiresPublicFixtures: planDocument.requiresPublicFixtures,
        requiresDemoSeed: planDocument.requiresDemoSeed,
        requiresSecurityReset: planDocument.requiresSecurityReset
      }, { kind: 'planned-profile' })
    }
    process.stdout.write(`${JSON.stringify(planDocument)}\n`)
    return
  }

  if (command === 'prepare') {
    const planFile = options.plan ?? options['plan-file']
    if (!planFile) throw new Error('prepare requires --plan')
    const planDocument = readJson(planFile)
    const ports = resolvePorts(planDocument, options)
    const controller = new AbortController()
    const onSignal = () => controller.abort(new Error('fixture prepare cancelled'))
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    try {
      const receipt = await prepare(planDocument, ports, controller.signal)
      if (options.out) writeJson(options.out, receipt)
      if (options['legacy-fixture-receipt']) {
        writeJson(options['legacy-fixture-receipt'], toLegacyFixtureReceipt(receipt))
      }
      process.stdout.write(`${JSON.stringify(receipt)}\n`)
    } catch (error) {
      if (error?.receipt && options.out) writeJson(options.out, error.receipt)
      if (error?.receipt && options['legacy-fixture-receipt']) {
        writeJson(options['legacy-fixture-receipt'], toLegacyFixtureReceipt(error.receipt))
      }
      throw error
    } finally {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }
    return
  }

  if (command === 'verify') {
    const receiptFile = options.receipt ?? options['receipt-file']
    if (!receiptFile) throw new Error('verify requires --receipt')
    const receipt = readJson(receiptFile)
    const ports = resolvePorts(receipt.plan ?? receipt, options)
    const next = await verify(receipt, ports)
    if (options.out) writeJson(options.out, next)
    process.stdout.write(`${JSON.stringify(next)}\n`)
    return
  }

  if (command === 'cleanup') {
    const receiptFile = options.receipt ?? options['receipt-file']
    if (!receiptFile) throw new Error('cleanup requires --receipt')
    const receipt = readJson(receiptFile)
    const ports = resolvePorts(receipt.plan ?? receipt, options)
    const controller = new AbortController()
    const onSignal = () => controller.abort(new Error('fixture cleanup cancelled'))
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    try {
      const next = await cleanup(receipt, ports, controller.signal)
      if (options.out) writeJson(options.out, next)
      process.stdout.write(`${JSON.stringify(next)}\n`)
    } finally {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }
    return
  }

  if (command === 'run') {
    const planDocument = planOrchestration(buildProfileIdentity(options), buildExecutionIdentity(options))
    if (options['plan-out']) writeJson(options['plan-out'], planDocument)
    if (options['planned-profile-out']) {
      writeFixtureProfileReceipt(options['planned-profile-out'], {
        profileId: planDocument.profileIdentity.profileId,
        profileSource: planDocument.profileIdentity.profileSource,
        catalogDigest: planDocument.catalogDigest,
        expandedCapabilityDigest: planDocument.expandedCapabilityDigest,
        capabilities: planDocument.capabilities,
        producers: planDocument.producers,
        mutationPolicy: planDocument.mutationPolicy,
        executionClass: planDocument.profileIdentity.executionClass,
        requiresLocalAuthBypass: planDocument.requiresLocalAuthBypass,
        requiresAuthFixtures: planDocument.requiresAuthFixtures,
        requiresPublicFixtures: planDocument.requiresPublicFixtures,
        requiresDemoSeed: planDocument.requiresDemoSeed,
        requiresSecurityReset: planDocument.requiresSecurityReset
      }, { kind: 'planned-profile' })
    }
    const ports = resolvePorts(planDocument, options)
    const controller = new AbortController()
    const onSignal = () => controller.abort(new Error('fixture run cancelled'))
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    try {
      let receipt = await prepare(planDocument, ports, controller.signal)
      if (options.verify !== false && options['skip-verify'] !== true) {
        receipt = await verify(receipt, ports, { signal: controller.signal })
      }
      if (options.out) writeJson(options.out, receipt)
      if (options['legacy-fixture-receipt']) {
        writeJson(options['legacy-fixture-receipt'], toLegacyFixtureReceipt(receipt))
      }
      process.stdout.write(`${JSON.stringify(receipt)}\n`)
    } catch (error) {
      if (error?.receipt && options.out) writeJson(options.out, error.receipt)
      if (error?.receipt && options['legacy-fixture-receipt']) {
        writeJson(options['legacy-fixture-receipt'], toLegacyFixtureReceipt(error.receipt))
      }
      throw error
    } finally {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }
    return
  }

  if (command === 'receipt-digest') {
    const file = options.file ?? options._[1]
    if (!file) throw new Error('receipt-digest requires --file')
    process.stdout.write(`${fixtureReceiptDigestFromFile(file)}\n`)
    return
  }

  throw new Error(`unknown fixture orchestrator command: ${command}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error?.message ?? error}\n`)
    process.exit(1)
  })
}

export { main as runFixtureOrchestratorCli }
