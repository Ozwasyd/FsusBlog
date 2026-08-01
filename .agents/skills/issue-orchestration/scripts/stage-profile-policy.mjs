import { createHash } from 'node:crypto'

const HASH = /^[a-f0-9]{64}$/u

export const ROUTING_POLICY_VERSION = 'stage-model-pool.v2'

export const REQUIRED_ROUTING_FIELDS = Object.freeze([
    'domain',
    'effectiveOwnerRepository',
    'engineeringRiskClass',
    'uiDecisionClass',
    'contractState',
    'verificationClass',
    'modelRoutingEvidenceDigest',
    'routingPolicyVersion'
])

export const ROUTING_ENUMS = Object.freeze({
    domain: Object.freeze([
        'generic-code',
        'ui-ux',
        'documentation',
        'orchestration-core',
        'deterministic-cleanup'
    ]),
    engineeringRiskClass: Object.freeze([
        'bounded',
        'complex',
        'high-risk',
        'frontier'
    ]),
    uiDecisionClass: Object.freeze([
        'none',
        'prescribed',
        'bounded-composition',
        'layout-judgment',
        'interaction-judgment',
        'system-design-dispute'
    ]),
    contractState: Object.freeze([
        'frozen',
        'disputed',
        'owner-unresolved',
        'authority-conflict'
    ]),
    verificationClass: Object.freeze([
        'focused',
        'cross-module',
        'runtime',
        'protocol',
        'security',
        'ux-local',
        'ux-path',
        'ux-system'
    ])
})

export const REQUIRED_STAGE_PROFILE_FIELDS = Object.freeze([
    'stageProfilePolicyVersion',
    'stageRole',
    'stagePhase',
    'allowedProfiles',
    'defaultProfile',
    'routingAuthority',
    'routingInputDigest',
    'selectedProfile',
    'selectedProfileReason',
    'sandbox',
    'writeScope',
    'requiredSkillDigests',
    'capabilityDigest'
])

const stage = (
    allowedProfiles,
    defaultProfile,
    sandbox,
    writeScope,
    { freshContext = false } = {}
) => Object.freeze({
    allowedProfiles: Object.freeze(allowedProfiles),
    defaultProfile,
    sandbox,
    writeScope,
    freshContext
})

const STAGES = Object.freeze({
    'root-scheduler:scheduling': stage(
        ['luna-low'],
        'luna-low',
        'read-only',
        'none'
    ),
    'dag-creator-updater:semantic-proposal': stage(
        ['terra-max', 'sol-xhigh', 'sol-max'],
        'terra-max',
        'read-only',
        'none',
        { freshContext: true }
    ),
    'test-owner:test-contract': stage(
        ['sol-high', 'terra-max', 'sol-xhigh'],
        'sol-high',
        'workspace-write',
        'tests-only'
    ),
    'test-owner:behavior-verification': stage(
        ['sol-high', 'terra-max', 'sol-xhigh'],
        'sol-high',
        'read-only',
        'none',
        { freshContext: true }
    ),
    'code-implementer:implementation': stage(
        ['luna-max', 'sol-high', 'terra-max', 'sol-xhigh'],
        'luna-max',
        'workspace-write',
        'implementation-only'
    ),
    'ui-ux-implementer:implementation': stage(
        ['sol-low', 'sol-medium'],
        'sol-low',
        'workspace-write',
        'implementation-only'
    ),
    'ui-system-adjudicator:adjudication': stage(
        ['sol-high', 'sol-xhigh'],
        'sol-high',
        'read-only',
        'none',
        { freshContext: true }
    ),
    'ux-acceptance-verifier:ux-acceptance': stage(
        ['sol-medium', 'sol-high', 'sol-xhigh'],
        'sol-medium',
        'read-only',
        'none',
        { freshContext: true }
    ),
    'documentation-writer:documentation': stage(
        ['luna-high', 'luna-max'],
        'luna-high',
        'workspace-write',
        'documentation-only'
    )
})

export const STAGE_ROUTE_DEFINITIONS = STAGES

export const STAGE_MODEL_POOL_POLICY = Object.freeze({
    schema: 'issue-orchestration.stage-model-pool-policy.v2',
    version: ROUTING_POLICY_VERSION,
    routingAuthority: 'deterministic-routing-compiler',
    requiredRoutingFields: REQUIRED_ROUTING_FIELDS,
    requiredStageProfileFields: REQUIRED_STAGE_PROFILE_FIELDS,
    stages: STAGES,
    cleanup: Object.freeze({
        greenAuthority: 'machine-resource-verifier',
        llmProfile: null,
        diagnosticProfiles: Object.freeze(['luna-low', 'terra-max'])
    }),
    forbiddenRoutingInputs: Object.freeze([
        'currentRootProfile',
        'balance',
        'subscription',
        'failureCount',
        'reworkCount',
        'telemetryCost',
        'humanPreference'
    ])
})

export class StageProfileError extends Error {
    constructor(code, message = code) {
        super(message)
        this.name = 'StageProfileError'
        this.code = code
    }
}

function fail(code, message) {
    throw new StageProfileError(code, message)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function sameValues(left, right) {
    return JSON.stringify(left) === JSON.stringify(right)
}

function routeKey(stageRole, stagePhase) {
    return `${stageRole}:${stagePhase}`
}

export function stageDefinitionsForRole(stageRole) {
    return Object.fromEntries(Object.entries(STAGES)
        .filter(([key]) => key.startsWith(`${stageRole}:`)))
}

export function splitProfile(profileId) {
    const match = /^(luna|terra|sol)-(low|medium|high|xhigh|max)$/u.exec(
        profileId ?? ''
    )
    if (!match) fail('routing-profile-id')
    return Object.freeze({
        profileId,
        model: `gpt-5.6-${match[1]}`,
        effort: match[2]
    })
}

function assertHash(value, code) {
    if (!HASH.test(value ?? '')) fail(code)
}

function assertNoLegacyAuthority(value) {
    if (value?.node?.model || value?.node?.effort
        || value?.implementationProfile || value?.reviewProfile
        || ['issue-implementer', 'issue-reviewer', 'cleanup-verifier']
            .includes(value?.stageRole)) {
        fail('routing-legacy-authority')
    }
}

export function validateRoutingClassification(value) {
    if (!value || typeof value !== 'object') fail('routing-classification')
    for (const field of REQUIRED_ROUTING_FIELDS) {
        if (!Object.hasOwn(value, field)) {
            fail('routing-classification-field', `Missing ${field}.`)
        }
    }
    for (const [field, allowed] of Object.entries(ROUTING_ENUMS)) {
        if (!allowed.includes(value[field])) {
            fail('routing-classification-enum', `Invalid ${field}.`)
        }
    }
    if (typeof value.effectiveOwnerRepository !== 'string'
        || !/^[^/\s]+\/[^/\s]+$/u.test(value.effectiveOwnerRepository)) {
        fail('routing-owner-repository')
    }
    assertHash(value.modelRoutingEvidenceDigest, 'routing-evidence-digest')
    if (value.routingPolicyVersion !== ROUTING_POLICY_VERSION) {
        fail('routing-policy-version')
    }
    return value
}

function selectDagProfile(input) {
    if (input.engineeringRiskClass === 'frontier'
        && input.frontierException === true) {
        return ['sol-max', 'dag-frontier-exception']
    }
    if (input.contractState === 'authority-conflict'
        || input.contractState === 'owner-unresolved'
        || input.engineeringRiskClass === 'frontier') {
        return ['sol-xhigh', 'dag-authority-or-topology-conflict']
    }
    return ['terra-max', 'dag-semantic-proposal-default']
}

function selectTestOwnerProfile(input) {
    if (['protocol', 'security'].includes(input.verificationClass)
        || input.contractState === 'authority-conflict') {
        return ['sol-xhigh', 'verification-protocol-security-or-authority']
    }
    if (input.verificationClass === 'runtime'
        || input.engineeringRiskClass === 'high-risk'
        || input.engineeringRiskClass === 'frontier') {
        return ['terra-max', 'verification-runtime-or-lifecycle-risk']
    }
    return ['sol-high', 'verification-focused-or-cross-module']
}

function selectCodeProfile(input) {
    return {
        bounded: ['luna-max', 'engineering-risk-bounded'],
        complex: ['sol-high', 'engineering-risk-complex'],
        'high-risk': ['terra-max', 'engineering-risk-high-risk'],
        frontier: ['sol-xhigh', 'engineering-risk-frontier']
    }[input.engineeringRiskClass]
}

function selectUiProfile(input) {
    if (input.domain !== 'ui-ux') fail('routing-ui-domain')
    if (input.uiDecisionClass === 'system-design-dispute') {
        fail('routing-ui-adjudication-required')
    }
    if (['prescribed', 'bounded-composition'].includes(input.uiDecisionClass)) {
        return ['sol-low', 'ui-prescribed-or-bounded-composition']
    }
    if (['layout-judgment', 'interaction-judgment'].includes(input.uiDecisionClass)) {
        return ['sol-medium', 'ui-layout-or-interaction-judgment']
    }
    fail('routing-ui-classification')
}

function selectAdjudicatorProfile(input) {
    if (input.domain !== 'ui-ux'
        || input.uiDecisionClass !== 'system-design-dispute') {
        fail('routing-ui-adjudication-not-required')
    }
    if (input.contractState === 'authority-conflict') {
        return ['sol-xhigh', 'ui-system-authority-conflict']
    }
    return ['sol-high', 'ui-system-design-dispute']
}

function selectUxProfile(input) {
    if (input.domain !== 'ui-ux') fail('routing-ui-domain')
    const route = {
        'ux-local': ['sol-medium', 'ux-local'],
        'ux-path': ['sol-high', 'ux-path'],
        'ux-system': ['sol-xhigh', 'ux-system']
    }[input.verificationClass]
    if (!route) fail('routing-ux-verification-class')
    return route
}

function selectDocumentationProfile(input) {
    if (input.domain !== 'documentation') fail('routing-documentation-domain')
    if (input.engineeringRiskClass === 'bounded') {
        return ['luna-high', 'documentation-current-sync']
    }
    return ['luna-max', 'documentation-complex-authority-migration']
}

function selectProfile(input, key) {
    if (key === 'root-scheduler:scheduling') {
        return ['luna-low', 'root-scheduler-fixed']
    }
    if (key === 'dag-creator-updater:semantic-proposal') {
        return selectDagProfile(input)
    }
    if (key === 'test-owner:test-contract'
        || key === 'test-owner:behavior-verification') {
        return selectTestOwnerProfile(input)
    }
    if (key === 'code-implementer:implementation') {
        if (input.domain === 'ui-ux') fail('routing-ui-owner')
        return selectCodeProfile(input)
    }
    if (key === 'ui-ux-implementer:implementation') {
        return selectUiProfile(input)
    }
    if (key === 'ui-system-adjudicator:adjudication') {
        return selectAdjudicatorProfile(input)
    }
    if (key === 'ux-acceptance-verifier:ux-acceptance') {
        return selectUxProfile(input)
    }
    if (key === 'documentation-writer:documentation') {
        return selectDocumentationProfile(input)
    }
    fail('routing-stage-role-phase')
}

export function compileStageRoute(input) {
    assertNoLegacyAuthority(input)
    validateRoutingClassification(input)
    const key = routeKey(input.stageRole, input.stagePhase)
    const definition = STAGES[key]
    if (!definition) fail('routing-stage-role-phase')
    const [selectedProfile, selectedProfileReason] = selectProfile(input, key)
    const routingInput = {
        classification: Object.fromEntries(REQUIRED_ROUTING_FIELDS
            .map((field) => [field, input[field]])),
        stageRole: input.stageRole,
        stagePhase: input.stagePhase,
        frontierException: input.frontierException === true
    }
    const requiredSkillDigests = Array.isArray(input.requiredSkillDigests)
        ? [...input.requiredSkillDigests]
        : []
    const capabilityDigest = HASH.test(input.capabilityDigest ?? '')
        ? input.capabilityDigest
        : digest({
                policyVersion: ROUTING_POLICY_VERSION,
                selectedProfile,
                allowedProfiles: definition.allowedProfiles
            })
    return Object.freeze({
        stageProfilePolicyVersion: ROUTING_POLICY_VERSION,
        stageRole: input.stageRole,
        stagePhase: input.stagePhase,
        allowedProfiles: [...definition.allowedProfiles],
        defaultProfile: definition.defaultProfile,
        routingAuthority: STAGE_MODEL_POOL_POLICY.routingAuthority,
        routingInputDigest: digest(routingInput),
        selectedProfile,
        selectedProfileReason,
        sandbox: definition.sandbox,
        writeScope: definition.writeScope,
        requiredSkillDigests,
        capabilityDigest
    })
}

function validateFreshContext(value, definition) {
    if (!definition.freshContext) return
    if (value.freshContext !== true
        || value.forkTurns === 'all'
        || value.inheritedThreadId) {
        fail('routing-verifier-fresh-context')
    }
}

function validateRuntimeCapability(value) {
    const capability = value.runtimeCapability
    if (!capability) return
    if (capability.available !== true
        || capability.requestedProfile !== value.selectedProfile
        || capability.effectiveProfile !== value.selectedProfile) {
        fail('runtime-capability-missing')
    }
}

function validateCandidate(value) {
    if (!value.candidate) return
    if (value.candidate.status !== 'candidate-green') {
        fail('routing-candidate-status')
    }
    if (value.candidate.frozenTestTreeDigestBefore
        !== value.candidate.frozenTestTreeDigestAfter
        || (value.candidate.modifiedPaths ?? []).some((path) =>
            path.startsWith('tests/'))) {
        fail('routing-frozen-test-tree')
    }
    if (value.action === 'sign-behavior-green'
        || value.action === 'sign-ux-accepted') {
        fail('routing-independent-verification-authority')
    }
}

export function validateStageAssignment(value) {
    assertNoLegacyAuthority(value)
    if (value?.schema !== 'issue-orchestration.stage-assignment.v2') {
        fail('routing-assignment-schema')
    }
    for (const field of REQUIRED_STAGE_PROFILE_FIELDS) {
        if (!Object.hasOwn(value, field)) fail('routing-stage-profile-field')
    }
    validateRoutingClassification(value.classification)
    const key = routeKey(value.stageRole, value.stagePhase)
    const definition = STAGES[key]
    if (!definition) fail('routing-stage-role-phase')
    if (value.stageProfilePolicyVersion !== ROUTING_POLICY_VERSION) {
        fail('routing-policy-version')
    }
    if (value.routingAuthority !== STAGE_MODEL_POOL_POLICY.routingAuthority) {
        fail('routing-authority')
    }
    if (value.stageRole === 'ui-ux-implementer'
        && !definition.allowedProfiles.includes(value.selectedProfile)) {
        fail('routing-ui-profile')
    }
    validateFreshContext(value, definition)
    const expected = compileStageRoute({
        ...value.classification,
        stageRole: value.stageRole,
        stagePhase: value.stagePhase,
        frontierException: value.frontierException,
        requiredSkillDigests: value.requiredSkillDigests,
        capabilityDigest: value.capabilityDigest
    })
    if (value.stageRole === 'root-scheduler'
        && value.selectedProfile !== expected.selectedProfile) {
        fail('routing-root-profile')
    }
    if (!sameValues(value.allowedProfiles, expected.allowedProfiles)
        || value.defaultProfile !== expected.defaultProfile
        || value.selectedProfile !== expected.selectedProfile
        || value.selectedProfileReason !== expected.selectedProfileReason) {
        fail('routing-selected-profile')
    }
    if (value.sandbox !== expected.sandbox
        || value.writeScope !== expected.writeScope) {
        fail('routing-permission')
    }
    assertHash(value.routingInputDigest, 'routing-input-digest')
    assertHash(value.capabilityDigest, 'routing-capability-digest')
    if (!Array.isArray(value.requiredSkillDigests)
        || value.requiredSkillDigests.some((entry) => !HASH.test(entry))) {
        fail('routing-skill-digest')
    }
    validateRuntimeCapability(value)
    validateCandidate(value)
    return value
}

const ALLOWED_RECLASSIFICATION_BLOCKERS = Object.freeze(new Set([
    'test-contract-disputed',
    'runtime-lifecycle-evidence',
    'protocol-security-evidence',
    'authority-conflict',
    'ui-system-design-dispute',
    'verification-scope-change'
]))

export function validateRouteReclassification(value) {
    if (value?.schema !== 'issue-orchestration.route-reclassification.v1'
        || value.policyVersion !== ROUTING_POLICY_VERSION) {
        fail('routing-reclassification-schema')
    }
    if (value.blockerClass === 'implementer-internal-red'
        || value.sourcePhase === 'self-test'
        || value.opensNewAttempt === true
        || value.triggersSemanticDagUpdate === true) {
        fail('routing-internal-cycle-authority')
    }
    if (!ALLOWED_RECLASSIFICATION_BLOCKERS.has(value.blockerClass)
        || !['test-owner', 'ux-acceptance-verifier', 'ui-system-adjudicator']
            .includes(value.sourceRole)
        || ['balance', 'telemetry', 'human-preference', 'rework-count']
            .includes(value.routingAuthority)) {
        fail('routing-reclassification-authority')
    }
    assertHash(value.blockerReceiptDigest, 'routing-blocker-receipt-digest')
    for (const field of [
        'previousProfile',
        'newRiskOrVerificationClass',
        'newProfile'
    ]) {
        if (typeof value[field] !== 'string' || !value[field]) {
            fail('routing-reclassification-field')
        }
    }
    return value
}

export function validateContinuity({ previous, next }) {
    if (!previous || !next
        || typeof previous.memberIssueId !== 'string'
        || typeof next.memberIssueId !== 'string'
        || !HASH.test(previous.memberRoutingReceiptDigest ?? '')
        || !HASH.test(next.memberRoutingReceiptDigest ?? '')) {
        fail('routing-member-independence')
    }
    if (previous.memberIssueId !== next.memberIssueId
        && (previous.memberRoutingReceiptDigest === next.memberRoutingReceiptDigest
            || previous.routingInputDigest === next.routingInputDigest
            || previous.requestId === next.requestId
            || previous.candidate?.attemptId === next.candidate?.attemptId)) {
        fail('routing-member-independence')
    }
    if (next.stagePhase === 'behavior-verification'
        || next.stagePhase === 'ux-acceptance'
        || next.stagePhase === 'adjudication') {
        const definition = STAGES[routeKey(next.stageRole, next.stagePhase)]
        validateFreshContext(next, definition ?? { freshContext: true })
    }
    return next
}
