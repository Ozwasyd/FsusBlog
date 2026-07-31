import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const implementationPath = path.join(
    root,
    '.agents/skills/issue-orchestration/scripts/event-ledger.mjs'
)
const fixturesRoot = path.join(root, 'tests/fixtures/issue-orchestration')
const acceptance = readJson('event-ledger-acceptance-map.json')
const controls = readJson('event-ledger-mutation-controls.json').controls
const runtimeProbes = readJson('event-ledger-runtime-probes.json').probes
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-event-ledger-contract-'))

const runId = 'run-1817-contract'
const nodeId = 'FsusBlog#1817'
const baseSha = '7f75d2a04d9eeaf65af0b4b0db5a572bdec25150'
const candidateSha = '1'.repeat(40)
const issueSnapshotFingerprint = '2'.repeat(64)
const repositoryFingerprint = '3'.repeat(64)
const sourceDagDigest = '4'.repeat(64)
const testContractDigest = '5'.repeat(64)
const genesisDigest = '0'.repeat(64)
const implementationActorId = 'code-implementer-1817'
const testOwnerActorId = 'test-owner-1817'
const uxActorId = 'ux-verifier-1817'

after(() => fs.rmSync(scratch, { force: true, recursive: true }))

function readJson(name) {
    return JSON.parse(fs.readFileSync(path.join(fixturesRoot, name), 'utf8'))
}

function normalizeJson(value) {
    if (Array.isArray(value)) return value.map(normalizeJson)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, normalizeJson(value[key])])
    )
}

function digest(value) {
    const source = typeof value === 'string'
        ? value
        : JSON.stringify(normalizeJson(value))
    return createHash('sha256').update(source).digest('hex')
}

function header(stateRootCanonical = path.join(scratch, 'state')) {
    return {
        schema: 'issue-orchestration.ledger.v1',
        runId,
        stateRootCanonical,
        baseSha,
        issueSnapshotFingerprint,
        repositoryFingerprint,
        createdAt: '2026-08-01T00:00:00.000Z'
    }
}

function emptyLedger() {
    return {
        header: header(),
        events: []
    }
}

function verifiedReceipt({
    actorId,
    actorRole,
    fresh = true,
    modifiedPaths = [],
    selfTestCycles = [],
    status = 'passed',
    visibleMatrixComplete = true
}) {
    const receipt = {
        schema: 'issue-orchestration.verified-candidate-receipt.v1',
        actorId,
        actorRole,
        candidateSha,
        testContractDigest,
        fresh,
        modifiedPaths,
        selfTestCycles,
        status,
        visibleMatrixComplete
    }
    return {
        ...receipt,
        receiptDigest: digest(receipt)
    }
}

function sealEvent(ledger, {
    actorRole = 'root-scheduler',
    attemptId = null,
    eventId = `event-${String(ledger.events.length + 1).padStart(3, '0')}`,
    eventType,
    evidenceRefs = [`evidence://${eventType}`],
    fromState,
    node = nodeId,
    payload = {},
    toState
}) {
    const event = {
        schema: 'issue-orchestration.event.v1',
        eventId,
        sequence: ledger.events.length + 1,
        runId,
        nodeId: node,
        eventType,
        fromState,
        toState,
        attemptId,
        actorRole,
        sourceDagDigest,
        issueSnapshotFingerprint,
        repositoryFingerprint,
        baseSha,
        payload,
        payloadDigest: digest(payload),
        evidenceRefs,
        createdAt: new Date(Date.parse('2026-08-01T00:00:00.000Z') + ledger.events.length * 1000).toISOString(),
        previousEventDigest: ledger.events.at(-1)?.eventDigest ?? genesisDigest
    }
    event.eventDigest = digest(event)
    ledger.events.push(event)
    return event
}

function resealFrom(ledger, start = 0) {
    for (let index = start; index < ledger.events.length; index += 1) {
        const event = ledger.events[index]
        event.sequence = index + 1
        event.previousEventDigest = index === 0
            ? genesisDigest
            : ledger.events[index - 1].eventDigest
        event.payloadDigest = digest(event.payload)
        delete event.eventDigest
        event.eventDigest = digest(event)
    }
    return ledger
}

function clone(value) {
    return structuredClone(value)
}

function discoveredLedger({ issueKind = 'code' } = {}) {
    const ledger = emptyLedger()
    sealEvent(ledger, {
        actorRole: 'dag-updater',
        eventType: 'node.discovered',
        fromState: 'none',
        payload: {
            issueKind,
            proposalReceipt: verifiedReceipt({
                actorId: 'dag-updater-1817',
                actorRole: 'dag-updater'
            })
        },
        toState: 'discovered'
    })
    return ledger
}

function frozenLedger(options = {}) {
    const ledger = discoveredLedger(options)
    sealEvent(ledger, {
        actorRole: 'test-owner',
        eventType: 'test-contract.started',
        fromState: 'discovered',
        payload: { actorId: testOwnerActorId },
        toState: 'test-contracting'
    })
    sealEvent(ledger, {
        actorRole: 'test-owner',
        eventType: 'test-contract.frozen',
        fromState: 'test-contracting',
        payload: {
            actorId: testOwnerActorId,
            frozenFiles: [
                {
                    path: 'tests/tools/issue-orchestration-event-ledger.test.mjs',
                    sha256: '6'.repeat(64)
                }
            ],
            testContractDigest
        },
        toState: 'test-contract-frozen'
    })
    return ledger
}

function implementingLedger(options = {}) {
    const ledger = frozenLedger(options)
    sealEvent(ledger, {
        actorRole: options.issueKind === 'ui-ux'
            ? 'ui-ux-implementer'
            : 'code-implementer',
        attemptId: 'attempt-1817-001',
        eventType: 'implementation.started',
        fromState: 'test-contract-frozen',
        payload: {
            actorId: implementationActorId,
            effort: 'low',
            model: 'gpt-5.6-sol',
            ownerContinuationId: 'implementation-owner-1817'
        },
        toState: 'implementing-self-testing'
    })
    return ledger
}

function candidateLedger(options = {}) {
    const ledger = implementingLedger(options)
    const actorRole = options.issueKind === 'ui-ux'
        ? 'ui-ux-implementer'
        : 'code-implementer'
    sealEvent(ledger, {
        actorRole,
        attemptId: 'attempt-1817-001',
        eventType: 'implementation.candidate-green',
        fromState: 'implementing-self-testing',
        payload: {
            actorId: implementationActorId,
            candidateSha,
            receipt: verifiedReceipt({
                actorId: implementationActorId,
                actorRole,
                selfTestCycles: [
                    { cycle: 1, outcome: 'failed', signature: 'expected-red' },
                    { cycle: 2, outcome: 'failed', signature: 'implementation-defect' },
                    { cycle: 3, outcome: 'passed', signature: null }
                ]
            }),
            reworkCount: 0
        },
        toState: 'candidate-green'
    })
    return ledger
}

function behaviorGreenLedger(options = {}) {
    const ledger = candidateLedger(options)
    sealEvent(ledger, {
        actorRole: 'test-owner',
        attemptId: 'attempt-1817-001',
        eventType: 'independent-verification.started',
        fromState: 'candidate-green',
        payload: {
            actorId: testOwnerActorId,
            candidateSha,
            independentOfActorId: implementationActorId
        },
        toState: 'independent-verifying'
    })
    sealEvent(ledger, {
        actorRole: 'test-owner',
        attemptId: 'attempt-1817-001',
        eventType: 'independent-verification.passed',
        fromState: 'independent-verifying',
        payload: {
            actorId: testOwnerActorId,
            candidateSha,
            receipt: verifiedReceipt({
                actorId: testOwnerActorId,
                actorRole: 'test-owner',
                fresh: true
            }),
            rerunTestIds: ['event-ledger-contract', 'event-ledger-mutations']
        },
        toState: 'behavior-green'
    })
    return ledger
}

function closedLedger({ issueKind = 'code' } = {}) {
    const ledger = behaviorGreenLedger({ issueKind })
    let documentFrom = 'behavior-green'
    if (issueKind === 'ui-ux') {
        sealEvent(ledger, {
            actorRole: 'ux-acceptance-verifier',
            attemptId: 'attempt-1817-001',
            eventType: 'ux-acceptance.started',
            fromState: 'behavior-green',
            payload: {
                actorId: uxActorId,
                candidateSha,
                modifiedPaths: []
            },
            toState: 'ux-acceptance'
        })
        sealEvent(ledger, {
            actorRole: 'ux-acceptance-verifier',
            attemptId: 'attempt-1817-001',
            eventType: 'ux-acceptance.accepted',
            fromState: 'ux-acceptance',
            payload: {
                actorId: uxActorId,
                candidateSha,
                modifiedPaths: [],
                receipt: verifiedReceipt({
                    actorId: uxActorId,
                    actorRole: 'ux-acceptance-verifier'
                })
            },
            toState: 'ux-accepted'
        })
        documentFrom = 'ux-accepted'
    }
    sealEvent(ledger, {
        actorRole: 'documentation-writer',
        eventType: 'documentation.started',
        fromState: documentFrom,
        payload: { actorId: 'documentation-writer-1817' },
        toState: 'documenting'
    })
    sealEvent(ledger, {
        actorRole: 'documentation-writer',
        eventType: 'documentation.passed',
        fromState: 'documenting',
        payload: {
            actorId: 'documentation-writer-1817',
            receipt: verifiedReceipt({
                actorId: 'documentation-writer-1817',
                actorRole: 'documentation-writer'
            })
        },
        toState: 'documentation-green'
    })
    sealEvent(ledger, {
        eventType: 'delivery.ready-computed',
        fromState: 'documentation-green',
        payload: { acceptanceComplete: true },
        toState: 'delivery-ready'
    })
    sealEvent(ledger, {
        eventType: 'delivery.started',
        fromState: 'delivery-ready',
        payload: { deliveryId: 'delivery-1817-001' },
        toState: 'delivering'
    })
    sealEvent(ledger, {
        eventType: 'delivery.completed',
        fromState: 'delivering',
        payload: {
            deliveryId: 'delivery-1817-001',
            remoteVerified: true,
            sideEffectKey: 'delivery-1817-001'
        },
        toState: 'delivering'
    })
    sealEvent(ledger, {
        actorRole: 'machine-cleanup-verifier',
        eventType: 'cleanup.started',
        fromState: 'delivering',
        payload: { cleanupId: 'cleanup-1817-001' },
        toState: 'cleaning'
    })
    sealEvent(ledger, {
        actorRole: 'machine-cleanup-verifier',
        eventType: 'cleanup.completed',
        fromState: 'cleaning',
        payload: {
            cleanupId: 'cleanup-1817-001',
            leaseReleased: true,
            sideEffectKey: 'cleanup-1817-001',
            slotReleased: true
        },
        toState: 'cleaning'
    })
    sealEvent(ledger, {
        eventType: 'issue.closed',
        fromState: 'cleaning',
        payload: {
            cleanupId: 'cleanup-1817-001',
            deliveryId: 'delivery-1817-001',
            remoteState: 'CLOSED'
        },
        toState: 'closed'
    })
    return ledger
}

let runtimePromise

async function runtime() {
    runtimePromise ??= import(pathToFileURL(implementationPath).href)
    return runtimePromise
}

async function replay(ledger) {
    const module = await runtime()
    return module.replayEventLedger(clone(ledger))
}

async function expectCode(operation, expectedCode) {
    await assert.rejects(
        async () => operation(),
        (error) => {
            assert.equal(error?.code, expectedCode, error?.stack ?? String(error))
            return true
        }
    )
}

function nodeOf(projection, id = nodeId) {
    assert.equal(typeof projection.nodes, 'object')
    assert.ok(projection.nodes[id], `projection has no node ${id}`)
    return projection.nodes[id]
}

function dagFrom(projection) {
    return {
        schema: 'issue-orchestration.dag.v3',
        runId,
        projectionDigest: projection.projectionDigest,
        nodes: Object.entries(projection.nodes).map(([id, node]) => ({
            id,
            status: node.status,
            activeAttemptId: node.activeAttemptId ?? null,
            reworkCount: node.reworkCount,
            terminal: node.terminal ?? null,
            evidenceRefs: node.evidenceRefs,
            timestamps: node.timestamps
        }))
    }
}

const requiredEventTypes = [
    'node.discovered',
    'test-contract.started',
    'test-contract.frozen',
    'test-contract.disputed',
    'implementation.started',
    'implementation.candidate-green',
    'implementation.contract-disputed',
    'implementation.external-blocked',
    'implementation.resource-failed',
    'independent-verification.started',
    'independent-verification.rejected',
    'independent-verification.passed',
    'ux-acceptance.started',
    'ux-acceptance.rejected',
    'ux-acceptance.accepted',
    'documentation.started',
    'documentation.failed',
    'documentation.passed',
    'delivery.ready-computed',
    'delivery.started',
    'delivery.failed',
    'delivery.completed',
    'cleanup.started',
    'cleanup.quarantined',
    'cleanup.failed',
    'cleanup.completed',
    'issue.closed',
    'issue.reopened',
    'node.terminal-entered',
    'node.terminal-recovered',
    'attempt.cancelled',
    'attempt.expired',
    'attempt.invocation-failed',
    'attempt.environment-failed',
    'ledger.correction-recorded',
    'dag.proposal-accepted',
    'dag.proposal-rejected',
    'group.session.proposed',
    'group.session.created',
    'group.session.activated',
    'group.member.test-contract-frozen',
    'group.member.write-lease-granted',
    'group.member.candidate-created',
    'group.member.behavior-green',
    'group.member.committed',
    'group.member.delivery-completed',
    'group.member.write-lease-revoked',
    'group.session.cleaning',
    'group.session.cleaned',
    'group.session.cancelled',
    'group.session.failed',
    'group.session.completed'
]

test('contract fixtures are exact, internally linked, and bind the latest authority comment', () => {
    assert.equal(acceptance.authorityCommentId, 5145136921)
    const controlIds = controls.map(({ id }) => id)
    assert.equal(new Set(controlIds).size, controlIds.length)
    const mapped = new Set(acceptance.acceptance.flatMap((entry) => entry.mutations))
    assert.deepEqual([...mapped].sort(), [...controlIds].sort())
    assert.deepEqual(runtimeProbes.map(({ id }) => id), ['R01', 'R02', 'R03', 'R04', 'R05', 'R06'])
})

test('P01 the runtime exposes one executable transition table and no old review authority', async () => {
    const module = await runtime()
    for (const name of [
        'appendEventAtomic',
        'recoverEventLedger',
        'replayEventLedger',
        'validateDagProjection'
    ]) {
        assert.equal(typeof module[name], 'function', `${name} is not exported`)
    }
    assert.equal(typeof module.transitionTable, 'object')
    for (const eventType of requiredEventTypes) {
        assert.ok(module.transitionTable[eventType], `missing transition rule ${eventType}`)
    }
    for (const forbidden of [
        'dispatch.started',
        'implementation.completed',
        'review.started',
        'review.passed',
        'verification.started',
        'verification.passed'
    ]) {
        assert.equal(module.transitionTable[forbidden], undefined)
    }
})

test('P02 replay is deterministic and all mandatory event fields contribute to integrity', async () => {
    const ledger = frozenLedger()
    const first = await replay(ledger)
    const second = await replay(ledger)
    assert.deepEqual(second, first)
    assert.match(first.projectionDigest, /^[a-f0-9]{64}$/u)
    assert.equal(first.lastSequence, ledger.events.length)
    assert.equal(first.lastEventDigest, ledger.events.at(-1).eventDigest)
    assert.equal(nodeOf(first).status, 'test-contract-frozen')
    for (const event of ledger.events) {
        for (const field of [
            'eventId',
            'sequence',
            'runId',
            'nodeId',
            'eventType',
            'fromState',
            'toState',
            'attemptId',
            'actorRole',
            'sourceDagDigest',
            'issueSnapshotFingerprint',
            'repositoryFingerprint',
            'baseSha',
            'payloadDigest',
            'evidenceRefs',
            'createdAt',
            'previousEventDigest',
            'eventDigest'
        ]) {
            assert.ok(Object.hasOwn(event, field), `${event.eventId} lacks ${field}`)
        }
    }
})

test('P03 non-UI self-test cycles stay in one attempt before fresh independent verification', async () => {
    const ledger = closedLedger()
    const projection = await replay(ledger)
    assert.equal(nodeOf(projection).status, 'closed')
    assert.equal(nodeOf(projection).reworkCount, 0)
    assert.equal(
        ledger.events.filter(({ eventType }) => eventType === 'implementation.started').length,
        1
    )
    assert.equal(
        ledger.events.find(({ eventType }) => eventType === 'implementation.candidate-green')
            .payload.receipt.selfTestCycles.length,
        3
    )
    assert.equal(
        ledger.events.some(({ eventType }) => eventType.startsWith('review.')),
        false
    )
})

test('P04 UI/UX projection inserts independent UX acceptance before documentation', async () => {
    const ledger = closedLedger({ issueKind: 'ui-ux' })
    const eventTypes = ledger.events.map(({ eventType }) => eventType)
    assert.ok(eventTypes.indexOf('ux-acceptance.accepted') < eventTypes.indexOf('documentation.started'))
    assert.equal(nodeOf(await replay(ledger)).status, 'closed')
})

test('P05 verifier rejection preserves the first failure and increments rework exactly once', async () => {
    const ledger = candidateLedger()
    sealEvent(ledger, {
        actorRole: 'test-owner',
        attemptId: 'attempt-1817-001',
        eventType: 'independent-verification.started',
        fromState: 'candidate-green',
        payload: {
            actorId: testOwnerActorId,
            candidateSha,
            independentOfActorId: implementationActorId
        },
        toState: 'independent-verifying'
    })
    const firstFailure = {
        classification: 'implementation',
        evidenceRef: 'evidence://independent-red-001',
        signature: 'assertion-drift'
    }
    sealEvent(ledger, {
        actorRole: 'test-owner',
        attemptId: 'attempt-1817-001',
        eventType: 'independent-verification.rejected',
        fromState: 'independent-verifying',
        payload: {
            candidateSha,
            continuationAttemptId: 'attempt-1817-001',
            firstFailure,
            implementationOwnerActorId: implementationActorId,
            reworkCount: 1
        },
        toState: 'implementing-self-testing'
    })
    const projection = await replay(ledger)
    assert.equal(nodeOf(projection).status, 'implementing-self-testing')
    assert.equal(nodeOf(projection).reworkCount, 1)
    assert.deepEqual(nodeOf(projection).firstFailure, firstFailure)
})

test('P06 failure categories are distinct and retain first-failure authority', async () => {
    for (const eventType of [
        'attempt.cancelled',
        'attempt.expired',
        'attempt.invocation-failed',
        'attempt.environment-failed',
        'implementation.contract-disputed',
        'implementation.external-blocked',
        'implementation.resource-failed'
    ]) {
        const ledger = implementingLedger()
        const firstFailure = {
            classification: eventType,
            evidenceRef: `evidence://${eventType}`,
            signature: `${eventType}-signature`
        }
        sealEvent(ledger, {
            actorRole: eventType === 'implementation.contract-disputed'
                ? 'code-implementer'
                : 'root-scheduler',
            attemptId: 'attempt-1817-001',
            eventType,
            fromState: 'implementing-self-testing',
            payload: {
                firstFailure,
                recoveryFingerprint: digest(eventType)
            },
            toState: eventType === 'implementation.external-blocked'
                ? 'terminal'
                : 'test-contract-frozen'
        })
        assert.deepEqual(nodeOf(await replay(ledger)).firstFailure, firstFailure)
    }
})

test('P07 correction is append-only and references an existing immutable event', async () => {
    const ledger = frozenLedger()
    const corrected = ledger.events[1]
    sealEvent(ledger, {
        eventType: 'ledger.correction-recorded',
        fromState: 'test-contract-frozen',
        payload: {
            correction: { field: 'payload.note', value: 'clarified' },
            targetEventDigest: corrected.eventDigest,
            targetEventId: corrected.eventId
        },
        toState: 'test-contract-frozen'
    })
    const projection = await replay(ledger)
    assert.equal(projection.corrections.length, 1)
    assert.equal(projection.corrections[0].targetEventId, corrected.eventId)
})

test('P08 terminal recovery requires a changed observable fingerprint', async () => {
    const ledger = frozenLedger()
    const oldFingerprint = digest('terminal-old')
    const newFingerprint = digest('terminal-new')
    sealEvent(ledger, {
        eventType: 'node.terminal-entered',
        fromState: 'test-contract-frozen',
        payload: {
            category: 'externally_blocked',
            directEvidence: ['evidence://permission-denied'],
            recoveryFingerprint: oldFingerprint
        },
        toState: 'terminal'
    })
    sealEvent(ledger, {
        eventType: 'node.terminal-recovered',
        fromState: 'terminal',
        payload: {
            previousRecoveryFingerprint: oldFingerprint,
            recoveryFingerprint: newFingerprint
        },
        toState: 'test-contract-frozen'
    })
    const node = nodeOf(await replay(ledger))
    assert.equal(node.status, 'test-contract-frozen')
    assert.equal(node.terminal, null)
})

test('P09 reopen invalidates closed authority and requires DAG/frontier recomputation', async () => {
    const ledger = closedLedger()
    sealEvent(ledger, {
        eventType: 'issue.reopened',
        fromState: 'closed',
        payload: {
            liveIssueFingerprint: digest('reopened'),
            remoteState: 'OPEN'
        },
        toState: 'discovered'
    })
    const node = nodeOf(await replay(ledger))
    assert.equal(node.status, 'discovered')
    assert.equal(node.deliveryAuthorized, false)
    assert.equal(node.semanticDagRecomputeRequired, true)
})

test('P10 semantic DAG proposal events require a changed remote live snapshot and DAG updater receipt', async () => {
    const ledger = frozenLedger()
    sealEvent(ledger, {
        actorRole: 'dag-updater',
        eventType: 'dag.proposal-accepted',
        fromState: 'test-contract-frozen',
        payload: {
            currentRemoteSnapshotDigest: digest('remote-new'),
            previousRemoteSnapshotDigest: digest('remote-old'),
            proposalReceipt: verifiedReceipt({
                actorId: 'dag-updater-1817',
                actorRole: 'dag-updater'
            }),
            trigger: 'remote-live-snapshot-digest-changed'
        },
        toState: 'test-contract-frozen'
    })
    assert.equal((await replay(ledger)).dagProposals.length, 1)
})

function groupLedger() {
    const ledger = emptyLedger()
    const groupId = 'group-1817'
    const member = 'FsusBlog#1817'
    const events = [
        ['group.session.proposed', 'none', 'proposed', groupId, { groupId }],
        ['group.session.created', 'proposed', 'created', groupId, { groupId }],
        ['group.session.activated', 'created', 'active', groupId, { groupId }],
        ['group.member.test-contract-frozen', 'test-contracting', 'test-contract-frozen', member, { groupId, memberId: member }],
        ['group.member.write-lease-granted', 'no-lease', 'lease-granted', member, { groupId, leaseId: 'lease-1817', memberId: member }],
        ['group.member.candidate-created', 'implementing-self-testing', 'candidate-green', member, { candidateSha, groupId, memberId: member }],
        ['group.member.behavior-green', 'independent-verifying', 'behavior-green', member, { candidateSha, groupId, memberId: member }],
        ['group.member.committed', 'behavior-green', 'committed', member, { commitSha: candidateSha, groupId, memberId: member }],
        ['group.member.delivery-completed', 'committed', 'delivery-completed', member, { groupId, memberId: member }],
        ['group.member.write-lease-revoked', 'lease-granted', 'lease-revoked', member, { groupId, leaseId: 'lease-1817', memberId: member }],
        ['group.session.cleaning', 'active', 'cleaning', groupId, { groupId }],
        ['group.session.cleaned', 'cleaning', 'cleaned', groupId, { groupId }],
        ['group.session.completed', 'cleaned', 'completed', groupId, { groupId }]
    ]
    for (const [eventType, fromState, toState, node, payload] of events) {
        sealEvent(ledger, {
            eventType,
            fromState,
            node,
            payload,
            toState
        })
    }
    return ledger
}

test('G01 group session and each member are independently replayed', async () => {
    const projection = await replay(groupLedger())
    assert.equal(projection.groups['group-1817'].status, 'completed')
    assert.equal(projection.groups['group-1817'].members[nodeId].status, 'delivery-completed')
    assert.equal(projection.groups['group-1817'].members[nodeId].leaseId, null)
})

test('mutation catalog is executable and exact-set equal', () => {
    assert.deepEqual(
        controls.map(({ id }) => id).sort(),
        Object.keys(mutations).sort()
    )
})

function invalidTransition(eventType, fromState, toState, options = {}) {
    const ledger = options.ledger ?? discoveredLedger(options)
    sealEvent(ledger, {
        actorRole: options.actorRole,
        attemptId: options.attemptId,
        eventType,
        fromState,
        payload: options.payload ?? {},
        toState
    })
    return ledger
}

async function replayMutation(ledger, code) {
    await expectCode(() => replay(ledger), code)
}

async function receiptMutation(mutator, code, options = {}) {
    const ledger = candidateLedger(options)
    const event = ledger.events.find(({ eventType }) => eventType === 'implementation.candidate-green')
    mutator(event.payload.receipt, event.payload, event)
    resealFrom(ledger, ledger.events.indexOf(event))
    await replayMutation(ledger, code)
}

async function verifierMutation(mutator, code) {
    const ledger = behaviorGreenLedger()
    const event = ledger.events.find(({ eventType }) => eventType === 'independent-verification.passed')
    mutator(event.payload.receipt, event.payload, event)
    resealFrom(ledger, ledger.events.indexOf(event))
    await replayMutation(ledger, code)
}

async function projectionMutation(mutator, code, ledger = behaviorGreenLedger()) {
    const module = await runtime()
    const projection = await module.replayEventLedger(clone(ledger))
    const dag = dagFrom(projection)
    mutator(dag, projection)
    await expectCode(
        () => module.validateDagProjection({ dag, projection }),
        code
    )
}

async function writerMutation(writerRole, code) {
    const module = await runtime()
    const directory = fs.mkdtempSync(path.join(scratch, 'writer-'))
    const ledger = frozenLedger()
    const ledgerPath = path.join(directory, 'ledger.jsonl')
    const projectionPath = path.join(directory, 'projection.json')
    writeLedger(ledgerPath, { ...ledger, events: ledger.events.slice(0, -1) })
    await expectCode(
        () => module.appendEventAtomic({
            event: clone(ledger.events.at(-1)),
            ledgerPath,
            projectionPath,
            protectedRoots: [],
            stateRoot: directory,
            writerRole
        }),
        code
    )
}

function writeLedger(file, ledger) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
        file,
        `${[ledger.header, ...ledger.events].map((entry) => JSON.stringify(entry)).join('\n')}\n`
    )
}

const mutations = {
    'event-field-missing': async (code) => {
        const ledger = frozenLedger()
        delete ledger.events[1].sourceDagDigest
        resealFrom(ledger, 1)
        await replayMutation(ledger, code)
    },
    'old-review-event': (code) => replayMutation(invalidTransition('review.passed', 'implementing-self-testing', 'behavior-green', { ledger: implementingLedger() }), code),
    'old-verification-event': (code) => replayMutation(invalidTransition('verification.passed', 'candidate-green', 'behavior-green', { ledger: candidateLedger() }), code),
    'old-direct-state-event': (code) => replayMutation(invalidTransition('node.status-updated', 'discovered', 'closed'), code),
    'discovered-to-delivery-ready': (code) => replayMutation(invalidTransition('delivery.ready-computed', 'discovered', 'delivery-ready'), code),
    'test-contracting-to-closed': (code) => replayMutation(invalidTransition('issue.closed', 'test-contracting', 'closed', { ledger: frozenLedger().events.slice(0, 2) && discoveredLedger() }), code),
    'implementing-to-closed': (code) => replayMutation(invalidTransition('issue.closed', 'implementing-self-testing', 'closed', { ledger: implementingLedger() }), code),
    'duplicate-implementation-start': async (code) => {
        const ledger = implementingLedger()
        sealEvent(ledger, {
            actorRole: 'code-implementer',
            attemptId: 'attempt-1817-001',
            eventType: 'implementation.started',
            fromState: 'implementing-self-testing',
            payload: { actorId: implementationActorId },
            toState: 'implementing-self-testing'
        })
        await replayMutation(ledger, code)
    },
    'self-test-red-candidate-green': (code) => receiptMutation((receipt) => { receipt.status = 'failed' }, code),
    'self-test-matrix-incomplete': (code) => receiptMutation((receipt) => { receipt.visibleMatrixComplete = false }, code),
    'self-test-candidate-identity-missing': (code) => receiptMutation((receipt, payload) => { delete receipt.candidateSha; delete payload.candidateSha }, code),
    'frozen-test-contract-modified': (code) => receiptMutation((receipt) => { receipt.modifiedPaths = ['tests/tools/issue-orchestration-event-ledger.test.mjs'] }, code),
    'candidate-direct-to-behavior-green': (code) => replayMutation(invalidTransition('independent-verification.passed', 'candidate-green', 'behavior-green', { ledger: candidateLedger(), actorRole: 'test-owner', attemptId: 'attempt-1817-001' }), code),
    'implementer-verifies-own-candidate': (code) => verifierMutation((receipt, payload) => { receipt.actorId = implementationActorId; payload.actorId = implementationActorId }, code),
    'independent-verification-not-fresh': (code) => verifierMutation((receipt) => { receipt.fresh = false }, code),
    'independent-verification-candidate-drift': (code) => verifierMutation((receipt, payload) => { receipt.candidateSha = 'f'.repeat(40); payload.candidateSha = 'f'.repeat(40) }, code),
    'root-declares-behavior-green': async (code) => {
        const ledger = behaviorGreenLedger()
        const event = ledger.events.at(-1)
        event.actorRole = 'root-scheduler'
        resealFrom(ledger, ledger.events.length - 1)
        await replayMutation(ledger, code)
    },
    'rejection-loses-first-failure': (code) => failureOverwriteMutation('independent-verification.rejected', 'first-failure-mismatch', code),
    'rejection-resets-rework-count': async (code) => {
        const ledger = rejectedLedger()
        const event = ledger.events.at(-1)
        event.payload.reworkCount = 0
        resealFrom(ledger, ledger.events.length - 1)
        await replayMutation(ledger, code)
    },
    'rejection-unbound-continuation': async (code) => {
        const ledger = rejectedLedger()
        const event = ledger.events.at(-1)
        event.payload.continuationAttemptId = 'attempt-unrelated'
        resealFrom(ledger, ledger.events.length - 1)
        await replayMutation(ledger, code)
    },
    'ui-documentation-before-ux-accepted': (code) => replayMutation(invalidTransition('documentation.started', 'behavior-green', 'documenting', { ledger: behaviorGreenLedger({ issueKind: 'ui-ux' }), actorRole: 'documentation-writer' }), code),
    'ui-delivery-before-ux-accepted': (code) => replayMutation(invalidTransition('delivery.started', 'behavior-green', 'delivering', { ledger: behaviorGreenLedger({ issueKind: 'ui-ux' }) }), code),
    'ux-verifier-modifies-code': async (code) => {
        const ledger = closedLedger({ issueKind: 'ui-ux' })
        const event = ledger.events.find(({ eventType }) => eventType === 'ux-acceptance.accepted')
        event.payload.modifiedPaths = ['.agents/skills/issue-orchestration/scripts/event-ledger.mjs']
        resealFrom(ledger, ledger.events.indexOf(event))
        await replayMutation(ledger, code)
    },
    'ux-rejection-owner-drift': (code) => uxRejectionMutation((payload) => { payload.implementationOwnerActorId = 'different-owner' }, code),
    'ux-rejection-effort-drift': (code) => uxRejectionMutation((payload) => { payload.implementationEffort = 'max' }, code),
    'documentation-before-behavior-green': (code) => replayMutation(invalidTransition('documentation.started', 'candidate-green', 'documenting', { ledger: candidateLedger(), actorRole: 'documentation-writer' }), code),
    'documentation-overwrites-first-failure': (code) => failureOverwriteMutation('documentation.passed', 'first-failure-mismatch', code),
    'delivery-before-documentation-green': (code) => replayMutation(invalidTransition('delivery.started', 'behavior-green', 'delivering', { ledger: behaviorGreenLedger() }), code),
    'close-before-delivery-completed': (code) => closeMutation({ remove: 'delivery.completed' }, code),
    'close-before-cleanup-completed': (code) => closeMutation({ remove: 'cleanup.completed' }, code),
    'cleanup-failure-releases-lease': (code) => cleanupFailureMutation({ leaseReleased: true }, code),
    'cleanup-success-overwrites-first-failure': (code) => failureOverwriteMutation('cleanup.completed', 'first-failure-mismatch', code),
    'projection-status-edited': (code) => projectionMutation((dag) => { dag.nodes[0].status = 'closed' }, code),
    'projection-attempt-edited': (code) => projectionMutation((dag) => { dag.nodes[0].activeAttemptId = 'attempt-forged' }, code),
    'projection-rework-edited': (code) => projectionMutation((dag) => { dag.nodes[0].reworkCount += 1 }, code),
    'projection-evidence-edited': (code) => projectionMutation((dag) => { dag.nodes[0].evidenceRefs = ['evidence://forged'] }, code),
    'sequence-gap': async (code) => {
        const ledger = frozenLedger()
        ledger.events[1].sequence = 9
        await replayMutation(ledger, code)
    },
    'duplicate-event-id': async (code) => {
        const ledger = frozenLedger()
        ledger.events[1].eventId = ledger.events[0].eventId
        resealFrom(ledger, 1)
        await replayMutation(ledger, code)
    },
    'run-id-tampered': (code) => identityMutation('runId', 'run-other', code),
    'node-id-tampered': (code) => identityMutation('nodeId', 'FsusBlog#9999', code),
    'base-sha-tampered': (code) => identityMutation('baseSha', 'f'.repeat(40), code),
    'previous-event-digest-tampered': async (code) => {
        const ledger = frozenLedger()
        ledger.events[1].previousEventDigest = 'f'.repeat(64)
        await replayMutation(ledger, code)
    },
    'payload-digest-tampered': async (code) => {
        const ledger = frozenLedger()
        ledger.events[1].payloadDigest = 'f'.repeat(64)
        await replayMutation(ledger, code)
    },
    'event-digest-tampered': async (code) => {
        const ledger = frozenLedger()
        ledger.events[1].eventDigest = 'f'.repeat(64)
        await replayMutation(ledger, code)
    },
    'historical-event-deleted': async (code) => {
        const ledger = frozenLedger()
        ledger.events.splice(1, 1)
        await replayMutation(ledger, code)
    },
    'events-reordered': async (code) => {
        const ledger = frozenLedger()
        ;[ledger.events[0], ledger.events[1]] = [ledger.events[1], ledger.events[0]]
        await replayMutation(ledger, code)
    },
    'conflicting-attempt-terminal-events': async (code) => {
        const ledger = implementingLedger()
        sealEvent(ledger, {
            attemptId: 'attempt-1817-001',
            eventType: 'attempt.cancelled',
            fromState: 'implementing-self-testing',
            payload: { firstFailure: { classification: 'cancelled' } },
            toState: 'test-contract-frozen'
        })
        sealEvent(ledger, {
            attemptId: 'attempt-1817-001',
            eventType: 'implementation.candidate-green',
            fromState: 'test-contract-frozen',
            payload: { candidateSha },
            toState: 'candidate-green'
        })
        await replayMutation(ledger, code)
    },
    'historical-event-edited': async (code) => {
        const ledger = frozenLedger()
        ledger.events[0].payload.issueKind = 'ui-ux'
        await replayMutation(ledger, code)
    },
    'correction-target-missing': async (code) => {
        const ledger = frozenLedger()
        sealEvent(ledger, {
            eventType: 'ledger.correction-recorded',
            fromState: 'test-contract-frozen',
            payload: {
                targetEventDigest: 'f'.repeat(64),
                targetEventId: 'event-missing'
            },
            toState: 'test-contract-frozen'
        })
        await replayMutation(ledger, code)
    },
    'truncated-ledger-tail': (code) => truncatedTailMutation(code),
    'duplicate-side-effect-after-recovery': (code) => duplicateSideEffectMutation(code),
    'terminal-category-invalid': (code) => terminalMutation({ category: 'unknown' }, code),
    'terminal-evidence-missing': (code) => terminalMutation({ directEvidence: [] }, code),
    'terminal-recovery-fingerprint-unchanged': (code) => terminalRecoveryUnchanged(code),
    'reopen-retains-closed-projection': (code) => projectionMutation((dag) => { dag.nodes[0].status = 'closed' }, code, reopenedLedger()),
    'implementer-writes-ledger': (code) => writerMutation('code-implementer', code),
    'test-owner-writes-ledger': (code) => writerMutation('test-owner', code),
    'reviewer-writes-pass-event': (code) => writerMutation('issue-reviewer', code),
    'root-authors-pass-without-receipt': (code) => rootWithoutReceiptMutation(code),
    'ledger-inside-repository': (code) => protectedPathMutation('repository', code),
    'ledger-inside-workspace': (code) => protectedPathMutation('workspace', code),
    'ledger-path-symlink': (code) => symlinkMutation(code),
    'group-member-skips-verification': (code) => groupMutation('group.member.committed', 'candidate-green', 'committed', code),
    'group-member-inherits-green': (code) => groupInheritedGreenMutation(code),
    'group-event-out-of-order': (code) => groupMutation('group.session.activated', 'proposed', 'active', code),
    'group-duplicate-active-member': (code) => duplicateActiveMemberMutation(code),
    'group-lease-multiple-members': (code) => groupLeaseConflictMutation(code),
    'dag-proposal-local-stage-trigger': (code) => dagProposalMutation({ trigger: 'local-stage-event' }, code),
    'dag-proposal-root-authored': (code) => dagProposalMutation({}, code, 'root-scheduler')
}

function rejectedLedger() {
    const ledger = candidateLedger()
    sealEvent(ledger, {
        actorRole: 'test-owner',
        attemptId: 'attempt-1817-001',
        eventType: 'independent-verification.started',
        fromState: 'candidate-green',
        payload: { actorId: testOwnerActorId, candidateSha, independentOfActorId: implementationActorId },
        toState: 'independent-verifying'
    })
    sealEvent(ledger, {
        actorRole: 'test-owner',
        attemptId: 'attempt-1817-001',
        eventType: 'independent-verification.rejected',
        fromState: 'independent-verifying',
        payload: {
            candidateSha,
            continuationAttemptId: 'attempt-1817-001',
            firstFailure: {
                classification: 'implementation',
                evidenceRef: 'evidence://first',
                signature: 'first'
            },
            implementationOwnerActorId: implementationActorId,
            reworkCount: 1
        },
        toState: 'implementing-self-testing'
    })
    return ledger
}

async function failureOverwriteMutation(eventType, _expected, code) {
    const ledger = rejectedLedger()
    sealEvent(ledger, {
        actorRole: eventType.startsWith('documentation.')
            ? 'documentation-writer'
            : 'machine-cleanup-verifier',
        eventType,
        fromState: 'implementing-self-testing',
        payload: {
            firstFailure: {
                classification: 'success',
                evidenceRef: 'evidence://replacement',
                signature: 'replacement'
            }
        },
        toState: 'implementing-self-testing'
    })
    await replayMutation(ledger, code)
}

async function uxRejectionMutation(mutator, code) {
    const ledger = behaviorGreenLedger({ issueKind: 'ui-ux' })
    sealEvent(ledger, {
        actorRole: 'ux-acceptance-verifier',
        attemptId: 'attempt-1817-001',
        eventType: 'ux-acceptance.started',
        fromState: 'behavior-green',
        payload: { actorId: uxActorId, candidateSha, modifiedPaths: [] },
        toState: 'ux-acceptance'
    })
    const payload = {
        implementationEffort: 'low',
        implementationOwnerActorId: implementationActorId,
        firstFailure: {
            classification: 'ux-rejected',
            evidenceRef: 'evidence://ux-red',
            signature: 'ux-red'
        }
    }
    mutator(payload)
    sealEvent(ledger, {
        actorRole: 'ux-acceptance-verifier',
        attemptId: 'attempt-1817-001',
        eventType: 'ux-acceptance.rejected',
        fromState: 'ux-acceptance',
        payload,
        toState: 'implementing-self-testing'
    })
    await replayMutation(ledger, code)
}

async function closeMutation({ remove }, code) {
    const ledger = closedLedger()
    const index = ledger.events.findIndex(({ eventType }) => eventType === remove)
    ledger.events.splice(index, 1)
    resealFrom(ledger, index)
    await replayMutation(ledger, code)
}

async function cleanupFailureMutation(payload, code) {
    const ledger = closedLedger()
    const start = ledger.events.findIndex(({ eventType }) => eventType === 'cleanup.started')
    ledger.events.splice(start + 1)
    sealEvent(ledger, {
        actorRole: 'machine-cleanup-verifier',
        eventType: 'cleanup.failed',
        fromState: 'cleaning',
        payload: {
            cleanupId: 'cleanup-1817-001',
            firstFailure: { classification: 'cleanup', signature: 'leak' },
            ...payload
        },
        toState: 'cleaning'
    })
    await replayMutation(ledger, code)
}

async function identityMutation(field, value, code) {
    const ledger = frozenLedger()
    ledger.events[1][field] = value
    resealFrom(ledger, 1)
    await replayMutation(ledger, code)
}

async function terminalMutation(patch, code) {
    const ledger = frozenLedger()
    sealEvent(ledger, {
        eventType: 'node.terminal-entered',
        fromState: 'test-contract-frozen',
        payload: {
            category: 'externally_blocked',
            directEvidence: ['evidence://external'],
            recoveryFingerprint: digest('terminal'),
            ...patch
        },
        toState: 'terminal'
    })
    await replayMutation(ledger, code)
}

async function terminalRecoveryUnchanged(code) {
    const ledger = frozenLedger()
    const fingerprint = digest('same')
    sealEvent(ledger, {
        eventType: 'node.terminal-entered',
        fromState: 'test-contract-frozen',
        payload: {
            category: 'externally_blocked',
            directEvidence: ['evidence://external'],
            recoveryFingerprint: fingerprint
        },
        toState: 'terminal'
    })
    sealEvent(ledger, {
        eventType: 'node.terminal-recovered',
        fromState: 'terminal',
        payload: {
            previousRecoveryFingerprint: fingerprint,
            recoveryFingerprint: fingerprint
        },
        toState: 'test-contract-frozen'
    })
    await replayMutation(ledger, code)
}

function reopenedLedger() {
    const ledger = closedLedger()
    sealEvent(ledger, {
        eventType: 'issue.reopened',
        fromState: 'closed',
        payload: { liveIssueFingerprint: digest('reopened'), remoteState: 'OPEN' },
        toState: 'discovered'
    })
    return ledger
}

async function rootWithoutReceiptMutation(code) {
    const module = await runtime()
    const directory = fs.mkdtempSync(path.join(scratch, 'root-no-receipt-'))
    const ledger = candidateLedger()
    const event = sealEvent(clone(ledger), {
        actorRole: 'test-owner',
        attemptId: 'attempt-1817-001',
        eventType: 'independent-verification.started',
        fromState: 'candidate-green',
        payload: { actorId: testOwnerActorId, candidateSha },
        toState: 'independent-verifying'
    })
    delete event.payload.receipt
    resealFrom({ header: ledger.header, events: [event] })
    const ledgerPath = path.join(directory, 'ledger.jsonl')
    writeLedger(ledgerPath, ledger)
    await expectCode(
        () => module.appendEventAtomic({
            event,
            ledgerPath,
            projectionPath: path.join(directory, 'projection.json'),
            protectedRoots: [],
            stateRoot: directory,
            writerRole: 'root-scheduler'
        }),
        code
    )
}

async function protectedPathMutation(kind, code) {
    const module = await runtime()
    const protectedRoot = fs.mkdtempSync(path.join(scratch, `${kind}-`))
    const stateRoot = path.join(protectedRoot, 'runtime-state')
    fs.mkdirSync(stateRoot)
    await expectCode(
        () => module.recoverEventLedger({
            ledgerPath: path.join(stateRoot, 'ledger.jsonl'),
            projectionPath: path.join(stateRoot, 'projection.json'),
            protectedRoots: [protectedRoot],
            stateRoot
        }),
        code
    )
}

async function symlinkMutation(code) {
    const module = await runtime()
    const stateRoot = fs.mkdtempSync(path.join(scratch, 'symlink-state-'))
    const target = fs.mkdtempSync(path.join(scratch, 'symlink-target-'))
    fs.symlinkSync(target, path.join(stateRoot, 'runtime'))
    await expectCode(
        () => module.recoverEventLedger({
            ledgerPath: path.join(stateRoot, 'runtime/ledger.jsonl'),
            projectionPath: path.join(stateRoot, 'projection.json'),
            protectedRoots: [],
            stateRoot
        }),
        code
    )
}

async function truncatedTailMutation(code) {
    const module = await runtime()
    const directory = fs.mkdtempSync(path.join(scratch, 'truncated-'))
    const ledger = frozenLedger()
    const ledgerPath = path.join(directory, 'ledger.jsonl')
    writeLedger(ledgerPath, ledger)
    fs.appendFileSync(ledgerPath, '{"schema":"issue-orchestration.event.v1"')
    await expectCode(
        () => module.recoverEventLedger({
            ledgerPath,
            projectionPath: path.join(directory, 'projection.json'),
            protectedRoots: [],
            stateRoot: directory
        }),
        code
    )
}

async function duplicateSideEffectMutation(code) {
    const ledger = closedLedger()
    const completed = clone(ledger.events.find(({ eventType }) => eventType === 'delivery.completed'))
    delete completed.eventDigest
    completed.eventId = 'event-duplicate-delivery'
    completed.sequence = ledger.events.length + 1
    completed.previousEventDigest = ledger.events.at(-1).eventDigest
    completed.fromState = 'closed'
    completed.toState = 'closed'
    completed.eventDigest = digest(completed)
    ledger.events.push(completed)
    await replayMutation(ledger, code)
}

async function groupMutation(eventType, fromState, toState, code) {
    const ledger = emptyLedger()
    sealEvent(ledger, {
        eventType: 'group.session.proposed',
        fromState: 'none',
        node: 'group-1817',
        payload: { groupId: 'group-1817' },
        toState: 'proposed'
    })
    sealEvent(ledger, {
        eventType,
        fromState,
        node: 'group-1817',
        payload: { groupId: 'group-1817', memberId: nodeId },
        toState
    })
    await replayMutation(ledger, code)
}

async function groupInheritedGreenMutation(code) {
    const ledger = groupLedger()
    const member = 'FsusBlog#1818'
    sealEvent(ledger, {
        eventType: 'group.member.committed',
        fromState: 'candidate-green',
        node: member,
        payload: { groupId: 'group-1817', memberId: member },
        toState: 'committed'
    })
    await replayMutation(ledger, code)
}

async function duplicateActiveMemberMutation(code) {
    const ledger = groupLedger()
    sealEvent(ledger, {
        eventType: 'group.session.activated',
        fromState: 'active',
        node: 'group-1817',
        payload: { activeMemberId: nodeId, groupId: 'group-1817' },
        toState: 'active'
    })
    await replayMutation(ledger, code)
}

async function groupLeaseConflictMutation(code) {
    const ledger = groupLedger()
    sealEvent(ledger, {
        eventType: 'group.member.write-lease-granted',
        fromState: 'no-lease',
        node: 'FsusBlog#1818',
        payload: {
            groupId: 'group-1817',
            leaseId: 'lease-1817',
            memberId: 'FsusBlog#1818'
        },
        toState: 'lease-granted'
    })
    await replayMutation(ledger, code)
}

async function dagProposalMutation(patch, code, actorRole = 'dag-updater') {
    const ledger = frozenLedger()
    sealEvent(ledger, {
        actorRole,
        eventType: 'dag.proposal-accepted',
        fromState: 'test-contract-frozen',
        payload: {
            currentRemoteSnapshotDigest: digest('remote-new'),
            previousRemoteSnapshotDigest: digest('remote-old'),
            proposalReceipt: verifiedReceipt({
                actorId: 'dag-updater-1817',
                actorRole: 'dag-updater'
            }),
            trigger: 'remote-live-snapshot-digest-changed',
            ...patch
        },
        toState: 'test-contract-frozen'
    })
    await replayMutation(ledger, code)
}

for (const control of controls) {
    test(`MUTATION ${control.id} is killed with ${control.expectedCode}`, async () => {
        await mutations[control.id](control.expectedCode)
    })
}

test('R01/R02/R04 durable recovery derives projection only from the ledger', async () => {
    const module = await runtime()
    const directory = fs.mkdtempSync(path.join(scratch, 'recovery-'))
    const ledger = frozenLedger()
    const ledgerPath = path.join(directory, 'ledger.jsonl')
    const projectionPath = path.join(directory, 'projection.json')
    writeLedger(ledgerPath, ledger)

    const missing = await module.recoverEventLedger({
        ledgerPath,
        projectionPath,
        protectedRoots: [],
        stateRoot: directory
    })
    assert.equal(missing.recoveryAction, 'replay-ledger-forward')
    assert.equal(nodeOf(missing.projection).status, 'test-contract-frozen')

    const ahead = clone(missing.projection)
    ahead.lastSequence += 1
    ahead.nodes[nodeId].status = 'closed'
    fs.writeFileSync(projectionPath, `${JSON.stringify(ahead, null, 2)}\n`)
    const rebuilt = await module.recoverEventLedger({
        ledgerPath,
        projectionPath,
        protectedRoots: [],
        stateRoot: directory
    })
    assert.equal(rebuilt.recoveryAction, 'discard-projection-and-rebuild')
    assert.equal(nodeOf(rebuilt.projection).status, 'test-contract-frozen')

    const current = await module.recoverEventLedger({
        ledgerPath,
        projectionPath,
        protectedRoots: [],
        stateRoot: directory
    })
    assert.equal(current.recoveryAction, 'projection-already-current')
    assert.deepEqual(current.repeatedSideEffects, [])
})

test('R03 corrupt tail reports the final valid sequence and keeps dispatch disabled', async () => {
    const module = await runtime()
    const directory = fs.mkdtempSync(path.join(scratch, 'tail-'))
    const ledger = frozenLedger()
    const ledgerPath = path.join(directory, 'ledger.jsonl')
    writeLedger(ledgerPath, ledger)
    fs.appendFileSync(ledgerPath, '{"schema":"issue-orchestration.event.v1"')
    await assert.rejects(
        () => module.recoverEventLedger({
            ledgerPath,
            projectionPath: path.join(directory, 'projection.json'),
            protectedRoots: [],
            stateRoot: directory
        }),
        (error) => {
            assert.equal(error.code, 'ledger-tail-corrupt')
            assert.equal(error.lastValidSequence, 3)
            assert.equal(error.dispatchEnabled, false)
            return true
        }
    )
})

test('R05/R06 append authority leaves protected repository and workspace inventories unchanged', async () => {
    const module = await runtime()
    const stateRoot = fs.mkdtempSync(path.join(scratch, 'external-state-'))
    const protectedRoots = ['FsusBlog', 'FsusUI', 'workspace', 'FsusBlog-worktree', 'FsusUI-worktree']
        .map((name) => {
            const directory = path.join(scratch, name)
            fs.mkdirSync(directory)
            fs.writeFileSync(path.join(directory, 'tracked-sentinel'), `${name}\n`)
            return directory
        })
    const before = protectedRoots.map(treeDigest)
    const ledger = frozenLedger()
    const last = ledger.events.pop()
    const ledgerPath = path.join(stateRoot, 'ledger.jsonl')
    writeLedger(ledgerPath, ledger)
    await module.appendEventAtomic({
        event: last,
        ledgerPath,
        projectionPath: path.join(stateRoot, 'projection.json'),
        protectedRoots,
        stateRoot,
        writerRole: 'root-scheduler'
    })
    assert.deepEqual(protectedRoots.map(treeDigest), before)
})

function treeDigest(directory) {
    const files = []
    function visit(current) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name)
            const relative = path.relative(directory, absolute)
            if (entry.isDirectory()) visit(absolute)
            else files.push([relative, digest(fs.readFileSync(absolute))])
        }
    }
    visit(directory)
    return digest(files.sort((left, right) => left[0].localeCompare(right[0])))
}
