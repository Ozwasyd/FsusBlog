import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const observationRelative = '.tmp/contracts/config-error-security/config-error-security-policy-observation.json'
const expectedArtifactId = 'config-error-security-policy-observation'
const expectedSchema = 'fsusblog.config-error-security-policy-observation.v1'

const requiredFactKeys = Object.freeze([
  'configuration.keys',
  'configuration.defaults',
  'configuration.allowed-values',
  'configuration.required-production-values',
  'error-codes.public',
  'error-codes.transport-mapping',
  'security.challenge-kinds',
  'security.challenge-retired-kinds',
  'security.rate-limit-policies',
  'security.cache-policy-classes',
  'security.fail-open-closed-modes',
  'security.numeric-boundaries'
])

function failResult(reasons)
{
  return {
    status: 'failed',
    failureReasons: reasons.map(String),
    observations: {}
  }
}

function isSortedUniqueStrings(values)
{
  if (!Array.isArray(values) || values.length === 0) return false
  if (values.some((value) => typeof value !== 'string' || value.length === 0)) return false
  if (new Set(values).size !== values.length) return false
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return sorted.every((value, index) => value === values[index])
}

function isBoundary(value)
{
  return value != null
    && typeof value === 'object'
    && typeof value.value === 'number'
    && Number.isFinite(value.value)
    && typeof value.unit === 'string'
    && value.unit.length > 0
    && typeof value.inclusiveMin === 'boolean'
    && typeof value.inclusiveMax === 'boolean'
    && typeof value.bound === 'string'
}

function isRangeBoundary(value)
{
  return value != null
    && typeof value === 'object'
    && typeof value.min === 'number'
    && typeof value.max === 'number'
    && typeof value.unit === 'string'
    && value.unit.length > 0
    && typeof value.inclusiveMin === 'boolean'
    && typeof value.inclusiveMax === 'boolean'
    && typeof value.bound === 'string'
}

function parseTsConstObjectKeys(source, exportName)
{
  const match = source.match(new RegExp(`export const ${exportName} = \\{([\\s\\S]*?)\\n\\} as const`, 'u'))
  if (!match) return null
  return [...match[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:/gmu)].map((entry) => entry[1])
}

function readOptional(repositoryRoot, relative)
{
  const absolute = path.join(repositoryRoot, relative)
  if (!existsSync(absolute)) return null
  return readFileSync(absolute, 'utf8')
}

/**
 * compiled-assembly extractor for configuration defaults, public error codes,
 * and challenge/rate/cache/security policy facts.
 * Authority is the sealed observation artifact from FsusBlog.ConfigErrorSecurityObservation.
 * Frontend sources are compared as consumer projections only — never as authority and never via handwritten alignment tables.
 */
// BEHAVIOR-OWNER: configuration-error-security-policy
export function extract(context)
{
  const buildIdentity = context.buildIdentity
  if (buildIdentity == null || typeof buildIdentity !== 'object')
  {
    return failResult(['config-error-security-policy-fact-extractor requires exact buildIdentity'])
  }
  if (buildIdentity.artifactId !== expectedArtifactId)
  {
    return failResult([`unexpected artifactId ${buildIdentity.artifactId}`])
  }
  if (/bin[/\\](?:Debug|Release)\b/iu.test(String(buildIdentity.artifactId))
    || /bin[/\\](?:Debug|Release)\b/iu.test(String(buildIdentity.path ?? '')))
  {
    return failResult(['refuses ambient bin/Debug or bin/Release observation identity'])
  }

  const absolute = path.join(context.repositoryRoot, observationRelative)
  if (!existsSync(absolute))
  {
    return failResult([`missing sealed observation artifact ${observationRelative}`])
  }

  const bytes = readFileSync(absolute)
  const artifactDigest = createHash('sha256').update(bytes).digest('hex')
  if (artifactDigest !== buildIdentity.artifactDigest)
  {
    return failResult([
      `observation artifact digest mismatch (refuses unbound or stale build; expected ${buildIdentity.artifactDigest}, got ${artifactDigest})`
    ])
  }

  let observation
  try
  {
    observation = JSON.parse(bytes.toString('utf8'))
  }
  catch (error)
  {
    return failResult([`observation JSON parse failed: ${error instanceof Error ? error.message : String(error)}`])
  }

  if (observation?.schema !== expectedSchema)
  {
    return failResult([`observation schema is not ${expectedSchema}`])
  }
  if (observation.source === 'checked-in-docs'
    || observation.source === 'test-fixture'
    || observation.source === 'appsettings.Development'
    || observation.source === 'example-appsettings'
    || observation.generatedFromDocs === true)
  {
    return failResult(['observation must not be reverse-generated from docs, fixtures, or example appsettings'])
  }
  if (observation.status === 'failed' || (Array.isArray(observation.failureReasons) && observation.failureReasons.length > 0))
  {
    return failResult([
      'observation host reported coherence failure',
      ...(Array.isArray(observation.failureReasons) ? observation.failureReasons.map(String) : [])
    ])
  }

  const facts = observation.facts
  if (facts == null || typeof facts !== 'object' || Array.isArray(facts))
  {
    return failResult(['observation.facts missing'])
  }

  const failureReasons = []
  for (const key of requiredFactKeys)
  {
    if (!Object.hasOwn(facts, key)) failureReasons.push(`missing required fact ${key}`)
  }
  if (failureReasons.length > 0) return failResult(failureReasons)

  // configuration layers
  const keys = facts['configuration.keys']
  if (keys == null || typeof keys !== 'object' || Array.isArray(keys) || Object.keys(keys).length === 0)
  {
    failureReasons.push('configuration.keys must be a non-empty typed map')
  }

  const defaults = facts['configuration.defaults']
  if (defaults == null || typeof defaults !== 'object' || Array.isArray(defaults))
  {
    failureReasons.push('configuration.defaults must be a typed map')
  }
  else
  {
    for (const [key, entry] of Object.entries(defaults))
    {
      if (entry == null || typeof entry !== 'object')
      {
        failureReasons.push(`configuration.defaults.${key} must be an object`)
        continue
      }
      if (entry.secret === true && entry.layers)
      {
        for (const layer of Object.values(entry.layers))
        {
          if (layer && typeof layer === 'object' && Object.hasOwn(layer, 'value') && layer.value != null && layer.value !== '')
          {
            failureReasons.push(`secret configuration.defaults.${key} must not materialize values`)
          }
        }
      }
      if (entry.layers && typeof entry.layers === 'object')
      {
        if (Object.hasOwn(entry.layers, 'runtime-environment'))
        {
          failureReasons.push(`configuration.defaults.${key} must not include runtime-environment layer`)
        }
      }
    }
  }

  const requiredProduction = facts['configuration.required-production-values']
  if (requiredProduction == null || typeof requiredProduction !== 'object' || Array.isArray(requiredProduction))
  {
    failureReasons.push('configuration.required-production-values must be a typed map')
  }

  const allowedValues = facts['configuration.allowed-values']
  if (allowedValues == null || typeof allowedValues !== 'object' || Array.isArray(allowedValues))
  {
    failureReasons.push('configuration.allowed-values must be a typed map')
  }

  // error codes
  const publicCodes = facts['error-codes.public']
  if (!isSortedUniqueStrings(publicCodes))
  {
    failureReasons.push('error-codes.public must be a sorted unique string set from production catalog')
  }
  if (Array.isArray(publicCodes) && !publicCodes.includes('Validation'))
  {
    failureReasons.push('error-codes.public must include Validation')
  }

  const transport = facts['error-codes.transport-mapping']
  if (transport == null || typeof transport !== 'object' || Array.isArray(transport) || Object.keys(transport).length === 0)
  {
    failureReasons.push('error-codes.transport-mapping must be a non-empty map')
  }

  // challenges
  const challengeKinds = facts['security.challenge-kinds']
  const activeKinds = challengeKinds?.active
  if (!isSortedUniqueStrings(activeKinds))
  {
    failureReasons.push('security.challenge-kinds.active must be a sorted unique string set')
  }

  const retiredKinds = facts['security.challenge-retired-kinds']
  if (!Array.isArray(retiredKinds))
  {
    failureReasons.push('security.challenge-retired-kinds must be an array')
  }
  else if (retiredKinds.length > 0 && !isSortedUniqueStrings(retiredKinds))
  {
    failureReasons.push('security.challenge-retired-kinds must be a sorted unique string set when non-empty')
  }
  if (Array.isArray(activeKinds) && Array.isArray(retiredKinds))
  {
    const retiredInActive = retiredKinds.filter((kind) => activeKinds.includes(kind))
    if (retiredInActive.length > 0)
    {
      failureReasons.push(`retired challenge kinds must not be listed active: ${retiredInActive.join(',')}`)
    }
  }

  // rate limits
  const ratePolicies = facts['security.rate-limit-policies']
  if (ratePolicies == null || typeof ratePolicies !== 'object' || Array.isArray(ratePolicies))
  {
    failureReasons.push('security.rate-limit-policies must be a map')
  }
  else
  {
    for (const required of ['fixed_ip', 'public_read', 'read_proof', 'notification_stream', 'security_challenge_verify'])
    {
      if (!Object.hasOwn(ratePolicies, required))
      {
        failureReasons.push(`security.rate-limit-policies missing ${required}`)
      }
    }
    for (const [policyId, policy] of Object.entries(ratePolicies))
    {
      if (policy?.window && !isBoundary(policy.window))
      {
        failureReasons.push(`security.rate-limit-policies.${policyId}.window must include unit and inclusive/exclusive bounds`)
      }
      if (policy?.codeDefaultPermitLimit && !isBoundary(policy.codeDefaultPermitLimit))
      {
        failureReasons.push(`security.rate-limit-policies.${policyId}.codeDefaultPermitLimit must be typed boundary`)
      }
      if (policy?.failMode !== 'fail-closed' && policy?.failMode !== 'fail-open')
      {
        failureReasons.push(`security.rate-limit-policies.${policyId}.failMode must be fail-closed or fail-open semantic id`)
      }
    }
  }

  // cache
  const cacheClasses = facts['security.cache-policy-classes']
  if (cacheClasses == null || typeof cacheClasses !== 'object' || Array.isArray(cacheClasses) || Object.keys(cacheClasses).length === 0)
  {
    failureReasons.push('security.cache-policy-classes must be a non-empty map')
  }

  // fail modes
  const failModes = facts['security.fail-open-closed-modes']
  if (failModes == null || typeof failModes !== 'object' || Array.isArray(failModes))
  {
    failureReasons.push('security.fail-open-closed-modes must be a map of semantic IDs')
  }
  else
  {
    for (const [modeId, mode] of Object.entries(failModes))
    {
      if (mode !== 'fail-closed' && mode !== 'fail-open')
      {
        failureReasons.push(`security.fail-open-closed-modes.${modeId} must be fail-closed or fail-open`)
      }
    }
  }

  // numeric boundaries
  const numeric = facts['security.numeric-boundaries']
  if (numeric == null || typeof numeric !== 'object' || Array.isArray(numeric) || Object.keys(numeric).length === 0)
  {
    failureReasons.push('security.numeric-boundaries must be a non-empty map')
  }
  else
  {
    for (const [id, boundary] of Object.entries(numeric))
    {
      if (boundary && typeof boundary === 'object' && Object.hasOwn(boundary, 'min'))
      {
        if (!isRangeBoundary(boundary))
        {
          failureReasons.push(`security.numeric-boundaries.${id} must include unit and inclusive/exclusive range bounds`)
        }
      }
      else if (boundary && typeof boundary === 'object' && Object.hasOwn(boundary, 'default'))
      {
        for (const part of ['default', 'minimum', 'maximum'])
        {
          if (boundary[part] != null && !isBoundary(boundary[part]))
          {
            failureReasons.push(`security.numeric-boundaries.${id}.${part} must be typed boundary with unit`)
          }
        }
      }
      else if (!isBoundary(boundary))
      {
        failureReasons.push(`security.numeric-boundaries.${id} must be typed boundary with unit and inclusive/exclusive semantics`)
      }
    }
  }

  // Secret leakage scan across full observation (connection strings / credentials).
  const serialized = JSON.stringify(observation)
  for (const banned of [
    'Host=',
    'Username=',
    'Password=',
    'Connection String',
    'BEGIN PRIVATE KEY',
    'postgres://',
    'redis://'
  ])
  {
    if (serialized.includes(banned))
    {
      failureReasons.push(`observation receipt must not contain secret material marker: ${banned}`)
    }
  }
  if (/Server=.*Database=/iu.test(serialized) || /AccountKey=/iu.test(serialized))
  {
    failureReasons.push('observation receipt must not contain connection-string style material')
  }

  // Frontend projection exactness (consumer only; no handwritten alignment object).
  const frontendProjection = {
    'error-codes': { status: 'skipped', missing: [], extra: [], clientLocal: [] },
    'challenge-kinds': { status: 'skipped', missing: [], extra: [] }
  }

  const appErrorSource = readOptional(context.repositoryRoot, 'src/frontend/src/utils/appError.ts')
  if (appErrorSource && Array.isArray(publicCodes))
  {
    const frontendCodes = parseTsConstObjectKeys(appErrorSource, 'AppErrorCode')
    if (!frontendCodes || frontendCodes.length === 0)
    {
      failureReasons.push('frontend AppErrorCode catalog unreadable for projection exactness')
    }
    else
    {
      const frontendSet = new Set(frontendCodes)
      const authoritySet = new Set(publicCodes)
      const missing = publicCodes.filter((code) => !frontendSet.has(code))
      // Client-local codes are those present only on the frontend surface; they are not
      // "extra authority items". Extra means frontend claiming a public wire code identity
      // that is not in authority — impossible by name equality, so we only fail on missing.
      // Bidirectional exact match for the public wire projection: every authority code is
      // present, and the projected public subset equals authority.
      const projectedPublic = frontendCodes.filter((code) => authoritySet.has(code)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      const clientLocal = frontendCodes.filter((code) => !authoritySet.has(code)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      const authoritySorted = [...publicCodes]
      const exact = missing.length === 0
        && projectedPublic.length === authoritySorted.length
        && projectedPublic.every((code, index) => code === authoritySorted[index])
      frontendProjection['error-codes'] = {
        status: exact ? 'exact' : 'mismatch',
        missing,
        extra: [],
        clientLocal,
        projectedPublic
      }
      if (!exact)
      {
        failureReasons.push(
          `frontend error-code projection is not exact vs authority (missing=${missing.join(',') || 'none'})`
        )
      }
    }
  }
  else if (Array.isArray(publicCodes) && publicCodes.length > 0)
  {
    // When running against a fixture root without frontend sources, projection is not available.
    frontendProjection['error-codes'] = {
      status: 'unavailable',
      missing: [...publicCodes],
      extra: [],
      clientLocal: []
    }
  }

  const binaryApiSource = readOptional(context.repositoryRoot, 'src/frontend/src/contracts/binaryApi.ts')
  if (binaryApiSource && Array.isArray(activeKinds))
  {
    // Frontend enum is numeric; wire-name projection lives in challenge-kind-wire.ts.
    const wireSource = readOptional(context.repositoryRoot, 'src/frontend/src/security/challenge-kind-wire.ts')
    const registrySource = readOptional(context.repositoryRoot, 'src/frontend/src/security/challenge-capability-registry.ts')
    if (!wireSource || !registrySource)
    {
      failureReasons.push('frontend challenge wire/registry sources unreadable for projection exactness')
    }
    else
    {
      // Derive wire names by matching return string literals in wire helper cases that map production kinds.
      const wireNames = [...wireSource.matchAll(/return\s+'([^']+)'/gu)].map((match) => match[1])
      const uniqueWire = [...new Set(wireNames)].filter((name) => name !== 'unknown').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      const authority = [...activeKinds]
      const missing = authority.filter((kind) => !uniqueWire.includes(kind))
      const extra = uniqueWire.filter((kind) => !authority.includes(kind) && !(Array.isArray(retiredKinds) && retiredKinds.includes(kind)))
      // Retired must not appear as active projection either.
      const retiredProjectedActive = Array.isArray(retiredKinds)
        ? retiredKinds.filter((kind) => uniqueWire.includes(kind) && authority.includes(kind))
        : []
      const exact = missing.length === 0 && extra.length === 0 && retiredProjectedActive.length === 0
        && uniqueWire.length === authority.length
        && uniqueWire.every((kind, index) => kind === authority[index])
      frontendProjection['challenge-kinds'] = {
        status: exact ? 'exact' : 'mismatch',
        missing,
        extra,
        projected: uniqueWire
      }
      if (!exact)
      {
        failureReasons.push(
          `frontend challenge-kind projection is not exact vs authority (missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'})`
        )
      }
    }
  }

  if (failureReasons.length > 0) return failResult(failureReasons)

  const observations = {
    'configuration.keys': facts['configuration.keys'],
    'configuration.defaults': facts['configuration.defaults'],
    'configuration.allowed-values': facts['configuration.allowed-values'],
    'configuration.required-production-values': facts['configuration.required-production-values'],
    'error-codes.public': facts['error-codes.public'],
    'error-codes.transport-mapping': facts['error-codes.transport-mapping'],
    'security.challenge-kinds': facts['security.challenge-kinds'],
    'security.challenge-retired-kinds': facts['security.challenge-retired-kinds'],
    'security.rate-limit-policies': facts['security.rate-limit-policies'],
    'security.cache-policy-classes': facts['security.cache-policy-classes'],
    'security.fail-open-closed-modes': facts['security.fail-open-closed-modes'],
    'security.numeric-boundaries': facts['security.numeric-boundaries'],
    'frontend.projection': frontendProjection,
    observationDigest: String(observation.observationDigest),
    artifactDigest,
    source: String(observation.source ?? 'compiled-production-constants')
  }

  return {
    status: 'ok',
    failureReasons: [],
    observations
  }
}
