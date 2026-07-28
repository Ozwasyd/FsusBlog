/**
 * Public entry for DocClaim/generated/prose/join single-mutation staleness matrix (#1750).
 */

export { MutationLayers, allowedMutationLayers, forbiddenReasonCodes } from './layers.mjs'
export {
    materializeFixtureRepository,
    currentObservations,
    matchingProseBodies,
    staleProseBodies,
    fixtureRootPrefix
} from './fixture.mjs'
export {
    mutationCases,
    mutationCasesById,
    requiredMutationIds,
    requiredPositiveControlIds,
    targetInvariants,
    surfaceCoverage,
    listMutationCases,
    getMutationCase
} from './catalog.mjs'
export {
    validateMutationCaseSchema,
    applySingleMutation,
    runMutationCase,
    runAllMutationCases,
    assertCaseResult
} from './runner.mjs'
export {
    suiteFiles,
    runStalenessMutationGovernance,
    formatGovernanceViolations,
    countWeakNegativeHits,
    assertRequiredCaseCoverage,
    assertSurfaceMutationCoverage,
    assertCaseSchemaHygiene,
    scanWeakNegativeSurfaces,
    scanMigratedBadDocFixtures
} from './governance.mjs'
