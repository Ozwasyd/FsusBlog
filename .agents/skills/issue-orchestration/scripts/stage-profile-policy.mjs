const HASH = /^[a-f0-9]{64}$/u
const VERSION = 'stage-profiles.v1'

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

function profile(role, model, effort, sandbox, writeScope, extras = {}) {
    return Object.freeze({
        policyVersion: VERSION,
        capabilityDigest: null,
        role,
        model,
        effort,
        sandbox,
        writeScope,
        requiredSkillDigests: [],
        rationaleCodes: ['issue-contract'],
        ...extras
    })
}

export const STAGE_PROFILES = Object.freeze({
    'root-scheduler': profile(
        'root-scheduler', 'gpt-5.6-sol', 'low', 'read-only', 'none'
    ),
    'dag-creator-updater': profile(
        'dag-creator-updater', 'gpt-5.6-sol', 'max', 'read-only', 'none',
        { freshContext: true, requestedByRole: 'root-scheduler',
            trigger: 'remote-live-snapshot-changed' }
    ),
    'test-owner': profile(
        'test-owner', 'gpt-5.6-sol', 'max', 'workspace-write', 'tests-only',
        { freshContext: true }
    ),
    'code-implementer': profile(
        'code-implementer', 'gpt-5.6-sol', 'low',
        'workspace-write', 'implementation-only'
    ),
    'ui-ux-implementer': profile(
        'ui-ux-implementer', 'gpt-5.6-sol', 'low',
        'workspace-write', 'implementation-only'
    ),
    'ux-acceptance-verifier': profile(
        'ux-acceptance-verifier', 'gpt-5.6-sol', 'max', 'read-only', 'none',
        { freshContext: true }
    ),
    'documentation-writer': profile(
        'documentation-writer', 'gpt-5.6-luna', 'xhigh',
        'workspace-write', 'documentation-only'
    ),
    'cleanup-verifier': profile(
        'cleanup-verifier', 'gpt-5.6-sol', 'max', 'read-only', 'none'
    )
})

function validateIdentity(value) {
    if (!value?.role) fail('stage-profile-role')
    if (['issue-implementer', 'issue-reviewer'].includes(value.role)
        || value.node || !Object.hasOwn(STAGE_PROFILES, value.role)) {
        fail('stage-profile-legacy-role')
    }
    if (value.policyVersion !== VERSION) fail('stage-profile-policy-version')
    if (!HASH.test(value.capabilityDigest ?? '')) {
        fail('stage-profile-capability-digest')
    }
    if (!Array.isArray(value.rationaleCodes) || value.rationaleCodes.length === 0) {
        fail('stage-profile-rationale')
    }
}

function validateCommonProfile(value, expected) {
    if (value.effort !== expected.effort) fail('stage-profile-effort')
    if (value.sandbox !== expected.sandbox) fail('stage-profile-sandbox')
}

export function validateStageAssignment(value) {
    validateIdentity(value)
    const expected = STAGE_PROFILES[value.role]

    if (value.role === 'root-scheduler' && value.action === 'author-dag') {
        fail('stage-profile-root-authority')
    }
    if (value.role === 'dag-creator-updater') {
        validateCommonProfile(value, expected)
        if (value.freshContext !== true) fail('stage-profile-fresh-context')
        if (value.requestedByRole !== 'root-scheduler') {
            fail('stage-profile-dag-authority')
        }
        if (value.trigger !== 'remote-live-snapshot-changed') {
            fail('stage-profile-dag-trigger')
        }
    } else if (value.role !== 'documentation-writer') {
        validateCommonProfile(value, expected)
    }

    if (!value.memberReceiptDigest) fail('stage-profile-member-receipt')

    if (value.role === 'test-owner') {
        if ((value.writePaths ?? []).some((path) => !path.startsWith('tests/'))) {
            fail('stage-profile-test-boundary')
        }
        if (value.inheritedFromRole?.includes('implementer')) {
            fail('stage-profile-verifier-independence')
        }
    }

    if (['code-implementer', 'ui-ux-implementer'].includes(value.role)) {
        const paths = value.writePaths ?? []
        if (paths.some((path) => path.startsWith('tests/')
            || path.startsWith('docs/'))) {
            fail('stage-profile-implementation-boundary')
        }
        if (value.role === 'code-implementer'
            && paths.some((path) => path.startsWith('src/frontend/'))) {
            fail('stage-profile-ui-owner')
        }
        if (value.candidate?.commandsGreen !== true
            || (value.candidate?.remainingFailures ?? []).length > 0) {
            fail('stage-profile-candidate-green')
        }
        if (value.action === 'sign-behavior-green') {
            fail('stage-profile-behavior-authority')
        }
        if (value.globalReworkDelta !== 0) {
            fail('stage-profile-rework-accounting')
        }
    }

    if (value.role === 'ui-ux-implementer') {
        if (typeof value.logicalActorId !== 'string') fail('stage-profile-ui-owner')
        if (!Array.isArray(value.requiredSkillDigests)
            || value.requiredSkillDigests.length < 2
            || value.requiredSkillDigests.some((entry) => !HASH.test(entry))) {
            fail('stage-profile-skill-digest')
        }
    }

    if (value.role === 'ux-acceptance-verifier'
        && (value.writePaths ?? []).length > 0) {
        fail('stage-profile-ux-boundary')
    }

    if (value.role === 'documentation-writer') {
        if (value.prerequisites?.behaviorGreen !== true
            || value.prerequisites?.uxAccepted !== true) {
            fail('stage-profile-prerequisite')
        }
        if (value.model !== expected.model || value.effort !== expected.effort) {
            if (!value.fallbackReceipt) {
                fail('stage-profile-documentation-capability')
            }
        }
    }
    return value
}

export function resolveDocumentationProfile({ capabilityReceipt, prerequisites }) {
    if (prerequisites?.behaviorGreen !== true
        || prerequisites?.uxAccepted !== true) {
        fail('stage-profile-prerequisite')
    }
    if (capabilityReceipt?.schema !==
        'issue-orchestration.model-capability-receipt.v1'
        || capabilityReceipt.supported !== true
        || capabilityReceipt.model !== 'gpt-5.6-luna'
        || capabilityReceipt.effort !== 'xhigh'
        || !HASH.test(capabilityReceipt.receiptDigest ?? '')) {
        fail('stage-profile-documentation-capability')
    }
    return {
        ...STAGE_PROFILES['documentation-writer'],
        capabilityDigest: capabilityReceipt.receiptDigest
    }
}

export function validateContinuity({ previous, next }) {
    if (!previous?.memberReceiptDigest || !next?.memberReceiptDigest) {
        fail('stage-profile-member-receipt')
    }
    for (const field of [
        'role', 'model', 'effort', 'sandbox', 'writeScope', 'logicalActorId'
    ]) {
        if (previous[field] !== next[field]) fail('stage-profile-continuity')
    }
    return next
}
