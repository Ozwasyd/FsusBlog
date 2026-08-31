import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    scanEntropyGovernanceSource,
    validateTestEntropyGovernance,
    verifyRepositoryTestEntropyGovernance
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test/check-test-entropy-governance.mjs';
import {
    REPLAY_PLAN_SCHEMA,
    REPLAY_RECEIPT_SCHEMA,
    canonicalDigest,
    canonicalJson,
    canonicalTestId,
    collectCanonicalDiscovery,
    deriveReplayStream,
    planExactShards,
    resolveRootSeed,
    sealReplayPlan,
    sealReplayReceipt,
    sortCanonicalTestIds,
    validateCanonicalTestId,
    validateDiscoveryAgainstPlan,
    validateReplayBundle,
    validateReplayPlan,
    validateReplayReceipt
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test/execution-replay-contract.mjs';

const zeroDigest = `sha256:${'0'.repeat(64)}`;
const oneDigest = `sha256:${'1'.repeat(64)}`;
const rootSeed = `seed256:${'ab'.repeat(32)}`;

const alphaId = canonicalTestId({
    framework: 'node-test',
    source: 'tests/tools/alpha.test.mjs',
    name: ['replay', 'alpha']
});
const betaId = canonicalTestId({
    framework: 'node-test',
    source: 'tests/tools/beta.test.mjs',
    name: ['replay', 'beta']
});
const parameterizedId = canonicalTestId({
    framework: 'xunit',
    source: 'tests/backend/Unit/ReplayTests.cs',
    name: ['ReplayTests', 'AcceptsCase'],
    caseIdentity: { kind: 'parameterized', id: 'row:0001/value=İstanbul' }
});

function replayPlan({
    testIds = [betaId, alphaId],
    shardCount = 2,
    randomStreams = [],
    run = { id: 'run-1', mode: 'qualification' },
    source = { commit: 'a'.repeat(40), worktreeFingerprint: zeroDigest },
    producer = { id: 'node-unit', framework: 'node-test' },
    entropySource = 'cli',
    allowEmptyShards = false,
    workers = ['worker-a', 'worker-b']
} = {})
{
    const assignment = planExactShards({ testIds, shardCount, allowEmptyShards });
    return sealReplayPlan({
        schema: REPLAY_PLAN_SCHEMA,
        source,
        producer,
        run,
        rootSeed,
        entropySources: [{ id: 'root-seed', kind: 'root-seed', source: entropySource }],
        randomStreams,
        ...assignment,
        workers: {
            ids: workers,
            assignmentPolicy: 'framework-owned-after-seal'
        },
        frameworkModes: [
            { name: 'isolation', value: 'process' },
            { name: 'retry', value: 'disabled' }
        ],
        schedulerReadyPolicy: {
            kind: 'sealed-shard-order',
            dynamicReassignment: false
        },
        schedulerShuffleSeed: 'scheduler-seed-v1',
        command: {
            executable: '/usr/bin/node',
            args: ['--test'],
            environmentDigest: oneDigest
        }
    });
}

function replayReceipt(plan, overrides = {})
{
    const testIds = overrides.testIds ?? [...plan.testEnumerationOrder];
    const shards = overrides.shards ?? plan.shards.map((shard) => ({
        id: shard.id,
        testIds: shard.testIds.filter((identifier) => testIds.includes(identifier))
    }));
    const workers = overrides.workers ?? [
        { id: plan.workers.ids[0], testIds: testIds.filter((_, index) => index % 2 === 0) },
        { id: plan.workers.ids[1] ?? plan.workers.ids[0], testIds: testIds.filter((_, index) => index % 2 === 1) }
    ].filter((worker, index, all) => all.findIndex((candidate) => candidate.id === worker.id) === index);
    const workerFor = (identifier) => workers.find((worker) => worker.testIds.includes(identifier))?.id;
    const shardFor = (identifier) => shards.find((shard) => shard.testIds.includes(identifier))?.id;
    return sealReplayReceipt({
        schema: REPLAY_RECEIPT_SCHEMA,
        source: overrides.source ?? plan.source,
        producer: overrides.producer ?? plan.producer,
        run: overrides.run ?? plan.run,
        planDigest: overrides.planDigest ?? plan.planDigest,
        rootSeed: overrides.rootSeed ?? plan.rootSeed,
        entropySources: overrides.entropySources ?? plan.entropySources,
        randomStreams: overrides.randomStreams ?? plan.randomStreams,
        testIds,
        shards,
        workers,
        admissionSequence: overrides.admissionSequence ?? testIds.map((testId, ordinal) => ({
            ordinal,
            testId,
            shardId: shardFor(testId),
            workerId: workerFor(testId)
        })),
        processOutcome: overrides.processOutcome ?? {
            status: 'passed',
            exitCode: 0,
            signal: null
        }
    });
}

test('canonical JSON and digest are stable across object insertion order', () =>
{
    assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
    assert.equal(
        canonicalDigest({ z: 1, a: { y: 2, x: 3 } }),
        canonicalDigest({ a: { x: 3, y: 2 }, z: 1 })
    );
    assert.throws(() => canonicalJson({ value: undefined }), /canonical JSON only accepts JSON values/u);
});

test('root seed resolution is explicit for qualification and immediately emits generated diagnostics', () =>
{
    assert.deepEqual(resolveRootSeed({ cliSeed: 'AB'.repeat(32), mode: 'qualification' }), {
        rootSeed,
        source: 'cli',
        sealed: true
    });
    assert.deepEqual(resolveRootSeed({ planSeed: rootSeed, mode: 'qualification' }), {
        rootSeed,
        source: 'plan',
        sealed: true
    });
    assert.throws(
        () => resolveRootSeed({ mode: 'qualification' }),
        (error) => error.reasonCode === 'replay.root-seed-missing'
    );
    assert.throws(
        () => resolveRootSeed({ cliSeed: rootSeed, planSeed: `seed256:${'cd'.repeat(32)}` }),
        (error) => error.reasonCode === 'replay.root-seed-conflict'
    );
    const emitted = [];
    const generated = resolveRootSeed({
        mode: 'diagnostic',
        emitGenerated: (seed) => emitted.push(seed),
        generate: () => Buffer.alloc(32, 0x42)
    });
    assert.equal(generated.rootSeed, `seed256:${'42'.repeat(32)}`);
    assert.deepEqual(emitted, [generated.rootSeed]);
    assert.throws(
        () => resolveRootSeed({ mode: 'diagnostic', generate: () => Buffer.alloc(32) }),
        (error) => error.reasonCode === 'replay.root-seed-unsealed'
    );
});

test('root seed domain separation is deterministic and binds producer, consumer, stream and version', () =>
{
    const input = {
        rootSeed,
        producerId: 'node-unit',
        canonicalTestId: alphaId,
        streamId: 'property-cases',
        version: 'v1'
    };
    const first = deriveReplayStream(input);
    assert.deepEqual(first, deriveReplayStream(input));
    assert.notEqual(first.seed, deriveReplayStream({ ...input, producerId: 'node-integration' }).seed);
    assert.notEqual(first.seed, deriveReplayStream({ ...input, canonicalTestId: betaId }).seed);
    assert.notEqual(first.seed, deriveReplayStream({ ...input, streamId: 'fuzz-cases' }).seed);
    assert.throws(
        () => deriveReplayStream({ ...input, version: 'v2' }),
        (error) => error.reasonCode === 'replay.stream-invalid'
    );
});

test('canonical IDs preserve parameterized, property and fuzz identity with fixed case-sensitive syntax', () =>
{
    const property = canonicalTestId({
        framework: 'vitest',
        source: 'tests/frontend/property/Model.test.ts',
        name: ['model property'],
        caseIdentity: { kind: 'property', id: 'iteration:000042' }
    });
    const fuzz = canonicalTestId({
        framework: 'libfuzzer',
        source: 'tests/native/fuzz/Aeds.cpp',
        name: 'AEDS decoder',
        caseIdentity: { kind: 'fuzz', id: 'sha256:abcdef' }
    });
    assert.equal(validateCanonicalTestId(parameterizedId), parameterizedId);
    assert.match(property, /\?case=property:iteration%3A000042$/u);
    assert.match(fuzz, /\?case=fuzz:sha256%3Aabcdef$/u);
    assert.notEqual(
        canonicalTestId({ framework: 'vitest', source: 'tests/A.test.ts', name: 'Case' }),
        canonicalTestId({ framework: 'vitest', source: 'tests/a.test.ts', name: 'case' })
    );
    assert.throws(
        () => validateCanonicalTestId('vitest:tests/a.test.ts#case?case=parameterized:%61'),
        (error) => error.reasonCode === 'replay.test-id-invalid'
    );
});

test('path separator equivalence and input enumeration order produce one stable canonical order', () =>
{
    const windowsInput = canonicalTestId({
        framework: 'node-test',
        source: 'tests\\tools\\alpha.test.mjs',
        name: ['replay', 'alpha']
    });
    assert.equal(windowsInput, alphaId);
    const expected = sortCanonicalTestIds([parameterizedId, betaId, alphaId]);
    assert.deepEqual(sortCanonicalTestIds([alphaId, parameterizedId, betaId]), expected);
    assert.deepEqual(sortCanonicalTestIds([betaId, alphaId, parameterizedId]), expected);
    assert.equal(canonicalDigest(expected), canonicalDigest(sortCanonicalTestIds([...expected].reverse())));
});

test('framework prefix prevents collisions while filesystem case remains semantically significant', () =>
{
    const node = canonicalTestId({ framework: 'node-test', source: 'tests/Same.test.ts', name: 'same' });
    const vitest = canonicalTestId({ framework: 'vitest', source: 'tests/Same.test.ts', name: 'same' });
    const lowercase = canonicalTestId({ framework: 'node-test', source: 'tests/same.test.ts', name: 'same' });
    assert.equal(new Set([node, vitest, lowercase]).size, 3);
    assert.deepEqual(sortCanonicalTestIds([lowercase, node]), [node, lowercase]);
});

test('framework-neutral discovery adapter only returns canonical IDs and static metadata', async () =>
{
    let calls = 0;
    const result = await collectCanonicalDiscovery({
        discover: async (context) =>
        {
            calls += 1;
            assert.deepEqual(context, { project: 'unit' });
            return [
                { canonicalTestId: betaId, staticMetadata: { owner: 'b' } },
                { canonicalTestId: alphaId, staticMetadata: { owner: 'a' } }
            ];
        }
    }, { project: 'unit' });
    assert.equal(calls, 1);
    assert.deepEqual(result.map((entry) => entry.canonicalTestId), [alphaId, betaId]);
    await assert.rejects(
        collectCanonicalDiscovery({ discover: async () => [
            { canonicalTestId: alphaId, staticMetadata: {} },
            { canonicalTestId: alphaId, staticMetadata: {} }
        ] }),
        (error) => error.reasonCode === 'replay.test-id-duplicate'
    );
});

test('exact shard planner is stable for 1, 2 and N shards regardless of discovery order', () =>
{
    const ids = [
        alphaId,
        betaId,
        parameterizedId,
        canonicalTestId({ framework: 'node-test', source: 'tests/tools/gamma.test.mjs', name: 'gamma' }),
        canonicalTestId({ framework: 'node-test', source: 'tests/tools/delta.test.mjs', name: 'delta' })
    ];
    for (const shardCount of [1, 2, 5])
    {
        const first = planExactShards({ testIds: ids, shardCount });
        const second = planExactShards({ testIds: [...ids].reverse(), shardCount });
        assert.deepEqual(first, second);
        assert.equal(first.shards.length, shardCount);
        assert.deepEqual(first.shards.flatMap((shard) => shard.testIds), first.testEnumerationOrder);
        assert.equal(new Set(first.shards.flatMap((shard) => shard.testIds)).size, ids.length);
    }
});

test('empty shard policy is explicit and a ratio without membership fails closed', () =>
{
    assert.throws(
        () => planExactShards({ testIds: [alphaId], shardCount: 2 }),
        (error) => error.reasonCode === 'replay.shard-invalid'
    );
    const allowed = planExactShards({ testIds: [alphaId], shardCount: 2, allowEmptyShards: true });
    assert.equal(allowed.shards[1].testIds.length, 0);
    assert.equal(allowed.shardPolicy.emptyShards, 'allow');

    const plan = replayPlan();
    const incomplete = structuredClone(plan);
    incomplete.shards = [{ id: 'shard-0001', ratio: '1/4' }];
    assert.throws(
        () => validateReplayPlan(incomplete),
        (error) => ['replay.schema-invalid', 'replay.shard-invalid'].includes(error.reasonCode)
    );
});

test('shard membership rejects missing, extra, duplicate and unknown canonical test IDs', () =>
{
    const plan = replayPlan();
    for (const mutate of [
        (candidate) => candidate.shards[0].testIds.pop(),
        (candidate) => candidate.shards[0].testIds.push(candidate.shards[1].testIds[0]),
        (candidate) => candidate.shards[0].testIds.push(canonicalTestId({
            framework: 'node-test', source: 'tests/tools/extra.test.mjs', name: 'extra'
        }))
    ])
    {
        const candidate = structuredClone(plan);
        mutate(candidate);
        assert.throws(
            () => validateReplayPlan(candidate),
            (error) => [
                'replay.shard-invalid',
                'replay.shard-membership-mismatch',
                'replay.test-id-duplicate'
            ].includes(error.reasonCode)
        );
    }
});

test('sealed plan rejects discovery drift before execution instead of rewriting membership', () =>
{
    const plan = replayPlan();
    assert.deepEqual(validateDiscoveryAgainstPlan(plan, [betaId, alphaId]), {
        exact: true,
        testCount: 2,
        enumerationDigest: plan.enumerationDigest
    });
    assert.throws(
        () => validateDiscoveryAgainstPlan(plan, [alphaId]),
        (error) => error.reasonCode === 'replay.discovery-drift' && error.details.missing.includes(betaId)
    );
    const extra = canonicalTestId({ framework: 'node-test', source: 'tests/tools/new.test.mjs', name: 'new' });
    assert.throws(
        () => validateDiscoveryAgainstPlan(plan, [alphaId, betaId, extra]),
        (error) => error.reasonCode === 'replay.discovery-drift' && error.details.extra.includes(extra)
    );
    assert.throws(
        () => validateDiscoveryAgainstPlan(plan, [alphaId, alphaId, betaId]),
        (error) => error.reasonCode === 'replay.test-id-duplicate'
    );
});

test('plan explicitly accepts randomStreams=[] and rejects missing, duplicate or tampered stream bindings', () =>
{
    const withoutRandomness = replayPlan({ randomStreams: [] });
    assert.deepEqual(validateReplayPlan(withoutRandomness).randomStreams, []);

    const first = deriveReplayStream({
        rootSeed,
        producerId: 'node-unit',
        canonicalTestId: alphaId,
        streamId: 'property-cases',
        version: 'v1'
    });
    const second = deriveReplayStream({
        rootSeed,
        producerId: 'node-unit',
        canonicalTestId: betaId,
        streamId: 'fuzz-cases',
        version: 'v1'
    });
    const withStreams = replayPlan({ randomStreams: [second, first] });
    assert.equal(withStreams.randomStreams.length, 2);

    const missing = structuredClone(withStreams);
    delete missing.randomStreams[0].consumerTestId;
    assert.throws(() => validateReplayPlan(missing), /randomStreams\[0\] fields are not exact/u);

    const duplicate = structuredClone(withStreams);
    duplicate.randomStreams[1] = {
        ...deriveReplayStream({
            rootSeed,
            producerId: 'node-unit',
            canonicalTestId: alphaId,
            streamId: duplicate.randomStreams[0].streamId,
            version: 'v1'
        })
    };
    assert.throws(
        () => validateReplayPlan(duplicate),
        (error) => error.reasonCode === 'replay.stream-duplicate'
    );

    const tampered = structuredClone(withStreams);
    tampered.randomStreams[0].seed = `seed256:${'ff'.repeat(32)}`;
    assert.throws(
        () => validateReplayPlan(tampered),
        (error) => error.reasonCode === 'replay.stream-tamper'
    );

    const omitted = structuredClone(withoutRandomness);
    delete omitted.randomStreams;
    assert.throws(
        () => validateReplayPlan(omitted),
        (error) => error.reasonCode === 'replay.schema-invalid'
    );
});

test('plan and receipt schemas reject unsupported versions, unknown fields and content tamper', () =>
{
    const plan = replayPlan();
    const unsupported = structuredClone(plan);
    unsupported.schema = 'fsusblog.test-execution-replay-plan.v2';
    assert.throws(
        () => validateReplayPlan(unsupported),
        (error) => error.reasonCode === 'replay.schema-unsupported'
    );
    const unknown = structuredClone(plan);
    unknown.unsealedOverride = true;
    assert.throws(
        () => validateReplayPlan(unknown),
        (error) => error.reasonCode === 'replay.schema-invalid'
    );
    const commandTamper = structuredClone(plan);
    commandTamper.command.args.push('--changed');
    assert.throws(
        () => validateReplayPlan(commandTamper),
        (error) => error.reasonCode === 'replay.command-tamper'
    );

    const receipt = replayReceipt(plan);
    const receiptUnknown = structuredClone(receipt);
    receiptUnknown.hostLoad = 42;
    assert.throws(
        () => validateReplayReceipt(receiptUnknown),
        (error) => error.reasonCode === 'replay.schema-invalid'
    );
    const receiptTamper = structuredClone(receipt);
    receiptTamper.processOutcome.status = 'failed';
    receiptTamper.processOutcome.exitCode = 1;
    assert.throws(
        () => validateReplayReceipt(receiptTamper),
        (error) => error.reasonCode === 'replay.receipt-tamper'
    );
});

test('receipt records actual IDs, order, shards, workers, streams, admissions and process outcome', () =>
{
    const stream = deriveReplayStream({
        rootSeed,
        producerId: 'node-unit',
        canonicalTestId: alphaId,
        streamId: 'property-cases',
        version: 'v1'
    });
    const plan = replayPlan({ randomStreams: [stream] });
    const receipt = replayReceipt(plan);
    assert.equal(validateReplayReceipt(receipt), receipt);
    assert.equal(receipt.testIds.length, 2);
    assert.equal(receipt.shards.flatMap((shard) => shard.testIds).length, 2);
    assert.equal(receipt.workers.flatMap((worker) => worker.testIds).length, 2);
    assert.deepEqual(receipt.admissionSequence.map((entry) => entry.ordinal), [0, 1]);
    assert.deepEqual(validateReplayBundle({ plan, receipt }), {
        valid: true,
        planDigest: plan.planDigest,
        receiptDigest: receipt.receiptDigest
    });
});

test('bundle validation fails closed on cross-source, cross-run, cross-producer and unknown stream binding', () =>
{
    const plan = replayPlan();
    const cases = [
        [replayReceipt(plan, {
            source: { ...plan.source, worktreeFingerprint: oneDigest }
        }), 'replay.source-binding-mismatch'],
        [replayReceipt(plan, {
            run: { ...plan.run, id: 'run-2' }
        }), 'replay.run-binding-mismatch'],
        [replayReceipt(plan, {
            producer: { ...plan.producer, id: 'other-producer' }
        }), 'replay.producer-binding-mismatch']
    ];
    for (const [receipt, reasonCode] of cases)
    {
        assert.throws(
            () => validateReplayBundle({ plan, receipt }),
            (error) => error.reasonCode === reasonCode
        );
    }

    const stream = deriveReplayStream({
        rootSeed,
        producerId: plan.producer.id,
        canonicalTestId: alphaId,
        streamId: 'unexpected-stream',
        version: 'v1'
    });
    const receipt = replayReceipt(plan, { randomStreams: [stream] });
    assert.throws(
        () => validateReplayBundle({ plan, receipt }),
        (error) => error.reasonCode === 'replay.stream-unknown'
    );
});

test('entropy governance identifies Date.now, UUID, PID and OS entropy used for seed/order', () =>
{
    const unsafe = [
        'const seed = Date.now()',
        'const rootSeed = crypto.randomUUID()',
        'const orderKey = process.pid',
        'const shardKey = randomBytes(32)',
        'const seed = crypto.getRandomValues(new Uint8Array(32))',
        "const seed = readFileSync('/dev/urandom')",
        'const testOrder = Math.random()'
    ];
    for (const [index, source] of unsafe.entries())
    {
        const findings = scanEntropyGovernanceSource(`fixture-${index}.mjs`, source);
        assert.equal(findings.length, 1, source);
        assert.throws(
            () => validateTestEntropyGovernance(new Map([[`fixture-${index}.mjs`, source]])),
            (error) => error.reasonCode === 'replay.entropy-unrecorded'
              && error.details.findings.length === 1
        );
    }
    assert.deepEqual(
        scanEntropyGovernanceSource('safe.mjs', 'const durationMs = Date.now() - startedAt'),
        []
    );
});

test('repository correctness entropy discovery currently has zero ungoverned seed/order sources', () =>
{
    const result = verifyRepositoryTestEntropyGovernance();
    assert.equal(result.findingCount, 0);
    assert.ok(result.sourceCount > 0);
});

test('machine-readable plan and receipt schemas are closed and aligned with runtime identities', () =>
{
    const planSchema = JSON.parse(fs.readFileSync(
        new URL('../../config/schemas/test-execution-replay-plan.schema.json', import.meta.url),
        'utf8'
    ));
    const receiptSchema = JSON.parse(fs.readFileSync(
        new URL('../../config/schemas/test-execution-replay-receipt.schema.json', import.meta.url),
        'utf8'
    ));
    assert.equal(planSchema.additionalProperties, false);
    assert.equal(receiptSchema.additionalProperties, false);
    assert.equal(planSchema.properties.schema.const, REPLAY_PLAN_SCHEMA);
    assert.equal(receiptSchema.properties.schema.const, REPLAY_RECEIPT_SCHEMA);
    assert.equal(planSchema.properties.randomStreams.type, 'array');
    assert.equal(receiptSchema.properties.admissionSequence.type, 'array');
    assert.ok(planSchema.required.includes('planDigest'));
    assert.ok(receiptSchema.required.includes('receiptDigest'));
});
