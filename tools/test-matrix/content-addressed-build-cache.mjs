#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  atomicJson,
  buildCacheDomainEvidenceSchema,
  buildCacheSummarySchema,
  cachePaths,
  computeBuildCacheIdentity,
  defaultRoot,
  loadBuildCacheConfiguration,
  readJson,
  verifyBuildCacheObject
} from './content-addressed-build-cache-contract.mjs'
import {
  acquireLock,
  materializeObject,
  publishObject,
  quarantineObject,
  releaseLock
} from './content-addressed-build-cache-storage.mjs'

export {
  buildCacheConfigSchema,
  buildCacheReceiptSchema,
  buildCacheDomainEvidenceSchema,
  buildCacheSummarySchema,
  computeBuildCacheIdentity,
  loadBuildCacheConfiguration,
  verifyBuildCacheObject
} from './content-addressed-build-cache-contract.mjs'

const summaryWaitArray = new Int32Array(new SharedArrayBuffer(4))

function evidencePaths(root, runRoot, config, domainId, runId) {
  return {
    dependency: dependencyEvidenceFile(runRoot, domainId),
    domain: path.join(path.resolve(root, config.evidenceRoot), runId, `${domainId}.json`),
    summary: path.resolve(root, config.summaryFile),
    summaryLock: path.resolve(root, `${config.summaryFile}.lock`)
  }
}

export function validateBuildCacheSummary({ root = defaultRoot, runId, config = loadBuildCacheConfiguration(root) }) {
  const file = path.resolve(root, config.summaryFile)
  const summary = readJson(file, 'production build cache summary')
  const expected = Object.keys(config.domains).sort()
  const completed = [...new Set(summary.completedDomains ?? [])].sort()
  const errors = []
  if (summary.schema !== buildCacheSummarySchema) errors.push('summary schema')
  if (summary.status !== 'complete') errors.push(`summary status=${summary.status ?? '<missing>'}`)
  if (summary.runId !== runId) errors.push('summary run id')
  if (JSON.stringify(summary.expectedDomains) !== JSON.stringify(expected)) errors.push('summary expected domains')
  if (JSON.stringify(completed) !== JSON.stringify(expected)) errors.push('summary completed domains')
  if (summary.dynamicFactsCached !== false) errors.push('summary dynamic facts')
  if (!Array.isArray(summary.domains) || summary.domains.some(result => result.schema !== buildCacheDomainEvidenceSchema || result.status !== 'success')) {
    errors.push('summary domain evidence')
  }
  if (errors.length > 0) throw new Error(`production build cache summary is invalid: ${errors.join('; ')}`)
  return summary
}

export function waitForBuildCacheSummary({ root = defaultRoot, runId, config = loadBuildCacheConfiguration(root) }) {
  while (true) {
    try {
      return validateBuildCacheSummary({ root, runId, config })
    } catch (error) {
      const file = path.resolve(root, config.summaryFile)
      if (fs.existsSync(file)) {
        const summary = readJson(file, 'production build cache summary')
        if (summary.runId === runId && summary.status === 'failure') throw error
      }
      Atomics.wait(summaryWaitArray, 0, 0, 100)
    }
  }
}

function writeSummary(root, config, runId, paths) {
  fs.mkdirSync(path.dirname(paths.summaryLock), { recursive: true })
  let owned = false
  for (let attempt = 0; attempt < 200 && !owned; attempt += 1) {
    try { fs.mkdirSync(paths.summaryLock); owned = true }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      Atomics.wait(summaryWaitArray, 0, 0, 10)
    }
  }
  if (!owned) throw new Error('could not acquire production build cache evidence lock')
  try {
    const domainRoot = path.join(path.resolve(root, config.evidenceRoot), runId)
    const results = fs.existsSync(domainRoot)
      ? fs.readdirSync(domainRoot).filter(name => name.endsWith('.json')).sort().map(name => readJson(path.join(domainRoot, name)))
      : []
    const expected = Object.keys(config.domains).sort()
    const actual = results.map(result => result.domain).sort()
    const summary = {
      schema: buildCacheSummarySchema,
      status: results.some(result => result.status !== 'success') ? 'failure' : actual.length === expected.length ? 'complete' : 'partial',
      runId,
      expectedDomains: expected,
      completedDomains: actual,
      dynamicFactsCached: false,
      domains: results,
      totals: {
        hits: results.filter(result => ['hit', 'race-hit'].includes(result.decision)).length,
        misses: results.filter(result => result.decision === 'miss').length,
        reusedBytes: results.reduce((sum, result) => sum + Number(result.metrics?.reusedBytes ?? 0), 0),
        builtBytes: results.reduce((sum, result) => sum + Number(result.metrics?.builtBytes ?? 0), 0),
        compilerInvocations: results.reduce((sum, result) => sum + Number(result.metrics?.compilerInvocations ?? 0), 0)
      }
    }
    atomicJson(paths.summary, summary)
  } finally { fs.rmSync(paths.summaryLock, { recursive: true, force: true }) }
}

function writeEvidence({ root, runRoot, config, domainId, runId, evidence }) {
  const paths = evidencePaths(root, runRoot, config, domainId, runId)
  atomicJson(paths.dependency, evidence)
  atomicJson(paths.domain, evidence)
  writeSummary(root, config, runId, paths)
}

async function runCommand(command, env, cwd = defaultRoot) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`build command failed code=${code ?? '<null>'} signal=${signal ?? '<none>'}`)))
  })
}

export async function executeBuildCacheDomain({ root = defaultRoot, runRoot, domainId, command, env = process.env, execute = runCommand }) {
  const startedAt = Date.now()
  const repositoryRoot = path.resolve(root)
  const buildRoot = path.resolve(runRoot)
  const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? path.basename(buildRoot)).trim()
  const sourceState = {
    commit: String(env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim() || null,
    worktreeFingerprint: String(env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim() || null
  }
  const computed = computeBuildCacheIdentity({ root: repositoryRoot, runRoot: buildRoot, domainId, command, env })
  let verified
  try { verified = verifyBuildCacheObject({ root: repositoryRoot, runRoot: buildRoot, domainId, command, env, config: computed.config }) }
  catch (error) {
    const badPaths = error.cachePaths ?? cachePaths(repositoryRoot, computed.config, domainId, computed.key)
    const quarantine = quarantineObject(badPaths, error.message)
    throw new Error(`${error.message}; quarantined=${quarantine ?? '<none>'}`, { cause: error })
  }
  if (verified.hit) {
    const materialization = materializeObject({ root: repositoryRoot, objectRoot: verified.paths.objectRoot, runRoot: buildRoot, domain: verified.domain, receipt: verified.receipt, runId, sourceState, env })
    const evidence = {
      schema: buildCacheDomainEvidenceSchema,
      status: 'success',
      runId,
      domain: domainId,
      phase: verified.domain.phase,
      decision: 'hit',
      reason: verified.reason,
      key: verified.key,
      receiptContentDigest: verified.receipt.contentDigest,
      producerSourceState: verified.receipt.producerSourceState,
      consumerSourceState: sourceState,
      dynamicFactsCached: false,
      dynamicFacts: verified.config.dynamicFacts,
      metrics: {
        reusedBytes: materialization.byteCount,
        builtBytes: 0,
        compilerInvocations: 0,
        materializationMode: materialization.mode,
        materializationFallbackReason: materialization.fallbackReason,
        relocatedFiles: materialization.relocatedFiles,
        relocationReplacements: materialization.replacements,
        receiptsResealed: materialization.receiptsResealed,
        postMaterialization: materialization.postMaterialization,
        durationMs: Date.now() - startedAt
      }
    }
    writeEvidence({ root: repositoryRoot, runRoot: buildRoot, config: verified.config, domainId, runId, evidence })
    return evidence
  }
  const paths = verified.paths
  const lock = await acquireLock(paths, verified.config, runId)
  if (!lock.owned) {
    const raced = verifyBuildCacheObject({ root: repositoryRoot, runRoot: buildRoot, domainId, command, env, config: verified.config })
    if (!raced.hit) throw new Error('concurrent build cache producer completed without an object')
    const materialization = materializeObject({ root: repositoryRoot, objectRoot: raced.paths.objectRoot, runRoot: buildRoot, domain: raced.domain, receipt: raced.receipt, runId, sourceState, env })
    const evidence = {
      schema: buildCacheDomainEvidenceSchema, status: 'success', runId, domain: domainId, phase: raced.domain.phase,
      decision: 'race-hit', reason: 'concurrent-producer', key: raced.key, receiptContentDigest: raced.receipt.contentDigest,
      producerSourceState: raced.receipt.producerSourceState, consumerSourceState: sourceState,
      dynamicFactsCached: false, dynamicFacts: raced.config.dynamicFacts,
      metrics: { reusedBytes: materialization.byteCount, builtBytes: 0, compilerInvocations: 0, materializationMode: materialization.mode, materializationFallbackReason: materialization.fallbackReason, relocatedFiles: materialization.relocatedFiles, relocationReplacements: materialization.replacements, receiptsResealed: materialization.receiptsResealed, postMaterialization: materialization.postMaterialization, durationMs: Date.now() - startedAt }
    }
    writeEvidence({ root: repositoryRoot, runRoot: buildRoot, config: raced.config, domainId, runId, evidence })
    return evidence
  }
  try {
    try {
      await execute(command, env, repositoryRoot)
    } catch (error) {
      const failureEvidence = {
        schema: buildCacheDomainEvidenceSchema,
        status: 'failure',
        runId,
        domain: domainId,
        phase: verified.domain.phase,
        decision: 'miss',
        reason: 'producer-command-failed',
        key: verified.key,
        receiptContentDigest: null,
        producerSourceState: sourceState,
        consumerSourceState: sourceState,
        dynamicFactsCached: false,
        dynamicFacts: verified.config.dynamicFacts,
        error: error instanceof Error ? error.message : String(error),
        metrics: {
          reusedBytes: 0,
          builtBytes: 0,
          compilerInvocations: 1,
          materializationMode: null,
          receiptsResealed: 0,
          postMaterialization: [],
          durationMs: Date.now() - startedAt
        }
      }
      writeEvidence({ root: repositoryRoot, runRoot: buildRoot, config: verified.config, domainId, runId, evidence: failureEvidence })
      throw error
    }
    const receipt = publishObject({ root: repositoryRoot, runRoot: buildRoot, computed: verified, paths, command, sourceState })
    const evidence = {
      schema: buildCacheDomainEvidenceSchema,
      status: 'success', runId, domain: domainId, phase: verified.domain.phase,
      decision: 'miss', reason: verified.reason, key: verified.key, receiptContentDigest: receipt.contentDigest,
      producerSourceState: sourceState, consumerSourceState: sourceState,
      dynamicFactsCached: false, dynamicFacts: verified.config.dynamicFacts,
      metrics: {
        reusedBytes: 0,
        builtBytes: receipt.artifactTree.byteCount,
        compilerInvocations: 1,
        materializationMode: null,
        receiptsResealed: 0,
        postMaterialization: [],
        publicationMode: receipt.publication.mode,
        publicationFallbackReason: receipt.publication.fallbackReason,
        durationMs: Date.now() - startedAt
      }
    }
    writeEvidence({ root: repositoryRoot, runRoot: buildRoot, config: verified.config, domainId, runId, evidence })
    return evidence
  } finally {
    fs.rmSync(paths.stagingRoot, { recursive: true, force: true })
    releaseLock(paths)
  }
}

function parseCli(argv) {
  const [verb, ...rest] = argv
  if (['check-summary', 'wait-summary'].includes(verb)) return { verb }
  if (verb !== 'run') throw new Error('content-addressed build cache command must be run, check-summary, or wait-summary')
  const separator = rest.indexOf('--')
  if (separator < 0) throw new Error('content-addressed build cache run requires -- before the command')
  const options = rest.slice(0, separator)
  const command = rest.slice(separator + 1)
  const domainIndex = options.indexOf('--domain')
  if (domainIndex < 0 || !options[domainIndex + 1]) throw new Error('--domain is required')
  if (command.length === 0) throw new Error('build command is required')
  return { verb, domainId: options[domainIndex + 1], command }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseCli(process.argv.slice(2))
  const runRoot = String(process.env.FSUSBLOG_PRODUCTION_BUILD_ROOT ?? '').trim()
  if (!runRoot) throw new Error('FSUSBLOG_PRODUCTION_BUILD_ROOT is required')
  if (['check-summary', 'wait-summary'].includes(args.verb)) {
    const runId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? path.basename(runRoot)).trim()
    try {
      const summary = args.verb === 'wait-summary'
        ? waitForBuildCacheSummary({ runId })
        : validateBuildCacheSummary({ runId })
      console.log(`[build-cache] complete domains=${summary.completedDomains.length} hits=${summary.totals.hits} misses=${summary.totals.misses}`)
    } catch (error) {
      console.error(`[build-cache] fatal: ${error.message}`)
      process.exitCode = 1
    }
  } else {
    executeBuildCacheDomain({ runRoot, domainId: args.domainId, command: args.command })
      .then(evidence => console.log(`[build-cache] ${evidence.domain} ${evidence.decision} key=${evidence.key}`))
      .catch(error => { console.error(`[build-cache] fatal: ${error.message}`); process.exitCode = 1 })
  }
}
