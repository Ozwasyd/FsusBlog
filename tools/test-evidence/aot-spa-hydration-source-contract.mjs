import { digestValue, stable } from '../fact-extractors/lib/canonicalize.mjs'
import { deriveAotSpaHydrationRawFacts } from './aot-spa-hydration-observed-facts.mjs'

export const sourceBundleSchema = 'fsusblog.aot-spa-hydration-source-bundle.v1'
export const evidenceKeys = Object.freeze(['manifest', 'browserContract'])
const seal = (value) => ({ ...stable(value), contentDigest: `sha256:${digestValue(stable(value))}` })

export function buildAotSpaHydrationSourceBundle({ candidate, plan, inputs, producer, readBytes })
{
  const planned = plan.observations.find((entry) => entry.classId === 'aot-spa-hydration')
  return seal({
    schema: sourceBundleSchema,
    producerId: plan.producerId,
    toolVersion: producer.toolVersion,
    sourceState: plan.sourceState,
    rawFacts: deriveAotSpaHydrationRawFacts(inputs, { readBytes }),
    candidatePlanRef: candidate.ref,
    evidenceRefs: Object.fromEntries(evidenceKeys.map((key) => [key, {
      ...inputs[key].ref,
      contentDigest: inputs[key].value?.contentDigest ?? null,
      schema: inputs[key].value.schema,
      role: key === 'manifest' ? 'spa-manifest' : 'browser-contract'
    }])),
    canonicalRerunCommand: `node tools/test-evidence/aot-spa-hydration-raw.mjs bundle --candidate-plan ${candidate.ref.path} ${evidenceKeys.map((key) => `--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} ${inputs[key].ref.path}`).join(' ')}`,
    independentVerifyCommand: `node tools/test-evidence/aot-spa-hydration-raw.mjs verify --candidate-plan ${candidate.ref.path} --receipt ${planned.receiptPath}`
  })
}
