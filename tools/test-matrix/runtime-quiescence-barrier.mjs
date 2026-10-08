import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';

import {deriveQuiescenceInventory, inspectQuiescenceObservation, quiescenceDigest} from './quiescence-contract.mjs';
import {assertQuiescenceIdentity, assertQuiescenceLease, generateQuiescenceReceipt, observationOptions,
    quiescenceSemanticState, validateQuiescencePlan, validateQuiescenceReceipt} from './runtime-quiescence-receipt.mjs';

export const quiescenceOwnerMethods = Object.freeze([
    'readIdentity', 'acquire', 'validate', 'renew', 'freeze', 'capturePlan', 'readObservations',
    'abortAttempt', 'release', 'postObserve'
]);

export class QuiescenceBarrierError extends Error
{
    constructor(message, status = 'blocked')
    {
        super(message);
        this.status = status;
    }
}

function immutable(value)
{
    const copy = structuredClone(value);
    const freeze = (item) =>
    {
        if (item && typeof item === 'object')
        {
            Object.values(item).forEach(freeze);
            Object.freeze(item);
        }
        return item;
    };
    return freeze(copy);
}

async function boundedCall(action, timeoutMs, signal)
{
    signal?.throwIfAborted();
    const cancellation = new AbortController();
    let timer;
    let listener;
    const interrupted = new Promise((_resolve, reject) =>
    {
        const stop = (error) =>
        {
            cancellation.abort(error);
            reject(error);
        };
        timer = setTimeout(() => stop(new QuiescenceBarrierError('bounded operation timed out', 'failed')), timeoutMs);
        listener = () => stop(new QuiescenceBarrierError('barrier cancelled', 'failed'));
        signal?.addEventListener('abort', listener, {once: true});
    });
    try
    {
        return await Promise.race([Promise.resolve().then(() => action(cancellation.signal)), interrupted]);
    }
    finally
    {
        clearTimeout(timer);
        signal?.removeEventListener('abort', listener);
    }
}

function inspectBatch(batch, {plan, identity, lease, inventory, schema, previousSequence})
{
    assertQuiescenceIdentity(batch?.identity, identity);
    if (batch.leaseId !== lease.leaseId || batch.leaseGeneration !== lease.generation ||
        !Number.isSafeInteger(batch.sequence) || batch.sequence <= previousSequence ||
        !Array.isArray(batch.domains) || batch.domains.length !== inventory.contracts.length ||
        new Set(batch.domains.map((entry) => entry.domainId)).size !== batch.domains.length)
    {
        throw new QuiescenceBarrierError('observer batch sequence, lease or exact domain roster unavailable/drift');
    }
    let pending = false;
    for (const entry of plan.domains)
    {
        const observation = batch.domains.find((domain) => domain.domainId === entry.domainId);
        const inspection = inspectQuiescenceObservation(observation, observationOptions(plan, entry, inventory, schema));
        if (inspection.identityBlockers.length)
        {
            throw new QuiescenceBarrierError(inspection.identityBlockers.join('; '), 'failed');
        }
        const counts = ['pendingCount', 'inFlightCount', 'activeMutationTransactionCount',
            'unacknowledgedInvalidationCount', 'terminalFailureCount'];
        if (counts.some((field) => observation[field] === null) || observation.activeClaims === null ||
            ['unknown', 'unavailable'].includes(observation.status) || observation.commitPostcondition === 'unavailable')
        {
            throw new QuiescenceBarrierError(`observer unavailable: ${entry.domainId}`);
        }
        if (observation.terminalFailureCount > 0 || observation.status === 'failed' || observation.commitPostcondition === 'failed')
        {
            throw new QuiescenceBarrierError(`terminal obligation or commit failure: ${entry.domainId}`, 'failed');
        }
        const work = counts.some((field) => observation[field] > 0) || observation.activeClaims.length > 0;
        if (!work && inspection.activityBlockers.length)
        {
            throw new QuiescenceBarrierError(`zero work cannot replace commit/status proof: ${entry.domainId}`);
        }
        pending ||= work;
    }
    return {pending, semanticDigest: quiescenceDigest(quiescenceSemanticState(batch.domains))};
}

// This protocol consumes independent production owner facts. It does not implement
// a new lease store, release fence, worker admission hook or observer authority.
export async function runRuntimeQuiescenceBarrier({authorities, owner, journal, identity: requestedIdentity,
    signal, timeoutMs = 30_000, operationTimeoutMs = 2_000, cleanupTimeoutMs = 2_000,
    pollIntervalMs = 25, stabilityWindowMs = 25, minimumStableObservations = 2, maximumObservationRounds = 1_000,
    clock = {monotonic: () => performance.now(), utc: () => new Date().toISOString()}})
{
    const inventory = immutable(deriveQuiescenceInventory(authorities));
    const identity = immutable(requestedIdentity);
    const schema = immutable(authorities.schema);
    const attemptId = randomUUID();
    const startedAt = clock.utc();
    const deadline = clock.monotonic() + timeoutMs;
    const realDeadline = performance.now() + timeoutMs;
    let lease = null;
    let plan = null;
    let domains = [];
    let state = 'initial';
    let attemptedAcquire = false;
    let frozen = false;
    let handedOff = false;
    let consumerCustody = false;
    let lastSequence = 0;
    let releasePromise = null;
    let sessionCancellation = null;
    let rejectedClaims = 0;
    const trace = [];
    const call = (action, activeSignal = signal) =>
    {
        if (!handedOff && (clock.monotonic() >= deadline || performance.now() >= realDeadline))
        {
            throw new QuiescenceBarrierError('quiescence drain deadline expired', 'failed');
        }
        return boundedCall(action, handedOff ? operationTimeoutMs :
            Math.min(operationTimeoutMs, Math.max(1, deadline - clock.monotonic())), activeSignal);
    };
    const transition = async (next, facts = {}) =>
    {
        state = next;
        trace.push(next);
        await call((activeSignal) => journal.append({state: next, attemptId, identity, ...facts}, {signal: activeSignal}));
    };
    const guard = async (renew = false) =>
    {
        const liveIdentity = immutable(await call((activeSignal) => owner.readIdentity({signal: activeSignal})));
        assertQuiescenceIdentity(liveIdentity, identity);
        const grant = immutable(await call((activeSignal) => owner[renew ? 'renew' : 'validate'](
            {attemptId, identity, lease}, {signal: activeSignal})));
        assertQuiescenceLease(grant, identity, lease);
        if (frozen && (grant.admissionFenceStatus !== 'frozen' || grant.fenceGeneration !== lease.generation ||
            grant.acceptedClaimCount !== 0 || !Number.isSafeInteger(grant.rejectedClaimCount) || grant.rejectedClaimCount < rejectedClaims))
        {
            throw new QuiescenceBarrierError('admission fence lost or a new mutation claim was accepted', 'failed');
        }
        if (frozen)
        {
            rejectedClaims = grant.rejectedClaimCount;
        }
        return grant;
    };
    const cleanup = (outcome = 'complete') =>
    {
        if (!['complete', 'failed', 'cancelled', 'timed-out'].includes(outcome))
        {
            return Promise.reject(new QuiescenceBarrierError('invalid quiescence release outcome'));
        }
        releasePromise ??= (async () =>
        {
            const errors = [];
            const cleanCall = (action) => boundedCall(action, cleanupTimeoutMs);
            // abortAttempt is an owner tombstone/settlement boundary. It must forbid
            // a timed-out acquire/freeze from creating resources after post-observe.
            if (attemptedAcquire)
            {
                try
                {
                    const aborted = await cleanCall((activeSignal) => owner.abortAttempt(
                        {attemptId, identity, lease, outcome}, {signal: activeSignal}));
                    assertQuiescenceIdentity(aborted?.identity, identity);
                    if (aborted.attemptId !== attemptId || aborted.status !== 'settled')
                    {
                        throw new Error('attempt was not owner-settled');
                    }
                }
                catch (error)
                {
                    errors.push(`abort-attempt:${error.message}`);
                }
                if (lease)
                {
                    try
                    {
                        const released = await cleanCall((activeSignal) => owner.release(
                            {attemptId, identity, lease, outcome}, {signal: activeSignal}));
                        assertQuiescenceIdentity(released?.identity, identity);
                        if (released.leaseId !== lease.leaseId || released.generation !== lease.generation || released.status !== 'released')
                        {
                            throw new Error('release owner/generation/status mismatch');
                        }
                    }
                    catch (error)
                    {
                        errors.push(`release:${error.message}`);
                    }
                }
                try
                {
                    const post = await cleanCall((activeSignal) => owner.postObserve(
                        {attemptId, identity, lease}, {signal: activeSignal}));
                    assertQuiescenceIdentity(post?.identity, identity);
                    if (post.attemptId !== attemptId || post.leaseActive !== false || post.fenceActive !== false || post.pendingOperations !== 0)
                    {
                        throw new Error('post-observation is unavailable or owner resources remain');
                    }
                }
                catch (error)
                {
                    errors.push(`post-observe:${error.message}`);
                }
            }
            const payload = {schema: 'fsusblog.quiescence-release.v1', attemptId, identity,
                leaseId: lease?.leaseId ?? null, generation: lease?.generation ?? null,
                outcome, status: errors.length ? 'failed' : 'released', errors};
            const receipt = immutable({...payload, contentDigest: quiescenceDigest(payload)});
            try
            {
                await cleanCall((activeSignal) => journal.append({state: 'released', attemptId, identity,
                    releaseReceipt: receipt}, {signal: activeSignal}));
            }
            catch (error)
            {
                errors.push(`release-journal:${error.message}`);
            }
            signal?.removeEventListener('abort', sessionCancellation);
            state = 'released';
            return immutable(errors.length ? {...payload, status: 'failed', errors, contentDigest: quiescenceDigest({...payload, status: 'failed', errors})} : receipt);
        })();
        return releasePromise;
    };
    try
    {
        if (![timeoutMs, operationTimeoutMs, cleanupTimeoutMs].every((value) => Number.isFinite(value) && value > 0 && value <= 60_000) ||
            !Number.isFinite(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 1_000 ||
            !Number.isFinite(stabilityWindowMs) || stabilityWindowMs < 0 || stabilityWindowMs >= timeoutMs ||
            !Number.isSafeInteger(minimumStableObservations) || minimumStableObservations < 2 ||
            !Number.isSafeInteger(maximumObservationRounds) || maximumObservationRounds < minimumStableObservations || maximumObservationRounds > 10_000)
        {
            throw new QuiescenceBarrierError('bounded barrier policy invalid');
        }
        const missing = quiescenceOwnerMethods.filter((method) => typeof owner?.[method] !== 'function');
        if (missing.length || typeof journal?.append !== 'function')
        {
            throw new QuiescenceBarrierError(`production owner capabilities unavailable: ${missing.join(',')}`);
        }
        const observedIdentity = immutable(await call((activeSignal) => owner.readIdentity({signal: activeSignal})));
        assertQuiescenceIdentity(observedIdentity, identity);
        if (identity.stateDomainCatalogDigest !== inventory.stateDomainCatalogDigest)
        {
            throw new QuiescenceBarrierError('scheduler/current catalog identity drift');
        }
        attemptedAcquire = true;
        const acquired = immutable(await call((activeSignal) => owner.acquire({attemptId, identity, inventory}, {signal: activeSignal})));
        assertQuiescenceLease(acquired, identity);
        lease = acquired;
        await transition('prepared', {lease});
        await guard();
        const freeze = immutable(await call((activeSignal) => owner.freeze({attemptId, identity, lease, inventory}, {signal: activeSignal})));
        assertQuiescenceIdentity(freeze.identity, identity);
        const expectedDomains = inventory.contracts.map((entry) => entry.domainId).sort();
        if (freeze.status !== 'frozen' || freeze.leaseId !== lease.leaseId || freeze.generation !== lease.generation ||
            !Array.isArray(freeze.domainIds) || JSON.stringify([...freeze.domainIds].sort()) !== JSON.stringify(expectedDomains))
        {
            throw new QuiescenceBarrierError('admission freeze missing, partial or stale');
        }
        frozen = true;
        await guard();
        plan = immutable(await call((activeSignal) => owner.capturePlan({attemptId, identity, lease, inventory, freeze}, {signal: activeSignal})));
        validateQuiescencePlan(plan, {inventory, identity, lease});
        await transition('frozen', {plan});
        let stableSince = null;
        let stableCount = 0;
        let stableDigest = null;
        let rounds = 0;
        while (clock.monotonic() < deadline && performance.now() < realDeadline && rounds < maximumObservationRounds)
        {
            rounds += 1;
            await guard(true);
            const batch = immutable(await call((activeSignal) => owner.readObservations({attemptId, identity, lease, plan}, {signal: activeSignal})));
            const observation = inspectBatch(batch, {plan, identity, lease, inventory, schema, previousSequence: lastSequence});
            lastSequence = batch.sequence;
            domains = batch.domains;
            await transition('observed', {sequence: lastSequence, semanticDigest: observation.semanticDigest, pending: observation.pending, rejectedClaimCount: rejectedClaims});
            if (observation.pending)
            {
                stableSince = null;
                stableCount = 0;
                stableDigest = null;
            }
            else
            {
                if (stableDigest !== observation.semanticDigest)
                {
                    stableSince = clock.monotonic();
                    stableCount = 0;
                    stableDigest = observation.semanticDigest;
                }
                stableCount += 1;
                if (stableCount >= minimumStableObservations && clock.monotonic() - stableSince >= stabilityWindowMs)
                {
                    const currentLease = await guard();
                    const receipt = immutable(generateQuiescenceReceipt({identity, inventory, lease, plan, domains,
                        startedAt, sealedAt: clock.utc(), status: 'quiescent'}));
                    validateQuiescenceReceipt(receipt, {identity, inventory, schema, plan, currentLease});
                    await transition('sealed', {receipt});
                    await guard();
                    sessionCancellation = () =>
                    {
                        if (!consumerCustody)
                        {
                            void cleanup('cancelled');
                        }
                    };
                    signal?.addEventListener('abort', sessionCancellation, {once: true});
                    signal?.throwIfAborted();
                    handedOff = true;
                    const sessionCheck = async (renew, releaseOnFailure = true) =>
                    {
                        try
                        {
                            if (releasePromise || state !== 'sealed')
                            {
                                throw new QuiescenceBarrierError('quiescence session no longer active', 'failed');
                            }
                            const freshLease = await guard(renew);
                            const freshBatch = immutable(await call((activeSignal) => owner.readObservations(
                                {attemptId, identity, lease, plan}, {signal: activeSignal})));
                            const fresh = inspectBatch(freshBatch, {plan, identity, lease, inventory, schema, previousSequence: lastSequence});
                            lastSequence = freshBatch.sequence;
                            if (fresh.pending || fresh.semanticDigest !== receipt.finalStateDigest)
                            {
                                throw new QuiescenceBarrierError('sealed state changed', 'failed');
                            }
                            validateQuiescenceReceipt(receipt, {identity, inventory, schema, plan, currentLease: freshLease});
                            return receipt;
                        }
                        catch (error)
                        {
                            if (releaseOnFailure)
                            {
                                await cleanup('failed');
                            }
                            throw error;
                        }
                    };
                    return {status: 'quiescent', receipt, plan, trace: [...trace],
                        validate: () => sessionCheck(false), renew: () => sessionCheck(true),
                        claimConsumerCustody: () =>
                        {
                            if (consumerCustody || releasePromise || state !== 'sealed')
                            {
                                throw new QuiescenceBarrierError('consumer custody already claimed or session inactive', 'failed');
                            }
                            signal?.throwIfAborted();
                            consumerCustody = true;
                            return Object.freeze({leaseId: lease.leaseId, generation: lease.generation,
                                receiptDigest: receipt.contentDigest, invalidationSignal: signal ?? null});
                        },
                        // Measurement holders cancel and observe their producers before
                        // invoking the same final-release owner; never release early.
                        validateHeld: () => sessionCheck(false, false), renewHeld: () => sessionCheck(true, false), release: cleanup};
                }
            }
            // Backoff is transport only. No timer or script completion can set state sealed.
            if (pollIntervalMs)
            {
                await call((activeSignal) => new Promise((resolve, reject) =>
                {
                    const timer = setTimeout(resolve, pollIntervalMs);
                    activeSignal.addEventListener('abort', () =>
                    {
                        clearTimeout(timer);
                        reject(activeSignal.reason);
                    }, {once: true});
                }));
            }
        }
        throw new QuiescenceBarrierError('quiescence drain deadline expired', 'failed');
    }
    catch (error)
    {
        const failedState = state;
        const releaseReceipt = await cleanup('failed');
        const receipt = generateQuiescenceReceipt({identity, inventory, lease, plan, domains, startedAt,
            sealedAt: clock.utc(), status: error.status ?? 'failed', blockers: [error.message, ...releaseReceipt.errors]});
        return {status: receipt.status, receipt: immutable(receipt), releaseReceipt, trace: [...trace],
            qualified: false, previousState: failedState};
    }
    finally
    {
        if (!handedOff && attemptedAcquire)
        {
            await cleanup('failed');
        }
    }
}
