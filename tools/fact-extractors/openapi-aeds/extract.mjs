import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const observationRelative = '.tmp/contracts/openapi/api-aeds-observation.json'
const expectedArtifactId = 'openapi-aeds-observation'

/**
 * compiled-assembly extractor for binary OpenAPI/AEDS facts.
 * Reads only the sealed observation artifact produced by FsusBlog.OpenApiObservation
 * for this exact build identity. Never reads checked-in OpenAPI as observation input.
 */
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

  if (observation?.schema !== 'fsusblog.api-aeds-observation.v1')
  {
    return {
      status: 'failed',
      failureReasons: ['observation schema is not fsusblog.api-aeds-observation.v1'],
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

  for (const op of observation.operations)
  {
    const key = `${op.method} ${op.path}`
    if (seenMethodPaths.has(key)) failureReasons.push(`duplicate method/path ${key}`)
    seenMethodPaths.add(key)
    if (!op.operationId) failureReasons.push(`${key} missing operationId`)
    if (seenOperationIds.has(op.operationId)) failureReasons.push(`duplicate operationId ${op.operationId}`)
    seenOperationIds.add(op.operationId)
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
      successStatus: Number(op.successStatus ?? 200)
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
      artifactDigest
    }
  }
}
