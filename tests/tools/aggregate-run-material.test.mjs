import assert from 'node:assert/strict';
import test from 'node:test';

const { prepareAggregateRunMaterial: prepareWithHostLimits } = await import(new URL('../../tools/test-matrix/outcomes/aggregate-run-material.mjs', import.meta.url));
const { governanceContentDigest } = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));

const digest = (value) => `sha256:${value.repeat(64)}`;

// Explicit test-host policy, never a budget accepted from producer material.
const hostExpectedLimits = Object.freeze({ maxDepth: 64, maxNodes: 4096, maxBytes: 65536, maxItems: 4096 });

function prepareAggregateRunMaterial(input)
{
    return prepareWithHostLimits(input, hostExpectedLimits);
}

// These are material-only fixtures, not authenticated producer capabilities.
function fixture()
{
    const body = {
        schema: 'fsusblog.current-run-evidence-context.v1',
        schedulerRunId: 'material-run',
        attemptId: 'attempt-0001',
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: digest('b'),
        candidateIdentity: { id: 'candidate', digest: digest('c') },
        buildIdentity: { id: 'build', digest: digest('d') },
        ownedRoots: ['artifacts/current-run']
    };
    const context = { ...body, contentDigest: governanceContentDigest(body) };
    const identity = {
        schedulerRunId: context.schedulerRunId,
        attemptId: context.attemptId,
        sourceCommit: context.sourceCommit,
        worktreeFingerprint: context.worktreeFingerprint,
        candidateIdentity: context.candidateIdentity,
        buildIdentity: context.buildIdentity,
        executionEnvelopeDigest: digest('1'),
        replayPlanDigest: digest('2'),
        temporalContextDigest: digest('3'),
        toolchainDigest: digest('4'),
        policyDigest: digest('5')
    };
    const members = ['producer-b', 'producer-a'].map((producerId) => ({
        producerId,
        sealedOutcomeReference: { path: `artifacts/current-run/${producerId}.json`, objectDigest: digest('6') },
        expectedIdentity: structuredClone(identity),
        identity: structuredClone(identity),
        summary: {
            status: 'success',
            testSets: { planned: ['test-z', 'test-a'], executed: ['test-a', 'test-z'],
                passed: ['test-z', 'test-a'], failed: [], skipped: [], blocked: [] },
            coverage: { required: ['coverage-a'], observed: ['coverage-a'] },
            stateDigests: [{ id: 'state-a', digest: digest('7') }],
            artifactDigests: [{ id: 'artifact-a', digest: digest('8') }],
            failures: []
        }
    }));
    return { requiredProducerIds: ['producer-b', 'producer-a'], context, members };
}

test('material collection preserves qualified IDs, refs and stable ordering without sealing authority', () =>
{
    const result = prepareAggregateRunMaterial(fixture());
    assert.equal(result.dataOnly, true);
    assert.equal(result.producerVerificationPending, true);
    assert.equal(result.status, 'complete');
    assert.equal(result.completeness, 'complete');
    assert.deepEqual(result.testSets.passed, [
        { producerId: 'producer-a', id: 'test-a' }, { producerId: 'producer-a', id: 'test-z' },
        { producerId: 'producer-b', id: 'test-a' }, { producerId: 'producer-b', id: 'test-z' }
    ]);
    assert.deepEqual(result.producerReferences.map((reference) => reference.producerId), ['producer-a', 'producer-b']);
    assert.equal(result.stateDigests.length, 2);
    assert.equal(result.artifactDigests.length, 2);
    assert.equal(Object.hasOwn(result, 'contentDigest'), false);
    assert.equal(Object.hasOwn(result, 'outcomeFingerprint'), false);
    assert.equal(Object.hasOwn(result, 'verified'), false);
    assert.equal(Object.hasOwn(result, 'qualificationEligible'), false);
});

for (const kind of ['missing', 'duplicate', 'extra'])
{
    test(`material membership rejects ${kind} producer references`, () =>
    {
        const input = fixture();
        if (kind === 'missing')
        {
            input.members.pop();
        }
        if (kind === 'duplicate')
        {
            input.members.push(structuredClone(input.members[0]));
        }
        if (kind === 'extra')
        {
            input.members.push({ ...structuredClone(input.members[0]), producerId: 'producer-extra' });
        }
        assert.throws(() => prepareAggregateRunMaterial(input), /exact-one|duplicate/u);
    });
}

for (const field of ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint',
    'candidateIdentity', 'buildIdentity', 'executionEnvelopeDigest', 'replayPlanDigest',
    'temporalContextDigest', 'toolchainDigest', 'policyDigest'])
{
    test(`material identity rejects changed ${field}`, () =>
    {
        const input = fixture();
        const identity = input.members[0].identity;
        identity[field] = field.endsWith('Identity') ? { id: 'foreign', digest: digest('f') }
            : field === 'sourceCommit' ? 'f'.repeat(40) : digest('f');
        assert.throws(() => prepareAggregateRunMaterial(input), /mismatch/u);
    });
}

test('independent producer envelopes may differ when their explicit expected bindings differ', () =>
{
    const input = fixture();
    input.members[0].expectedIdentity.executionEnvelopeDigest = digest('9');
    input.members[0].identity.executionEnvelopeDigest = digest('9');
    assert.equal(prepareAggregateRunMaterial(input).statusVector.length, 2);
});

test('member failure and cancelled/partial topology cannot become a complete success', () =>
{
    const input = fixture();
    const summary = input.members[0].summary;
    summary.status = 'failed';
    summary.testSets.passed = ['test-a'];
    summary.testSets.failed = ['test-z'];
    summary.failures = [{ id: 'failure-z', kind: 'product.assertion', identity: { testId: 'test-z' } }];
    const failed = prepareAggregateRunMaterial(input);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureTopology[0].id, 'failure-z');
    summary.status = 'cancelled';
    summary.testSets.executed = ['test-a'];
    summary.testSets.failed = [];
    summary.testSets.blocked = ['test-z'];
    assert.equal(prepareAggregateRunMaterial(input).status, 'cancelled');
    summary.status = 'partial';
    assert.equal(prepareAggregateRunMaterial(input).completeness, 'partial');
});

test('success cannot conceal missing coverage, failed results, or failure facts', () =>
{
    for (const mutate of [
        (summary) =>
        {
            summary.coverage.observed = [];
        },
        (summary) =>
        {
            summary.testSets.passed = ['test-a'];
            summary.testSets.failed = ['test-z'];
        },
        (summary) =>
        {
            summary.failures = [{ id: 'failure', kind: 'product.assertion', identity: { testId: 'test-a' } }];
        }
    ])
    {
        const input = fixture();
        mutate(input.members[0].summary);
        assert.throws(() => prepareAggregateRunMaterial(input), /conceals/u);
    }
});

test('material preserves declared skipped and blocked members without deciding release eligibility', () =>
{
    const input = fixture();
    const summary = input.members[0].summary;
    summary.testSets.executed = [];
    summary.testSets.passed = [];
    summary.testSets.skipped = ['test-a'];
    summary.testSets.blocked = ['test-z'];
    const result = prepareAggregateRunMaterial(input);
    assert.equal(result.testSets.skipped.length, 1);
    assert.equal(result.testSets.blocked.length, 1);
    assert.equal(result.producerVerificationPending, true);
    assert.equal(Object.hasOwn(result, 'qualificationEligible'), false);
});

test('test set relations reject duplicate, extra and conflicting terminal membership', () =>
{
    for (const mutate of [
        (sets) =>
        {
            sets.planned.push('test-a');
        },
        (sets) =>
        {
            sets.executed.push('unplanned');
        },
        (sets) =>
        {
            sets.failed.push('test-a');
        },
        (sets) =>
        {
            sets.passed = ['test-a'];
        }
    ])
    {
        const input = fixture();
        mutate(input.members[0].summary.testSets);
        assert.throws(() => prepareAggregateRunMaterial(input), /duplicate|not planned|repeated|terminal/u);
    }
});

test('explicit refs and closed material shape reject paths, raw candidates and verified bools', () =>
{
    for (const path of ['../other.json', '/absolute.json', 'artifacts/*/outcome.json', 'artifacts//outcome.json'])
    {
        const input = fixture();
        input.members[0].sealedOutcomeReference.path = path;
        assert.throws(() => prepareAggregateRunMaterial(input), /explicit/u);
    }
    const input = fixture();
    input.members[0].verified = true;
    assert.throws(() => prepareAggregateRunMaterial(input), /fields mismatch/u);
    assert.throws(() => prepareAggregateRunMaterial({ ...fixture(), verifier: () => true }), /fields mismatch/u);
    const outside = fixture();
    outside.members[0].sealedOutcomeReference.path = 'artifacts/other-run/outcome.json';
    assert.throws(() => prepareAggregateRunMaterial(outside), /owned roots/u);
});

test('material snapshots do not alias original member payloads or expose mutable refs', () =>
{
    const input = fixture();
    const result = prepareAggregateRunMaterial(input);
    input.members[0].sealedOutcomeReference.path = 'artifacts/current-run/changed.json';
    input.members[0].summary.stateDigests[0].digest = digest('f');
    assert.equal(result.producerReferences[1].path, 'artifacts/current-run/producer-b.json');
    assert.equal(result.stateDigests[1].digest, digest('7'));
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.producerReferences[0]), true);
});

function withFailureIdentity(identity)
{
    const input = fixture();
    input.members[0].summary.status = 'failed';
    input.members[0].summary.testSets.passed = ['test-a'];
    input.members[0].summary.testSets.failed = ['test-z'];
    input.members[0].summary.failures = [{ id: 'failure-z', kind: 'product.assertion', identity }];
    return input;
}

for (const [name, create] of [
    ['Map', () => new Map([['testId', 'test-z']])],
    ['Set', () => new Set(['test-z'])],
    ['Date', () => new Date(0)],
    ['function', () => ({ testId: () => 'test-z' })],
    ['nonfinite number', () => ({ testId: Number.POSITIVE_INFINITY })],
    ['proxy', () => new Proxy({ testId: 'test-z' }, {})]
])
{
    test(`public material entry rejects ${name} failure identity before cloning`, () =>
    {
        assert.throws(() => prepareWithHostLimits(withFailureIdentity(create()), hostExpectedLimits), /JSON/u);
    });
}

test('public material entry rejects cyclic identity without recursive cloning or freezing', () =>
{
    const identity = { testId: 'test-z' };
    identity.self = identity;
    assert.throws(() => prepareWithHostLimits(withFailureIdentity(identity), hostExpectedLimits), /cycle/u);
});

test('public material entry refuses hidden, symbol and accessor data without invoking getters', () =>
{
    for (const key of ['hidden', Symbol('hidden')])
    {
        const identity = { testId: 'test-z' };
        Object.defineProperty(identity, key, { value: 'secret', enumerable: false });
        assert.throws(() => prepareWithHostLimits(withFailureIdentity(identity), hostExpectedLimits), /hidden|symbol/u);
    }
    let invoked = 0;
    const identity = { testId: 'test-z' };
    Object.defineProperty(identity, 'other', { enumerable: true, get: () =>
    {
        invoked += 1;
        return 'not-data';
    } });
    assert.throws(() => prepareWithHostLimits(withFailureIdentity(identity), hostExpectedLimits), /accessor/u);
    assert.equal(invoked, 0);
});

test('public material entry requires independent host limits and refuses producer self-budgeting', () =>
{
    assert.throws(() => prepareWithHostLimits(fixture()), /host expected material limits/u);
    assert.throws(() => prepareWithHostLimits({ ...fixture(), hostExpectedLimits }, hostExpectedLimits), /fields mismatch/u);
    for (const field of ['maxDepth', 'maxNodes', 'maxBytes', 'maxItems'])
    {
        assert.throws(() => prepareWithHostLimits(fixture(), { ...hostExpectedLimits, [field]: 0 }), /positive safe integer/u);
        assert.throws(() => prepareWithHostLimits(fixture(), { ...hostExpectedLimits, [field]: 1 }), /exceed/u);
    }
});

test('public material entry admits the literal host depth boundary and refuses one below it', () =>
{
    assert.equal(prepareWithHostLimits(fixture(), { ...hostExpectedLimits, maxDepth: 6 }).dataOnly, true);
    assert.throws(() => prepareWithHostLimits(fixture(), { ...hostExpectedLimits, maxDepth: 5 }), /depth/u);
    let identity = { testId: 'test-z' };
    for (let index = 0; index < 64; index += 1)
    {
        identity = { nested: identity };
    }
    assert.throws(() => prepareWithHostLimits(withFailureIdentity(identity), hostExpectedLimits), /depth/u);
});

test('public material entry bounds arrays and JSON string bytes before spreading or cloning', () =>
{
    const sparse = withFailureIdentity({ data: new Array(hostExpectedLimits.maxItems + 1) });
    assert.throws(() => prepareWithHostLimits(sparse, hostExpectedLimits), /items/u);
    assert.throws(() => prepareWithHostLimits(withFailureIdentity({ data: new Array(2) }), hostExpectedLimits), /sparse/u);
    const expanded = withFailureIdentity({ data: '\u0000'.repeat(hostExpectedLimits.maxBytes) });
    assert.throws(() => prepareWithHostLimits(expanded, hostExpectedLimits), /bytes/u);
});

test('public material entry returns detached frozen plain failure facts with JSON scalar fidelity', () =>
{
    const identity = Object.assign(Object.create(null), { testId: 'test-z', detail: ['a', 1, true, null, '\ud800'] });
    const result = prepareWithHostLimits(withFailureIdentity(identity), hostExpectedLimits);
    identity.detail[0] = 'changed';
    assert.deepEqual(result.failureTopology[0].identity.detail, ['a', 1, true, null, '\ud800']);
    assert.equal(Object.isFrozen(result.failureTopology[0].identity), true);
    assert.equal(Object.isFrozen(result.failureTopology[0].identity.detail), true);
    assert.throws(() =>
    {
        result.failureTopology[0].identity.detail[0] = 'changed';
    }, TypeError);
});

test('public material entry refuses array length beyond remaining nodes before sparse-key validation', () =>
{
    const input = withFailureIdentity({ data: new Array(hostExpectedLimits.maxNodes) });
    const limits = { ...hostExpectedLimits, maxItems: 65536 };
    assert.throws(() => prepareWithHostLimits(input, limits), /nodes exceed/u);
});

test('public material entry refuses array minimum JSON bytes before sparse-key validation', () =>
{
    const input = withFailureIdentity({ data: new Array(32768) });
    const limits = { ...hostExpectedLimits, maxNodes: 65536, maxItems: 65536 };
    assert.throws(() => prepareWithHostLimits(input, limits), /bytes exceed/u);
});
