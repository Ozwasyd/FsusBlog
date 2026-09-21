import {
  exactKeys,
  expectedIdentity,
  fail,
  requireDigest,
  requireId,
  requireIdentity,
  roles,
  safeIdentifierPattern,
  safeInput,
  sourceReceiptSchema,
  verifySeal
} from './blue-green-containment-support.mjs'

function slotIdentity(value, label)
{
  exactKeys(value, [
    'slot', 'releaseId', 'imageDigest', 'artifactDigest', 'volumeDigest',
    'schemaDigest', 'processDigest', 'runtimeRole'
  ], label)
  if (!['blue', 'green'].includes(value.slot)) fail(`${label} slot must be blue or green`)
  requireId(value.releaseId, `${label} releaseId`)
  for (const field of ['imageDigest', 'artifactDigest', 'volumeDigest', 'schemaDigest', 'processDigest'])
  {
    requireDigest(value[field], `${label} ${field}`)
  }
  if (value.runtimeRole !== 'monolithic') fail(`${label} runtime role must be observed as monolithic`)
  return value
}

function stateObservation(value, role)
{
  exactKeys(value, ['active', 'standby'], `${role} observation`)
  const active = slotIdentity(value.active, `${role} active`)
  const standby = slotIdentity(value.standby, `${role} standby`)
  if (active.slot === standby.slot || active.releaseId === standby.releaseId)
  {
    fail(`${role} active and standby identities are ambiguous`)
  }
  return { active, standby }
}

function transitionObservation(value, role, expectedStatus)
{
  exactKeys(value, [
    'sourceSlot', 'targetSlot', 'sourceReleaseId', 'targetReleaseId',
    'activeReleaseId', 'gatewayGeneration', 'status'
  ], `${role} observation`)
  if (!['blue', 'green'].includes(value.sourceSlot) || !['blue', 'green'].includes(value.targetSlot)
    || value.sourceSlot === value.targetSlot)
  {
    fail(`${role} slot transition is invalid`)
  }
  for (const field of ['sourceReleaseId', 'targetReleaseId', 'activeReleaseId']) requireId(value[field], `${role} ${field}`)
  if (!Number.isSafeInteger(value.gatewayGeneration) || value.gatewayGeneration < 1) fail(`${role} gatewayGeneration is invalid`)
  if (value.status !== expectedStatus) fail(`${role} status must be ${expectedStatus}`)
  return value
}

function healthObservation(value)
{
  const booleans = [
    'serviceReady', 'routeDataReady', 'cacheReady', 'dependenciesReady',
    'versionReady', 'credentialReady'
  ]
  exactKeys(value, ['releaseId', ...booleans, 'status'], 'health observation')
  requireId(value.releaseId, 'health releaseId')
  if (value.status !== 'passed' || booleans.some((field) => value[field] !== true))
  {
    fail('health observation is incomplete; process, port, HTTP, or file existence cannot substitute readiness')
  }
  return value
}

function failureObservation(value)
{
  exactKeys(value, ['cases', 'status'], 'failure observation')
  if (value.status !== 'passed' || !Array.isArray(value.cases) || value.cases.length === 0) fail('failure cases are missing')
  const ids = new Set()
  for (const item of value.cases)
  {
    exactKeys(item, [
      'caseId', 'beforeActiveReleaseId', 'attemptedReleaseId',
      'afterActiveReleaseId', 'terminalState'
    ], 'failure case')
    requireId(item.caseId, 'failure caseId')
    if (ids.has(item.caseId)) fail(`duplicate failure case ${item.caseId}`)
    ids.add(item.caseId)
    for (const field of ['beforeActiveReleaseId', 'attemptedReleaseId', 'afterActiveReleaseId'])
    {
      requireId(item[field], `failure ${field}`)
    }
    if (item.beforeActiveReleaseId !== item.afterActiveReleaseId || item.terminalState !== 'contained')
    {
      fail(`failure case ${item.caseId} changed or obscured the active release`)
    }
  }
  return value
}

function trafficObservation(value)
{
  exactKeys(value, [
    'activeReleaseId', 'ownerReleaseIds', 'partialSwitch', 'splitBrain',
    'unknownOwner', 'status'
  ], 'traffic observation')
  requireId(value.activeReleaseId, 'traffic activeReleaseId')
  if (value.status !== 'passed' || value.partialSwitch !== false || value.splitBrain !== false
    || value.unknownOwner !== false || !Array.isArray(value.ownerReleaseIds)
    || value.ownerReleaseIds.length !== 1 || value.ownerReleaseIds[0] !== value.activeReleaseId)
  {
    fail('traffic ownership is partial, split-brain, or ambiguous')
  }
  return value
}

function containmentObservation(value, role)
{
  exactKeys(value, [
    'activeReleaseId', 'inactiveReleaseId', 'activePreserved',
    'inactiveOperationOwned', 'sharedPreserved', 'status'
  ], `${role} observation`)
  requireId(value.activeReleaseId, `${role} activeReleaseId`)
  requireId(value.inactiveReleaseId, `${role} inactiveReleaseId`)
  if (value.activeReleaseId === value.inactiveReleaseId || value.status !== 'passed'
    || value.activePreserved !== true || value.inactiveOperationOwned !== true
    || value.sharedPreserved !== true)
  {
    fail(`${role} containment did not preserve active/shared facts or prove inactive ownership`)
  }
  return value
}

function processObservation(value)
{
  const observation = containmentObservation(value, 'process')
  if (observation.runtimeRoleContractSatisfied !== undefined) fail('process observation contains an unsupported inferred runtime role')
  return observation
}

function cleanupObservation(value)
{
  exactKeys(value, [
    'operationOwnedReleaseId', 'deletedReleaseIds', 'preservedReleaseIds',
    'activeTouched', 'sharedTouched', 'otherRunTouched', 'status'
  ], 'cleanup observation')
  requireId(value.operationOwnedReleaseId, 'cleanup operationOwnedReleaseId')
  if (!Array.isArray(value.deletedReleaseIds) || !Array.isArray(value.preservedReleaseIds)
    || value.deletedReleaseIds.some((releaseId) => !safeIdentifierPattern.test(releaseId))
    || value.preservedReleaseIds.some((releaseId) => !safeIdentifierPattern.test(releaseId))
    || !value.deletedReleaseIds.includes(value.operationOwnedReleaseId)
    || value.status !== 'passed' || value.activeTouched !== false
    || value.sharedTouched !== false || value.otherRunTouched !== false)
  {
    fail('cleanup is not limited to current-operation owned inactive facts')
  }
  return value
}

function terminalObservation(value)
{
  exactKeys(value, [
    'status', 'errors', 'timedOut', 'cancelled', 'automaticRetryCount',
    'privacySafe', 'canonicalRerunCommand'
  ], 'terminal observation')
  if (value.status !== 'passed' || !Array.isArray(value.errors) || value.errors.length !== 0
    || value.timedOut !== false || value.cancelled !== false || value.automaticRetryCount !== 0
    || value.privacySafe !== true || typeof value.canonicalRerunCommand !== 'string'
    || value.canonicalRerunCommand.length === 0)
  {
    fail('terminal receipt is failed, incomplete, retried, or not privacy-safe')
  }
  return value
}

function verifyObservation(role, value)
{
  if (role === 'state-before' || role === 'state-after') return stateObservation(value, role)
  if (role === 'promotion') return transitionObservation(value, role, 'promoted')
  if (role === 'switch') return transitionObservation(value, role, 'committed')
  if (role === 'rollback') return transitionObservation(value, role, 'rolled-back')
  if (role === 'health') return healthObservation(value)
  if (role === 'failure') return failureObservation(value)
  if (role === 'traffic') return trafficObservation(value)
  if (['artifact', 'volume', 'schema'].includes(role)) return containmentObservation(value, role)
  if (role === 'process') return processObservation(value)
  if (role === 'cleanup') return cleanupObservation(value)
  if (role === 'terminal') return terminalObservation(value)
  fail(`unknown source role ${role}`)
}

export function loadSources(paths, context, deploymentId, repositoryRoot)
{
  if (!Array.isArray(paths) || paths.length !== roles.length) fail('source receipt closure must be exact-one per role')
  requireId(deploymentId, 'deploymentId')
  const expected = expectedIdentity(context, deploymentId)
  const byRole = new Map()
  for (const [index, relative] of paths.entries())
  {
    const input = safeInput(relative, repositoryRoot, `source receipt ${index}`)
    const receipt = input.value
    if (receipt.schema !== sourceReceiptSchema || !roles.includes(receipt.role)) fail('source receipt schema/role mismatch')
    if (byRole.has(receipt.role)) fail(`duplicate source receipt role ${receipt.role}`)
    verifySeal(receipt, `${receipt.role} source receipt`)
    requireIdentity(receipt, expected, receipt.role)
    if (receipt.executionClass !== 'correctness' || receipt.evidenceClass !== 'correctness'
      || receipt.qualificationEligible !== true || receipt.planned !== true
      || receipt.executed !== true || receipt.outcome !== 'passed'
      || receipt.recovered !== false || receipt.diagnostic !== false
      || receipt.stale !== false || receipt.crossCandidate !== false)
    {
      fail(`${receipt.role} is diagnostic, recovered, stale, cross-candidate, blocked, unknown, or not passed`)
    }
    if (typeof receipt.canonicalRerunCommand !== 'string' || receipt.canonicalRerunCommand.length === 0)
    {
      fail(`${receipt.role} canonical rerun command is missing`)
    }
    const observation = verifyObservation(receipt.role, receipt.observation)
    byRole.set(receipt.role, { receipt, observation, ref: input.ref })
  }
  if (roles.some((role) => !byRole.has(role))) fail('source receipt closure has missing roles')
  return { expected, byRole }
}
