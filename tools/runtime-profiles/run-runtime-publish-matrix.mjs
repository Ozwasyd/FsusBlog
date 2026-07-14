#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import {
  RUNTIME_MATRIX_EVIDENCE_SCHEMA,
  captureHardwareIdentity,
  createBalancedSchedule,
  sealRuntimeProfileSelection,
  summarizeRuntimeRuns,
  validateRuntimeMatrixEvidence,
  validateRuntimeProfileResult,
  validateRuntimeSelectionPolicy
} from './runtime-publish-evidence.mjs'
import { readRuntimeProfileManifest, sha256Value } from './runtime-publish-profile.mjs'

try {
  const options = parseArgs(process.argv.slice(2))
  for (const key of ['executor', 'output', 'commit-sha', 'fixture-id']) if (!options[key]) throw new Error(`missing --${key}`)
  if (!/^[0-9a-f]{40}$/u.test(options['commit-sha'])) throw new Error('--commit-sha must be a full lowercase Git SHA')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(options['fixture-id'])) throw new Error('--fixture-id is invalid')
  const rounds = parseInteger(options.rounds ?? '3', '--rounds', 1, 30)
  const cooldownMs = parseInteger(options['cooldown-ms'] ?? '30000', '--cooldown-ms', 0, 900000)
  const loaded = readRuntimeProfileManifest(options.manifest)
  const requiredProfiles = loaded.manifest.profiles.filter((profile) => profile.conditionalAdmission === undefined)
  const requiredProfileIds = requiredProfiles.map((profile) => profile.id)
  const selectedIds = options.profiles ? options.profiles.split(',').filter(Boolean) : requiredProfileIds
  if (new Set(selectedIds).size !== selectedIds.length || selectedIds.length < 2) throw new Error('--profiles must contain at least two unique profile ids')
  const profiles = selectedIds.map((id) => {
    const profile = loaded.manifest.profiles.find((candidate) => candidate.id === id)
    if (!profile) throw new Error(`unknown profile in --profiles: ${id}`)
    return profile
  })
  const expectsComplete = rounds >= 3 && sameIds(selectedIds, requiredProfileIds)
  const selectionPolicy = options['selection-policy'] ? readSelectionPolicy(options['selection-policy']) : null
  if (expectsComplete && !selectionPolicy) throw new Error('full matrix requires --selection-policy so production selection is evidence-bound')
  const executor = path.resolve(options.executor)
  if (!fs.statSync(executor).isFile()) throw new Error('--executor must be a regular file')
  const hardware = captureHardwareIdentity()
  const schedule = createBalancedSchedule(selectedIds, rounds, `${options['commit-sha']}:${options['fixture-id']}:${hardware.digest}`)
  const output = path.resolve(options.output)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const runs = options['resume-from']
    ? readResumeRuns(options['resume-from'], {
        options,
        loaded,
        hardware,
        profiles,
        rounds,
        cooldownMs,
        schedule,
        selectionPolicy
      })
    : []
  const workRoot = fs.mkdtempSync(path.join(path.dirname(output), '.runtime-matrix-'))
  try {
    for (const entry of schedule) {
      if (runs.some((run) => run.status === 'ok' && sameScheduleEntry(run.identity, entry))) continue
      const requestedCooldownMs = runs.length === 0 ? 0 : cooldownMs
      const cooldownStartedAt = Date.now()
      if (requestedCooldownMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, requestedCooldownMs)
      const cooldownObservedMs = runs.length === 0 ? 0 : Date.now() - cooldownStartedAt
      const profile = profiles.find((candidate) => candidate.id === entry.profileId)
      const request = {
        schema: 'fsusblog.runtime-publish-profile-request.v1',
        identity: {
          commitSha: options['commit-sha'],
          fixtureId: options['fixture-id'],
          hardwareDigest: hardware.digest,
          profileManifestDigest: loaded.digest,
          profileDigest: sha256Value(profile),
          profileId: profile.id,
          round: entry.round,
          position: entry.position
        },
        profile,
        hardware: hardware.identity,
        cooldownMs: requestedCooldownMs,
        cooldownObservedMs
      }
      const requestFile = path.join(workRoot, `${entry.round}-${entry.position}-${profile.id}.request.json`)
      const resultFile = path.join(workRoot, `${entry.round}-${entry.position}-${profile.id}.result.json`)
      fs.writeFileSync(requestFile, `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      const startedAt = Date.now()
      const child = spawnSync(process.execPath, [executor, '--request', requestFile, '--output', resultFile], {
        cwd: process.cwd(),
        env: { ...process.env, FSUSBLOG_RUNTIME_MATRIX_EXECUTOR: '1' },
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: Number(options['executor-timeout-ms'] ?? 7_200_000)
      })
      let result
      if (fs.existsSync(resultFile)) {
        try {
          result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
        } catch (error) {
          result = {
            schema: 'fsusblog.runtime-publish-profile-result.v1',
            status: 'failed',
            identity: request.identity,
            error: boundedError(`executor wrote an unreadable result: ${error instanceof Error ? error.message : String(error)}`),
            durationMs: Date.now() - startedAt
          }
        }
      } else {
        result = {
          schema: 'fsusblog.runtime-publish-profile-result.v1',
          status: 'failed',
          identity: request.identity,
          error: boundedError(child.error?.message || child.stderr || `executor exited ${child.status ?? 'without status'}`),
          durationMs: Date.now() - startedAt
        }
      }
      const errors = validateRuntimeProfileResult(result, { ...request.identity, cooldownMs: requestedCooldownMs, expectedProfile: profile, expectedHardware: hardware.identity })
      if (errors.length > 0) {
        result = {
          schema: 'fsusblog.runtime-publish-profile-result.v1',
          status: 'failed',
          identity: request.identity,
          error: boundedError(`executor returned invalid result: ${errors.join('; ')}`),
          durationMs: Date.now() - startedAt
        }
      }
      runs.push(result)
      writeEvidence(output, loaded, hardware, options, profiles, requiredProfileIds, rounds, cooldownMs, schedule, runs, selectionPolicy)
    }
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true })
  }
  const evidence = writeEvidence(output, loaded, hardware, options, profiles, requiredProfileIds, rounds, cooldownMs, schedule, runs, selectionPolicy)
  const errors = validateRuntimeMatrixEvidence(evidence, { requireComplete: expectsComplete })
  if (errors.length > 0) throw new Error(errors.join('\n'))
  console.log(JSON.stringify({
    status: evidence.status,
    output,
    attempts: runs.length,
    successful: runs.filter((run) => run.status === 'ok').length,
    failedAttempts: runs.filter((run) => run.status === 'failed').length
  }))
} catch (error) {
  console.error(`[run-runtime-publish-matrix] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

function writeEvidence(output, loaded, hardware, options, profiles, requiredProfileIds, rounds, cooldownMs, schedule, runs, selectionPolicy) {
  const isFull = rounds >= 3 &&
    sameIds(profiles.map((profile) => profile.id), requiredProfileIds) &&
    schedule.every((entry) => runs.some((run) => run.status === 'ok' && sameScheduleEntry(run.identity, entry)))
  const evidence = {
    schema: RUNTIME_MATRIX_EVIDENCE_SCHEMA,
    status: isFull ? 'complete' : 'partial',
    createdAtUtc: new Date().toISOString(),
    identity: {
      commitSha: options['commit-sha'],
      fixtureId: options['fixture-id'],
      profileManifestDigest: loaded.digest,
      hardwareDigest: hardware.digest
    },
    hardware: hardware.identity,
    rounds,
    cooldownMs,
    profileIds: profiles.map((profile) => profile.id),
    schedule,
    runs,
    comparison: summarizeRuntimeRuns(runs, loaded.manifest.defaultProfile),
    selection: null
  }
  if (isFull) evidence.selection = sealRuntimeProfileSelection(evidence, selectionPolicy)
  const temporary = `${output}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, output)
  return evidence
}

function readResumeRuns(file, expected) {
  const resolved = path.resolve(file)
  if (!fs.statSync(resolved).isFile()) throw new Error('--resume-from must be a regular evidence file')
  const evidence = JSON.parse(fs.readFileSync(resolved, 'utf8'))
  const validationErrors = validateRuntimeMatrixEvidence(evidence, { requireComplete: false })
  if (validationErrors.length > 0) throw new Error(`resume evidence failed validation:\n${validationErrors.join('\n')}`)
  const expectedIdentity = {
    commitSha: expected.options['commit-sha'],
    fixtureId: expected.options['fixture-id'],
    profileManifestDigest: expected.loaded.digest,
    hardwareDigest: expected.hardware.digest
  }
  for (const [field, value] of Object.entries(expectedIdentity)) {
    if (evidence.identity?.[field] !== value) throw new Error(`resume evidence identity.${field} does not match the current matrix`)
  }
  if (sha256Value(evidence.hardware) !== sha256Value(expected.hardware.identity)) throw new Error('resume evidence hardware does not match the current matrix')
  if (evidence.rounds !== expected.rounds) throw new Error('resume evidence rounds do not match the current matrix')
  if (evidence.cooldownMs !== expected.cooldownMs) throw new Error('resume evidence cooldown does not match the current matrix')
  if (sha256Value(evidence.profileIds) !== sha256Value(expected.profiles.map((profile) => profile.id))) throw new Error('resume evidence profiles do not match the current matrix')
  if (sha256Value(evidence.schedule) !== sha256Value(expected.schedule)) throw new Error('resume evidence schedule does not match the current matrix')
  if (evidence.selection !== null && evidence.selection !== undefined) {
    if (!expected.selectionPolicy || sha256Value(evidence.selection.policy) !== sha256Value(expected.selectionPolicy)) {
      throw new Error('resume evidence selection policy does not match the current matrix')
    }
  }
  for (const run of evidence.runs) {
    const profile = expected.profiles.find((candidate) => candidate.id === run.identity?.profileId)
    if (!profile || run.identity?.profileDigest !== sha256Value(profile)) throw new Error(`resume evidence profile digest does not match ${run.identity?.profileId ?? 'unknown'}`)
  }
  return structuredClone(evidence.runs)
}

function sameScheduleEntry(identity, entry) {
  return identity?.round === entry.round && identity?.position === entry.position && identity?.profileId === entry.profileId
}

function sameIds(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value)) && right.every((value) => left.includes(value))
}

function readSelectionPolicy(file) {
  const resolved = path.resolve(file)
  const policy = JSON.parse(fs.readFileSync(resolved, 'utf8'))
  const errors = validateRuntimeSelectionPolicy(policy)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return policy
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${key ?? '<end>'}`)
    options[key.slice(2)] = value
  }
  return options
}

function parseInteger(value, label, minimum, maximum) {
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must be an integer`)
  const parsed = Number(value)
  if (parsed < minimum || parsed > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`)
  return parsed
}

function boundedError(value) {
  return String(value).replace(/[\r\n]+/gu, ' ').trim().slice(0, 2048) || 'executor failed without diagnostics'
}
