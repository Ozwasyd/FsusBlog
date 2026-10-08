export function createPureReleaseAuthorityFixture(semanticDigest)
{
  const reference = (name) => ({
    path: `.tmp/${name}.json`,
    fileDigest: semanticDigest(name),
    contentDigest: null
  })
  const stages = ['candidate-readiness', 'gateway-switch', 'target-health', 'release-evidence']
    .map((stage) => ({ stage, status: 'pass' }))
  const artifacts = Object.fromEntries(
    ['faultInjection', 'publicTraffic', 'assetCompatibility', 'resourceBudget']
      .map((name) => [name, { sha256: semanticDigest(name) }])
  )
  const auxiliary = {
    compatibilityMatrix: { sha256: semanticDigest('matrix') },
    releaseManifest: { sha256: semanticDigest('manifest') }
  }
  const rolloutValue = {
    source: { releaseId: 'old' },
    target: { releaseId: 'new', imageDigest: semanticDigest('image') },
    stages,
    recoveries: [],
    artifacts,
    auxiliary
  }
  const runtimeRole = {
    admission: { ref: reference('admission') },
    deployment: { ref: reference('deployment') },
    observation: { ref: reference('observation') }
  }
  const manifest = {
    ref: reference('manifest'),
    value: { currentSchema: { receiptContentDigest: semanticDigest('current-schema-receipt') } }
  }
  return {
    plan: {
      sourceState: { commit: 'a'.repeat(40) },
      candidate: { candidateId: 'candidate-1', releaseId: 'release-1' }
    },
    planInput: { ref: reference('plan') },
    build: { packageDigest: semanticDigest('package') },
    authorities: {
      authorityDigest: semanticDigest('authority'),
      rollout: { ref: reference('rollout'), value: rolloutValue },
      runtimeRole,
      manifest
    }
  }
}
