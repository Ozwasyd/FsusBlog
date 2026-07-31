import { createHash } from 'node:crypto'

const REASON_ORDER = [
    'dependency-unsatisfied',
    'investigation-incomplete',
    'owner-unresolved',
    'base-drift',
    'scope-drift',
    'active-attempt',
    'terminal-unchanged',
    'runtime-capability-missing',
    'delivery-frozen',
    'exclusive-lease-held',
    'remote-facts-stale'
]

const STAGES = [
    ['testContract', 'test-contract-ready'],
    ['implementation', 'implementation-ready'],
    ['behavior', 'behavior-verification-ready'],
    ['uxAcceptance', 'ux-acceptance-ready'],
    ['documentation', 'documentation-ready'],
    ['delivery', 'delivery-ready'],
    ['cleanup', 'cleanup-ready']
]

class FrontierError extends Error {
    constructor(code, message) {
        super(message)
        this.name = 'FrontierError'
        this.code = code
    }
}

function fail(code, message) {
    throw new FrontierError(code, message)
}

function canonical(value) {
    if (Array.isArray(value)) {
        return value
            .map(canonical)
            .sort((left, right) =>
                JSON.stringify(left).localeCompare(JSON.stringify(right))
            )
    }
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    )
}

function digest(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex')
}

function evidence(identity, value) {
    return value === undefined
        ? { identity }
        : { identity, digest: digest(value) }
}

function stageFor(node, state) {
    const stages = node.surface === 'ui-ux'
        ? STAGES
        : STAGES.filter(([, stage]) => stage !== 'ux-acceptance-ready')
    for (const [receipt, stage] of stages) {
        if (state.receipts?.[receipt]?.status !== 'passed') return stage
    }
    return null
}

function expectedCandidate(node, stage) {
    if (stage === 'test-contract-ready') {
        return {
            role: 'test-owner',
            model: 'gpt-5.6-sol',
            effort: 'max',
            mode: 'write-tests-only',
            allowedPaths: node.allowedTestPaths
        }
    }
    if (stage === 'implementation-ready') {
        return {
            role: node.surface === 'ui-ux'
                ? 'ui-ux-implementer'
                : 'code-implementer',
            model: 'gpt-5.6-sol',
            effort: 'low',
            mode: 'write-implementation-only',
            allowedPaths: node.allowedImplementationPaths,
            designAuthorityRequired: node.surface === 'ui-ux'
        }
    }
    if (stage === 'behavior-verification-ready') {
        return {
            role: 'test-owner',
            model: 'gpt-5.6-sol',
            effort: 'max',
            mode: 'read-execute-only',
            allowedPaths: []
        }
    }
    if (stage === 'ux-acceptance-ready') {
        return {
            role: 'ux-acceptance-verifier',
            model: 'gpt-5.6-sol',
            effort: 'max',
            mode: 'read-only',
            allowedPaths: [],
            designAuthorityRequired: true
        }
    }
    if (stage === 'documentation-ready') {
        return {
            role: 'documentation-writer',
            model: 'gpt-5.6-luna',
            effort: 'xhigh',
            mode: 'write-docs-only',
            allowedPaths: [`docs/frontier-${node.issueNumber}.md`]
        }
    }
    return {
        role: 'root-scheduler',
        model: 'gpt-5.6-sol',
        effort: 'low',
        mode: 'root-only',
        allowedPaths: []
    }
}

function candidateFor(runtimeState, issueId, stage) {
    return runtimeState.candidates?.find(
        (candidate) => candidate.issueId === issueId && candidate.stage === stage
    )
}

function candidateValid(node, candidate, stage) {
    if (!candidate) return false
    const expected = expectedCandidate(node, stage)
    for (const field of ['role', 'model', 'effort', 'mode']) {
        if (candidate[field] !== expected[field]) return false
    }
    if (JSON.stringify(canonical(candidate.allowedPaths ?? []))
        !== JSON.stringify(canonical(expected.allowedPaths ?? []))) return false
    if (expected.designAuthorityRequired) {
        if (!/^[a-f0-9]{64}$/u.test(candidate.designSkillDigest ?? '')) return false
        if (!Array.isArray(candidate.designAuthorityDigests)
            || candidate.designAuthorityDigests.length === 0
            || candidate.designAuthorityDigests.some(
                (value) => !/^[a-f0-9]{64}$/u.test(value)
            )) return false
    }
    return /^[a-f0-9]{64}$/u.test(candidate.capabilityReceiptDigest ?? '')
}

function dependencySatisfied(dependency) {
    return dependency.remoteState === 'CLOSED'
        && dependency.stateReason === 'completed'
        && /^[a-f0-9]{64}$/u.test(dependency.evidenceDigest ?? '')
        && /^[a-f0-9]{40}$/u.test(dependency.deliveredCommit ?? '')
}

export function computeNodeEligibility({ node, dag, runtimeState, selectorReceipt }) {
    const state = runtimeState.nodeStates?.[node.id] ?? { receipts: {}, terminal: null }
    const stage = stageFor(node, state)
    if (!stage) return { issueId: node.id, stage: null, ready: false, reasons: [] }

    const reasons = []
    const activeDependencies = node.activeDependencies ?? []
    const invalidTombstones = (node.satisfiedDependencies ?? [])
        .filter((dependency) => !dependencySatisfied(dependency))
    if (activeDependencies.length > 0 || invalidTombstones.length > 0) {
        reasons.push({
            code: 'dependency-unsatisfied',
            evidence: evidence(
                [...activeDependencies, ...invalidTombstones.map(({ issue }) => issue)]
                    .sort().join(','),
                { activeDependencies, invalidTombstones }
            )
        })
    }
    if (node.investigation?.status !== 'complete') {
        reasons.push({
            code: 'investigation-incomplete',
            evidence: evidence(
                node.investigation?.ownerId ?? node.id,
                node.investigation ?? null
            )
        })
    }
    if (!node.ownerRepository) {
        reasons.push({
            code: 'owner-unresolved',
            evidence: evidence(node.id, { ownerRepository: null })
        })
    }
    const liveBase = runtimeState.repositoryBases?.[node.repository]
    if (liveBase !== node.baseSha) {
        reasons.push({
            code: 'base-drift',
            evidence: evidence(node.repository, { recorded: node.baseSha, live: liveBase })
        })
    }
    if (node.selectorReceiptDigest !== selectorReceipt.receiptDigest
        || node.remoteFactDigest !== selectorReceipt.remoteFactDigests?.[node.id]) {
        reasons.push({
            code: 'scope-drift',
            evidence: evidence(node.id, {
                nodeSelectorReceiptDigest: node.selectorReceiptDigest,
                selectorReceiptDigest: selectorReceipt.receiptDigest,
                nodeRemoteFactDigest: node.remoteFactDigest,
                remoteFactDigest: selectorReceipt.remoteFactDigests?.[node.id]
            })
        })
    }
    const attempts = (runtimeState.activeAttempts ?? []).filter(
        (attempt) => attempt.issueId === node.id && attempt.stage === stage
    )
    if (attempts.length > 0) {
        reasons.push({
            code: 'active-attempt',
            evidence: evidence(attempts[0].attemptId, attempts)
        })
    }
    const terminal = state.terminal
    if (terminal
        && terminal.recoveryFingerprint === terminal.observedRecoveryFingerprint) {
        reasons.push({
            code: 'terminal-unchanged',
            evidence: evidence(terminal.recoveryFingerprint, terminal)
        })
    }
    const candidate = candidateFor(runtimeState, node.id, stage)
    if (!candidateValid(node, candidate, stage)) {
        reasons.push({
            code: 'runtime-capability-missing',
            evidence: evidence(`${node.id}@${stage}`, { candidate, expected: expectedCandidate(node, stage) })
        })
    }
    const freezes = (runtimeState.deliveryFreezes ?? []).filter(
        (freeze) => freeze.issueIds?.includes(node.id)
    )
    if (freezes.length > 0) {
        reasons.push({
            code: 'delivery-frozen',
            evidence: evidence(freezes[0].freezeId, freezes)
        })
    }
    const leases = (runtimeState.exclusiveLeases ?? []).filter(
        (lease) => lease.issueId === node.id
    )
    if (leases.length > 0) {
        reasons.push({
            code: 'exclusive-lease-held',
            evidence: evidence(leases[0].leaseId, leases)
        })
    }
    if (runtimeState.remoteFacts?.fresh !== true) {
        reasons.push({
            code: 'remote-facts-stale',
            evidence: evidence(
                runtimeState.remoteFacts?.selectorReceiptDigest ?? node.id,
                runtimeState.remoteFacts ?? null
            )
        })
    }
    reasons.sort(
        (left, right) => REASON_ORDER.indexOf(left.code) - REASON_ORDER.indexOf(right.code)
    )
    return { issueId: node.id, stage, ready: reasons.length === 0, reasons }
}

function eligibilityInputs({ dag, runtimeState, selectorReceipt }) {
    return {
        selectorReceipt,
        dag: {
            schema: dag.schema,
            selectorReceiptDigest: dag.selectorReceiptDigest,
            remoteSnapshotDigest: dag.remoteSnapshotDigest,
            nodes: (dag.nodes ?? []).map((node) => {
                const { narration, status, ...semantic } = node
                return semantic
            })
        },
        runtimeState
    }
}

export function compileReadyFrontier({
    dag,
    runtimeState,
    selectorReceipt,
    computedAt = new Date().toISOString()
}) {
    const selected = [...(selectorReceipt.resolvedIssueSet ?? [])].sort()
    const nodes = [...(dag.nodes ?? [])].sort((left, right) => left.id.localeCompare(right.id))
    if (JSON.stringify(selected) !== JSON.stringify(nodes.map(({ id }) => id).sort())) {
        fail('frontier-scope-incomplete', 'DAG nodes do not exactly cover the selector receipt.')
    }
    const outcomes = nodes.map((node) =>
        computeNodeEligibility({ node, dag, runtimeState, selectorReceipt })
    )
    const readyFrontier = outcomes
        .filter(({ ready }) => ready)
        .map(({ issueId, stage }) => ({ issueId, stage }))
        .sort((left, right) =>
            `${left.issueId}@${left.stage}`.localeCompare(`${right.issueId}@${right.stage}`)
        )
    const notReadyReasons = Object.fromEntries(
        outcomes
            .filter(({ reasons }) => reasons.length > 0)
            .map(({ issueId, reasons }) => [issueId, reasons])
    )
    const executionProjection = readyFrontier.map(({ issueId, stage }) => ({
        issueId,
        stage,
        candidateCapabilityReceiptDigest:
            candidateFor(runtimeState, issueId, stage)?.capabilityReceiptDigest
    }))
    const eligibilityInputDigest = digest(
        eligibilityInputs({ dag, runtimeState, selectorReceipt })
    )
    const frontierDigest = digest({
        eligibilityInputDigest,
        readyFrontier,
        notReadyReasons,
        executionProjection
    })
    return {
        schema: 'issue-orchestration.frontier-projection.v1',
        computedAt,
        eligibilityInputDigest,
        frontierDigest,
        readyFrontier,
        notReadyReasons,
        executionProjection
    }
}

export function validateReadyFrontier({
    dag,
    runtimeState,
    selectorReceipt,
    recordedProjection
}) {
    const expected = compileReadyFrontier({ dag, runtimeState, selectorReceipt })
    if (recordedProjection?.eligibilityInputDigest !== expected.eligibilityInputDigest) {
        return { valid: false, code: 'frontier-input-digest-mismatch' }
    }
    if (recordedProjection?.frontierDigest !== expected.frontierDigest) {
        const projectionMatches = JSON.stringify(canonical({
            readyFrontier: recordedProjection?.readyFrontier,
            notReadyReasons: recordedProjection?.notReadyReasons,
            executionProjection: recordedProjection?.executionProjection
        })) === JSON.stringify(canonical({
            readyFrontier: expected.readyFrontier,
            notReadyReasons: expected.notReadyReasons,
            executionProjection: expected.executionProjection
        }))
        return {
            valid: false,
            code: projectionMatches
                ? 'frontier-digest-mismatch'
                : 'frontier-projection-mismatch'
        }
    }
    const projectionMatches = JSON.stringify(canonical({
        readyFrontier: recordedProjection.readyFrontier,
        notReadyReasons: recordedProjection.notReadyReasons,
        executionProjection: recordedProjection.executionProjection
    })) === JSON.stringify(canonical({
        readyFrontier: expected.readyFrontier,
        notReadyReasons: expected.notReadyReasons,
        executionProjection: expected.executionProjection
    }))
    return projectionMatches
        ? { valid: true }
        : { valid: false, code: 'frontier-projection-mismatch' }
}

export function selectDispatchCandidates({ projection, runtimeState }) {
    if (runtimeState.rootOnlyDeliveryAction) {
        return {
            dispatchCandidates: [],
            noDispatchReason: {
                code: 'root-only-delivery-action',
                evidence: evidence(runtimeState.rootOnlyDeliveryAction.actionId)
            }
        }
    }
    const availableSlots = Math.max(0, runtimeState.availableSlots ?? 0)
    return {
        dispatchCandidates: projection.readyFrontier.slice(0, availableSlots),
        noDispatchReason: null
    }
}

export function validateDispatchCandidates({
    projection,
    runtimeState,
    groupProposals,
    recordedCandidateSet
}) {
    const expected = selectDispatchCandidates({ projection, runtimeState, groupProposals })
    const actual = recordedCandidateSet?.dispatchCandidates
    if (!Array.isArray(actual)) {
        return { valid: false, code: 'dispatch-candidate-mismatch' }
    }
    if (expected.dispatchCandidates.length > 0 && actual.length === 0) {
        return { valid: false, code: 'dispatch-work-conservation' }
    }
    if (actual.length < expected.dispatchCandidates.length) {
        return { valid: false, code: 'dispatch-maximality' }
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected.dispatchCandidates)
        || JSON.stringify(recordedCandidateSet.noDispatchReason)
            !== JSON.stringify(expected.noDispatchReason)) {
        return { valid: false, code: 'dispatch-candidate-mismatch' }
    }
    return { valid: true }
}
