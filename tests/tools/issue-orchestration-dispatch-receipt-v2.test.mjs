import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtureRoot = path.join(root, 'tests/fixtures/issue-orchestration')
const runtimePath = path.join(
    root,
    '.agents/skills/issue-orchestration/scripts/dispatch-receipt.mjs'
)
const policyPath = path.join(
    root,
    '.agents/skills/issue-orchestration/scripts/stage-profile-policy.mjs'
)
const contract = readJson('dispatch-receipt-v2-test-contract.json')
const acceptance = readJson('dispatch-receipt-v2-acceptance-map.json')
const controls = readJson('dispatch-receipt-v2-mutation-controls.json').controls
const probes = readJson('dispatch-receipt-v2-runtime-probes.json').probes

const baseSha = '788737a0ad22003544b2d439df995e1097de0ee2'
const repository = 'Ozwasyd/FsusBlog'
const issueId = `${repository}#1832`
const worktree = root
const hash = (character) => character.repeat(64)

function readJson(name) {
    return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), 'utf8'))
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value)))
        .digest('hex')
}

function clone(value) {
    return structuredClone(value)
}

function sealedObservation(value) {
    const observation = clone(value)
    observation.observationDigest = digest(observation)
    return observation
}

async function runtime() {
    return import(`${pathToFileURL(runtimePath).href}?v2=${Date.now()}-${Math.random()}`)
}

async function policy() {
    return import(`${pathToFileURL(policyPath).href}?v2=${Date.now()}-${Math.random()}`)
}

async function frozenRoute(changes = {}) {
    const module = await policy()
    const classification = {
        domain: 'orchestration-core',
        effectiveOwnerRepository: repository,
        engineeringRiskClass: 'high-risk',
        uiDecisionClass: 'none',
        contractState: 'frozen',
        verificationClass: 'runtime',
        modelRoutingEvidenceDigest: hash('a'),
        routingPolicyVersion: 'stage-model-pool.v2',
        ...changes.classification
    }
    const stageRole = changes.stageRole ?? 'code-implementer'
    const stagePhase = changes.stagePhase ?? 'implementation'
    const route = module.compileStageRoute({
        ...classification,
        stageRole,
        stagePhase,
        requiredSkillDigests: changes.requiredSkillDigests ?? []
    })
    return { classification, route, stageRole, stagePhase, module }
}

async function requestInput(overrides = {}) {
    const routeInput = await frozenRoute({
        classification: overrides.routingClassification,
        stageRole: overrides.stageRole,
        stagePhase: overrides.stagePhase,
        requiredSkillDigests: (overrides.requiredSkills ?? [])
            .map(({ digest: value }) => value)
    })
    const selected = routeInput.module.splitProfile(routeInput.route.selectedProfile)
    return {
        schema: 'issue-orchestration.dispatch-request.v2',
        policyVersion: 'stage-model-pool.v2',
        routingPolicyDigest: digest(routeInput.module.STAGE_MODEL_POOL_POLICY),
        stageRole: routeInput.stageRole,
        stagePhase: routeInput.stagePhase,
        stageProfileId: routeInput.route.selectedProfile,
        allowedProfilesDigest: digest(routeInput.route.allowedProfiles),
        defaultProfileId: routeInput.route.defaultProfile,
        routingAuthority: routeInput.route.routingAuthority,
        routingInputDigest: routeInput.route.routingInputDigest,
        selectedProfileReason: routeInput.route.selectedProfileReason,
        selectedProfileId: routeInput.route.selectedProfile,
        routingClassification: routeInput.classification,
        routeTransitionFrom: null,
        routeTransitionReason: 'initial-classification',
        requestedByRole: 'root-scheduler',
        requestId: 'request-1832-001',
        runId: 'run-1832-001',
        nodeId: issueId,
        attemptId: 'attempt-1832-001',
        promptDigest: hash('b'),
        sourceDagDigest: hash('c'),
        frontierDigest: hash('d'),
        issueSnapshotFingerprint: hash('e'),
        repositoryFingerprint: hash('f'),
        scopeIdentityDigest: hash('1'),
        dependencyIdentityDigest: digest(contract.dependencyBindings),
        repository,
        baseSha,
        epochId: 'epoch-1832-001',
        requestedModel: selected.model,
        requestedEffort: selected.effort,
        requestedMode: 'normal',
        requestedSandbox: routeInput.route.sandbox,
        requestedForkTurns: '3',
        requestedWorkingDirectory: worktree,
        requiredSkills: overrides.requiredSkills ?? [],
        requiredSkillIds: (overrides.requiredSkills ?? []).map(({ id }) => id),
        requiredSkillDigests: (overrides.requiredSkills ?? [])
            .map(({ digest: value }) => value),
        designAuthorityDigests: [],
        uiImpact: false,
        allowedPathsDigest: hash('2'),
        forbiddenPathsDigest: hash('3'),
        writePolicy: 'stage-scoped-write-lease',
        readOnlyPolicy: false,
        candidateSha: baseSha,
        candidateDigest: hash('4'),
        testOwnerId: contract.testOwnerId,
        testContractDigest: contract.testContractDigest,
        behaviorReceiptDigest: null,
        uxAcceptanceReceiptDigest: null,
        documentationReceiptDigest: null,
        groupId: null,
        groupSessionDigest: null,
        memberIssueId: issueId,
        memberStage: 'implementation',
        activeWriteLeaseId: null,
        groupWorktreeIdentity: null,
        groupBranchIdentity: null,
        testOwnerContinuityIdentity: null,
        implementerContinuityIdentity: null,
        freshVerificationRollout: false,
        memberTestContractDigest: contract.testContractDigest,
        memberCandidateIdentity: hash('5'),
        createdAt: '2026-08-01T13:00:00+08:00',
        ...overrides,
        routingClassification: {
            ...routeInput.classification,
            ...overrides.routingClassification
        }
    }
}

function dispatchEvidence(request) {
    const machineObservations = [
        sealedObservation({
            kind: 'dispatch-context.v2',
            source: 'machine-dispatch-context',
            requestId: request.requestId,
            promptDigest: request.promptDigest,
            sourceDagDigest: request.sourceDagDigest,
            frontierDigest: request.frontierDigest,
            issueSnapshotFingerprint: request.issueSnapshotFingerprint,
            repositoryFingerprint: request.repositoryFingerprint,
            scopeIdentityDigest: request.scopeIdentityDigest,
            dependencyIdentityDigest: request.dependencyIdentityDigest,
            policyVersion: request.policyVersion,
            routingPolicyDigest: request.routingPolicyDigest,
            routingInputDigest: request.routingInputDigest,
            testContractDigest: request.testContractDigest,
            epochId: request.epochId
        }),
        sealedObservation({
            kind: 'git-worktree-identity',
            source: 'machine-git-observation',
            repository,
            baseSha: request.baseSha,
            candidateSha: request.candidateSha,
            candidateDigest: request.candidateDigest,
            workingDirectory: worktree
        }),
        sealedObservation({
            kind: 'skill-loader',
            source: 'runtime-skill-loader',
            loadedSkills: request.requiredSkills
        }),
        sealedObservation({
            kind: 'runtime-capability.v2',
            source: 'runtime-capability-registry',
            requestedProfileId: request.selectedProfileId,
            effectiveProfileId: request.selectedProfileId,
            available: true
        }),
        sealedObservation({
            kind: 'group-member-lease',
            source: 'machine-lease-registry',
            groupId: null,
            memberIssueId: issueId,
            memberStage: request.memberStage,
            freshVerificationRollout: request.freshVerificationRollout
        })
    ]
    const rolloutRecords = [
        {
            timestamp: '2026-08-01T13:00:01+08:00',
            type: 'session_meta',
            payload: {
                id: 'rollout-1832-implementer',
                session_id: 'thread-1832-implementer',
                source: {
                    subagent: {
                        thread_spawn: {
                            agent_role: request.stageRole,
                            fork_turns: request.requestedForkTurns
                        }
                    }
                }
            }
        },
        {
            timestamp: '2026-08-01T13:00:01+08:00',
            type: 'turn_context',
            payload: {
                cwd: request.requestedWorkingDirectory,
                model: request.requestedModel,
                effort: request.requestedEffort,
                mode: request.requestedMode,
                sandbox_policy: { type: request.requestedSandbox }
            }
        }
    ]
    return { machineObservations, rolloutRecords }
}

async function verifiedDispatch() {
    const module = await runtime()
    const request = await module.sealDispatchRequest(await requestInput())
    const result = await module.verifyRuntimeDispatch({
        request,
        ...dispatchEvidence(request),
        priorReceipts: []
    })
    assert.equal(result.dispatchReceipt.verificationStatus, 'verified')
    assert.equal(
        result.dispatchReceipt.schema,
        'issue-orchestration.dispatch-receipt.v2'
    )
    return { module, request, ...result }
}

function rootStartupInput() {
    const request = {
        schema: 'issue-orchestration.root-startup-request.v2',
        policyVersion: 'stage-model-pool.v2',
        routingPolicyDigest: hash('6'),
        runId: 'run-1832-001',
        stageRole: 'root-scheduler',
        stagePhase: 'scheduling',
        stageProfileId: 'luna-low',
        routingInputDigest: hash('7'),
        requestedModel: 'gpt-5.6-luna',
        requestedEffort: 'low',
        requestedMode: 'normal',
        requestedWorkingDirectory: worktree,
        repositoryFingerprint: hash('f'),
        baseSha,
        createdAt: '2026-08-01T12:59:59+08:00'
    }
    request.requestDigest = digest(request)
    const rolloutRecords = [
        {
            timestamp: '2026-08-01T13:00:00+08:00',
            type: 'session_meta',
            payload: {
                id: 'rollout-1832-root',
                session_id: 'thread-1832-root',
                role: 'root-scheduler',
                model: 'gpt-5.6-luna',
                effort: 'low',
                mode: 'normal'
            }
        },
        {
            timestamp: '2026-08-01T13:00:00+08:00',
            type: 'turn_context',
            payload: {
                cwd: worktree,
                role: 'root-scheduler',
                model: 'gpt-5.6-luna',
                effort: 'low',
                mode: 'normal'
            }
        }
    ]
    const machineObservations = [
        sealedObservation({
            kind: 'root-runtime-capability.v2',
            source: 'runtime-capability-registry',
            stageProfileId: 'luna-low',
            available: true
        })
    ]
    return { request, rolloutRecords, machineObservations }
}

function selfTestExecution(request) {
    const commandResults = contract.visibleTestMatrix.map((entry, index) => ({
        id: entry.id,
        command: entry.command,
        exitStatus: 0,
        skipped: false,
        resultDigest: digest(`${entry.id}:${index}`)
    }))
    return {
        runId: request.runId,
        nodeId: request.nodeId,
        attemptId: request.attemptId,
        stageRole: request.stageRole,
        stageProfileId: request.stageProfileId,
        routingInputDigest: request.routingInputDigest,
        requestDigest: request.requestDigest,
        candidateSha: request.candidateSha,
        baseSha: request.baseSha,
        frozenTestContractDigest: contract.testContractDigest,
        frozenTestTreeDigestBefore: contract.frozenTestTree.digest,
        frozenTestTreeDigestAfter: contract.frozenTestTree.digest,
        implementationDiffDigest: hash('8'),
        commandResults,
        visibleTestMatrixDigest: digest(contract.visibleTestMatrix),
        lintTypecheckBuildResults: {
            lint: 'passed',
            typecheck: 'passed',
            build: 'not-applicable-no-build-artifact'
        },
        firstFailureRefs: ['evidence://1832/v2-schema-missing'],
        fixCycleCount: 1,
        failureHistory: [
            { ref: 'evidence://1832/v2-schema-missing', outcome: 'failed' },
            { ref: 'evidence://1832/candidate-green', outcome: 'passed' }
        ],
        remainingFailures: [],
        workingTreeStatusDigest: hash('9'),
        observedWorkingTreeStatusDigest: hash('9'),
        modifiedPaths: [
            '.agents/skills/issue-orchestration/scripts/dispatch-receipt.mjs',
            '.agents/skills/issue-orchestration/scripts/event-ledger.mjs'
        ],
        verifierRole: 'deterministic-machine'
    }
}

function verifiedV2DispatchReceipt(request = {}) {
    const receipt = {
        schema: 'issue-orchestration.dispatch-receipt.v2',
        requestId: request.requestId ?? 'request-1832-001',
        requestDigest: request.requestDigest ?? hash('a'),
        attemptId: request.attemptId ?? 'attempt-1832-001',
        epochId: request.epochId ?? 'epoch-1832-001',
        baseSha: request.baseSha ?? baseSha,
        candidateSha: request.candidateSha ?? baseSha,
        policyVersion: 'stage-model-pool.v2',
        routingPolicyDigest: request.routingPolicyDigest ?? hash('6'),
        routingInputDigest: request.routingInputDigest ?? hash('7'),
        verificationStatus: 'verified',
        mismatchReasons: []
    }
    receipt.receiptDigest = digest(receipt)
    return receipt
}

function behaviorReceipt({ fresh = true, selfTest = false } = {}) {
    const receipt = {
        schema: selfTest
            ? 'issue-orchestration.implementer-self-test-receipt.v2'
            : 'issue-orchestration.behavior-receipt.v2',
        stageRole: selfTest ? 'code-implementer' : 'test-owner',
        stagePhase: selfTest ? 'self-test' : 'behavior-verification',
        candidateSha: baseSha,
        freshVerificationRollout: selfTest ? false : fresh,
        readOnly: !selfTest,
        verificationStatus: 'verified'
    }
    receipt.receiptDigest = digest(receipt)
    return receipt
}

async function assertThrownCode(action, expectedCode, id) {
    await assert.rejects(
        action,
        (error) => error?.code === expectedCode,
        id
    )
}

function assertRejectedReason(result, expectedCode, id) {
    const receipt = result.rootStartupReceipt ?? result.dispatchReceipt ?? result
    assert.notEqual(receipt.verificationStatus, 'verified', id)
    assert.ok(receipt.mismatchReasons?.includes(expectedCode), id)
}

test('P00 frozen test assets bind the live issue, dependencies and exact base', () => {
    assert.equal(contract.status, 'frozen-red')
    assert.equal(contract.issueId, issueId)
    assert.equal(contract.baseSha, baseSha)
    assert.equal(contract.testOwnerId, 'test-owner-fsusblog-1832-788737a0')
    assert.equal(contract.groupId, null)
    assert.equal(contract.pipeline, 'ordinary-serial')
    assert.equal(contract.ciPolicy, 'out-of-scope-no-ci')
    assert.deepEqual(
        contract.dependencyBindings.map(({ issue, deliveredCommit }) =>
            [issue, deliveredCommit]),
        [
            ['Ozwasyd/FsusBlog#1817', '9c02ed22bdd578d07d6e4ca8c1c4c9bc161bbc18'],
            ['Ozwasyd/FsusBlog#1818', 'c8cb56dce27769a3cc3663cc0e39cc0a75716fed'],
            ['Ozwasyd/FsusBlog#1819', 'aff9260d358171d7765e542e56bf18635b328583']
        ]
    )
    assert.deepEqual(
        acceptance.acceptance.flatMap(({ mutations }) => mutations)
            .filter((value, index, values) => values.indexOf(value) === index)
            .sort(),
        controls.map(({ id }) => id).sort()
    )
    assert.deepEqual(probes.map(({ mutation }) => mutation),
        controls.map(({ id }) => id))
    for (const [relative, expected] of Object.entries(contract.fileHashes)) {
        assert.equal(digest(fs.readFileSync(path.join(root, relative))), expected)
    }
    const unsigned = clone(contract)
    delete unsigned.testContractDigest
    assert.equal(digest(unsigned), contract.testContractDigest)
})

test('P01 dispatch-request.v2 seals every route and serial identity field', async () => {
    const module = await runtime()
    const request = await module.sealDispatchRequest(await requestInput())
    assert.equal(request.schema, 'issue-orchestration.dispatch-request.v2')
    assert.equal(request.groupId, null)
    assert.equal(request.memberIssueId, issueId)
    assert.equal(request.stageProfileId, 'terra-max')
    assert.equal(request.selectedProfileReason, 'engineering-risk-high-risk')
    assert.equal(request.requestDigest, digest({ ...request, requestDigest: undefined }))
    assert.equal(Object.isFrozen(request), true)
})

test('P02 dispatch-receipt.v2 binds independently observed actual metadata', async () => {
    const { request, runtimeObservation, dispatchReceipt } = await verifiedDispatch()
    assert.equal(runtimeObservation.effectiveModel, request.requestedModel)
    assert.equal(runtimeObservation.effectiveEffort, request.requestedEffort)
    assert.equal(runtimeObservation.effectiveRole, request.stageRole)
    assert.equal(runtimeObservation.effectiveMode, 'normal')
    assert.equal(runtimeObservation.routingInputDigest, request.routingInputDigest)
    assert.equal(dispatchReceipt.runtimeMetadataDigest, digest(runtimeObservation))
    assert.equal(dispatchReceipt.scopeIdentityDigest, request.scopeIdentityDigest)
    assert.equal(dispatchReceipt.dependencyIdentityDigest,
        request.dependencyIdentityDigest)
})

test('P03 independent root-startup-receipt.v2 proves Luna/low/normal actuals', async () => {
    const module = await runtime()
    const verifyRootStartup = module.verifyRootStartup
    assert.equal(typeof verifyRootStartup, 'function')
    const result = await verifyRootStartup(rootStartupInput())
    assert.deepEqual(result.rootStartupReceipt, {
        ...result.rootStartupReceipt,
        schema: 'issue-orchestration.root-startup-receipt.v2',
        stageRole: 'root-scheduler',
        actualModel: 'gpt-5.6-luna',
        actualEffort: 'low',
        actualMode: 'normal',
        verificationStatus: 'verified',
        mismatchReasons: []
    })
    assert.equal(result.rootStartupReceipt.receiptDigest,
        digest({ ...result.rootStartupReceipt, receiptDigest: undefined }))
})

test('P04 unobservable actual metadata cannot be marked verified', async () => {
    const module = await runtime()
    const request = await module.sealDispatchRequest(await requestInput())
    const evidence = dispatchEvidence(request)
    delete evidence.rolloutRecords[1].payload.model
    delete evidence.rolloutRecords[1].payload.effort
    const result = await module.verifyRuntimeDispatch({
        request,
        ...evidence,
        priorReceipts: []
    })
    assert.equal(result.dispatchReceipt.verificationStatus, 'capability-unverified')
    assert.ok(result.dispatchReceipt.mismatchReasons.includes(
        'runtime-model-unobservable'))
    assert.ok(result.dispatchReceipt.mismatchReasons.includes(
        'runtime-effort-unobservable'))
})

test('P05 deterministic routing is recomputed and receipt-bound', async () => {
    const { module: policyModule, route } = await frozenRoute()
    assert.equal(route.selectedProfile, 'terra-max')
    assert.equal(route.selectedProfileReason, 'engineering-risk-high-risk')
    const module = await runtime()
    const request = await module.sealDispatchRequest(await requestInput())
    const { dispatchReceipt } = await module.verifyRuntimeDispatch({
        request,
        ...dispatchEvidence(request),
        priorReceipts: []
    })
    assert.equal(dispatchReceipt.policyVersion, policyModule.ROUTING_POLICY_VERSION)
    assert.equal(dispatchReceipt.routingInputDigest, route.routingInputDigest)
    assert.equal(dispatchReceipt.selectedProfileId, route.selectedProfile)
})

test('P06 ordinary serial receipt binds exact scope and dependency identity', async () => {
    const { request, dispatchReceipt } = await verifiedDispatch()
    assert.equal(request.groupId, null)
    for (const field of [
        'groupSessionDigest', 'activeWriteLeaseId', 'groupWorktreeIdentity',
        'groupBranchIdentity', 'testOwnerContinuityIdentity',
        'implementerContinuityIdentity'
    ]) assert.equal(request[field], null, field)
    assert.equal(dispatchReceipt.memberIssueId, issueId)
    assert.equal(dispatchReceipt.scopeIdentityDigest, request.scopeIdentityDigest)
    assert.equal(dispatchReceipt.dependencyIdentityDigest,
        digest(contract.dependencyBindings))
})

test('P07 implementer-self-test-receipt.v2 binds route and frozen evidence', async () => {
    const { module, request, dispatchReceipt } = await verifiedDispatch()
    const receipt = await module.verifyImplementerSelfTest({
        request,
        dispatchReceipt,
        contract,
        execution: selfTestExecution(request),
        priorReceipts: []
    })
    assert.equal(
        receipt.schema,
        'issue-orchestration.implementer-self-test-receipt.v2'
    )
    assert.equal(receipt.verificationStatus, 'verified')
    assert.equal(receipt.stageProfileId, request.stageProfileId)
    assert.equal(receipt.routingInputDigest, request.routingInputDigest)
    assert.equal(receipt.baseSha, request.baseSha)
    assert.equal(receipt.frozenTestContractDigest, contract.testContractDigest)
    assert.equal(receipt.fixCycleCount, 1)
    assert.deepEqual(receipt.remainingFailures, [])
})

test('P08 v1 receipts are readable history but cannot authorize v2 transitions', async () => {
    const module = await runtime()
    const historical = JSON.parse(JSON.stringify({
        schema: 'issue-orchestration.dispatch-receipt.v1',
        verificationStatus: 'verified'
    }))
    await assertThrownCode(
        () => module.authorizeReceiptTransition({
            eventType: 'implementation.started',
            transitionSchema: 'issue-orchestration.transition.v2',
            dispatchReceipt: historical
        }),
        'receipt-v1-historical-only',
        'P08'
    )
})

test('P09 behavior-green requires the fresh read-only verifier v2 receipt', async () => {
    const module = await runtime()
    await module.authorizeReceiptTransition({
        eventType: 'independent-verification.passed',
        transitionSchema: 'issue-orchestration.transition.v2',
        candidateSha: baseSha,
        dispatchReceipt: verifiedV2DispatchReceipt(),
        behaviorReceipt: behaviorReceipt()
    })
})

async function runControl(control) {
    const module = await runtime()
    if (control.id === 'N01-root-actual-sol-low') {
        const input = rootStartupInput()
        input.rolloutRecords[0].payload.model = 'gpt-5.6-sol'
        input.rolloutRecords[1].payload.model = 'gpt-5.6-sol'
        assertRejectedReason(await module.verifyRootStartup(input),
            control.expectedCode, control.id)
        return
    }
    if (control.id === 'N08-root-runtime-metadata-unobservable') {
        const input = rootStartupInput()
        for (const record of input.rolloutRecords) {
            delete record.payload.model
            delete record.payload.effort
        }
        assertRejectedReason(await module.verifyRootStartup(input),
            control.expectedCode, control.id)
        return
    }
    if (control.id === 'N10-behavior-verifier-not-fresh') {
        await assertThrownCode(
            () => module.authorizeReceiptTransition({
                eventType: 'independent-verification.passed',
                transitionSchema: 'issue-orchestration.transition.v2',
                candidateSha: baseSha,
                dispatchReceipt: verifiedV2DispatchReceipt(),
                behaviorReceipt: behaviorReceipt({ fresh: false })
            }),
            control.expectedCode,
            control.id
        )
        return
    }
    if (control.id === 'N11-self-test-signs-behavior-green') {
        await assertThrownCode(
            () => module.authorizeReceiptTransition({
                eventType: 'independent-verification.passed',
                transitionSchema: 'issue-orchestration.transition.v2',
                candidateSha: baseSha,
                dispatchReceipt: verifiedV2DispatchReceipt(),
                behaviorReceipt: behaviorReceipt({ selfTest: true })
            }),
            control.expectedCode,
            control.id
        )
        return
    }
    if (control.id === 'N13-v1-dispatch-transition-authority') {
        await assertThrownCode(
            () => module.authorizeReceiptTransition({
                eventType: 'implementation.started',
                transitionSchema: 'issue-orchestration.transition.v2',
                dispatchReceipt: {
                    schema: 'issue-orchestration.dispatch-receipt.v1',
                    verificationStatus: 'verified'
                }
            }),
            control.expectedCode,
            control.id
        )
        return
    }
    if (control.id === 'N14-v1-self-test-transition-authority') {
        await assertThrownCode(
            () => module.authorizeReceiptTransition({
                eventType: 'implementation.candidate-green',
                transitionSchema: 'issue-orchestration.transition.v2',
                candidateSha: baseSha,
                dispatchReceipt: verifiedV2DispatchReceipt(),
                selfTestReceipt: {
                    schema: 'issue-orchestration.implementer-self-test-receipt.v1',
                    verificationStatus: 'verified'
                }
            }),
            control.expectedCode,
            control.id
        )
        return
    }
    if (control.id === 'N22-frozen-test-tree-drift') {
        const { request, dispatchReceipt } = await verifiedDispatch()
        const execution = selfTestExecution(request)
        execution.frozenTestTreeDigestAfter = hash('0')
        const result = await module.verifyImplementerSelfTest({
            request,
            dispatchReceipt,
            contract,
            execution,
            priorReceipts: []
        })
        assertRejectedReason(result, control.expectedCode, control.id)
        return
    }
    let input
    if (['N04-ui-prescribed-forbidden-family',
        'N05-ui-implementer-sol-high',
        'N06-ui-dispute-bypasses-adjudicator'].includes(control.id)) {
        input = await requestInput({
            stageRole: 'ui-ux-implementer',
            routingClassification: {
                domain: 'ui-ux',
                engineeringRiskClass: 'bounded',
                uiDecisionClass: control.id === 'N06-ui-dispute-bypasses-adjudicator'
                    ? 'layout-judgment'
                    : 'prescribed',
                verificationClass: 'ux-local'
            },
            requiredSkills: [
                { id: 'fsusblog-design-conformance', digest: hash('a') },
                { id: 'fsusui-design-conformance', digest: hash('b') }
            ],
            uiImpact: true
        })
    } else if (control.id === 'N21-runtime-skill-digest-drift') {
        input = await requestInput({
            requiredSkills: [
                { id: 'issue-orchestration', digest: hash('a') }
            ]
        })
    } else input = await requestInput()
    if (control.id === 'N02-bounded-terra-without-reclassification') {
        input.routingClassification.engineeringRiskClass = 'bounded'
    }
    if (control.id === 'N03-high-risk-luna') {
        input.stageProfileId = 'luna-max'
        input.selectedProfileId = 'luna-max'
        input.requestedModel = 'gpt-5.6-luna'
    }
    if (control.id === 'N04-ui-prescribed-forbidden-family') {
        input.stageProfileId = 'luna-max'
        input.selectedProfileId = 'luna-max'
        input.requestedModel = 'gpt-5.6-luna'
        input.requestedEffort = 'max'
    }
    if (control.id === 'N05-ui-implementer-sol-high') {
        input.stageProfileId = 'sol-high'
        input.selectedProfileId = 'sol-high'
        input.requestedModel = 'gpt-5.6-sol'
        input.requestedEffort = 'high'
    }
    if (control.id === 'N06-ui-dispute-bypasses-adjudicator') {
        input.routingClassification.uiDecisionClass = 'system-design-dispute'
        input.adjudicationReceiptDigest = null
    }
    if (control.id === 'N07-root-balance-model-substitution') {
        input.routingOverride = {
            selectedByRole: 'root-scheduler',
            reason: 'balance'
        }
    }
    if (control.id === 'N09-group-member-inherits-previous-route') {
        input.groupId = 'group-1832-negative'
        input.groupSessionDigest = hash('a')
        input.activeWriteLeaseId = 'lease-previous-member'
        input.groupWorktreeIdentity = hash('b')
        input.groupBranchIdentity = hash('c')
        input.testOwnerContinuityIdentity = hash('d')
        input.implementerContinuityIdentity = hash('e')
        input.previousMemberRoutingReceiptDigest = input.routingInputDigest
    }
    if (control.id === 'N12-old-policy-digest-replay') {
        input.routingPolicyDigest = hash('0')
    }
    if (control.id === 'N16-root-direct-profile-selection') {
        input.selectedByRole = 'root-scheduler'
    }
    if (control.id === 'N19-non-group-id-omitted') delete input.groupId
    if (['N02-bounded-terra-without-reclassification',
        'N03-high-risk-luna',
        'N04-ui-prescribed-forbidden-family',
        'N05-ui-implementer-sol-high',
        'N06-ui-dispute-bypasses-adjudicator',
        'N07-root-balance-model-substitution',
        'N09-group-member-inherits-previous-route',
        'N12-old-policy-digest-replay',
        'N16-root-direct-profile-selection',
        'N19-non-group-id-omitted'].includes(control.id)) {
        await assertThrownCode(
            () => module.sealDispatchRequest(input),
            control.expectedCode,
            control.id
        )
        return
    }
    const request = await module.sealDispatchRequest(input)
    const evidence = dispatchEvidence(request)
    if (control.id === 'N15-unavailable-profile-silent-fallback') {
        evidence.machineObservations[3].available = false
        evidence.machineObservations[3].effectiveProfileId = 'sol-high'
        evidence.machineObservations[3].observationDigest =
            digest({ ...evidence.machineObservations[3], observationDigest: undefined })
    }
    if (control.id === 'N17-scope-identity-drift') {
        evidence.machineObservations[0].scopeIdentityDigest = hash('0')
        evidence.machineObservations[0].observationDigest =
            digest({ ...evidence.machineObservations[0], observationDigest: undefined })
    }
    if (control.id === 'N18-dependency-identity-drift') {
        evidence.machineObservations[0].dependencyIdentityDigest = hash('0')
        evidence.machineObservations[0].observationDigest =
            digest({ ...evidence.machineObservations[0], observationDigest: undefined })
    }
    if (control.id === 'N20-receipt-replay-new-base-candidate') {
        const replay = {
            ...verifiedV2DispatchReceipt(request),
            baseSha: '0'.repeat(40),
            candidateSha: '1'.repeat(40)
        }
        replay.receiptDigest = digest({
            ...replay,
            receiptDigest: undefined
        })
        evidence.priorReceipts = [replay]
    }
    if (control.id === 'N21-runtime-skill-digest-drift') {
        evidence.machineObservations[2].loadedSkills = [
            { id: 'issue-orchestration', digest: hash('b') }
        ]
        evidence.machineObservations[2].observationDigest =
            digest({ ...evidence.machineObservations[2], observationDigest: undefined })
    }
    const result = await module.verifyRuntimeDispatch({
        request,
        ...evidence,
        priorReceipts: evidence.priorReceipts ?? []
    })
    assertRejectedReason(result, control.expectedCode, control.id)
}

for (const control of controls) {
    test(`${control.id} ${control.requirement}`, async () => {
        await runControl(control)
    })
}
