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

/** Validate owner-controlled policy, not a policy supplied by an agent receipt. */
export function validateBlogUiStagePolicy(input) {
    exactKeys(input, [
        'schema', 'repository', 'requiredSkillIds', 'writerLeaseOrder',
        'executionProfiles', 'implementation', 'adjudication', 'uxAcceptance',
        'documentation', 'humanGate', 'consumerWorkaroundsForbidden'
    ])
    requirePolicy(input.schema === 'fsusblog-design-conformance.ui-stage-policy.v2')
    requirePolicy(input.repository === 'Ozwasyd/FsusBlog')
    requirePolicy(JSON.stringify(input.requiredSkillIds) ===
        JSON.stringify(['fsusblog-design-conformance', 'fsusui-design-conformance']))
    requirePolicy(JSON.stringify(input.writerLeaseOrder) ===
        JSON.stringify(['test-owner', 'ui-ux-implementer', 'documentation-writer']))
    requirePolicy(record(input.executionProfiles) && Object.keys(input.executionProfiles).length > 0)
    for (const [id, profile] of Object.entries(input.executionProfiles)) {
        requirePolicy(/^[a-z][a-z0-9-]*$/u.test(id))
        exactKeys(profile, ['model', 'effort'])
        requirePolicy(typeof profile.model === 'string' && profile.model.trim().length > 0)
        requirePolicy(typeof profile.effort === 'string' && profile.effort.trim().length > 0)
    }
    const hasProfile = (id) => Object.hasOwn(input.executionProfiles, id)
    exactKeys(input.implementation, [
        'role', 'allowedProfiles', 'automaticPromotion', 'writeScope', 'routing', 'resliceShapes'
    ])
    requirePolicy(input.implementation.role === 'ui-ux-implementer')
    requirePolicy(input.implementation.writeScope === 'implementation-only')
    requirePolicy(input.implementation.automaticPromotion === false)
    requirePolicy(strings(input.implementation.allowedProfiles) && input.implementation.allowedProfiles.every(hasProfile))
    requirePolicy(strings(input.implementation.resliceShapes))
    exactKeys(input.implementation.routing, [
        'prescribed', 'bounded-composition', 'layout-judgment', 'interaction-judgment', 'system-design-dispute'
    ])
    for (const [decision, routes] of Object.entries(input.implementation.routing)) {
        if (decision === 'system-design-dispute') {
            requirePolicy(routes === 'stop')
            continue
        }
        requirePolicy(record(routes) && Object.keys(routes).length > 0)
        for (const [shape, profile] of Object.entries(routes)) {
            requirePolicy(['atomic-edit', 'bounded-multifile', 'iterative-debug', 'render-probe-heavy'].includes(shape))
            requirePolicy(!input.implementation.resliceShapes.includes(shape))
            requirePolicy(input.implementation.allowedProfiles.includes(profile))
        }
    }
    exactKeys(input.adjudication, [
        'role', 'allowedProfiles', 'routing', 'freshContext', 'sandbox', 'writeScope', 'requiredReslice'
    ])
    requirePolicy(input.adjudication.role === 'ui-system-adjudicator')
    requirePolicy(strings(input.adjudication.allowedProfiles) && input.adjudication.allowedProfiles.every(hasProfile))
    exactKeys(input.humanGate, [
        'requestSchema', 'requestStatus', 'eligibleReasons', 'ineligibleReasons', 'requiresFullRevalidation'
    ])
    requirePolicy(strings(input.humanGate.eligibleReasons) && strings(input.humanGate.ineligibleReasons))
    requirePolicy(input.humanGate.eligibleReasons.every((reason) => !input.humanGate.ineligibleReasons.includes(reason)))
    requirePolicy(input.humanGate.requestSchema === 'issue-orchestration.human-decision-request.v1')
    requirePolicy(input.humanGate.requestStatus === 'verified' && input.humanGate.requiresFullRevalidation === true)
    exactKeys(input.adjudication.routing, ['unique-resolution', ...input.humanGate.eligibleReasons])
    requirePolicy(Object.values(input.adjudication.routing).every((id) => input.adjudication.allowedProfiles.includes(id)))
    exactKeys(input.uxAcceptance, ['role', 'freshContext', 'sandbox', 'writeScope', 'routing'])
    requirePolicy(input.uxAcceptance.role === 'ux-acceptance-verifier')
    exactKeys(input.uxAcceptance.routing, ['ux-local', 'ux-path', 'ux-system'])
    requirePolicy(Object.values(input.uxAcceptance.routing).every(hasProfile))
    for (const stage of [input.adjudication, input.uxAcceptance]) {
        requirePolicy(stage.freshContext === true && stage.sandbox === 'read-only' && stage.writeScope === 'none')
    }
    requirePolicy(input.adjudication.requiredReslice === true)
    exactKeys(input.documentation, ['role', 'allowedProfiles', 'requires', 'writeScope'])
    requirePolicy(input.documentation.role === 'documentation-writer' && input.documentation.writeScope === 'documentation-only')
    requirePolicy(strings(input.documentation.allowedProfiles))
    requirePolicy(JSON.stringify(input.documentation.requires) === JSON.stringify(['behavior-green', 'ux-accepted']))
    requirePolicy(strings(input.consumerWorkaroundsForbidden))
    return freeze(structuredClone(input))
}

export const blogUiStagePolicy = validateBlogUiStagePolicy(JSON.parse(source))
// Exact file bytes bind receipts and generated schemas to the deployed policy.
export const blogUiStagePolicyDigest = createHash('sha256').update(source).digest('hex')

export function matchesExecutionProfile(receipt, expectedId) {
    const profile = Object.hasOwn(blogUiStagePolicy.executionProfiles, expectedId ?? '')
        ? blogUiStagePolicy.executionProfiles[expectedId]
        : null
    return profile !== null && receipt?.actualProfile === expectedId &&
        receipt.actualModel === profile.model && receipt.actualEffort === profile.effort
}
