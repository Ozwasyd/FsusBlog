import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { digestCatalog } from '../../contracts/behavior-contract-catalog.mjs'
import { digestValue } from '../lib/canonicalize.mjs'

const observationRelative = '.tmp/contracts/openapi/api-aeds-observation.json'
const observedOpenApiRelative = '.tmp/contracts/openapi/fsusblog.openapi.observed.json'
const buildReceiptRelative = '.tmp/contracts/openapi/build-receipt.json'
const expectedArtifactId = 'openapi-aeds-observation'
const endpointContractRelative = 'src/shared/Contracts/Validation/aeds-endpoint-contracts.json'
const protocolRelative = 'src/shared/Contracts/Validation/aeds-protocol.json'
const behaviorCatalogRelative = 'config/contracts/behavior-contracts.json'
const generatorRelative = 'tools/contracts/lib/openapi-observation.mjs'
const sourcePaths = Object.freeze([
  endpointContractRelative,
  protocolRelative,
  'src/backend/Infrastructure/Results/ApiErrorSemanticMapper.cs',
  behaviorCatalogRelative,
  'tools/contracts/FsusBlog.OpenApiObservation/FsusBlog.OpenApiObservation.csproj',
  'tools/contracts/FsusBlog.OpenApiObservation/CompiledEndpointContractObserver.cs',
  'tools/contracts/FsusBlog.OpenApiObservation/Models.cs',
  'tools/contracts/FsusBlog.OpenApiObservation/OpenApiObservationSelfTest.cs',
  'tools/contracts/FsusBlog.OpenApiObservation/OpenApiProjectionWriter.cs',
  'tools/contracts/FsusBlog.OpenApiObservation/Program.cs',
  'tools/contracts/FsusBlog.OpenApiObservation/RequestContractObserver.cs',
  generatorRelative,
  'tools/fact-extractors/openapi-aeds/extract.mjs'
])
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
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
const parameterKeys = ['name', 'direction', 'source', 'schemaRef', 'required', 'nullable', 'bounds', 'evidence']

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
    && validBound(parameter.bounds)
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

function validResponses(op, statusMappingKeys)
{
  if (!isSortedUnique(op.publicErrorStatuses) || op.publicErrorStatuses.length === 0
    || !isObject(op.publicErrorStatusEvidence)) return false
  const refs = op.publicErrorStatuses.map((status) => `configuration-error-security-policy:error-transport-mappings:${status}`)
  if (JSON.stringify(op.publicErrorRefs) !== JSON.stringify(refs)
    || op.publicErrorRefState !== 'operation-status-authority-bound'
    || JSON.stringify(Object.keys(op.publicErrorStatusEvidence).sort((a, b) => Number(a) - Number(b)))
      !== JSON.stringify(op.publicErrorStatuses.map(String))) return false
  if (!op.publicErrorStatuses.every((status) => status >= 400 && status <= 599
    && statusMappingKeys.has(status)
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

function observationContentDigest(observation)
{
  const dotNetJson = (value) => JSON.stringify(value)
    .replace(/\\"/gu, '\\u0022')
    .replace(/[+<>&'\u007f-\uffff]/gu, (character) =>
      `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
  const pascalRecord = (value) => !isObject(value) ? value : Object.fromEntries(Object.entries(value).map(([key, item]) => [
    `${key[0].toUpperCase()}${key.slice(1)}`,
    item
  ]))
  const bounds = (value) => !isObject(value) ? {} : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, pascalRecord(item)]))
  const parameter = (value) => ({
    ...pascalRecord(value),
    Bounds: pascalRecord(value?.bounds)
  })
  const properties = (value) => !isObject(value) ? {} : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, {
    ...pascalRecord(item),
    Bounds: pascalRecord(item.bounds)
  }]))
  const definitions = (value) => !isObject(value) ? {} : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, {
    ...pascalRecord(item),
    Properties: properties(item.properties),
    Bounds: bounds(item.bounds)
  }]))
  const operations = (observation.operations ?? []).map((operation) => ({
    ...pascalRecord(operation),
    Request: {
      ...pascalRecord(operation.request),
      Parameters: operation.request?.parameters?.map(parameter),
      Properties: properties(operation.request?.properties),
      Definitions: definitions(operation.request?.definitions),
      Bounds: bounds(operation.request?.bounds)
    },
    Responses: operation.responses?.map(pascalRecord),
    PublicErrorStatusEvidence: operation.publicErrorStatusEvidence
  }))
  return sha256(Buffer.from(dotNetJson({
    Schema: observation.schema,
    Protocol: observation.protocol,
    AedsVersion: observation.aedsVersion,
    OperationCount: observation.operationCount,
    OperationKeys: observation.operationKeys,
    Operations: operations,
    ProtocolStates: pascalRecord(observation.protocolStates),
    ErrorAuthority: pascalRecord(observation.errorAuthority),
    EndpointContractAuthority: pascalRecord(observation.endpointContractAuthority)
  }), 'utf8'))
}

function protocolStateCatalog(protocol)
{
  const version = Number(protocol?.header?.version)
  const frameTypes = protocol?.frameTypes
  const retiredEntries = protocol?.retiredFrameValues
  if (!Number.isInteger(version) || !Array.isArray(frameTypes) || frameTypes.length === 0
    || !Array.isArray(retiredEntries)) return null
  const frameNames = frameTypes.map((frame) => String(frame?.name ?? ''))
  const frameValues = frameTypes.map((frame) => frame?.value)
  const retiredFrameValues = retiredEntries.map((entry) => entry?.value)
  if (frameNames.some((name) => name.length === 0)
    || frameValues.some((value) => !Number.isInteger(value))
    || retiredFrameValues.some((value) => !Number.isInteger(value))
    || new Set(frameNames).size !== frameNames.length
    || new Set(frameValues).size !== frameValues.length
    || new Set(retiredFrameValues).size !== retiredFrameValues.length
    || frameValues.some((value) => retiredFrameValues.includes(value))) return null
  const named = frameNames.filter((name) => name !== 'Unknown').sort()
  const activeFrameIds = named.filter((name) => !name.startsWith('Reserved'))
  if (activeFrameIds.length === 0) return null
  return {
    supportedVersions: [version],
    activeFrameIds,
    retiredFrameValues: [...retiredFrameValues].sort((left, right) => left - right),
    migrationOnlyFrameIds: named.filter((name) => name.startsWith('Reserved')),
    aedsOnly: true
  }
}

function readJson(absolute, label, failureReasons)
{
  if (!existsSync(absolute))
  {
    failureReasons.push(`missing ${label}`)
    return null
  }
  try
  {
    return JSON.parse(readFileSync(absolute, 'utf8'))
  }
  catch (error)
  {
    failureReasons.push(`${label} JSON parse failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function validateExactBuildReceipt(repositoryRoot, suppliedIdentity)
{
  const failureReasons = []
  const receipt = readJson(path.join(repositoryRoot, buildReceiptRelative), 'canonical OpenAPI build receipt', failureReasons)
  if (receipt == null) return { failureReasons, receipt: null }
  const receiptKeys = [
    'schema', 'artifactId', 'observationPath', 'openapiPath', 'observationDigest', 'artifactDigest',
    'openapiDigest', 'sourceDigests', 'sourceDigest', 'contractDigest', 'errorCatalogDigest',
    'generatorDigest', 'protocolDigest', 'configuration', 'buildIdentity'
  ]
  const identityKeys = [
    'artifactId', 'receiptDigest', 'artifactDigest', 'sourceDigest', 'contractDigest',
    'errorCatalogDigest', 'generatorDigest', 'protocolDigest'
  ]
  if (!exactKeys(receipt, receiptKeys)
    || receipt.schema !== 'fsusblog.openapi-observation-build-receipt.v1'
    || receipt.artifactId !== expectedArtifactId
    || receipt.observationPath !== observationRelative
    || receipt.openapiPath !== observedOpenApiRelative
    || !['Debug', 'Release'].includes(receipt.configuration)
    || !exactKeys(receipt.buildIdentity, identityKeys)
    || !exactKeys(receipt.sourceDigests, sourcePaths))
  {
    failureReasons.push('canonical OpenAPI build receipt shape/path/source set is invalid')
    return { failureReasons, receipt }
  }

  const { buildIdentity: embeddedIdentity, ...receiptBody } = receipt
  const actualReceiptDigest = digestValue(receiptBody)
  if (embeddedIdentity.receiptDigest !== actualReceiptDigest)
  {
    failureReasons.push('canonical OpenAPI build receipt self-digest mismatch')
  }
  for (const key of identityKeys.filter((key) => key !== 'receiptDigest'))
  {
    if (embeddedIdentity[key] !== receipt[key]) failureReasons.push(`build receipt embedded ${key} mismatch`)
  }
  if (!exactKeys(suppliedIdentity, ['artifactId', 'receiptDigest', 'artifactDigest'])
    || suppliedIdentity.artifactId !== embeddedIdentity.artifactId
    || suppliedIdentity.receiptDigest !== embeddedIdentity.receiptDigest
    || suppliedIdentity.artifactDigest !== embeddedIdentity.artifactDigest)
  {
    failureReasons.push('supplied buildIdentity does not identify the canonical OpenAPI build receipt')
  }

  const actualSourceDigests = {}
  for (const relative of sourcePaths)
  {
    const absolute = path.join(repositoryRoot, relative)
    if (!existsSync(absolute))
    {
      failureReasons.push(`build receipt source missing: ${relative}`)
      continue
    }
    actualSourceDigests[relative] = sha256(readFileSync(absolute))
    if (receipt.sourceDigests[relative] !== actualSourceDigests[relative])
    {
      failureReasons.push(`build receipt source digest mismatch: ${relative}`)
    }
  }
  if (receipt.sourceDigest !== digestValue(actualSourceDigests)) failureReasons.push('build receipt aggregate source digest mismatch')
  if (receipt.generatorDigest !== actualSourceDigests[generatorRelative]) failureReasons.push('build receipt generator digest mismatch')
  if (receipt.protocolDigest !== actualSourceDigests[protocolRelative]) failureReasons.push('build receipt protocol digest mismatch')

  const endpointContract = readJson(path.join(repositoryRoot, endpointContractRelative), 'canonical endpoint contract', failureReasons)
  if (endpointContract != null)
  {
    const { contentDigest: declared, ...content } = endpointContract
    const actual = sha256(Buffer.from(JSON.stringify(content), 'utf8'))
    if (declared !== actual || receipt.contractDigest !== actual) failureReasons.push('build receipt contract digest mismatch')
  }
  const behaviorCatalog = readJson(path.join(repositoryRoot, behaviorCatalogRelative), 'current BehaviorCatalog', failureReasons)
  if (behaviorCatalog != null && receipt.errorCatalogDigest !== digestCatalog(behaviorCatalog))
  {
    failureReasons.push('build receipt error authority digest mismatch')
  }
  for (const [relative, expected, label] of [
    [observationRelative, receipt.artifactDigest, 'observation artifact'],
    [observedOpenApiRelative, receipt.openapiDigest, 'observed OpenAPI artifact']
  ])
  {
    const absolute = path.join(repositoryRoot, relative)
    if (!existsSync(absolute)) failureReasons.push(`missing ${label} at fixed canonical path`)
    else if (sha256(readFileSync(absolute)) !== expected) failureReasons.push(`${label} digest mismatch`)
  }
  return { failureReasons, receipt }
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

  const receiptValidation = validateExactBuildReceipt(context.repositoryRoot, buildIdentity)
  if (receiptValidation.failureReasons.length > 0)
  {
    return {
      status: 'failed',
      failureReasons: receiptValidation.failureReasons,
      observations: {}
    }
  }
  const buildReceipt = receiptValidation.receipt

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
  const artifactDigest = sha256(bytes)
  if (artifactDigest !== buildReceipt.artifactDigest)
  {
    return {
      status: 'failed',
      failureReasons: [
        `observation artifact digest mismatch (refuses unbound or stale build; expected ${buildReceipt.artifactDigest}, got ${artifactDigest})`
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
  const protocol = readJson(path.join(context.repositoryRoot, protocolRelative), 'canonical AEDS protocol', failureReasons)
  const expectedProtocolStates = protocolStateCatalog(protocol)
  if (expectedProtocolStates == null || JSON.stringify(protocolStates) !== JSON.stringify(expectedProtocolStates))
  {
    failureReasons.push('active/retired/migration/AEDS-only protocol states do not match canonical aeds-protocol.json')
  }
  if (observation.observationDigest !== observationContentDigest(observation)
    || buildReceipt.observationDigest !== observation.observationDigest)
  {
    failureReasons.push('observationDigest does not match current observation content and build receipt')
  }
  if (!exactKeys(errorAuthority, ['behaviorId', 'catalogDigest', 'documentPath', 'factIds', 'statusMappingKeys'])
    || errorAuthority.behaviorId !== 'configuration-error-security-policy'
    || !/^[a-f0-9]{64}$/u.test(String(errorAuthority.catalogDigest ?? ''))
    || errorAuthority.documentPath !== 'docs/api/schemas-and-errors.md'
    || JSON.stringify(errorAuthority.factIds) !== JSON.stringify([
      'facts.error-codes.domain.active',
      'facts.error-codes.transport-mapping'
    ])
    || !isSortedUnique(errorAuthority.statusMappingKeys)
    || errorAuthority.statusMappingKeys.length === 0
    || !errorAuthority.statusMappingKeys.every((status) => Number.isInteger(status) && status >= 400 && status <= 599))
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
  const behaviorCatalog = path.join(context.repositoryRoot, behaviorCatalogRelative)
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
    if (!validResponses(op, new Set(errorAuthority?.statusMappingKeys ?? [])))
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
