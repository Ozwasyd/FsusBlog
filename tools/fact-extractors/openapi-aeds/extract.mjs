import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { digestCatalog } from '../../contracts/behavior-contract-catalog.mjs'

const observationRelative = '.tmp/contracts/openapi/api-aeds-observation.json'
const expectedArtifactId = 'openapi-aeds-observation'
const exactKeys = (value, expected) => value && typeof value === 'object'
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())

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

  if (observation?.schema !== 'fsusblog.api-aeds-observation.v2')
  {
    return {
      status: 'failed',
      failureReasons: ['observation schema is not fsusblog.api-aeds-observation.v2'],
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
  const behaviorCatalog = path.join(context.repositoryRoot, 'config/contracts/behavior-contracts.json')
  if (existsSync(behaviorCatalog)
    && digestCatalog(JSON.parse(readFileSync(behaviorCatalog, 'utf8'))) !== errorAuthority?.catalogDigest)
  {
    failureReasons.push('error authority catalog digest does not match current BehaviorCatalog')
  }

  for (const op of observation.operations)
  {
    const key = `${op.method} ${op.path}`
    if (seenMethodPaths.has(key)) failureReasons.push(`duplicate method/path ${key}`)
    seenMethodPaths.add(key)
    if (!op.operationId) failureReasons.push(`${key} missing operationId`)
    if (seenOperationIds.has(op.operationId)) failureReasons.push(`duplicate operationId ${op.operationId}`)
    seenOperationIds.add(op.operationId)
    if (!exactKeys(op.request, ['source', 'schemaRef', 'required', 'nullable', 'requiredFields', 'parameters', 'fieldSetState', 'boundsState', 'unionState'])
      || !['none', 'aeds-frame-body'].includes(op.request.source)
      || typeof op.request.required !== 'boolean' || typeof op.request.nullable !== 'boolean'
      || !Array.isArray(op.request.requiredFields) || !Array.isArray(op.request.parameters)
      || !['not-applicable', 'opaque-aeds-frame'].includes(op.request.fieldSetState)
      || !['not-applicable', 'opaque-aeds-frame'].includes(op.request.boundsState)
      || !['not-applicable', 'opaque-aeds-frame'].includes(op.request.unionState)
      || op.request.nullable !== false || op.request.requiredFields.length !== 0)
    {
      failureReasons.push(`${key} request contract is not closed and typed`)
    }
    else if ((op.requestFrame == null && (op.request.source !== 'none' || op.request.schemaRef !== null || op.request.required !== false))
      || (op.requestFrame != null && (op.request.source !== 'aeds-frame-body'
        || op.request.schemaRef !== `aeds://frame/${op.requestFrame}` || op.request.required !== true)))
    {
      failureReasons.push(`${key} request direction/schema does not match the typed frame`)
    }
    if (!Array.isArray(op.responses) || op.responses.length !== 2
      || op.responses.some((response) => !exactKeys(response, ['status', 'schemaRef', 'contentType', 'resultPlacement', 'nullable'])
        || response.contentType !== 'application/octet-stream'
        || response.resultPlacement !== 'aeds.frame.payload'
        || !String(response.schemaRef ?? '').startsWith('aeds://frame/')
        || response.nullable !== false))
    {
      failureReasons.push(`${key} response contracts/result placement are invalid`)
    }
    else if (op.responses[0].status !== Number(op.successStatus)
      || op.responses[0].schemaRef !== `aeds://frame/${op.responseFrame}`
      || op.responses[1].status !== null
      || op.responses[1].schemaRef !== `aeds://frame/${op.errorFrame}`)
    {
      failureReasons.push(`${key} response status/schema direction conflicts with frame contract`)
    }
    if (op.errorAuthorityBehaviorId !== 'configuration-error-security-policy'
      || op.publicErrorRefState !== 'transport-frame-authority-only'
      || JSON.stringify(op.publicErrorRefs) !== JSON.stringify(['configuration-error-security-policy:error-transport-mappings:ApiError']))
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
      request: {
        source: op.request?.source ?? 'invalid',
        schemaRef: op.request?.schemaRef ?? 'none',
        required: op.request?.required ?? false,
        nullable: op.request?.nullable ?? false,
        fieldSetState: op.request?.fieldSetState ?? 'invalid',
        boundsState: op.request?.boundsState ?? 'invalid',
        unionState: op.request?.unionState ?? 'invalid',
        requiredFieldSetState: Array.isArray(op.request?.requiredFields) && op.request.requiredFields.length > 0 ? 'present' : 'empty',
        parameterSetState: Array.isArray(op.request?.parameters) && op.request.parameters.length > 0 ? 'present' : 'empty',
        ...(Array.isArray(op.request?.requiredFields) && op.request.requiredFields.length > 0 ? { requiredFields: op.request.requiredFields } : {}),
        ...(Array.isArray(op.request?.parameters) && op.request.parameters.length > 0
          ? { parameters: Object.fromEntries(op.request.parameters.map((parameter) => [parameter.name, parameter])) }
          : {})
      },
      responses: Object.fromEntries((Array.isArray(op.responses) ? op.responses : []).map((response, index) => [
        response.status == null ? 'default' : `status-${response.status}-${index}`,
        { ...response, status: response.status ?? 'default' }
      ])),
      publicErrorRefs: op.publicErrorRefs,
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
      artifactDigest
    }
  }
}
