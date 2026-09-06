#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { blogUiStagePolicy as policy, blogUiStagePolicyDigest, matchesExecutionProfile } from './ui-stage-policy.mjs'
import { checkExecutionProfilesSchema } from './generate-execution-profiles.mjs'

checkExecutionProfilesSchema()

const skillRoot = path.resolve(import.meta.dirname, '..')
const contractRoot = path.resolve(skillRoot, 'contracts')
const schemaNames = [
    'fsusui-baseline-identity.schema.json',
    'ui-classification-receipt.schema.json',
    'ui-dispatch-receipt.schema.json',
    'ui-system-adjudication-receipt.schema.json',
    'ux-acceptance-receipt.schema.json'
]
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const REQUIRED_SKILL_IDS = policy.requiredSkillIds
const RESLICE_SHAPES = new Set(policy.implementation.resliceShapes)
const UX_ROUTES = policy.uxAcceptance.routing
const HUMAN_REASONS = new Set(policy.humanGate.eligibleReasons)
const INELIGIBLE_HUMAN_REASONS =
    new Set(policy.humanGate.ineligibleReasons)
const FORBIDDEN_WRITE_PATTERNS = [
    /(^|\/)tests?(\/|$)/iu,
    /(^|\/)fixtures?(\/|$)/iu,
    /(^|\/)(?:__snapshots__|snapshots?)(\/|$)/iu,
    /(^|\/)docs?(\/|$)/iu,
    /(^|\/)\.agents\/skills(\/|$)/iu
]

export class BlogUiContractError extends Error {
    constructor(code, message = code) {
        super(message)
        this.code = code
    }
}

function fail(code, message = code) {
    throw new BlogUiContractError(code, message)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort()
            .map((key) => [key, canonical(value[key])])
    )
}

function digest(value) {
    return createHash('sha256')
        .update(typeof value === 'string'
            ? value
            : JSON.stringify(canonical(value)))
        .digest('hex')
}

function unsignedDigest(value, field) {
    const unsigned = structuredClone(value)
    delete unsigned[field]
    return digest(unsigned)
}

function sealDigest(value, field) {
    const next = structuredClone(value)
    next[field] = unsignedDigest(next, field)
    return next
}

function assertDigest(value, field, code) {
    if (!HASH.test(value?.[field] ?? '') ||
        value[field] !== unsignedDigest(value, field)) {
        fail(code)
    }
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value
    }
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value)
}

function text(value) {
    return typeof value === 'string' && value.trim().length > 0
}

function textArray(value, minimum = 1) {
    return Array.isArray(value) &&
        value.length >= minimum &&
        value.every(text)
}

function skillIds(skills) {
    return Array.isArray(skills)
        ? skills.map(({ id }) => id)
        : []
}

function skillDigests(skills) {
    return Array.isArray(skills)
        ? skills.map(({ digest: value }) => value)
        : []
}

function validRequiredSkills(skills) {
    return JSON.stringify(skillIds(skills)) ===
        JSON.stringify(REQUIRED_SKILL_IDS) &&
        skillDigests(skills).every((value) => HASH.test(value ?? ''))
}

function routeFor(uiDecisionClass, executionShape) {
    if (RESLICE_SHAPES.has(executionShape)) {
        fail('blog-ui-reslice-required')
    }
    if (uiDecisionClass === 'system-design-dispute') {
        fail('blog-ui-adjudication-required')
    }
    const route = policy.implementation.routing[uiDecisionClass]?.[executionShape]
    if (typeof route === 'string') return route
    fail('blog-ui-reslice-required')
}

function assertStagePolicy(input) {
    if (input?.stagePolicyDigest !== blogUiStagePolicyDigest) {
        fail('blog-ui-stage-policy-binding')
    }
}

function validateBaseline(input) {
    if (input?.schema !==
            'fsusblog-design-conformance.fsusui-baseline-identity.v1' ||
        input.repository !== 'Ozwasyd/FsusUI' ||
        !['local-source', 'package-pin'].includes(input.sourceKind) ||
        !text(input.packageVersion) ||
        typeof input.dirty !== 'boolean' ||
        !HASH.test(input.dirtyFingerprint ?? '') ||
        !HASH.test(input.skillDigest ?? '') ||
        !input.contractDigests ||
        !['stagePolicy', 'classification', 'adjudication', 'uxAcceptance']
            .every((field) => HASH.test(
                input.contractDigests[field] ?? ''
            ))) {
        fail('blog-ui-baseline-identity')
    }
    if (input.sourceKind === 'local-source' &&
        (!path.isAbsolute(input.absolutePath ?? '') ||
            !SHA.test(input.gitHead ?? ''))) {
        fail('blog-ui-baseline-identity')
    }
    if (input.sourceKind === 'package-pin' &&
        (input.absolutePath !== null || input.gitHead !== null ||
            input.dirty !== false)) {
        fail('blog-ui-baseline-identity')
    }
    assertDigest(input, 'baselineDigest', 'blog-ui-baseline-identity')
    return structuredClone(input)
}

function validateClassification(input) {
    assertStagePolicy(input)
    if (input?.schema !==
            'fsusblog-design-conformance.ui-classification-receipt.v2' ||
        input.repository !== 'Ozwasyd/FsusBlog' ||
        !text(input.issueId) ||
        input.uiImpact !== true ||
        !['Ozwasyd/FsusBlog', 'Ozwasyd/FsusUI']
            .includes(input.ownerRepository) ||
        !textArray(input.affectedSurfaces) ||
        !Object.hasOwn(policy.implementation.routing, input.uiDecisionClass) ||
        !Object.hasOwn(UX_ROUTES, input.verificationClass) ||
        !validRequiredSkills(input.requiredDesignAuthorities) ||
        !textArray(input.stateEvidenceMatrix) ||
        !textArray(input.inScope) ||
        !textArray(input.outOfScope) ||
        !SHA.test(input.candidateSha ?? '') ||
        !HASH.test(input.candidateIdentityDigest ?? '') ||
        ![
            'slicePolicyDigest',
            'routingPolicyDigest',
            'contextDigest',
            'classificationEvidenceDigest'
        ].every((field) => HASH.test(input[field] ?? ''))) {
        fail('blog-ui-authority-binding')
    }
    const baseline = validateBaseline(input.fsusUIBaseline)
    const authorities = input.requiredDesignAuthorities
    if (authorities[1].digest !== baseline.skillDigest) {
        fail('blog-ui-authority-binding')
    }
    assertDigest(input, 'receiptDigest', 'blog-ui-authority-binding')
    return {
        ...structuredClone(input),
        fsusUIBaseline: baseline
    }
}

function validateDispatch(input, classification) {
    assertStagePolicy(input)
    if (input?.stageRole !== 'ui-ux-implementer' ||
        input.stagePhase !== 'ui-implementation') {
        fail('blog-ui-implementer-role')
    }
    const expectedProfile = routeFor(
        classification.uiDecisionClass,
        input.executionShape
    )
    if (input.schema !==
            'fsusblog-design-conformance.ui-dispatch-receipt.v2' ||
        input.repository !== 'Ozwasyd/FsusBlog' ||
        input.classificationReceiptDigest !==
            classification.receiptDigest ||
        input.slicePolicyDigest !== classification.slicePolicyDigest ||
        input.routingPolicyDigest !== classification.routingPolicyDigest ||
        ![
            'workPlanDigest',
            'sliceDigest',
            'compiledPromptDigest',
            'executionRouteDecisionDigest',
            'targetWorktreeDigest'
        ].every((field) => HASH.test(input[field] ?? '')) ||
        !textArray(input.firstReadTargets) ||
        !text(input.firstWritablePath) ||
        !textArray(input.allowedPaths) ||
        !textArray(input.forbiddenPaths) ||
        !textArray(input.explicitNonGoals) ||
        !textArray(input.requiredFocusedCommands) ||
        !textArray(input.requiredRenderProbes) ||
        !text(input.completionPredicate) ||
        !text(input.continuationPredicate) ||
        !path.isAbsolute(input.targetWorktree ?? '') ||
        input.targetWorktreeDigest !== digest(input.targetWorktree) ||
        input.candidateSha !== classification.candidateSha ||
        input.candidateIdentityDigest !==
            classification.candidateIdentityDigest ||
        !validRequiredSkills(input.requiredSkills) ||
        JSON.stringify(input.requiredSkills) !==
            JSON.stringify(classification.requiredDesignAuthorities) ||
        JSON.stringify(input.designAuthorityDigests) !==
            JSON.stringify(skillDigests(input.requiredSkills)) ||
        input.fsusUIBaselineDigest !==
            classification.fsusUIBaseline.baselineDigest ||
        input.writeLease?.scope !== 'implementation-only' ||
        !text(input.writeLease?.leaseId) ||
        input.status !== 'verified') {
        fail('blog-ui-authority-binding')
    }
    if (!text(input.firstRequiredAction) ||
        !text(input.firstWritablePath) ||
        !textArray(input.explicitNonGoals)) {
        fail('blog-ui-prompt-incomplete')
    }
    if (input.firstWritablePath !== input.allowedPaths[0] ||
        input.allowedPaths.some((entry) =>
            FORBIDDEN_WRITE_PATTERNS.some((pattern) =>
                pattern.test(entry))) ||
        input.forbiddenPaths.some((entry) =>
            input.allowedPaths.includes(entry))) {
        fail('blog-ui-write-lease')
    }
    if (!matchesExecutionProfile(input, expectedProfile) ||
        !policy.implementation.allowedProfiles.includes(
            input.actualProfile
        )) {
        fail('blog-ui-route-mismatch')
    }
    if (!Number.isInteger(
        input.checkpointThresholds?.maxInvestigationCommands
    ) ||
        !Number.isInteger(
            input.checkpointThresholds?.maxNoArtifactCommands
        ) ||
        input.checkpointThresholds.maxInvestigationCommands < 1 ||
        input.checkpointThresholds.maxNoArtifactCommands < 1) {
        fail('blog-ui-checkpoint-threshold')
    }
    assertDigest(input, 'receiptDigest', 'blog-ui-authority-binding')
    return structuredClone(input)
}

export function sealBlogUiAdjudication(input) {
    assertStagePolicy(input)
    if (INELIGIBLE_HUMAN_REASONS.has(input.authorityState) ||
        INELIGIBLE_HUMAN_REASONS.has(input.humanGateReason)) {
        fail('blog-ui-human-gate-ineligible')
    }
    if (input?.schema !==
            'fsusblog-design-conformance.ui-system-adjudication-receipt.v2' ||
        input.repository !== 'Ozwasyd/FsusBlog' ||
        !HASH.test(input.classificationReceiptDigest ?? '') ||
        !matchesExecutionProfile(input, policy.adjudication.routing[input.authorityState]) ||
        input.freshContext !== true ||
        input.sandbox !== 'read-only' ||
        input.writeLease !== null ||
        input.requiredReslice !== true ||
        !textArray(input.inScope) ||
        !textArray(input.outOfScope)) {
        fail('blog-ui-adjudicator-read-only')
    }
    if (!Array.isArray(input.modifiedPaths) ||
        input.modifiedPaths.length !== 0) {
        fail('blog-ui-adjudicator-read-only')
    }
    if (input.authorityState === 'unique-resolution') {
        if (input.uniqueResolutionAvailable !== true ||
            !policy.implementation.allowedProfiles.includes(
                input.allowedImplementationClass
            ) ||
            input.humanGateReason !== null ||
            input.humanDecisionRequestSchema !== null ||
            input.humanDecisionRequestStatus !== null ||
            input.humanDecisionRequestDigest !== null) {
            fail('blog-ui-adjudication-required')
        }
    } else if (HUMAN_REASONS.has(input.authorityState)) {
        if (input.uniqueResolutionAvailable !== false ||
            input.allowedImplementationClass !== null ||
            input.humanGateReason !== input.authorityState ||
            input.humanDecisionRequestSchema !==
                policy.humanGate.requestSchema ||
            input.humanDecisionRequestStatus !==
                policy.humanGate.requestStatus ||
            !HASH.test(input.humanDecisionRequestDigest ?? '')) {
            fail('blog-ui-human-decision-required')
        }
    } else {
        fail('blog-ui-human-gate-ineligible')
    }
    assertDigest(
        input,
        'receiptDigest',
        'blog-ui-adjudication-binding'
    )
    return deepFreeze(structuredClone(input))
}

function validateUxAcceptance(input, classification, dispatch) {
    if (!input) fail('blog-ui-ux-acceptance-required')
    assertStagePolicy(input)
    const expectedProfile = UX_ROUTES[classification.verificationClass]
    if (input.schema !==
            'fsusblog-design-conformance.ux-acceptance-receipt.v2' ||
        input.repository !== 'Ozwasyd/FsusBlog' ||
        input.classificationReceiptDigest !==
            classification.receiptDigest ||
        input.dispatchReceiptDigest !== dispatch.receiptDigest ||
        input.candidateSha !== classification.candidateSha ||
        input.candidateIdentityDigest !==
            classification.candidateIdentityDigest ||
        !matchesExecutionProfile(input, expectedProfile) ||
        input.freshContext !== true ||
        input.sandbox !== 'read-only' ||
        input.writeLease !== null ||
        JSON.stringify(input.requiredSkills) !==
            JSON.stringify(dispatch.requiredSkills) ||
        JSON.stringify(input.designAuthorityDigests) !==
            JSON.stringify(dispatch.designAuthorityDigests) ||
        input.fsusUIBaselineDigest !== dispatch.fsusUIBaselineDigest ||
        input.workPlanDigest !== dispatch.workPlanDigest ||
        input.sliceDigest !== dispatch.sliceDigest ||
        input.compiledPromptDigest !== dispatch.compiledPromptDigest ||
        input.executionRouteDecisionDigest !==
            dispatch.executionRouteDecisionDigest ||
        !HASH.test(input.implementationRunIdentityDigest ?? '') ||
        !HASH.test(input.verifierRunIdentityDigest ?? '') ||
        input.implementationRunIdentityDigest ===
            input.verifierRunIdentityDigest ||
        !Array.isArray(input.viewportStateMatrix) ||
        input.viewportStateMatrix.length === 0 ||
        input.viewportStateMatrix.some(({ evidenceDigest }) =>
            !HASH.test(evidenceDigest ?? '')) ||
        !Array.isArray(input.renderedArtifacts) ||
        input.renderedArtifacts.length === 0 ||
        input.renderedArtifacts.some(({ artifactDigest }) =>
            !HASH.test(artifactDigest ?? '')) ||
        !Array.isArray(input.modifiedPaths) ||
        input.modifiedPaths.length !== 0 ||
        !Array.isArray(input.designSuggestions) ||
        input.designSuggestions.length !== 0 ||
        !['accepted', 'rejected'].includes(input.status) ||
        !Array.isArray(input.blockers) ||
        input.status === 'accepted' && input.blockers.length !== 0 ||
        input.status === 'rejected' && input.blockers.length === 0) {
        fail('blog-ui-ux-acceptance-binding')
    }
    assertDigest(
        input,
        'receiptDigest',
        'blog-ui-ux-acceptance-binding'
    )
    return structuredClone(input)
}

export function evaluateBlogUiCheckpoint(input) {
    if (input?.schema !==
            'fsusblog-design-conformance.ui-checkpoint.v1' ||
        !['partial', 'complete'].includes(input.status) ||
        !HASH.test(input.sliceDigest ?? '') ||
        !HASH.test(input.compiledPromptDigest ?? '') ||
        !HASH.test(input.filesystemEvidenceDigest ?? '') ||
        !HASH.test(input.gitDiffDigest ?? '') ||
        !textArray(input.commandEvidenceDigests) ||
        input.commandEvidenceDigests.some((value) => !HASH.test(value)) ||
        !textArray(input.renderEvidenceDigests) ||
        input.renderEvidenceDigests.some((value) => !HASH.test(value))) {
        fail('blog-ui-checkpoint-evidence')
    }
    if (input.status === 'partial' &&
        (input.candidateGreen === true ||
            !text(input.nextRequiredAction))) {
        fail('blog-ui-partial-candidate-green')
    }
    if (input.status === 'complete' &&
        input.nextRequiredAction !== null) {
        fail('blog-ui-checkpoint-evidence')
    }
    assertDigest(
        input,
        'checkpointDigest',
        'blog-ui-checkpoint-evidence'
    )
    return deepFreeze(structuredClone(input))
}

export function authorizeBlogUiRecovery(input) {
    const materialChanges = new Set([
        'executable-slice-digest',
        'compiled-prompt-digest',
        'runtime-fingerprint',
        'sandbox-permission',
        'worktree-identity',
        'verified-profile-capability',
        'breaker-reset-receipt'
    ])
    if (input?.schema !==
            'fsusblog-design-conformance.ui-recovery-request.v1' ||
        ![
            'slice-not-executable',
            'compiled-prompt-incomplete',
            'runtime-invocation-failed',
            'sandbox-cwd-worktree-mismatch',
            'agent-first-action-not-executed',
            'profile-capability-mismatch'
        ].includes(input.failureClass) ||
        !HASH.test(input.previousObservableFingerprint ?? '') ||
        !HASH.test(input.currentObservableFingerprint ?? '') ||
        input.previousObservableFingerprint ===
            input.currentObservableFingerprint ||
        !textArray(input.changedInputs) ||
        !input.changedInputs.some((entry) => materialChanges.has(entry))) {
        fail('blog-ui-recovery-not-material')
    }
    const result = {
        authorized: true,
        failureClass: input.failureClass,
        previousObservableFingerprint:
            input.previousObservableFingerprint,
        currentObservableFingerprint:
            input.currentObservableFingerprint,
        changedInputs: [...input.changedInputs]
    }
    result.authorizationDigest = digest(result)
    return deepFreeze(result)
}

function baseSkillBindings() {
    return [
        {
            id: 'fsusblog-design-conformance',
            digest: digest('blog-skill')
        },
        {
            id: 'fsusui-design-conformance',
            digest: digest('fsusui-skill')
        }
    ]
}

function createBaseline(skills) {
    return sealDigest({
        schema:
            'fsusblog-design-conformance.fsusui-baseline-identity.v1',
        sourceKind: 'local-source',
        repository: 'Ozwasyd/FsusUI',
        absolutePath: '/workspace/FsusUI',
        gitHead: '2'.repeat(40),
        packageVersion: '0.36.0',
        dirty: false,
        dirtyFingerprint: digest('fsusui-clean'),
        skillDigest: skills[1].digest,
        contractDigests: {
            stagePolicy: digest('fsusui-stage-policy'),
            classification: digest('fsusui-classification'),
            adjudication: digest('fsusui-adjudication'),
            uxAcceptance: digest('fsusui-ux')
        }
    }, 'baselineDigest')
}

function createClassification({
    uiDecisionClass,
    verificationClass,
    skills,
    baseline
}) {
    return sealDigest({
        schema:
            'fsusblog-design-conformance.ui-classification-receipt.v2',
        stagePolicyDigest: blogUiStagePolicyDigest,
        repository: 'Ozwasyd/FsusBlog',
        issueId: '1830',
        uiImpact: true,
        ownerRepository: 'Ozwasyd/FsusBlog',
        affectedSurfaces: ['public-home'],
        uiDecisionClass,
        verificationClass,
        requiredDesignAuthorities: structuredClone(skills),
        fsusUIBaseline: structuredClone(baseline),
        stateEvidenceMatrix: [
            'light-wide-default',
            'dark-narrow-keyboard'
        ],
        inScope: ['src/frontend/pages/Home.vue'],
        outOfScope: ['FsusUI component geometry'],
        candidateSha: '3'.repeat(40),
        candidateIdentityDigest: digest('candidate-1830'),
        slicePolicyDigest: digest('slice-policy'),
        routingPolicyDigest: digest('routing-policy'),
        contextDigest: digest('context'),
        classificationEvidenceDigest: digest('classification-evidence')
    }, 'receiptDigest')
}

function createDispatch({
    classification,
    executionShape,
    actualProfile
}) {
    return sealDigest({
        schema:
            'fsusblog-design-conformance.ui-dispatch-receipt.v2',
        stagePolicyDigest: blogUiStagePolicyDigest,
        repository: 'Ozwasyd/FsusBlog',
        stageRole: 'ui-ux-implementer',
        stagePhase: 'ui-implementation',
        classificationReceiptDigest: classification.receiptDigest,
        workPlanDigest: digest('work-plan'),
        sliceDigest: digest('slice'),
        compiledPromptDigest: digest('compiled-prompt'),
        executionRouteDecisionDigest: digest('execution-route'),
        slicePolicyDigest: classification.slicePolicyDigest,
        routingPolicyDigest: classification.routingPolicyDigest,
        executionShape,
        firstRequiredAction:
            'inspect the current rendered home fixture',
        firstReadTargets: [
            'src/frontend/pages/Home.vue',
            'tests/frontend/fixtures/layout-archetype-matrix.json'
        ],
        firstWritablePath: 'src/frontend/pages/Home.vue',
        allowedPaths: ['src/frontend/pages/Home.vue'],
        forbiddenPaths: [
            'tests/',
            'tests/fixtures/',
            'docs/',
            '.agents/skills/'
        ],
        explicitNonGoals: [
            'no FsusUI token or component API changes',
            'no screenshot baseline updates'
        ],
        requiredFocusedCommands: [
            'node --test tests/frontend/home-layout.test.mjs'
        ],
        requiredRenderProbes: [
            'public-home light/dark narrow/wide'
        ],
        checkpointThresholds: {
            maxInvestigationCommands: 6,
            maxNoArtifactCommands: 3
        },
        completionPredicate:
            'focused contract and required render probes are green',
        continuationPredicate:
            'verified checkpoint names the next required action',
        actualModel: policy.executionProfiles[actualProfile].model,
        actualEffort: policy.executionProfiles[actualProfile].effort,
        actualProfile,
        targetWorktree: '/workspace/FsusBlog',
        targetWorktreeDigest: digest('/workspace/FsusBlog'),
        candidateSha: classification.candidateSha,
        candidateIdentityDigest:
            classification.candidateIdentityDigest,
        requiredSkills:
            structuredClone(classification.requiredDesignAuthorities),
        designAuthorityDigests:
            skillDigests(classification.requiredDesignAuthorities),
        fsusUIBaselineDigest:
            classification.fsusUIBaseline.baselineDigest,
        writeLease: {
            leaseId: 'lease-ui-1830',
            scope: 'implementation-only'
        },
        status: 'verified'
    }, 'receiptDigest')
}

function createAdjudication({
    classification,
    authorityState
}) {
    const human = HUMAN_REASONS.has(authorityState)
    const actualProfile = policy.adjudication.routing[authorityState]
    return sealDigest({
        schema:
            'fsusblog-design-conformance.ui-system-adjudication-receipt.v2',
        stagePolicyDigest: blogUiStagePolicyDigest,
        repository: 'Ozwasyd/FsusBlog',
        classificationReceiptDigest: classification.receiptDigest,
        actualModel: policy.executionProfiles[actualProfile].model,
        actualEffort: policy.executionProfiles[actualProfile].effort,
        actualProfile,
        freshContext: true,
        sandbox: 'read-only',
        writeLease: null,
        authorityState,
        uniqueResolutionAvailable: !human,
        allowedImplementationClass: human ? null : routeFor('layout-judgment', 'bounded-multifile'),
        inScope: ['authority ownership and implementation class'],
        outOfScope: ['implementation and product redesign'],
        requiredFollowUpIssue: human ? 'Ozwasyd/FsusBlog#1835' : null,
        requiredReslice: true,
        humanGateReason: human ? authorityState : null,
        humanDecisionRequestSchema: human
            ? policy.humanGate.requestSchema
            : null,
        humanDecisionRequestStatus: human
            ? policy.humanGate.requestStatus
            : null,
        humanDecisionRequestDigest: human
            ? digest('human-decision-request')
            : null,
        modifiedPaths: []
    }, 'receiptDigest')
}

function createUxAcceptance({
    classification,
    dispatch
}) {
    const actualProfile = UX_ROUTES[classification.verificationClass]
    return sealDigest({
        schema:
            'fsusblog-design-conformance.ux-acceptance-receipt.v2',
        stagePolicyDigest: blogUiStagePolicyDigest,
        repository: 'Ozwasyd/FsusBlog',
        classificationReceiptDigest: classification.receiptDigest,
        dispatchReceiptDigest: dispatch.receiptDigest,
        candidateSha: classification.candidateSha,
        candidateIdentityDigest:
            classification.candidateIdentityDigest,
        actualModel: policy.executionProfiles[actualProfile].model,
        actualEffort: policy.executionProfiles[actualProfile].effort,
        actualProfile,
        freshContext: true,
        sandbox: 'read-only',
        writeLease: null,
        requiredSkills: structuredClone(dispatch.requiredSkills),
        designAuthorityDigests:
            [...dispatch.designAuthorityDigests],
        fsusUIBaselineDigest: dispatch.fsusUIBaselineDigest,
        workPlanDigest: dispatch.workPlanDigest,
        sliceDigest: dispatch.sliceDigest,
        compiledPromptDigest: dispatch.compiledPromptDigest,
        executionRouteDecisionDigest:
            dispatch.executionRouteDecisionDigest,
        implementationRunIdentityDigest: digest('implementation-run'),
        verifierRunIdentityDigest: digest('ux-verifier-run'),
        viewportStateMatrix: [
            {
                viewport: '1440x900',
                state: 'default-light',
                input: 'keyboard',
                evidenceDigest: digest('matrix-evidence')
            }
        ],
        renderedArtifacts: [
            {
                kind: 'production-fixture-screenshot',
                path: '.tmp/ui-evidence/public-home.png',
                artifactDigest: digest('rendered-artifact')
            }
        ],
        blockers: [],
        status: 'accepted',
        modifiedPaths: [],
        designSuggestions: []
    }, 'receiptDigest')
}

function createCheckpoint(dispatch) {
    return sealDigest({
        schema: 'fsusblog-design-conformance.ui-checkpoint.v1',
        status: 'partial',
        sliceDigest: dispatch.sliceDigest,
        compiledPromptDigest: dispatch.compiledPromptDigest,
        filesystemEvidenceDigest: digest('filesystem-evidence'),
        gitDiffDigest: digest('git-diff'),
        commandEvidenceDigests: [digest('focused-command')],
        renderEvidenceDigests: [digest('render-evidence')],
        nextRequiredAction: 'run the narrow dark rendered probe',
        candidateGreen: false
    }, 'checkpointDigest')
}

function createRecovery() {
    return {
        schema:
            'fsusblog-design-conformance.ui-recovery-request.v1',
        failureClass: 'compiled-prompt-incomplete',
        previousObservableFingerprint: digest('old-prompt'),
        currentObservableFingerprint: digest('recompiled-prompt'),
        changedInputs: ['compiled-prompt-digest']
    }
}

export function createValidBlogUiBundle({
    uiDecisionClass = 'prescribed',
    verificationClass = 'ux-local',
    executionShape = uiDecisionClass === 'prescribed'
        ? 'atomic-edit'
        : 'bounded-multifile',
    includeDispatch = true,
    adjudicationAuthorityState = 'unique-resolution'
} = {}) {
    const skills = baseSkillBindings()
    const baseline = createBaseline(skills)
    const classification = createClassification({
        uiDecisionClass,
        verificationClass,
        skills,
        baseline
    })
    const dispatch = includeDispatch
        ? createDispatch({
            classification,
            executionShape,
            actualProfile: routeFor(uiDecisionClass, executionShape)
        })
        : null
    return {
        baseline,
        classification,
        dispatch,
        adjudication: createAdjudication({
            classification,
            authorityState: adjudicationAuthorityState
        }),
        uxAcceptance: dispatch
            ? createUxAcceptance({ classification, dispatch })
            : null,
        checkpoint: dispatch ? createCheckpoint(dispatch) : null,
        recovery: createRecovery(),
        overlappingImplementationOwner: false,
        consumerWorkaround: null,
        behaviorGreen: true,
        humanDecisionRecorded: false,
        reclassifiedAfterHumanDecision: true
    }
}

function resealClassification(bundle) {
    bundle.classification = sealDigest(
        bundle.classification,
        'receiptDigest'
    )
    bundle.baseline = structuredClone(bundle.classification.fsusUIBaseline)
    if (bundle.dispatch) {
        bundle.dispatch.classificationReceiptDigest =
            bundle.classification.receiptDigest
        bundle.dispatch = sealDigest(bundle.dispatch, 'receiptDigest')
    }
    if (bundle.adjudication) {
        bundle.adjudication.classificationReceiptDigest =
            bundle.classification.receiptDigest
        bundle.adjudication = sealDigest(
            bundle.adjudication,
            'receiptDigest'
        )
    }
    if (bundle.uxAcceptance && bundle.dispatch) {
        bundle.uxAcceptance.classificationReceiptDigest =
            bundle.classification.receiptDigest
        bundle.uxAcceptance.dispatchReceiptDigest =
            bundle.dispatch.receiptDigest
        bundle.uxAcceptance = sealDigest(
            bundle.uxAcceptance,
            'receiptDigest'
        )
    }
}

export function mutateBlogUiBundle(source, id) {
    const bundle = structuredClone(source)
    if (id === 'N01-non-ui-implementer') {
        bundle.dispatch.stageRole = 'code-implementer'
    } else if (id === 'N02-overlapping-ui-owner') {
        bundle.overlappingImplementationOwner = true
    } else if (id === 'N03-unsliced-complete-page') {
        bundle.dispatch.executionShape = 'complete-page-system'
    } else if (id === 'N04-prompt-missing-first-action') {
        bundle.dispatch.firstRequiredAction = ''
    } else if (id === 'N05-prescribed-wrong-profile') {
        bundle.dispatch.actualProfile = routeFor('layout-judgment', 'bounded-multifile')
        bundle.dispatch.actualEffort = policy.executionProfiles[bundle.dispatch.actualProfile].effort
    } else if (id === 'N06-ui-implementer-adjudication-profile') {
        bundle.dispatch.actualProfile = policy.adjudication.routing['unique-resolution']
        bundle.dispatch.actualEffort = policy.executionProfiles[bundle.dispatch.actualProfile].effort
    } else if (id === 'N07-output-missing-promotes-high') {
        bundle.recovery.currentObservableFingerprint =
            bundle.recovery.previousObservableFingerprint
        bundle.recovery.changedInputs = ['model-profile']
    } else if (id === 'N08-long-horizon-not-resliced') {
        bundle.dispatch.executionShape = 'long-horizon-cross-module'
    } else if (id === 'N09-dispute-bypasses-adjudication') {
        bundle.classification.uiDecisionClass = 'system-design-dispute'
        resealClassification(bundle)
    } else if (id === 'N10-adjudicator-writes-css') {
        bundle.adjudication.modifiedPaths = [
            'src/frontend/pages/Home.vue'
        ]
    } else if (id === 'N11-model-uncertainty-human-gate') {
        bundle.adjudication.authorityState = 'model-uncertainty'
        bundle.adjudication.humanGateReason = 'model-uncertainty'
    } else if (id === 'N12-model-chooses-product-direction') {
        bundle.adjudication.authorityState =
            'multiple-valid-product-directions'
        bundle.adjudication.uniqueResolutionAvailable = true
        bundle.adjudication.allowedImplementationClass = routeFor('layout-judgment', 'bounded-multifile')
        bundle.adjudication.humanGateReason = null
        bundle.adjudication.humanDecisionRequestSchema = null
        bundle.adjudication.humanDecisionRequestStatus = null
        bundle.adjudication.humanDecisionRequestDigest = null
    } else if (id === 'N13-human-decision-direct-ux-green') {
        bundle.humanDecisionRecorded = true
        bundle.reclassifiedAfterHumanDecision = false
    } else if (id === 'N14-missing-skill-baseline-route-digest') {
        bundle.dispatch.requiredSkills =
            bundle.dispatch.requiredSkills.slice(0, 1)
    } else if (id ===
        'N15-consumer-private-selector-workaround') {
        bundle.consumerWorkaround = 'private-selector'
    } else if (id === 'N16-behavior-green-skips-ux') {
        bundle.uxAcceptance = null
    } else if (id === 'N17-narrative-checkpoint') {
        bundle.checkpoint.filesystemEvidenceDigest = null
        bundle.checkpoint.gitDiffDigest = null
        bundle.checkpoint.commandEvidenceDigests = []
        bundle.checkpoint.renderEvidenceDigests = []
    } else if (id === 'N18-partial-slice-candidate-green') {
        bundle.checkpoint.candidateGreen = true
    } else {
        fail('blog-ui-mutation-unknown')
    }
    return bundle
}

export function validateBlogUiBundle(input) {
    if (input?.overlappingImplementationOwner === true) {
        fail('blog-ui-owner-overlap')
    }
    if (input?.consumerWorkaround !== null) {
        fail('blog-ui-consumer-workaround')
    }
    if (input?.humanDecisionRecorded === true &&
        input.reclassifiedAfterHumanDecision !== true) {
        fail('blog-ui-human-decision-revalidation')
    }
    const classification = validateClassification(input?.classification)
    const baseline = validateBaseline(input?.baseline)
    if (baseline.baselineDigest !==
        classification.fsusUIBaseline.baselineDigest) {
        fail('blog-ui-authority-binding')
    }
    if (input.adjudication?.classificationReceiptDigest !== classification.receiptDigest) {
        fail('blog-ui-adjudication-binding')
    }
    if (!input.dispatch) {
        if (classification.uiDecisionClass === 'system-design-dispute') {
            return deepFreeze({
                baseline,
                classification,
                dispatch: null,
                adjudication:
                    sealBlogUiAdjudication(input.adjudication),
                uxAcceptance: null,
                checkpoint: null,
                recovery: authorizeBlogUiRecovery(input.recovery)
            })
        }
        fail('blog-ui-dispatch-required')
    }
    const dispatch = validateDispatch(input.dispatch, classification)
    const adjudication = sealBlogUiAdjudication(input.adjudication)
    if (input.behaviorGreen !== true) {
        fail('blog-ui-behavior-green-required')
    }
    const uxAcceptance = validateUxAcceptance(
        input.uxAcceptance,
        classification,
        dispatch
    )
    const checkpoint = evaluateBlogUiCheckpoint(input.checkpoint)
    const recovery = authorizeBlogUiRecovery(input.recovery)
    return deepFreeze({
        baseline,
        classification,
        dispatch,
        adjudication,
        uxAcceptance,
        checkpoint,
        recovery
    })
}

export function runBlogUiSelfCheck() {
    checkExecutionProfilesSchema()
    for (const name of schemaNames) {
        const schema = JSON.parse(readFileSync(
            path.resolve(contractRoot, name),
            'utf8'
        ))
        if (schema.additionalProperties !== false ||
            !Array.isArray(schema.required) ||
            !schema.required.includes('schema')) {
            fail('blog-ui-schema-invalid')
        }
    }
    validateBlogUiBundle(createValidBlogUiBundle())
    const controls = JSON.parse(readFileSync(path.resolve(
        contractRoot,
        'blog-ui-orchestration-negative-controls.json'
    ), 'utf8'))
    for (const control of controls) {
        try {
            validateBlogUiBundle(mutateBlogUiBundle(
                createValidBlogUiBundle(),
                control.id
            ))
        } catch (error) {
            if (error?.code === control.expectedCode) continue
            throw error
        }
        fail(`blog-ui-negative-control-survived:${control.id}`)
    }
    return {
        schemas: schemaNames.length + 1,
        negativeControls: controls.length,
        policyDigest: blogUiStagePolicyDigest
    }
}

async function main() {
    if (process.argv.length !== 2) {
        throw new Error('ui-orchestration.mjs runs self-checks only; use validateBlogUiBundle for supplied receipts')
    }
    const result = runBlogUiSelfCheck()
    process.stdout.write(
        `[fsusblog-ui-orchestration] schemas=${result.schemas} ` +
        `negative-controls=${result.negativeControls} ` +
        `policy=${result.policyDigest}\n`
    )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    await main()
}
