import { fail } from './blue-green-containment-support.mjs'

export function crossValidate(byRole, candidateReleaseId)
{
  const before = byRole.get('state-before').observation
  const after = byRole.get('state-after').observation
  const promotion = byRole.get('promotion').observation
  const switched = byRole.get('switch').observation
  const health = byRole.get('health').observation
  const rollback = byRole.get('rollback').observation
  const failures = byRole.get('failure').observation
  const traffic = byRole.get('traffic').observation
  const cleanup = byRole.get('cleanup').observation

  if (before.standby.releaseId !== candidateReleaseId || after.active.releaseId !== candidateReleaseId
    || before.active.releaseId !== after.standby.releaseId
    || before.active.slot !== after.standby.slot || before.standby.slot !== after.active.slot)
  {
    fail('before/after active and standby identities do not prove one exact promotion')
  }
  if (promotion.sourceSlot !== before.active.slot || promotion.targetSlot !== before.standby.slot
    || promotion.sourceReleaseId !== before.active.releaseId
    || promotion.targetReleaseId !== candidateReleaseId
    || promotion.activeReleaseId !== candidateReleaseId
    || switched.sourceSlot !== promotion.sourceSlot || switched.targetSlot !== promotion.targetSlot
    || switched.sourceReleaseId !== promotion.sourceReleaseId
    || switched.targetReleaseId !== promotion.targetReleaseId
    || switched.activeReleaseId !== candidateReleaseId
    || health.releaseId !== candidateReleaseId || traffic.activeReleaseId !== candidateReleaseId)
  {
    fail('promotion, switch, health, traffic, and candidate identities disagree')
  }
  if (rollback.sourceReleaseId !== candidateReleaseId
    || rollback.targetReleaseId !== before.active.releaseId
    || rollback.activeReleaseId !== before.active.releaseId)
  {
    fail('rollback did not restore the exact pre-promotion active identity')
  }
  if (failures.cases.some((item) => item.beforeActiveReleaseId !== before.active.releaseId
    || item.attemptedReleaseId !== candidateReleaseId))
  {
    fail('failure containment cases are not bound to the same active/candidate identities')
  }
  for (const role of ['artifact', 'volume', 'schema', 'process'])
  {
    const observation = byRole.get(role).observation
    if (observation.activeReleaseId !== candidateReleaseId
      || observation.inactiveReleaseId !== before.active.releaseId)
    {
      fail(`${role} containment identities disagree with the terminal active/standby state`)
    }
  }
  if (cleanup.operationOwnedReleaseId !== before.active.releaseId
    || !cleanup.preservedReleaseIds.includes(candidateReleaseId)
    || cleanup.deletedReleaseIds.includes(candidateReleaseId))
  {
    fail('cleanup touched the active release or was not bound to the operation-owned inactive release')
  }
  return { before, after }
}
