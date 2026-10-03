import path from 'node:path'
import { seal } from '../fact-extractors/post-runtime/receipt-seal-contract.mjs'

export const releaseReadinessAuthorityBundleSchema = 'fsusblog.release-identity-readiness-authority-bundle.v2'
export const canonicalAuthorityBundleSchema = 'fsusblog.blue-green-containment-authority-bundle.v2'

// A reference is not native qualification. The original owned verifier must
// independently validate its artifact and database before producing authorities.
export function requireCurrentSchemaReceiptReference(reference)
{
  const keys = ['path', 'fileDigest', 'contentDigest', 'schema']
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)
    || Object.keys(reference).sort().join('\0') !== keys.sort().join('\0')
    || reference.schema !== 'fsusblog.current-schema-receipt.v1'
    || typeof reference.path !== 'string' || reference.path.length === 0
    || reference.path !== reference.path.trim() || /[\u0000-\u001f\u007f-\u009f\\]/u.test(reference.path)
    || !reference.path.startsWith('.tmp/') || !reference.path.endsWith('.json')
    || path.posix.normalize(reference.path) !== reference.path
    || reference.path.split('/').some((part) => ['..', 'latest', 'history', 'historical'].includes(part.toLowerCase()))
    || !/^sha256:[a-f0-9]{64}$/u.test(reference.fileDigest ?? '')
    || !/^sha256:[a-f0-9]{64}$/u.test(reference.contentDigest ?? '')
    || reference.fileDigest === reference.contentDigest)
  {
    throw new Error('[canonical-release-authorities] explicit current-schema receipt reference is required')
  }
  return { ...reference }
}

export function currentSchemaAuthorityReference(authorities)
{
  if (!authorities?.currentSchema)
  {
    throw new Error('[canonical-release-authorities] current-schema native verification owner is unavailable')
  }
  return requireCurrentSchemaReceiptReference(authorities.currentSchema.receiptRef)
}

function currentSchemaReferenceArguments(reference)
{
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  return `--current-schema-receipt ${quote(reference.path)} --current-schema-file-digest ${reference.fileDigest} --current-schema-content-digest ${reference.contentDigest}`
}

function requireBundleContext({ plan, producer, sourceState, output, classId })
{
  const planned = plan.observations.find((entry) => entry.classId === classId)
  if (!planned || producer?.producerId !== plan.producerId
    || typeof producer.toolVersion !== 'string' || !sourceState
    || typeof output !== 'string' || !output.startsWith('.tmp/')
    || !output.endsWith('.json') || path.posix.normalize(output) !== output
    || output.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/u.test(output))
  {
    throw new Error('[canonical-release-authorities] exact producer/plan/output bundle context is required')
  }
  return planned
}

function quote(value)
{
  return `'${value.replaceAll("'", "'\\''")}'`
}

function embeddedAuthorityReference(reference, schema, role)
{
  return {
    ...reference,
    contentDigest: reference.contentDigest?.startsWith('sha256:')
      ? reference.contentDigest : `sha256:${reference.contentDigest}`,
    schema,
    role
  }
}

// The caller owns persisted input and canonical authority verification.
export function buildReleaseReadinessAuthorityBundle({ planInput, plan, authorities, producer, sourceState, rawFacts, output })
{
  const planned = requireBundleContext({ plan, producer, sourceState, output, classId: 'release-identity-readiness' })
  const currentSchemaReceiptRef = currentSchemaAuthorityReference(authorities)
  return seal({
    schema: releaseReadinessAuthorityBundleSchema,
    producerId: producer.producerId,
    toolVersion: producer.toolVersion,
    sourceState,
    rawFacts,
    candidatePlanRef: planInput.ref,
    rolloutEvidenceRef: embeddedAuthorityReference(authorities.rollout.ref,
      'fsusblog.release-rollout-evidence.v1', 'release-rollout'),
    runtimeRoleAdmissionRef: embeddedAuthorityReference(authorities.runtimeRole.admission.ref,
      'fsusblog.behavior-doc-static-admission-receipt.v2', 'runtime-role-admission'),
    currentSchemaReceiptRef,
    authorityDigest: authorities.authorityDigest,
    canonicalRerunCommand: `node tools/test-evidence/release-readiness-raw.mjs project-authorities --candidate-plan ${quote(planInput.ref.path)} --source ${quote(output)} --out ${quote(planned.receiptPath)}`,
    independentVerifyCommand: `node tools/test-evidence/release-readiness-raw.mjs verify --candidate-plan ${quote(planInput.ref.path)} --receipt ${quote(planned.receiptPath)}`,
    bundleRerunCommand: `node tools/test-evidence/release-readiness-raw.mjs bundle-authorities --candidate-plan ${quote(planInput.ref.path)} --rollout-evidence ${quote(authorities.rollout.ref.path)} --runtime-role-admission ${quote(authorities.runtimeRole.admission.ref.path)} ${currentSchemaReferenceArguments(currentSchemaReceiptRef)} --out ${quote(output)}`
  })
}

export function buildBlueGreenAuthorityBundle({ candidatePlan, context, authorities, producer, sourceState, rawFacts, output })
{
  const planned = requireBundleContext({ plan: context.plan, producer, sourceState, output, classId: 'blue-green-containment' })
  const currentSchemaReceiptRef = currentSchemaAuthorityReference(authorities)
  return seal({
    schema: canonicalAuthorityBundleSchema,
    producerId: producer.producerId,
    toolVersion: producer.toolVersion,
    sourceState,
    rawFacts,
    candidatePlanRef: context.candidatePlanRef,
    rolloutEvidenceRef: embeddedAuthorityReference(authorities.rollout.ref,
      'fsusblog.release-rollout-evidence.v1', 'release-rollout'),
    runtimeRoleAdmissionRef: embeddedAuthorityReference(authorities.runtimeRole.admission.ref,
      'fsusblog.behavior-doc-static-admission-receipt.v2', 'runtime-role-admission'),
    currentSchemaReceiptRef,
    authorityDigest: authorities.authorityDigest,
    canonicalRerunCommand: `node tools/test-evidence/blue-green-containment-raw.mjs produce-authorities --candidate-plan ${quote(candidatePlan)} --source ${quote(output)} --out ${quote(planned.receiptPath)}`,
    independentVerifyCommand: `node tools/test-evidence/blue-green-containment-raw.mjs verify --candidate-plan ${quote(candidatePlan)} --receipt ${quote(planned.receiptPath)}`,
    bundleRerunCommand: `node tools/test-evidence/blue-green-containment-raw.mjs bundle-authorities --candidate-plan ${quote(candidatePlan)} --rollout-evidence ${quote(authorities.rollout.ref.path)} --runtime-role-admission ${quote(authorities.runtimeRole.admission.ref.path)} ${currentSchemaReferenceArguments(currentSchemaReceiptRef)} --out ${quote(output)}`
  })
}
