import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const implementationPath = resolve(
    root,
    '.agents/skills/issue-orchestration/scripts/frontier-compiler.mjs'
)
const gatePath = resolve(
    root,
    '.agents/skills/issue-orchestration/scripts/check-dag-gate.mjs'
)
const selectorPath = resolve(
    root,
    '.agents/skills/issue-orchestration/scripts/scope-selector.mjs'
)
const fixtureRoot = resolve(root, 'tests/fixtures/issue-orchestration')
const cases = JSON.parse(readFileSync(
    resolve(fixtureRoot, 'ready-frontier-cases.json'),
    'utf8'
))
const mutationControls = JSON.parse(readFileSync(
    resolve(fixtureRoot, 'ready-frontier-mutation-controls.json'),
    'utf8'
)).controls
const acceptanceMap = JSON.parse(readFileSync(
    resolve(fixtureRoot, 'ready-frontier-acceptance-map.json'),
    'utf8'
))
const requiredExports = [
    'computeNodeEligibility',
    'compileReadyFrontier',
    'validateReadyFrontier',
    'selectDispatchCandidates',
    'validateDispatchCandidates'
]

let implementationPromise
let selectorPromise

function sha256(value) {
    return createHash('sha256').update(value).digest('hex')
}

function clone(value) {
    return structuredClone(value)
}

function digest(value) {
    const canonical = (input) => {
        if (Array.isArray(input)) {
            return input
                .map(canonical)
                .sort((left, right) =>
                    JSON.stringify(left).localeCompare(JSON.stringify(right))
                )
        }
        if (!input || typeof input !== 'object') return input
        return Object.fromEntries(
            Object.keys(input).sort().map((key) => [key, canonical(input[key])])
        )
    }
    return sha256(JSON.stringify(canonical(value)))
}

async function implementation() {
    assert.equal(
        existsSync(implementationPath),
        true,
        `missing #1816 frontier compiler: ${implementationPath}`
    )
    implementationPromise ??= import(pathToFileURL(implementationPath).href)
    const loaded = await implementationPromise
    for (const name of requiredExports) {
        assert.equal(typeof loaded[name], 'function', `missing exported function ${name}`)
    }
    return loaded
}

async function selectorImplementation() {
    selectorPromise ??= import(pathToFileURL(selectorPath).href)
    return selectorPromise
}

function remoteIssue(member, index = 0) {
    return {
        repository: member.repository,
        number: member.issueNumber,
        state: 'OPEN',
        stateReason: null,
        updatedAt: `2026-07-31T10:${String(index).padStart(2, '0')}:00.000Z`,
        title: `frontier member ${member.issueId}`,
        body: `Acceptance contract for ${member.issueId}`,
        comments: [
            {
                id: `comment-${member.issueNumber}`,
                body: `Relevant acceptance ${member.issueId}`,
                updatedAt: `2026-07-31T10:${String(index).padStart(2, '0')}:30.000Z`,
                relevant: true
            }
        ],
        labels: ['area:tooling'],
        milestone: null,
        dependsOn: member.dependsOn,
        related: [],
        mentioned: [],
        trackedIssueIds: []
    }
}

function selectorFor(members, version = 'frontier-contract.v1') {
    return {
        schema: 'issue-orchestration.scope-selector.v1',
        selectorVersion: version,
        type: 'explicit-issues',
        repositories: [...new Set(members.map(({ repository }) => repository))],
        statePolicy: {
            open: 'include',
            closed: 'retain-if-explicit',
            reopen: 'retain'
        },
        dependencyClosure: 'none',
        implicitExpansion: 'forbidden',
        parameters: {
            issueIds: members.map(({ issueId }) => issueId)
        },
        remoteQueryIdentity: `fixture:${version}`
    }
}

function investigation(issueId) {
    return {
        status: 'complete',
        checkedAt: '2026-08-01T00:00:00.000Z',
        blockedSince: null,
        ownerId: `investigator:${issueId}`,
        codePaths: [
            '.agents/skills/issue-orchestration/scripts/check-dag-gate.mjs'
        ],
        testPaths: [
            'tests/tools/issue-orchestration-ready-frontier.test.mjs'
        ],
        currentDocs: [
            'docs/development/issue-orchestration-scope.md'
        ],
        constraints: ['member issue plus stage is the eligibility grain']
    }
}

function nodeFor(member, selectorReceipt) {
    const allowedTestPaths = [
        `tests/contracts/${member.issueNumber}.test.mjs`,
        `tests/fixtures/contracts/${member.issueNumber}.json`
    ]
    const allowedImplementationPaths = member.surface === 'ui-ux'
        ? [`src/components/frontier-${member.issueNumber}.tsx`]
        : [`.agents/runtime/frontier-${member.issueNumber}.mjs`]
    return {
        id: member.issueId,
        repository: member.repository,
        issueNumber: member.issueNumber,
        ownerRepository: member.repository,
        baseSha: cases.repositories[member.repository].baseSha,
        acceptanceGroup: `member-${member.issueNumber}`,
        surface: member.surface,
        documentationRequired: true,
        activeDependencies: [...member.dependsOn],
        satisfiedDependencies: [],
        allowedTestPaths,
        allowedImplementationPaths,
        modificationBoundaryDigest: digest({
            allowedImplementationPaths,
            allowedTestPaths
        }),
        investigation: investigation(member.issueId),
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteFactDigest: selectorReceipt.remoteFactDigests[member.issueId],
        status: 'investigated',
        narration: 'Root-authored prose is deliberately non-authoritative.'
    }
}

function receipt(status = 'passed', extra = {}) {
    return {
        status,
        receiptDigest: extra.receiptDigest ?? digest({ status, ...extra }),
        ...extra
    }
}

function roleCandidate(member, stage) {
    const common = {
        issueId: member.issueId,
        stage,
        actorId: `${stage}:${member.issueId}`,
        capabilityReceiptDigest: digest({
            issueId: member.issueId,
            stage,
            capability: true
        })
    }
    if (stage === 'test-contract-ready') {
        return {
            ...common,
            role: 'test-owner',
            model: 'gpt-5.6-sol',
            effort: 'max',
            mode: 'write-tests-only',
            allowedPaths: [
                `tests/contracts/${member.issueNumber}.test.mjs`,
                `tests/fixtures/contracts/${member.issueNumber}.json`
            ]
        }
    }
    if (stage === 'implementation-ready') {
        if (member.surface === 'ui-ux') {
            return {
                ...common,
                role: 'ui-ux-implementer',
                model: 'gpt-5.6-sol',
                effort: 'low',
                mode: 'write-implementation-only',
                allowedPaths: [`src/components/frontier-${member.issueNumber}.tsx`],
                designSkillDigest: 'a'.repeat(64),
                designAuthorityDigests: ['b'.repeat(64)]
            }
        }
        return {
            ...common,
            role: 'code-implementer',
            model: 'gpt-5.6-sol',
            effort: 'low',
            mode: 'write-implementation-only',
            allowedPaths: [`.agents/runtime/frontier-${member.issueNumber}.mjs`]
        }
    }
    if (stage === 'behavior-verification-ready') {
        return {
            ...common,
            role: 'test-owner',
            model: 'gpt-5.6-sol',
            effort: 'max',
            mode: 'read-execute-only',
            allowedPaths: []
        }
    }
    if (stage === 'ux-acceptance-ready') {
        return {
            ...common,
            role: 'ux-acceptance-verifier',
            model: 'gpt-5.6-sol',
            effort: 'max',
            mode: 'read-only',
            allowedPaths: [],
            designSkillDigest: 'a'.repeat(64),
            designAuthorityDigests: ['b'.repeat(64)]
        }
    }
    if (stage === 'documentation-ready') {
        return {
            ...common,
            role: 'documentation-writer',
            model: 'gpt-5.6-luna',
            effort: 'xhigh',
            mode: 'write-docs-only',
            allowedPaths: [`docs/frontier-${member.issueNumber}.md`]
        }
    }
    return {
        ...common,
        role: 'root-scheduler',
        model: 'gpt-5.6-sol',
        effort: 'low',
        mode: 'root-only',
        allowedPaths: []
    }
}

function runtimeFor(members) {
    return {
        schema: 'issue-orchestration.frontier-runtime.v1',
        repositoryBases: Object.fromEntries(
            Object.entries(cases.repositories).map(([repository, facts]) => [
                repository,
                facts.baseSha
            ])
        ),
        nodeStates: Object.fromEntries(members.map(({ issueId }) => [
            issueId,
            {
                receipts: {},
                terminal: null
            }
        ])),
        activeAttempts: [],
        deliveryFreezes: [],
        exclusiveLeases: [],
        candidates: members.flatMap((member) =>
            cases.stages.map((stage) => roleCandidate(member, stage))
        ),
        remoteFacts: {
            fresh: true,
            observedAt: '2026-08-01T00:00:00.000Z'
        },
        availableSlots: 15,
        rootOnlyDeliveryAction: null
    }
}

async function scenario(
    members = cases.canonicalMembers,
    {
        remoteIssues = members.map(remoteIssue),
        selector = selectorFor(members),
        resolvedAt = '2026-08-01T00:00:00.000Z'
    } = {}
) {
    const { resolveSelector } = await selectorImplementation()
    const selectorReceipt = resolveSelector({
        selector: clone(selector),
        remoteIssues: clone(remoteIssues),
        resolvedAt
    })
    const dag = {
        schema: 'issue-orchestration.dag.v3',
        selectorReceiptDigest: selectorReceipt.receiptDigest,
        remoteSnapshotDigest: selectorReceipt.remoteSnapshotDigest,
        nodes: members.map((member) => nodeFor(member, selectorReceipt))
    }
    const runtimeState = runtimeFor(members)
    runtimeState.remoteFacts.selectorReceiptDigest = selectorReceipt.receiptDigest
    runtimeState.remoteFacts.remoteSnapshotDigest =
        selectorReceipt.remoteSnapshotDigest
    const uiMember = members.find(({ surface }) => surface === 'ui-ux')
    if (uiMember) {
        runtimeState.nodeStates[uiMember.issueId].receipts.testContract =
            receipt('passed', {
                testOwnerId: 'test-owner-ui',
                testContractDigest: 'c'.repeat(64)
            })
    }
    return {
        dag,
        members: clone(members),
        remoteIssues: clone(remoteIssues),
        runtimeState,
        selector: clone(selector),
        selectorReceipt
    }
}

async function compile(input, computedAt = cases.computedAt) {
    const { compileReadyFrontier } = await implementation()
    return compileReadyFrontier({
        dag: clone(input.dag),
        runtimeState: clone(input.runtimeState),
        selectorReceipt: clone(input.selectorReceipt),
        computedAt
    })
}

function readyKey(candidate) {
    return `${candidate.issueId}@${candidate.stage}`
}

function assertDigest(value, label) {
    assert.match(value, /^[a-f0-9]{64}$/u, `${label} must be lowercase SHA-256`)
}

function assertCanonicalProjection(projection) {
    assert.equal(projection.schema, 'issue-orchestration.frontier-projection.v1')
    assertDigest(projection.eligibilityInputDigest, 'eligibilityInputDigest')
    assertDigest(projection.frontierDigest, 'frontierDigest')
    assert.ok(Array.isArray(projection.readyFrontier))
    assert.ok(Array.isArray(projection.executionProjection))
    assert.deepEqual(
        projection.readyFrontier.map(readyKey),
        projection.readyFrontier.map(readyKey).toSorted()
    )
    assert.equal(typeof projection.notReadyReasons, 'object')
    assert.ok(projection.notReadyReasons && !Array.isArray(projection.notReadyReasons))
    for (const reasons of Object.values(projection.notReadyReasons)) {
        assert.ok(Array.isArray(reasons) && reasons.length > 0)
        const indexes = reasons.map(({ code }) => cases.reasonOrder.indexOf(code))
        assert.ok(indexes.every((index) => index >= 0))
        assert.deepEqual(indexes, indexes.toSorted((left, right) => left - right))
        for (const reason of reasons) {
            assert.equal(typeof reason.evidence, 'object')
            assert.ok(reason.evidence && !Array.isArray(reason.evidence))
            assert.ok(
                typeof reason.evidence.identity === 'string'
                || /^[a-f0-9]{64}$/u.test(reason.evidence.digest ?? ''),
                `${reason.code} must bind direct evidence or identity`
            )
        }
    }
}

async function expectDenied(operation, expectedCode) {
    try {
        const result = await operation()
        assert.equal(result?.valid, false, `expected denial ${expectedCode}`)
        assert.equal(result.code, expectedCode)
        return result
    } catch (error) {
        assert.equal(error?.code, expectedCode, error?.stack ?? String(error))
        return error
    }
}

async function validateFrontier(input, recordedProjection) {
    const { validateReadyFrontier } = await implementation()
    return validateReadyFrontier({
        dag: clone(input.dag),
        runtimeState: clone(input.runtimeState),
        selectorReceipt: clone(input.selectorReceipt),
        recordedProjection: clone(recordedProjection)
    })
}

async function selectDispatch(input, projection, groupProposals = []) {
    const { selectDispatchCandidates } = await implementation()
    return selectDispatchCandidates({
        projection: clone(projection),
        runtimeState: clone(input.runtimeState),
        groupProposals: clone(groupProposals)
    })
}

async function validateDispatch(input, projection, recordedCandidateSet, groupProposals = []) {
    const { validateDispatchCandidates } = await implementation()
    return validateDispatchCandidates({
        projection: clone(projection),
        runtimeState: clone(input.runtimeState),
        groupProposals: clone(groupProposals),
        recordedCandidateSet: clone(recordedCandidateSet)
    })
}

function independentMembers(count, repository = 'Ozwasyd/FsusBlog') {
    return Array.from({ length: count }, (_, index) => ({
        issueId: `${repository}#${9200 + index}`,
        repository,
        issueNumber: 9200 + index,
        surface: 'code',
        dependsOn: []
    }))
}

function setProgress(runtimeState, issueId, completedReceipts) {
    const receipts = {}
    for (const name of completedReceipts) {
        receipts[name] = receipt('passed', {
            testOwnerId: name === 'testContract' ? 'test-owner-1' : undefined,
            testContractDigest: name === 'testContract' ? 'd'.repeat(64) : undefined,
            candidateDigest: name === 'implementation' ? 'e'.repeat(64) : undefined
        })
    }
    runtimeState.nodeStates[issueId].receipts = receipts
}

test('contract fixtures cover every acceptance and mutation identity', () => {
    assert.equal(cases.schema, 'issue-orchestration.ready-frontier-cases.v1')
    assert.deepEqual(cases.reasonOrder, [
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
    ])
    assert.equal(new Set(cases.stages).size, 7)
    assert.equal(new Set(mutationControls.map(({ id }) => id)).size, mutationControls.length)
    const mapped = new Set(
        acceptanceMap.acceptance.flatMap(({ mutations }) => mutations)
    )
    assert.deepEqual(
        [...mapped].sort(),
        mutationControls.map(({ id }) => id).sort()
    )
})

test('[F01] compiler emits the canonical maximal member-stage projection', async () => {
    const input = await scenario()
    const projection = await compile(input)
    assertCanonicalProjection(projection)
    assert.deepEqual(
        projection.readyFrontier,
        cases.expectedCanonicalReadyFrontier
    )
    assert.deepEqual(
        Object.fromEntries(Object.entries(projection.notReadyReasons).map(
            ([issueId, reasons]) => [issueId, reasons.map(({ code }) => code)]
        )),
        cases.expectedCanonicalNotReady
    )
    const validation = await validateFrontier(input, projection)
    assert.equal(validation.valid, true)
})

test('[F02] issue, dependency, candidate, and traversal order do not affect digests', async () => {
    const input = await scenario()
    const original = await compile(input, cases.computedAt)
    const reordered = clone(input)
    reordered.dag.nodes.reverse()
    for (const node of reordered.dag.nodes) {
        node.activeDependencies.reverse()
        node.allowedTestPaths.reverse()
        node.allowedImplementationPaths.reverse()
    }
    reordered.runtimeState.candidates.reverse()
    const replay = await compile(reordered, cases.laterComputedAt)
    assert.deepEqual(replay.readyFrontier, original.readyFrontier)
    assert.deepEqual(replay.notReadyReasons, original.notReadyReasons)
    assert.equal(replay.eligibilityInputDigest, original.eligibilityInputDigest)
    assert.equal(replay.frontierDigest, original.frontierDigest)
})

test('[F03] all eleven blocker reasons are stable and directly evidence-bound', async (current) => {
    const reasonCases = {
        'dependency-unsatisfied': async () => scenario(),
        'investigation-incomplete': async () => {
            const input = await scenario(independentMembers(1))
            input.dag.nodes[0].investigation = {
                status: 'incomplete',
                checkedAt: cases.computedAt,
                blockedSince: '2026-07-31T23:00:00.000Z',
                ownerId: 'investigation-owner-1',
                codePaths: [],
                testPaths: [],
                currentDocs: [],
                constraints: []
            }
            return input
        },
        'owner-unresolved': async () => {
            const input = await scenario(independentMembers(1))
            delete input.dag.nodes[0].ownerRepository
            return input
        },
        'base-drift': async () => {
            const input = await scenario(independentMembers(1))
            input.runtimeState.repositoryBases['Ozwasyd/FsusBlog'] = 'f'.repeat(40)
            return input
        },
        'scope-drift': async () => {
            const input = await scenario(independentMembers(1))
            input.dag.nodes[0].remoteFactDigest = 'f'.repeat(64)
            return input
        },
        'active-attempt': async () => {
            const input = await scenario(independentMembers(1))
            input.runtimeState.activeAttempts.push({
                attemptId: 'attempt-1',
                issueId: input.dag.nodes[0].id,
                stage: 'test-contract-ready',
                leaseId: 'lease-attempt-1'
            })
            return input
        },
        'terminal-unchanged': async () => {
            const input = await scenario(independentMembers(1))
            input.runtimeState.nodeStates[input.dag.nodes[0].id].terminal = {
                category: 'externally_blocked',
                recoveryFingerprint: 'terminal-fingerprint-1',
                observedRecoveryFingerprint: 'terminal-fingerprint-1',
                evidenceDigest: '1'.repeat(64)
            }
            return input
        },
        'runtime-capability-missing': async () => {
            const input = await scenario(independentMembers(1))
            input.runtimeState.candidates = []
            return input
        },
        'delivery-frozen': async () => {
            const input = await scenario(independentMembers(1))
            input.runtimeState.deliveryFreezes.push({
                freezeId: 'delivery-freeze-1',
                issueIds: [input.dag.nodes[0].id],
                evidenceDigest: '2'.repeat(64)
            })
            return input
        },
        'exclusive-lease-held': async () => {
            const input = await scenario(independentMembers(1))
            input.runtimeState.exclusiveLeases.push({
                leaseId: 'exclusive-lease-1',
                issueId: input.dag.nodes[0].id,
                holderIssueId: 'Ozwasyd/FsusBlog#9999',
                conflictKey: 'orchestration-schema'
            })
            return input
        },
        'remote-facts-stale': async () => {
            const input = await scenario(independentMembers(1))
            input.runtimeState.remoteFacts.fresh = false
            return input
        }
    }

    for (const reason of cases.reasonOrder) {
        await current.test(reason, async () => {
            const input = await reasonCases[reason]()
            const projection = await compile(input)
            const issueId = reason === 'dependency-unsatisfied'
                ? 'Ozwasyd/FsusBlog#9102'
                : input.dag.nodes[0].id
            const emitted = projection.notReadyReasons[issueId]
            assert.ok(emitted, `${reason} was not emitted`)
            const observed = emitted.find(({ code }) => code === reason)
            assert.ok(observed, JSON.stringify(emitted, null, 2))
            assert.ok(
                typeof observed.evidence.identity === 'string'
                || /^[a-f0-9]{64}$/u.test(observed.evidence.digest ?? '')
            )
        })
    }
})

test('[F04] multiple blocker reasons follow the frozen canonical reason order', async () => {
    const input = await scenario(independentMembers(1))
    const issueId = input.dag.nodes[0].id
    delete input.dag.nodes[0].ownerRepository
    input.dag.nodes[0].investigation.status = 'incomplete'
    input.dag.nodes[0].investigation.blockedSince = '2026-07-31T23:00:00.000Z'
    input.runtimeState.repositoryBases['Ozwasyd/FsusBlog'] = 'f'.repeat(40)
    input.runtimeState.candidates = []
    input.runtimeState.remoteFacts.fresh = false
    const projection = await compile(input)
    assert.deepEqual(
        projection.notReadyReasons[issueId].map(({ code }) => code),
        [
            'investigation-incomplete',
            'owner-unresolved',
            'base-drift',
            'runtime-capability-missing',
            'remote-facts-stale'
        ]
    )
})

test('[F05] the validator independently rejects root-edited frontier and reasons', async () => {
    const input = await scenario()
    const projection = await compile(input)
    const omitted = clone(projection)
    omitted.readyFrontier.shift()
    await expectDenied(
        () => validateFrontier(input, omitted),
        'frontier-projection-mismatch'
    )
    const editedReason = clone(projection)
    editedReason.notReadyReasons['Ozwasyd/FsusBlog#9102'][0].code =
        'investigation-incomplete'
    await expectDenied(
        () => validateFrontier(input, editedReason),
        'frontier-projection-mismatch'
    )
})

test('[F06] an empty frontier is proven by complete blocker coverage', async () => {
    const input = await scenario(independentMembers(3))
    for (const node of input.dag.nodes) {
        node.investigation.status = 'incomplete'
        node.investigation.blockedSince = '2026-07-31T23:00:00.000Z'
    }
    const projection = await compile(input)
    assert.deepEqual(projection.readyFrontier, [])
    assert.deepEqual(
        Object.keys(projection.notReadyReasons).sort(),
        input.dag.nodes.map(({ id }) => id).sort()
    )
})

test('[F07] valid completed tombstones unlock and reopen removes dependents', async () => {
    const dependent = {
        issueId: 'Ozwasyd/FsusBlog#9301',
        repository: 'Ozwasyd/FsusBlog',
        issueNumber: 9301,
        surface: 'code',
        dependsOn: ['Ozwasyd/FsusBlog#9300']
    }
    const input = await scenario([dependent])
    input.dag.nodes[0].activeDependencies = []
    input.dag.nodes[0].satisfiedDependencies = [{
        issue: 'Ozwasyd/FsusBlog#9300',
        repository: 'Ozwasyd/FsusBlog',
        issueNumber: 9300,
        remoteState: 'CLOSED',
        stateReason: 'completed',
        evidenceDigest: '3'.repeat(64),
        deliveredCommit: cases.repositories['Ozwasyd/FsusBlog'].baseSha
    }]
    const unlocked = await compile(input)
    assert.deepEqual(unlocked.readyFrontier, [{
        issueId: dependent.issueId,
        stage: 'test-contract-ready'
    }])
    input.dag.nodes[0].satisfiedDependencies[0].remoteState = 'OPEN'
    input.dag.nodes[0].satisfiedDependencies[0].stateReason = null
    const reopened = await compile(input)
    assert.deepEqual(reopened.readyFrontier, [])
    assert.deepEqual(
        reopened.notReadyReasons[dependent.issueId].map(({ code }) => code),
        ['dependency-unsatisfied']
    )
})

test('[F08] remote, base, terminal, and candidate permission drift invalidate old input', async () => {
    const input = await scenario(independentMembers(1))
    const projection = await compile(input)
    const drifts = [
        (changed) => {
            changed.runtimeState.repositoryBases['Ozwasyd/FsusBlog'] = 'f'.repeat(40)
        },
        (changed) => {
            changed.runtimeState.candidates[0].allowedPaths.push('tests/forbidden.test.mjs')
        },
        (changed) => {
            changed.runtimeState.nodeStates[changed.dag.nodes[0].id].terminal = {
                category: 'externally_blocked',
                recoveryFingerprint: 'before',
                observedRecoveryFingerprint: 'after',
                evidenceDigest: '4'.repeat(64)
            }
        }
    ]
    for (const mutate of drifts) {
        const changed = clone(input)
        mutate(changed)
        await expectDenied(
            () => validateFrontier(changed, projection),
            'frontier-input-digest-mismatch'
        )
    }

    const changedIssues = clone(input.remoteIssues)
    changedIssues[0].comments[0].body += ' changed'
    const changed = await scenario(input.members, {
        remoteIssues: changedIssues,
        selector: {
            ...input.selector,
            selectorVersion: 'frontier-contract.v2'
        }
    })
    await expectDenied(
        () => validateFrontier(changed, projection),
        'frontier-input-digest-mismatch'
    )
})

test('[S01] non-UI stage progression is deterministic through cleanup', async () => {
    const input = await scenario(independentMembers(1))
    const issueId = input.dag.nodes[0].id
    const progression = [
        [[], 'test-contract-ready'],
        [['testContract'], 'implementation-ready'],
        [['testContract', 'implementation'], 'behavior-verification-ready'],
        [['testContract', 'implementation', 'behavior'], 'documentation-ready'],
        [['testContract', 'implementation', 'behavior', 'documentation'], 'delivery-ready'],
        [['testContract', 'implementation', 'behavior', 'documentation', 'delivery'], 'cleanup-ready']
    ]
    for (const [receipts, expectedStage] of progression) {
        setProgress(input.runtimeState, issueId, receipts)
        const projection = await compile(input)
        assert.deepEqual(projection.readyFrontier, [{
            issueId,
            stage: expectedStage
        }])
    }
    setProgress(input.runtimeState, issueId, [
        'testContract',
        'implementation',
        'behavior',
        'documentation',
        'delivery',
        'cleanup'
    ])
    const closed = await compile(input)
    assert.deepEqual(closed.readyFrontier, [])
    assert.deepEqual(closed.notReadyReasons, {})
})

test('[S02] UI behavior green advances only to UX acceptance, then documentation', async () => {
    const member = {
        issueId: 'Ozwasyd/FsusUI#2950',
        repository: 'Ozwasyd/FsusUI',
        issueNumber: 2950,
        surface: 'ui-ux',
        dependsOn: []
    }
    const input = await scenario([member])
    setProgress(input.runtimeState, member.issueId, [
        'testContract',
        'implementation',
        'behavior'
    ])
    const beforeUx = await compile(input)
    assert.deepEqual(beforeUx.readyFrontier, [{
        issueId: member.issueId,
        stage: 'ux-acceptance-ready'
    }])
    setProgress(input.runtimeState, member.issueId, [
        'testContract',
        'implementation',
        'behavior',
        'uxAcceptance'
    ])
    const afterUx = await compile(input)
    assert.deepEqual(afterUx.readyFrontier, [{
        issueId: member.issueId,
        stage: 'documentation-ready'
    }])
})

test('[S03] local stage progress changes execution frontier without semantic DAG update', async () => {
    const input = await scenario(independentMembers(1))
    const first = await compile(input)
    setProgress(input.runtimeState, input.dag.nodes[0].id, ['testContract'])
    const second = await compile(input)
    assert.notEqual(second.frontierDigest, first.frontierDigest)
    assert.equal(
        input.selectorReceipt.remoteSnapshotDigest,
        input.dag.remoteSnapshotDigest
    )
    const { evaluateDagUpdate } = await selectorImplementation()
    const update = evaluateDagUpdate({
        previousRemoteSnapshotDigest: input.selectorReceipt.remoteSnapshotDigest,
        currentReceipt: input.selectorReceipt,
        executionEvents: [{ type: 'local-stage-progressed' }],
        launchRequest: null
    })
    assert.equal(update.semanticAction, 'none')
    assert.equal(update.dagUpdateRequired, false)
})

test('[R01] wrong test-owner runtime identity is a capability blocker', async () => {
    const input = await scenario(independentMembers(1))
    const candidate = input.runtimeState.candidates.find(
        ({ stage }) => stage === 'test-contract-ready'
    )
    candidate.effort = 'low'
    const projection = await compile(input)
    assert.deepEqual(
        projection.notReadyReasons[input.dag.nodes[0].id].map(({ code }) => code),
        ['runtime-capability-missing']
    )
})

test('[R02] UI implementation rejects ordinary code role or missing design authority', async () => {
    const member = {
        issueId: 'Ozwasyd/FsusUI#2951',
        repository: 'Ozwasyd/FsusUI',
        issueNumber: 2951,
        surface: 'ui-ux',
        dependsOn: []
    }
    const input = await scenario([member])
    const candidate = input.runtimeState.candidates.find(
        ({ stage }) => stage === 'implementation-ready'
    )
    candidate.role = 'code-implementer'
    delete candidate.designSkillDigest
    delete candidate.designAuthorityDigests
    const projection = await compile(input)
    assert.deepEqual(
        projection.notReadyReasons[member.issueId].map(({ code }) => code),
        ['runtime-capability-missing']
    )
})

test('[D01] fifteen eligible members fill fifteen available slots', async () => {
    const input = await scenario(independentMembers(15))
    input.runtimeState.availableSlots = 15
    const projection = await compile(input)
    const candidates = await selectDispatch(input, projection)
    assert.equal(projection.readyFrontier.length, 15)
    assert.equal(candidates.dispatchCandidates.length, 15)
})

test('[D02] N eligible members produce exactly N candidates', async () => {
    const input = await scenario(independentMembers(4))
    input.runtimeState.availableSlots = 15
    const projection = await compile(input)
    const candidates = await selectDispatch(input, projection)
    assert.equal(candidates.dispatchCandidates.length, 4)
    assert.deepEqual(candidates.dispatchCandidates, projection.readyFrontier)
})

test('[D03] root-only delivery action is the sole permitted ready-work empty batch', async () => {
    const input = await scenario(independentMembers(2))
    input.runtimeState.rootOnlyDeliveryAction = {
        actionId: 'delivery-window-1',
        evidenceDigest: '5'.repeat(64)
    }
    const projection = await compile(input)
    const candidates = await selectDispatch(input, projection)
    assert.deepEqual(candidates.dispatchCandidates, [])
    assert.equal(candidates.noDispatchReason.code, 'root-only-delivery-action')
    assert.equal(
        candidates.noDispatchReason.evidence.identity,
        'delivery-window-1'
    )
})

test('[G01] group ready cannot mask a blocked member', async () => {
    const input = await scenario()
    const projection = await compile(input)
    const groupProposals = [{
        groupId: 'group-1',
        repository: 'Ozwasyd/FsusBlog',
        memberIssueIds: [
            'Ozwasyd/FsusBlog#9101',
            'Ozwasyd/FsusBlog#9102'
        ],
        eligible: true
    }]
    const selected = await selectDispatch(input, projection, groupProposals)
    assert.equal(
        selected.dispatchCandidates.some(
            ({ issueId }) => issueId === 'Ozwasyd/FsusBlog#9102'
        ),
        false
    )
})

test('[G02] group green cannot advance an individually failed member', async () => {
    const input = await scenario(independentMembers(2))
    const failedId = input.dag.nodes[1].id
    setProgress(input.runtimeState, failedId, [
        'testContract',
        'implementation'
    ])
    input.runtimeState.nodeStates[failedId].receipts.behavior =
        receipt('failed', { failureDigest: '6'.repeat(64) })
    const projection = await compile(input)
    assert.equal(
        projection.readyFrontier.some(
            ({ issueId, stage }) =>
                issueId === failedId && stage === 'delivery-ready'
        ),
        false
    )
})

test('[G03] ineligible grouping falls back without serializing independent members', async () => {
    const input = await scenario(independentMembers(2))
    const projection = await compile(input)
    const groupProposals = [{
        groupId: 'bad-group',
        repository: 'Ozwasyd/FsusBlog',
        memberIssueIds: input.dag.nodes.map(({ id }) => id),
        eligible: false,
        denialCode: 'independent-low-conflict-members'
    }]
    const selected = await selectDispatch(input, projection, groupProposals)
    assert.equal(selected.dispatchCandidates.length, 2)
    assert.deepEqual(selected.dispatchCandidates, projection.readyFrontier)
})

test('mutation catalog and executable controls are exact-set equal', () => {
    assert.deepEqual(
        mutationControls.map(({ id }) => id).sort(),
        [
            'eligible-member-omitted',
            'blocked-member-overreported',
            'free-text-reason',
            'reason-code-or-evidence-modified',
            'non-current-stage-dispatched',
            'frontier-digest-forged',
            'remote-comment-drift',
            'base-sha-drift',
            'selector-member-omitted',
            'terminal-fingerprint-changed',
            'candidate-permission-drift',
            'ready-slots-empty-batch',
            'group-ready-masks-blocked-member',
            'group-green-masks-member-failure',
            'group-serializes-independent-members'
        ].sort()
    )
})

for (const control of mutationControls) {
    test(`MUTATION ${control.id} is killed with ${control.expectedCode}`, async () => {
        if (control.id === 'selector-member-omitted') {
            const input = await scenario(independentMembers(2))
            input.dag.nodes.pop()
            await expectDenied(() => compile(input), control.expectedCode)
            return
        }

        if (control.surface === 'frontier') {
            const input = await scenario()
            const projection = await compile(input)
            if (control.id === 'eligible-member-omitted') {
                projection.readyFrontier.shift()
            } else if (control.id === 'blocked-member-overreported') {
                projection.readyFrontier.push({
                    issueId: 'Ozwasyd/FsusBlog#9102',
                    stage: 'test-contract-ready'
                })
            } else if (control.id === 'free-text-reason') {
                projection.notReadyReasons['Ozwasyd/FsusBlog#9102'] =
                    '暂时不处理'
            } else if (control.id === 'reason-code-or-evidence-modified') {
                projection.notReadyReasons['Ozwasyd/FsusBlog#9102'][0]
                    .evidence.identity = 'root-authored'
            } else if (control.id === 'frontier-digest-forged') {
                projection.frontierDigest = 'f'.repeat(64)
            }
            await expectDenied(
                () => validateFrontier(input, projection),
                control.expectedCode
            )
            return
        }

        if (control.surface === 'input') {
            const input = await scenario(independentMembers(1))
            if (control.id === 'terminal-fingerprint-changed') {
                input.runtimeState.nodeStates[input.dag.nodes[0].id].terminal = {
                    category: 'externally_blocked',
                    recoveryFingerprint: 'same',
                    observedRecoveryFingerprint: 'same',
                    evidenceDigest: '7'.repeat(64)
                }
            }
            const projection = await compile(input)
            if (control.id === 'base-sha-drift') {
                input.runtimeState.repositoryBases['Ozwasyd/FsusBlog'] =
                    'f'.repeat(40)
            } else if (control.id === 'candidate-permission-drift') {
                input.runtimeState.candidates[0].allowedPaths.push(
                    'tests/forbidden.test.mjs'
                )
            } else if (control.id === 'terminal-fingerprint-changed') {
                input.runtimeState.nodeStates[input.dag.nodes[0].id]
                    .terminal.observedRecoveryFingerprint = 'changed'
            } else if (control.id === 'remote-comment-drift') {
                input.selectorReceipt.remoteFactDigests[input.dag.nodes[0].id] =
                    'f'.repeat(64)
                input.selectorReceipt.remoteSnapshotDigest = 'e'.repeat(64)
            }
            await expectDenied(
                () => validateFrontier(input, projection),
                control.expectedCode
            )
            return
        }

        const input = control.id === 'group-serializes-independent-members'
            ? await scenario(independentMembers(2))
            : await scenario()
        const projection = await compile(input)
        const groupProposals = control.id.startsWith('group-')
            ? [{
                groupId: 'mutant-group',
                repository: 'Ozwasyd/FsusBlog',
                memberIssueIds: input.dag.nodes.map(({ id }) => id),
                eligible: control.id !== 'group-serializes-independent-members'
            }]
            : []
        const recorded = await selectDispatch(input, projection, groupProposals)
        if (control.id === 'non-current-stage-dispatched') {
            recorded.dispatchCandidates[0].stage = 'implementation-ready'
        } else if (control.id === 'ready-slots-empty-batch') {
            recorded.dispatchCandidates = []
            recorded.noDispatchReason = null
        } else if (control.id === 'group-ready-masks-blocked-member') {
            recorded.dispatchCandidates.push({
                issueId: 'Ozwasyd/FsusBlog#9102',
                stage: 'test-contract-ready'
            })
        } else if (control.id === 'group-green-masks-member-failure') {
            recorded.dispatchCandidates.push({
                issueId: 'Ozwasyd/FsusBlog#9102',
                stage: 'delivery-ready'
            })
        } else if (control.id === 'group-serializes-independent-members') {
            recorded.dispatchCandidates = recorded.dispatchCandidates.slice(0, 1)
        }
        await expectDenied(
            () => validateDispatch(
                input,
                projection,
                recorded,
                groupProposals
            ),
            control.expectedCode
        )
    })
}

test('check-dag-gate is the runtime consumer of the compiler validator', async () => {
    await implementation()
    const source = readFileSync(gatePath, 'utf8')
    assert.match(source, /frontier-compiler\.mjs/u)
    assert.match(source, /validateReadyFrontier/u)
})
