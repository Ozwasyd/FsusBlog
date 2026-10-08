import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { adaptReleaseReliabilitySemanticOutcome, releaseReliabilityOutcomeAuthorityId,
    releaseReliabilityOutcomeProducerId } = await import(
    new URL('../../tools/test-matrix/outcomes/release-reliability-adapter.mjs', import.meta.url)
);
const { digestCanonical } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { sealDocument } = await import(new URL('../../tools/test/release-reliability-receipt.mjs', import.meta.url));
const { validateProducerSemanticOutcomeCandidate } = await import(
    new URL('../../tools/test-matrix/outcomes/outcome-contract.mjs', import.meta.url)
);
const registry = JSON.parse(fs.readFileSync(new URL(
    '../../config/testing/release-reliability-lifecycle-action-registry.json', import.meta.url
), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(new URL(
    '../../config/testing/release-reliability-scenario-catalog.json', import.meta.url
), 'utf8'));
const d = text => digestCanonical(text);

// Independent DATA_ONLY expected inputs model a held verifier handoff. These are
// controlled fixtures, not a physical seven-scenario run or an authority receipt.
function fixture(classification = 'qualified-success')
{
    const identity = { buildIdentity: d('build'), executionEnvelopeDigest: d('envelope'),
        producerId: releaseReliabilityOutcomeProducerId, replayPlanDigest: d('replay'),
        schedulerRunId: 'controlled-run', sourceCommit: 'a'.repeat(40),
        temporalContextDigest: d('temporal'), toolchainDigest: d('tools'), worktreeFingerprint: d('tree') };
    const binding = { identity, invocationId: 'controlled-invocation', attemptDigest: d('attempt'),
        currentRunDigest: d('locator'), fixtureDigest: d('fixture'), machineDigest: d('machine'),
        policyDigest: d('policy'), runtimeDigest: d('runtime') };
    const runIdentityReference = { path: 'identity.json', contentDigest: d('run-identity') };
    const inputAuthorityRefs = [{ kind: 'reliability-terminal-verification', path: 'verification.json',
        digest: d('independent-verification') }];
    const attemptEligibility = { aggregateDigest: d('aggregate'), attemptDigest: binding.attemptDigest,
        attemptNumber: 1, cleanFirstAttempt: true, firstFailure: false, qualificationEligible: true };
    const scenarioResults = [];
    const terminalEvents = [];
    const members = [];
    const receiptDigests = {};
    const isolationDigests = {};
    const lifecycleByScenario = {};
    for (const scenario of catalog.scenarios)
    {
        const scenarioId = scenario.id;
        const terminalClass = scenarioId === catalog.scenarios[0].id ? classification : 'qualified-success';
        const unspawned = ['precondition-failure', 'not-reached'].includes(terminalClass);
        const notReached = terminalClass === 'not-reached';
        const actions = registry.actions.filter(action => action.scenarioId === scenarioId).map(plan =>
        {
            const notRun = notReached || unspawned && plan.phase !== 'precondition';
            const receipt = notRun ? null : { path: `${scenarioId}/${plan.actionId}.json`,
                bytesDigest: d(plan.actionId), actionId: plan.actionId, phase: plan.phase,
                stateDomains: plan.stateDomains };
            const processTreeReceipt = notRun ? null : { path: `${scenarioId}/${plan.actionId}-tree.json`,
                bytesDigest: d(`${plan.actionId}-tree`), postObservation: 'zero-members', logComplete: true };
            if (receipt)
            {
                receiptDigests[receipt.path] = receipt.bytesDigest;
                receiptDigests[processTreeReceipt.path] = processTreeReceipt.bytesDigest;
            }
            isolationDigests[plan.actionId] = notRun ? null : d(`${plan.actionId}-isolation`);
            return { actionId: plan.actionId, phase: plan.phase,
                status: notRun ? 'not-run' : terminalClass !== 'qualified-success'
                    && plan.phase === (unspawned ? 'precondition' : 'measurement') ? 'failed' : 'passed',
                receipt, processTreeReceipt, terminalFence: notRun ? null : { status: 'closed', lateEvidenceAccepted: false } };
        });
        lifecycleByScenario[scenarioId] = actions.map(action => ({ actionId: action.actionId,
            phase: action.phase, status: action.status, stateDomains: registry.actions
                .find(plan => plan.actionId === action.actionId).stateDomains,
            isolationEvidenceDigest: isolationDigests[action.actionId] }));
        const authoritativeEvidence = unspawned || terminalClass === 'cancelled' ? null
            : { path: scenario.authoritativeEvidence.path, digest: d(`${scenarioId}-producer`) };
        if (authoritativeEvidence)
        {
            receiptDigests[authoritativeEvidence.path] = authoritativeEvidence.digest;
        }
        const result = sealDocument({ schema: 'fsusblog.release-reliability-scenario-result.v3',
            scenarioId, runId: identity.schedulerRunId, invocationId: binding.invocationId,
            identity: runIdentityReference, producerSpawned: !unspawned,
            status: terminalClass === 'qualified-success' ? 'passed' : notReached ? 'not-reached' : 'failed',
            evidenceClass: 'correctness', qualificationEligible: terminalClass === 'qualified-success',
            authoritativeEvidence, lifecycle: { actions: notReached ? [] : actions,
                resetPostObservation: { status: 'passed' }, finalPostObservation: { status: 'passed' } },
            firstFailure: terminalClass === 'qualified-success' ? null : { phase: unspawned ? 'precondition' : 'measurement',
                message: 'controlled original failure' }, cleanupFailures: [] });
        const failureKind = { 'product-failure': 'product.assertion', 'precondition-failure': 'contract.missing-evidence',
            'infra-no-conclusion': 'infra.environment-mismatch', cancelled: 'infra.process-signal',
            'not-reached': 'contract.missing-evidence' }[terminalClass];
        const failureIdentity = { 'product-failure': { assertionId: `${scenarioId}:budget` },
            'infra-no-conclusion': { executionEnvelopeDigest: identity.executionEnvelopeDigest },
            cancelled: { attemptNumber: 1 } }[terminalClass] ?? {};
        members.push({ scenarioId, binding,
            isolationEvidenceDigests: Object.fromEntries(actions.map(action =>
                [action.actionId, isolationDigests[action.actionId]])),
            failures: failureKind ? [{ kind: failureKind, identity: failureIdentity, evidenceId: `${scenarioId}:measurement`,
                phase: notReached ? 'not-reached' : unspawned ? 'precondition' : 'measurement' }] : [],
            semanticEvidence: authoritativeEvidence ? { producerEvidenceDigest: authoritativeEvidence.digest,
                metrics: { measuredBudget: 3 }, state: { retainedHandles: 0 },
                assertions: [{ assertionId: `${scenarioId}:budget`, status: terminalClass === 'product-failure' ? 'failed' : 'passed' }] } : null });
        scenarioResults.push(result);
        terminalEvents.push({ scenarioId, terminalClassification: terminalClass,
            reachedPhase: notReached ? 'not-reached' : unspawned ? 'precondition' : 'postcondition',
            producerSpawned: !unspawned, exitCode: unspawned ? null : terminalClass === 'qualified-success' ? 0 : 1,
            signal: terminalClass === 'cancelled' ? 'SIGTERM' : null, authoritativeEvidence,
            firstBlockingReason: terminalClass === 'qualified-success' ? null : 'controlled original failure',
            lifecycleReceipts: structuredClone(actions.flatMap(action =>
                [action.receipt, action.processTreeReceipt].filter(Boolean))),
            startedAt: notReached ? null : '2026-10-08T00:00:00.000Z', finishedAt: '2026-10-08T00:00:01.000Z' });
    }
    const timeline = sealDocument({ schema: 'fsusblog.release-reliability-timeline.v3', status: 'complete',
        runId: identity.schedulerRunId, invocationId: binding.invocationId, identity: runIdentityReference,
        terminalEvents, scenarioResults: scenarioResults.map(result => ({ scenarioId: result.scenarioId,
            resultContentDigest: result.contentDigest })) });
    const evidence = { binding, scenarioResults, timeline, members, groupStatus: 'qualified' };
    const expected = structuredClone({ identity, binding, inputAuthorityRefs, runIdentityReference,
        verificationReceiptDigest: inputAuthorityRefs[0].digest, timelineDigest: timeline.contentDigest,
        terminalEvents, receiptDigests, isolationDigests, lifecycleByScenario,
        resultDigests: Object.fromEntries(scenarioResults.map(result => [result.scenarioId, result.contentDigest])),
        memberDigests: Object.fromEntries(members.map(member => [member.scenarioId, digestCanonical(member)])) });
    return { identity, inputAuthorityRefs, attemptEligibility, evidence, expected };
}

function reseal(input, index = 0)
{
    const result = sealDocument(input.evidence.scenarioResults[index]);
    input.evidence.scenarioResults[index] = result;
    input.expected.resultDigests[result.scenarioId] = result.contentDigest;
    input.expected.memberDigests[result.scenarioId] = digestCanonical(input.evidence.members[index]);
    input.evidence.timeline.scenarioResults.find(item => item.scenarioId === result.scenarioId)
        .resultContentDigest = result.contentDigest;
    input.evidence.timeline = sealDocument(input.evidence.timeline);
    input.expected.timelineDigest = input.evidence.timeline.contentDigest;
}

test('exact-seven qualified members produce a verified candidate and preserve all lifecycle phases', () =>
{
    const result = adaptReleaseReliabilitySemanticOutcome(fixture());
    assert.equal(result.verificationStatus, 'verified');
    assert.equal(result.producerAuthorityId, releaseReliabilityOutcomeAuthorityId);
    assert.equal(result.producerAuthorityId, 'tools/test-matrix/outcomes/release-reliability-adapter.mjs');
    assert.equal(result.outcome.status, 'success');
    assert.equal(result.outcome.membership.memberOutcomes.length, 7);
    assert.ok(result.outcome.membership.memberOutcomes.every(member => member.planned && member.executed
        && member.terminalClassification === 'qualified-success' && member.lifecycle.length === 5));
    assert.equal(Object.hasOwn(result, 'fingerprint'), false);
});

test('missing extra duplicate and orphan scenarios fail closed across results events and semantic members', () =>
{
    for (const field of ['scenarioResults', 'members'])
    {
        for (const mutation of ['missing', 'extra', 'duplicate', 'orphan'])
        {
            const input = fixture();
            const entries = input.evidence[field];
            if (mutation === 'missing')
            {
                entries.pop();
            }
            if (mutation === 'extra')
            {
                entries.push({ ...entries[0], scenarioId: 'unknown' });
            }
            if (mutation === 'duplicate')
            {
                entries[1] = entries[0];
            }
            if (mutation === 'orphan')
            {
                entries[0].scenarioId = 'unknown';
            }
            assert.throws(() => adaptReleaseReliabilitySemanticOutcome(input));
        }
    }
    const input = fixture();
    input.evidence.timeline.terminalEvents.pop();
    reseal(input);
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(input));
});

test('product failure retains assertion scenario lifecycle and evidence identity without overwriting peers', () =>
{
    const result = adaptReleaseReliabilitySemanticOutcome(fixture('product-failure'));
    const failed = result.outcome.membership.memberOutcomes.find(member => member.terminalClassification === 'product-failure');
    assert.equal(result.outcome.status, 'failed');
    assert.equal(failed.failureReasons[0].kind, 'product.assertion');
    assert.equal(failed.failureReasons[0].identity.scenarioId, failed.scenarioId);
    assert.equal(failed.failureReasons[0].identity.lifecyclePhase, 'measurement');
    assert.equal(result.outcome.membership.memberOutcomes.filter(member => member.terminalClassification === 'qualified-success').length, 6);
});

test('precondition failure and not reached preserve planned lifecycle without measurement authority', () =>
{
    for (const classification of ['precondition-failure', 'not-reached'])
    {
        const result = adaptReleaseReliabilitySemanticOutcome(fixture(classification));
        const member = result.outcome.membership.memberOutcomes.find(item => item.terminalClassification === classification);
        assert.equal(member.executed, false);
        assert.equal(member.semanticEvidence, null);
        assert.equal(member.failureReasons[0].kind, 'contract.missing-evidence');
        assert.equal(member.lifecycle.find(action => action.phase === 'measurement').status, 'not-run');
    }
});

test('infrastructure no conclusion and cancellation cannot become product failures or successes', () =>
{
    for (const classification of ['infra-no-conclusion', 'cancelled'])
    {
        const input = fixture(classification);
        const result = adaptReleaseReliabilitySemanticOutcome(input);
        assert.equal(result.outcome.status, 'failed');
        assert.ok(result.outcome.reasons.every(failure => failure.kind.startsWith('infra.')));
        input.evidence.members[0].failures[0].kind = 'product.assertion';
        input.evidence.members[0].failures[0].identity = { assertionId: 'budget' };
        reseal(input);
        assert.throws(() => adaptReleaseReliabilitySemanticOutcome(input), /non-product/u);
    }
});

test('unknown terminal aliases and reclassified infra events are rejected even with a resealed timeline', () =>
{
    for (const classification of ['success', 'ok', 'product-failure', 'qualified-success'])
    {
        const input = fixture('infra-no-conclusion');
        input.evidence.timeline.terminalEvents[0].terminalClassification = classification;
        reseal(input);
        assert.throws(() => adaptReleaseReliabilitySemanticOutcome(input), /terminal events/u);
    }
});

test('missing lifecycle phases duplicate actions unknown statuses and incomplete isolation fail closed', () =>
{
    for (const mutation of ['missing', 'duplicate', 'unknown', 'isolation', 'domains', 'fence'])
    {
        const input = fixture();
        const actions = input.evidence.scenarioResults[0].lifecycle.actions;
        if (mutation === 'missing')
        {
            actions.pop();
        }
        if (mutation === 'duplicate')
        {
            actions[1] = actions[0];
        }
        if (mutation === 'unknown')
        {
            actions[0].status = 'ok';
        }
        if (mutation === 'isolation')
        {
            actions[0].processTreeReceipt.postObservation = 'members-remain';
        }
        if (mutation === 'domains')
        {
            actions[0].receipt.stateDomains = [];
        }
        if (mutation === 'fence')
        {
            actions[0].terminalFence.lateEvidenceAccepted = true;
        }
        reseal(input);
        assert.throws(() => adaptReleaseReliabilitySemanticOutcome(input));
    }
});

test('group qualification never replaces a failed member or its failure topology', () =>
{
    const input = fixture('product-failure');
    input.evidence.groupStatus = 'qualified';
    input.evidence.qualifiedReceipt = { status: 'qualified', allPassed: true };
    assert.equal(adaptReleaseReliabilitySemanticOutcome(input).outcome.status, 'failed');
    input.evidence.members[0].failures = [];
    reseal(input);
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(input), /topology/u);
});

test('error text logs trace paths and timing are excluded from semantic content', () =>
{
    const input = fixture('product-failure');
    const original = adaptReleaseReliabilitySemanticOutcome(input);
    input.evidence.scenarioResults[0].firstFailure.message = 'a completely different error message';
    input.evidence.scenarioResults[0].stdoutLog = '/other/log';
    input.evidence.scenarioResults[0].durationMs = 9999;
    input.evidence.members[0].diagnostics = { log: '/other/path', trace: 'different trace', timestamp: 'later' };
    input.evidence.members[0].semanticEvidence.assertions[0].message = 'diagnostic assertion text';
    input.evidence.members[0].semanticEvidence.assertions[0].log = '/other/assertion/log';
    reseal(input);
    const changed = adaptReleaseReliabilitySemanticOutcome(input);
    assert.equal(changed.outcome.semanticPayloadDigest, original.outcome.semanticPayloadDigest);
    assert.deepEqual(changed.outcome.reasons, original.outcome.reasons);
});

test('semantic metric state assertion and isolation changes remain visible', () =>
{
    for (const field of ['metrics', 'state', 'assertions', 'isolation'])
    {
        const input = fixture();
        const original = adaptReleaseReliabilitySemanticOutcome(input);
        if (field === 'metrics')
        {
            input.evidence.members[0].semanticEvidence.metrics.measuredBudget = 4;
        }
        if (field === 'state')
        {
            input.evidence.members[0].semanticEvidence.state.retainedHandles = 1;
        }
        if (field === 'assertions')
        {
            input.evidence.members[0].semanticEvidence.assertions[0].assertionId += ':changed';
        }
        if (field === 'isolation')
        {
            const actionId = input.evidence.scenarioResults[0].lifecycle.actions[0].actionId;
            input.expected.isolationDigests[actionId] = d('changed isolation');
            input.evidence.members[0].isolationEvidenceDigests[actionId] = d('changed isolation');
            input.expected.lifecycleByScenario[input.evidence.members[0].scenarioId][0].isolationEvidenceDigest = d('changed isolation');
        }
        reseal(input);
        assert.notEqual(adaptReleaseReliabilitySemanticOutcome(input).outcome.semanticPayloadDigest,
            original.outcome.semanticPayloadDigest);
    }
});

test('cross run source worktree build runtime fixture machine policy envelope replay temporal attempt and locator fail closed', () =>
{
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'buildIdentity', 'executionEnvelopeDigest',
        'replayPlanDigest', 'temporalContextDigest', 'schedulerRunId', 'toolchainDigest'])
    {
        const input = fixture();
        input.evidence.members[0].binding.identity[field] = d('foreign');
        assert.throws(() => adaptReleaseReliabilitySemanticOutcome(input));
    }
    for (const field of ['invocationId', 'runtimeDigest', 'fixtureDigest', 'machineDigest',
        'policyDigest', 'attemptDigest', 'currentRunDigest'])
    {
        const input = fixture();
        input.evidence.members[0].binding[field] = d('foreign');
        assert.throws(() => adaptReleaseReliabilitySemanticOutcome(input));
    }
});

test('result receipt terminal and semantic evidence tampering cannot be hidden by self resealing', () =>
{
    const input = fixture();
    input.evidence.scenarioResults[0].status = 'failed';
    input.evidence.scenarioResults[0] = sealDocument(input.evidence.scenarioResults[0]);
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(input), /digest mismatch/u);
    const receipt = fixture();
    receipt.evidence.scenarioResults[0].lifecycle.actions[0].receipt.bytesDigest = d('tampered');
    reseal(receipt);
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(receipt), /receipt/u);
    const semantic = fixture();
    semantic.evidence.members[0].semanticEvidence.metrics.measuredBudget = 900;
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(semantic), /semantic member/u);
});

test('precondition and not reached cannot fabricate producer evidence or executed lifecycle', () =>
{
    for (const classification of ['precondition-failure', 'not-reached'])
    {
        const input = fixture(classification);
        input.evidence.members[0].semanticEvidence = { metrics: {}, state: {}, assertions: [] };
        reseal(input);
        assert.throws(() => adaptReleaseReliabilitySemanticOutcome(input), /unspawned/u);
    }
});

test('missing independent verifier inputs stale receipt expectations and orphan receipts fail closed', () =>
{
    const missing = fixture();
    delete missing.expected;
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(missing), /independent/u);
    const orphan = fixture();
    orphan.expected.receiptDigests['orphan.json'] = d('orphan');
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(orphan), /receipt membership/u);
    const verifier = fixture();
    verifier.expected.verificationReceiptDigest = d('foreign verifier');
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(verifier), /verification/u);
});

test('unqualified recovered and later attempts cannot produce successful candidates', () =>
{
    for (const changed of [{ qualificationEligible: false }, { cleanFirstAttempt: false },
        { attemptNumber: 2 }, { firstFailure: true }])
    {
        const input = fixture();
        Object.assign(input.attemptEligibility, changed);
        const result = adaptReleaseReliabilitySemanticOutcome(input);
        assert.equal(result.outcome.status, 'failed');
        assert.ok(result.outcome.reasons.some(failure => failure.kind === 'contract.identity'));
    }
});

test('candidate content tampering is rejected by the original outcome verifier', () =>
{
    const candidate = adaptReleaseReliabilitySemanticOutcome(fixture());
    candidate.outcome.membership.memberOutcomes[0].semanticEvidence.metricsDigest = d('tampered');
    assert.throws(() => validateProducerSemanticOutcomeCandidate(candidate), /content digest/u);
});

test('qualified terminal cannot hide a failed assertion or unqualified producer', () =>
{
    const assertion = fixture();
    assertion.evidence.members[0].semanticEvidence.assertions[0].status = 'failed';
    reseal(assertion);
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(assertion), /passing correctness/u);
    const producer = fixture();
    producer.evidence.scenarioResults[0].qualificationEligible = false;
    reseal(producer);
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(producer), /passing correctness/u);
});

test('canonical failure kinds and assertion identities cannot be invented or orphaned', () =>
{
    const kind = fixture('product-failure');
    kind.evidence.members[0].failures[0].kind = 'product.unknown';
    reseal(kind);
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(kind), /canonical failure/u);
    const assertion = fixture('product-failure');
    assertion.evidence.members[0].failures[0].identity.assertionId = 'orphan';
    reseal(assertion);
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(assertion), /measured assertion/u);
});

test('getters proxies cycles and sparse arrays cannot execute inside evidence adaptation', () =>
{
    const input = fixture();
    let reads = 0;
    Object.defineProperty(input.evidence, 'exploit', { enumerable: true, get()
    {
        reads += 1;
        return true;
    } });
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(input), /accessors/u);
    assert.equal(reads, 0);
    const proxy = fixture();
    proxy.evidence = new Proxy(proxy.evidence, {});
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(proxy), /plain JSON/u);
    const cycle = fixture();
    cycle.evidence.loop = cycle.evidence;
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(cycle), /acyclic/u);
    const sparse = fixture();
    delete sparse.evidence.members[0];
    assert.throws(() => adaptReleaseReliabilitySemanticOutcome(sparse), /sparse/u);
});
