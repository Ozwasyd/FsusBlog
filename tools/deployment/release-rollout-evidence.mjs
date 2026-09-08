#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { ROLLOUT_STAGES, readRolloutState } from './release-rollout-lib.mjs'

import { STAGE_SCHEMA, FINAL_SCHEMA, REQUIRED_FINAL_ARTIFACTS, REQUIRED_AUXILIARY_EVIDENCE, validateRecoveryResolution, validateAuxiliaryEvidence, validateSemanticArtifact, verifyReleaseRolloutEvidence } from './release-rollout-evidence-receipt-contract.mjs'

try {
  const { command, options, artifacts, auxiliaries } = parseArgs(process.argv.slice(2))
  if (command === 'stage') {
    emitStageEvidence(options)
  } else if (command === 'preseal') {
    presealEvidence(options, artifacts, auxiliaries)
  } else if (command === 'finalize') {
    finalizeEvidence(options, artifacts, auxiliaries)
  } else if (command === 'verify') {
    const report = verifyFinalEvidence(requiredPath(options, 'evidence'))
    process.stdout.write(`${JSON.stringify(report)}\n`)
    if (report.status !== 'pass') process.exitCode = 1
  } else {
    throw new Error('usage: release-rollout-evidence.mjs <stage|preseal|finalize|verify> [options]')
  }
} catch (error) {
  process.stderr.write(`[release-rollout-evidence] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

function presealEvidence(options, artifactInputs, auxiliaryInputs) {
  const stateFile = requiredPath(options, 'state')
  const state = readRolloutState(stateFile)
  if (state.status !== 'running' || state.currentStage !== 'release-evidence') {
    throw new Error('preseal is allowed only while the final release-evidence stage is running')
  }
  if (state.completedStages.join('\n') !== ROLLOUT_STAGES.slice(0, -1).join('\n')) {
    throw new Error('preseal requires every preceding rollout stage in exact order')
  }
  const errors = []
  const artifacts = collectArtifacts(artifactInputs, errors, state)
  const auxiliary = collectAuxiliaryEvidence(auxiliaryInputs, errors, state)
  const report = {
    schema: 'fsusblog.release-rollout-preseal.v1',
    status: errors.length === 0 ? 'pass' : 'fail',
    rolloutId: state.rolloutId,
    source: state.source,
    target: state.target,
    gatewayGeneration: state.gatewayGeneration,
    completedStages: state.completedStages,
    artifacts,
    auxiliary,
    errors,
    observedAtUtc: new Date().toISOString()
  }
  writeJsonExclusiveOrReplace(requiredPath(options, 'out'), report, options.replace === true)
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (errors.length > 0) process.exitCode = 1
}

function emitStageEvidence(options) {
  const stateFile = requiredPath(options, 'state')
  const state = readRolloutState(stateFile)
  const stage = required(options, 'stage')
  if (!ROLLOUT_STAGES.includes(stage)) throw new Error(`unknown rollout stage: ${stage}`)
  if (state.currentStage !== stage) throw new Error(`rollout state is not executing ${stage}`)
  const status = required(options, 'status')
  if (!['ok', 'failed'].includes(status)) throw new Error('--status must be ok or failed')
  const exitCode = nonNegativeInteger(options['exit-code'], 'exit-code')
  if ((status === 'ok') !== (exitCode === 0)) throw new Error('stage status and exit code disagree')
  const startedAtUtc = isoUtc(required(options, 'started-at'), 'started-at')
  const completedAtUtc = isoUtc(options['completed-at'] ?? new Date().toISOString(), 'completed-at')
  if (Date.parse(completedAtUtc) < Date.parse(startedAtUtc)) throw new Error('stage completion precedes start')
  const stdout = fileMetadata(requiredPath(options, 'stdout'))
  const stderr = fileMetadata(requiredPath(options, 'stderr'))
  const attempts = state.stages.filter(record => record.stage === stage).length
  const evidence = {
    schema: STAGE_SCHEMA,
    rolloutId: state.rolloutId,
    stage,
    attempt: attempts,
    status,
    exitCode,
    commandId: boundedLabel(required(options, 'command-id'), 'command-id'),
    source: state.source,
    target: state.target,
    startedAtUtc,
    completedAtUtc,
    durationMs: Date.parse(completedAtUtc) - Date.parse(startedAtUtc),
    output: { stdout, stderr }
  }
  writeJsonExclusiveOrReplace(requiredPath(options, 'out'), evidence, options.replace === true)
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
}

function finalizeEvidence(options, artifactInputs, auxiliaryInputs) {
  const stateFile = requiredPath(options, 'state')
  const state = readRolloutState(stateFile)
  if (state.status !== 'running' || state.currentStage !== null) {
    throw new Error('rollout state must have all stages completed and no active stage before final evidence is sealed')
  }
  if (!state.switchCommitted || !Number.isSafeInteger(state.gatewayGeneration)) {
    throw new Error('completed rollout lacks a committed gateway generation')
  }
  if (state.completedStages.join('\n') !== ROLLOUT_STAGES.join('\n')) {
    throw new Error('completed rollout does not contain the exact ordered stage set')
  }

  const errors = []
  const stages = []
  for (const stage of ROLLOUT_STAGES) {
    const attempts = state.stages.filter(record => record.stage === stage)
    const successful = attempts.filter(record => record.status === 'ok')
    if (successful.length !== 1) errors.push(`${stage}: expected exactly one successful terminal attempt`)
    const attemptEvidence = attempts.map((attempt, index) => {
      if (!attempt.evidencePath) {
        errors.push(`${stage}: attempt ${index + 1} evidence path is missing`)
        return { attempt: index + 1, status: attempt.status, errorCode: attempt.errorCode, evidence: null }
      }
      try {
        const metadata = fileMetadata(attempt.evidencePath)
        const parsed = readJson(attempt.evidencePath)
        if (parsed.schema !== STAGE_SCHEMA || parsed.rolloutId !== state.rolloutId || parsed.stage !== stage || parsed.status !== attempt.status) {
          errors.push(`${stage}: attempt ${index + 1} evidence identity/status is invalid`)
        }
        return { attempt: index + 1, status: attempt.status, errorCode: attempt.errorCode, evidence: metadata }
      } catch (error) {
        errors.push(`${stage}: attempt ${index + 1}: ${message(error)}`)
        return { attempt: index + 1, status: attempt.status, errorCode: attempt.errorCode, evidence: null }
      }
    })
    const record = successful.at(-1)
    if (!record?.evidencePath) {
      errors.push(`${stage}: stage evidence path is missing`)
      continue
    }
    try {
      const metadata = fileMetadata(record.evidencePath)
      const parsed = readJson(record.evidencePath)
      if (parsed.schema !== STAGE_SCHEMA || parsed.rolloutId !== state.rolloutId || parsed.stage !== stage || parsed.status !== 'ok') {
        errors.push(`${stage}: stage evidence identity/status is invalid`)
      }
      stages.push({ stage, attempts: attempts.length, attemptEvidence, evidence: metadata })
    } catch (error) {
      errors.push(`${stage}: ${message(error)}`)
    }
  }

  const artifacts = collectArtifacts(artifactInputs, errors, state)
  const auxiliary = collectAuxiliaryEvidence(auxiliaryInputs, errors, state)

  validateRecoveryResolution(state.recoveries, errors)
  const recoveries = collectRecoveries(state.recoveries, errors)
  const evidence = {
    schema: FINAL_SCHEMA,
    status: errors.length === 0 ? 'pass' : 'fail',
    rolloutId: state.rolloutId,
    kind: state.kind,
    source: state.source,
    target: state.target,
    gatewayGeneration: state.gatewayGeneration,
    rollback: {
      allowed: state.rollbackAllowed,
      contractMigrationApplied: state.contractMigrationApplied,
      target: state.source
    },
    stages,
    recoveries,
    artifacts,
    auxiliary,
    errors,
    sealedAtUtc: new Date().toISOString()
  }
  const output = requiredPath(options, 'out')
  writeJsonExclusiveOrReplace(output, evidence, false)
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  if (errors.length > 0) process.exitCode = 1
}

function collectRecoveries(records, errors) {
  return records.map(record => {
    let evidence = null
    if (!record.evidencePath) {
      errors.push(`rollout recovery evidence is missing: ${record.action ?? '<missing>'}`)
    } else {
      try {
        evidence = fileMetadata(record.evidencePath)
      } catch (error) {
        errors.push(`recovery ${record.action}: ${message(error)}`)
      }
    }
    return { ...record, evidence }
  })
}

function collectArtifacts(artifactInputs, errors, state) {
  const artifactMap = new Map()
  for (const input of artifactInputs) {
    const separator = input.indexOf('=')
    if (separator <= 0) throw new Error(`invalid --artifact value: ${input}`)
    const name = boundedLabel(input.slice(0, separator), 'artifact name')
    const file = path.resolve(input.slice(separator + 1))
    if (artifactMap.has(name)) throw new Error(`duplicate artifact: ${name}`)
    artifactMap.set(name, file)
  }
  for (const name of artifactMap.keys()) {
    if (!REQUIRED_FINAL_ARTIFACTS.includes(name)) errors.push(`unexpected artifact is not allowlisted: ${name}`)
  }
  for (const name of REQUIRED_FINAL_ARTIFACTS) {
    if (!artifactMap.has(name)) errors.push(`required artifact is missing: ${name}`)
  }
  const artifacts = {}
  for (const [name, file] of artifactMap) {
    try {
      const parsed = readJson(file)
      if (parsed.rolloutId !== state.rolloutId) errors.push(`${name}: rolloutId does not match the durable rollout`)
      if (parsed.target?.releaseId !== undefined && parsed.target.releaseId !== state.target.releaseId) errors.push(`${name}: target release does not match`)
      if (parsed.target?.imageDigest !== undefined && parsed.target.imageDigest !== state.target.imageDigest) errors.push(`${name}: target digest does not match`)
      if (parsed.sourceReleaseId !== undefined && parsed.sourceReleaseId !== state.source.releaseId) errors.push(`${name}: source release does not match`)
      if (parsed.targetReleaseId !== undefined && parsed.targetReleaseId !== state.target.releaseId) errors.push(`${name}: target release does not match`)
      validateSemanticArtifact(name, parsed, errors)
      artifacts[name] = { ...fileMetadata(file), schema: parsed.schema ?? null, status: parsed.status ?? null }
    } catch (error) {
      errors.push(`${name}: ${message(error)}`)
    }
  }
  return artifacts
}

function collectAuxiliaryEvidence(inputs, errors, state) {
  const inputMap = new Map()
  for (const input of inputs) {
    const separator = input.indexOf('=')
    if (separator <= 0) throw new Error(`invalid --auxiliary value: ${input}`)
    const name = boundedLabel(input.slice(0, separator), 'auxiliary evidence name')
    const file = path.resolve(input.slice(separator + 1))
    if (inputMap.has(name)) throw new Error(`duplicate auxiliary evidence: ${name}`)
    inputMap.set(name, file)
  }
  for (const name of inputMap.keys()) {
    if (!REQUIRED_AUXILIARY_EVIDENCE.includes(name)) errors.push(`unexpected auxiliary evidence is not allowlisted: ${name}`)
  }
  for (const name of REQUIRED_AUXILIARY_EVIDENCE) {
    if (!inputMap.has(name)) errors.push(`required auxiliary evidence is missing: ${name}`)
  }
  const auxiliary = {}
  for (const name of REQUIRED_AUXILIARY_EVIDENCE) {
    const file = inputMap.get(name)
    if (!file) continue
    try {
      const parsed = readJson(file)
      validateAuxiliaryEvidence(name, parsed, state, errors, Date.now())
      auxiliary[name] = { ...fileMetadata(file), schema: parsed.schema ?? null, status: parsed.status ?? null }
    } catch (error) {
      errors.push(`${name}: ${message(error)}`)
    }
  }
  return auxiliary
}

function verifyFinalEvidence(file) {
  try {
    return verifyReleaseRolloutEvidence(JSON.parse(readEvidenceBytes(file).toString('utf8')), {
      evidencePath: path.resolve(file),
      now: Date.now(),
      readBytes: readEvidenceBytes
    })
  } catch (error) {
    return { schema: 'fsusblog.release-rollout-evidence-verification.v1', status: 'fail', errors: [message(error)] }
  }
}

function readEvidenceBytes(file) {
  const resolved = path.resolve(file)
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const before = fs.fstatSync(descriptor, { bigint: true })
    if (!before.isFile()) throw new Error(`evidence input must be a regular non-symlink file: ${resolved}`)
    const bytes = fs.readFileSync(descriptor)
    const after = fs.fstatSync(descriptor, { bigint: true })
    const current = fs.lstatSync(resolved, { bigint: true })
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino
      || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(field => before[field] !== after[field])) {
      throw new Error(`evidence input changed while reading: ${resolved}`)
    }
    return bytes
  } finally {
    fs.closeSync(descriptor)
  }
}

function parseArgs(argv) {
  const command = argv.shift()
  const options = {}
  const artifacts = []
  const auxiliaries = []
  while (argv.length > 0) {
    const name = argv.shift()
    if (!name?.startsWith('--')) throw new Error(`invalid argument: ${name ?? '<end>'}`)
    if (name === '--replace') {
      options.replace = true
      continue
    }
    const value = argv.shift()
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
    if (name === '--artifact') artifacts.push(value)
    else if (name === '--auxiliary') auxiliaries.push(value)
    else options[name.slice(2)] = value
  }
  return { command, options, artifacts, auxiliaries }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function fileMetadata(file) {
  const resolved = path.resolve(file)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`evidence input must be a regular non-symlink file: ${resolved}`)
  const hash = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')
  return { path: resolved, bytes: stat.size, sha256: `sha256:${hash}` }
}

function writeJsonExclusiveOrReplace(file, value, replace) {
  const resolved = path.resolve(file)
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 })
  const flags = replace ? 'w' : 'wx'
  const descriptor = fs.openSync(resolved, flags, 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function required(options, name) {
  const value = options[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`--${name} is required`)
  return value
}

function requiredPath(options, name) {
  return path.resolve(required(options, name))
}

function boundedLabel(value, label) {
  const result = String(value ?? '')
  if (!/^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/u.test(result)) throw new Error(`${label} is invalid`)
  return result
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`)
  return parsed
}

function isoUtc(value, label) {
  const result = String(value ?? '')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new Error(`${label} must be ISO UTC`)
  }
  return result
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}
