import { isPlainObject } from '../lib/canonicalize.mjs'
import {
  producePostRuntimeObservation,
  verifyPostRuntimeObservation
} from './adapter.mjs'

export const applicationRuntimeProducerId = 'application-runtime-observation-producer'

const fieldContracts = Object.freeze({
  'route-response-error-semantics': [
    'statusCode', 'typedResult', 'protocolIdentity', 'contentIdentity',
    'authSemantics', 'permissionSemantics', 'visibilitySemantics',
    'cacheSemantics', 'semanticMatch'
  ],
  'aot-hydration-coherence': [
    'buildDigest', 'manifestDigest', 'publicationDigest', 'localeCanaryDigest',
    'dataCanaryDigest', 'serverHtmlDigest', 'hydratedDomDigest',
    'clientStateDigest', 'networkResourceDigest', 'coherent'
  ],
  'cache-search-outbox-convergence': [
    'authorityCoordinateDigest', 'eventDigest', 'edgeDigest', 'generationDigest',
    'queryDigest', 'readModelDigest', 'outputDigest', 'terminalReceiptDigest',
    'terminalState', 'coherent'
  ],
  'session-cookie-runtime-coherence': [
    'databaseSessionDigest', 'credentialDigest', 'authContextDigest', 'jwtDigest',
    'cookieDigest', 'storageClaimsDigest', 'expiryDigest', 'revisionDigest',
    'deviceDigest', 'serviceResultDigest', 'coherent'
  ],
  'browser-behavior-contract': [
    'requiredTestIds', 'viewportId', 'themeId', 'stateId', 'interactionDigest',
    'domDigest', 'a11yDigest', 'networkDigest', 'consoleDigest',
    'contractSatisfied', 'consoleClean', 'screenshotOnly'
  ]
})

const digestPattern = /^(?:sha256:)?[a-f0-9]{64}$/u

function fail(message) { throw new Error(`[application-runtime-observation] ${message}`) }

function exactFacts(observationClass, facts)
{
  if (!isPlainObject(facts)) fail(`${observationClass} facts must be an object`)
  const fields = fieldContracts[observationClass]
  if (!fields) fail(`unknown observation class ${observationClass}`)
  if (Object.keys(facts).sort().join('\0') !== [...fields].sort().join('\0'))
  {
    fail(`${observationClass} facts have unsupported or missing fields`)
  }
}

function requireStringFacts(facts, fields, observationClass)
{
  for (const field of fields)
  {
    if (typeof facts[field] !== 'string' || facts[field].length === 0) fail(`${observationClass}.${field} is required`)
  }
}

function requireDigests(facts, fields, observationClass)
{
  for (const field of fields)
  {
    if (!digestPattern.test(String(facts[field] ?? ''))) fail(`${observationClass}.${field} must be a sealed digest`)
  }
}

export function validateApplicationRuntimeFacts(observationClass, facts)
{
  exactFacts(observationClass, facts)
  if (observationClass === 'route-response-error-semantics')
  {
    if (!Number.isInteger(facts.statusCode) || facts.statusCode < 100 || facts.statusCode > 599) fail('route statusCode is invalid')
    if (!['payload', 'typed-error'].includes(facts.typedResult)) fail('route typedResult must be payload or typed-error')
    requireStringFacts(facts, [
      'protocolIdentity', 'contentIdentity', 'authSemantics', 'permissionSemantics',
      'visibilitySemantics', 'cacheSemantics'
    ], observationClass)
    if (facts.semanticMatch !== true) fail('route semantic identity mismatch (HTTP status alone cannot qualify)')
    return true
  }
  if (observationClass === 'aot-hydration-coherence')
  {
    requireDigests(facts, fieldContracts[observationClass].filter((field) => field !== 'coherent'), observationClass)
    if (facts.coherent !== true) fail('AOT/hydration canary, manifest, DOM, state, or resource identity is stale')
    return true
  }
  if (observationClass === 'cache-search-outbox-convergence')
  {
    requireDigests(facts, fieldContracts[observationClass].filter((field) => !['terminalState', 'coherent'].includes(field)), observationClass)
    if (facts.terminalState !== 'converged' || facts.coherent !== true) fail('cache/search/outbox edge is stale or partial')
    return true
  }
  if (observationClass === 'session-cookie-runtime-coherence')
  {
    requireDigests(facts, fieldContracts[observationClass].filter((field) => field !== 'coherent'), observationClass)
    if (facts.coherent !== true) fail('DB session, credential, JWT, Cookie, storage, or service claims mismatch')
    return true
  }
  const requiredTestIds = facts.requiredTestIds
  if (!Array.isArray(requiredTestIds) || requiredTestIds.length === 0
    || requiredTestIds.some((testId) => typeof testId !== 'string' || testId.length === 0)
    || new Set(requiredTestIds).size !== requiredTestIds.length)
  {
    fail('browser requiredTestIds must be an exact non-empty set')
  }
  requireStringFacts(facts, ['viewportId', 'themeId', 'stateId'], observationClass)
  requireDigests(facts, ['interactionDigest', 'domDigest', 'a11yDigest', 'networkDigest', 'consoleDigest'], observationClass)
  if (facts.contractSatisfied !== true || facts.consoleClean !== true || facts.screenshotOnly !== false)
  {
    fail('browser correctness contract failed or only diagnostic screenshot evidence was supplied')
  }
  return true
}

// BEHAVIOR-OWNER: application-runtime-semantic-coherence
export function produceApplicationRuntimeObservation(inputs)
{
  return producePostRuntimeObservation({
    ...inputs,
    producerId: applicationRuntimeProducerId,
    validateFacts: validateApplicationRuntimeFacts
  })
}

export function verifyApplicationRuntimeObservation({ receipt, ...inputs })
{
  return verifyPostRuntimeObservation({
    ...inputs,
    receipt,
    produce: produceApplicationRuntimeObservation
  })
}

export function extract(context)
{
  return produceApplicationRuntimeObservation(context)
}
