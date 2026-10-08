#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateJsonSchema } from '../../../../tools/test-matrix/schema-validator/validate.mjs'
import {
    blogUiDomainPolicyDigest,
    blogUiStagePolicy as policy,
    blogUiStagePolicyDigest
} from './ui-stage-policy.mjs'

const skillRoot = path.resolve(import.meta.dirname, '..')
const contractRoot = path.resolve(skillRoot, 'contracts')
const schemaNames = [
    'fsusui-baseline-identity.schema.json',
    'ui-classification-receipt.schema.json',
    'ui-system-adjudication-receipt.schema.json',
    'ux-acceptance-receipt.schema.json'
]
const schemaTitles = {
    baseline: 'fsusblog-design-conformance.fsusui-baseline-identity.v1',
    classification: 'fsusblog-design-conformance.ui-classification-receipt.v2',
    adjudication: 'fsusblog-design-conformance.ui-system-adjudication-receipt.v2',
    uxAcceptance: 'fsusblog-design-conformance.ux-acceptance-receipt.v2'
}
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const REQUIRED_SKILL_IDS = policy.requiredSkillIds
const FORBIDDEN_RECEIPT_KEYS = new Set([
    'actor',
    'actualModel',
    'actualEffort',
    'actualProfile',
    'capacity',
    'checkpoint',
    'dispatch',
    'effort',
    'executionShape',
    'executionRoute',
    'executionRouteDecisionDigest',
    'executionRuntime',
    'lease',
    'leaseDigest',
    'model',
    'profile',
    'provider',
    'route',
    'routeDecision',
    'routeDigest',
    'runtime',
    'runtimeCapabilities',
    'runtimePermission',
    'runtimePermissions',
    'runtimeProfile',
    'runtimeDecision',
    'schedulerRoute',
    'schedulerRuntime',
    'routingPolicyDigest',
    'retry',
    'slicePolicyDigest',
    'workPlanDigest',
    'sliceDigest',
    'stage',
    'stageOrder',
    'selectedEffort',
    'selectedModel',
    'selectedProfile',
    'compiledPromptDigest',
    'dispatchReceiptDigest',
    'writeLease',
    'sandbox',
    'freshContext',
    'stageRole',
    'stagePhase',
    'writerLeaseOrder',
    'humanGateReason',
    'humanDecisionRequestSchema',
    'humanDecisionRequestStatus',
    'humanDecisionRequestDigest'
])
const BUNDLE_KEYS = new Set([
    'adjudication',
    'adjudicationClassification',
    'baseline',
    'behaviorGreen',
    'classification',
    'consumerWorkaround',
    'overlappingImplementationOwner',
    'uxAcceptance'
])

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

function assertDomainPolicy(input) {
    if (input?.domainPolicyDigest !== blogUiDomainPolicyDigest) {
        fail('blog-ui-domain-policy-binding')
    }
}

function assertNoOrchestrationFields(value, path = 'receipt') {
    if (Array.isArray(value)) {
        value.forEach((item, index) =>
            assertNoOrchestrationFields(item, `${path}[${index}]`))
        return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_RECEIPT_KEYS.has(key)) {
            fail('blog-ui-orchestration-authority-leak', `${path}.${key}`)
        }
        assertNoOrchestrationFields(child, `${path}.${key}`)
    }
}

function assertReceiptShape(value, schemaTitle, code, receiptPath) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(code)
    }
    const schema = schemaNames
        .map((name) => JSON.parse(readFileSync(
            path.resolve(contractRoot, name),
            'utf8'
        )))
        .find((candidate) => candidate.title === schemaTitle)
    if (!schema || !schema.properties) {
        fail('blog-ui-schema-invalid', schemaTitle)
    }
    for (const key of Object.keys(value)) {
        if (Object.hasOwn(schema.properties, key)) continue
        if (FORBIDDEN_RECEIPT_KEYS.has(key)) {
            fail('blog-ui-orchestration-authority-leak', `${receiptPath}.${key}`)
        }
        fail('blog-ui-receipt-shape', `${receiptPath}.${key}`)
    }
    return schema
}

function assertReceiptSchema(value, schema, code) {
    const errors = validateJsonSchema(value, schema)
    if (errors.length !== 0) {
        fail(code, errors.join('\n'))
    }
}

function assertBundleShape(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('blog-ui-bundle-shape')
    }
    for (const key of Object.keys(value)) {
        if (BUNDLE_KEYS.has(key)) continue
        if (FORBIDDEN_RECEIPT_KEYS.has(key)) {
            fail('blog-ui-orchestration-authority-leak', `bundle.${key}`)
        }
        fail('blog-ui-bundle-shape', `bundle.${key}`)
    }
    for (const key of BUNDLE_KEYS) {
        if (!Object.hasOwn(value, key)) {
            fail('blog-ui-bundle-shape', `bundle.${key}`)
        }
    }
    if (typeof value.overlappingImplementationOwner !== 'boolean') {
        fail('blog-ui-bundle-shape', 'bundle.overlappingImplementationOwner')
    }
}

function validateBaseline(input) {
    const schema = assertReceiptShape(
        input,
        schemaTitles.baseline,
        'blog-ui-baseline-identity',
        'baseline'
    )
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
    assertReceiptSchema(input, schema, 'blog-ui-baseline-identity')
    assertDigest(input, 'baselineDigest', 'blog-ui-baseline-identity')
    return structuredClone(input)
}

function validateClassification(input) {
    assertDomainPolicy(input)
    assertNoOrchestrationFields(input, 'classification')
    const schema = assertReceiptShape(
        input,
        schemaTitles.classification,
        'blog-ui-authority-binding',
        'classification'
    )
    assertReceiptSchema(input, schema, 'blog-ui-authority-binding')
    if (input?.schema !==
            'fsusblog-design-conformance.ui-classification-receipt.v2' ||
        input.repository !== 'Ozwasyd/FsusBlog' ||
        !text(input.issueId) ||
        input.uiImpact !== true ||
        !['Ozwasyd/FsusBlog', 'Ozwasyd/FsusUI']
            .includes(input.ownerRepository) ||
        !textArray(input.affectedSurfaces) ||
        !policy.uiDecisionClasses.includes(input.uiDecisionClass) ||
        !policy.verificationClasses.includes(input.verificationClass) ||
        !validRequiredSkills(input.requiredDesignAuthorities) ||
        !textArray(input.stateEvidenceMatrix) ||
        !textArray(input.inScope) ||
        !textArray(input.outOfScope) ||
        !SHA.test(input.candidateSha ?? '') ||
        !HASH.test(input.candidateIdentityDigest ?? '') ||
        !HASH.test(input.classificationEvidenceDigest ?? '') ||
        input.status !== 'frozen') {
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

export function sealBlogUiAdjudication(input, classification) {
    classification = validateClassification(classification)
    assertDomainPolicy(input)
    assertNoOrchestrationFields(input, 'adjudication')
    const schema = assertReceiptShape(
        input,
        schemaTitles.adjudication,
        'blog-ui-adjudication-binding',
        'adjudication'
    )
    if (input?.schema !==
            'fsusblog-design-conformance.ui-system-adjudication-receipt.v2' ||
        input.repository !== 'Ozwasyd/FsusBlog' ||
        classification.uiDecisionClass !==
            policy.systemDesignDisputeClass ||
        input.classificationReceiptDigest !== classification.receiptDigest ||
        input.ownerRepository !== classification.ownerRepository ||
        JSON.stringify(input.authoritativeSkillDigests) !==
            JSON.stringify(skillDigests(classification.requiredDesignAuthorities)) ||
        JSON.stringify(input.authorityDigests) !==
            JSON.stringify(skillDigests(classification.requiredDesignAuthorities)) ||
        input.activeBaselineIdentityDigest !==
            classification.fsusUIBaseline.baselineDigest ||
        input.candidateSha !== classification.candidateSha ||
        input.candidateIdentityDigest !==
            classification.candidateIdentityDigest ||
        ![
            'owner-dispute',
            'authority-dispute',
            'component-api-ownership',
            'design-system-capability-boundary'
        ].includes(input.problemClassification) ||
        ![
            'fsusui-owned',
            'consumer-owned',
            'authority-clarified',
            'requires-authority-change'
        ].includes(input.disposition) ||
        ![
            'prescribed',
            'bounded-composition',
            'layout-judgment',
            'interaction-judgment'
        ].includes(input.allowedUiDecisionClass) ||
        !textArray(input.inScope) ||
        !textArray(input.outOfScope) ||
        !(input.requiredFollowUpIssue === null ||
            text(input.requiredFollowUpIssue)) ||
        input.status !== 'adjudicated') {
        fail('blog-ui-adjudication-binding')
    }
    if (!Array.isArray(input.modifiedPaths) ||
        input.modifiedPaths.length !== 0) {
        fail('blog-ui-adjudicator-read-only')
    }
    assertReceiptSchema(input, schema, 'blog-ui-adjudication-binding')
    assertDigest(
        input,
        'adjudicationDigest',
        'blog-ui-adjudication-binding'
    )
    return deepFreeze(structuredClone(input))
}

function validateUxAcceptance(input, classification) {
    if (!input) fail('blog-ui-ux-acceptance-required')
    assertDomainPolicy(input)
    assertNoOrchestrationFields(input, 'uxAcceptance')
    const schema = assertReceiptShape(
        input,
        schemaTitles.uxAcceptance,
        'blog-ui-ux-acceptance-binding',
        'uxAcceptance'
    )
    assertReceiptSchema(input, schema, 'blog-ui-ux-acceptance-binding')
    if (input.schema !==
            'fsusblog-design-conformance.ux-acceptance-receipt.v2' ||
        input.repository !== 'Ozwasyd/FsusBlog' ||
        input.classificationReceiptDigest !==
            classification.receiptDigest ||
        input.candidateSha !== classification.candidateSha ||
        input.candidateIdentityDigest !==
            classification.candidateIdentityDigest ||
        input.verificationClass !== classification.verificationClass ||
        JSON.stringify(input.requiredSkills) !==
            JSON.stringify(classification.requiredDesignAuthorities) ||
        JSON.stringify(input.designAuthorityDigests) !==
            JSON.stringify(skillDigests(classification.requiredDesignAuthorities)) ||
        input.fsusUIBaselineDigest !==
            classification.fsusUIBaseline.baselineDigest ||
        !HASH.test(input.independenceEvidenceDigest ?? '') ||
        input.productionFixture !== true ||
        !Array.isArray(input.viewportStateMatrix) ||
        input.viewportStateMatrix.length === 0 ||
        input.viewportStateMatrix.some(({ evidenceDigest }) =>
            !HASH.test(evidenceDigest ?? '')) ||
        !Array.isArray(input.inspectedRenderedArtifacts) ||
        input.inspectedRenderedArtifacts.length === 0 ||
        input.inspectedRenderedArtifacts.some(({ digest: value, inspected, fixtureClass }) =>
            !HASH.test(value ?? '') ||
            inspected !== true ||
            fixtureClass !== 'production') ||
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
        domainPolicyDigest: blogUiDomainPolicyDigest,
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
        classificationEvidenceDigest: digest('classification-evidence'),
        status: 'frozen'
    }, 'receiptDigest')
}

function createAdjudication({ classification }) {
    return sealDigest({
        schema:
            'fsusblog-design-conformance.ui-system-adjudication-receipt.v2',
        domainPolicyDigest: blogUiDomainPolicyDigest,
        repository: 'Ozwasyd/FsusBlog',
        classificationReceiptDigest: classification.receiptDigest,
        ownerRepository: classification.ownerRepository,
        authoritativeSkillDigests:
            skillDigests(classification.requiredDesignAuthorities),
        authorityDigests:
            skillDigests(classification.requiredDesignAuthorities),
        activeBaselineIdentityDigest:
            classification.fsusUIBaseline.baselineDigest,
        candidateSha: classification.candidateSha,
        candidateIdentityDigest:
            classification.candidateIdentityDigest,
        problemClassification: 'component-api-ownership',
        disposition: 'consumer-owned',
        allowedUiDecisionClass: 'layout-judgment',
        modifiedPaths: [],
        inScope: ['authority ownership and implementation class'],
        outOfScope: ['implementation and product redesign'],
        requiredFollowUpIssue: null,
        status: 'adjudicated'
    }, 'adjudicationDigest')
}

function createUxAcceptance({ classification }) {
    return sealDigest({
        schema:
            'fsusblog-design-conformance.ux-acceptance-receipt.v2',
        domainPolicyDigest: blogUiDomainPolicyDigest,
        repository: 'Ozwasyd/FsusBlog',
        classificationReceiptDigest: classification.receiptDigest,
        candidateSha: classification.candidateSha,
        candidateIdentityDigest:
            classification.candidateIdentityDigest,
        verificationClass: classification.verificationClass,
        requiredSkills:
            structuredClone(classification.requiredDesignAuthorities),
        designAuthorityDigests:
            skillDigests(classification.requiredDesignAuthorities),
        fsusUIBaselineDigest:
            classification.fsusUIBaseline.baselineDigest,
        independenceEvidenceDigest: digest('independence-evidence'),
        productionFixture: true,
        viewportStateMatrix: [
            {
                viewport: '1440x900',
                state: 'default-light',
                theme: 'light',
                inputModes: ['pointer', 'keyboard'],
                evidenceDigest: digest('matrix-evidence')
            }
        ],
        inspectedRenderedArtifacts: [
            {
                id: 'public-home-light',
                kind: 'screenshot',
                path: '.tmp/ui-evidence/public-home.png',
                digest: digest('rendered-artifact'),
                inspected: true,
                fixtureClass: 'production'
            }
        ],
        blockers: [],
        status: 'accepted',
        modifiedPaths: [],
        designSuggestions: []
    }, 'receiptDigest')
}

export function createValidBlogUiBundle({
    uiDecisionClass = 'prescribed',
    verificationClass = 'ux-local',
    includeAcceptance = true
} = {}) {
    const skills = baseSkillBindings()
    const baseline = createBaseline(skills)
    const classification = createClassification({
        uiDecisionClass,
        verificationClass,
        skills,
        baseline
    })
    const adjudicationClassification = createClassification({
        uiDecisionClass: policy.systemDesignDisputeClass,
        verificationClass: 'ux-system',
        skills,
        baseline
    })
    return {
        baseline,
        classification,
        adjudicationClassification,
        adjudication: createAdjudication({
            classification: adjudicationClassification
        }),
        uxAcceptance: includeAcceptance
            ? createUxAcceptance({ classification })
            : null,
        overlappingImplementationOwner: false,
        consumerWorkaround: null,
        behaviorGreen: true
    }
}

export function mutateBlogUiBundle(source, id) {
    const bundle = structuredClone(source)
    if (id === 'N01-classification-skill-digest-missing') {
        bundle.classification.requiredDesignAuthorities = []
    } else if (id === 'N02-classification-candidate-drift') {
        bundle.classification.candidateSha = '9'.repeat(40)
    } else if (id === 'N03-classification-policy-drift') {
        bundle.classification.domainPolicyDigest = 'f'.repeat(64)
        bundle.classification = sealDigest(
            bundle.classification,
            'receiptDigest'
        )
    } else if (id === 'N04-system-dispute-without-matching-adjudication') {
        bundle.adjudication.classificationReceiptDigest = 'e'.repeat(64)
        bundle.adjudication = sealDigest(
            bundle.adjudication,
            'adjudicationDigest'
        )
    } else if (id === 'N05-adjudication-modifies-component') {
        bundle.adjudication.modifiedPaths = [
            'src/frontend/pages/Home.vue'
        ]
        bundle.adjudication = sealDigest(
            bundle.adjudication,
            'adjudicationDigest'
        )
    } else if (id === 'N06-adjudication-policy-drift') {
        bundle.adjudication.domainPolicyDigest = 'f'.repeat(64)
        bundle.adjudication = sealDigest(
            bundle.adjudication,
            'adjudicationDigest'
        )
    } else if (id === 'N07-ux-accepted-with-blocker') {
        bundle.uxAcceptance.blockers = ['unresolved focus state']
        bundle.uxAcceptance = sealDigest(
            bundle.uxAcceptance,
            'receiptDigest'
        )
    } else if (id === 'N08-ux-rejected-without-blocker') {
        bundle.uxAcceptance.status = 'rejected'
        bundle.uxAcceptance.blockers = []
        bundle.uxAcceptance = sealDigest(
            bundle.uxAcceptance,
            'receiptDigest'
        )
    } else if (id === 'N09-ux-verification-class-drift') {
        bundle.uxAcceptance.verificationClass = 'ux-system'
        bundle.uxAcceptance = sealDigest(
            bundle.uxAcceptance,
            'receiptDigest'
        )
    } else if (id === 'N10-ux-candidate-drift') {
        bundle.uxAcceptance.candidateSha = '9'.repeat(40)
        bundle.uxAcceptance = sealDigest(
            bundle.uxAcceptance,
            'receiptDigest'
        )
    } else if (id === 'N11-ux-verifier-writes-component') {
        bundle.uxAcceptance.modifiedPaths = [
            'src/frontend/pages/Home.vue'
        ]
        bundle.uxAcceptance = sealDigest(
            bundle.uxAcceptance,
            'receiptDigest'
        )
    } else if (id === 'N12-ux-policy-drift') {
        bundle.uxAcceptance.domainPolicyDigest = 'f'.repeat(64)
        bundle.uxAcceptance = sealDigest(
            bundle.uxAcceptance,
            'receiptDigest'
        )
    } else if (id === 'N13-consumer-private-selector-workaround') {
        bundle.consumerWorkaround = 'private-selector'
    } else if (id === 'N14-missing-fsusui-skill') {
        bundle.classification.requiredDesignAuthorities =
            bundle.classification.requiredDesignAuthorities.slice(0, 1)
    } else if (id === 'N15-behavior-green-skips-ux') {
        bundle.uxAcceptance = null
    } else if (id === 'N16-overlapping-ui-owner') {
        bundle.overlappingImplementationOwner = true
    } else if (id === 'N17-baseline-identity-drift') {
        bundle.classification.fsusUIBaseline.dirty = true
    } else if (id === 'N18-orchestration-fields-in-receipt') {
        bundle.classification.actualModel = 'gpt-5.6-sol'
        bundle.classification = sealDigest(
            bundle.classification,
            'receiptDigest'
        )
    } else {
        fail('blog-ui-mutation-unknown')
    }
    return bundle
}

export function validateBlogUiBundle(input) {
    assertBundleShape(input)
    if (input?.overlappingImplementationOwner === true) {
        fail('blog-ui-owner-overlap')
    }
    if (input?.consumerWorkaround !== null) {
        fail('blog-ui-consumer-workaround')
    }
    const classification = validateClassification(input?.classification)
    const baseline = validateBaseline(input?.baseline)
    if (baseline.baselineDigest !==
        classification.fsusUIBaseline.baselineDigest) {
        fail('blog-ui-authority-binding')
    }
    const adjudicationClassification = validateClassification(
        input?.adjudicationClassification
    )
    for (const field of [
        'issueId',
        'ownerRepository',
        'affectedSurfaces',
        'requiredDesignAuthorities',
        'fsusUIBaseline',
        'candidateSha',
        'candidateIdentityDigest'
    ]) {
        if (digest(adjudicationClassification[field]) !==
            digest(classification[field])) {
            fail('blog-ui-adjudication-binding', field)
        }
    }
    const adjudication = sealBlogUiAdjudication(
        input.adjudication,
        adjudicationClassification
    )
    if (input.behaviorGreen !== true) {
        fail('blog-ui-behavior-green-required')
    }
    const uxAcceptance = validateUxAcceptance(
        input.uxAcceptance,
        classification
    )
    return deepFreeze({
        baseline,
        classification,
        adjudicationClassification,
        adjudication,
        uxAcceptance
    })
}

export function runBlogUiSelfCheck() {
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
        const text = JSON.stringify(schema)
        if (/\bactualModel\b|\bactualEffort\b|\bactualProfile\b|ui-execution-profiles|gpt-5\.6-sol|sol-low/u.test(text)) {
            fail('blog-ui-orchestration-authority-leak', name)
        }
    }
    if (policy.sharedOrchestrationAuthority !== 'external' ||
        !policy.forbiddenSharedOrchestrationClaims.includes('model-profile-effort') ||
        !policy.forbiddenSharedOrchestrationClaims.includes('route-selection')) {
        fail('blog-ui-orchestration-authority-leak', 'policy')
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
        schemas: schemaNames.length,
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
