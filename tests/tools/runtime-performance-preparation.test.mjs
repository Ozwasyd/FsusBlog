import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {createPerformancePreparationPlan, performancePreparationOperations, readPerformancePreparationInputs,
    runRuntimePerformancePreparation, validatePerformancePreparationReceipt, assertNotLegacyPerformancePreparation,
    createPerformancePreparationReceiptPublisher, readPerformancePreparationReceipt} =
    await import(new URL('../../tools/test/runtime-performance-preparation.mjs', import.meta.url));
const {createQuiescenceMeasurementConsumers} = await import(new URL('../../tools/test/quiescence-measurement-consumer.mjs', import.meta.url));
const {requireMeasurementQuiescenceConsumer} = await import(new URL('../../tools/test/quiescence-measurement-inventory.mjs', import.meta.url));
const {runRuntimeQuiescenceBarrier} = await import(new URL('../../tools/test-matrix/runtime-quiescence-barrier.mjs', import.meta.url));
const {createResidentLeaseInventory, createResidentLeaseHandoff, consumeResidentLeaseHandoff} =
    await import(new URL('../../tools/test-matrix/resident-resource-leases.mjs', import.meta.url));
const {publishRunBoundMarker} = await import(new URL('../../tools/test-matrix/run-bound-marker.mjs', import.meta.url));
const {executeWeightedStepDag, performanceSteps} = await import(new URL('../../tools/test/bundles/bundle-steps.mjs', import.meta.url));
const {createProductionFreshOutputRoot, sealTerminalProductionFreshOutputs} = await import(new URL('../../tools/test-matrix/production-fresh-run-bound-outputs.mjs', import.meta.url));
import {sealedModelOutput} from './quiescence-measurement-model.mjs';
import {authorities, barrierOptions, identity, inventory, modelOwner} from './runtime-quiescence-model.mjs';

const producerId = 'runtime-performance-preparation';
const sourceState = {commit: 'unit-source-commit', worktreeFingerprint: 'unit-source-worktree'};
const terminal = () => ({status: 'terminal'});
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fixture(t, mutate = {})
{
    const {markerRunId = identity.runId, markerSourceState = sourceState, ...overrides} = mutate;
    const model = modelOwner();
    const session = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner, {timeoutMs: 10_000}));
    t.after(() => session.release());
    const marker = {markerId: 'unit-fixture-ready', producerBundleId: 'unit-fixture-owner', producerStepId: 'prepare', artifacts: null};
    const explicit = sealedModelOutput(t, session.receipt, (root, layout) =>
    {
        const artifact = path.relative(root, path.join(layout.outputRoot, 'reports/unit-model-quiescence.json'));
        marker.artifacts = [artifact];
        const document = publishRunBoundMarker({file: path.join(layout.outputRoot, 'reports/fixture-input.json'),
            root, markerId: marker.markerId, runId: markerRunId, sourceState: markerSourceState,
            producerBundleId: marker.producerBundleId, producerStepId: marker.producerStepId, artifacts: [artifact]});
        return [{relativePath: 'reports/fixture-input.json', document}];
    });
    const runtimeFile = path.join(explicit.root, '.tmp/env', identity.namespace + '.env');
    fs.mkdirSync(path.dirname(runtimeFile), {recursive: true});
    const env = {FSUSBLOG_TEST_NAMESPACE: identity.namespace, FSUSBLOG_TEST_RUN_ID: identity.runId,
        FSUSBLOG_POSTGRES_PORT: '21001', FSUSBLOG_REDIS_PORT: '23001', FSUSBLOG_DEBUG_BACKEND_PORT: '25001',
        FSUSBLOG_DEBUG_FRONTEND_PORT: '27001', FSUSBLOG_RELEASE_PREVIEW_PORT: '29001',
        FSUSBLOG_DEBUG_BACKEND_URL: 'http://127.0.0.1:25001', FSUSBLOG_DEBUG_FRONTEND_URL: 'http://127.0.0.1:27001',
        FSUSBLOG_RELEASE_PREVIEW_URL: 'http://127.0.0.1:29001'};
    const writeEnvironment = () => fs.writeFileSync(runtimeFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'));
    writeEnvironment();
    // Actual task process observation under the existing reader. Role assignments
    // and lease facts are unit models, not five real production services.
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const startTimeTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const services = ['debug-backend', 'debug-frontend', 'release-preview', 'postgres', 'redis'].map((id, index) => ({
        id, kind: 'process', identity: {pid: process.pid, startTimeTicks}, generation: 'unit-resident-' + id,
        port: 20001 + index, health: {status: 'ready', checkedAt: new Date().toISOString()}, observedRssBytes: 4096}));
    const residentInventory = createResidentLeaseInventory({runId: identity.runId, namespace: identity.namespace,
        ownerBundleId: 'runtime-browser', sourceState, resourceGrant: {cpuUnits: 4, memoryGiB: 4}, services});
    const readiness = {status: 'ready', checkedAt: new Date().toISOString(),
        services: services.map(({id, generation}) => ({id, generation, status: 'live'}))};
    const residentHandoff = consumeResidentLeaseHandoff(createResidentLeaseHandoff({inventory: residentInventory,
        toOwnerBundleId: producerId, readiness}), {inventory: residentInventory, consumerBundleId: producerId});
    const resident = {inventoryFile: path.join(explicit.root, 'resident-inventory.json'),
        handoffFile: path.join(explicit.root, 'resident-handoff.json')};
    fs.writeFileSync(resident.inventoryFile, JSON.stringify(residentInventory));
    fs.writeFileSync(resident.handoffFile, JSON.stringify(residentHandoff));
    const plan = createPerformancePreparationPlan({identity, attemptId: explicit.locator.attemptId, sourceState,
        timeoutMs: 60_000, fixtureInputs: [{inputId: 'unit-fixture', marker,
            locator: explicit.relatedLocators['reports/fixture-input.json'], forOperations: performancePreparationOperations.map(({id}) => id)}]});
    const readValidation = () => ({identity, inventory, schema: authorities.schema, plan: session.plan, currentLease: model.grant()});
    const events = [];
    const consumers = createQuiescenceMeasurementConsumers({...explicit,
        consumers: [producerId, 'backend-perf'].map((id) => requireMeasurementQuiescenceConsumer(id)), session, readValidation,
        audit: {append: (event) => events.push(event)}, operationTimeoutMs: 500, checkIntervalMs: 10});
    t.after(() => consumers.close('unit fixture finished'));
    const started = [];
    const operations = Object.fromEntries(performancePreparationOperations.map(({id, owner}) => [id, {owner,
        async start()
        {
            started.push(id);
            return {status: 'prepared', measurementSpawnCount: 0, benchmarkWindowHeld: false};
        }, cancelAndObserveTerminal: terminal}]));
    // Publisher is a unit contract double. It does not write an authoritative
    // product locator or pretend the missing production publication port exists.
    const published = [];
    const options = {root: explicit.root, plan, resident, consumers, operations, readValidation,
        quiescenceLocator: explicit.locator, publisher: {appendAndSeal: ({receipt}) =>
        {
            published.push(receipt);
            return {scope: 'unit-model-only'};
        }}, ...overrides};
    return {options, model, session, plan, explicit, residentInventory, residentHandoff, resident, env, writeEnvironment,
        consumers, started, published, events};
}

test('exact preparation inputs admit with unrelated coverage/build active; missing protected publication fails closed', async (t) =>
{
    const f = await fixture(t);
    let finishTail;
    const unrelatedTail = new Promise((resolve) =>
    {
        finishTail = resolve;
    });
    const inputs = readPerformancePreparationInputs({...f.options,
        quiescence: {locator: f.explicit.locator, validation: f.options.readValidation()}});
    f.options.publisher.appendAndSeal = ({receipt}) =>
    {
        assert.equal(f.model.model.active, true);
        f.published.push(receipt);
        return {scope: 'unit-model-only'};
    };
    await assert.rejects(() => runRuntimePerformancePreparation(f.options), /exact current-run sealed producer locator/u);
    assert.deepEqual(f.started, ['fixture-data', 'scale-xs', 'scale-s', 'fault-setup']);
    const receipt = f.published[0];
    assert.equal(f.model.model.active, false);
    assert.equal(receipt.consumerReceipt.releaseResult.status, 'held-for-declared-consumers');
    assert.deepEqual(f.plan.resources.exclusiveResources, []);
    assert.deepEqual(f.plan.unrelatedTerminalInputs, []);
    validatePerformancePreparationReceipt(receipt, {plan: f.plan, inputs, consumerReceipt: receipt.consumerReceipt});
    assert.equal(f.published.length, 1);
    finishTail();
    await unrelatedTail;

    // Exercise real append-only output/locator IO in a separate task-private
    // root using the captured unit-owner facts. This is not a live preparation.
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-preparation-output-model-'));
    t.after(() =>
    {
        const writable = (directory) =>
        {
            fs.chmodSync(directory, 0o700);
            for (const entry of fs.readdirSync(directory, {withFileTypes: true}))
            {
                if (entry.isDirectory())
                {
                    writable(path.join(directory, entry.name));
                }
            }
        };
        writable(outputRoot);
        fs.rmSync(outputRoot, {recursive: true, force: true});
    });
    const layout = createProductionFreshOutputRoot({root: outputRoot, runId: f.plan.identity.runId,
        attemptId: f.plan.attemptId});
    const publisher = createPerformancePreparationReceiptPublisher({layout});
    const arguments_ = {receipt, plan: f.plan, inputs, consumerReceipt: receipt.consumerReceipt};
    const publication = publisher.appendAndSeal(arguments_);
    assert.throws(() => readPerformancePreparationReceipt({root: outputRoot, locator: publication.locator, ...arguments_}));
    assert.throws(() => publisher.appendAndSeal(arguments_), /EEXIST/u);
    sealTerminalProductionFreshOutputs(layout);
    readPerformancePreparationReceipt({root: outputRoot, locator: publication.locator, ...arguments_});
    assert.throws(() => readPerformancePreparationReceipt({root: outputRoot,
        locator: {...publication.locator, attemptId: 'old-attempt'}, ...arguments_}), /exact current-run/u);
    const tampered = structuredClone(receipt);
    tampered.benchmarkWindowHeld = true;
    assert.throws(() => validatePerformancePreparationReceipt(tampered, arguments_), /binding invalid/u);

    const interruptedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-preparation-interrupted-model-'));
    t.after(() => fs.rmSync(interruptedRoot, {recursive: true, force: true}));
    const interruptedLayout = createProductionFreshOutputRoot({root: interruptedRoot,
        runId: f.plan.identity.runId, attemptId: f.plan.attemptId});
    const partialFile = path.join(interruptedLayout.outputRoot, 'reports/runtime-performance-preparation/sealed.json');
    fs.mkdirSync(path.dirname(partialFile), {recursive: true});
    fs.writeFileSync(partialFile, '{"interrupted":');
    const partialBefore = fs.readFileSync(partialFile);
    const interruptedPublisher = createPerformancePreparationReceiptPublisher({layout: interruptedLayout});
    assert.throws(() => interruptedPublisher.appendAndSeal(arguments_), /EEXIST/u);
    assert.deepEqual(fs.readFileSync(partialFile), partialBefore);
    assert.equal(fs.existsSync(path.join(interruptedLayout.outputRoot, 'artifacts/producer-receipts/runtime-performance-preparation.json')), false);
});

for (const kind of ['active-claim', 'generation', 'runtime-restart', 'wrong-run-runtime', 'wrong-namespace-resident',
    'wrong-source-resident', 'wrong-recipient', 'wrong-run-fixture', 'stale-attempt-fixture', 'missing-fixture', 'missing-port', 'missing-publisher'])
{
    test(`${kind} refuses before preparation or benchmark spawn`, async (t) =>
    {
        const f = await fixture(t);
        if (kind === 'active-claim')
        {
            f.model.model.acceptedClaimCount = 1;
        }
        if (kind === 'generation')
        {
            f.model.model.generation += 1;
        }
        if (kind === 'runtime-restart')
        {
            f.options.readValidation = () => ({identity: {...identity, runtimeIdentityDigest: `sha256:${'c'.repeat(64)}`}});
        }
        if (kind === 'wrong-run-runtime')
        {
            f.env.FSUSBLOG_TEST_RUN_ID = 'other-run';
            f.writeEnvironment();
        }
        if (kind === 'wrong-namespace-resident' || kind === 'wrong-source-resident')
        {
            const changed = structuredClone(f.residentInventory);
            if (kind === 'wrong-namespace-resident')
            {
                changed.namespace = 'other-namespace';
            }
            else
            {
                changed.sourceState.commit = 'other-source';
            }
            fs.writeFileSync(f.resident.inventoryFile, JSON.stringify(changed));
        }
        if (kind === 'wrong-recipient')
        {
            const wrong = createResidentLeaseHandoff({inventory: f.residentInventory,
                toOwnerBundleId: 'performance-evidence', readiness: f.residentHandoff.readiness});
            fs.writeFileSync(f.resident.handoffFile, JSON.stringify(consumeResidentLeaseHandoff(wrong,
                {inventory: f.residentInventory, consumerBundleId: 'performance-evidence'})));
        }
        if (['wrong-run-fixture', 'stale-attempt-fixture', 'missing-fixture'].includes(kind))
        {
            const changed = structuredClone(f.plan);
            if (kind === 'wrong-run-fixture')
            {
                changed.fixtureInputs[0].locator.runId = 'other-run';
            }
            if (kind === 'stale-attempt-fixture')
            {
                changed.fixtureInputs[0].locator.attemptId = 'old-attempt';
            }
            if (kind === 'missing-fixture')
            {
                changed.fixtureInputs = [];
            }
            f.options.plan = changed;
        }
        if (kind === 'missing-port')
        {
            delete f.options.operations['fault-setup'];
        }
        if (kind === 'missing-publisher')
        {
            f.options.publisher = null;
        }
        await assert.rejects(() => runRuntimePerformancePreparation(f.options));
        assert.deepEqual(f.started, []);
        assert.deepEqual(f.published, []);
    });
}

for (const kind of ['sealed-wrong-run-marker', 'sealed-stale-source-marker', 'fixture-content-digest'])
{
    test(`${kind} rejects actual explicit protected fixture input before spawn`, async (t) =>
    {
        const f = await fixture(t, kind === 'sealed-wrong-run-marker' ? {markerRunId: 'other-run'}
            : kind === 'sealed-stale-source-marker' ? {markerSourceState: {...sourceState, commit: 'other-source'}} : {});
        if (kind === 'fixture-content-digest')
        {
            const fixtureInputs = structuredClone(f.plan.fixtureInputs);
            fixtureInputs[0].locator.contentDigest = `sha256:${'0'.repeat(64)}`;
            f.options.plan = createPerformancePreparationPlan({...f.plan, fixtureInputs});
        }
        await assert.rejects(() => runRuntimePerformancePreparation(f.options));
        assert.deepEqual(f.started, []);
        assert.deepEqual(f.published, []);
    });
}

test('preparation failure prevents later actions and publication without relaxing product failure', async (t) =>
{
    const f = await fixture(t);
    f.options.operations['scale-xs'].start = () =>
    {
        f.started.push('scale-xs');
        throw new Error('original seed failure');
    };
    const result = await runRuntimePerformancePreparation(f.options);
    assert.equal(result.status, 'failed');
    assert.match(result.receipt.error, /original seed failure/u);
    assert.deepEqual(f.started, ['fixture-data', 'scale-xs']);
    assert.deepEqual(f.published, []);
});

test('expired original preparation budget and already-cancelled request both refuse before spawn', async (t) =>
{
    const f = await fixture(t);
    const plan = createPerformancePreparationPlan({...f.plan, timeoutMs: 1});
    await assert.rejects(() => runRuntimePerformancePreparation({...f.options, plan}), /deadline exhausted/u);
    assert.deepEqual(f.started, []);
    assert.equal(f.model.model.active, false);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(() => runRuntimePerformancePreparation({...f.options, signal: cancelled.signal}));
    assert.deepEqual(f.started, []);
});

test('cancellation observes real unit producer completion before releasing its holder', async (t) =>
{
    const f = await fixture(t);
    const signal = new AbortController();
    let resolveAction;
    let activeExecution;
    let cancelEntered;
    const cancellationEntered = new Promise((resolve) =>
    {
        cancelEntered = resolve;
    });
    f.options.operations['fixture-data'].start = () =>
    {
        f.started.push('fixture-data');
        activeExecution = new Promise((resolve) =>
        {
            resolveAction = resolve;
        });
        return activeExecution;
    };
    f.options.operations['fixture-data'].cancelAndObserveTerminal = async () =>
    {
        assert.equal(f.model.model.active, true);
        assert.equal(f.consumers.holderCount(), 1);
        cancelEntered();
        await activeExecution;
        return terminal();
    };
    const pending = runRuntimePerformancePreparation({...f.options, signal: signal.signal});
    while (!resolveAction)
    {
        await delay(1);
    }
    signal.abort();
    await cancellationEntered;
    assert.equal(f.model.model.active, true);
    resolveAction({status: 'prepared', measurementSpawnCount: 0, benchmarkWindowHeld: false});
    const result = await pending;
    assert.equal(result.status, 'failed');
    assert.equal(f.consumers.holderCount(), 0);
    assert.deepEqual(f.started, ['fixture-data']);
    assert.deepEqual(f.published, []);
});

for (const kind of ['active-claim', 'generation', 'runtime-env', 'resident-handoff', 'measurement', 'benchmark-window'])
{
    test(`${kind} drift/postcondition during preparation prevents further actions and seal`, async (t) =>
    {
        const f = await fixture(t);
        f.options.operations['fixture-data'].start = () =>
        {
            f.started.push('fixture-data');
            if (kind === 'active-claim')
            {
                f.model.model.acceptedClaimCount = 1;
            }
            if (kind === 'generation')
            {
                f.model.model.generation += 1;
            }
            if (kind === 'runtime-env')
            {
                f.env.FSUSBLOG_DEBUG_BACKEND_PORT = '25002';
                f.env.FSUSBLOG_DEBUG_BACKEND_URL = 'http://127.0.0.1:25002';
                f.writeEnvironment();
            }
            if (kind === 'resident-handoff')
            {
                fs.writeFileSync(f.resident.handoffFile, JSON.stringify({...f.residentHandoff, generation: 'changed'}));
            }
            return {status: 'prepared', measurementSpawnCount: kind === 'measurement' ? 1 : 0,
                benchmarkWindowHeld: kind === 'benchmark-window'};
        };
        const result = await runRuntimePerformancePreparation(f.options);
        assert.equal(result.status, 'failed');
        assert.deepEqual(f.started, ['fixture-data']);
        assert.deepEqual(f.published, []);
    });
}

test('old mega-bundle preparation refuses before command dispatch and original scheduler declarations remain unchanged', async () =>
{
    const selected = performanceSteps().filter((entry) => ['data-scale-xs', 'data-scale-s', 'data-scale-summary', 'fault-injection'].includes(entry.id))
        .map((entry) => ({...entry, dependsOn: []}));
    let spawned = 0;
    await assert.rejects(() => executeWeightedStepDag(selected, {cpuUnits: 4, memoryGiB: 4, maxParallel: 4}, (entry) =>
    {
        assertNotLegacyPerformancePreparation(entry.id);
        spawned += 1;
    }));
    assert.equal(spawned, 0);
    const runner = fs.readFileSync(new URL('../../tools/test/bundles/run-bundle.mjs', import.meta.url), 'utf8');
    assert.match(runner, /async function executePerformanceStep\(step\)\s*\{\s*assertNotLegacyPerformancePreparation\(step.id\)/u);
});

test('actual preparation CLI rejects ambient marker/budget declarations before any producer spawn', () =>
{
    for (const [command, args] of [[process.execPath, ['tools/test/runtime-performance-preparation.mjs']],
        ['bash', ['tools/test/bundles/runtime-performance-preparation.sh']]])
    {
        const result = spawnSync(command, args, {
            cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8',
            env: {...process.env, FSUSBLOG_NODE: process.execPath, FSUSBLOG_RUNTIME_STATE_READY: '1',
                FSUSBLOG_PREPARATION_READY: '1', FSUSBLOG_STEP_CPU_BUDGET: '4'}});
        assert.equal(result.status, 1);
        const output = JSON.parse(result.stderr.trim());
        assert.equal(output.producerSpawnCount, 0);
        assert.equal(output.status, 'blocked');
        assert.match(output.error, /catalog registration.*holder transport.*prepare-only.*publisher unavailable/u);
    }
});
