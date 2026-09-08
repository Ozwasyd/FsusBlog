import { isPlainObject } from '../lib/canonicalize.mjs'

const digestPattern = /^(?:sha256:)?[a-f0-9]{64}$/u

const fieldContracts = Object.freeze({
  'route-response-error': [
    'statusCode', 'typedResult', 'protocolIdentity', 'contentIdentity',
    'authSemantics', 'permissionSemantics', 'visibilitySemantics',
    'cacheSemantics', 'semanticMatch'
  ],
  'aot-spa-hydration': [
    'buildDigest', 'manifestDigest', 'publicationDigest', 'localeCanaryDigest',
    'dataCanaryDigest', 'serverHtmlDigest', 'hydratedDomDigest',
    'clientStateDigest', 'networkResourceDigest', 'coherent'
  ],
  'cache-search-outbox-convergence': [
    'authorityCoordinateDigest', 'eventDigest', 'edgeDigest', 'generationDigest',
    'queryDigest', 'readModelDigest', 'outputDigest', 'terminalReceiptDigest',
    'terminalState', 'coherent'
  ],
  'session-cookie-runtime': [
    'databaseSessionDigest', 'credentialDigest', 'authContextDigest', 'jwtDigest',
    'cookieDigest', 'storageClaimsDigest', 'expiryDigest', 'revisionDigest',
    'deviceDigest', 'serviceResultDigest', 'coherent'
  ],
  'browser-behavior-contract': [
    'requiredTestIds', 'viewportId', 'themeId', 'stateId', 'interactionDigest',
    'domDigest', 'a11yDigest', 'networkDigest', 'consoleDigest',
    'contractSatisfied', 'consoleClean', 'screenshotOnly'
  ],
  'release-identity-readiness': [
    'imageDigest', 'packageDigest', 'configDigest', 'schemaDigest',
    'manifestDigest', 'signingDigest', 'trustDigest', 'readinessReceiptDigest',
    'serviceReady', 'routeDataReady', 'cacheReady', 'dependenciesReady',
    'versionReady', 'credentialReady', 'identityMatch',
    'runtimeRoleContractSatisfied', 'monolithicOwnershipSatisfied'
  ],
  'blue-green-containment': [
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

const fail = (classId, message) => { throw new Error(`[post-runtime-observation] ${classId} ${message}`) }

function exactFacts(classId, facts)
{
  if (!isPlainObject(facts)) fail(classId, 'semanticFacts must be an object')
  const fields = fieldContracts[classId]
  if (!fields) fail(classId, 'has no semantic contract')
  if (Object.keys(facts).sort().join('\0') !== [...fields].sort().join('\0'))
  {
    fail(classId, 'semanticFacts have unsupported or missing fields')
  }
  return fields
}

function requireStrings(classId, facts, fields)
{
  for (const field of fields)
  {
    if (typeof facts[field] !== 'string' || facts[field].length === 0) fail(classId, `${field} is required`)
  }
}

function requireDigests(classId, facts, fields)
{
  for (const field of fields)
  {
    if (!digestPattern.test(String(facts[field] ?? ''))) fail(classId, `${field} must be a sealed digest`)
  }
}

function requireTrue(classId, facts, fields)
{
  for (const field of fields)
  {
    if (facts[field] !== true) fail(classId, `${field} must be true`)
  }
}

export function validateSemanticFacts(classId, facts)
{
  const fields = exactFacts(classId, facts)
  if (classId === 'route-response-error')
  {
    if (!Number.isInteger(facts.statusCode) || facts.statusCode < 100 || facts.statusCode > 599) fail(classId, 'statusCode is invalid')
    if (!['payload', 'typed-error'].includes(facts.typedResult)) fail(classId, 'typedResult must be payload or typed-error')
    requireStrings(classId, facts, [
      'protocolIdentity', 'contentIdentity', 'authSemantics', 'permissionSemantics',
      'visibilitySemantics', 'cacheSemantics'
    ])
    if (facts.semanticMatch !== true) fail(classId, 'semantic identity mismatch')
    return true
  }
  if (classId === 'browser-behavior-contract')
  {
    if (!Array.isArray(facts.requiredTestIds) || facts.requiredTestIds.length === 0
      || facts.requiredTestIds.some((testId) => typeof testId !== 'string' || testId.length === 0)
      || new Set(facts.requiredTestIds).size !== facts.requiredTestIds.length)
    {
      fail(classId, 'requiredTestIds must be an exact non-empty set')
    }
    requireStrings(classId, facts, ['viewportId', 'themeId', 'stateId'])
    requireDigests(classId, facts, ['interactionDigest', 'domDigest', 'a11yDigest', 'networkDigest', 'consoleDigest'])
    if (facts.contractSatisfied !== true || facts.consoleClean !== true || facts.screenshotOnly !== false)
    {
      fail(classId, 'correctness contract failed or screenshot-only evidence was supplied')
    }
    return true
  }
  if (classId === 'cache-search-outbox-convergence')
  {
    requireDigests(classId, facts, fields.filter((field) => !['terminalState', 'coherent'].includes(field)))
    if (facts.terminalState !== 'converged' || facts.coherent !== true) fail(classId, 'is stale or partial')
    return true
  }
  if (classId === 'aot-spa-hydration' || classId === 'session-cookie-runtime')
  {
    requireDigests(classId, facts, fields.filter((field) => field !== 'coherent'))
    if (facts.coherent !== true) fail(classId, 'semantic identities are not coherent')
    return true
  }
  const booleanFields = classId === 'release-identity-readiness'
    ? [
        'serviceReady', 'routeDataReady', 'cacheReady', 'dependenciesReady',
        'versionReady', 'credentialReady', 'identityMatch',
        'runtimeRoleContractSatisfied', 'monolithicOwnershipSatisfied'
      ]
    : [
        'activeReleaseProtected', 'activeIdentityKnown', 'switchComplete',
        'splitBrainAbsent', 'cleanupInactiveOnly', 'sharedFactsPreserved',
        'runtimeRoleContractSatisfied'
      ]
  requireDigests(classId, facts, fields.filter((field) => !booleanFields.includes(field)))
  requireTrue(classId, facts, booleanFields)
  return true
}
