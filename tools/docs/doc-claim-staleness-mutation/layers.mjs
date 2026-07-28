/**
 * Earliest detection layers for DocClaim / generated / prose / join staleness mutations.
 * Fixed set — baseline-only cheats must fail at prose/generated mismatch, not a substitute layer.
 */

export const MutationLayers = Object.freeze({
    CLAIM_SCHEMA: 'claim-schema',
    CLAIM_PARSER: 'claim-parser',
    GENERATED_SECTION_CHECK: 'generated-section-check',
    PROSE_VERIFIER: 'prose-verifier',
    BEHAVIOR_GRAPH_JOIN: 'behavior-graph-join'
})

export const allowedMutationLayers = Object.freeze(Object.values(MutationLayers))

/** Vague outcomes that prove nothing about body/current-observation join. */
export const forbiddenReasonCodes = Object.freeze([
    'process failed',
    'process-failed',
    'nonzero-exit',
    'exit-nonzero',
    'failed',
    'error',
    'unknown'
])
