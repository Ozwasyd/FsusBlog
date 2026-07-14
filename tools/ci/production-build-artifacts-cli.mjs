#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  collectProductionToolchain,
  createProductionBuildReceipt,
  materializeProductionBuildDomains,
  verifyProductionBuildReceipt
} from './production-build-artifacts.mjs'

function parseOptions(args) {
  const options = { artifact: [], input: [], tool: [], map: [] }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`)
    const equal = argument.indexOf('=')
    const key = equal < 0 ? argument.slice(2) : argument.slice(2, equal)
    const value = equal < 0 ? args[++index] : argument.slice(equal + 1)
    if (value === undefined) throw new Error(`missing value for --${key}`)
    if (['artifact', 'input', 'tool', 'map'].includes(key)) options[key].push(value)
    else options[key.replaceAll('-', '_')] = value
  }
  return options
}

function pairs(values, label) {
  return Object.fromEntries(values.map(value => {
    const index = value.indexOf('=')
    if (index < 1 || index === value.length - 1) throw new Error(`${label} must use name=value: ${value}`)
    return [value.slice(0, index), value.slice(index + 1)]
  }))
}

function sourceState(options) {
  return {
    commit: options.expected_commit ?? options.source_commit ?? process.env.GITHUB_SHA,
    worktreeFingerprint: options.expected_fingerprint ?? options.source_fingerprint ?? process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
  }
}

function producer(options) {
  return {
    workflow: options.workflow ?? process.env.GITHUB_WORKFLOW,
    runId: options.expected_run_id ?? options.run_id ?? process.env.GITHUB_RUN_ID,
    runAttempt: Number(options.expected_run_attempt ?? options.run_attempt ?? process.env.GITHUB_RUN_ATTEMPT),
    job: options.expected_job ?? options.job ?? process.env.GITHUB_JOB
  }
}

function expectedProducer(options) {
  return {
    runId: options.expected_run_id ?? process.env.GITHUB_RUN_ID,
    job: options.expected_job,
    ...(options.expected_run_attempt === undefined ? {} : { runAttempt: Number(options.expected_run_attempt) })
  }
}

function mappings(values) {
  return values.map(value => {
    const index = value.indexOf('=')
    if (index < 1 || index === value.length - 1) throw new Error(`--map must use name=destination: ${value}`)
    return { name: value.slice(0, index), destination: value.slice(index + 1) }
  })
}

function writeEvidence(file, value) {
  if (!file) return
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`)
}

const [command, ...args] = process.argv.slice(2)
const options = parseOptions(args)
const root = path.resolve(options.root ?? process.cwd())
const artifactRoot = path.resolve(options.artifact_root ?? path.join(root, '.tmp/ci-production-build'))
const receiptFile = options.receipt ?? 'receipt.json'

try {
  if (command === 'create') {
    const toolchain = { ...collectProductionToolchain({ root }), ...pairs(options.tool, '--tool') }
    const domains = options.artifact.map(value => {
      const index = value.indexOf('=')
      if (index < 1 || index === value.length - 1) throw new Error(`--artifact must use domain=path: ${value}`)
      const rawName = value.slice(0, index)
      const consumerMode = rawName.endsWith(':copy-before-write') ? 'copy-before-write' : 'read-only'
      const name = rawName.replace(/:copy-before-write$/u, '')
      return { name, path: value.slice(index + 1), consumerMode }
    })
    const receipt = createProductionBuildReceipt({
      root,
      artifactRoot,
      receiptFile,
      sourceState: sourceState(options),
      producer: producer(options),
      toolchain,
      inputPaths: options.input,
      domains,
      build: {
        profile: options.profile,
        command: options.command,
        startedAt: options.started_at,
        finishedAt: options.finished_at,
        durationMs: options.duration_ms
      }
    })
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  } else if (command === 'verify') {
    const result = verifyProductionBuildReceipt({
      artifactRoot,
      receiptFile,
      expectedSourceState: sourceState(options),
      expectedProducer: expectedProducer(options),
      expectedToolchain: options.tool.length > 0 ? pairs(options.tool, '--tool') : null,
      expectedReceiptDigest: options.expected_receipt_digest,
      transferStartedAtMs: options.transfer_started_at_ms
    })
    writeEvidence(options.evidence, result.evidence)
    process.stdout.write(`${JSON.stringify(result.evidence, null, 2)}\n`)
  } else if (command === 'materialize') {
    const result = materializeProductionBuildDomains({
      artifactRoot,
      receiptFile,
      destinationRoot: path.resolve(options.destination_root ?? root),
      mappings: mappings(options.map),
      verification: {
        expectedSourceState: sourceState(options),
        expectedProducer: expectedProducer(options),
        expectedToolchain: options.tool.length > 0 ? pairs(options.tool, '--tool') : null,
        expectedReceiptDigest: options.expected_receipt_digest,
        transferStartedAtMs: options.transfer_started_at_ms
      }
    })
    writeEvidence(options.evidence, { ...result.evidence, materialized: result.copied })
    process.stdout.write(`${JSON.stringify({ ...result.evidence, materialized: result.copied }, null, 2)}\n`)
  } else {
    throw new Error('usage: production-build-artifacts-cli.mjs <create|verify|materialize> [options]')
  }
} catch (error) {
  if (error?.evidence) writeEvidence(options.evidence, error.evidence)
  console.error(`[production-build-artifacts] ${error.message}`)
  process.exit(1)
}
