#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { ROLLOUT_STAGES } from './release-rollout-lib.mjs'

const EVIDENCE_SCHEMA = 'fsusblog.release-traffic-evidence.v1'
const VERIFICATION_SCHEMA = 'fsusblog.release-traffic-evidence-verification.v1'
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const HMAC_SHA256 = /^hmac-sha256:[0-9a-f]{64}$/u
const CATEGORIES = Object.freeze([
  'home', 'archive', 'article', 'binary', 'search', 'static',
  'login', 'refresh', 'protected-read', 'write', 'upload', 'admin-health'
])
const POLICY_STAGES = Object.freeze(['status:planned', ...ROLLOUT_STAGES, 'status:completed'])

try {
  const options = parseArgs(process.argv.slice(2))
  const report = verifyTrafficEvidence(options)
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (report.status !== 'pass') process.exitCode = 1
} catch (error) {
  process.stderr.write(`[release-traffic-evidence-verify] fatal: ${message(error)}\n`)
  process.exitCode = 1
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`invalid argument near ${name ?? '<end>'}`)
    }
    const key = name.slice(2)
    if (Object.hasOwn(options, key)) throw new Error(`duplicate argument --${key}`)
    options[key] = value
  }
  for (const name of ['evidence', 'scenario', 'binding-key-file', 'rollout-id']) {
    if (!options[name]) throw new Error(`--${name} is required`)
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/u.test(options['rollout-id'])) {
    throw new Error('--rollout-id is invalid')
  }
  return {
    evidence: canonicalRegularFile(options.evidence, 'evidence'),
    scenario: canonicalRegularFile(options.scenario, 'scenario'),
    bindingKeyFile: canonicalPrivateFile(options['binding-key-file'], 'binding key file'),
    rolloutId: options['rollout-id']
  }
}

function verifyTrafficEvidence(options) {
  const errors = []
  const evidence = readJson(options.evidence, 'traffic evidence')
  const scenario = readJson(options.scenario, 'traffic scenario')
  const key = fs.readFileSync(options.bindingKeyFile)
  if (key.length < 32 || key.length > 4096) errors.push('binding key must contain 32..4096 bytes')

  if (scenario.schema !== 'fsusblog.release-traffic-scenario.v1'
    || scenario.finalBinding?.schema !== 'fsusblog.release-traffic-final-binding-plan.v1'
    || scenario.finalBinding?.required !== true
    || scenario.finalBinding?.algorithm !== 'hmac-sha256') {
    errors.push('scenario does not require the HMAC final binding contract')
  }
  validateStrongSemantics(evidence, options.rolloutId, errors)

  const scenarioSha256 = hashFile(options.scenario)
  const binding = evidence.finalBinding
  if (!isObject(binding)
    || binding.schema !== 'fsusblog.release-traffic-final-binding.v1'
    || binding.algorithm !== 'hmac-sha256') {
    errors.push('final binding schema/algorithm is invalid')
  } else {
    const { finalBinding: ignored, ...unsignedReport } = evidence
    const payloadSha256 = sha256(canonicalJson(unsignedReport))
    if (binding.rolloutId !== options.rolloutId) errors.push('final binding rolloutId mismatch')
    if (binding.scenarioSha256 !== scenarioSha256) errors.push('final binding scenario hash mismatch')
    if (binding.payloadSha256 !== payloadSha256) errors.push('final binding payload hash mismatch')
    if (!SHA256.test(String(binding.initialRolloutStateSha256 ?? ''))
      || !SHA256.test(String(binding.finalRolloutStateSha256 ?? ''))) {
      errors.push('final binding rollout-state hashes are invalid')
    }
    if (binding.observationCount !== evidence.observationBinding?.observationCount
      || binding.observationHashChain !== evidence.observationBinding?.chainHeadSha256) {
      errors.push('final binding observation identity mismatch')
    }
    const expectedKeyId = hmacSha256(key, 'fsusblog.release-traffic-binding-key-id.v1')
    if (binding.keyId !== expectedKeyId || !HMAC_SHA256.test(String(binding.keyId ?? ''))) {
      errors.push('final binding keyId mismatch')
    }
    const { signature: ignoredSignature, ...unsignedBinding } = binding
    const expectedSignature = hmacSha256(key, canonicalJson(unsignedBinding))
    if (binding.signature !== expectedSignature || !HMAC_SHA256.test(String(binding.signature ?? ''))) {
      errors.push('final binding signature mismatch')
    }
  }
  key.fill(0)

  return {
    schema: VERIFICATION_SCHEMA,
    status: errors.length === 0 ? 'pass' : 'fail',
    rolloutId: options.rolloutId,
    evidenceSha256: hashFile(options.evidence),
    scenarioSha256,
    errors
  }
}

function validateStrongSemantics(value, rolloutId, errors) {
  if (!isObject(value) || value.schema !== EVIDENCE_SCHEMA) errors.push(`schema must be ${EVIDENCE_SCHEMA}`)
  if (value.status !== 'pass') errors.push('traffic evidence status must be pass')
  if (value.probeMode !== 'public-rollout') errors.push('traffic evidence must use public-rollout mode')
  if (value.rolloutId !== rolloutId) errors.push('traffic evidence rolloutId mismatch')
  if (!Array.isArray(value.errors) || value.errors.length !== 0) errors.push('traffic evidence errors must be empty')
  for (const field of [
    'unexpectedResponseCount', 'deploymentFailureCount', 'connectionErrorCount',
    'gatewayErrorCount', 'unhandled5xxCount', 'inFlightAbortedCount', 'inFlightRequestCount'
  ]) {
    if (Number(value[field]) !== 0) errors.push(`${field} must be zero`)
  }
  if (!Number.isSafeInteger(value.totalRequests) || value.totalRequests <= 0) errors.push('totalRequests must be positive')
  if (!(Number(value.releaseDistribution?.source) > 0) || !(Number(value.releaseDistribution?.target) > 0)) {
    errors.push('source and target releases must both be observed')
  }

  const policy = value.releaseIdentityPolicy
  const expectedCoverage = POLICY_STAGES.flatMap(stage => CATEGORIES.map(category => `${stage}/${category}`)).sort()
  const coverageKeys = isObject(policy?.coverage) ? Object.keys(policy.coverage).sort() : []
  if (policy?.required !== true || policy?.scenarioRequired !== true || policy?.mode !== 'public-rollout'
    || Number(policy?.violationCount) !== 0) {
    errors.push('release identity policy result is invalid')
  }
  if (coverageKeys.join('\n') !== expectedCoverage.join('\n')
    || coverageKeys.some(key => !Number.isSafeInteger(policy.coverage[key]) || policy.coverage[key] < 0)) {
    errors.push('release identity policy does not expose the exact 17 x 12 coverage ledger')
  }

  if (!Array.isArray(value.requiredCategories)
    || value.requiredCategories.join('\n') !== CATEGORIES.join('\n')) {
    errors.push('required traffic categories are incomplete or out of order')
  }
  const sessionChains = isObject(value.sessionChains) ? Object.values(value.sessionChains) : []
  if (sessionChains.length === 0 || sessionChains.some(chain => !(Number(chain.completedCycles) > 0) || Number(chain.failedCycles) !== 0)) {
    errors.push('session chains must complete without failed cycles')
  }
  const holds = isObject(value.gatewaySwitchHolds) ? Object.values(value.gatewaySwitchHolds) : []
  if (holds.length === 0 || holds.some(hold => hold.required !== true
    || !(Number(hold.attempts) > 0)
    || !(Number(hold.passCount) > 0)
    || Number(hold.failCount) !== 0
    || !Array.isArray(hold.observations)
    || !hold.observations.some(observation => observation?.pass === true
      && observation?.startedAt?.switchCommitted === false
      && observation?.completedAt?.switchCommitted === true
      && observation?.releaseRole === 'target'
      && SHA256.test(String(observation?.bindingSha256 ?? ''))))) {
    errors.push('gateway-switch hold evidence is incomplete')
  }

  const observations = value.observationBinding
  const digests = Array.isArray(observations?.observationSha256) ? observations.observationSha256 : []
  if (observations?.schema !== 'fsusblog.release-traffic-observation-chain.v1'
    || observations?.algorithm !== 'sha256-chain'
    || !(Number(observations?.observationCount) > 0)
    || observations.observationCount !== digests.length
    || digests.some(digest => !SHA256.test(String(digest)))) {
    errors.push('observation binding ledger is invalid')
  } else {
    let head = sha256('fsusblog.release-traffic-observation-chain.v1')
    for (const digest of digests) head = sha256(`${head}\0${digest}`)
    if (head !== observations.chainHeadSha256) errors.push('observation hash chain mismatch')
  }
  if (!SHA256.test(String(observations?.scenarioSha256 ?? ''))
    || !SHA256.test(String(observations?.initialRolloutStateSha256 ?? ''))) {
    errors.push('observation input hashes are invalid')
  }

  const responseObservations = Array.isArray(value.responseObservations) ? value.responseObservations : []
  const aedsVerified = responseObservations.some(record => record?.category === 'binary'
    && Array.isArray(record?.lastObservation?.aeds?.checks)
    && record.lastObservation.aeds.checks.length >= 7
    && record.lastObservation.aeds.checks.every(check => check?.pass === true))
  if (!aedsVerified) errors.push('no successful AEDS v2 byte-level observation is present')
}

function canonicalRegularFile(file, label) {
  const resolved = path.resolve(file)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  return fs.realpathSync(resolved)
}

function canonicalPrivateFile(file, label) {
  const resolved = canonicalRegularFile(file, label)
  const mode = fs.statSync(resolved).mode & 0o777
  if (![0o400, 0o600].includes(mode)) throw new Error(`${label} must have mode 0400 or 0600`)
  return resolved
}

function readJson(file, label) {
  let value
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { throw new Error(`${label}: ${message(error)}`) }
  if (!isObject(value)) throw new Error(`${label} must contain a JSON object`)
  return value
}

function hashFile(file) {
  return sha256(fs.readFileSync(file))
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function hmacSha256(key, value) {
  return `hmac-sha256:${crypto.createHmac('sha256', key).update(value).digest('hex')}`
}

function canonicalJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}
