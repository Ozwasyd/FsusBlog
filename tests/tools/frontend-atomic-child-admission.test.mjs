import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import test from 'node:test';
import { URL } from 'node:url';

const { prepareFrontendChildReplay, validateFrontendChildObservations } = await import(new URL('../../tools/test/frontend-atomic/property-replay.mjs', import.meta.url));
const { prepareFrontendBenchmarkAdmission, runFrontendBenchmarkAdmission } = await import(new URL('../../tools/test/frontend-atomic/benchmark-admission.mjs', import.meta.url));
const { canonicalDigest, deriveReplayStream, planExactShards, REPLAY_PLAN_SCHEMA, sealReplayPlan } = await import(new URL('../../tools/test/execution-replay-contract.mjs', import.meta.url));
const { deriveRandomConsumerStream, loadRandomStreamInventory } = await import(new URL('../../tools/test/random-streams.mjs', import.meta.url));
const { defaultTimeoutPolicyDigest, materializeTemporalEnvironment, qualificationTemporalContext, readTemporalReplayAuthority } = await import(new URL('../../tools/test/temporal-context.mjs', import.meta.url));
const { authorityKinds, sha256 } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { loadTestMatrix } = await import(new URL('../../tools/test-matrix/command-groups.mjs', import.meta.url));
const { projectFrontendPropertyModelPerf } = await import(new URL('../../tools/test/frontend-atomic/property-model-perf.mjs', import.meta.url));

const repositoryRoot = process.cwd();
const zeroDigest = `sha256:${'0'.repeat(64)}`;

/** Proposed child catalog and synthetic held refs are ordinary controls, never runtime admission. */
function fixture(producerId = 'frontend-property')
{
    const inventory = structuredClone(loadRandomStreamInventory());
    const receiptOwner = '.tmp/frontend/frontend-property/random-streams.json';
    inventory.consumers.forEach((consumer) =>
    {
        if (consumer.producerId === 'frontend-property-model-perf')
        {
            consumer.producerId = 'frontend-property';
            consumer.receiptOwner = receiptOwner;
        }
    });
    inventory.nonRandomDeclarations.forEach((consumer) =>
    {
        if (consumer.producerId === 'frontend-property-model-perf')
        {
            consumer.producerId = 'frontend-state-machines';
        }
    });
    const context = { producerId, sourceCommit: '1'.repeat(40), worktreeFingerprint: zeroDigest,
        schedulerRunId: 'ordinary-child-controls', attemptId: `${producerId}-attempt-1`, attemptNumber: 1 };
    const temporalContext = qualificationTemporalContext({ sourceCommit: context.sourceCommit,
        sourceFingerprint: context.worktreeFingerprint, producerId, schedulerRunId: context.schedulerRunId,
        businessEpochUtc: '2024-02-29T23:59:59.000Z', locale: 'en-US', uiLocale: 'en-US',
        timeoutPolicyDigest: defaultTimeoutPolicyDigest() });
    const rootSeed = `seed256:${'ab'.repeat(32)}`;
    const consumers = inventory.consumers.filter((consumer) => consumer.producerId === producerId);
    const rows = producerId === 'frontend-property' ? consumers
        : inventory.nonRandomDeclarations.filter((consumer) => consumer.producerId === 'frontend-state-machines');
    const environment = { ...materializeTemporalEnvironment(temporalContext) };
    if (producerId === 'frontend-property')
    {
        Object.assign(environment, { FSUSBLOG_REPLAY_ROOT_SEED: rootSeed, FSUSBLOG_REPLAY_MODE: 'qualification',
            FSUSBLOG_RANDOM_STREAMS_JSON: JSON.stringify(Object.fromEntries(consumers.map((consumer) =>
                [`${consumer.canonicalTestId}\u0000${consumer.streamId}`, deriveRandomConsumerStream({ rootSeed, consumer }).derivedSeed]))) });
    }
    const command = producerId === 'frontend-perf-regression'
        ? ['npm', 'run', 'check:frontend-perf-regression'] : [process.execPath, '--test'];
    const plan = sealReplayPlan({ schema: REPLAY_PLAN_SCHEMA,
        source: { commit: context.sourceCommit, worktreeFingerprint: context.worktreeFingerprint },
        producer: { id: producerId, framework: 'vitest' }, run: { id: context.schedulerRunId, mode: 'qualification' },
        rootSeed, entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }],
        randomStreams: consumers.map((consumer) => deriveReplayStream({ rootSeed, producerId,
            canonicalTestId: consumer.canonicalTestId, streamId: consumer.streamId }))
            .sort((left, right) => left.streamId.localeCompare(right.streamId)),
        ...planExactShards({ testIds: rows.map((row) => row.canonicalTestId), shardCount: 1 }),
        workers: { ids: ['fixture-worker'], assignmentPolicy: 'framework-owned-after-seal' },
        frameworkModes: [{ name: 'retry', value: 'disabled' }],
        schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false },
        schedulerShuffleSeed: 'ordinary-controls',
        command: { executable: command[0], args: command.slice(1), environmentDigest: canonicalDigest(environment) } });
    const replayBytes = JSON.stringify(plan);
    const temporalContextBytes = JSON.stringify(temporalContext);
    const authorityReferences = authorityKinds.map((kind) => ({ kind, artifactPath: `ordinary-${kind}.json`,
        artifactDigest: kind === 'replay-plan' ? sha256(replayBytes)
            : kind === 'temporal-context' ? sha256(temporalContextBytes) : zeroDigest,
        verificationReceiptPath: `ordinary-${kind}.verification.json`, verificationReceiptDigest: zeroDigest }));
    const options = { context, inventory, receiptOwner, replayBytes, temporalContextBytes,
        temporalAuthority: readTemporalReplayAuthority(), environment, command,
        testIds: plan.testEnumerationOrder, authorityReferences,
        verifyAuthority: (reference) => ({ verified: true, authorityDigest: reference.artifactDigest,
            verificationReceiptDigest: reference.verificationReceiptDigest, identity: context }) };
    if (producerId === 'frontend-perf-regression')
    {
        const matrix = loadTestMatrix(repositoryRoot);
        const packageDocument = JSON.parse(fs.readFileSync(new URL('../../src/frontend/package.json', import.meta.url)));
        const entry = projectFrontendPropertyModelPerf(matrix, packageDocument).entries.find((item) => item.id === producerId);
        Object.assign(options, { matrix, packageDocument, resources: entry.resources, repositoryRoot,
            attemptSequence: 1, evidenceFile: '/tmp/ordinary-benchmark-evidence.json',
            productEvidenceFile: '/tmp/ordinary-benchmark-product.json',
            authorityRoot: '/tmp/ordinary-benchmark-authority', authorityManifestRoot: '/tmp/ordinary-benchmark-manifest' });
    }
    return options;
}

function temporalObservation(options)
{
    const context = JSON.parse(options.temporalContextBytes);
    return { businessEpochUtc: context.businessEpochUtc, timezone: context.timezone,
        locale: context.locale, nodeTimezone: context.nodeTimezone, monotonicClockSource: context.monotonicClockSource };
}

function reseal(options, edit = () => {})
{
    const plan = JSON.parse(options.replayBytes);
    delete plan.planDigest;
    edit(plan);
    plan.command.environmentDigest = canonicalDigest(options.environment);
    options.replayBytes = JSON.stringify(sealReplayPlan(plan));
    options.authorityReferences.find((reference) => reference.kind === 'replay-plan').artifactDigest = sha256(options.replayBytes);
}

test('property child binds canonical streams and preserves full budgets without mutating the current catalog', () =>
{
    const before = loadRandomStreamInventory();
    const prepared = prepareFrontendChildReplay(fixture());
    assert.equal(prepared.bindings.length, 2);
    assert.equal(prepared.qualificationEligible, false);
    assert.equal(Object.isFrozen(prepared.bindings[0].consumer.budget), true);
    assert.deepEqual(prepared.bindings.map(({ consumer }) => consumer.budget.iterations), [128, 20]);
    assert.deepEqual(loadRandomStreamInventory(), before);
    const legacy = before.consumers.find((consumer) => consumer.streamId === prepared.bindings[0].consumer.streamId);
    assert.notEqual(prepared.bindings[0].stream.derivedSeed,
        deriveRandomConsumerStream({ rootSeed: prepared.plan.rootSeed, consumer: legacy }).derivedSeed);
});

test('actual legacy catalog cannot masquerade as admitted child bindings', () =>
{
    const options = fixture();
    options.inventory = loadRandomStreamInventory();
    assert.throws(() => prepareFrontendChildReplay(options), /catalog consumer preservation/u);
});

test('child binding rejects reduced budgets, changed versions, missing streams and seed tamper', () =>
{
    for (const mutate of [
        (options) => options.inventory.consumers.find((row) => row.producerId === 'frontend-property').budget.iterations--,
        (options) => options.inventory.consumers.find((row) => row.producerId === 'frontend-property').version = 'unowned-version',
        (options) => options.inventory.consumers.splice(options.inventory.consumers.findIndex((row) => row.producerId === 'frontend-property'), 1),
        (options) => options.environment.FSUSBLOG_RANDOM_STREAMS_JSON = '{}'
    ])
    {
        const options = fixture();
        mutate(options);
        assert.throws(() => prepareFrontendChildReplay(options));
    }
});

test('child context rejects cross-source/run/producer, changed bytes, missing temporal ingress and second attempts', () =>
{
    for (const mutate of [
        (options) => options.context.sourceCommit = '2'.repeat(40),
        (options) => options.context.schedulerRunId = 'another-run',
        (options) => options.context.producerId = 'frontend-state-machines',
        (options) => options.replayBytes += ' ',
        (options) => delete options.environment.FSUSBLOG_TEMPORAL_CONTEXT_JSON,
        (options) => options.context.attemptNumber = 2,
        (options) => options.testIds = options.testIds.slice(1)
    ])
    {
        const options = fixture();
        mutate(options);
        assert.throws(() => prepareFrontendChildReplay(options));
    }
});

test('freshly sealed retry, shard and stream substitutions cannot bypass child binding', () =>
{
    const retry = fixture();
    reseal(retry, (plan) => plan.frameworkModes[0].value = 'enabled');
    assert.throws(() => prepareFrontendChildReplay(retry), /unsharded zero-retry/u);
    const shards = fixture();
    reseal(shards, (plan) => Object.assign(plan, planExactShards({ testIds: plan.testEnumerationOrder, shardCount: 2 })));
    assert.throws(() => prepareFrontendChildReplay(shards), /unsharded zero-retry/u);
    const streams = fixture();
    reseal(streams, (plan) => plan.randomStreams = []);
    assert.throws(() => prepareFrontendChildReplay(streams), /sealed streams/u);
    const environment = fixture();
    environment.environment.FSUSBLOG_RANDOM_STREAMS_JSON = '{}';
    reseal(environment);
    assert.throws(() => prepareFrontendChildReplay(environment), /stream environment/u);
});

test('state-machine child retains explicit non-random disposition and refuses invented random consumers', () =>
{
    const options = fixture('frontend-state-machines');
    const prepared = prepareFrontendChildReplay(options);
    assert.deepEqual(prepared.bindings, []);
    assert.equal(prepared.plan.testEnumerationOrder.length, 5);
    assert.equal(validateFrontendChildObservations(prepared, { temporalObservation: temporalObservation(options),
        randomObservations: [] }).qualificationEligible, false);
    options.inventory.consumers.find((row) => row.producerId === 'frontend-property').producerId = 'frontend-state-machines';
    assert.throws(() => prepareFrontendChildReplay(options), /random\/non-random/u);
});

test('controlled child executes existing deterministic random API and validates complete original observations', () =>
{
    const options = fixture();
    const prepared = prepareFrontendChildReplay(options);
    const moduleUrl = new URL('../../tools/test/random-streams.mjs', import.meta.url).href;
    const script = `import { createDeterministicRandom, deterministicCaseIdentity } from ${JSON.stringify(moduleUrl)};
const input = JSON.parse(process.env.ORDINARY_BINDINGS);
console.log(JSON.stringify(input.bindings.map(({consumer,stream}) => {
 const next = createDeterministicRandom(stream.derivedSeed);
 return { canonicalTestId: consumer.canonicalTestId, streamId: consumer.streamId, derivedSeed: stream.derivedSeed,
 runId: input.context.schedulerRunId, attemptId: input.context.attemptId, replayPlanDigest: input.plan.planDigest,
 caseIdentities: Array.from({length:consumer.budget.iterations}, (_,caseIndex) => deterministicCaseIdentity({derivedSeed:stream.derivedSeed,caseIndex,value:next()})),
 transitionIdentities:[],outcome:'passed' };
})));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...prepared.environment, ORDINARY_BINDINGS: JSON.stringify(prepared) }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const observations = JSON.parse(child.stdout);
    const result = validateFrontendChildObservations(prepared, { temporalObservation: temporalObservation(options), randomObservations: observations });
    assert.equal(result.qualificationEligible, false);
    assert.deepEqual(result.randomObservations.map((row) => row.caseIdentities.length), [128, 20]);
    const reduced = structuredClone(observations);
    reduced[0].caseIdentities.pop();
    assert.throws(() => validateFrontendChildObservations(prepared, { temporalObservation: temporalObservation(options), randomObservations: reduced }), /reduced iteration/u);
    const crossed = structuredClone(observations);
    crossed[0].attemptId = 'another-attempt';
    assert.throws(() => validateFrontendChildObservations(prepared, { temporalObservation: temporalObservation(options), randomObservations: crossed }), /attemptId mismatch/u);
    assert.throws(() => validateFrontendChildObservations(prepared, { temporalObservation: {}, randomObservations: observations }), /businessEpochUtc/u);
    assert.throws(() => validateFrontendChildObservations(prepared, { temporalObservation: temporalObservation(options), randomObservations: [observations[0], observations[0]] }), /exact observed stream roster/u);
});

test('benchmark source preparation preserves its actual command and exclusive measurement class', () =>
{
    const options = fixture('frontend-perf-regression');
    const prepared = prepareFrontendBenchmarkAdmission(options);
    assert.equal(prepared.executionClass, 'benchmark-window');
    assert.equal(prepared.resources.exclusiveCapacity, true);
    assert.equal(prepared.measurement.commandOwner, 'tools/test/performance-admission.mjs');
    assert.equal(prepared.qualificationEligible, false);
    assert.deepEqual([prepared.plan.command.executable, ...prepared.plan.command.args], ['npm', 'run', 'check:frontend-perf-regression']);
});

test('benchmark rejects retry, missing authority roots, resource dilution and another window owner before spawn', async () =>
{
    for (const mutate of [
        (options) => options.attemptSequence = 2,
        (options) => delete options.authorityManifestRoot,
        (options) => delete options.productEvidenceFile,
        (options) => options.resources.exclusiveCapacity = false,
        (options) =>
        {
            options.environment.FSUSBLOG_MEASUREMENT_ENVELOPE_OWNER = 'another-window';
            reseal(options);
        }
    ])
    {
        const options = fixture('frontend-perf-regression');
        mutate(options);
        await assert.rejects(runFrontendBenchmarkAdmission(options));
    }
    await assert.rejects(runFrontendBenchmarkAdmission(fixture('frontend-perf-regression')), /canonical frontend working directory/u);
});
