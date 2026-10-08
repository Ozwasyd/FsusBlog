import {randomUUID} from 'node:crypto';

import {loadMeasurementQuiescenceConsumers, requireMeasurementQuiescenceConsumer} from './quiescence-measurement-inventory.mjs';

const {quiescenceDigest} = await import(new URL('../test-matrix/quiescence-contract.mjs', import.meta.url));
const {projectRuntimeStateReady} = await import(new URL('../test-matrix/runtime-quiescence-receipt.mjs', import.meta.url));
const {validateQuiescenceReleaseReceipt} = await import(new URL('../test-matrix/runtime-quiescence-journal.mjs', import.meta.url));

export const measurementQuiescenceClassification = 'infra.quiescence-precondition';

function failure(message)
{
    return Object.assign(new Error(message), {classification: measurementQuiescenceClassification});
}

async function bounded(action, milliseconds)
{
    let timer;
    try
    {
        return await Promise.race([Promise.resolve().then(action), new Promise((_resolve, reject) =>
        {
            timer = setTimeout(() => reject(failure('consumer owner operation timed out')), milliseconds);
        })]);
    }
    finally
    {
        clearTimeout(timer);
    }
}

// Owns consumer holders only. The existing barrier remains the sole lease,
// admission-fence, observation and final-release owner.
export function createQuiescenceMeasurementConsumers({root, locator, consumers, session,
    readValidation, audit, subscribeInvalidation = null, operationTimeoutMs = 2_000, checkIntervalMs = 25})
{
    if (!Array.isArray(consumers) || !consumers.length || new Set(consumers.map((entry) => entry.consumerId)).size !== consumers.length ||
        consumers.some((entry) => !entry.consumerId || !['requires-quiescence', 'non-quiescent-worker-measurement'].includes(entry.stateContract)) ||
        !Number.isInteger(operationTimeoutMs) || operationTimeoutMs <= 0 || operationTimeoutMs > 60_000 ||
        !Number.isInteger(checkIntervalMs) || checkIntervalMs <= 0 || checkIntervalMs > 60_000 || typeof audit?.append !== 'function')
    {
        throw failure('explicit consumer inventory, audit owner and bounded policy required');
    }
    const roster = new Map(consumers.map((entry) => [entry.consumerId, Object.freeze({...entry})]));
    const consumerInventoryDigest = loadMeasurementQuiescenceConsumers().contentDigest;
    for (const entry of roster.values())
    {
        if (requireMeasurementQuiescenceConsumer(entry.consumerId).stateContract !== entry.stateContract)
        {
            throw failure('consumer state contract differs from its canonical declaration');
        }
    }
    const holders = new Map();
    const receipts = new Map();
    let queue = Promise.resolve();
    let finalRelease = null;
    let invalid = null;
    let closeRequested = false;
    let projection = null;
    let failedOutcome = false;
    let boundIdentity = null;
    let unsubscribe = null;
    let custody = null;
    let custodyCancellation = null;
    const serialize = (action) =>
    {
        const result = queue.then(action);
        queue = result.catch(() =>
        {});
        return result;
    };
    const append = (event) => bounded(() => audit.append(event), operationTimeoutMs);
    const check = (renew = false) => serialize(async () =>
    {
        if (invalid || finalRelease)
        {
            throw invalid ?? failure('consumer lease already released');
        }
        if (loadMeasurementQuiescenceConsumers().contentDigest !== consumerInventoryDigest)
        {
            throw failure('canonical consumer inventory changed during measurement');
        }
        if (typeof readValidation !== 'function' || ['claimConsumerCustody', 'validateHeld', 'renewHeld', 'release'].some((method) => typeof session?.[method] !== 'function'))
        {
            throw failure('protected production locator/lease authority unavailable');
        }
        if (!custody)
        {
            custody = session.claimConsumerCustody();
            custodyCancellation = () => invalidate(failure('held barrier cancellation'));
            custody.invalidationSignal?.addEventListener('abort', custodyCancellation, {once: true});
        }
        const receipt = await bounded(() => session[renew ? 'renewHeld' : 'validateHeld'](), operationTimeoutMs);
        const validation = await bounded(readValidation, operationTimeoutMs);
        const next = projectRuntimeStateReady({root, locator, validation});
        boundIdentity ??= structuredClone(validation.identity);
        if (receipt.contentDigest !== next.receiptDigest || (projection && quiescenceDigest(next) !== quiescenceDigest(projection)))
        {
            throw failure('sealed consumer receipt or lease generation drift');
        }
        if (custody.receiptDigest !== next.receiptDigest || custody.leaseId !== next.leaseId || custody.generation !== next.leaseGeneration)
        {
            throw failure('consumer custody receipt or lease generation drift');
        }
        projection ??= Object.freeze(structuredClone(next));
        return structuredClone(next);
    });
    const invalidate = (error) =>
    {
        invalid ??= failure(error.message);
        for (const holder of holders.values())
        {
            holder.controller.abort(invalid);
        }
    };
    const releaseIfTerminal = () =>
    {
        if (finalRelease || !session || holders.size || !closeRequested && receipts.size !== roster.size)
        {
            return finalRelease;
        }
        finalRelease = (async () =>
        {
            try
            {
                await queue;
                custody?.invalidationSignal?.removeEventListener('abort', custodyCancellation);
                const stopSubscription = unsubscribe;
                unsubscribe = null;
                try
                {
                    stopSubscription?.();
                }
                catch (error)
                {
                    invalidate(error);
                    failedOutcome = true;
                }
                const result = await bounded(() => session.release(invalid || failedOutcome ? 'failed' : 'complete'), operationTimeoutMs);
                const identity = boundIdentity ?? Object.fromEntries(['runId', 'namespace', 'candidateIdentityDigest',
                    'runtimeIdentityDigest', 'stateDomainCatalogDigest'].map((field) => [field, session.receipt?.[field]]));
                validateQuiescenceReleaseReceipt(result, {identity,
                    leaseId: session.receipt?.quiescenceLeaseId, generation: session.receipt?.quiescenceGeneration});
                if (result?.status !== 'released')
                {
                    throw failure('barrier final release/post-observation failed');
                }
                await append({state: 'lease-released', quiescence: projection, releaseReceipt: result});
                return {status: 'released', receipt: result};
            }
            catch (error)
            {
                invalidate(error);
                return {status: 'failed', error: error.message};
            }
        })();
        return finalRelease;
    };
    if (subscribeInvalidation !== null)
    {
        if (typeof subscribeInvalidation !== 'function')
        {
            throw failure('invalid protected invalidation event owner');
        }
        unsubscribe = subscribeInvalidation((reason) => invalidate(failure(String(reason))));
        if (typeof unsubscribe !== 'function')
        {
            throw failure('invalidation subscription requires owned unsubscribe');
        }
    }
    const run = async ({consumerId, producer, signal, timeoutMs, workerStateAuthority = null, quiescenceRef = null}) =>
    {
        const declaration = roster.get(consumerId);
        if (!declaration || holders.has(consumerId) || receipts.has(consumerId) || closeRequested)
        {
            const refusal = failure('unknown, duplicate or closed measurement consumer');
            invalidate(refusal);
            closeRequested = true;
            try
            {
                await append({state: 'consumer-refused', consumerId, reason: refusal.message});
            }
            finally
            {
                await releaseIfTerminal();
            }
            throw refusal;
        }
        if (declaration.stateContract === 'non-quiescent-worker-measurement')
        {
            if (quiescenceRef || locator || session || typeof workerStateAuthority?.run !== 'function')
            {
                throw failure('worker measurement requires its own active-state authority and cannot consume quiescence');
            }
            return workerStateAuthority.run({consumerId, producer, signal, timeoutMs});
        }
        const holder = {holderId: randomUUID(), controller: new AbortController(), started: false, terminal: false};
        holders.set(consumerId, holder);
        const startedAt = new Date().toISOString();
        let startCheck = null;
        let endCheck = null;
        let outcome = 'failed';
        let phase = 'admission';
        let result = null;
        let error = null;
        let cancellation = null;
        let monitor;
        let deadline;
        let abortListener;
        try
        {
            if (typeof producer?.start !== 'function' || typeof producer?.cancelAndObserveTerminal !== 'function' ||
                !Number.isInteger(timeoutMs) || timeoutMs <= 0 || signal?.aborted)
            {
                throw failure('producer terminal/cancellation owner or original explicit producer timeout budget required');
            }
            startCheck = await check();
            await append({state: 'holder-acquired', consumerId, holderId: holder.holderId,
                activeHolderCount: holders.size, quiescence: startCheck});
            signal?.throwIfAborted();
            holder.controller.signal.throwIfAborted();
            const aborted = new Promise((_resolve, reject) =>
            {
                holder.controller.signal.addEventListener('abort', () => reject(holder.controller.signal.reason), {once: true});
                abortListener = () => holder.controller.abort(failure('measurement cancelled'));
                signal?.addEventListener('abort', abortListener, {once: true});
                deadline = setTimeout(() => holder.controller.abort(failure('measurement timeout')), timeoutMs);
            });
            let monitoring = false;
            monitor = setInterval(() =>
            {
                if (monitoring || holder.terminal)
                {
                    return;
                }
                monitoring = true;
                void check(true).catch((caught) =>
                {
                    if (!holder.terminal)
                    {
                        invalidate(caught);
                    }
                }).finally(() =>
                {
                    monitoring = false;
                });
            }, checkIntervalMs);
            holder.started = true;
            phase = 'measurement';
            const execution = Promise.resolve().then(() => producer.start({signal: holder.controller.signal}));
            execution.then(() =>
            {
                holder.terminal = true;
            }, () =>
            {
                holder.terminal = true;
            });
            result = await Promise.race([execution, aborted]);
            phase = 'end-check';
            endCheck = await check();
            outcome = 'success';
        }
        catch (caught)
        {
            error = caught;
            failedOutcome = true;
            outcome = /timeout/u.test(caught.message) ? 'timeout' : /cancel/u.test(caught.message) ? 'cancelled' : 'failed';
            if (caught.classification === measurementQuiescenceClassification || holder.controller.signal.aborted)
            {
                invalidate(caught);
            }
        }
        finally
        {
            clearInterval(monitor);
            clearTimeout(deadline);
            signal?.removeEventListener('abort', abortListener);
            if (holder.started && !holder.terminal)
            {
                holder.controller.abort(error ?? failure('measurement terminal cleanup'));
                try
                {
                    cancellation = await bounded(() => producer.cancelAndObserveTerminal({reason: error?.message}), operationTimeoutMs);
                    if (cancellation?.status !== 'terminal')
                    {
                        error = failure('producer terminal observation unavailable');
                        invalidate(error);
                    }
                    else
                    {
                        holder.terminal = true;
                    }
                }
                catch (caught)
                {
                    invalidate(caught);
                    error = caught;
                }
            }
            if (!holder.started)
            {
                holder.terminal = true;
            }
            const payload = {schema: 'fsusblog.quiescence-consumer.v1', consumerId, stateContract: declaration.stateContract,
                consumerInventoryDigest,
                holderId: holder.holderId, quiescence: projection, startedAt, endedAt: new Date().toISOString(),
                startCheck, endCheck, outcome, cancellation, producerStarted: holder.started,
                producerTerminal: holder.terminal, holderStatus: holder.terminal ? 'released' : 'cleanup-required', error: error?.message ?? null};
            const receipt = {...payload, contentDigest: quiescenceDigest(payload)};
            try
            {
                await append({state: 'consumer-terminal', receipt});
            }
            catch (caught)
            {
                invalidate(caught);
                error = caught;
            }
            receipts.set(consumerId, receipt);
            if (holder.terminal)
            {
                holders.delete(consumerId);
            }
        }
        const release = await releaseIfTerminal();
        const prior = receipts.get(consumerId);
        const payload = {...prior, releaseResult: release ?? {status: 'held-for-declared-consumers'}};
        delete payload.contentDigest;
        const audited = {...payload, contentDigest: quiescenceDigest(payload)};
        try
        {
            await append({state: 'consumer-release-result', receipt: audited});
            receipts.set(consumerId, audited);
        }
        catch (caught)
        {
            invalidate(caught);
            error = caught;
        }
        return {status: error || invalid || release?.status === 'failed' ? 'failed' : 'completed',
            qualificationEligible: !error && !invalid && !failedOutcome && !holders.size && release?.status === 'released',
            result, receipt: receipts.get(consumerId), release: release ?? null,
            classification: invalid || error && phase !== 'measurement' ? measurementQuiescenceClassification : error?.classification ?? null};
    };
    return {run, validate: check, async close(reason = null)
    {
        closeRequested = true;
        if (reason)
        {
            invalidate(failure(reason));
        }
        const release = await releaseIfTerminal();
        return {status: holders.size ? 'cleanup-required' : release?.status ?? 'unavailable',
            activeHolderCount: holders.size, consumerReceipts: [...receipts.values()], release: release ?? null,
            qualificationEligible: !invalid && !failedOutcome && !holders.size && release?.status === 'released' && receipts.size === roster.size};
    }, holderCount: () => holders.size};
}
