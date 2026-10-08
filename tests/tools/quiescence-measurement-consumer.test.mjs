import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const {createQuiescenceMeasurementConsumers} = await import(new URL('../../tools/test/quiescence-measurement-consumer.mjs', import.meta.url));
const {loadMeasurementQuiescenceConsumers, assertProductionMeasurementQuiescenceAvailable} = await import(new URL('../../tools/test/quiescence-measurement-inventory.mjs', import.meta.url));
const {performanceSteps} = await import(new URL('../../tools/test/bundles/bundle-steps.mjs', import.meta.url));
const {runRuntimeQuiescenceBarrier} = await import(new URL('../../tools/test-matrix/runtime-quiescence-barrier.mjs', import.meta.url));
const {wrapTaskScopedMeasurementCommand} = await import(new URL('../../tools/test/bundles/measurement-step-command.mjs', import.meta.url));
import {sealedModelOutput} from './quiescence-measurement-model.mjs';
import {authorities, barrierOptions, identity, inventory, modelOwner, reseal} from './runtime-quiescence-model.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const declaration = (consumerId) => loadMeasurementQuiescenceConsumers().consumers.find((entry) => entry.consumerId === consumerId);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, ids = ['backend-perf'], extra = {})
{
    const model = modelOwner();
    const session = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner, {timeoutMs: 10_000, signal: extra.barrierSignal}));
    assert.equal(session.status, 'quiescent');
    t.after(() => session.release());
    const explicit = sealedModelOutput(t, session.receipt);
    if (extra.badLocatorDigest)
    {
        explicit.locator = {...explicit.locator, contentDigest: `sha256:${'f'.repeat(64)}`};
    }
    const events = [];
    const consumer = createQuiescenceMeasurementConsumers({...explicit, consumers: ids.map(declaration), session,
        readValidation: () => ({identity, inventory, schema: authorities.schema, plan: session.plan, currentLease: model.grant()}),
        audit: {append: (event) =>
        {
            events.push(structuredClone(event));
        }}, operationTimeoutMs: 500,
        checkIntervalMs: 10, ...extra});
    const run = consumer.run;
    consumer.run = (options) => run({timeoutMs: 5_000, ...options}); // Explicit unit producer plan; no production budget default.
    return {model, session, consumer, events, explicit};
}

function producer(start = () => ({exitCode: 0}))
{
    let execution;
    return {start: (context) =>
    {
        execution = Promise.resolve().then(() => start(context));
        return execution;
    }, cancelAndObserveTerminal: async () =>
    {
        await execution.catch(() =>
        {});
        return {status: 'terminal'};
    }};
}

test('consumer inventory covers every actual production measurement and declared reliability/resource consumer; unknown and marker authority refused', () =>
{
    const inventory = loadMeasurementQuiescenceConsumers();
    for (const step of performanceSteps().filter((entry) => entry.evidencePhase === 'measurement'))
    {
        assert.equal(declaration(step.id).stateContract, 'requires-quiescence');
    }
    for (const id of ['release-soak-min', 'release-load-peak', 'release-load-burst', 'release-memory-leak-budget', 'release-open-handle-budget'])
    {
        assert.equal(declaration(id).stateContract, 'requires-quiescence');
        assert.throws(() => assertProductionMeasurementQuiescenceAvailable(id), /authority unavailable/u);
    }
    assert.throws(() => assertProductionMeasurementQuiescenceAvailable('new-unknown-consumer'), /unknown/u);
    assert.throws(() => wrapTaskScopedMeasurementCommand({consumerId: 'backend-perf'}), /authority unavailable/u);
    const runner = fs.readFileSync(path.join(root, 'tools/test/bundles/run-bundle.mjs'), 'utf8');
    assert.doesNotMatch(runner, /publishCurrentRunMarker\('runtime-state-ready'/u);
    assert.doesNotMatch(runner, /'runtime-state-ready':/u);
    assert.equal(inventory.consumers.find((entry) => entry.consumerId === 'runtime-cache-distributed-invalidation').stateContract,
        'non-quiescent-worker-measurement');
});

test('valid consumer holds the same lease through start/end, audits holder and final release', async (t) =>
{
    const {consumer, model, events} = await fixture(t);
    const result = await consumer.run({consumerId: 'backend-perf', producer: producer(async () =>
    {
        assert.equal(model.model.active, true);
        assert.equal(consumer.holderCount(), 1);
        await delay(20);
        return {exitCode: 0};
    })});
    assert.equal(result.status, 'completed');
    assert.equal(result.qualificationEligible, true); // unit-owner model only
    assert.equal(result.receipt.startCheck.leaseGeneration, result.receipt.endCheck.leaseGeneration);
    assert.equal(result.release.status, 'released');
    assert.equal(model.model.active, false);
    assert.deepEqual(events.map((event) => event.state), ['holder-acquired', 'consumer-terminal', 'lease-released', 'consumer-release-result']);
});

test('parallel explicit holders and not-yet-started consumers retain lease until the last declared terminal', async (t) =>
{
    const {consumer, model} = await fixture(t, ['backend-perf', 'aeds-frame-cost']);
    let finish;
    const first = consumer.run({consumerId: 'backend-perf', producer: producer(() => new Promise((resolve) =>
    {
        finish = resolve;
    }))});
    while (!finish)
    {
        await delay(1);
    }
    const second = await consumer.run({consumerId: 'aeds-frame-cost', producer: producer()});
    assert.equal(second.release, null);
    assert.equal(model.model.active, true);
    finish({exitCode: 0});
    const ended = await first;
    assert.equal(ended.release.status, 'released');
    assert.equal(model.calls.filter((entry) => entry === 'release').length, 1);
    assert.equal((await consumer.close()).qualificationEligible, true);
});

for (const kind of ['released-lease', 'generation', 'runtime', 'namespace', 'fence', 'receipt-digest', 'state'])
{
    test(`${kind} drift before start refuses with producer spawn zero`, async (t) =>
    {
        const {consumer, model} = await fixture(t, ['backend-perf'], {badLocatorDigest: kind === 'receipt-digest'});
        if (kind === 'released-lease')
        {
            model.model.active = false;
        }
        if (kind === 'generation')
        {
            model.model.generation += 1;
        }
        if (kind === 'runtime' || kind === 'namespace')
        {
            model.owner.readIdentity = () => ({...identity, [kind === 'runtime' ? 'runtimeIdentityDigest' : 'namespace']: 'changed'});
        }
        if (kind === 'fence')
        {
            model.model.acceptedClaimCount = 1;
        }
        if (kind === 'state')
        {
            const original = model.owner.readObservations;
            model.owner.readObservations = async (request) =>
            {
                const batch = await original(request);
                batch.domains[0].pendingCount = 1;
                return batch;
            };
        }
        let spawned = 0;
        const result = await consumer.run({consumerId: 'backend-perf', timeoutMs: 5_000, producer: producer(() =>
        {
            spawned += 1;
        })});
        assert.equal(spawned, 0);
        assert.equal(result.qualificationEligible, false);
        assert.equal(consumer.holderCount(), 0);
    });
}

for (const kind of ['generation', 'fence', 'runtime'])
{
    test(`${kind} drift during measurement cancels before further sampling and observes terminal`, async (t) =>
    {
        const {consumer, model} = await fixture(t);
        let cancelCount = 0;
        let terminal;
        const terminalObserved = new Promise((resolve) =>
        {
            terminal = resolve;
        });
        const result = await consumer.run({consumerId: 'backend-perf', producer: {
            start: async ({signal}) =>
            {
                if (kind === 'generation')
                {
                    model.model.generation += 1;
                }
                if (kind === 'fence')
                {
                    model.model.acceptedClaimCount = 1;
                }
                if (kind === 'runtime')
                {
                    model.owner.readIdentity = () => ({...identity, runtimeIdentityDigest: `sha256:${'f'.repeat(64)}`});
                }
                await new Promise((resolve) => signal.addEventListener('abort', resolve, {once: true}));
                assert.equal(model.model.active, true);
                await delay(5);
                terminal();
                return {exitCode: 1};
            },
            cancelAndObserveTerminal: async () =>
            {
                cancelCount += 1;
                await terminalObserved;
                return {status: 'terminal'};
            }
        }});
        assert.equal(result.status, 'failed');
        assert.equal(result.classification, 'infra.quiescence-precondition');
        assert.equal(result.receipt.producerTerminal, true);
        assert.ok(cancelCount <= 1);
        assert.equal(consumer.holderCount(), 0);
        assert.equal(model.model.active, false);
    });
}

for (const kind of ['success', 'failure', 'timeout', 'cancel'])
{
    test(`${kind} terminal path releases and audits without changing producer parameters`, async (t) =>
    {
        const {consumer, model} = await fixture(t);
        const cancellation = new AbortController();
        const result = await consumer.run({consumerId: 'backend-perf', signal: cancellation.signal, timeoutMs: 30,
            producer: producer(async ({signal}) =>
            {
                if (kind === 'failure')
                {
                    throw new Error('product assertion failed');
                }
                if (kind === 'cancel')
                {
                    cancellation.abort();
                }
                if (kind === 'timeout' || kind === 'cancel')
                {
                    if (!signal.aborted)
                    {
                        await new Promise((resolve) => signal.addEventListener('abort', resolve, {once: true}));
                    }
                }
                return {exitCode: 0};
            })});
        assert.equal(result.status, kind === 'success' ? 'completed' : 'failed');
        assert.equal(result.release.status, 'released');
        assert.equal(model.model.active, false);
        assert.equal(result.receipt.holderStatus, 'released');
        if (kind === 'failure')
        {
            assert.equal(result.classification, null);
            assert.match(result.receipt.error, /product assertion failed/u);
        }
    });
}

test('failed release or audit cannot qualify; unobserved producer retains holder and requires actual owner recovery', async (t) =>
{
    const {consumer, model} = await fixture(t);
    model.owner.release = () =>
    {
        throw new Error('actual release failed');
    };
    const result = await consumer.run({consumerId: 'backend-perf', producer: producer()});
    assert.equal(result.qualificationEligible, false);
    assert.equal(result.release.status, 'failed');
    const other = await fixture(t, ['aeds-frame-cost']);
    const retained = await other.consumer.run({consumerId: 'aeds-frame-cost', timeoutMs: 20,
        producer: {start: () => new Promise(() =>
        {}), cancelAndObserveTerminal: () => ({status: 'unknown'})}});
    assert.equal(retained.receipt.holderStatus, 'cleanup-required');
    assert.equal(other.model.model.active, true);
    assert.equal((await other.consumer.close()).qualificationEligible, false);
});

test('worker-specific consumer refuses a quiescence receipt and delegates only its distinct state authority', async (t) =>
{
    const {consumer} = await fixture(t, ['runtime-cache-distributed-invalidation']);
    await assert.rejects(consumer.run({consumerId: 'runtime-cache-distributed-invalidation', producer: producer()}), /cannot consume/u);
    const active = createQuiescenceMeasurementConsumers({consumers: [declaration('runtime-cache-distributed-invalidation')], audit: {append()
    {}}});
    let delegated = false;
    const outcome = await active.run({consumerId: 'runtime-cache-distributed-invalidation', producer: producer(),
        workerStateAuthority: {run: () =>
        {
            delegated = true;
            return {status: 'delegated'};
        }}});
    assert.equal(outcome.status, 'delegated');
    assert.equal(delegated, true);
});

test('actual performance CLI refuses missing production authority before child spawn even with marker/environment claims', () =>
{
    for (const windowId of ['release-resource-budget-memory-leak', 'load-profile-unregistered', 'run/performance-evidence/unknown'])
    {
        const command = [path.join(root, 'tools/test/performance-admission.mjs'), '--window-id', windowId,
            '--evidence', '/tmp/quiescence-consumer-evidence/missing-authority.json', '--', process.execPath, '-e', 'process.stdout.write("PRODUCER_STARTED")'];
        const result = spawnSync(process.execPath, command, {encoding: 'utf8', env: {...process.env,
            FSUSBLOG_MEASUREMENT_ENVELOPE_OWNER: 'marker-only', FSUSBLOG_TEST_RUN_ID: 'caller-only'}});
        assert.equal(result.status, 1);
        assert.match(result.stderr, /authority unavailable|unknown/u);
        assert.doesNotMatch(result.stdout, /PRODUCER_STARTED/u);
    }
});

test('barrier pending/in-flight refusal cannot become consumer admission or start another producer', async () =>
{
    const model = modelOwner();
    const original = model.owner.readObservations;
    model.owner.readObservations = async (request) =>
    {
        const batch = await original(request);
        batch.domains[0] = reseal({...batch.domains[0], pendingCount: 1, inFlightCount: 1});
        return batch;
    };
    const blocked = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner, {maximumObservationRounds: 2, timeoutMs: 5_000}));
    assert.notEqual(blocked.status, 'quiescent');
    const consumer = createQuiescenceMeasurementConsumers({consumers: [declaration('backend-perf')], session: blocked, audit: {append()
    {}}});
    let spawned = 0;
    const result = await consumer.run({consumerId: 'backend-perf', timeoutMs: 5_000, producer: producer(() =>
    {
        spawned += 1;
    })});
    assert.equal(spawned, 0);
    assert.equal(result.qualificationEligible, false);
    assert.equal(model.model.active, false);
});

test('unknown or missing original producer budget refuses before spawn and releases the owned session', async (t) =>
{
    const missing = await fixture(t);
    const refused = await missing.consumer.run({consumerId: 'backend-perf', timeoutMs: undefined, producer: producer(() => assert.fail('spawned'))});
    assert.equal(refused.qualificationEligible, false);
    assert.equal(missing.model.model.active, false);
    const unknown = await fixture(t);
    await assert.rejects(unknown.consumer.run({consumerId: 'unregistered-consumer', producer: producer(() => assert.fail('spawned'))}), /unknown/u);
    assert.equal(unknown.model.model.active, false);
    assert.equal((await unknown.consumer.close()).qualificationEligible, false);
});

test('audit failure refuses before spawn and wrong/unsigned final release proof cannot qualify', async (t) =>
{
    const denied = await fixture(t, ['backend-perf'], {audit: {append: () =>
    {
        throw new Error('audit unavailable');
    }}});
    let spawned = 0;
    const refused = await denied.consumer.run({consumerId: 'backend-perf', producer: producer(() =>
    {
        spawned += 1;
    })});
    assert.equal(spawned, 0);
    assert.equal(refused.qualificationEligible, false);
    const invalid = await fixture(t);
    const original = invalid.session.release;
    invalid.session.release = async (outcome) =>
    {
        await original(outcome);
        return {status: 'released'};
    };
    const result = await invalid.consumer.run({consumerId: 'backend-perf', producer: producer()});
    assert.equal(result.qualificationEligible, false);
    assert.equal(result.release.status, 'failed');
});

test('protected invalidation event immediately aborts a holder and removes subscription on final release', async (t) =>
{
    let emit;
    let unsubscribed = false;
    const {consumer} = await fixture(t, ['backend-perf'], {subscribeInvalidation: (listener) =>
    {
        emit = listener;
        return () =>
        {
            unsubscribed = true;
        };
    }});
    const result = await consumer.run({consumerId: 'backend-perf', producer: producer(async ({signal}) =>
    {
        emit('protected listener restarted');
        assert.equal(signal.aborted, true);
        throw signal.reason;
    })});
    assert.equal(result.status, 'failed');
    assert.equal(result.release.status, 'released');
    assert.equal(unsubscribed, true);
});

test('overall barrier cancellation keeps consumer custody until producer terminal instead of releasing early', async (t) =>
{
    const cancellation = new AbortController();
    const {consumer, model, session} = await fixture(t, ['backend-perf'], {barrierSignal: cancellation.signal});
    const leaseDuringShutdown = [];
    const result = await consumer.run({consumerId: 'backend-perf', producer: producer(async ({signal}) =>
    {
        cancellation.abort();
        assert.equal(signal.aborted, true);
        leaseDuringShutdown.push(model.model.active);
        assert.throws(() => session.claimConsumerCustody(), /already claimed/u);
        await delay(5);
        leaseDuringShutdown.push(model.model.active);
        return {exitCode: 1};
    })});
    assert.equal(result.qualificationEligible, false);
    assert.equal(result.receipt.producerTerminal, true);
    assert.equal(model.model.active, false);
    assert.deepEqual(leaseDuringShutdown, [true, true]);
    assert.equal(model.calls.filter((entry) => entry === 'release').length, 1);
});
