import assert from 'node:assert/strict';
import test from 'node:test';

const {runRuntimeQuiescenceBarrier} = await import(new URL('../../tools/test-matrix/runtime-quiescence-barrier.mjs', import.meta.url));
const {inspectProductionQuiescenceBarrierBoundary} = await import(new URL('../../tools/test-matrix/runtime-quiescence-production-boundary.mjs', import.meta.url));

import {barrierOptions, identity, inventory, memoryJournal, modelOwner, reseal} from './runtime-quiescence-model.mjs';

test('complete protocol model seals only after independent stable observations and retains lease until explicit release', async () =>
{
    const model = modelOwner();
    const journal = memoryJournal();
    const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner, {journal}));
    assert.equal(result.status, 'quiescent');
    assert.deepEqual(result.trace, ['prepared', 'frozen', 'observed', 'observed', 'sealed']);
    assert.equal(model.model.active, true);
    assert.equal(model.model.frozen, true);
    assert.equal(model.calls.includes('release'), false);
    await result.validate();
    await result.renew();
    const released = await result.release('complete');
    assert.equal(released.status, 'released');
    assert.equal(model.model.active, false);
    assert.equal(model.model.frozen, false);
    assert.deepEqual(await result.release('complete'), released);
    assert.equal(model.calls.filter((call) => call === 'release').length, 1);
    assert.equal(journal.events.at(-1).state, 'released');
    await assert.rejects(() => result.validate(), /no longer active/u);
});

for (const field of ['pendingCount', 'inFlightCount', 'activeMutationTransactionCount', 'unacknowledgedInvalidationCount'])
{
    test(`${field}=1 cannot seal despite script exit or queue empty; observed drain restarts stability`, async () =>
    {
        const model = modelOwner();
        const read = model.owner.readObservations;
        model.owner.readObservations = async (request) =>
        {
            const batch = await read(request);
            if (batch.sequence === 1)
            {
                batch.domains[0] = reseal({...batch.domains[0], [field]: 1, status: 'blocked', commitPostcondition: 'unknown'});
            }
            return batch;
        };
        const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner));
        assert.equal(result.status, 'quiescent');
        assert.equal(result.trace.filter((state) => state === 'observed').length, 3);
        await result.release();
    });
}

for (const mutation of [
    (domain) => ({...domain, terminalFailureCount: 1}),
    (domain) => ({...domain, inFlightCount: null}),
    (domain) => ({...domain, activeClaims: null}),
    (domain) => ({...domain, status: 'unavailable'}),
    (domain) => ({...domain, commitPostcondition: 'unknown'}),
    (domain) => ({...domain, observedGeneration: 'unit-model-generation:4'}),
    (domain) => ({...domain, highWatermark: 'changed-watermark'}),
    (domain) => ({...domain, runtimeIdentityDigest: `sha256:${'e'.repeat(64)}`}),
    (domain) => ({...domain, namespace: 'other-unit-model-namespace'}),
    (domain) => ({...domain, observerIdentity: {...domain.observerIdentity, incarnation: 'restarted-model-worker'}})
])
{
    test(`unknown/failure/drift mutation ${mutation.toString()} never seals and finally releases`, async () =>
    {
        const model = modelOwner();
        const read = model.owner.readObservations;
        model.owner.readObservations = async (request) =>
        {
            const batch = await read(request);
            batch.domains[0] = reseal(mutation(batch.domains[0]));
            return batch;
        };
        const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner));
        assert.notEqual(result.status, 'quiescent');
        assert.equal(result.qualified, false);
        assert.equal(result.trace.includes('sealed'), false);
        assert.equal(result.releaseReceipt.status, 'released');
        assert.equal(model.model.active, false);
    });
}

test('active claim and endless pending work time out without timers proving correctness', async () =>
{
    const model = modelOwner();
    const read = model.owner.readObservations;
    model.owner.readObservations = async (request) =>
    {
        const batch = await read(request);
        batch.domains[0] = reseal({...batch.domains[0], activeClaims: [{namespace: identity.namespace,
            owner: 'unit-model-worker', leaseId: 'unit-model-claim', generation: '3'}], status: 'blocked'});
        return batch;
    };
    const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner, {maximumObservationRounds: 3}));
    assert.equal(result.status, 'failed');
    assert.match(result.receipt.blockers.join(), /deadline/u);
    assert.equal(model.model.active, false);
});

test('partial freeze, accepted new claim and changed lease generation each fail before seal', async () =>
{
    for (const kind of ['partial-freeze', 'accepted-claim', 'stale-generation'])
    {
        const model = modelOwner();
        const freeze = model.owner.freeze;
        model.owner.freeze = async (request) =>
        {
            const reply = await freeze(request);
            if (kind === 'partial-freeze')
            {
                reply.domainIds.pop();
            }
            if (kind === 'accepted-claim')
            {
                model.model.acceptedClaimCount = 1;
            }
            if (kind === 'stale-generation')
            {
                model.model.generation += 1;
            }
            return reply;
        };
        const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner));
        assert.notEqual(result.status, 'quiescent');
        assert.equal(result.trace.includes('sealed'), false);
        assert.equal(model.model.active, false);
    }
});

test('lease conflict does not release a foreign/unvalidated grant', async () =>
{
    const model = modelOwner({acquire: async () => ({status: 'conflict', identity: {...identity, runId: 'other-run'},
        leaseId: 'foreign-lease', generation: 9, remainingLeaseMs: 10_000})});
    const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner));
    assert.notEqual(result.status, 'quiescent');
    assert.equal(model.calls.includes('release'), false);
    assert.equal(model.calls.includes('abortAttempt'), true);
});

test('cancelled or stalled acquire uses owner attempt settlement, never a guessed lease', async () =>
{
    for (const cancel of [false, true])
    {
        const model = modelOwner();
        const controller = new AbortController();
        model.owner.acquire = async () =>
        {
            if (cancel)
            {
                controller.abort();
            }
            return new Promise(() =>
            {});
        };
        const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner, {signal: controller.signal, operationTimeoutMs: 10}));
        assert.equal(result.status, 'failed');
        assert.equal(result.receipt.quiescenceLeaseId, null);
        assert.equal(model.calls.includes('abortAttempt'), true);
        assert.equal(model.calls.includes('postObserve'), true);
        assert.equal(model.calls.includes('release'), false);
    }
});

test('release failure or surviving fence makes cleanup unqualified and preserves negative facts', async () =>
{
    for (const failRelease of [false, true])
    {
        const model = modelOwner();
        if (failRelease)
        {
            model.owner.release = async () =>
            {
                throw new Error('model release denied');
            };
        }
        else
        {
            const release = model.owner.release;
            model.owner.release = async (request) =>
            {
                const reply = await release(request);
                model.model.frozen = true;
                return reply;
            };
        }
        const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner));
        assert.equal(result.status, 'quiescent');
        const released = await result.release();
        assert.equal(released.status, 'failed');
        assert.ok(released.errors.length);
        await assert.rejects(() => result.validate(), /no longer active/u);
    }
});

test('a claim accepted or listener restarted after seal invalidates session and releases immediately', async () =>
{
    for (const restart of [false, true])
    {
        const model = modelOwner();
        const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner));
        if (restart)
        {
            const read = model.owner.readObservations;
            model.owner.readObservations = async (request) =>
            {
                const batch = await read(request);
                batch.identity.runtimeIdentityDigest = `sha256:${'f'.repeat(64)}`;
                return batch;
            };
        }
        else
        {
            model.model.acceptedClaimCount = 1;
        }
        await assert.rejects(() => result.validate());
        assert.equal(model.model.active, false);
        assert.equal(model.calls.includes('release'), true);
    }
});

test('replayed observation sequence, missing observer and journal failure are not readiness', async () =>
{
    for (const kind of ['replayed', 'missing', 'journal'])
    {
        const model = modelOwner();
        const journal = memoryJournal();
        const read = model.owner.readObservations;
        model.owner.readObservations = async (request) =>
        {
            const batch = await read(request);
            if (kind === 'replayed')
            {
                batch.sequence = 1;
            }
            if (kind === 'missing')
            {
                batch.domains.pop();
            }
            return batch;
        };
        if (kind === 'journal')
        {
            journal.append = () =>
            {
                throw new Error('model append unavailable');
            };
        }
        const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner, {journal}));
        assert.notEqual(result.status, 'quiescent');
        assert.equal(model.model.active, false);
    }
});

test('missing production capability stays unavailable and cannot borrow a repository lease', async () =>
{
    const model = modelOwner();
    delete model.owner.freeze;
    const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner));
    assert.equal(result.status, 'blocked');
    assert.equal(model.calls.includes('acquire'), false);
    const boundary = inspectProductionQuiescenceBarrierBoundary({root: new URL('../..', import.meta.url).pathname,
        runId: 'source-capability-check'});
    assert.equal(boundary.status, 'unavailable');
    assert.equal(boundary.runtimeQualified, false);
    assert.equal(boundary.missingCapabilities.filter((entry) => entry.domainId).length, 8);
    assert.equal(inventory.contracts.length, 31);
});

test('stable window alone is insufficient; independent owner sequences and all state proofs are still required', async () =>
{
    const model = modelOwner();
    let elapsed = 0;
    const clock = {monotonic: () =>
    {
        elapsed += 100;
        return elapsed;
    }, utc: () => '2026-10-08T00:00:00.000Z'};
    const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner, {clock, stabilityWindowMs: 50}));
    assert.equal(result.status, 'quiescent');
    assert.equal(result.trace.filter((state) => state === 'observed').length, 2);
    await result.release();
    const pending = modelOwner();
    const read = pending.owner.readObservations;
    pending.owner.readObservations = async (request) =>
    {
        const batch = await read(request);
        batch.domains[0] = reseal({...batch.domains[0], inFlightCount: 1, status: 'blocked'});
        return batch;
    };
    elapsed = 0;
    const blocked = await runRuntimeQuiescenceBarrier(barrierOptions(pending.owner,
        {clock, stabilityWindowMs: 50, maximumObservationRounds: 3}));
    assert.notEqual(blocked.status, 'quiescent');
});

test('cancellation after seal triggers owner cleanup without waiting for a consumer check', async () =>
{
    const model = modelOwner();
    const controller = new AbortController();
    const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner, {signal: controller.signal}));
    assert.equal(result.status, 'quiescent');
    controller.abort();
    const released = await result.release();
    assert.equal(released.outcome, 'cancelled');
    assert.equal(released.status, 'released');
    assert.equal(model.model.active, false);
});

test('a rejected new claim is recorded by the owner without weakening the frozen barrier', async () =>
{
    const model = modelOwner();
    const freeze = model.owner.freeze;
    model.owner.freeze = async (request) =>
    {
        const proof = await freeze(request);
        model.model.rejectedClaimCount = 1;
        return proof;
    };
    const journal = memoryJournal();
    const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner, {journal}));
    assert.equal(result.status, 'quiescent');
    assert.equal(journal.events.find((event) => event.state === 'observed').rejectedClaimCount, 1);
    await result.release();
});

test('unknown attempt settlement or pending owner operations cannot produce a successful release receipt', async () =>
{
    for (const pending of [false, true])
    {
        const model = modelOwner();
        if (pending)
        {
            const post = model.owner.postObserve;
            model.owner.postObserve = async (request) => ({...await post(request), pendingOperations: 1});
        }
        else
        {
            const abort = model.owner.abortAttempt;
            model.owner.abortAttempt = async (request) => ({...await abort(request), status: 'unknown'});
        }
        const session = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner));
        assert.equal(session.status, 'quiescent');
        const release = await session.release();
        assert.equal(release.status, 'failed');
        assert.ok(release.errors.length);
    }
});

test('incomplete source-capture shape is refused without filling any observation field', async () =>
{
    const model = modelOwner();
    const read = model.owner.readObservations;
    const raw = {DomainId: 'comment-mutation-outbox', SourceApi: 'CommentMutationOutboxRuntimeState.CreateSnapshot/v1',
        SourceAvailable: true, Metrics: {'backlog-count': 0}, Blockers: ['current-run-namespace-and-runtime-identity=unavailable'],
        RuntimeQualified: false};
    model.owner.readObservations = async (request) =>
    {
        const batch = await read(request);
        batch.domains[0] = structuredClone(raw);
        return batch;
    };
    const result = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner));
    assert.notEqual(result.status, 'quiescent');
    assert.equal(result.qualified, false);
    assert.equal(result.trace.includes('sealed'), false);
    assert.equal(Object.hasOwn(raw, 'runId'), false);
    assert.equal(model.model.active, false);
});
