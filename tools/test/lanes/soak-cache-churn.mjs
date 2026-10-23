import { performance } from 'node:perf_hooks';
import { clearTimeout as clearDeadline, setTimeout as scheduleDeadline } from 'node:timers';
import { setImmediate as nextTurn } from 'node:timers/promises';

export const cacheChurnSteps = Object.freeze([
    'read-current-generation',
    'mutate-dedicated-canary',
    'verify-durable-obligation',
    'observe-revocation-or-version-bump',
    'prove-old-generation-not-current',
    'wait-exact-rebuild',
    'read-new-generation',
    'verify-canary-payload',
    'verify-generation-equality',
    'cleanup-canary',
    'verify-cleanup-generation'
]);

const driverMethods = [
    'readCurrentGeneration', 'mutateCanary', 'readObligation',
    'readRevocation', 'readPublication', 'cleanupCanary'
];
const generationOwners = ['database', 'redisFrame', 'hotRead', 'aotReceipt'];

function requireProof(condition, failureKind)
{
    if (!condition)
    {
        throw new Error(failureKind);
    }
}

function positiveInteger(value)
{
    return Number.isSafeInteger(value) && value > 0;
}

function validatePolicy(policy)
{
    requireProof(policy && ['minimumCycles', 'cycleTimeoutMs', 'cleanupTimeoutMs']
        .every((key) => positiveInteger(policy[key])), 'cache-churn-policy-invalid');
}

function deadlineScope(timeoutMs, parentSignal)
{
    const controller = new AbortController();
    const timer = scheduleDeadline(() => controller.abort(new Error('cache-churn-observation-timeout')), timeoutMs);
    return {
        signal: parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal,
        dispose: () => clearDeadline(timer)
    };
}

async function invokeDriver(driver, method, identity, signal)
{
    signal.throwIfAborted();
    let onAbort;
    const interrupted = new Promise((_, reject) =>
    {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try
    {
        return await Promise.race([driver[method](identity, signal), interrupted]);
    }
    finally
    {
        signal.removeEventListener('abort', onAbort);
    }
}

export function readCacheChurnPolicy(policyText)
{
    const section = policyText.match(/^soakCacheChurn:\r?\n((?:[ \t]+[^\r\n]*\r?\n?)+)/mu)?.[1];
    requireProof(section, 'cache-churn-policy-missing');
    const policy = {};
    for (const key of ['minimumCycles', 'cycleTimeoutMs', 'cleanupTimeoutMs'])
    {
        const matches = [...section.matchAll(new RegExp(`^  ${key}: ([0-9]+)$`, 'gmu'))];
        requireProof(matches.length === 1, `cache-churn-policy-invalid:${key}`);
        policy[key] = Number(matches[0][1]);
        requireProof(positiveInteger(policy[key]), `cache-churn-policy-invalid:${key}`);
    }
    return policy;
}

function verifyIdentity(proof, identity)
{
    requireProof(proof && ['runId', 'namespace', 'cycleId', 'mutationId', 'canaryKey']
        .every((key) => proof[key] === identity[key]), 'cache-churn-identity-mismatch');
}

function verifyObligation(proof, identity, previousGeneration)
{
    verifyIdentity(proof, identity);
    requireProof(typeof proof.obligationId === 'string' && proof.obligationId.length > 0,
        'cache-churn-obligation-missing');
    requireProof(proof.durable === true, 'cache-churn-obligation-not-durable');
    requireProof(positiveInteger(proof.targetGeneration) && proof.targetGeneration > previousGeneration,
        'cache-churn-target-generation-not-advanced');
    requireProof(['accepted', 'persisted-dirty', 'coalesced'].includes(proof.deliveryResult),
        'cache-churn-delivery-failed');
    requireProof(!proof.queueFull || proof.deliveryResult === 'persisted-dirty',
        'cache-churn-queue-full-without-durable-marker');
    requireProof(['pending', 'processing', 'published'].includes(proof.state),
        `cache-churn-obligation-failed:${proof.state}`);
    requireProof(proof.attemptNumber === 0 || proof.attemptNumber === 1,
        'cache-churn-worker-retry');
    requireProof(Array.isArray(proof.attempts)
        && proof.attempts.every((attempt) => attempt.attemptNumber === 1 && attempt.failureKind === 'none'),
    'cache-churn-worker-attempt-evidence-invalid');
    if (proof.state === 'published')
    {
        requireProof(proof.attemptNumber === 1
            && ['projector', 'publish', 'revocation-completion', 'completion']
                .every((stage) => proof.attempts.some((attempt) => attempt.stage === stage)),
        'cache-churn-worker-attempt-evidence-incomplete');
    }
    return proof;
}

function verifyPayload(proof, identity, present)
{
    for (const owner of generationOwners)
    {
        const payload = proof.payloads?.[owner];
        requireProof(payload && payload.canaryKey === identity.canaryKey
            && payload.present === present
            && (!present || payload.value === identity.canaryValue),
        `cache-churn-stale-payload:${owner}`);
    }
}

function verifyPublication(proof, identity, obligation, present)
{
    verifyIdentity(proof, identity);
    requireProof(proof.state === 'published', 'cache-churn-rebuild-not-published');
    verifyObligation(proof.obligation, identity, obligation.targetGeneration - 1);
    requireProof(proof.obligation.obligationId === obligation.obligationId
        && proof.obligation.targetGeneration === obligation.targetGeneration
        && proof.obligation.state === 'published', 'cache-churn-exact-obligation-not-published');
    requireProof(proof.publishedGeneration === obligation.targetGeneration
        && proof.obligation.publishedGeneration === proof.publishedGeneration,
    'cache-churn-exact-generation-not-published');
    requireProof(proof.oldGenerationIsCurrent === false, 'cache-churn-old-generation-current');
    for (const owner of generationOwners)
    {
        requireProof(proof.generations?.[owner] === proof.publishedGeneration,
            `cache-churn-generation-mismatch:${owner}`);
    }
    verifyPayload(proof, identity, present);
    return proof;
}

async function waitForPostcondition(read, evaluate, signal)
{
    for (;;)
    {
        signal.throwIfAborted();
        const observation = await read(signal);
        signal.throwIfAborted();
        if (evaluate(observation))
        {
            return observation;
        }
        // Yield between observations, without treating elapsed time as rebuild proof.
        await nextTurn(undefined, { signal });
    }
}

function cycleIdentity(runId, namespace, ordinal)
{
    const cycleId = `${runId}/cycle-${ordinal}`;
    return {
        runId, namespace, cycleId,
        mutationId: `${cycleId}/mutation`,
        canaryKey: `soak:${namespace}:${cycleId}`,
        canaryValue: `${cycleId}/payload`
    };
}

export async function runCacheChurnCycle({ driver, identity, policy, signal })
{
    validatePolicy(policy);
    const receipt = { ...identity, status: 'failed', steps: [], failures: [], cleanup: null };
    const cycleDeadline = deadlineScope(policy.cycleTimeoutMs, signal);
    const cycleSignal = cycleDeadline.signal;
    let mutationAttempted = false;
    const step = (name, proof) => receipt.steps.push({ name, proof });
    try
    {
        const previous = await invokeDriver(driver, 'readCurrentGeneration', identity, cycleSignal);
        verifyIdentity(previous, identity);
        requireProof(positiveInteger(previous.generation), 'cache-churn-current-generation-unavailable');
        receipt.previousGeneration = previous.generation;
        step(cacheChurnSteps[0], previous);

        mutationAttempted = true;
        const mutation = await invokeDriver(driver, 'mutateCanary', identity, cycleSignal);
        verifyIdentity(mutation, identity);
        requireProof(mutation.committed === true, 'cache-churn-mutation-not-committed');
        step(cacheChurnSteps[1], mutation);

        const obligation = verifyObligation(
            await invokeDriver(driver, 'readObligation', identity, cycleSignal), identity, previous.generation);
        receipt.obligationId = obligation.obligationId;
        receipt.targetGeneration = obligation.targetGeneration;
        receipt.deliveryAttempt = {
            result: obligation.deliveryResult,
            queueFull: obligation.queueFull === true
        };
        step(cacheChurnSteps[2], obligation);

        const revocation = await waitForPostcondition(
            (waitSignal) => invokeDriver(driver, 'readRevocation', identity, waitSignal),
            (proof) =>
            {
                verifyIdentity(proof, identity);
                requireProof(proof.previousGeneration === previous.generation,
                    'cache-churn-revocation-previous-generation-mismatch');
                if (proof.state === 'pending')
                {
                    return false;
                }
                requireProof(proof.state === 'observed'
                    && proof.targetGeneration === obligation.targetGeneration,
                'cache-churn-revocation-not-observed');
                requireProof(proof.oldGenerationIsCurrent === false,
                    'cache-churn-old-generation-current');
                return true;
            }, cycleSignal);
        step(cacheChurnSteps[3], revocation);
        step(cacheChurnSteps[4], revocation);

        const published = await waitForPostcondition(
            (waitSignal) => invokeDriver(driver, 'readPublication', identity, waitSignal),
            (proof) =>
            {
                verifyIdentity(proof, identity);
                verifyObligation(proof.obligation, identity, previous.generation);
                if (proof.state === 'pending')
                {
                    return false;
                }
                requireProof(proof.state === 'published', 'cache-churn-rebuild-failed');
                verifyPublication(proof, identity, obligation, true);
                return true;
            }, cycleSignal);
        step(cacheChurnSteps[5], published);
        const current = await invokeDriver(driver, 'readPublication', identity, cycleSignal);
        verifyPublication(current, identity, obligation, true);
        receipt.publishedGeneration = current.publishedGeneration;
        step(cacheChurnSteps[6], current);
        step(cacheChurnSteps[7], current.payloads);
        step(cacheChurnSteps[8], current.generations);
    }
    catch (error)
    {
        receipt.failures.push(error.message);
    }
    finally
    {
        cycleDeadline.dispose();
        if (mutationAttempted)
        {
            // Cleanup has a fresh bounded signal even when the measurement was interrupted.
            const cleanupDeadline = deadlineScope(policy.cleanupTimeoutMs);
            const cleanupSignal = cleanupDeadline.signal;
            const cleanupIdentity = { ...identity, mutationId: `${identity.cycleId}/cleanup` };
            try
            {
                const cleanup = await invokeDriver(driver, 'cleanupCanary', cleanupIdentity, cleanupSignal);
                verifyIdentity(cleanup, cleanupIdentity);
                requireProof(cleanup.committed === true, 'cache-churn-cleanup-not-committed');
                const cleanupObligation = verifyObligation(
                    cleanup.obligation, cleanupIdentity,
                    receipt.targetGeneration ?? receipt.previousGeneration);
                step(cacheChurnSteps[9], cleanup);
                const published = await waitForPostcondition(
                    (waitSignal) => invokeDriver(driver, 'readPublication', cleanupIdentity, waitSignal),
                    (proof) =>
                    {
                        verifyIdentity(proof, cleanupIdentity);
                        verifyObligation(proof.obligation, cleanupIdentity,
                            receipt.targetGeneration ?? receipt.previousGeneration);
                        if (proof.state === 'pending')
                        {
                            return false;
                        }
                        requireProof(proof.state === 'published', 'cache-churn-cleanup-rebuild-failed');
                        verifyPublication(proof, cleanupIdentity, cleanupObligation, false);
                        return true;
                    }, cleanupSignal);
                receipt.cleanup = { status: 'ok', ...published };
                step(cacheChurnSteps[10], published);
            }
            catch (error)
            {
                receipt.cleanup = { status: 'failed', failureKind: error.message };
                receipt.failures.push(`cleanup:${error.message}`);
            }
            finally
            {
                cleanupDeadline.dispose();
            }
        }
    }
    receipt.status = receipt.failures.length === 0 && receipt.steps.length === cacheChurnSteps.length
        ? 'ok' : 'failed';
    return receipt;
}

export function verifyCacheChurnEvidence({ cycles, policy, elapsedMs, durationMs })
{
    validatePolicy(policy);
    requireProof(positiveInteger(durationMs) && Number.isFinite(elapsedMs), 'cache-churn-window-invalid');
    requireProof(Array.isArray(cycles) && cycles.length >= policy.minimumCycles,
        'cache-churn-minimum-cycles-not-met');
    requireProof(elapsedMs >= durationMs, 'cache-churn-window-incomplete');
    const cycleIds = new Set();
    const mutationIds = new Set();
    let previousPublished = 0;
    for (const cycle of cycles)
    {
        requireProof(cycle.status === 'ok' && cycle.failures.length === 0, 'cache-churn-cycle-failed');
        requireProof(!cycleIds.has(cycle.cycleId) && !mutationIds.has(cycle.mutationId),
            'cache-churn-cycle-identity-reused');
        cycleIds.add(cycle.cycleId);
        mutationIds.add(cycle.mutationId);
        requireProof(cycle.previousGeneration >= previousPublished, 'cache-churn-generation-regressed');
        requireProof(cycle.steps.map((item) => item.name).join('|') === cacheChurnSteps.join('|'),
            'cache-churn-cycle-steps-incomplete');
        const identity = cycle;
        verifyIdentity(cycle.steps[0].proof, identity);
        requireProof(cycle.steps[1].proof.committed === true, 'cache-churn-mutation-not-committed');
        verifyIdentity(cycle.steps[1].proof, identity);
        const obligation = verifyObligation(cycle.steps[2].proof, identity, cycle.previousGeneration);
        requireProof(cycle.obligationId === obligation.obligationId
            && cycle.targetGeneration === obligation.targetGeneration,
        'cache-churn-cycle-summary-mismatch');
        verifyIdentity(cycle.steps[3].proof, identity);
        verifyIdentity(cycle.steps[4].proof, identity);
        requireProof(cycle.steps[3].proof.state === 'observed'
            && cycle.steps[3].proof.previousGeneration === cycle.previousGeneration
            && cycle.steps[3].proof.targetGeneration === obligation.targetGeneration,
        'cache-churn-revocation-not-observed');
        requireProof(cycle.steps[4].proof.oldGenerationIsCurrent === false,
            'cache-churn-old-generation-current');
        verifyPublication(cycle.steps[5].proof, identity, obligation, true);
        verifyPublication(cycle.steps[6].proof, identity, obligation, true);
        requireProof(cycle.publishedGeneration === cycle.steps[6].proof.publishedGeneration,
            'cache-churn-cycle-summary-mismatch');
        const cleanupIdentity = { ...identity, mutationId: `${identity.cycleId}/cleanup` };
        verifyIdentity(cycle.steps[9].proof, cleanupIdentity);
        requireProof(cycle.steps[9].proof.committed === true, 'cache-churn-cleanup-not-committed');
        const cleanupObligation = verifyObligation(cycle.steps[9].proof.obligation,
            cleanupIdentity, cycle.publishedGeneration);
        verifyPublication(cycle.steps[10].proof, cleanupIdentity, cleanupObligation, false);
        previousPublished = cycle.steps[10].proof.publishedGeneration;
    }
    return true;
}

export async function runCacheChurnWindow({ driver, policy, runId, namespace, durationMs,
    observeReads = async () =>
    {}, signal, now = () => performance.now() })
{
    validatePolicy(policy);
    requireProof(positiveInteger(durationMs), 'cache-churn-window-invalid');
    requireProof(typeof runId === 'string' && /^[A-Za-z0-9_.-]+$/u.test(runId)
        && typeof namespace === 'string' && /^[A-Za-z0-9_.-]+$/u.test(namespace),
    'cache-churn-run-namespace-invalid');
    const result = { status: 'blocked', runId, namespace, policy, durationMs, elapsedMs: 0, cycles: [] };
    if (!driver || driverMethods.some((method) => typeof driver[method] !== 'function'))
    {
        result.failureKind = 'cache-churn-live-observation-owner-unavailable';
        return result;
    }
    const startedAt = now();
    try
    {
        do
        {
            signal?.throwIfAborted();
            const identity = cycleIdentity(runId, namespace, result.cycles.length + 1);
            const cycle = await runCacheChurnCycle({ driver, identity, policy, signal });
            result.cycles.push(cycle);
            requireProof(cycle.status === 'ok', `cache-churn-cycle-failed:${cycle.failures.join(',')}`);
            await observeReads(signal);
        } while (now() - startedAt < durationMs);
        result.elapsedMs = now() - startedAt;
        verifyCacheChurnEvidence(result);
        result.status = 'ok';
    }
    catch (error)
    {
        result.elapsedMs = now() - startedAt;
        result.status = 'failed';
        result.failureKind = error.message;
    }
    return result;
}
