import { isPlainObject } from '../lib/canonicalize.mjs'
import {
  producePostRuntimeObservation,
  verifyPostRuntimeObservation
} from './adapter.mjs'

export const releaseDeploymentProducerId = 'release-deployment-observation-producer'

const fieldContracts = Object.freeze({
  'release-identity-readiness': [
    'imageDigest', 'packageDigest', 'configDigest', 'schemaDigest',
    'manifestDigest', 'signingDigest', 'trustDigest', 'readinessReceiptDigest',
    'serviceReady', 'routeDataReady', 'cacheReady', 'dependenciesReady',
    'versionReady', 'credentialReady', 'identityMatch',
    'runtimeRoleContractSatisfied', 'monolithicOwnershipSatisfied'
  ],
  'blue-green-switch-rollback-containment': [
    'activeBeforeDigest', 'standbyBeforeDigest', 'activeAfterDigest',
    'standbyAfterDigest', 'promotionReceiptDigest', 'switchReceiptDigest',
    'healthReceiptDigest', 'rollbackReceiptDigest', 'failureReceiptDigest',
    'trafficOwnershipDigest', 'artifactContainmentDigest',
    'volumeContainmentDigest', 'schemaContainmentDigest',
    'processContainmentDigest', 'cleanupReceiptDigest', 'terminalReceiptDigest',
    'activeReleaseProtected', 'activeIdentityKnown', 'switchComplete',
    'splitBrainAbsent', 'cleanupInactiveOnly', 'sharedFactsPreserved',
    'runtimeRoleContractSatisfied'
  ]
})

const digestPattern = /^(?:sha256:)?[a-f0-9]{64}$/u

function fail(message) { throw new Error(`[release-deployment-observation] ${message}`) }

function exactFacts(observationClass, facts)
{
  if (!isPlainObject(facts)) fail(`${observationClass} facts must be an object`)
  const fields = fieldContracts[observationClass]
  if (!fields) fail(`unknown observation class ${observationClass}`)
  if (Object.keys(facts).sort().join('\0') !== [...fields].sort().join('\0'))
  {
    fail(`${observationClass} facts have unsupported or missing fields`)
  }
  return fields
}

function requireDigests(facts, fields, observationClass)
{
  for (const field of fields)
  {
    if (!digestPattern.test(String(facts[field] ?? ''))) fail(`${observationClass}.${field} must be a sealed digest`)
  }
}

function requireTrue(facts, fields, observationClass)
{
  for (const field of fields)
  {
    if (facts[field] !== true) fail(`${observationClass}.${field} must be true`)
  }
}

export function validateReleaseDeploymentFacts(observationClass, facts)
{
  const fields = exactFacts(observationClass, facts)
  if (observationClass === 'release-identity-readiness')
  {
    const booleanFields = [
      'serviceReady', 'routeDataReady', 'cacheReady', 'dependenciesReady',
      'versionReady', 'credentialReady', 'identityMatch',
      'runtimeRoleContractSatisfied', 'monolithicOwnershipSatisfied'
    ]
    requireDigests(facts, fields.filter((field) => !booleanFields.includes(field)), observationClass)
    requireTrue(facts, booleanFields, observationClass)
    return true
  }
  const booleanFields = [
    'activeReleaseProtected', 'activeIdentityKnown', 'switchComplete',
    'splitBrainAbsent', 'cleanupInactiveOnly', 'sharedFactsPreserved',
    'runtimeRoleContractSatisfied'
  ]
  requireDigests(facts, fields.filter((field) => !booleanFields.includes(field)), observationClass)
  requireTrue(facts, booleanFields, observationClass)
  return true
}

// BEHAVIOR-OWNER: release-deployment-runtime-containment
export function produceReleaseDeploymentObservation(inputs)
{
  return producePostRuntimeObservation({
    ...inputs,
    producerId: releaseDeploymentProducerId,
    validateFacts: validateReleaseDeploymentFacts
  })
}

export function verifyReleaseDeploymentObservation({ receipt, ...inputs })
{
  return verifyPostRuntimeObservation({
    ...inputs,
    receipt,
    produce: produceReleaseDeploymentObservation
  })
}

export function extract(context)
{
  return produceReleaseDeploymentObservation(context)
}
