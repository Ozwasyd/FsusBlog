import crypto from 'node:crypto'

import { ROLLOUT_STAGES } from './release-rollout-evidence-constants.mjs'

const TRAFFIC_CATEGORIES = Object.freeze([
  'home', 'archive', 'article', 'binary', 'search', 'static',
  'login', 'refresh', 'protected-read', 'write', 'upload', 'admin-health'
])
const TRAFFIC_POLICY_STAGES = Object.freeze(['status:planned', ...ROLLOUT_STAGES, 'status:completed'])
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const HMAC_SHA256 = /^hmac-sha256:[0-9a-f]{64}$/u

export function validateStrongTrafficEvidence(value, name, errors) {
  if (value.probeMode !== 'public-rollout') errors.push(`${name}: probeMode must be public-rollout`)
  const policy = value.releaseIdentityPolicy
  if (policy?.required !== true || policy?.scenarioRequired !== true || policy?.mode !== 'public-rollout'
    || Number(policy?.violationCount) !== 0) {
    errors.push(`${name}: release identity policy result is invalid`)
  }
  const expectedCoverage = TRAFFIC_POLICY_STAGES.flatMap(stage => TRAFFIC_CATEGORIES.map(category => `${stage}/${category}`)).sort()
  const actualCoverage = policy?.coverage && typeof policy.coverage === 'object' && !Array.isArray(policy.coverage)
    ? Object.keys(policy.coverage).sort()
    : []
  if (actualCoverage.join('\n') !== expectedCoverage.join('\n')
    || actualCoverage.some(key => !Number.isSafeInteger(policy.coverage[key]) || policy.coverage[key] < 0)) {
    errors.push(`${name}: exact 17 x 12 release identity coverage ledger is missing`)
  }
  if (!Array.isArray(value.requiredCategories)
    || value.requiredCategories.join('\n') !== TRAFFIC_CATEGORIES.join('\n')) {
    errors.push(`${name}: required categories are incomplete`)
  }
  const sessions = value.sessionChains && typeof value.sessionChains === 'object' && !Array.isArray(value.sessionChains)
    ? Object.values(value.sessionChains)
    : []
  if (sessions.length === 0 || sessions.some(session => !(Number(session.completedCycles) > 0) || Number(session.failedCycles) !== 0)) {
    errors.push(`${name}: real session chain evidence is incomplete`)
  }
  const holds = value.gatewaySwitchHolds && typeof value.gatewaySwitchHolds === 'object' && !Array.isArray(value.gatewaySwitchHolds)
    ? Object.values(value.gatewaySwitchHolds)
    : []
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
    errors.push(`${name}: gateway-switch hold evidence is incomplete`)
  }
  const observation = value.observationBinding
  const digests = Array.isArray(observation?.observationSha256) ? observation.observationSha256 : []
  if (observation?.schema !== 'fsusblog.release-traffic-observation-chain.v1'
    || observation?.algorithm !== 'sha256-chain'
    || !(Number(observation?.observationCount) > 0)
    || observation.observationCount !== digests.length
    || digests.some(digest => !SHA256.test(String(digest)))) {
    errors.push(`${name}: observation binding ledger is invalid`)
  } else {
    let head = sha256Text('fsusblog.release-traffic-observation-chain.v1')
    for (const digest of digests) head = sha256Text(`${head}\0${digest}`)
    if (head !== observation.chainHeadSha256) errors.push(`${name}: observation hash chain is invalid`)
  }
  const responses = Array.isArray(value.responseObservations) ? value.responseObservations : []
  if (!responses.some(record => record?.category === 'binary'
    && Array.isArray(record?.lastObservation?.aeds?.checks)
    && record.lastObservation.aeds.checks.length >= 7
    && record.lastObservation.aeds.checks.every(check => check?.pass === true))) {
    errors.push(`${name}: successful AEDS v2 byte evidence is missing`)
  }
  const binding = value.finalBinding
  const { finalBinding: ignored, ...unsignedValue } = value
  if (binding?.schema !== 'fsusblog.release-traffic-final-binding.v1'
    || binding?.algorithm !== 'hmac-sha256'
    || !HMAC_SHA256.test(String(binding?.keyId ?? ''))
    || !HMAC_SHA256.test(String(binding?.signature ?? ''))
    || binding?.rolloutId !== value.rolloutId
    || binding?.scenarioSha256 !== observation?.scenarioSha256
    || binding?.initialRolloutStateSha256 !== observation?.initialRolloutStateSha256
    || !SHA256.test(String(binding?.finalRolloutStateSha256 ?? ''))
    || binding?.observationCount !== observation?.observationCount
    || binding?.observationHashChain !== observation?.chainHeadSha256
    || binding?.payloadSha256 !== sha256Text(canonicalJson(unsignedValue))) {
    errors.push(`${name}: HMAC final binding structure or payload binding is invalid`)
  }
}

function sha256Text(value)
{
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value)
{
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}
