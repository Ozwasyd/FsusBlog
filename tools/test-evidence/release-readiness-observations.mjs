import {
  currentJson,
  exactKeys,
  fail,
  observationSchemas,
  readinessChecks,
  releaseIdPattern,
  requireDigest,
  semanticDigest,
  verifySeal
} from './release-readiness-source-support.mjs'

export function buildFacts(plan, repositoryRoot)
{
  const build = currentJson(plan.build.receipt, 'production build receipt', repositoryRoot)
  if (build.value.contentDigest !== plan.build.receiptContentDigest
    || build.value.sourceState?.commit !== plan.sourceState.commit
    || String(build.value.sourceState?.worktreeFingerprint ?? '').replace(/^sha256:/u, '')
      !== plan.sourceState.worktreeFingerprint.replace(/^sha256:/u, ''))
  {
    fail('production build receipt does not exact-match candidate plan')
  }
  if (build.value.schema !== 'fsusblog.ci-production-build-receipt.v1' || build.value.status !== 'complete')
  {
    fail('production build receipt schema/status mismatch')
  }
  verifySeal(build.value, 'production build receipt')
  if (!Array.isArray(build.value.artifacts) || build.value.artifacts.length === 0) fail('production build has no artifact package')
  return {
    receipt: build,
    artifactDigest: semanticDigest(build.value.artifacts),
    packageDigest: semanticDigest({ domains: build.value.domains, artifacts: build.value.artifacts }),
    toolchainIdentity: semanticDigest(build.value.toolchain)
  }
}

export function imageObservation(value, source, manifest)
{
  exactKeys(value, [
    'schema', 'releaseId', 'imageRef', 'imageDigest', 'registryDigest',
    'runtimeImageDigest', 'imageConfigDigest', 'registryInspected', 'verified'
  ], 'observations.image')
  if (value.schema !== observationSchemas.image) fail('observations.image schema mismatch')
  for (const field of ['imageDigest', 'registryDigest', 'runtimeImageDigest', 'imageConfigDigest'])
  {
    requireDigest(value[field], `observations.image.${field}`)
  }
  if (value.releaseId !== source.releaseId || value.imageRef !== manifest.imageRef
    || value.imageDigest !== manifest.imageDigest || value.registryDigest !== manifest.imageDigest
    || value.runtimeImageDigest !== manifest.imageDigest
    || value.registryInspected !== true || value.verified !== true)
  {
    fail('image registry/runtime identity is not exact')
  }
}

export function packageObservation(value, source, manifest, build)
{
  exactKeys(value, [
    'schema', 'buildIdentity', 'artifactDigest', 'packageDigest', 'imageDigest',
    'artifactCount', 'verified'
  ], 'observations.package')
  if (value.schema !== observationSchemas.package) fail('observations.package schema mismatch')
  for (const field of ['buildIdentity', 'artifactDigest', 'packageDigest', 'imageDigest'])
  {
    requireDigest(value[field], `observations.package.${field}`)
  }
  if (value.buildIdentity !== source.buildIdentity || value.artifactDigest !== build.artifactDigest
    || value.packageDigest !== build.packageDigest || value.imageDigest !== manifest.imageDigest
    || value.artifactCount !== build.receipt.value.artifacts.length || value.verified !== true)
  {
    fail('package observation does not match production build and image')
  }
}

export function configObservation(value, source)
{
  exactKeys(value, [
    'schema', 'releaseId', 'slot', 'expectedDigest', 'observedDigest',
    'publicProjectionDigest', 'redacted', 'secretValuesPersisted', 'verified'
  ], 'observations.config')
  if (value.schema !== observationSchemas.config) fail('observations.config schema mismatch')
  for (const field of ['expectedDigest', 'observedDigest', 'publicProjectionDigest'])
  {
    requireDigest(value[field], `observations.config.${field}`)
  }
  if (value.releaseId !== source.releaseId || value.slot !== source.slot
    || value.expectedDigest !== value.observedDigest || value.redacted !== true
    || value.secretValuesPersisted !== false || value.verified !== true)
  {
    fail('runtime config observation is mismatched or not privacy-safe')
  }
}

export function schemaObservation()
{
  fail('legacy database schema windows are retired; current-schema post-runtime admitted native collector is not connected')
}

export function signingObservation(value, manifestDigest)
{
  exactKeys(value, [
    'schema', 'algorithm', 'payloadDigest', 'signatureDigest',
    'signerIdentityDigest', 'verificationReceiptDigest', 'verified'
  ], 'observations.signing')
  if (value.schema !== observationSchemas.signing
    || !['cosign-keyless', 'sigstore-bundle'].includes(value.algorithm))
  {
    fail('signing observation schema/algorithm mismatch')
  }
  for (const field of ['payloadDigest', 'signatureDigest', 'signerIdentityDigest', 'verificationReceiptDigest'])
  {
    requireDigest(value[field], `observations.signing.${field}`)
  }
  if (value.payloadDigest !== manifestDigest || value.verified !== true) fail('release manifest signature was not verified')
}

export function trustObservation(value, imageDigest, manifestDigest)
{
  exactKeys(value, [
    'schema', 'policyDigest', 'publisherIdentityDigest', 'decision',
    'artifactDigest', 'manifestDigest', 'transparencyLogDigest', 'verified'
  ], 'observations.trust')
  if (value.schema !== observationSchemas.trust) fail('observations.trust schema mismatch')
  for (const field of ['policyDigest', 'publisherIdentityDigest', 'artifactDigest', 'manifestDigest', 'transparencyLogDigest'])
  {
    requireDigest(value[field], `observations.trust.${field}`)
  }
  if (value.decision !== 'trusted' || value.artifactDigest !== imageDigest
    || value.manifestDigest !== manifestDigest || value.verified !== true)
  {
    fail('release trust decision does not bind the image and manifest')
  }
}

export function runtimeRoleObservation(value, source)
{
  exactKeys(value, [
    'schema', 'releaseId', 'slot', 'runtimeId', 'topologyMode', 'deploymentMode',
    'processIdentityDigest', 'containerIdentityDigest', 'serviceIdentityDigest',
    'ownershipDigest', 'actualObservationSources', 'processCount', 'containerCount',
    'serviceCount', 'unknownOwnerCount', 'conflictingOwnerCount', 'observedRole',
    'roleContractSatisfied', 'monolithicOwnershipSatisfied'
  ], 'observations.runtimeRole')
  if (value.schema !== observationSchemas.runtimeRole) fail('observations.runtimeRole schema mismatch')
  for (const field of ['processIdentityDigest', 'containerIdentityDigest', 'serviceIdentityDigest', 'ownershipDigest'])
  {
    requireDigest(value[field], `observations.runtimeRole.${field}`)
  }
  const actualSources = ['container-runtime-inspect', 'proc-cgroup', 'service-manager-status']
  if (value.releaseId !== source.releaseId || value.slot !== source.slot || value.runtimeId !== source.runtimeId
    || value.topologyMode !== 'monolithic' || value.deploymentMode !== 'candidate'
    || JSON.stringify(value.actualObservationSources) !== JSON.stringify(actualSources)
    || !Number.isSafeInteger(value.processCount) || value.processCount < 1
    || value.containerCount !== 1 || value.serviceCount !== 1
    || value.unknownOwnerCount !== 0 || value.conflictingOwnerCount !== 0
    || value.observedRole !== 'candidate' || value.roleContractSatisfied !== true
    || value.monolithicOwnershipSatisfied !== true)
  {
    fail('runtime-role ownership is unknown, conflicting, inferred, or non-monolithic')
  }
}

export function readinessObservation(value, source, anchors)
{
  exactKeys(value, [
    'schema', 'releaseId', 'slot', 'runtimeId', 'probeClass', 'checks',
    'processAliveOnly', 'portOpenOnly', 'http200Only', 'fileExistsOnly',
    'jobStatusOnly', 'terminalStatus'
  ], 'observations.readiness')
  if (value.schema !== observationSchemas.readiness || value.releaseId !== source.releaseId
    || value.slot !== source.slot || value.runtimeId !== source.runtimeId
    || value.probeClass !== 'semantic-contract' || value.terminalStatus !== 'verified')
  {
    fail('readiness observation identity/schema mismatch')
  }
  for (const shortcut of ['processAliveOnly', 'portOpenOnly', 'http200Only', 'fileExistsOnly', 'jobStatusOnly'])
  {
    if (value[shortcut] !== false) fail(`${shortcut} cannot qualify readiness`)
  }
  exactKeys(value.checks, Object.keys(readinessChecks), 'observations.readiness.checks')
  for (const [checkId, authority] of Object.entries(readinessChecks))
  {
    const check = value.checks[checkId]
    exactKeys(check, [
      'schema', 'authority', 'expectedDigest', 'observedDigest', 'sampleCount',
      'semanticMatch', 'status'
    ], `observations.readiness.checks.${checkId}`)
    if (check.schema !== `fsusblog.release-readiness.${checkId}.v1` || check.authority !== authority)
    {
      fail(`${checkId} readiness authority/schema mismatch`)
    }
    requireDigest(check.expectedDigest, `${checkId}.expectedDigest`)
    requireDigest(check.observedDigest, `${checkId}.observedDigest`)
    if (check.expectedDigest !== check.observedDigest || !Number.isSafeInteger(check.sampleCount)
      || check.sampleCount < 1 || check.semanticMatch !== true || check.status !== 'passed')
    {
      fail(`${checkId} readiness semantic observation did not match`)
    }
  }
  for (const [checkId, digest] of Object.entries(anchors))
  {
    if (value.checks[checkId].expectedDigest !== digest) fail(`${checkId} readiness is not bound to its authority digest`)
  }
}
