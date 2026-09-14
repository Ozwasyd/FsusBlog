#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
    access,
    lstat,
    mkdir,
    readFile,
    readlink,
    readdir,
    realpath,
    rename,
    rm,
    stat,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { currentProcessIdentity, processIdentityStatus } from './process-identity.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultStateRoot = path.join(repoRoot, '.tmp', 'run-once');
const defaultPhysicalExecutionRoot = path.join(repoRoot, '.tmp', 'physical-executions');
const defaultLockTimeoutMs = 5 * 60 * 1000;
const defaultStaleLockMs = 15 * 60 * 1000;
const defaultHeartbeatMs = 5 * 1000;
const runBoundSchema = 'fsusblog.physical-execution-receipt.v3';
const lockOwnerSchema = 'fsusblog.run-once-lock-owner.v3';
const lockLifecycleSchema = 'fsusblog.run-once-lock-lifecycle.v1';
const lockObservationSchema = 'fsusblog.run-once-lock-observation.v1';

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

function digestValue(value)
{
    return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function normalizeTestIds(testIds)
{
    if (!Array.isArray(testIds))
    {
        throw new Error('run-bound testIds must be an array');
    }
    const normalized = testIds.map((testId) =>
    {
        if (typeof testId !== 'string' || !testId.trim())
        {
            throw new Error('run-bound testIds must contain non-empty strings');
        }
        return testId.trim();
    });
    return [...new Set(normalized)].sort();
}

async function writeJsonAtomic(file, document)
{
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
}

function sanitizeSegment(value, fallback)
{
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/gu, '-')
        .replace(/^-+|-+$/gu, '');
    return !normalized || normalized === '.' || normalized === '..' ? fallback : normalized;
}

async function exists(file)
{
    try
    {
        await access(file);
        return true;
    }
    catch
    {
        return false;
    }
}

async function hashOutputPath(output)
{
    const hash = createHash('sha256');

    async function visit(current, relativePath)
    {
        const metadata = await lstat(current);
        const type = metadata.isDirectory()
            ? 'directory'
            : metadata.isFile()
        ? 'file'
        : metadata.isSymbolicLink()
          ? 'symlink'
          : 'other';
        hash.update(`${relativePath || '.'}\0${type}\0${metadata.mode & 0o777}\0${metadata.size}\0`);
        if (metadata.isFile())
        {
            hash.update(await readFile(current));
            hash.update('\0');
            return;
        }
        if (metadata.isSymbolicLink())
        {
            hash.update(await readlink(current));
            hash.update('\0');
            return;
        }
        if (!metadata.isDirectory())
        {
            return;
        }

        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name)))
        {
            const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
            await visit(path.join(current, entry.name), childRelativePath);
        }
    }

    await visit(output, '');
    return {
        path: output,
        digest: hash.digest('hex')
    };
}

async function captureOutputStates(outputs)
{
    try
    {
        return await Promise.all((outputs ?? []).map(hashOutputPath));
    }
    catch (error)
    {
        if (error?.code === 'ENOENT')
        {
            return null;
        }
        throw error;
    }
}

async function outputsMatchState(outputs, expectedStates)
{
    if (!Array.isArray(expectedStates) || expectedStates.length !== outputs.length)
    {
        return false;
    }
    const actualStates = await captureOutputStates(outputs);
    return actualStates != null && JSON.stringify(actualStates) === JSON.stringify(expectedStates);
}

async function readState(file)
{
    try
    {
        return JSON.parse(await readFile(file, 'utf8'));
    }
    catch
    {
        return null;
    }
}

function throwIfAborted(signal)
{
    if (!signal?.aborted)
    {
        return;
    }
    if (signal.reason instanceof Error)
    {
        throw signal.reason;
    }
    throw Object.assign(new Error('operation aborted'), { name: 'AbortError' });
}

async function sleep(milliseconds, signal)
{
    throwIfAborted(signal);
    if (!signal)
    {
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
        return;
    }
    await new Promise((resolve, reject) =>
    {
        const timer = setTimeout(() =>
        {
            signal.removeEventListener('abort', abort);
            resolve();
        }, milliseconds);
        const abort = () =>
        {
            clearTimeout(timer);
            try
            {
                throwIfAborted(signal);
            }
            catch (error)
            {
                reject(error);
            }
        };
        signal.addEventListener('abort', abort, { once: true });
    });
}

async function writeLockOwner(ownerFile, owner)
{
    const temporaryOwnerFile = `${ownerFile}.${owner.ownerToken}.tmp`;
    await writeFile(temporaryOwnerFile, `${JSON.stringify(owner, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
    });
    await rename(temporaryOwnerFile, ownerFile);
}

function lockOwnerProcessIdentityMatches(owner, identity)
{
    return Boolean(
        owner &&
            identity &&
            owner.pid === identity.pid &&
            owner.processStartIdentity === identity.processStartIdentity &&
            owner.executablePath === identity.executablePath &&
            owner.executableDigest === identity.executableDigest &&
            owner.commandDigest === identity.commandDigest
    );
}

function lockOwnerIdentityMatches(expected, actual)
{
    return Boolean(
        expected &&
            actual &&
            expected.schema === actual.schema &&
            expected.ownerToken === actual.ownerToken &&
            lockOwnerProcessIdentityMatches(expected, actual) &&
            expected.schedulerRunId === actual.schedulerRunId &&
            expected.namespace === actual.namespace &&
            expected.executionKey === actual.executionKey
    );
}

function lockOwnerExactMatches(expected, actual)
{
    return lockOwnerIdentityMatches(expected, actual) && digestValue(expected) === digestValue(actual);
}

function lockOwnerIsComplete(owner, nowMs = Date.now())
{
    const createdAtMs = Date.parse(owner?.createdAt);
    const heartbeatAtMs = Date.parse(owner?.heartbeatAt);
    return Boolean(
        owner &&
            owner.schema === lockOwnerSchema &&
            typeof owner.ownerToken === 'string' &&
            owner.ownerToken.length > 0 &&
            Number.isInteger(owner.pid) &&
            owner.pid > 0 &&
            owner.processStartIdentity &&
            owner.executablePath &&
            owner.executableDigest &&
            owner.commandDigest &&
            Object.hasOwn(owner, 'schedulerRunId') &&
            (owner.schedulerRunId === null ||
                (typeof owner.schedulerRunId === 'string' && owner.schedulerRunId.length > 0)) &&
            typeof owner.namespace === 'string' &&
            owner.namespace.length > 0 &&
            typeof owner.executionKey === 'string' &&
            owner.executionKey.length > 0 &&
            Number.isFinite(createdAtMs) &&
            Number.isFinite(heartbeatAtMs) &&
            createdAtMs <= heartbeatAtMs &&
            heartbeatAtMs <= nowMs &&
            Number.isFinite(owner.heartbeatEveryMs) &&
            owner.heartbeatEveryMs > 0 &&
            Number.isFinite(owner.unverifiableGraceMs) &&
            owner.unverifiableGraceMs > 0 &&
            Number.isFinite(owner.staleAfterMs) &&
            owner.staleAfterMs > 0
    );
}

async function releaseOwnedLock(lockDirectory, expectedOwner)
{
    const owner = await readState(path.join(lockDirectory, 'owner.json'));
    if (lockOwnerIdentityMatches(expectedOwner, owner) && processIdentityStatus(expectedOwner).status === 'live')
    {
        const tombstone = `${lockDirectory}.release-${expectedOwner.ownerToken}`;
        try
        {
            await rename(lockDirectory, tombstone);
        }
        catch (error)
        {
            if (error?.code === 'ENOENT')
            {
                return;
            }
            throw error;
        }
        await rm(tombstone, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 10
        });
    }
}

function lockOwnerPolicy(staleAfterMs, heartbeatEveryMs)
{
    return {
        schema: lockOwnerSchema,
        heartbeatEveryMs,
        unverifiableGraceMs: staleAfterMs,
        staleAfterMs
    };
}

function createLockLifecycleReceipt(owner)
{
    const payload = {
        schema: lockLifecycleSchema,
        ownerSchema: owner.schema,
        ownerToken: owner.ownerToken,
        schedulerRunId: owner.schedulerRunId,
        namespace: owner.namespace,
        executionKey: owner.executionKey,
        ownerIdentity: {
            pid: owner.pid,
            processStartIdentity: owner.processStartIdentity,
            executablePath: owner.executablePath,
            executableDigest: owner.executableDigest,
            commandDigest: owner.commandDigest
        },
        policy: {
            heartbeatEveryMs: owner.heartbeatEveryMs,
            unverifiableGraceMs: owner.unverifiableGraceMs,
            staleAfterMs: owner.staleAfterMs
        },
        acquiredAt: owner.createdAt
    };
    return { ...payload, receiptDigest: digestValue(payload) };
}

export function validateRunOnceLockLifecycleReceipt(
    receipt,
    { namespace = receipt?.namespace, executionKey = receipt?.executionKey } = {}
)
{
    const payload = { ...receipt };
    delete payload.receiptDigest;
    const identity = receipt?.ownerIdentity;
    const policy = receipt?.policy;
    if (
        receipt?.schema !== lockLifecycleSchema ||
        receipt.ownerSchema !== lockOwnerSchema ||
        typeof receipt.ownerToken !== 'string' ||
        receipt.ownerToken.length === 0 ||
        receipt.namespace !== namespace ||
        receipt.executionKey !== executionKey ||
        !Object.hasOwn(receipt, 'schedulerRunId') ||
        !Number.isFinite(Date.parse(receipt.acquiredAt)) ||
        !Number.isInteger(identity?.pid) ||
        identity.pid <= 0 ||
        !identity.processStartIdentity ||
        !identity.executablePath ||
        !identity.executableDigest ||
        !identity.commandDigest ||
        !Number.isFinite(policy?.heartbeatEveryMs) ||
        policy.heartbeatEveryMs <= 0 ||
        !Number.isFinite(policy?.unverifiableGraceMs) ||
        policy.unverifiableGraceMs <= 0 ||
        !Number.isFinite(policy?.staleAfterMs) ||
        policy.staleAfterMs <= 0 ||
        receipt.receiptDigest !== digestValue(payload)
    )
    {
        throw new Error('run-once lock lifecycle receipt integrity validation failed');
    }
    return true;
}

function reusableRunOnceState(state, { namespace, executionKey })
{
    if (state?.schema !== 'fsusblog.test-run-once.v3')
    {
        return false;
    }
    try
    {
        return validateRunOnceLockLifecycleReceipt(state.lockLifecycleReceipt, { namespace, executionKey });
    }
    catch
    {
        return false;
    }
}

export async function heartbeatRunOnceLock({
    ownerFile,
    ownerToken,
    ownerIdentity,
    heartbeatAt = new Date().toISOString()
})
{
    const heartbeatAtMs = Date.parse(heartbeatAt);
    const nowMs = Date.now();
    if (await exists(path.join(path.dirname(ownerFile), 'reclaim.json')))
    {
        return false;
    }
    const current = await readState(ownerFile);
    if (
        current?.ownerToken !== ownerToken ||
        !lockOwnerProcessIdentityMatches(current, ownerIdentity) ||
        processIdentityStatus(ownerIdentity).status !== 'live' ||
        !lockOwnerIsComplete(current, nowMs) ||
        !Number.isFinite(heartbeatAtMs) ||
        heartbeatAtMs < Date.parse(current.heartbeatAt) ||
        heartbeatAtMs < Date.parse(current.createdAt) ||
        heartbeatAtMs > nowMs
    )
    {
        return false;
    }
    if (await exists(path.join(path.dirname(ownerFile), 'reclaim.json')))
    {
        return false;
    }
    await writeLockOwner(ownerFile, { ...current, heartbeatAt });
    return true;
}

async function lockOwnerSnapshotDigest(ownerFile)
{
    try
    {
        return digestValue({ ownerBytes: await readFile(ownerFile, 'utf8') });
    }
    catch (error)
    {
        if (error?.code === 'ENOENT')
        {
            return digestValue({ ownerBytes: null });
        }
        throw error;
    }
}

function lockObservationReceipt(ownerSnapshotDigest, observedAt)
{
    const payload = {
        schema: lockObservationSchema,
        ownerSnapshotDigest,
        observedAt
    };
    return { ...payload, receiptDigest: digestValue(payload) };
}

function validLockObservation(receipt, ownerSnapshotDigest, nowMs)
{
    const payload = { ...receipt };
    delete payload.receiptDigest;
    const observedAtMs = Date.parse(receipt?.observedAt);
    return Boolean(
        receipt &&
            receipt.schema === lockObservationSchema &&
            receipt.ownerSnapshotDigest === ownerSnapshotDigest &&
            Number.isFinite(observedAtMs) &&
            observedAtMs <= nowMs &&
            receipt.receiptDigest === digestValue(payload)
    );
}

function isRunOnceLockLifecycleDirectory(name)
{
    return /^[a-f0-9]{64}\.lock(?:$|\.(?:release|reclaimed)-[a-z0-9-]+)$/u.test(name);
}

async function observeUnverifiableLock(lockDirectory, ownerFile, graceMs, nowMs)
{
    const observationFile = path.join(lockDirectory, 'owner-observation.json');
    const ownerSnapshotDigest = await lockOwnerSnapshotDigest(ownerFile);
    let observation = await readState(observationFile);
    if (!validLockObservation(observation, ownerSnapshotDigest, nowMs))
    {
        observation = lockObservationReceipt(ownerSnapshotDigest, new Date(nowMs).toISOString());
        try
        {
            await writeFile(observationFile, `${JSON.stringify(observation, null, 2)}\n`, {
                encoding: 'utf8',
                mode: 0o600,
                flag: 'wx'
            });
        }
        catch (error)
        {
            if (error?.code === 'ENOENT')
            {
                return { expired: false };
            }
            if (error?.code !== 'EEXIST')
            {
                throw error;
            }
            const concurrent = await readState(observationFile);
            if (!validLockObservation(concurrent, ownerSnapshotDigest, nowMs))
            {
                throw new Error('owner-unverifiable: lock observation receipt integrity validation failed', { cause: error });
            }
            observation = concurrent;
        }
    }
    return { expired: nowMs - Date.parse(observation.observedAt) > graceMs };
}

export async function reclaimStaleRunOnceLock(
    lockDirectory,
    staleAfterMs,
    { identityStatus = processIdentityStatus, beforeDelete = null, nowMs = Date.now() } = {}
)
{
    const ownerFile = path.join(lockDirectory, 'owner.json');
    const owner = await readState(ownerFile);
    if (!(await exists(lockDirectory)))
    {
        return true;
    }
    if (!lockOwnerIsComplete(owner, nowMs))
    {
        const observation = await observeUnverifiableLock(lockDirectory, ownerFile, staleAfterMs, nowMs);
        if (!observation.expired)
        {
            return false;
        }
        throw new Error(`owner-unverifiable after ${staleAfterMs}ms: owner metadata is incomplete`);
    }
    const ageMs = nowMs - Date.parse(owner.heartbeatAt);
    const ownerStatus = identityStatus(owner);
    if (ownerStatus.status === 'live')
    {
        return false;
    }
    if (ownerStatus.status === 'unverifiable')
    {
        if (ageMs <= owner.unverifiableGraceMs)
        {
            return false;
        }
        throw new Error(
            `owner-unverifiable after ${owner.unverifiableGraceMs}ms: ${ownerStatus.actual?.reason ?? 'identity unavailable'}`
        );
    }
    const ownerToken = owner?.ownerToken;
    const reclaimMarker = path.join(lockDirectory, 'reclaim.json');
    try
    {
        await writeFile(
            reclaimMarker,
            `${JSON.stringify({ ownerToken, processStartIdentity: owner.processStartIdentity })}\n`,
            {
                encoding: 'utf8',
                mode: 0o600,
                flag: 'wx'
            }
        );
    }
    catch (error)
    {
        if (error?.code === 'EEXIST' || error?.code === 'ENOENT')
        {
            return false;
        }
        throw error;
    }
    await beforeDelete?.({ ownerFile, owner });
    const confirmedOwner = await readState(ownerFile);
    if (!ownerToken || !lockOwnerExactMatches(owner, confirmedOwner))
    {
        await rm(reclaimMarker, { force: true });
        return false;
    }
    const tombstone = `${lockDirectory}.reclaimed-${ownerToken}-${randomUUID()}`;
    try
    {
        await rename(lockDirectory, tombstone);
    }
    catch (error)
    {
        if (error?.code === 'ENOENT')
        {
            return false;
        }
        throw error;
    }
    await rm(tombstone, { recursive: true, force: true });
    return true;
}

async function acquireLock(lockDirectory, timeoutMs, { staleAfterMs, heartbeatEveryMs, signal })
{
    const startedAt = Date.now();
    for (;;)
    {
        throwIfAborted(signal);
        const ownerToken = randomUUID();
        try
        {
            await mkdir(lockDirectory, { mode: 0o700 });
            const ownerFile = path.join(lockDirectory, 'owner.json');
            const identity = currentProcessIdentity();
            const owner = {
                ...lockOwnerPolicy(staleAfterMs, heartbeatEveryMs),
                ownerToken,
                pid: identity.pid,
                processStartIdentity: identity.processStartIdentity,
                executablePath: identity.executablePath,
                executableDigest: identity.executableDigest,
                commandDigest: identity.commandDigest,
                schedulerRunId: String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim() || null,
                namespace: path.basename(path.dirname(lockDirectory)),
                executionKey: path.basename(lockDirectory, '.lock'),
                createdAt: new Date().toISOString(),
                heartbeatAt: new Date().toISOString()
            };
            await writeLockOwner(ownerFile, owner);

            let stopped = false;
            let heartbeatInFlight = Promise.resolve();
            const heartbeat = () =>
            {
                heartbeatInFlight = heartbeatInFlight
                    .then(async () =>
                    {
                        if (stopped)
                        {
                            return;
                        }
                        await heartbeatRunOnceLock({ ownerFile, ownerToken, ownerIdentity: identity });
                    })
                    .catch(() =>
                    {});
            };
            const heartbeatTimer = setInterval(heartbeat, Math.max(1, heartbeatEveryMs));
            heartbeatTimer.unref();
            try
            {
                throwIfAborted(signal);
            }
            catch (error)
            {
                stopped = true;
                clearInterval(heartbeatTimer);
                await releaseOwnedLock(lockDirectory, owner);
                throw error;
            }
            return {
                ownerToken,
                lockLifecycleReceipt: createLockLifecycleReceipt(owner),
                async release()
                {
                    stopped = true;
                    clearInterval(heartbeatTimer);
                    await heartbeatInFlight;
                    await releaseOwnedLock(lockDirectory, owner);
                }
            };
        }
        catch (error)
        {
            if (error?.code !== 'EEXIST')
            {
                throw error;
            }

            if (await reclaimStaleRunOnceLock(lockDirectory, staleAfterMs))
            {
                continue;
            }

            if (Date.now() - startedAt >= timeoutMs)
            {
                throw new Error(`timed out waiting for run-once lock: ${lockDirectory}`, { cause: error });
            }
            await sleep(100, signal);
        }
    }
}

/**
 * Optional reusable-state verifier contract (injectable; run-once stays pure).
 *
 * verifyReusableState(state, context) -> {
 *   reusable: boolean,
 *   observationDigest?: string | null,
 *   reasonCode?: string | null,
 *   detail?: unknown
 * }
 *
 * When reusable is false, run-once records the reason and re-executes the producer.
 * When the verifier throws, run-once fails closed (never treats the fault as a
 * silent cache miss). Ordinary build/test callers omit the verifier and keep
 * fingerprint + required-output digest reuse only.
 */
async function evaluateReusableState(state, {
    namespace,
    executionKey,
    fingerprint,
    requiredOutputs,
    verifyReusableState
})
{
    if (
        !reusableRunOnceState(state, { namespace, executionKey }) ||
        state?.status !== 'success' ||
        state?.fingerprint !== fingerprint ||
        !(await outputsMatchState(requiredOutputs, state.requiredOutputStates))
    )
    {
        return {
            reusable: false,
            reasonCode: 'run-once.base-mismatch',
            observationDigest: null,
            detail: null
        };
    }

    if (typeof verifyReusableState !== 'function')
    {
        return {
            reusable: true,
            reasonCode: 'run-once.output-match',
            observationDigest: null,
            detail: null
        };
    }

    let verdict;
    try
    {
        verdict = await verifyReusableState(state, {
            namespace,
            executionKey,
            fingerprint,
            requiredOutputs,
            requiredOutputStates: state.requiredOutputStates
        });
    }
    catch (error)
    {
        // Fail closed: verifier faults are not cache misses.
        const fault = error instanceof Error ? error : new Error(String(error));
        if (!fault.reasonCode)
        {
            fault.reasonCode = 'run-once.verifier-fault';
        }
        fault.runOnceStateFile = state?.key ?? executionKey;
        throw fault;
    }

    if (!verdict || typeof verdict !== 'object' || typeof verdict.reusable !== 'boolean')
    {
        const fault = new Error('verifyReusableState must return { reusable: boolean, reasonCode?, observationDigest? }');
        fault.reasonCode = 'run-once.verifier-fault';
        throw fault;
    }

    return {
        reusable: verdict.reusable === true,
        reasonCode: verdict.reasonCode == null ? null : String(verdict.reasonCode),
        observationDigest: verdict.observationDigest == null ? null : String(verdict.observationDigest),
        detail: verdict.detail ?? null
    };
}

export async function runOnce(
    {
        root = defaultStateRoot,
        namespace = process.env.FSUSBLOG_TEST_NAMESPACE || 'local',
        key,
        fingerprint,
        requiredOutputs = [],
        lockTimeoutMs = defaultLockTimeoutMs,
        staleLockMs = defaultStaleLockMs,
        heartbeatMs = defaultHeartbeatMs,
        verifyReusableState = null,
        buildSuccessState = null
    },
    operation
)
{
    if (!String(key ?? '').trim())
    {
        throw new Error('run-once key is required');
    }
    if (!String(fingerprint ?? '').trim())
    {
        throw new Error('run-once fingerprint is required');
    }
    if (typeof operation !== 'function')
    {
        throw new Error('run-once operation must be a function');
    }
    if (verifyReusableState != null && typeof verifyReusableState !== 'function')
    {
        throw new Error('run-once verifyReusableState must be a function when provided');
    }
    if (buildSuccessState != null && typeof buildSuccessState !== 'function')
    {
        throw new Error('run-once buildSuccessState must be a function when provided');
    }

    const namespaceDirectory = path.join(root, sanitizeSegment(namespace, 'local'));
    const normalizedNamespace = sanitizeSegment(namespace, 'local');
    const normalizedKey = sanitizeSegment(key, 'operation');
    const stateFile = path.join(namespaceDirectory, `${normalizedKey}.json`);
    const lockDirectory = path.join(namespaceDirectory, `${normalizedKey}.lock`);
    const normalizedOutputs = requiredOutputs.map((output) => path.resolve(output)).sort();
    await mkdir(namespaceDirectory, { recursive: true });

    const reuseContextBase = {
        namespace: normalizedNamespace,
        executionKey: normalizedKey,
        fingerprint,
        requiredOutputs: normalizedOutputs,
        verifyReusableState
    };

    const current = await readState(stateFile);
    const currentReuse = await evaluateReusableState(current, reuseContextBase);
    if (currentReuse.reusable)
    {
        return {
            status: 'shared-current-run',
            stateFile,
            reuse: {
                reasonCode: currentReuse.reasonCode,
                observationDigest: currentReuse.observationDigest,
                detail: currentReuse.detail
            }
        };
    }

    const lock = await acquireLock(lockDirectory, lockTimeoutMs, {
        staleAfterMs: Math.max(1, Number(staleLockMs) || defaultStaleLockMs),
        heartbeatEveryMs: Math.max(1, Number(heartbeatMs) || defaultHeartbeatMs)
    });
    try
    {
        const lockedCurrent = await readState(stateFile);
        const lockedReuse = await evaluateReusableState(lockedCurrent, reuseContextBase);
        if (lockedReuse.reusable)
        {
            return {
                status: 'shared-current-run',
                stateFile,
                reuse: {
                    reasonCode: lockedReuse.reasonCode,
                    observationDigest: lockedReuse.observationDigest,
                    detail: lockedReuse.detail
                }
            };
        }

        const reuseRejection = lockedCurrent || current
            ? {
                reasonCode: lockedReuse.reasonCode ?? currentReuse.reasonCode,
                observationDigest: lockedReuse.observationDigest ?? currentReuse.observationDigest,
                detail: lockedReuse.detail ?? currentReuse.detail
            }
            : null;

        await operation();
        const requiredOutputStates = await captureOutputStates(normalizedOutputs);
        if (requiredOutputStates == null)
        {
            throw new Error(`run-once command succeeded without required outputs: ${normalizedOutputs.join(', ')}`);
        }

        let nextState = {
            schema: 'fsusblog.test-run-once.v3',
            namespace: normalizedNamespace,
            key: normalizedKey,
            fingerprint,
            status: 'success',
            requiredOutputs: normalizedOutputs,
            requiredOutputStates,
            lockLifecycleReceipt: lock.lockLifecycleReceipt,
            completedAt: new Date().toISOString()
        };
        if (typeof buildSuccessState === 'function')
        {
            const enrichment = await buildSuccessState({
                state: nextState,
                requiredOutputs: normalizedOutputs,
                requiredOutputStates,
                reuseRejection
            });
            if (enrichment && typeof enrichment === 'object')
            {
                nextState = { ...nextState, ...enrichment, schema: 'fsusblog.test-run-once.v3' };
            }
        }
        if (reuseRejection)
        {
            nextState = {
                ...nextState,
                lastReuseRejection: {
                    reasonCode: reuseRejection.reasonCode,
                    observationDigest: reuseRejection.observationDigest,
                    rejectedAt: new Date().toISOString()
                }
            };
        }
        const temporaryState = `${stateFile}.${process.pid}.tmp`;
        await writeFile(temporaryState, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
        await rename(temporaryState, stateFile);
        return {
            status: 'executed',
            stateFile,
            reuseRejection
        };
    }
    finally
    {
        await lock.release();
    }
}

function receiptPayload(receipt)
{
    const payload = { ...receipt };
    delete payload.receiptDigest;
    return payload;
}

function receiptContract(receipt)
{
    return {
        schedulerRunId: receipt.schedulerRunId,
        executionKey: receipt.executionKey,
        command: receipt.command,
        cwd: receipt.cwd,
        inputDigest: receipt.inputDigest,
        environmentDigest: receipt.environmentDigest,
        outputContract: receipt.outputContract,
        requiredOutputs: receipt.requiredOutputs,
        testIds: normalizeTestIds(receipt.testIds),
        commit: receipt.commit,
        worktreeFingerprint: receipt.worktreeFingerprint,
        executionEnvelopeDigest: receipt.executionEnvelopeDigest ?? null
    };
}

function validateReceiptIntegrity(receipt, { contractDigest, runId })
{
    if (receipt?.schema !== runBoundSchema
      || receipt.schedulerRunId !== runId
      || receipt.contractDigest !== contractDigest
      || digestValue(receiptContract(receipt)) !== contractDigest
      || receipt.receiptDigest !== digestValue(receiptPayload(receipt)))
    {
        throw new Error('run-bound receipt integrity validation failed');
    }
}

function normalizedRepositoryPath(file, root = repoRoot)
{
    return path.relative(path.resolve(root), path.resolve(file)).replaceAll(path.sep, '/');
}

function isWithin(parent, child)
{
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readRegularBoundJson(file, expectedDirectory, label)
{
    const resolvedFile = path.resolve(file);
    const resolvedDirectory = path.resolve(expectedDirectory);
    if (!isWithin(resolvedDirectory, resolvedFile))
    {
        throw new Error(`${label} path is outside its run-bound directory`);
    }
    const metadata = await lstat(resolvedFile);
    if (!metadata.isFile() || metadata.isSymbolicLink())
    {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    const [realDirectory, realFile] = await Promise.all([
        realpath(resolvedDirectory),
        realpath(resolvedFile)
    ]);
    if (!isWithin(realDirectory, realFile))
    {
        throw new Error(`${label} resolves outside its run-bound directory`);
    }
    const bytes = await readFile(realFile);
    let document;
    try
    {
        document = JSON.parse(bytes.toString('utf8'));
    }
    catch
    {
        throw new Error(`${label} is not valid JSON`);
    }
    return { file: realFile, bytes, document };
}

function validateProjectionReceiptBinding({ projection, receipt, runId, normalizedKey, consumerId })
{
    validateReceiptIntegrity(receipt, { contractDigest: receipt?.contractDigest, runId });
    if (receipt.status !== 'success'
      || receipt.executionKey !== normalizedKey
      || projection?.schema !== 'fsusblog.physical-execution-projection.v1'
      || projection.schedulerRunId !== runId
      || projection.executionKey !== normalizedKey
      || projection.consumerId !== consumerId
      || !['producer', 'consumer'].includes(projection.disposition)
      || projection.status !== 'success'
      || projection.physicalExecutionReceiptDigest !== receipt.receiptDigest
      || projection.executionEnvelopeDigest !== (receipt.executionEnvelopeDigest ?? null)
      || JSON.stringify(normalizeTestIds(projection.testIds)) !== JSON.stringify(normalizeTestIds(receipt.testIds))
      || JSON.stringify(canonicalize(projection.artifactEvidence)) !== JSON.stringify(canonicalize(receipt.requiredOutputStates)))
    {
        throw new Error('run-bound projection and receipt binding validation failed');
    }
}

export async function validateRunBoundProjection({
    root = defaultPhysicalExecutionRoot,
    runId,
    key,
    consumerId,
    projectionFile,
    receiptFile,
    verifyOutputs = true
})
{
    const normalizedRunId = sanitizeSegment(runId, 'run');
    const normalizedKey = sanitizeSegment(key, 'execution');
    const runDirectory = path.join(root, normalizedRunId);
    const projectionDirectory = path.join(runDirectory, 'projections');
    const receiptDirectory = path.join(runDirectory, 'receipts', normalizedKey);
    const projectionEntry = await readRegularBoundJson(projectionFile, projectionDirectory, 'run-bound projection');
    const receiptEntry = await readRegularBoundJson(receiptFile, receiptDirectory, 'run-bound receipt');
    const expectedReceiptPath = normalizedRepositoryPath(
        receiptEntry.file,
        receiptEntry.document.cwd
    );

    if (projectionEntry.document.physicalExecutionReceipt !== expectedReceiptPath
      || path.basename(receiptEntry.file) !== `${receiptEntry.document.contractDigest}.json`)
    {
        throw new Error('run-bound projection receipt path validation failed');
    }
    validateProjectionReceiptBinding({
        projection: projectionEntry.document,
        receipt: receiptEntry.document,
        runId,
        normalizedKey,
        consumerId
    });
    if (verifyOutputs
      && !await outputsMatchState(receiptEntry.document.requiredOutputs, receiptEntry.document.requiredOutputStates))
    {
        throw new Error('run-bound projection output validation failed');
    }
    return {
        projectionFile: projectionEntry.file,
        projectionBytes: projectionEntry.bytes,
        projection: projectionEntry.document,
        receiptFile: receiptEntry.file,
        receiptBytes: receiptEntry.bytes,
        receipt: receiptEntry.document
    };
}

function consumerEvidencePayload(document)
{
    const payload = { ...document };
    delete payload.evidenceDigest;
    return payload;
}

export function validateRunBoundConsumerEvidence(document, { runId, key, consumerId } = {})
{
    const normalizedKey = sanitizeSegment(key ?? document?.executionKey, 'execution');
    if (document?.schema !== 'fsusblog.physical-execution-consumer-evidence.v2'
      || document.schedulerRunId !== (runId ?? document.schedulerRunId)
      || document.executionKey !== normalizedKey
      || document.consumerId !== (consumerId ?? document.consumerId)
      || document.status !== 'success'
      || !/^sha256:[a-f0-9]{64}$/u.test(document.sourceProjectionDigest ?? '')
      || document.sourceProjectionDocumentDigest !== digestValue(document.sourceProjectionDocument)
      || document.physicalExecutionReceiptDigest !== document.physicalExecutionReceiptDocument?.receiptDigest
      || document.evidenceDigest !== digestValue(consumerEvidencePayload(document)))
    {
        throw new Error('run-bound consumer evidence integrity validation failed');
    }
    if (document.physicalExecutionReceiptDocument.executionEnvelopeDigest != null
      && (document.executionEnvelopeDigest
          !== document.physicalExecutionReceiptDocument.executionEnvelopeDigest
        || !/^sha256:[a-f0-9]{64}$/u.test(document.executionEnvelopeReceiptDigest ?? '')
        || typeof document.executionEnvelopeReceipt !== 'string'
        || !document.executionEnvelopeReceipt))
    {
        throw new Error('run-bound consumer execution envelope binding validation failed');
    }
    validateProjectionReceiptBinding({
        projection: document.sourceProjectionDocument,
        receipt: document.physicalExecutionReceiptDocument,
        runId: document.schedulerRunId,
        normalizedKey,
        consumerId: document.consumerId
    });
    if (document.sourceProjectionDocument.physicalExecutionReceipt !== document.physicalExecutionReceipt
      || document.sourceProjectionDocumentDigest !== digestValue(document.sourceProjectionDocument)
      || document.projectedAt !== document.sourceProjectionDocument.projectedAt
      || JSON.stringify(normalizeTestIds(document.testIds)) !== JSON.stringify(normalizeTestIds(document.sourceProjectionDocument.testIds))
      || JSON.stringify(canonicalize(document.artifactEvidence)) !== JSON.stringify(canonicalize(document.sourceProjectionDocument.artifactEvidence)))
    {
        throw new Error('run-bound consumer evidence projection validation failed');
    }
    return true;
}

export function buildRunBoundConsumerEvidence({
    validatedProjection,
    executionEnvelopeBinding = null
})
{
    const { projection, projectionBytes, receipt, projectionFile, receiptFile } = validatedProjection;
    const payload = {
        schema: 'fsusblog.physical-execution-consumer-evidence.v2',
        schedulerRunId: projection.schedulerRunId,
        executionKey: projection.executionKey,
        consumerId: projection.consumerId,
        status: projection.status,
        testIds: projection.testIds,
        artifactEvidence: projection.artifactEvidence,
        physicalExecutionReceipt: normalizedRepositoryPath(receiptFile, receipt.cwd),
        physicalExecutionReceiptDigest: receipt.receiptDigest,
        physicalExecutionReceiptDocument: receipt,
        executionEnvelopeDigest: receipt.executionEnvelopeDigest ?? null,
        executionEnvelopeReceipt: executionEnvelopeBinding?.receiptFile ?? null,
        executionEnvelopeReceiptDigest: executionEnvelopeBinding?.receiptDigest ?? null,
        sourceProjection: normalizedRepositoryPath(projectionFile, receipt.cwd),
        sourceProjectionDigest: `sha256:${createHash('sha256').update(projectionBytes).digest('hex')}`,
        sourceProjectionDocumentDigest: digestValue(projection),
        sourceProjectionDocument: projection,
        projectedAt: projection.projectedAt
    };
    if (receipt.executionEnvelopeDigest != null
      && (executionEnvelopeBinding?.envelopeDigest !== receipt.executionEnvelopeDigest
        || !executionEnvelopeBinding?.receiptDigest
        || !executionEnvelopeBinding?.receiptFile))
    {
        throw new Error('run-bound consumer execution envelope binding is missing');
    }
    const document = { ...payload, evidenceDigest: digestValue(payload) };
    validateRunBoundConsumerEvidence(document);
    return document;
}

function receiptFailure(receipt)
{
    const error = new Error(receipt.failure?.message || `run-bound producer ${receipt.status}`);
    error.name = receipt.failure?.name || 'RunBoundProducerError';
    error.exitCode = receipt.failure?.exitCode ?? null;
    error.signal = receipt.failure?.signal ?? null;
    error.receiptStatus = receipt.status;
    return error;
}

async function summarizeRunBoundExecutions(root, runId, {
    lockTimeoutMs = defaultLockTimeoutMs,
    staleLockMs = defaultStaleLockMs,
    heartbeatMs = defaultHeartbeatMs,
    signal
} = {})
{
    const runDirectory = path.join(root, sanitizeSegment(runId, 'run'));
    const summaryLock = await acquireLock(path.join(runDirectory, '.summary.lock'), lockTimeoutMs, {
        staleAfterMs: Math.max(1, Number(staleLockMs) || defaultStaleLockMs),
        heartbeatEveryMs: Math.max(1, Number(heartbeatMs) || defaultHeartbeatMs),
        signal
    });
    try
    {
        const receiptRoot = path.join(runDirectory, 'receipts');
        const projectionRoot = path.join(runDirectory, 'projections');
        const readJsonFiles = async (directory) =>
        {
            if (!await exists(directory))
            {
                return [];
            }
            const files = [];
            const visit = async (current) =>
            {
                for (const entry of await readdir(current, { withFileTypes: true }))
                {
                    const child = path.join(current, entry.name);
                    if (entry.isDirectory() && !isRunOnceLockLifecycleDirectory(entry.name))
                    {
                        await visit(child);
                    }
                    else if (entry.isFile() && entry.name.endsWith('.json'))
                    {
                        files.push(child);
                    }
                }
            };
            await visit(directory);
            return await Promise.all(files.sort().map(async (file) => ({
                file,
                document: await readState(file),
                bytes: (await stat(file)).size
            })));
        };
        const [receipts, projections] = await Promise.all([
            readJsonFiles(receiptRoot),
            readJsonFiles(projectionRoot)
        ]);
        const validReceipts = receipts.filter(
            (entry) => entry.document?.schema === runBoundSchema
        );
        const validProjections = projections
            .map((entry) => entry.document)
            .filter((document) =>
                document?.schema === 'fsusblog.physical-execution-projection.v1');
        const summary = {
            schema: 'fsusblog.physical-execution-summary.v1',
            schedulerRunId: runId,
            physicalExecutions: validReceipts.length,
            logicalConsumers: validProjections.length,
            dedupHits: validProjections.filter((entry) => entry.disposition === 'consumer').length,
            avoidedChildStartups: validProjections.reduce((total, entry) => total + Number(entry.avoidedChildStartups ?? 0), 0),
            totalConsumerWaitMs: validProjections.reduce((total, entry) => total + Number(entry.waitedMs ?? 0), 0),
            receiptBytes: validReceipts.reduce((total, entry) => total + entry.bytes, 0),
            producers: validReceipts.map((entry) => ({
                key: entry.document?.executionKey,
                status: entry.document?.status,
                receipt: normalizedRepositoryPath(entry.file, entry.document?.cwd)
            })),
            consumers: validProjections.map((entry) => ({
                consumerId: entry.consumerId,
                key: entry.executionKey,
                disposition: entry.disposition,
                waitedMs: entry.waitedMs,
                physicalExecutionReceipt: entry.physicalExecutionReceipt
            })),
            generatedAt: new Date().toISOString()
        };
        await writeJsonAtomic(path.join(runDirectory, 'summary.json'), summary);
        return summary;
    }
    finally
    {
        await summaryLock.release();
    }
}

async function writeRunBoundProjection({
    root,
    runId,
    receiptFile,
    receipt,
    consumerId,
    testIds,
    disposition,
    waitedMs,
    lockTimeoutMs,
    staleLockMs,
    heartbeatMs,
    signal
})
{
    validateReceiptIntegrity(receipt, { contractDigest: receipt.contractDigest, runId });
    if (receipt.status === 'success'
      && !await outputsMatchState(receipt.requiredOutputs, receipt.requiredOutputStates))
    {
        throw new Error('run-bound receipt output projection failed closed');
    }
    const normalizedTestIds = normalizeTestIds(testIds);
    const receiptTestIds = normalizeTestIds(receipt.testIds);
    if (normalizedTestIds.length !== receiptTestIds.length
      || normalizedTestIds.some((testId, index) => testId !== receiptTestIds[index]))
    {
        throw new Error('run-bound receipt test ID projection failed closed');
    }
    const projection = {
        schema: 'fsusblog.physical-execution-projection.v1',
        schedulerRunId: runId,
        executionKey: receipt.executionKey,
        consumerId,
        disposition,
        avoidedChildStartups: disposition === 'consumer' ? 1 : 0,
        waitedMs,
        status: receipt.status,
        testIds: normalizedTestIds,
        artifactEvidence: receipt.requiredOutputStates,
        physicalExecutionReceipt: normalizedRepositoryPath(receiptFile, receipt.cwd),
        physicalExecutionReceiptDigest: receipt.receiptDigest,
        executionEnvelopeDigest: receipt.executionEnvelopeDigest ?? null,
        projectedAt: new Date().toISOString()
    };
    const projectionDirectory = path.join(root, sanitizeSegment(runId, 'run'), 'projections');
    const projectionFile = path.join(
        projectionDirectory,
        `${sanitizeSegment(consumerId, 'consumer')}-${sanitizeSegment(receipt.executionKey, 'execution')}-${randomUUID()}.json`
    );
    await writeJsonAtomic(projectionFile, projection);
    await summarizeRunBoundExecutions(root, runId, { lockTimeoutMs, staleLockMs, heartbeatMs, signal });
    return projectionFile;
}

export async function runBoundExecution({
    root = defaultPhysicalExecutionRoot,
    runId,
    key,
    command,
    cwd,
    inputDigest,
    environmentDigest,
    outputContract = [],
    requiredOutputs = [],
    commit,
    worktreeFingerprint,
    executionEnvelopeDigest = null,
    testIds = [],
    consumerId = 'consumer',
    lockTimeoutMs = defaultLockTimeoutMs,
    staleLockMs = defaultStaleLockMs,
    heartbeatMs = defaultHeartbeatMs,
    signal
}, operation)
{
    for (const [name, value] of Object.entries({ runId, key, inputDigest, environmentDigest, commit, worktreeFingerprint }))
    {
        if (!String(value ?? '').trim())
        {
            throw new Error(`run-bound ${name} is required`);
        }
    }
    if (executionEnvelopeDigest != null
      && !/^sha256:[a-f0-9]{64}$/u.test(executionEnvelopeDigest))
    {
        throw new Error('run-bound executionEnvelopeDigest must be a SHA-256 digest');
    }
    if (!Array.isArray(command) || command.length === 0)
    {
        throw new Error('run-bound normalized command is required');
    }
    if (typeof operation !== 'function')
    {
        throw new Error('run-bound operation must be a function');
    }

    const normalizedRunId = sanitizeSegment(runId, 'run');
    const normalizedKey = sanitizeSegment(key, 'execution');
    const normalizedCwd = path.resolve(cwd ?? repoRoot);
    const normalizedOutputs = requiredOutputs.map((output) => path.resolve(normalizedCwd, output)).sort();
    const normalizedTestIds = normalizeTestIds(testIds);
    const contract = {
        schedulerRunId: runId,
        executionKey: normalizedKey,
        command: command.map(String),
        cwd: normalizedCwd,
        inputDigest,
        environmentDigest,
        outputContract: [...outputContract].map(String).sort(),
        requiredOutputs: normalizedOutputs,
        testIds: normalizedTestIds,
        commit,
        worktreeFingerprint,
        executionEnvelopeDigest
    };
    const contractDigest = digestValue(contract);
    const receiptDirectory = path.join(root, normalizedRunId, 'receipts', normalizedKey);
    const receiptFile = path.join(receiptDirectory, `${contractDigest}.json`);
    const lockDirectory = path.join(receiptDirectory, `${contractDigest}.lock`);
    await mkdir(receiptDirectory, { recursive: true });
    const requestedAt = Date.now();

    const consume = async (receipt, disposition, waitedMs = Date.now() - requestedAt) =>
    {
        validateReceiptIntegrity(receipt, { contractDigest, runId });
        const projectionFile = await writeRunBoundProjection({
            root,
            runId,
            receiptFile,
            receipt,
            consumerId,
            testIds,
            disposition,
            waitedMs,
            lockTimeoutMs,
            staleLockMs,
            heartbeatMs,
            signal
        });
        if (receipt.status !== 'success')
        {
            throw receiptFailure(receipt);
        }
        return { status: disposition === 'consumer' ? 'shared-current-run' : 'executed', receiptFile, projectionFile };
    };

    const current = await readState(receiptFile);
    if (current)
    {
        return await consume(current, 'consumer');
    }

    const lock = await acquireLock(lockDirectory, lockTimeoutMs, {
        staleAfterMs: Math.max(1, Number(staleLockMs) || defaultStaleLockMs),
        heartbeatEveryMs: Math.max(1, Number(heartbeatMs) || defaultHeartbeatMs),
        signal
    });
    try
    {
        const lockedCurrent = await readState(receiptFile);
        if (lockedCurrent)
        {
            return await consume(lockedCurrent, 'consumer');
        }

        const producerWaitMs = Date.now() - requestedAt;
        const startedAt = new Date().toISOString();
        const startedAtMs = Date.now();
        let status = 'success';
        let failure = null;
        let physicalExecution = null;
        try
        {
            physicalExecution = await operation();
        }
        catch (error)
        {
            physicalExecution = error?.physicalExecution ?? null;
            status = error?.name === 'AbortError' || error?.signal ? 'cancelled' : 'failure';
            failure = {
                name: error?.name ?? 'Error',
                message: error instanceof Error ? error.message : String(error),
                exitCode: error?.exitCode ?? null,
                signal: error?.signal ?? null
            };
        }
        const requiredOutputStates = await captureOutputStates(normalizedOutputs);
        if (status === 'success' && requiredOutputStates == null)
        {
            status = 'failure';
            failure = {
                name: 'MissingRequiredOutputError',
                message: `run-bound command succeeded without required outputs: ${normalizedOutputs.join(', ')}`,
                exitCode: null,
                signal: null
            };
        }
        const payload = {
            schema: runBoundSchema,
            ...contract,
            contractDigest,
            status,
            producer: {
                consumerId,
                pid: process.pid
            },
            requiredOutputStates: requiredOutputStates ?? [],
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAtMs,
            physicalExecution,
            failure
        };
        const receipt = { ...payload, receiptDigest: digestValue(payload) };
        await writeJsonAtomic(receiptFile, receipt);
        return await consume(receipt, 'producer', producerWaitMs);
    }
    finally
    {
        await lock.release();
    }
}

async function collectFiles(input, files)
{
    const metadata = await stat(input);
    if (metadata.isFile())
    {
        files.push(input);
        return;
    }
    if (!metadata.isDirectory())
    {
        return;
    }

    const entries = await readdir(input, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name)))
    {
        if (entry.isDirectory() && new Set(['.git', '.tmp', 'bin', 'coverage', 'dist', 'node_modules', 'obj', 'test-results']).has(entry.name))
        {
            continue;
        }
        await collectFiles(path.join(input, entry.name), files);
    }
}

export async function fingerprintPaths(inputs, {
    root = repoRoot,
    values = [],
    secretEnvironmentNames = [],
    env = process.env
} = {})
{
    const files = [];
    for (const input of inputs ?? [])
    {
        const absolutePath = path.resolve(root, input);
        if (!await exists(absolutePath))
        {
            throw new Error(`fingerprint input does not exist: ${input}`);
        }
        await collectFiles(absolutePath, files);
    }

    const hash = createHash('sha256');
    for (const value of values)
    {
        hash.update('value\0');
        hash.update(String(value));
        hash.update('\0');
    }
    for (const name of [...new Set(secretEnvironmentNames)].sort())
    {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
        {
            throw new Error(`invalid secret environment name: ${name}`);
        }
        const secretDigest = createHash('sha256').update(String(env[name] ?? '')).digest('hex');
        hash.update('secret-env\0');
        hash.update(name);
        hash.update('\0');
        hash.update(secretDigest);
        hash.update('\0');
    }
    for (const file of files.sort())
    {
        hash.update(path.relative(root, file).replaceAll(path.sep, '/'));
        hash.update('\0');
        hash.update(await readFile(file));
        hash.update('\0');
    }
    return hash.digest('hex');
}

function parseOptions(argv)
{
    const options = { paths: [], values: [], secretEnvs: [], requiredOutputs: [] };
    let commandIndex = -1;
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--')
        {
            commandIndex = index + 1;
            break;
        }
        const name = argument.replace(/^--/u, '');
        const value = argv[index + 1];
        if (!argument.startsWith('--') || value == null)
        {
            throw new Error(`invalid run-once option: ${argument}`);
        }
        index += 1;
        if (name === 'path')
        {
            options.paths.push(value);
        }
        else if (name === 'value')
        {
            options.values.push(value);
        }
        else if (name === 'secret-env')
        {
            options.secretEnvs.push(value);
        }
        else if (name === 'require-output')
        {
            options.requiredOutputs.push(value);
        }
        else
        {
            options[name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
        }
    }
    return {
        options,
        command: commandIndex >= 0 ? argv.slice(commandIndex) : []
    };
}

async function spawnCommand(command, { cwd })
{
    await new Promise((resolve, reject) =>
    {
        const child = spawn(command[0], command.slice(1), {
            cwd,
            env: process.env,
            stdio: 'inherit'
        });
        child.on('error', reject);
        child.on('exit', (code, signal) =>
        {
            if (code === 0)
            {
                resolve();
            }
            else
            {
                reject(new Error(`command failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${command.join(' ')}`));
            }
        });
    });
}

async function main(argv)
{
    const action = argv[0];
    const { options, command } = parseOptions(argv.slice(1));
    if (action === 'fingerprint')
    {
        console.log(await fingerprintPaths(options.paths, {
            root: options.root ? path.resolve(options.root) : repoRoot,
            values: options.values,
            secretEnvironmentNames: options.secretEnvs,
            env: process.env
        }));
        return;
    }
    if (action !== 'run')
    {
        throw new Error('usage: run-once.mjs <fingerprint|run> [options]');
    }
    if (command.length === 0)
    {
        throw new Error('run-once run requires a command after --');
    }

    const cwd = options.cwd ? path.resolve(options.cwd) : repoRoot;
    const result = await runOnce({
        root: options.root ? path.resolve(options.root) : defaultStateRoot,
        namespace: options.namespace,
        key: options.key,
        fingerprint: options.fingerprint,
        requiredOutputs: options.requiredOutputs.map((output) => path.resolve(cwd, output)),
        lockTimeoutMs: Number(options.lockTimeoutMs ?? defaultLockTimeoutMs),
        staleLockMs: Number(options.staleLockMs ?? defaultStaleLockMs),
        heartbeatMs: Number(options.heartbeatMs ?? defaultHeartbeatMs)
    }, async () => spawnCommand(command, { cwd }));
    console.log(`[run-once] ${result.status} key=${options.key} state=${result.stateFile}`);
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain)
{
    main(process.argv.slice(2)).catch((error) =>
    {
        console.error(`[run-once] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
