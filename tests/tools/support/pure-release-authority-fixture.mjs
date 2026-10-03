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
  // Explicit metadata for pure contract controls only; not an issued receipt or native observation.
  const manifest = {
    ref: reference('manifest'),
    value: {
      schema: 'fsusblog.release-manifest.v3',
      currentSchema: {
        receipt: { reference: '.tmp/current-schema-contract-fixture.json', sha256: '1'.repeat(64) },
        target: {
          modelVersion: 'contract-fixture-model.v1', extractorVersion: 'contract-fixture-extractor.v1',
          generatorVersion: 'contract-fixture-generator.v1', sourceDigest: '2'.repeat(64), contentDigest: '3'.repeat(64)
        },
        database: { provider: 0, instanceId: 'contract-fixture-instance', databaseId: 'contract-fixture-database' },
        actualSchemaDigest: '4'.repeat(64)
      }
    }
  }
  // Synthetic semantic materials for the post-v2 bundle projection only. They
  // are not serialized by the native codec, collected from a process or admitted.
  const receiptRef = { path: manifest.value.currentSchema.receipt.reference,
    fileDigest: `sha256:${manifest.value.currentSchema.receipt.sha256}`,
    contentDigest: `sha256:${'5'.repeat(64)}`, schema: 'fsusblog.current-schema-receipt.v1' }
  const artifact = name => ({ reference: `.tmp/contract-fixture-${name}.json`, sha256: '6'.repeat(64) })
  const currentSchema = {
    receiptRef,
    receipt: {
      format: receiptRef.schema, status: 'verified-current',
      target: structuredClone(manifest.value.currentSchema.target),
      sourceFingerprintId: 'contract-fixture-source', sourceFingerprintVersion: 'contract-fixture.v1',
      sourceRegistryDigest: '7'.repeat(64), sourceObservationDigest: '8'.repeat(64),
      plan: artifact('plan'), apply: artifact('apply'), checkpoints: [artifact('checkpoint')],
      database: structuredClone(manifest.value.currentSchema.database),
      actualSchemaDigest: manifest.value.currentSchema.actualSchemaDigest,
      semanticPostconditions: [{ stepId: 'contract-fixture-step', predicateReference: 'contract-fixture-predicate.v1',
        expectedDigest: '9'.repeat(64), actualDigest: '9'.repeat(64), evidenceDigest: 'e'.repeat(64) }],
      backupPackage: artifact('backup'), backupManifest: artifact('backup-manifest'),
      restoreDrill: artifact('restore'), recoveryReferences: [artifact('recovery')],
      verifier: { sourceRevision: 'a'.repeat(40), worktreeDigest: 'b'.repeat(64),
        toolchainDigest: 'c'.repeat(64), configurationDigest: 'd'.repeat(64) },
      reasons: [], contentDigest: '5'.repeat(64)
    },
    admission: {
      ref: reference('current-schema-admission'),
      value: { status: 'verified-current', candidateSourceRevision: 'a'.repeat(40),
        artifactSha256: manifest.value.currentSchema.receipt.sha256,
        target: structuredClone(manifest.value.currentSchema.target),
        database: structuredClone(manifest.value.currentSchema.database),
        actualSchemaDigest: manifest.value.currentSchema.actualSchemaDigest }
    }
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
      manifest,
      currentSchema
    }
  }
}
