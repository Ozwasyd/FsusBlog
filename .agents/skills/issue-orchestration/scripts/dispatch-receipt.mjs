#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const REQUIRED_REQUEST_FIELDS = [
    'schema', 'requestId', 'runId', 'nodeId', 'attemptId', 'role', 'stageRole',
    'requestedByRole', 'promptDigest', 'sourceDagDigest', 'frontierDigest',
    'issueSnapshotFingerprint', 'repositoryFingerprint', 'repository', 'baseSha',
    'candidateSha', 'candidateDigest', 'requestedModel', 'requestedEffort',
    'requestedSandbox', 'requestedForkTurns', 'requestedWorkingDirectory',
    'stageProfileDigest', 'testOwnerId', 'testContractDigest', 'epochId',
    'requiredSkills', 'designAuthorityDigests', 'uiImpact', 'behaviorReceiptDigest',
    'uxAcceptanceReceiptDigest', 'documentationReceiptDigest', 'allowedPathsDigest',
    'forbiddenPathsDigest', 'writePolicy', 'groupId', 'groupSessionDigest',
    'memberIssueId', 'memberStage', 'activeWriteLeaseId', 'groupWorktreeIdentity',
    'groupBranchIdentity', 'testOwnerContinuityIdentity',
    'implementerContinuityIdentity', 'freshVerificationRollout',
    'memberTestContractDigest', 'memberCandidateIdentity', 'createdAt'
]

class ReceiptError extends Error {
    constructor(code, message = code) {
        super(message)
        this.code = code
    }
}

function fail(code) {
    throw new ReceiptError(code)
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    return createHash('sha256')
        .update(typeof value === 'string' ? value : JSON.stringify(canonical(value)))
        .digest('hex')
}

function unsignedDigest(value, digestField) {
    const unsigned = { ...value }
    delete unsigned[digestField]
    return digest(unsigned)
}

function containsSecret(value) {
    if (Array.isArray(value)) return value.some(containsSecret)
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, child]) =>
        /(?:secret|token|password|credential|api[-_]?key|authorization)/iu.test(key) ||
        containsSecret(child))
}

function unique(values) {
    return [...new Set(values)]
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value)
}

function observationByKind(observations, kind) {
    return observations.find((item) => item?.kind === kind)
}

function trustworthyObservation(item) {
    const trustedSources = new Set([
        'runtime-rollout', 'machine-git-observation', 'runtime-skill-loader',
        'machine-lease-registry'
    ])
    return item && trustedSources.has(item.source) &&
        item.observationDigest === unsignedDigest(item, 'observationDigest')
}

export async function sealDispatchRequest(input) {
    if (containsSecret(input)) fail('dispatch-secret-material')
    for (const field of REQUIRED_REQUEST_FIELDS) {
        if (!Object.hasOwn(input, field)) fail(
            field === 'groupId' ? 'dispatch-group-identity-missing' : 'dispatch-request-field-missing'
        )
    }
    if (input.schema !== 'issue-orchestration.dispatch-request.v1') {
        fail('dispatch-request-field-missing')
    }
    if (!SHA.test(input.baseSha ?? '')) fail('dispatch-request-base-sha')
    const profiles = {
        'root-scheduler': ['gpt-5.6-sol', 'low', 'read-only', 'external-state-root-only'],
        'dag-creator-updater': ['gpt-5.6-sol', 'max', 'read-only', 'read-only'],
        'test-owner': ['gpt-5.6-sol', 'max', 'workspace-write',
            'test-owner-scoped-write-lease'],
        'code-implementer': ['gpt-5.6-sol', 'low', 'workspace-write',
            'stage-scoped-write-lease'],
        'ui-ux-implementer': ['gpt-5.6-sol', 'low', 'workspace-write',
            'stage-scoped-write-lease'],
        'ux-acceptance-verifier': ['gpt-5.6-sol', 'max', 'read-only', 'read-only']
    }
    const expectedProfile = profiles[input.stageRole]
    if (expectedProfile && [input.requestedModel, input.requestedEffort,
        input.requestedSandbox, input.writePolicy].some((value, index) =>
        value !== expectedProfile[index])) {
        fail(input.stageRole === 'root-scheduler'
            ? 'dispatch-root-profile-policy'
            : 'dispatch-stage-profile-policy')
    }
    if (input.stageRole === 'ui-ux-implementer' && input.repository === 'Ozwasyd/FsusBlog') {
        const expectedSkills = ['fsusblog-design-conformance', 'fsusui-design-conformance']
        const actualSkills = input.requiredSkills.map(({ id }) => id)
        const skillDigests = input.requiredSkills.map(({ digest: value }) => value)
        if (JSON.stringify(actualSkills) !== JSON.stringify(expectedSkills) ||
            JSON.stringify(input.designAuthorityDigests) !== JSON.stringify(skillDigests) ||
            skillDigests.some((value) => !HASH.test(value))) {
            fail('dispatch-ui-design-authority-policy')
        }
    }
    if (input.stageRole === 'dag-creator-updater' &&
        input.requestedByRole !== 'root-scheduler') fail('dispatch-stage-profile-policy')
    if (input.requestDigest && input.requestDigest !== unsignedDigest(input, 'requestDigest')) {
        fail('dispatch-request-digest')
    }
    const request = structuredClone(input)
    delete request.requestDigest
    request.requestDigest = digest(request)
    return deepFreeze(request)
}

function observeRuntime(request, rolloutRecords, machineObservations) {
    const session = rolloutRecords.find((item) => item?.type === 'session_meta')?.payload
    const contexts = rolloutRecords.filter((item) => item?.type === 'turn_context').map((item) => item.payload)
    const context = contexts[0] ?? {}
    const spawn = session?.source?.subagent?.thread_spawn ?? {}
    const dispatch = observationByKind(machineObservations, 'dispatch-context')
    const git = observationByKind(machineObservations, 'git-worktree-identity')
    const skill = observationByKind(machineObservations, 'skill-loader')
    const lease = observationByKind(machineObservations, 'group-member-lease')
    const sandbox = context.sandbox_policy?.type
    return {
        schema: 'issue-orchestration.runtime-observation.v1',
        threadId: session?.session_id,
        rolloutId: session?.id,
        startedAt: rolloutRecords[0]?.timestamp,
        effectiveModel: context.model,
        effectiveEffort: context.effort,
        effectiveRole: spawn.agent_role,
        effectiveSandbox: sandbox,
        effectiveForkTurns: spawn.fork_turns,
        effectiveWorkingDirectory: context.cwd,
        loadedSkills: skill?.loadedSkills,
        skillLoadProvenance: skill?.source,
        session,
        contexts,
        dispatch,
        git,
        skill,
        lease,
        provenanceTrusted: [dispatch, git, skill, lease].every(trustworthyObservation)
    }
}

function compareRuntime(request, observed, priorReceipts) {
    const reasons = []
    const missing = [
        ['threadId', 'runtime-thread-id-unobservable'],
        ['rolloutId', 'runtime-rollout-id-unobservable'],
        ['startedAt', 'runtime-started-at-unobservable'],
        ['effectiveModel', 'runtime-model-unobservable'],
        ['effectiveEffort', 'runtime-effort-unobservable'],
        ['effectiveRole', 'runtime-role-unobservable'],
        ['effectiveSandbox', 'runtime-sandbox-unobservable'],
        ['effectiveForkTurns', 'runtime-fork-unobservable'],
        ['effectiveWorkingDirectory', 'runtime-working-directory-unobservable']
    ]
    for (const [field, reason] of missing) if (!observed[field]) reasons.push(reason)
    if (!observed.skill) reasons.push('runtime-skill-load-unobservable')
    if (observed.effectiveModel && observed.effectiveModel !== request.requestedModel) {
        reasons.push('runtime-model-mismatch')
    }
    if (observed.effectiveEffort && observed.effectiveEffort !== request.requestedEffort) {
        reasons.push('runtime-effort-mismatch')
    }
    if (observed.effectiveRole && observed.effectiveRole !== request.stageRole) {
        reasons.push('runtime-role-mismatch')
    }
    if (observed.effectiveSandbox && observed.effectiveSandbox !== request.requestedSandbox) {
        reasons.push('runtime-sandbox-role-policy')
    }
    if (observed.effectiveForkTurns === 'all') reasons.push('runtime-full-history-fork')
    else if (observed.effectiveForkTurns &&
        observed.effectiveForkTurns !== request.requestedForkTurns) {
        reasons.push('runtime-fork-mismatch')
    }
    if (observed.effectiveWorkingDirectory &&
        observed.effectiveWorkingDirectory !== request.requestedWorkingDirectory) {
        reasons.push('runtime-working-directory-mismatch')
    }
    if (new Set(observed.contexts.map(({ effort }) => effort)).size > 1) {
        reasons.push('runtime-context-drift')
    }
    if (new Set(observed.contexts.map(({ sandbox_policy: policy }) => JSON.stringify(policy))).size > 1) {
        reasons.push('runtime-sandbox-drift')
    }
    const pairs = [
        [observed.dispatch?.promptDigest, request.promptDigest, 'runtime-prompt-digest-mismatch'],
        [observed.git?.baseSha, request.baseSha, 'runtime-base-sha-mismatch'],
        [observed.dispatch?.sourceDagDigest, request.sourceDagDigest, 'runtime-source-dag-digest-mismatch'],
        [observed.dispatch?.frontierDigest, request.frontierDigest, 'runtime-frontier-digest-mismatch'],
        [observed.dispatch?.stageProfileDigest, request.stageProfileDigest,
            'runtime-stage-profile-digest-mismatch'],
        [observed.dispatch?.testContractDigest, request.testContractDigest,
            'runtime-test-contract-digest-mismatch'],
        [observed.dispatch?.requestId, request.requestId, 'runtime-request-id-mismatch'],
        [observed.dispatch?.epochId, request.epochId, 'runtime-epoch-id-mismatch'],
        [observed.git?.candidateSha, request.candidateSha, 'runtime-candidate-identity-mismatch'],
        [observed.git?.candidateDigest, request.candidateDigest,
            'runtime-candidate-identity-mismatch']
    ]
    for (const [actual, expected, reason] of pairs) if (actual !== expected) reasons.push(reason)
    if (!observed.provenanceTrusted) reasons.push('runtime-provenance-request-copy')
    if (observed.skill?.source === 'agent-self-report') {
        reasons.push('runtime-skill-observation-untrusted')
    }
    if (request.stageRole === 'test-owner' && observed.contexts[0]?.sandbox_policy) {
        const expectedRoots = [
            `${request.requestedWorkingDirectory}/tests/tools`,
            `${request.requestedWorkingDirectory}/tests/fixtures/issue-orchestration`
        ]
        if (JSON.stringify(observed.contexts[0].sandbox_policy.writable_roots) !==
            JSON.stringify(expectedRoots)) reasons.push('runtime-test-owner-write-boundary')
    }
    if (observed.skill) {
        const loaded = new Map((observed.loadedSkills ?? []).map((item) => [item.id, item.digest]))
        for (const requirement of request.requiredSkills) {
            if (!loaded.has(requirement.id)) reasons.push('runtime-required-skill-missing')
            else if (loaded.get(requirement.id) !== requirement.digest) {
                reasons.push('runtime-skill-digest-mismatch')
            }
        }
    }
    if (priorReceipts.some((item) =>
        item.verificationStatus === 'verified' && item.threadId === observed.threadId &&
        item.requestId !== request.requestId)) reasons.push('runtime-thread-identity-reused')
    if (priorReceipts.some((item) =>
        item.verificationStatus === 'verified' && item.requestDigest === request.requestDigest &&
        item.attemptId !== request.attemptId)) reasons.push('dispatch-request-replay')
    const lease = observed.lease ?? {}
    if (request.groupId !== null) {
        const groupPairs = [
            [lease.groupId, request.groupId, 'runtime-group-id-mismatch'],
            [lease.groupSessionDigest, request.groupSessionDigest,
                'runtime-group-session-mismatch'],
            [lease.memberIssueId, request.memberIssueId, 'runtime-group-member-mismatch'],
            [lease.memberStage, request.memberStage, 'runtime-group-member-stage-mismatch'],
            [lease.memberTestContractDigest, request.memberTestContractDigest,
                'runtime-member-test-contract-mismatch'],
            [lease.activeWriteLeaseId, request.activeWriteLeaseId, 'runtime-write-lease-mismatch'],
            [observed.git?.worktreeIdentity, request.groupWorktreeIdentity,
                'runtime-group-worktree-mismatch'],
            [observed.git?.branchIdentity, request.groupBranchIdentity,
                'runtime-group-branch-mismatch'],
            [lease.memberCandidateIdentity, request.memberCandidateIdentity,
                'runtime-member-candidate-mismatch'],
            [lease.testOwnerContinuityIdentity, request.testOwnerContinuityIdentity,
                'runtime-test-owner-continuity-mismatch'],
            [lease.implementerContinuityIdentity, request.implementerContinuityIdentity,
                'runtime-implementer-continuity-mismatch']
        ]
        for (const [actual, expected, reason] of groupPairs) if (actual !== expected) reasons.push(reason)
        const owners = lease.activeLeaseOwners ?? []
        if (owners.filter((item) => item.leaseId === request.activeWriteLeaseId).length !== 1) {
            reasons.push('runtime-write-lease-conflict')
        }
    }
    if (request.freshVerificationRollout && lease.freshVerificationRollout !== true) {
        reasons.push('runtime-verification-not-fresh')
    }
    return unique(reasons)
}

export async function verifyRuntimeDispatch(input) {
    if (containsSecret(input.extraMetadata) || containsSecret(input.machineObservations)) {
        return rejectedDispatch(input.request, null, ['dispatch-secret-material'])
    }
    const runtimeObservation = observeRuntime(
        input.request,
        input.rolloutRecords ?? [],
        input.machineObservations ?? []
    )
    const reasons = compareRuntime(input.request, runtimeObservation, input.priorReceipts ?? [])
    const runtimeMetadataDigest = digest(runtimeObservation)
    if (input.claimedRuntimeMetadataDigest &&
        input.claimedRuntimeMetadataDigest !== runtimeMetadataDigest) reasons.push('runtime-metadata-digest')
    if (input.replayReceiptDigest && (input.priorReceipts ?? []).some((item) =>
        item.receiptDigest === input.replayReceiptDigest && item.epochId !== input.request.epochId)) {
        reasons.push('dispatch-receipt-replay')
    }
    const capabilityReasons = reasons.filter((reason) =>
        reason.endsWith('-unobservable') || reason === 'runtime-provenance-request-copy')
    const verificationStatus = reasons.length === 0
        ? 'verified'
        : capabilityReasons.length === reasons.length ? 'capability-unverified' : 'rejected'
    const dispatchReceipt = {
        schema: 'issue-orchestration.dispatch-receipt.v1',
        requestId: input.request.requestId,
        requestDigest: input.request.requestDigest,
        attemptId: input.request.attemptId,
        epochId: input.request.epochId,
        threadId: runtimeObservation.threadId,
        rolloutId: runtimeObservation.rolloutId,
        runtimeMetadataDigest,
        verificationStatus,
        mismatchReasons: unique(reasons)
    }
    dispatchReceipt.receiptDigest = digest(dispatchReceipt)
    return { runtimeObservation, dispatchReceipt }
}

function rejectedDispatch(request, runtimeObservation, reasons) {
    return {
        runtimeObservation,
        dispatchReceipt: {
            schema: 'issue-orchestration.dispatch-receipt.v1',
            requestId: request.requestId,
            verificationStatus: 'rejected',
            mismatchReasons: reasons
        }
    }
}

export async function verifyImplementerSelfTest({ request, dispatchReceipt, contract, execution }) {
    const reasons = []
    const expectedCommands = contract.visibleTestMatrix
    if (execution.commandResults?.length !== expectedCommands.length ||
        expectedCommands.some((item, index) =>
            JSON.stringify(execution.commandResults?.[index]?.command) !== JSON.stringify(item.command) ||
            execution.commandResults?.[index]?.id !== item.id ||
            execution.commandResults?.[index]?.exitStatus !== 0 ||
            !HASH.test(execution.commandResults?.[index]?.resultDigest ?? ''))) {
        reasons.push('self-test-visible-matrix-incomplete')
    }
    if (execution.visibleTestMatrixDigest !== contract.visibleTestMatrixDigest) {
        reasons.push('self-test-visible-matrix-incomplete')
    }
    if (execution.frozenTestTreeDigestBefore !== contract.frozenTestTree.digest ||
        execution.frozenTestTreeDigestAfter !== contract.frozenTestTree.digest ||
        execution.frozenTestTreeDigestBefore !== execution.frozenTestTreeDigestAfter) {
        reasons.push('self-test-frozen-tree-drift')
    }
    if (!execution.failureHistory?.some((item) =>
        execution.firstFailureRefs?.includes(item.ref) && item.outcome === 'failed')) {
        reasons.push('self-test-command-history-incomplete')
    }
    if (execution.commandResults?.some((item) => item.skipped)) reasons.push('self-test-command-skipped')
    if (!SHA.test(execution.candidateSha ?? '') || execution.candidateSha === '0'.repeat(40)) {
        reasons.push('self-test-candidate-mismatch')
    }
    if (execution.baseSha !== request.baseSha) reasons.push('self-test-base-mismatch')
    if (execution.requestDigest !== request.requestDigest) reasons.push('self-test-request-mismatch')
    if (execution.runId !== request.runId || execution.nodeId !== request.nodeId ||
        execution.attemptId !== request.attemptId || execution.stageRole !== request.stageRole ||
        execution.frozenTestContractDigest !== contract.testContractDigest) {
        reasons.push('self-test-request-mismatch')
    }
    if (execution.remainingFailures?.length) reasons.push('self-test-remaining-failures')
    if (Object.values(execution.lintTypecheckBuildResults ?? {}).includes('failed')) {
        reasons.push('self-test-quality-gate-failed')
    }
    if (execution.firstFailureRefs?.[0] !== execution.failureHistory?.[0]?.ref) {
        reasons.push('self-test-first-failure-lost')
    }
    if (execution.workingTreeStatusDigest !== execution.observedWorkingTreeStatusDigest) {
        reasons.push('self-test-working-tree-drift')
    }
    if (!HASH.test(execution.implementationDiffDigest ?? '')) {
        reasons.push('self-test-implementation-diff-missing')
    }
    if (execution.modifiedPaths?.some((item) => item.startsWith('tests/'))) {
        reasons.push('self-test-frozen-path-modified')
    }
    if (execution.verifierRole !== 'deterministic-machine') reasons.push('self-test-verifier-authority')
    if (dispatchReceipt.schema !== 'issue-orchestration.dispatch-receipt.v1' ||
        dispatchReceipt.verificationStatus !== 'verified' ||
        dispatchReceipt.requestId !== request.requestId ||
        dispatchReceipt.requestDigest !== request.requestDigest ||
        dispatchReceipt.attemptId !== request.attemptId ||
        dispatchReceipt.epochId !== request.epochId ||
        dispatchReceipt.receiptDigest !== unsignedDigest(dispatchReceipt, 'receiptDigest')) {
        reasons.push('verified-dispatch-receipt-required')
    }
    const receipt = {
        schema: 'issue-orchestration.implementer-self-test-receipt.v1',
        verificationStatus: reasons.length ? 'rejected' : 'verified',
        mismatchReasons: unique(reasons),
        requestDigest: request.requestDigest,
        requestId: request.requestId,
        attemptId: request.attemptId,
        epochId: request.epochId,
        candidateSha: execution.candidateSha,
        visibleTestMatrixDigest: execution.visibleTestMatrixDigest,
        frozenTestTreeDigestBefore: execution.frozenTestTreeDigestBefore,
        frozenTestTreeDigestAfter: execution.frozenTestTreeDigestAfter,
        implementationDiffDigest: execution.implementationDiffDigest,
        commandResults: structuredClone(execution.commandResults),
        firstFailureRefs: structuredClone(execution.firstFailureRefs),
        failureHistory: structuredClone(execution.failureHistory)
    }
    receipt.receiptDigest = digest(receipt)
    return receipt
}

export async function authorizeReceiptTransition(input) {
    if (!input.dispatchReceipt ||
        input.dispatchReceipt.schema !== 'issue-orchestration.dispatch-receipt.v1' ||
        input.dispatchReceipt.verificationStatus !== 'verified') {
        fail('verified-dispatch-receipt-required')
    }
    if (input.eventType === 'implementation.candidate-green') {
        if (!input.selfTestReceipt) fail('verified-self-test-receipt-required')
        if (input.selfTestReceipt.schema !==
            'issue-orchestration.implementer-self-test-receipt.v1') {
            fail('receipt-schema-stage-mismatch')
        }
        if (input.selfTestReceipt.verificationStatus !== 'verified') {
            fail('verified-self-test-receipt-required')
        }
        if (input.request && (
            input.selfTestReceipt.candidateSha !== input.candidateSha ||
            input.selfTestReceipt.requestDigest !== input.request.requestDigest ||
            input.selfTestReceipt.requestId !== input.request.requestId ||
            input.selfTestReceipt.attemptId !== input.request.attemptId ||
            input.selfTestReceipt.epochId !== input.request.epochId
        )) fail('self-test-candidate-mismatch')
    }
    if (input.eventType === 'independent-verification.passed') {
        const receipt = input.behaviorReceipt
        if (!receipt || receipt.schema !== 'issue-orchestration.behavior-receipt.v1' ||
            receipt.verificationStatus !== 'verified') {
            fail('independent-behavior-receipt-required')
        }
    }
    return true
}

async function runCli(argv) {
    if (argv[0] !== 'verify-runtime') fail('dispatch-cli-command')
    const options = {}
    for (let index = 1; index < argv.length; index += 2) {
        if (!argv[index]?.startsWith('--') || !argv[index + 1]) fail('dispatch-cli-arguments')
        options[argv[index].slice(2)] = argv[index + 1]
    }
    for (const field of ['request', 'rollout', 'machine-observations']) {
        if (!options[field]) fail('dispatch-cli-arguments')
    }
    const request = JSON.parse(fs.readFileSync(options.request, 'utf8'))
    const rolloutRecords = fs.readFileSync(options.rollout, 'utf8').split('\n')
        .filter(Boolean).map((line) => JSON.parse(line))
    const observations = JSON.parse(fs.readFileSync(options['machine-observations'], 'utf8'))
    const result = await verifyRuntimeDispatch({
        request: await sealDispatchRequest(request),
        rolloutRecords,
        machineObservations: observations.machineObservations ?? observations,
        priorReceipts: observations.priorReceipts ?? []
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.dispatchReceipt.verificationStatus !== 'verified') process.exitCode = 1
}

if (process.argv[1] && import.meta.url.split('?')[0] === pathToFileURL(process.argv[1]).href) {
    runCli(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${error.code ?? error.name}: ${error.message}\n`)
        process.exitCode = 1
    })
}
