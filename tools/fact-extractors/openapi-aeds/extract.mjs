import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { digestCatalog } from '../../contracts/behavior-contract-catalog.mjs'

const observationRelative = '.tmp/contracts/openapi/api-aeds-observation.json'
const expectedArtifactId = 'openapi-aeds-observation'
const endpointContractRelative = 'src/shared/Contracts/Validation/aeds-endpoint-contracts.json'
const exactKeys = (value, expected) => value && typeof value === 'object'
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value)
const isSortedUnique = (values) => Array.isArray(values)
  && JSON.stringify(values) === JSON.stringify([...new Set(values)].sort((left, right) =>
    typeof left === 'number' ? left - right : String(left).localeCompare(String(right))))
const boundKeys = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']
const propertyKeys = ['name', 'type', 'required', 'nullable', 'format', 'schemaRef', 'itemType', 'itemSchemaRef', 'enumValues', 'bounds']
const definitionKeys = ['typeIdentity', 'requiredFields', 'properties', 'oneOf', 'discriminator', 'bounds']
const requestKeys = ['direction', 'source', 'schemaRef', 'encoding', 'required', 'nullable', 'requiredFields', 'parameters', 'properties', 'definitions', 'oneOf', 'discriminator', 'bounds', 'fieldSetState', 'boundsState', 'unionState', 'schemaDigest', 'sourceTypes', 'readerIdentities']
const parameterKeys = ['name', 'direction', 'source', 'schemaRef', 'required', 'nullable', 'evidence']

function validBound(value)
{
  return exactKeys(value, boundKeys)
    && ['minimum', 'maximum'].every((key) => value[key] == null
      || (typeof value[key] === 'string' && value[key].length > 0))
    && boundKeys.slice(2).every((key) => value[key] == null || (Number.isInteger(value[key]) && value[key] >= 0))
}

const hasBound = (value) => boundKeys.some((key) => value[key] != null)
const boundedProperties = (properties) => Object.fromEntries(Object.entries(properties)
  .filter(([, property]) => hasBound(property.bounds))
  .map(([name, property]) => [name, property.bounds]))

function validProperties(properties, definitions)
{
  if (!isObject(properties)) return false
  return Object.entries(properties).every(([name, property]) =>
    exactKeys(property, propertyKeys) && property.name === name
      && ['string', 'boolean', 'binary', 'enum', 'number', 'integer', 'array', 'object'].includes(property.type)
      && typeof property.required === 'boolean' && typeof property.nullable === 'boolean'
      && (property.format == null || (typeof property.format === 'string' && property.format.length > 0))
      && (property.schemaRef == null || property.type === 'object')
      && (property.itemType == null || ['array', 'object'].includes(property.type))
      && (property.itemSchemaRef == null || ['array', 'object'].includes(property.type))
      && (property.type !== 'array' || property.itemType != null)
      && Array.isArray(property.enumValues)
      && (property.type === 'enum') === (property.enumValues.length > 0)
      && isSortedUnique(property.enumValues) && validBound(property.bounds)
      && [property.schemaRef, property.itemSchemaRef].filter((value) => value != null).every((ref) =>
        String(ref).startsWith('clr://') && Object.hasOwn(definitions, String(ref).slice('clr://'.length))))
}

function validRequest(op)
{
  const request = op.request
  if (!exactKeys(request, requestKeys) || request.direction !== 'request' || !Array.isArray(request.requiredFields)
    || !Array.isArray(request.parameters) || !isObject(request.properties)
    || !isObject(request.definitions) || !Array.isArray(request.oneOf)
    || !isObject(request.bounds) || !Array.isArray(request.sourceTypes)
    || !Array.isArray(request.readerIdentities) || request.nullable !== false) return false
  if (!request.parameters.every((parameter) => exactKeys(parameter, parameterKeys)
    && typeof parameter.name === 'string' && parameter.name.length > 0
    && parameter.direction === 'request' && ['path', 'query', 'header'].includes(parameter.source)
    && typeof parameter.schemaRef === 'string' && parameter.schemaRef.startsWith(`${parameter.source}://`)
    && typeof parameter.required === 'boolean' && typeof parameter.nullable === 'boolean'
    && !(parameter.required && parameter.nullable)
    && Array.isArray(parameter.evidence) && parameter.evidence.length > 0
    && isSortedUnique(parameter.evidence))
    || new Set(request.parameters.map((parameter) => `${parameter.source}\0${parameter.name}`)).size !== request.parameters.length
    || !isSortedUnique(request.parameters.map((parameter) => `${parameter.source}\0${parameter.name}`))) return false
  if (op.requestFrame == null)
  {
    return request.source === 'none' && request.schemaRef === null && request.encoding === 'none'
      && request.required === false && request.requiredFields.length === 0
      && Object.keys(request.properties).length === 0 && Object.keys(request.definitions).length === 0
      && request.oneOf.length === 0 && request.discriminator === null && Object.keys(request.bounds).length === 0
      && request.fieldSetState === 'not-applicable' && request.boundsState === 'not-applicable'
      && request.unionState === 'not-applicable' && request.schemaDigest === null
      && request.sourceTypes.length === 0 && request.readerIdentities.length === 0
  }
  if (request.source !== 'aeds-frame-body' || request.schemaRef !== `aeds://request-schema/${op.operationId}`
    || !['binary-layout', 'binary-package', 'utf8-json'].includes(request.encoding)
    || request.required !== true || Object.keys(request.properties).length === 0
    || request.fieldSetState !== 'closed' || request.boundsState !== 'closed'
    || !['none', 'one-of'].includes(request.unionState)
    || !/^[a-f0-9]{64}$/u.test(String(request.schemaDigest ?? ''))
    || request.sourceTypes.length === 0 || request.readerIdentities.length === 0
    || !isSortedUnique(request.requiredFields) || !isSortedUnique(request.oneOf)
    || !isSortedUnique(request.sourceTypes) || !isSortedUnique(request.readerIdentities)
    || !request.sourceTypes.every((identity) => typeof identity === 'string' && identity.length > 0)
    || !request.readerIdentities.every((identity) => typeof identity === 'string' && identity.length > 0)) return false
  const required = Object.values(request.properties).filter((property) => property.required).map((property) => property.name).sort()
  if (JSON.stringify(required) !== JSON.stringify(request.requiredFields)
    || !validProperties(request.properties, request.definitions)
    || JSON.stringify(boundedProperties(request.properties)) !== JSON.stringify(request.bounds)) return false
  for (const [identity, definition] of Object.entries(request.definitions))
  {
    if (!exactKeys(definition, definitionKeys) || definition.typeIdentity !== identity
      || !isSortedUnique(definition.requiredFields) || !isSortedUnique(definition.oneOf)
      || !isObject(definition.properties) || !isObject(definition.bounds)
      || !validProperties(definition.properties, request.definitions)
      || JSON.stringify(boundedProperties(definition.properties)) !== JSON.stringify(definition.bounds)
      || !definition.oneOf.every((derived) => Object.hasOwn(request.definitions, derived))
      || (definition.oneOf.length === 0
        ? definition.discriminator !== null
        : typeof definition.discriminator !== 'string' || definition.discriminator.length === 0)
      || JSON.stringify(Object.values(definition.properties).filter((property) => property.required)
        .map((property) => property.name).sort()) !== JSON.stringify(definition.requiredFields)) return false
  }
  const digest = createHash('sha256').update(JSON.stringify({
    direction: request.direction,
    schemaRef: request.schemaRef,
    requestFrame: op.requestFrame,
    encoding: request.encoding,
    parameters: request.parameters,
    requiredFields: request.requiredFields,
    properties: request.properties,
    definitions: request.definitions,
    oneOf: request.oneOf,
    discriminator: request.discriminator,
    bounds: request.bounds,
    sourceTypes: request.sourceTypes,
    readerIdentities: request.readerIdentities
  })).digest('hex')
  return digest === request.schemaDigest
    && request.oneOf.every((identity) => Object.hasOwn(request.definitions, identity))
    && (request.oneOf.length === 0
      ? request.discriminator === null && request.unionState === 'none'
      : typeof request.discriminator === 'string' && request.discriminator.length > 0
        && request.unionState === 'one-of')
}

function validResponses(op)
{
  if (!isSortedUnique(op.publicErrorStatuses) || op.publicErrorStatuses.length === 0
    || !isObject(op.publicErrorStatusEvidence)) return false
  const refs = op.publicErrorStatuses.map((status) => `configuration-error-security-policy:error-transport-mappings:${status}`)
  if (JSON.stringify(op.publicErrorRefs) !== JSON.stringify(refs)
    || op.publicErrorRefState !== 'operation-status-authority-bound'
    || JSON.stringify(Object.keys(op.publicErrorStatusEvidence).sort((a, b) => Number(a) - Number(b)))
      !== JSON.stringify(op.publicErrorStatuses.map(String))) return false
  if (!op.publicErrorStatuses.every((status) => status >= 400 && status <= 599
    && Array.isArray(op.publicErrorStatusEvidence[String(status)])
    && op.publicErrorStatusEvidence[String(status)].length > 0
    && isSortedUnique(op.publicErrorStatusEvidence[String(status)])
    && op.publicErrorStatusEvidence[String(status)]
      .every((source) => typeof source === 'string' && source.length > 0))) return false
  if (!Array.isArray(op.responses) || op.responses.length !== op.publicErrorStatuses.length + 1) return false
  const success = op.responses.filter((response) => response.kind === 'success')
  const errors = op.responses.filter((response) => response.kind === 'error')
  return success.length === 1 && success[0].status === Number(op.successStatus)
    && success[0].schemaRef === `aeds://frame/${op.responseFrame}` && success[0].publicErrorRef === null
    && JSON.stringify(errors.map((response) => response.status)) === JSON.stringify(op.publicErrorStatuses)
    && op.responses.every((response) => exactKeys(response, ['status', 'kind', 'schemaRef', 'contentType', 'resultPlacement', 'nullable', 'publicErrorRef'])
      && response.status != null && response.contentType === 'application/octet-stream'
      && response.resultPlacement === 'aeds.frame.payload' && response.nullable === false)
    && errors.every((response) => response.schemaRef === `aeds://frame/${op.errorFrame}`
      && response.publicErrorRef === `configuration-error-security-policy:error-transport-mappings:${response.status}`)
}

const encodedKey = (prefix, identity) => `${prefix}_${Buffer.from(String(identity), 'utf8').toString('hex')}`
const compactObject = (entries) => Object.fromEntries(entries.filter(([, value]) => value != null))

function projectBounds(bounds)
{
  const projected = Object.fromEntries(Object.entries(bounds).filter(([, value]) => value != null))
  return Object.keys(projected).length > 0 ? projected : null
}

function projectProperties(properties)
{
  return Object.fromEntries(Object.entries(properties).map(([name, property]) => [
    encodedKey('field', name),
    compactObject([
      ['identity', name], ['type', property.type], ['required', property.required], ['nullable', property.nullable],
      ['format', property.format], ['schemaRef', property.schemaRef], ['itemType', property.itemType],
      ['itemSchemaRef', property.itemSchemaRef],
      ['enumValues', property.enumValues.length > 0 ? property.enumValues : null],
      ['bounds', projectBounds(property.bounds)]
    ])
  ]))
}

function projectRequest(request)
{
  const definitions = Object.fromEntries(Object.entries(request.definitions).map(([identity, definition]) => [
    encodedKey('type', identity),
    compactObject([
      ['identity', identity],
      ['requiredFields', definition.requiredFields.length > 0 ? definition.requiredFields : null],
      ['properties', projectProperties(definition.properties)],
      ['oneOf', definition.oneOf.length > 0 ? definition.oneOf : null],
      ['discriminator', definition.discriminator],
      ['bounds', Object.keys(definition.bounds).length > 0
        ? Object.fromEntries(Object.entries(definition.bounds).map(([name, bounds]) => [encodedKey('field', name), {
            identity: name,
            ...projectBounds(bounds)
          }]))
        : null]
    ])
  ]))
  return compactObject([
    ['direction', request.direction], ['source', request.source], ['schemaRef', request.schemaRef], ['encoding', request.encoding],
    ['required', request.required], ['nullable', request.nullable],
    ['requiredFields', request.requiredFields.length > 0 ? request.requiredFields : null],
    ['parameters', request.parameters.length > 0
      ? Object.fromEntries(request.parameters.map((parameter) => [encodedKey('parameter', `${parameter.source}:${parameter.name}`), parameter]))
      : null],
    ['properties', Object.keys(request.properties).length > 0 ? projectProperties(request.properties) : null],
    ['definitions', Object.keys(definitions).length > 0 ? definitions : null],
    ['oneOf', request.oneOf.length > 0 ? request.oneOf : null], ['discriminator', request.discriminator],
    ['bounds', Object.keys(request.bounds).length > 0
      ? Object.fromEntries(Object.entries(request.bounds).map(([name, bounds]) => [encodedKey('field', name), {
          identity: name,
          ...projectBounds(bounds)
        }]))
      : null],
    ['fieldSetState', request.fieldSetState], ['boundsState', request.boundsState], ['unionState', request.unionState],
    ['schemaDigest', request.schemaDigest], ['sourceTypes', request.sourceTypes.length > 0 ? request.sourceTypes : null],
    ['readerIdentities', request.readerIdentities.length > 0 ? request.readerIdentities : null]
  ])
}

function projectResponse(response)
{
  return compactObject(Object.entries(response))
}

/**
 * compiled-assembly extractor for binary OpenAPI/AEDS facts.
 * Reads only the sealed observation artifact produced by FsusBlog.OpenApiObservation
 * for this exact build identity. Never reads checked-in OpenAPI as observation input.
 */
// BEHAVIOR-OWNER: binary-api-aeds-contract
export function extract(context)
{
  const buildIdentity = context.buildIdentity
  if (buildIdentity == null || typeof buildIdentity !== 'object')
  {
    return {
      status: 'failed',
      failureReasons: ['openapi-aeds-fact-extractor requires exact buildIdentity'],
      observations: {}
    }
  }
  if (buildIdentity.artifactId !== expectedArtifactId)
  {
    return {
      status: 'failed',
      failureReasons: [`unexpected artifactId ${buildIdentity.artifactId}`],
      observations: {}
    }
  }
  if (/bin[/\\](?:Debug|Release)\b/iu.test(String(buildIdentity.artifactId))
    || /bin[/\\](?:Debug|Release)\b/iu.test(String(buildIdentity.path ?? '')))
  {
    return {
      status: 'failed',
      failureReasons: ['refuses ambient bin/Debug or bin/Release observation identity'],
      observations: {}
    }
  }

  const absolute = path.join(context.repositoryRoot, observationRelative)
  if (!existsSync(absolute))
  {
    return {
      status: 'failed',
      failureReasons: [`missing sealed observation artifact ${observationRelative}`],
      observations: {}
    }
  }

  const bytes = readFileSync(absolute)
  const artifactDigest = createHash('sha256').update(bytes).digest('hex')
  if (artifactDigest !== buildIdentity.artifactDigest)
  {
    return {
      status: 'failed',
      failureReasons: [
        `observation artifact digest mismatch (refuses unbound or stale build; expected ${buildIdentity.artifactDigest}, got ${artifactDigest})`
      ],
      observations: {}
    }
  }

  let observation
  try
  {
    observation = JSON.parse(bytes.toString('utf8'))
  }
  catch (error)
  {
    return {
      status: 'failed',
      failureReasons: [`observation JSON parse failed: ${error instanceof Error ? error.message : String(error)}`],
      observations: {}
    }
  }

  if (observation?.schema !== 'fsusblog.api-aeds-observation.v4')
  {
    return {
      status: 'failed',
      failureReasons: ['observation schema is not fsusblog.api-aeds-observation.v4'],
      observations: {}
    }
  }
  if (!Array.isArray(observation.operations) || observation.operations.length === 0)
  {
    return {
      status: 'failed',
      failureReasons: ['observation operations empty'],
      observations: {}
    }
  }

  // Reject reverse generation from checked-in OpenAPI: observation must not claim checked-in file as source.
  if (observation.source === 'checked-in-openapi'
    || observation.generatedFromCheckedInOpenApi === true
    || observation.contractSource === 'fsusblog.openapi.json')
  {
    return {
      status: 'failed',
      failureReasons: ['observation must not be reverse-generated from checked-in OpenAPI'],
      observations: {}
    }
  }

  const operations = {}
  const operationKeys = []
  const seenOperationIds = new Set()
  const seenMethodPaths = new Set()
  const failureReasons = []
  const protocolStates = observation.protocolStates
  const errorAuthority = observation.errorAuthority
  const endpointAuthority = observation.endpointContractAuthority
  if (!protocolStates || protocolStates.aedsOnly !== true
    || !Array.isArray(protocolStates.supportedVersions) || protocolStates.supportedVersions.length === 0
    || !Array.isArray(protocolStates.activeFrameIds) || protocolStates.activeFrameIds.length === 0
    || !Array.isArray(protocolStates.retiredFrameValues)
    || !Array.isArray(protocolStates.migrationOnlyFrameIds))
  {
    failureReasons.push('closed active/retired/migration/AEDS-only protocol states missing')
  }
  else if (JSON.stringify(protocolStates.supportedVersions) !== JSON.stringify([Number(observation.aedsVersion)])
    || new Set(protocolStates.activeFrameIds).size !== protocolStates.activeFrameIds.length
    || new Set(protocolStates.retiredFrameValues).size !== protocolStates.retiredFrameValues.length
    || new Set(protocolStates.migrationOnlyFrameIds).size !== protocolStates.migrationOnlyFrameIds.length
    || protocolStates.activeFrameIds.some((id) => protocolStates.migrationOnlyFrameIds.includes(id))
    || protocolStates.activeFrameIds.some((id) => String(id).startsWith('Reserved'))
    || protocolStates.migrationOnlyFrameIds.some((id) => !String(id).startsWith('Reserved')))
  {
    failureReasons.push('active/retired/AEDS-only protocol states conflict')
  }
  if (!exactKeys(errorAuthority, ['behaviorId', 'catalogDigest', 'documentPath', 'factIds'])
    || errorAuthority.behaviorId !== 'configuration-error-security-policy'
    || !/^[a-f0-9]{64}$/u.test(String(errorAuthority.catalogDigest ?? ''))
    || errorAuthority.documentPath !== 'docs/api/schemas-and-errors.md'
    || JSON.stringify(errorAuthority.factIds) !== JSON.stringify([
      'facts.error-codes.domain.active',
      'facts.error-codes.transport-mapping'
    ]))
  {
    failureReasons.push('error authority binding is missing, duplicated, or stale')
  }
  if (!exactKeys(endpointAuthority, ['schema', 'documentPath', 'contentDigest'])
    || endpointAuthority.schema !== 'fsusblog.aeds-endpoint-contracts.v2'
    || endpointAuthority.documentPath !== endpointContractRelative
    || !/^[a-f0-9]{64}$/u.test(String(endpointAuthority.contentDigest ?? '')))
  {
    failureReasons.push('endpoint contract authority binding is missing, duplicated, or stale')
  }
  const behaviorCatalog = path.join(context.repositoryRoot, 'config/contracts/behavior-contracts.json')
  if (existsSync(behaviorCatalog)
    && digestCatalog(JSON.parse(readFileSync(behaviorCatalog, 'utf8'))) !== errorAuthority?.catalogDigest)
  {
    failureReasons.push('error authority catalog digest does not match current BehaviorCatalog')
  }
  const endpointContract = path.join(context.repositoryRoot, endpointContractRelative)
  if (existsSync(endpointContract))
  {
    const document = JSON.parse(readFileSync(endpointContract, 'utf8'))
    const { contentDigest: _contentDigest, ...content } = document
    const actual = createHash('sha256').update(JSON.stringify(content)).digest('hex')
    if (actual !== endpointAuthority?.contentDigest || document.contentDigest !== actual)
    {
      failureReasons.push('endpoint contract content digest does not match current canonical shared contract')
    }
  }

  for (const op of observation.operations)
  {
    const key = `${op.method} ${op.path}`
    if (seenMethodPaths.has(key)) failureReasons.push(`duplicate method/path ${key}`)
    seenMethodPaths.add(key)
    if (!op.operationId) failureReasons.push(`${key} missing operationId`)
    if (seenOperationIds.has(op.operationId)) failureReasons.push(`duplicate operationId ${op.operationId}`)
    seenOperationIds.add(op.operationId)
    if (!validRequest(op))
    {
      failureReasons.push(`${key} request contract is not closed and typed`)
    }
    if (!validResponses(op))
    {
      failureReasons.push(`${key} response contracts/result placement are invalid`)
    }
    if (op.errorAuthorityBehaviorId !== 'configuration-error-security-policy'
      || op.publicErrorRefState !== 'operation-status-authority-bound')
    {
      failureReasons.push(`${key} public errors must reference the exact current error authority`)
    }
    if (op.protocolState !== 'active-aeds-only' || op.resultPlacement !== 'aeds.frame.payload')
    {
      failureReasons.push(`${key} protocol state/result placement is invalid`)
    }
    operationKeys.push(key)
    operations[op.operationId] = {
      method: String(op.method),
      path: String(op.path),
      protocol: String(op.protocol ?? 'AEDS'),
      aedsVersion: Number(op.aedsVersion ?? 2),
      requestFrame: op.requestFrame == null || op.requestFrame === '' ? 'none' : String(op.requestFrame),
      responseFrame: String(op.responseFrame),
      errorFrame: String(op.errorFrame ?? 'ApiError'),
      auth: String(op.auth),
      permission: String(op.permission ?? 'none'),
      pow: Boolean(op.pow),
      rateLimit: String(op.rateLimit),
      cache: String(op.cache),
      successStatus: Number(op.successStatus ?? 200),
      request: isObject(op.request) ? projectRequest(op.request) : { state: 'invalid' },
      responses: Object.fromEntries((Array.isArray(op.responses) ? op.responses : []).map((response, index) => [
        `status-${response.status}-${index}`,
        projectResponse(response)
      ])),
      publicErrorStatuses: op.publicErrorStatuses,
      publicErrorRefs: op.publicErrorRefs,
      publicErrorStatusEvidence: Object.fromEntries(Object.entries(op.publicErrorStatusEvidence ?? {})
        .map(([status, sources]) => [`status_${status}`, sources])),
      publicErrorRefState: op.publicErrorRefState,
      errorAuthorityBehaviorId: op.errorAuthorityBehaviorId,
      resultPlacement: op.resultPlacement,
      protocolState: op.protocolState
    }
  }

  if (failureReasons.length > 0)
  {
    return { status: 'failed', failureReasons, observations: {} }
  }

  operationKeys.sort()
  return {
    status: 'ok',
    failureReasons: [],
    observations: {
      operationCount: observation.operations.length,
      operationKeys,
      operations,
      observationDigest: String(observation.observationDigest),
      protocol: String(observation.protocol ?? 'AEDS'),
      aedsVersion: Number(observation.aedsVersion ?? 2),
      protocolStates: {
        supportedVersions: protocolStates.supportedVersions,
        activeFrameIds: protocolStates.activeFrameIds,
        retiredFrameValues: protocolStates.retiredFrameValues,
        aedsOnly: protocolStates.aedsOnly,
        migrationOnlyState: protocolStates.migrationOnlyFrameIds.length === 0 ? 'empty' : 'present',
        ...(protocolStates.migrationOnlyFrameIds.length > 0
          ? { migrationOnlyFrameIds: protocolStates.migrationOnlyFrameIds }
          : {})
      },
      errorAuthority,
      endpointContractAuthority: endpointAuthority,
      artifactDigest
    }
  }
}
