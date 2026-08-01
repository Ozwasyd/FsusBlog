import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const implementationPath = path.join(
    root,
    '.agents/skills/issue-orchestration/scripts/dispatch-receipt.mjs'
)
const eventLedgerPath = path.join(
    root,
    '.agents/skills/issue-orchestration/scripts/event-ledger.mjs'
)
const fixturesRoot = path.join(root, 'tests/fixtures/issue-orchestration')
const acceptance = readJson('dispatch-receipt-acceptance-map.json')
const controls = readJson('dispatch-receipt-mutation-controls.json').controls
const probes = readJson('dispatch-receipt-runtime-probes.json').probes
const contract = readJson('dispatch-receipt-test-contract.json')

const baseSha = contract.baseSha
const deliveryEpochId = contract.deliveryBinding.epochId
const candidateSha = contract.candidateIdentity.candidateSha
const candidateDigest = contract.candidateIdentity.candidateDigest
const revisionTwoCandidateDigest =
    '86d9dbd5a099ace8965762706dc52ae5876da065db915435ee7d03df63bbcdbf'
const digestA = '1'.repeat(64)
const digestB = '2'.repeat(64)
const digestC = '3'.repeat(64)
const digestD = '4'.repeat(64)
const worktree = '/srv/fsus/worktrees/1818'
const repository = 'Ozwasyd/FsusBlog'
const testOwnerWritableRoots = [
    path.posix.join(worktree, 'tests/tools'),
    path.posix.join(worktree, 'tests/fixtures/issue-orchestration')
]

function readJson(name) {
    return JSON.parse(fs.readFileSync(path.join(fixturesRoot, name), 'utf8'))
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function digest(value) {
    const source = typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(canonical(value))
    return createHash('sha256').update(source).digest('hex')
}

function clone(value) {
    return structuredClone(value)
}

async function runtime() {
    return import(`${pathToFileURL(implementationPath).href}?contract=${Date.now()}`)
}

async function eventLedgerRuntime() {
    return import(`${pathToFileURL(eventLedgerPath).href}?dispatch-contract=${Date.now()}`)
}

function requiredSkills(stageRole) {
    if (!['ui-ux-implementer', 'ux-acceptance-verifier'].includes(stageRole)) return []
    return [
        { id: 'fsusblog-design-conformance', digest: digestA },
        { id: 'fsusui-design-conformance', digest: digestB }
    ]
}

function requestInput({
    candidate = null,
    group = false,
    overrides = {},
    stageRole = 'code-implementer'
} = {}) {
    const profiles = {
        'root-scheduler': {
            effort: 'low',
            model: 'gpt-5.6-sol',
            sandbox: 'read-only',
            writePolicy: 'external-state-root-only'
        },
        'dag-creator-updater': {
            effort: 'max',
            model: 'gpt-5.6-sol',
            sandbox: 'read-only',
            writePolicy: 'read-only'
        },
        'test-owner': {
            effort: 'max',
            model: 'gpt-5.6-sol',
            sandbox: 'workspace-write',
            writePolicy: 'test-owner-scoped-write-lease'
        },
        'code-implementer': {
            effort: 'low',
            model: 'gpt-5.6-sol',
            sandbox: 'workspace-write',
            writePolicy: 'stage-scoped-write-lease'
        },
        'ui-ux-implementer': {
            effort: 'low',
            model: 'gpt-5.6-sol',
            sandbox: 'workspace-write',
            writePolicy: 'stage-scoped-write-lease'
        },
        'ux-acceptance-verifier': {
            effort: 'max',
            model: 'gpt-5.6-sol',
            sandbox: 'read-only',
            writePolicy: 'read-only'
        },
        'documentation-writer': {
            effort: 'low',
            model: 'gpt-5.6-sol',
            sandbox: 'workspace-write',
            writePolicy: 'documentation-scoped-write-lease'
        },
        'cleanup-verifier': {
            effort: 'max',
            model: 'gpt-5.6-sol',
            sandbox: 'read-only',
            writePolicy: 'read-only'
        }
    }
    const profile = profiles[stageRole]
    assert.ok(profile, `missing fixture profile for ${stageRole}`)
    const skills = requiredSkills(stageRole)
    return {
        schema: 'issue-orchestration.dispatch-request.v1',
        requestId: 'request-1818-001',
        runId: 'run-1818-contract',
        nodeId: 'FsusBlog#1818',
        attemptId: 'attempt-1818-001',
        role: stageRole,
        stageRole,
        requestedByRole: 'root-scheduler',
        promptDigest: digestA,
        sourceDagDigest: digestB,
        frontierDigest: digestC,
        issueSnapshotFingerprint: digestD,
        repositoryFingerprint: '5'.repeat(64),
        repository,
        baseSha,
        candidateSha: candidate,
        candidateDigest: candidate ? candidateDigest : null,
        requestedModel: profile.model,
        requestedEffort: profile.effort,
        requestedSandbox: profile.sandbox,
        requestedForkTurns: 'none',
        requestedWorkingDirectory: worktree,
        stageProfileDigest: '7'.repeat(64),
        testOwnerId: contract.testOwnerId,
        testContractDigest: contract.testContractDigest,
        epochId: deliveryEpochId,
        requiredSkills: skills,
        designAuthorityDigests: skills.map(({ digest: value }) => value),
        uiImpact: skills.length > 0,
        behaviorReceiptDigest: null,
        uxAcceptanceReceiptDigest: null,
        documentationReceiptDigest: null,
        allowedPathsDigest: '8'.repeat(64),
        forbiddenPathsDigest: '9'.repeat(64),
        writePolicy: profile.writePolicy,
        groupId: group ? 'group-bootstrap-repair' : null,
        groupSessionDigest: group ? 'b'.repeat(64) : null,
        memberIssueId: group ? 'FsusBlog#1818' : null,
        memberStage: group ? stageRole : null,
        activeWriteLeaseId: group && profile.sandbox !== 'read-only'
            ? 'lease-1818-001'
            : null,
        groupWorktreeIdentity: group ? 'c'.repeat(64) : null,
        groupBranchIdentity: group ? 'd'.repeat(64) : null,
        testOwnerContinuityIdentity: group ? 'test-owner-continuity-1818' : null,
        implementerContinuityIdentity: group ? 'implementer-continuity-1818' : null,
        freshVerificationRollout: stageRole === 'test-owner' ||
            stageRole === 'ux-acceptance-verifier',
        memberTestContractDigest: group ? contract.testContractDigest : null,
        memberCandidateIdentity: group && candidate ? candidate : null,
        createdAt: '2026-08-01T04:30:00.000Z',
        ...overrides
    }
}

function sealRecord(record) {
    const unsigned = clone(record)
    delete unsigned.observationDigest
    return { ...unsigned, observationDigest: digest(unsigned) }
}

function evidence(request, { source = 'runtime-rollout' } = {}) {
    const skills = request.requiredSkills
    const sandboxPolicy = request.requestedSandbox === 'read-only'
        ? { type: 'read-only' }
        : {
                type: 'workspace-write',
                writable_roots: request.stageRole === 'test-owner'
                    ? testOwnerWritableRoots
                    : [worktree]
            }
    const rolloutRecords = [
        {
            timestamp: '2026-08-01T04:30:01.000Z',
            type: 'session_meta',
            payload: {
                id: 'rollout-1818-001',
                session_id: 'thread-1818-001',
                parent_thread_id: 'thread-root-1818',
                cwd: worktree,
                source: {
                    subagent: {
                        thread_spawn: {
                            agent_role: request.stageRole,
                            fork_turns: 'none',
                            parent_thread_id: 'thread-root-1818',
                            request_id: request.requestId
                        }
                    }
                },
                history_mode: 'fresh',
                thread_source: 'subagent'
            }
        },
        {
            timestamp: '2026-08-01T04:30:01.100Z',
            type: 'turn_context',
            payload: {
                cwd: worktree,
                model: request.requestedModel,
                effort: request.requestedEffort,
                sandbox_policy: sandboxPolicy
            }
        }
    ]
    const machineObservations = [
        sealRecord({
            kind: 'dispatch-context',
            source,
            requestId: request.requestId,
            promptDigest: request.promptDigest,
            sourceDagDigest: request.sourceDagDigest,
            frontierDigest: request.frontierDigest,
            stageProfileDigest: request.stageProfileDigest,
            testContractDigest: request.testContractDigest,
            epochId: request.epochId
        }),
        sealRecord({
            kind: 'git-worktree-identity',
            source: 'machine-git-observation',
            repository,
            baseSha: request.baseSha,
            candidateSha: request.candidateSha,
            candidateDigest: request.candidateDigest,
            workingDirectory: worktree,
            worktreeIdentity: request.groupWorktreeIdentity,
            branchIdentity: request.groupBranchIdentity
        }),
        sealRecord({
            kind: 'skill-loader',
            source: 'runtime-skill-loader',
            loadedSkills: skills
        }),
        sealRecord({
            kind: 'group-member-lease',
            source: 'machine-lease-registry',
            groupId: request.groupId,
            groupSessionDigest: request.groupSessionDigest,
            memberIssueId: request.memberIssueId,
            memberStage: request.memberStage,
            activeWriteLeaseId: request.activeWriteLeaseId,
            memberTestContractDigest: request.memberTestContractDigest,
            memberCandidateIdentity: request.memberCandidateIdentity,
            testOwnerContinuityIdentity: request.testOwnerContinuityIdentity,
            implementerContinuityIdentity: request.implementerContinuityIdentity,
            freshVerificationRollout: request.freshVerificationRollout,
            activeLeaseOwners: request.activeWriteLeaseId
                ? [{ leaseId: request.activeWriteLeaseId, memberIssueId: request.memberIssueId }]
                : []
        })
    ]
    return { machineObservations, rolloutRecords }
}

async function verifiedDispatch(options = {}) {
    const module = await runtime()
    const request = await module.sealDispatchRequest(requestInput(options))
    const result = await module.verifyRuntimeDispatch({
        request,
        ...evidence(request),
        priorReceipts: []
    })
    assert.equal(result.dispatchReceipt.verificationStatus, 'verified')
    return { module, request, ...result }
}

function selfTestExecution(request, { candidate = candidateSha } = {}) {
    const commandResults = contract.visibleTestMatrix.map((entry, index) => ({
        id: entry.id,
        command: entry.command,
        exitStatus: 0,
        skipped: false,
        observationSource: 'machine-process-observation',
        resultDigest: digest(`${entry.id}:${index + 1}`)
    }))
    return {
        runId: request.runId,
        nodeId: request.nodeId,
        attemptId: request.attemptId,
        stageRole: request.stageRole,
        requestDigest: request.requestDigest,
        candidateSha: candidate,
        baseSha,
        frozenTestContractDigest: contract.testContractDigest,
        frozenTestTreeDigestBefore: contract.frozenTestTree.digest,
        frozenTestTreeDigestAfter: contract.frozenTestTree.digest,
        implementationDiffDigest: 'e'.repeat(64),
        commandResults,
        visibleTestMatrixDigest: contract.visibleTestMatrixDigest,
        lintTypecheckBuildResults: {
            lint: 'passed',
            typecheck: 'passed',
            build: 'not-applicable-no-build-artifact'
        },
        firstFailureRefs: ['evidence://1818/required-runtime-cli-no-op'],
        fixCycleCount: 1,
        failureHistory: [
            { ref: 'evidence://1818/required-runtime-cli-no-op', outcome: 'failed' },
            { ref: 'evidence://1818/candidate-green', outcome: 'passed' }
        ],
        remainingFailures: [],
        workingTreeStatusDigest: 'f'.repeat(64),
        observedWorkingTreeStatusDigest: 'f'.repeat(64),
        modifiedPaths: ['.agents/skills/issue-orchestration/scripts/dispatch-receipt.mjs'],
        verifierRole: 'deterministic-machine'
    }
}

function appendLedgerEvent(ledger, {
    actorRole,
    attemptId = null,
    eventType,
    fromState,
    payload = {},
    toState
}) {
    const event = {
        eventId: `event-1818-${String(ledger.events.length + 1).padStart(3, '0')}`,
        sequence: ledger.events.length + 1,
        runId: ledger.header.runId,
        nodeId: 'FsusBlog#1818',
        eventType,
        fromState,
        toState,
        attemptId,
        actorRole,
        sourceDagDigest: digestB,
        issueSnapshotFingerprint: digestC,
        repositoryFingerprint: digestD,
        baseSha,
        payload,
        payloadDigest: digest(payload),
        evidenceRefs: [`evidence://1818/${eventType}`],
        createdAt: new Date(
            Date.parse('2026-08-01T04:30:00.000Z') + ledger.events.length * 1000
        ).toISOString(),
        previousEventDigest: ledger.events.at(-1)?.eventDigest ?? '0'.repeat(64)
    }
    event.eventDigest = digest(event)
    ledger.events.push(event)
    return event
}

function ordinaryFrozenContract() {
    const frozenFiles = [{
        path: 'tests/tools/issue-orchestration-ordinary-contract.test.mjs',
        sha256: digestA
    }]
    return {
        frozenFiles,
        testContractDigest: digest(frozenFiles)
    }
}

function frozenLedger({
    frozenFiles = contract.frozenTestTree.files,
    testContractDigest = contract.testContractDigest
} = {}) {
    const ledger = {
        header: {
            schema: 'issue-orchestration.ledger.v1',
            runId: 'run-1818-contract',
            baseSha,
            issueSnapshotFingerprint: digestC,
            repositoryFingerprint: digestD
        },
        events: []
    }
    appendLedgerEvent(ledger, {
        actorRole: 'dag-creator-updater',
        eventType: 'node.discovered',
        fromState: 'none',
        payload: { issueKind: 'code' },
        toState: 'discovered'
    })
    appendLedgerEvent(ledger, {
        actorRole: 'test-owner',
        eventType: 'test-contract.started',
        fromState: 'discovered',
        payload: { actorId: contract.testOwnerId },
        toState: 'test-contracting'
    })
    appendLedgerEvent(ledger, {
        actorRole: 'test-owner',
        eventType: 'test-contract.frozen',
        fromState: 'test-contracting',
        payload: {
            actorId: contract.testOwnerId,
            frozenFiles,
            testContractDigest
        },
        toState: 'test-contract-frozen'
    })
    return ledger
}

function implementationStartedLedger(dispatchReceipt, contractOptions = {}) {
    const ledger = frozenLedger(contractOptions)
    appendLedgerEvent(ledger, {
        actorRole: 'code-implementer',
        attemptId: 'attempt-1818-001',
        eventType: 'implementation.started',
        fromState: 'test-contract-frozen',
        payload: {
            actorId: 'code-implementer-1818',
            ...(dispatchReceipt ? { dispatchReceipt } : {}),
            effort: 'low',
            model: 'gpt-5.6-sol',
            ownerContinuationId: 'implementation-owner-1818'
        },
        toState: 'implementing-self-testing'
    })
    return ledger
}

function legacyCandidateReceipt({
    testContractDigest = contract.testContractDigest
} = {}) {
    const receipt = {
        schema: 'issue-orchestration.verified-candidate-receipt.v1',
        actorId: 'code-implementer-1818',
        actorRole: 'code-implementer',
        candidateSha,
        testContractDigest,
        fresh: true,
        modifiedPaths: ['.agents/skills/issue-orchestration/scripts/dispatch-receipt.mjs'],
        selfTestCycles: [
            { cycle: 1, outcome: 'failed', signature: 'required-runtime-cli-no-op' },
            { cycle: 2, outcome: 'passed', signature: null }
        ],
        status: 'passed',
        visibleMatrixComplete: true
    }
    return { ...receipt, receiptDigest: digest(receipt) }
}

function allReferencedMutations() {
    return new Set(acceptance.acceptance.flatMap((item) => item.mutations))
}

test('P00 frozen contract maps every acceptance mutation and runtime probe', () => {
    const ids = new Set(controls.map(({ id }) => id))
    const referenced = allReferencedMutations()
    for (const id of referenced) assert.ok(ids.has(id), `missing mutation ${id}`)
    for (const id of ids) assert.ok(referenced.has(id), `unmapped mutation ${id}`)
    assert.deepEqual(
        probes.map(({ id }) => id),
        Array.from({ length: 20 }, (_, index) =>
            `RP${String(index + 1).padStart(2, '0')}`)
    )
    assert.equal(contract.authorityCommentId, 5145140476)
    assert.equal(contract.testOwnerId, 'test-owner-fsusblog-1818-18c6003eb5ad')
    assert.equal(baseSha, '9c02ed22bdd578d07d6e4ca8c1c4c9bc161bbc18')
    assert.equal(deliveryEpochId, 'epoch-1818-003')
    assert.equal(contract.baseSha, baseSha)
    assert.deepEqual(contract.deliveryBinding, {
        epochId: deliveryEpochId,
        baseSha,
        candidateSha,
        candidateIdentityRef: '#candidateIdentity'
    })
    assert.deepEqual(contract.deliveryBindingHistory.at(-1), {
        revision: 5,
        epochId: 'epoch-1818-002',
        baseSha: 'f99e6091165edc9dba7f2b1314568c3a07b69537',
        candidateSha: 'b'.repeat(40),
        candidateDigest: '8c40894842241ae87aeaba98bc527e18c84ee800a98929b8e1e63306c1210497',
        testContractDigest:
            '99e14648bad3cb4b6b6c96512332969ce42fce7a9f8748bf9ecee5606ba4cd51',
        frozenTestTreeDigest:
            'aa4292f1e9910bc7af4ecb98d3d421b4673455f906a7e1a95216586238bd967d',
        visibleTestMatrixDigest:
            'f22aed9931ca0138ca6233393aa9c0a55edc16b11f9325f0c00e0e0ab0ace5a0'
    })
    const manifest = contract.frozenTestTree.files.map(({ path: relative, sha256 }) => ({
        path: relative,
        sha256: digest(fs.readFileSync(path.join(root, relative)))
    }))
    assert.deepEqual(manifest, contract.frozenTestTree.files)
    assert.equal(digest(manifest), contract.frozenTestTree.digest)
    assert.equal(digest(contract.visibleTestMatrix), contract.visibleTestMatrixDigest)
    const unsigned = clone(contract)
    delete unsigned.testContractDigest
    delete unsigned.candidateIdentity
    assert.equal(digest(unsigned), contract.testContractDigest)
    const implementationFiles = [{
        path: '.agents/skills/issue-orchestration/scripts/dispatch-receipt.mjs',
        sha256: 'e6c26a2b16e145379689edbedc4ef21e52e517808ad34731b25b2f33beb7b833',
        gitMode: '100644'
    }]
    assert.deepEqual(contract.minimalImplementationPaths, implementationFiles.map(({ path }) => path))
    assert.deepEqual(contract.candidateIdentity, {
        schema: 'issue-orchestration.candidate-identity.v1',
        algorithm: 'sha256-canonical-json-v1',
        policy: 'two-stage-no-self-reference',
        baseSha,
        candidateSha: baseSha,
        testContractDigest: contract.testContractDigest,
        implementationFiles,
        candidateDigest: digest({
            baseSha,
            candidateSha: baseSha,
            testContractDigest: contract.testContractDigest,
            implementationFiles
        })
    })
    assert.deepEqual(contract.satisfiedBaseDependencies, [{
        issue: 'Ozwasyd/FsusBlog#1817',
        path: '.agents/skills/issue-orchestration/scripts/event-ledger.mjs',
        status: 'satisfied-by-base',
        baseSha
    }])
    assert.equal(contract.documentationStageBinding.candidateImplementation, false)
    assert.equal(controls.length, 93)
    assert.equal(contract.visibleTestMatrix.length, 17)
})

test('P01 dispatch request v1 is immutable, complete, secret-free, and explicit for non-group work', async () => {
    const module = await runtime()
    const request = await module.sealDispatchRequest(requestInput())
    assert.equal(request.schema, 'issue-orchestration.dispatch-request.v1')
    assert.equal(request.groupId, null)
    assert.equal(request.candidateSha, null)
    assert.equal(request.requestDigest, digest(Object.fromEntries(
        Object.entries(request).filter(([key]) => key !== 'requestDigest')
    )))
})

test('P01A sealed dispatch request is deeply frozen against nested mutation', async () => {
    const module = await runtime()
    const request = await module.sealDispatchRequest(requestInput({
        stageRole: 'ui-ux-implementer'
    }))
    assert.equal(Object.isFrozen(request), true)
    assert.equal(Object.isFrozen(request.requiredSkills), true)
    assert.equal(Object.isFrozen(request.requiredSkills[0]), true)
    assert.throws(
        () => request.requiredSkills.push({ id: 'forged-skill', digest: digestD }),
        TypeError
    )
})

test('P02 runtime-observed dispatch receipt derives effective identity from rollout and machine evidence', async () => {
    const { dispatchReceipt, runtimeObservation } = await verifiedDispatch()
    assert.equal(runtimeObservation.schema, 'issue-orchestration.runtime-observation.v1')
    assert.equal(dispatchReceipt.schema, 'issue-orchestration.dispatch-receipt.v1')
    assert.equal(dispatchReceipt.verificationStatus, 'verified')
    assert.deepEqual(dispatchReceipt.mismatchReasons, [])
    assert.equal(runtimeObservation.effectiveModel, 'gpt-5.6-sol')
    assert.equal(runtimeObservation.effectiveEffort, 'low')
    assert.equal(runtimeObservation.effectiveRole, 'code-implementer')
    assert.equal(runtimeObservation.effectiveSandbox, 'workspace-write')
    assert.equal(runtimeObservation.effectiveForkTurns, 'none')
})

test('P03 stage profile and UI Skill loads are effective runtime facts, not request copies', async () => {
    const { dispatchReceipt, runtimeObservation, request } = await verifiedDispatch({
        stageRole: 'ui-ux-implementer'
    })
    assert.equal(dispatchReceipt.verificationStatus, 'verified')
    assert.deepEqual(runtimeObservation.loadedSkills, request.requiredSkills)
    assert.equal(runtimeObservation.skillLoadProvenance, 'runtime-skill-loader')
})

test('P03A test owner has a Sol/max write lease restricted to owned tests and fixtures', async () => {
    const { dispatchReceipt, runtimeObservation, request } = await verifiedDispatch({
        stageRole: 'test-owner'
    })
    assert.equal(dispatchReceipt.verificationStatus, 'verified')
    assert.equal(request.requestedModel, 'gpt-5.6-sol')
    assert.equal(request.requestedEffort, 'max')
    assert.equal(runtimeObservation.effectiveSandbox, 'workspace-write')
    assert.deepEqual(runtimeObservation.contexts[0].sandbox_policy.writable_roots,
        testOwnerWritableRoots)
})

const dispatchMutations = {
    'runtime-model-unobservable': ({ rolloutRecords }) => { delete rolloutRecords[1].payload.model },
    'runtime-effort-unobservable': ({ rolloutRecords }) => { delete rolloutRecords[1].payload.effort },
    'runtime-role-unobservable': ({ rolloutRecords }) => { delete rolloutRecords[0].payload.source.subagent.thread_spawn.agent_role },
    'runtime-sandbox-unobservable': ({ rolloutRecords }) => { delete rolloutRecords[1].payload.sandbox_policy },
    'runtime-fork-unobservable': ({ rolloutRecords }) => { delete rolloutRecords[0].payload.source.subagent.thread_spawn.fork_turns },
    'runtime-working-directory-unobservable': ({ rolloutRecords }) => {
        delete rolloutRecords[1].payload.cwd
    },
    'runtime-thread-id-unobservable': ({ rolloutRecords }) => {
        delete rolloutRecords[0].payload.session_id
    },
    'runtime-rollout-id-unobservable': ({ rolloutRecords }) => {
        delete rolloutRecords[0].payload.id
    },
    'runtime-started-at-unobservable': ({ rolloutRecords }) => {
        delete rolloutRecords[0].timestamp
    },
    'runtime-skill-unobservable': ({ machineObservations }) => {
        machineObservations.splice(machineObservations.findIndex(({ kind }) => kind === 'skill-loader'), 1)
    },
    'runtime-model-mismatch': ({ rolloutRecords }) => { rolloutRecords[1].payload.model = 'gpt-5.6-terra' },
    'runtime-effort-mismatch': ({ rolloutRecords }) => { rolloutRecords[1].payload.effort = 'max' },
    'runtime-role-mismatch': ({ rolloutRecords }) => {
        rolloutRecords[0].payload.source.subagent.thread_spawn.agent_role = 'documentation-writer'
    },
    'reviewer-sandbox-writable': ({ rolloutRecords }) => {
        rolloutRecords[1].payload.sandbox_policy = { type: 'workspace-write', writable_roots: [worktree] }
    },
    'full-history-fork': ({ rolloutRecords }) => {
        rolloutRecords[0].payload.source.subagent.thread_spawn.fork_turns = 'all'
        rolloutRecords[0].payload.history_mode = 'full'
    },
    'runtime-fork-exact-mismatch': ({ rolloutRecords }) => {
        rolloutRecords[0].payload.source.subagent.thread_spawn.fork_turns = '3'
    },
    'context-effort-drift': ({ rolloutRecords }) => {
        rolloutRecords.push(clone(rolloutRecords[1]))
        rolloutRecords.at(-1).payload.effort = 'max'
    },
    'context-sandbox-drift': ({ rolloutRecords }) => {
        rolloutRecords.push(clone(rolloutRecords[1]))
        rolloutRecords.at(-1).payload.sandbox_policy = { type: 'danger-full-access' }
    },
    'cwd-wrong-repository': ({ rolloutRecords }) => { rolloutRecords[1].payload.cwd = '/srv/other' },
    'prompt-drift': ({ machineObservations }) => { machineObservations[0].promptDigest = '0'.repeat(64) },
    'base-drift': ({ machineObservations }) => { machineObservations[1].baseSha = '0'.repeat(40) },
    'source-dag-drift': ({ machineObservations }) => { machineObservations[0].sourceDagDigest = '0'.repeat(64) },
    'frontier-drift': ({ machineObservations }) => { machineObservations[0].frontierDigest = '0'.repeat(64) },
    'stage-profile-drift': ({ machineObservations }) => { machineObservations[0].stageProfileDigest = '0'.repeat(64) },
    'test-contract-drift': ({ machineObservations }) => { machineObservations[0].testContractDigest = '0'.repeat(64) },
    'candidate-drift': ({ machineObservations }) => { machineObservations[1].candidateSha = '0'.repeat(40) },
    'runtime-candidate-digest-drift': ({ machineObservations }) => {
        machineObservations[1].candidateDigest = '0'.repeat(64)
    },
    'runtime-request-id-drift': ({ machineObservations, rolloutRecords }) => {
        machineObservations[0].requestId = 'request-1818-drifted'
        rolloutRecords[0].payload.source.subagent.thread_spawn.request_id =
            'request-1818-drifted'
    },
    'runtime-epoch-drift': ({ machineObservations }) => {
        machineObservations[0].epochId = `${deliveryEpochId}-drifted`
    },
    'required-skill-missing': ({ machineObservations }) => { machineObservations[2].loadedSkills.pop() },
    'loaded-skill-digest-mismatch': ({ machineObservations }) => {
        machineObservations[2].loadedSkills[0].digest = '0'.repeat(64)
    },
    'skill-observation-self-hashed-forgery': ({ machineObservations }) => {
        machineObservations[2].source = 'agent-self-report'
        machineObservations[2].reportedByRole = 'ui-ux-implementer'
    },
    'requested-copied-as-effective': ({ machineObservations }) => {
        for (const item of machineObservations) item.source = 'dispatch-request'
    },
    'runtime-metadata-digest-tampered': (input) => { input.claimedRuntimeMetadataDigest = '0'.repeat(64) },
    'group-id-mismatch': ({ machineObservations }) => { machineObservations[3].groupId = 'group-other' },
    'group-session-drift': ({ machineObservations }) => {
        machineObservations[3].groupSessionDigest = '0'.repeat(64)
    },
    'group-member-mismatch': ({ machineObservations }) => { machineObservations[3].memberIssueId = 'FsusBlog#9999' },
    'group-member-stage-drift': ({ machineObservations }) => {
        machineObservations[3].memberStage = 'documentation-writer'
    },
    'group-member-test-contract-drift': ({ machineObservations }) => {
        machineObservations[3].memberTestContractDigest = '0'.repeat(64)
    },
    'group-lease-mismatch': ({ machineObservations }) => { machineObservations[3].activeWriteLeaseId = 'lease-other' },
    'group-worktree-mismatch': ({ machineObservations }) => { machineObservations[1].worktreeIdentity = '0'.repeat(64) },
    'group-branch-mismatch': ({ machineObservations }) => { machineObservations[1].branchIdentity = '0'.repeat(64) },
    'group-lease-multiple-members': ({ machineObservations }) => {
        machineObservations[3].activeLeaseOwners.push({
            leaseId: 'lease-1818-001',
            memberIssueId: 'FsusBlog#1820'
        })
    },
    'group-candidate-substitutes-member': ({ machineObservations }) => {
        machineObservations[3].memberCandidateIdentity = '0'.repeat(40)
    },
    'group-test-owner-continuity-drift': ({ machineObservations }) => {
        machineObservations[3].testOwnerContinuityIdentity = 'test-owner-continuity-other'
    },
    'group-implementer-continuity-drift': ({ machineObservations }) => {
        machineObservations[3].implementerContinuityIdentity =
            'implementer-continuity-other'
    },
    'behavior-verifier-not-fresh': ({ machineObservations }) => {
        machineObservations[3].freshVerificationRollout = false
    },
    'test-owner-write-root-overreach': ({ rolloutRecords }) => {
        rolloutRecords[1].payload.sandbox_policy.writable_roots = [worktree]
    },
    'secret-in-receipt': (input) => { input.extraMetadata = { token: 'secret-value' } }
}

async function dispatchMutation(control) {
    const module = await runtime()
    const grouped = control.id.startsWith('group-')
    const behaviorVerifier = control.id === 'behavior-verifier-not-fresh'
    const uxVerifier = control.id === 'reviewer-sandbox-writable'
    const testOwner = control.id === 'test-owner-write-root-overreach'
    const candidateDigestBinding = control.id === 'runtime-candidate-digest-drift'
    const ui = ['runtime-skill-unobservable', 'required-skill-missing',
        'loaded-skill-digest-mismatch', 'skill-observation-self-hashed-forgery']
        .includes(control.id)
    const stageRole = uxVerifier
        ? 'ux-acceptance-verifier'
        : behaviorVerifier || testOwner
            ? 'test-owner'
            : ui
                ? 'ui-ux-implementer'
                : 'code-implementer'
    const request = await module.sealDispatchRequest(requestInput({
        candidate: grouped || behaviorVerifier || uxVerifier || candidateDigestBinding
            ? candidateSha
            : null,
        group: grouped,
        overrides: candidateDigestBinding
            ? { candidateDigest: revisionTwoCandidateDigest }
            : {},
        stageRole
    }))
    const input = { request, ...evidence(request), priorReceipts: [] }
    if (control.id === 'thread-reused-two-attempts') {
        input.priorReceipts = [{
            threadId: 'thread-1818-001',
            requestId: 'request-old',
            attemptId: 'attempt-old',
            verificationStatus: 'verified'
        }]
    } else if (control.id === 'request-replayed-new-attempt') {
        input.priorReceipts = [{
            requestDigest: request.requestDigest,
            attemptId: 'attempt-old',
            verificationStatus: 'verified'
        }]
    } else if (control.id === 'receipt-replayed-new-epoch') {
        input.priorReceipts = [{
            requestDigest: request.requestDigest,
            epochId: 'epoch-old',
            receiptDigest: '0'.repeat(64),
            verificationStatus: 'verified'
        }]
        input.replayReceiptDigest = '0'.repeat(64)
    } else {
        dispatchMutations[control.id](input)
    }
    for (const item of input.machineObservations) {
        if (item.observationDigest) item.observationDigest = digest(
            Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'observationDigest'))
        )
    }
    const result = await module.verifyRuntimeDispatch(input)
    assert.equal(
        result.dispatchReceipt.verificationStatus,
        control.expectedStatus,
        `${control.id}: ${JSON.stringify(result.dispatchReceipt)}`
    )
    assert.ok(result.dispatchReceipt.mismatchReasons.includes(control.expectedReason))
}

test('P04 missing, mismatched, drifted, copied, replayed, and tampered runtime metadata fails closed', async (t) => {
    const selected = controls.filter(({ surface, id }) =>
        surface === 'dispatch' && id !== 'secret-in-receipt' &&
        !id.startsWith('group-') && id !== 'behavior-verifier-not-fresh' &&
        id !== 'runtime-candidate-digest-drift')
    for (const control of selected) {
        await t.test(control.id, () => dispatchMutation(control))
    }
})

test('P05 group/member/lease/candidate/fresh-rollout identities are exact and member scoped', async (t) => {
    const valid = await verifiedDispatch({ candidate: candidateSha, group: true })
    assert.equal(valid.dispatchReceipt.verificationStatus, 'verified')
    const selected = controls.filter(({ surface, id }) =>
        surface === 'dispatch' && (id.startsWith('group-') ||
            id === 'behavior-verifier-not-fresh'))
    for (const control of selected) {
        await t.test(control.id, () => dispatchMutation(control))
    }
})

test('P06 verified implementer self-test receipt v1 binds full matrix and unchanged frozen tree', async () => {
    const { module, request, dispatchReceipt } = await verifiedDispatch()
    const result = await module.verifyImplementerSelfTest({
        request,
        dispatchReceipt,
        contract,
        execution: selfTestExecution(request),
        priorReceipts: []
    })
    assert.equal(result.schema, 'issue-orchestration.implementer-self-test-receipt.v1')
    assert.equal(result.verificationStatus, 'verified')
    assert.equal(result.visibleTestMatrixDigest, contract.visibleTestMatrixDigest)
    assert.equal(result.frozenTestTreeDigestBefore, result.frozenTestTreeDigestAfter)
})

const selfTestMutations = {
    'self-test-matrix-subset': (execution) => { execution.commandResults.pop() },
    'frozen-test-tree-changed': (execution) => { execution.frozenTestTreeDigestAfter = '0'.repeat(64) },
    'failing-command-deleted': (execution) => { execution.failureHistory.shift() },
    'command-marked-skipped': (execution) => { execution.commandResults[0].skipped = true },
    'self-test-replay-new-candidate': (execution) => { execution.candidateSha = '0'.repeat(40) },
    'self-test-base-mismatch': (execution) => { execution.baseSha = '0'.repeat(40) },
    'self-test-request-mismatch': (execution) => { execution.requestDigest = '0'.repeat(64) },
    'self-test-still-red': (execution) => { execution.remainingFailures = ['dispatch-receipt-focused'] },
    'self-test-lint-failed': (execution) => { execution.lintTypecheckBuildResults.lint = 'failed' },
    'first-failure-overwritten': (execution) => { execution.firstFailureRefs = ['evidence://later-failure'] },
    'working-tree-digest-drift': (execution) => { execution.observedWorkingTreeStatusDigest = '0'.repeat(64) },
    'implementation-diff-touches-tests': (execution) => {
        execution.modifiedPaths.push('tests/tools/issue-orchestration-dispatch-receipt.test.mjs')
    },
    'implementation-diff-digest-missing': (execution) => {
        delete execution.implementationDiffDigest
    },
    'root-self-declares-verified': (execution) => { execution.verifierRole = 'root-scheduler' }
}

test('P07 partial, skipped, drifted, replayed, red, or self-authored self-test cannot be verified', async (t) => {
    const selected = controls.filter(({ surface }) => surface === 'self-test')
    for (const control of selected) {
        await t.test(control.id, async () => {
            const { module, request, dispatchReceipt } = await verifiedDispatch()
            const execution = selfTestExecution(request)
            selfTestMutations[control.id](execution)
            const result = await module.verifyImplementerSelfTest({
                request,
                dispatchReceipt,
                contract,
                execution,
                priorReceipts: []
            })
            assert.equal(result.verificationStatus, control.expectedStatus, control.id)
            assert.ok(result.mismatchReasons.includes(control.expectedReason), control.id)
        })
    }
})

test('P08 candidate-green self-test and independent behavior receipt are distinct transition authorities', async () => {
    const { module, request, dispatchReceipt } = await verifiedDispatch()
    const selfTestReceipt = await module.verifyImplementerSelfTest({
        request,
        dispatchReceipt,
        contract,
        execution: selfTestExecution(request),
        priorReceipts: []
    })
    await module.authorizeReceiptTransition({
        eventType: 'implementation.started',
        fromState: 'test-contract-frozen',
        toState: 'implementing-self-testing',
        dispatchReceipt
    })
    await module.authorizeReceiptTransition({
        eventType: 'implementation.candidate-green',
        fromState: 'implementing-self-testing',
        toState: 'candidate-green',
        dispatchReceipt,
        selfTestReceipt
    })
    await assert.rejects(
        () => module.authorizeReceiptTransition({
            eventType: 'independent-verification.passed',
            fromState: 'candidate-green',
            toState: 'behavior-green',
            dispatchReceipt,
            selfTestReceipt,
            behaviorReceipt: selfTestReceipt
        }),
        (error) => error?.code === 'independent-behavior-receipt-required'
    )
})

test('P09 a real rollout-shaped record with null role and absent fork remains capability-unverified', async () => {
    const module = await runtime()
    const request = await module.sealDispatchRequest(requestInput({ stageRole: 'test-owner' }))
    const input = evidence(request)
    input.rolloutRecords[0].payload.source.subagent.thread_spawn.agent_role = null
    delete input.rolloutRecords[0].payload.source.subagent.thread_spawn.fork_turns
    const result = await module.verifyRuntimeDispatch({ request, ...input, priorReceipts: [] })
    assert.equal(result.dispatchReceipt.verificationStatus, 'capability-unverified')
    assert.ok(result.dispatchReceipt.mismatchReasons.includes('runtime-role-unobservable'))
    assert.ok(result.dispatchReceipt.mismatchReasons.includes('runtime-fork-unobservable'))
})

test('P10 verify-runtime CLI rejects nonexistent inputs with a nonzero status and diagnostic', () => {
    const missingRoot = path.join(root, `.dispatch-receipt-missing-${process.pid}`)
    assert.equal(fs.existsSync(missingRoot), false)
    const result = spawnSync(process.execPath, [
        implementationPath,
        'verify-runtime',
        '--request', path.join(missingRoot, 'request.json'),
        '--rollout', path.join(missingRoot, 'rollout.jsonl'),
        '--machine-observations', path.join(missingRoot, 'observations.json')
    ], {
        cwd: root,
        encoding: 'utf8'
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    assert.notEqual(
        result.status,
        0,
        'required-runtime-cli-no-op: verify-runtime exited 0 for nonexistent inputs'
    )
    assert.notEqual(
        output,
        '',
        'required-runtime-cli-no-op: verify-runtime emitted no rejection diagnostic'
    )
})

test('P11 event ledger cannot start implementation without a verified dispatch receipt', async () => {
    const module = await eventLedgerRuntime()
    const ledger = implementationStartedLedger(undefined)
    await assert.rejects(
        () => module.replayEventLedger(ledger),
        (error) => error?.code === 'verified-dispatch-receipt-required'
    )
})

test('P12 legacy verified-candidate receipt cannot enter candidate-green', async () => {
    const module = await eventLedgerRuntime()
    const { dispatchReceipt } = await verifiedDispatch()
    const ledger = implementationStartedLedger(dispatchReceipt)
    appendLedgerEvent(ledger, {
        actorRole: 'code-implementer',
        attemptId: 'attempt-1818-001',
        eventType: 'implementation.candidate-green',
        fromState: 'implementing-self-testing',
        payload: {
            actorId: 'code-implementer-1818',
            candidateSha,
            receipt: legacyCandidateReceipt()
        },
        toState: 'candidate-green'
    })
    await assert.rejects(
        () => module.replayEventLedger(ledger),
        (error) => error?.code === 'receipt-schema-stage-mismatch'
    )
})

test('P13 self-test receipt cannot replay across candidate/request/epoch identity', async () => {
    const first = await verifiedDispatch({
        candidate: candidateSha,
        overrides: {
            attemptId: 'attempt-1818-replay-a',
            epochId: `${deliveryEpochId}-replay-a`,
            requestId: 'request-1818-replay-a'
        }
    })
    const firstReceipt = await first.module.verifyImplementerSelfTest({
        request: first.request,
        dispatchReceipt: first.dispatchReceipt,
        contract,
        execution: selfTestExecution(first.request),
        priorReceipts: []
    })
    assert.equal(firstReceipt.verificationStatus, 'verified')

    const nextCandidate = 'c'.repeat(40)
    const second = await verifiedDispatch({
        candidate: nextCandidate,
        overrides: {
            attemptId: 'attempt-1818-replay-b',
            candidateDigest: 'd'.repeat(64),
            epochId: `${deliveryEpochId}-replay-b`,
            requestId: 'request-1818-replay-b'
        }
    })
    await assert.rejects(
        () => second.module.authorizeReceiptTransition({
            eventType: 'implementation.candidate-green',
            fromState: 'implementing-self-testing',
            toState: 'candidate-green',
            request: second.request,
            candidateSha: nextCandidate,
            dispatchReceipt: second.dispatchReceipt,
            selfTestReceipt: firstReceipt
        }),
        (error) => error?.code === 'self-test-candidate-mismatch'
    )
})

test('P14 request schema and transition negative controls return stable codes', async (t) => {
    const module = await runtime()
    for (const control of controls.filter(({ surface }) => surface === 'request')) {
        await t.test(control.id, async () => {
            let input = requestInput()
            if (control.id === 'request-field-missing') delete input.promptDigest
            if (control.id === 'request-digest-tampered') input.requestDigest = '0'.repeat(64)
            if (control.id === 'short-base-sha') input.baseSha = '18c6003'
            if (control.id === 'secret-in-request') input.secretToken = 'secret-value'
            if (control.id === 'non-group-id-implicit') delete input.groupId
            if (control.id === 'code-profile-terra-max') {
                input.requestedModel = 'gpt-5.6-terra'
                input.requestedEffort = 'max'
            }
            if (control.id === 'root-profile-wrong') {
                input = requestInput({
                    overrides: {
                        requestedEffort: 'max',
                        requestedModel: 'gpt-5.6-terra',
                        requestedSandbox: 'workspace-write',
                        writePolicy: 'stage-scoped-write-lease'
                    },
                    stageRole: 'root-scheduler'
                })
            }
            await assert.rejects(
                () => module.sealDispatchRequest(input),
                (error) => error?.code === control.expectedCode,
                control.id
            )
        })
    }
    for (const control of controls.filter(({ surface }) => surface === 'transition')) {
        await t.test(control.id, async () => {
            const verified = {
                schema: 'issue-orchestration.dispatch-receipt.v1',
                verificationStatus: 'verified'
            }
            const selfTest = {
                schema: 'issue-orchestration.implementer-self-test-receipt.v1',
                verificationStatus: 'verified'
            }
            const input = {
                eventType: 'implementation.started',
                fromState: 'test-contract-frozen',
                toState: 'implementing-self-testing',
                dispatchReceipt: verified,
                selfTestReceipt: selfTest
            }
            if (control.id === 'start-without-dispatch') delete input.dispatchReceipt
            if (control.id === 'nonverified-dispatch-start') {
                input.dispatchReceipt.verificationStatus = 'rejected'
            }
            if (control.id === 'candidate-without-self-test') {
                input.eventType = 'implementation.candidate-green'
                input.fromState = 'implementing-self-testing'
                input.toState = 'candidate-green'
                delete input.selfTestReceipt
            }
            if (['self-test-used-for-behavior', 'candidate-direct-behavior']
                .includes(control.id)) {
                input.eventType = 'independent-verification.passed'
                input.fromState = 'candidate-green'
                input.toState = 'behavior-green'
                input.behaviorReceipt = input.selfTestReceipt
            }
            if (control.id === 'old-receipt-satisfies-new-stage') {
                input.eventType = 'implementation.candidate-green'
                input.fromState = 'implementing-self-testing'
                input.toState = 'candidate-green'
                input.selfTestReceipt.schema =
                    'issue-orchestration.verified-candidate-receipt.v1'
            }
            await assert.rejects(
                () => module.authorizeReceiptTransition(input),
                (error) => error?.code === control.expectedCode,
                control.id
            )
        })
    }
})

test('P15 candidateDigest drift rejects the runtime dispatch identity', async () => {
    const control = controls.find(({ id }) => id === 'runtime-candidate-digest-drift')
    assert.ok(control)
    await dispatchMutation(control)
})

test('P16 reviewer workspace-write request fails during request sealing', async () => {
    const control = controls.find(({ id }) =>
        id === 'reviewer-write-policy-request-bypass')
    assert.ok(control)
    const module = await runtime()
    const input = requestInput({
        overrides: {
            requestedSandbox: 'workspace-write',
            writePolicy: 'stage-scoped-write-lease'
        },
        stageRole: 'ux-acceptance-verifier'
    })
    let bypassReceipt = null
    let sealingError = null
    try {
        const request = await module.sealDispatchRequest(input)
        const result = await module.verifyRuntimeDispatch({
            request,
            ...evidence(request),
            priorReceipts: []
        })
        bypassReceipt = result.dispatchReceipt
    } catch (error) {
        sealingError = error
    }
    if (bypassReceipt) {
        assert.fail(
            `${control.id}: request sealing accepted; runtime receipt ` +
            `${JSON.stringify(bypassReceipt)}`
        )
    }
    assert.equal(sealingError?.code, control.expectedCode)
})

async function assertInvalidRequestRejected(control, input, mutateRuntimeEvidence = () => {}) {
    const module = await runtime()
    let request
    try {
        request = await module.sealDispatchRequest(input)
    } catch (error) {
        assert.equal(error?.code, control.expectedCode, control.id)
        return
    }
    const runtimeEvidence = evidence(request)
    mutateRuntimeEvidence(runtimeEvidence)
    const { dispatchReceipt } = await module.verifyRuntimeDispatch({
        request,
        ...runtimeEvidence,
        priorReceipts: []
    })
    assert.fail(
        `${control.id}: request sealing accepted; runtime receipt ` +
        `${JSON.stringify(dispatchReceipt)}`
    )
}

test('P17 test-owner unsafe profile request fails during request sealing', async () => {
    const control = controls.find(({ id }) =>
        id === 'test-owner-profile-request-bypass')
    assert.ok(control)
    await assertInvalidRequestRejected(
        control,
        requestInput({
            overrides: {
                requestedModel: 'gpt-5.6-terra',
                requestedEffort: 'low',
                requestedSandbox: 'danger-full-access',
                writePolicy: 'unrestricted'
            },
            stageRole: 'test-owner'
        }),
        ({ rolloutRecords }) => {
            rolloutRecords[1].payload.sandbox_policy = {
                type: 'danger-full-access',
                writable_roots: testOwnerWritableRoots
            }
        }
    )
})

test('P18 non-root DAG unsafe profile request fails during request sealing', async () => {
    const control = controls.find(({ id }) =>
        id === 'non-root-dag-profile-request-bypass')
    assert.ok(control)
    await assertInvalidRequestRejected(
        control,
        requestInput({
            overrides: {
                requestedModel: 'gpt-5.6-terra',
                requestedEffort: 'low',
                requestedSandbox: 'workspace-write',
                writePolicy: 'stage-scoped-write-lease'
            },
            stageRole: 'dag-creator-updater'
        })
    )
})

test('P19 FsusBlog UI dispatch requires design skills and authority digests', async () => {
    const control = controls.find(({ id }) =>
        id === 'ui-required-skills-empty-bypass')
    assert.ok(control)
    await assertInvalidRequestRejected(
        control,
        requestInput({
            overrides: {
                requiredSkills: [],
                designAuthorityDigests: [],
                uiImpact: true
            },
            stageRole: 'ui-ux-implementer'
        })
    )
})

test('P20 credential-bearing runtime observation rejects without echoing secrets', async () => {
    const control = controls.find(({ id }) =>
        id === 'credential-bearing-observation-leak')
    assert.ok(control)
    const module = await runtime()
    const request = await module.sealDispatchRequest(requestInput())
    const runtimeEvidence = evidence(request)
    const credential = 'revision-four-synthetic-credential-do-not-echo'
    const observation = runtimeEvidence.machineObservations[0]
    observation.credential = credential
    const unsigned = clone(observation)
    delete unsigned.observationDigest
    observation.observationDigest = digest(unsigned)
    const result = await module.verifyRuntimeDispatch({
        request,
        ...runtimeEvidence,
        priorReceipts: []
    })
    assert.equal(result.dispatchReceipt.verificationStatus, control.expectedStatus, control.id)
    assert.ok(result.dispatchReceipt.mismatchReasons.includes(control.expectedReason), control.id)
    assert.equal(JSON.stringify(result).includes(credential), false, control.id)
})

test('P21 ordinary frozen contract cannot start without a verified dispatch', async () => {
    const control = controls.find(({ id }) =>
        id === 'ledger-frozen-path-dispatch-bypass')
    assert.ok(control)
    const module = await eventLedgerRuntime()
    const ledger = implementationStartedLedger(undefined, ordinaryFrozenContract())
    await assert.rejects(
        () => module.replayEventLedger(ledger),
        (error) => error?.code === control.expectedCode,
        control.id
    )
})

test('P22 ordinary frozen contract rejects a legacy candidate receipt', async () => {
    const control = controls.find(({ id }) =>
        id === 'ledger-frozen-path-legacy-candidate-bypass')
    assert.ok(control)
    const module = await eventLedgerRuntime()
    const ordinary = ordinaryFrozenContract()
    const { dispatchReceipt } = await verifiedDispatch({
        overrides: { testContractDigest: ordinary.testContractDigest }
    })
    const ledger = implementationStartedLedger(dispatchReceipt, ordinary)
    appendLedgerEvent(ledger, {
        actorRole: 'code-implementer',
        attemptId: 'attempt-1818-001',
        eventType: 'implementation.candidate-green',
        fromState: 'implementing-self-testing',
        payload: {
            actorId: 'code-implementer-1818',
            candidateSha,
            receipt: legacyCandidateReceipt({
                testContractDigest: ordinary.testContractDigest
            })
        },
        toState: 'candidate-green'
    })
    await assert.rejects(
        () => module.replayEventLedger(ledger),
        (error) => error?.code === control.expectedCode,
        control.id
    )
})

test('P23 self-test receipt digest binds diff, command, and failure evidence', async () => {
    const control = controls.find(({ id }) =>
        id === 'self-test-evidence-digest-collision')
    assert.ok(control)
    const { module, request, dispatchReceipt } = await verifiedDispatch()
    const firstExecution = selfTestExecution(request)
    const secondExecution = clone(firstExecution)
    secondExecution.implementationDiffDigest = 'd'.repeat(64)
    for (const result of secondExecution.commandResults) {
        result.resultDigest = digest(`${result.id}:revision-four-alternate`)
    }
    secondExecution.firstFailureRefs = ['evidence://1818/revision-four-alternate-red']
    secondExecution.failureHistory = [
        { ref: secondExecution.firstFailureRefs[0], outcome: 'failed' },
        { ref: 'evidence://1818/revision-four-alternate-green', outcome: 'passed' }
    ]
    const firstReceipt = await module.verifyImplementerSelfTest({
        request,
        dispatchReceipt,
        contract,
        execution: firstExecution,
        priorReceipts: []
    })
    const secondReceipt = await module.verifyImplementerSelfTest({
        request,
        dispatchReceipt,
        contract,
        execution: secondExecution,
        priorReceipts: []
    })
    assert.equal(firstReceipt.verificationStatus, 'verified', control.id)
    assert.equal(secondReceipt.verificationStatus, 'verified', control.id)
    assert.notEqual(firstReceipt.receiptDigest, secondReceipt.receiptDigest, control.id)
})

test('P24 self-test verifier rejects a minimal forged dispatch receipt', async () => {
    const control = controls.find(({ id }) =>
        id === 'self-test-minimal-dispatch-forgery')
    assert.ok(control)
    const module = await runtime()
    const request = await module.sealDispatchRequest(requestInput())
    const forgedDispatchReceipt = {
        schema: 'issue-orchestration.dispatch-receipt.v1',
        verificationStatus: 'verified'
    }
    const result = await module.verifyImplementerSelfTest({
        request,
        dispatchReceipt: forgedDispatchReceipt,
        contract,
        execution: selfTestExecution(request),
        priorReceipts: []
    })
    assert.equal(
        result.verificationStatus,
        control.expectedStatus,
        `${control.id}: ${JSON.stringify(result)}`
    )
    assert.ok(result.mismatchReasons.includes(control.expectedReason), control.id)
})
