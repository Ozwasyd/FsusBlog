import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const blogUiStagePolicyUrl = new URL('../contracts/blog-ui-stage-policy.json', import.meta.url)
const source = readFileSync(blogUiStagePolicyUrl, 'utf8')

function requirePolicy(condition) {
    if (!condition) {
        const error = new Error('invalid Blog UI stage policy')
        error.code = 'blog-ui-policy-invalid'
        throw error
    }
}

function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
    requirePolicy(record(value))
    requirePolicy(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()))
}

function strings(value) {
    return Array.isArray(value) && value.length > 0 &&
        value.every((entry) => typeof entry === 'string' && entry.trim().length > 0) &&
        new Set(value).size === value.length
}

function freeze(value) {
    if (record(value) || Array.isArray(value)) {
        Object.values(value).forEach(freeze)
        Object.freeze(value)
    }
    return value
}

const forbiddenPolicyKeys = new Set([
    'executionProfiles',
    'allowedProfiles',
    'writerLeaseOrder',
    'roleProfiles',
    'rolePermissions',
    'writeLeaseOrder',
    'readOnlyStages',
    'stageOrder',
    'uiDecisionRoutes',
    'verificationRoutes',
    'routing',
    'routeCells',
    'selectedProfile',
    'routingProfile',
    'actualModel',
    'actualEffort',
    'actualProfile',
    'automaticPromotion',
    'resliceShapes',
    'humanGate',
    'implementation',
    'adjudication',
    'uxAcceptance',
    'documentation'
])

function assertNoOrchestrationKeys(value, path = 'policy') {
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertNoOrchestrationKeys(item, `${path}[${index}]`))
        return
    }
    if (!record(value)) return
    for (const [key, child] of Object.entries(value)) {
        requirePolicy(!forbiddenPolicyKeys.has(key))
        assertNoOrchestrationKeys(child, `${path}.${key}`)
    }
}

/** Validate owner-controlled domain policy. Shared orchestration remains external. */
export function validateBlogUiStagePolicy(input) {
    exactKeys(input, [
        'schema',
        'policyVersion',
        'repository',
        'authorityScope',
        'requiredSkillIds',
        'uiDecisionClasses',
        'verificationClasses',
        'systemDesignDisputeClass',
        'implementationOwnership',
        'acceptanceRequirements',
        'consumerWorkaroundsForbidden',
        'sharedOrchestrationAuthority',
        'forbiddenSharedOrchestrationClaims',
        'requiredClassificationBindings',
        'requiredAcceptanceBindings'
    ])
    requirePolicy(input.schema === 'fsusblog-design-conformance.ui-stage-policy.v2')
    requirePolicy(input.policyVersion === 'fsusblog-ui-domain.v2')
    requirePolicy(input.repository === 'Ozwasyd/FsusBlog')
    requirePolicy(input.authorityScope === 'repository-domain-and-acceptance-only')
    requirePolicy(input.sharedOrchestrationAuthority === 'external')
    requirePolicy(JSON.stringify(input.requiredSkillIds) ===
        JSON.stringify(['fsusblog-design-conformance', 'fsusui-design-conformance']))
    requirePolicy(JSON.stringify(input.uiDecisionClasses) === JSON.stringify([
        'prescribed',
        'bounded-composition',
        'layout-judgment',
        'interaction-judgment',
        'system-design-dispute'
    ]))
    requirePolicy(JSON.stringify(input.verificationClasses) === JSON.stringify([
        'ux-local',
        'ux-path',
        'ux-system'
    ]))
    requirePolicy(input.systemDesignDisputeClass === 'system-design-dispute')
    exactKeys(input.implementationOwnership, [
        'allowedPathClass',
        'forbiddenPathClasses',
        'acceptanceMayModifyImplementation',
        'adjudicationMayModifyImplementation'
    ])
    requirePolicy(input.implementationOwnership.allowedPathClass === 'implementation')
    requirePolicy(JSON.stringify(input.implementationOwnership.forbiddenPathClasses) === JSON.stringify([
        'tests',
        'fixtures',
        'snapshots',
        'acceptance-mapping',
        'design-authorities',
        'skill-contracts'
    ]))
    requirePolicy(input.implementationOwnership.acceptanceMayModifyImplementation === false)
    requirePolicy(input.implementationOwnership.adjudicationMayModifyImplementation === false)
    exactKeys(input.acceptanceRequirements, [
        'requiresRenderedEvidence',
        'requiresProductionFixture',
        'acceptedReceiptRequiresZeroBlockers',
        'independentAcceptanceRequired'
    ])
    requirePolicy(input.acceptanceRequirements.requiresRenderedEvidence === true)
    requirePolicy(input.acceptanceRequirements.requiresProductionFixture === true)
    requirePolicy(input.acceptanceRequirements.acceptedReceiptRequiresZeroBlockers === true)
    requirePolicy(input.acceptanceRequirements.independentAcceptanceRequired === true)
    requirePolicy(strings(input.consumerWorkaroundsForbidden))
    requirePolicy(JSON.stringify(input.forbiddenSharedOrchestrationClaims) === JSON.stringify([
        'root-controller',
        'permanent-actor-roster',
        'model-profile-effort',
        'route-selection',
        'runtime-execution-permissions',
        'lease-resource-capacity',
        'shared-stage-order',
        'checkpoint-continuation',
        'retry-recovery-failure-routing',
        'delivery-cleanup-terminalization'
    ]))
    requirePolicy(JSON.stringify(input.requiredClassificationBindings) === JSON.stringify([
        'skillDigest',
        'authorityDigest',
        'baselineIdentity',
        'candidateIdentity',
        'domainPolicyDigest'
    ]))
    requirePolicy(JSON.stringify(input.requiredAcceptanceBindings) === JSON.stringify([
        'classificationReceiptDigest',
        'skillDigest',
        'authorityDigest',
        'baselineIdentity',
        'candidateIdentity',
        'domainPolicyDigest'
    ]))
    assertNoOrchestrationKeys(input)
    return freeze(structuredClone(input))
}

export const blogUiStagePolicy = validateBlogUiStagePolicy(JSON.parse(source))
// Exact file bytes bind receipts to the deployed domain policy.
export const blogUiDomainPolicyDigest = createHash('sha256').update(source).digest('hex')
// Compatibility alias used by older import sites in this repository.
export const blogUiStagePolicyDigest = blogUiDomainPolicyDigest
