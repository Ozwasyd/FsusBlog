import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
import { deriveProbeRawFacts } from './runtime-observation-probe-facts.mjs'

const receiptSchema = 'fsusblog.runtime-observation-probe.v1'
const seal = (value) => ({ ...stable(value), contentDigest: `sha256:${digestValue(stable(value))}` })

function dependencyReference(input, role)
{
  return {
    path: input.ref.path,
    fileDigest: input.ref.contentDigest,
    contentDigest: input.value.contentDigest ?? null,
    schema: input.value.schema,
    role
  }
}


export function buildRuntimeObservationProbeReceipt(kind, context, facts, { producer, sourceState })
{
  const plan = context.candidatePlan.value
  const canonicalRerunCommand = `node tools/test-evidence/runtime-observation-probes.mjs probe --kind ${kind} --candidate-plan ${context.candidatePlan.relative} --build ${context.build.ref.path} --fixture ${context.fixture.ref.path} --out ${context.output}`
  const independentVerifyCommand = `node tools/test-evidence/runtime-observation-raw.mjs verify --candidate-plan ${context.candidatePlan.relative} --receipt ${plan.observations.find((entry) => entry.classId === kind).receiptPath}`
  return seal({
    schema: receiptSchema,
    kind,
    producerId: 'production-correctness-scheduler',
    toolVersion: producer.toolVersion,
    sourceState,
    canonicalRerunCommand,
    independentVerifyCommand,
    rawFacts: deriveProbeRawFacts(kind, facts),
    candidatePlanRef: {
      path: context.candidatePlan.relative,
      fileDigest: context.candidatePlan.fileDigest,
      contentDigest: context.candidatePlan.value.contentDigest,
      schema: context.candidatePlan.value.schema,
      role: 'candidate-plan'
    },
    buildReceipt: dependencyReference(context.build, 'production-build'),
    fixtureReceipt: dependencyReference(context.fixture, 'fixture'),
    provenance: {
      mode: 'local-real-runtime',
      semanticAuthority: 'current-candidate-application-and-owned-services',
      simulatedInfrastructure: ['docker-postgresql', 'docker-redis', 'loopback-network'],
      syntheticSemanticResult: false,
      rerunCommand: canonicalRerunCommand
    },
    facts,
    terminalStatus: 'verified'
  })
}
