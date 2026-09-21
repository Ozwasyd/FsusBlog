import { validateCandidatePlan } from '../fact-extractors/post-runtime/adapter.mjs'
import { root } from '../test-matrix/post-runtime-producer-registry.mjs'
import {
  buildFacts,
  configObservation,
  imageObservation,
  packageObservation,
  readinessObservation,
  runtimeRoleObservation,
  schemaObservation,
  signingObservation,
  trustObservation
} from './release-readiness-observations.mjs'
import {
  assertPrivacySafe,
  exactKeys,
  fail,
  manifestReference,
  observationSchemas,
  provenance,
  releaseReadinessSourceSchema,
  semanticDigest,
  sourceState,
  verifySeal
} from './release-readiness-source-support.mjs'

export function validateReleaseReadinessSource(value, { candidatePlan, repositoryRoot = root } = {})
{
  const plan = validateCandidatePlan(candidatePlan, { repositoryRoot })
  exactKeys(value, [
    'schema', 'producerId', 'sourceState', 'provenance', 'manifestRef',
    'observations', 'contentDigest'
  ], 'release readiness source')
  if (value.schema !== releaseReadinessSourceSchema || value.producerId !== plan.producerId)
  {
    fail('release readiness source schema/producer mismatch')
  }
  verifySeal(value, 'release readiness source')
  assertPrivacySafe(value, 'release readiness source')
  const source = sourceState(value.sourceState, plan)
  provenance(value.provenance)
  const manifestInput = manifestReference(value.manifestRef, repositoryRoot, source, plan)
  const build = buildFacts(plan, repositoryRoot)
  if (source.artifactDigest !== build.artifactDigest) fail('sourceState.artifactDigest does not match production build package')
  exactKeys(value.observations, Object.keys(observationSchemas), 'observations')
  imageObservation(value.observations.image, source, manifestInput.manifest)
  packageObservation(value.observations.package, source, manifestInput.manifest, build)
  configObservation(value.observations.config, source)
  schemaObservation(value.observations.databaseSchema, source, manifestInput.manifest)
  signingObservation(value.observations.signing, manifestInput.ref.fileDigest)
  trustObservation(value.observations.trust, manifestInput.manifest.imageDigest, manifestInput.ref.fileDigest)
  runtimeRoleObservation(value.observations.runtimeRole, source)
  const versionDigest = semanticDigest({
    toolchain: manifestInput.manifest.toolchain,
    runtimeProfile: manifestInput.manifest.runtimeProfile
  })
  readinessObservation(value.observations.readiness, source, {
    service: value.observations.runtimeRole.serviceIdentityDigest,
    dependencies: value.observations.databaseSchema.schemaDigest,
    version: versionDigest,
    credential: value.observations.trust.policyDigest
  })
  return { source: value, plan, manifest: manifestInput, build, versionDigest }
}
