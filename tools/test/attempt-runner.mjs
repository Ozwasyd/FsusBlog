import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    aggregateAttemptReceiptSchema,
    attemptReceiptSchema,
    classifyAggregate,
    digestCanonical,
    readRetryPolicyRegistry,
    retryPolicyById,
    sealContentDigest,
    sha256,
    validateAggregateAttemptReceipt,
    validateAttemptReceipt,
    validateExternalAuthorityReferences,
    verifyFileDigest
} from './attempt-provenance.mjs';

export const attemptResultSchema = 'fsusblog.test-attempt-result.v1';

function requiredText(value, label)
{
    if (typeof value !== 'string' || !value.trim())
    {
        throw new Error(`${label} is required`);
    }
    return value.trim();
}

function safeSegment(value, label)
{
    const normalized = requiredText(value, label);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u.test(normalized)
        || normalized === '.' || normalized === '..')
    {
        throw new Error(`${label} is not a safe run-owned path segment`);
    }
    return normalized;
}

function sortedUnique(values)
{
    return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))].sort();
}

function createOwnedDirectory(directory, label)
{
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
    {
        throw new Error(`${label} must be a real run-owned directory`);
    }
}

function writeExclusive(file, value, mode = 0o444)
{
    const descriptor = fs.openSync(file, 'wx', mode);
    try
    {
        fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    fs.chmodSync(file, mode);
}

function readStructuredResult(file)
{
    if (!fs.existsSync(file))
    {
        return null;
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error('attempt result sidecar must be a regular file');
    }
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    const allowed = [
        'schema',
        'failureClass',
        'failureKind',
        'executedTestIds',
        'failedTestIds',
        'artifactPaths'
    ];
    if (result?.schema !== attemptResultSchema
        || Object.keys(result).some((key) => !allowed.includes(key)))
    {
        throw new Error(`attempt result sidecar schema must be ${attemptResultSchema}`);
    }
    return {
        failureClass: result.failureClass === null ? null : requiredText(result.failureClass, 'failureClass'),
        failureKind: result.failureKind === null ? null : requiredText(result.failureKind, 'failureKind'),
        executedTestIds: sortedUnique(result.executedTestIds),
        failedTestIds: sortedUnique(result.failedTestIds),
        artifactPaths: sortedUnique(result.artifactPaths)
    };
}

function signalProcessGroup(child, signal)
{
    if (!child.pid)
    {
        return;
    }
    if (process.platform === 'win32')
    {
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true
        });
        return;
    }
    try
    {
        process.kill(-child.pid, signal);
    }
    catch (error)
    {
        if (error.code !== 'ESRCH')
        {
            child.kill(signal);
        }
    }
}

function executeChild({ command, cwd, env, stdoutFile, stderrFile, timeoutMs, signal })
{
    return new Promise((resolve) =>
    {
        const stdout = fs.openSync(stdoutFile, 'wx', 0o600);
        const stderr = fs.openSync(stderrFile, 'wx', 0o600);
        let child;
        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let timer = null;
        const finish = (result) =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            if (timer)
            {
                clearTimeout(timer);
            }
            signal?.removeEventListener('abort', cancel);
            fs.closeSync(stdout);
            fs.closeSync(stderr);
            fs.chmodSync(stdoutFile, 0o444);
            fs.chmodSync(stderrFile, 0o444);
            resolve({ ...result, timedOut, cancelled });
        };
        const cancel = () =>
        {
            cancelled = true;
            signalProcessGroup(child, 'SIGKILL');
        };
        try
        {
            child = spawn(command[0], command.slice(1), {
                cwd,
                env,
                stdio: ['ignore', stdout, stderr],
                detached: process.platform !== 'win32',
                windowsHide: true
            });
        }
        catch (error)
        {
            finish({ code: null, signal: null, spawnError: error });
            return;
        }
        child.once('error', (error) => finish({ code: null, signal: null, spawnError: error }));
        child.once('exit', (code, exitSignal) => finish({ code, signal: exitSignal, spawnError: null }));
        if (Number.isFinite(timeoutMs) && timeoutMs > 0)
        {
            timer = setTimeout(() =>
            {
                timedOut = true;
                signalProcessGroup(child, 'SIGKILL');
            }, timeoutMs);
            timer.unref?.();
        }
        if (signal?.aborted)
        {
            cancel();
        }
        else
        {
            signal?.addEventListener('abort', cancel, { once: true });
        }
    });
}

function failureIdentity(outcome, structuredResult, resultError, requiresTestResult)
{
    if (resultError)
    {
        return { failureClass: 'runner', failureKind: 'runner-crash' };
    }
    if (outcome.cancelled)
    {
        return { failureClass: 'runner', failureKind: 'runner-cancelled' };
    }
    if (outcome.timedOut)
    {
        return { failureClass: 'runner', failureKind: 'runner-timeout' };
    }
    if (outcome.spawnError)
    {
        return { failureClass: 'runner', failureKind: 'command-spawn-error' };
    }
    if (outcome.signal)
    {
        return { failureClass: 'runner', failureKind: 'command-signal' };
    }
    if (outcome.code !== 0)
    {
        return structuredResult?.failureClass && structuredResult?.failureKind
            ? {
                failureClass: structuredResult.failureClass,
                failureKind: structuredResult.failureKind
            }
            : { failureClass: 'product', failureKind: 'command-exit-nonzero' };
    }
    if (structuredResult === null)
    {
        // Process-only commands observe no framework test IDs. Declared test
        // membership still requires the producer's real structured result.
        return requiresTestResult
            ? { failureClass: 'runner', failureKind: 'invalid-success-result-sidecar' }
            : { failureClass: null, failureKind: null };
    }
    if (structuredResult.failureClass !== null || structuredResult.failureKind !== null)
    {
        return { failureClass: 'runner', failureKind: 'invalid-success-result-sidecar' };
    }
    return { failureClass: null, failureKind: null };
}

function artifactTable(attemptRoot, declaredPaths, requiredPaths)
{
    const paths = sortedUnique([...declaredPaths, ...requiredPaths]);
    const table = {};
    const missing = [];
    for (const relative of paths)
    {
        const candidate = path.resolve(attemptRoot, relative);
        if (!candidate.startsWith(`${path.resolve(attemptRoot)}${path.sep}`)
            || !fs.existsSync(candidate))
        {
            missing.push(relative);
            continue;
        }
        const stat = fs.lstatSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink())
        {
            missing.push(relative);
            continue;
        }
        table[relative] = sha256(fs.readFileSync(candidate));
        fs.chmodSync(candidate, 0o444);
    }
    return { paths: Object.keys(table).sort(), table, missing };
}

function retryDecision(policy, failureKind, attemptNumber)
{
    if (failureKind === null)
    {
        return 'not-applicable';
    }
    if (attemptNumber >= policy.allowedRetries + 1)
    {
        return policy.allowedRetries === 0 ? 'policy-denied' : 'policy-exhausted';
    }
    return policy.retryOn.includes(failureKind) ? 'policy-authorized' : 'policy-denied';
}

async function executeAttempt(options, policy, attemptNumber, producerRoot)
{
    const attemptRoot = path.join(producerRoot, `attempt-${attemptNumber}`);
    createOwnedDirectory(attemptRoot, `attempt ${attemptNumber}`);
    const stdoutFile = path.join(attemptRoot, 'stdout.log');
    const stderrFile = path.join(attemptRoot, 'stderr.log');
    const resultFile = path.join(attemptRoot, 'result.json');
    const startedAt = options.now();
    const started = options.monotonicNow();
    let outcome = {
        code: null,
        signal: null,
        spawnError: null,
        timedOut: false,
        cancelled: false
    };
    let resultError = null;
    try
    {
        outcome = await executeChild({
            command: options.command,
            cwd: options.cwd,
            env: {
                ...options.env,
                FSUSBLOG_ATTEMPT_NUMBER: String(attemptNumber),
                FSUSBLOG_ATTEMPT_RESULT_PATH: resultFile,
                FSUSBLOG_ATTEMPT_ARTIFACT_ROOT: attemptRoot
            },
            stdoutFile,
            stderrFile,
            timeoutMs: options.timeoutMs,
            signal: options.signal
        });
    }
    catch (error)
    {
        resultError = error;
        if (!fs.existsSync(stdoutFile))
        {
            fs.writeFileSync(stdoutFile, '');
        }
        if (!fs.existsSync(stderrFile))
        {
            fs.writeFileSync(stderrFile, `${error.stack ?? error.message}\n`);
        }
    }
    let structuredResult = null;
    try
    {
        structuredResult = readStructuredResult(resultFile);
    }
    catch (error)
    {
        resultError = error;
    }
    let failure = failureIdentity(outcome, structuredResult, resultError, options.expectedTestIds.length > 0);
    const artifacts = artifactTable(
        attemptRoot,
        structuredResult?.artifactPaths ?? [],
        ['stderr.log', 'stdout.log', ...(fs.existsSync(resultFile) ? ['result.json'] : [])]
    );
    if (artifacts.missing.length > 0)
    {
        failure = { failureClass: 'runner', failureKind: 'artifact-collection-failure' };
    }
    const clean = outcome.code === 0 && outcome.signal === null && outcome.spawnError === null
        && !outcome.timedOut && !outcome.cancelled && failure.failureKind === null;
    const status = clean ? 'clean-success' : (outcome.cancelled ? 'cancelled' : 'failed-no-retry');
    const decision = retryDecision(policy, failure.failureKind, attemptNumber);
    const receipt = sealContentDigest({
        schema: attemptReceiptSchema,
        producerId: options.producerId,
        attemptNumber,
        maxAttempts: policy.allowedRetries + 1,
        sourceCommit: options.sourceCommit,
        worktreeFingerprint: options.worktreeFingerprint,
        schedulerRunId: options.schedulerRunId,
        command: options.command,
        commandDigest: digestCanonical(options.command),
        executionEnvelopeDigest: options.authorityDigestByKind.get('execution-envelope'),
        replayPlanDigest: options.authorityDigestByKind.get('replay-plan'),
        temporalContextDigest: options.authorityDigestByKind.get('temporal-context'),
        authorityReferences: options.authorityReferences,
        startedAt,
        finishedAt: options.now(),
        durationMs: Math.max(0, Math.round(options.monotonicNow() - started)),
        exitCode: Number.isInteger(outcome.code) ? outcome.code : null,
        signal: outcome.signal,
        failureClass: failure.failureClass,
        failureKind: failure.failureKind,
        failedTestIds: sortedUnique(structuredResult?.failedTestIds),
        executedTestIds: sortedUnique(structuredResult?.executedTestIds),
        stdoutPath: 'stdout.log',
        stderrPath: 'stderr.log',
        artifactPaths: artifacts.paths,
        artifactDigests: artifacts.table,
        firstFailure: attemptNumber === 1 && !clean,
        retryDecision: decision,
        retryPolicyId: policy.id,
        status
    });
    const receiptFile = path.join(attemptRoot, 'receipt.json');
    writeExclusive(receiptFile, receipt);
    return {
        receipt,
        receiptFile,
        retry: decision === 'policy-authorized'
    };
}

export async function runProducerAttempts(input)
{
    const registry = input.registry ?? readRetryPolicyRegistry();
    const policy = retryPolicyById(input.retryPolicyId, registry);
    const options = {
        ...input,
        producerId: safeSegment(input.producerId, 'producerId'),
        schedulerRunId: safeSegment(input.schedulerRunId, 'schedulerRunId'),
        command: Array.isArray(input.command) && input.command.length > 0
            ? input.command.map((value) => String(value))
            : (() =>
{
 throw new Error('command must be a non-empty array');
})(),
        cwd: path.resolve(input.cwd),
        env: input.env ?? {},
        now: input.now ?? (() => new Date().toISOString()),
        monotonicNow: input.monotonicNow ?? (() => performance.now()),
        expectedTestIds: sortedUnique(input.expectedTestIds),
        timeoutMs: input.timeoutMs ?? null,
        signal: input.signal ?? null
    };
    const identity = {
        sourceCommit: options.sourceCommit,
        worktreeFingerprint: options.worktreeFingerprint,
        schedulerRunId: options.schedulerRunId,
        producerId: options.producerId
    };
    const authorities = validateExternalAuthorityReferences(
        input.authorityReferences,
        input.verifyAuthority,
        identity
    );
    options.authorityReferences = authorities;
    options.authorityDigestByKind = new Map(authorities.map((item) => [item.kind, item.artifactDigest]));
    const evidenceRoot = path.resolve(input.evidenceRoot);
    fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
    const runRoot = path.join(evidenceRoot, options.schedulerRunId);
    if (!fs.existsSync(runRoot))
    {
        createOwnedDirectory(runRoot, 'attempt run root');
    }
    const producerRoot = path.join(runRoot, options.producerId);
    createOwnedDirectory(producerRoot, 'attempt producer root');
    const executed = [];
    for (let attemptNumber = 1; attemptNumber <= policy.allowedRetries + 1; attemptNumber += 1)
    {
        const attempt = await executeAttempt(options, policy, attemptNumber, producerRoot);
        executed.push(attempt);
        if (!attempt.retry)
        {
            break;
        }
    }
    const receipts = executed.map((item) => item.receipt);
    const aggregate = sealContentDigest({
        schema: aggregateAttemptReceiptSchema,
        producerId: options.producerId,
        schedulerRunId: options.schedulerRunId,
        sourceCommit: options.sourceCommit,
        worktreeFingerprint: options.worktreeFingerprint,
        retryPolicyId: policy.id,
        attempts: executed.map((item, index) => ({
            attemptNumber: index + 1,
            path: path.relative(producerRoot, item.receiptFile).replaceAll(path.sep, '/'),
            digest: item.receipt.contentDigest
        })),
        firstAttemptStatus: receipts[0].status,
        finalAttemptStatus: receipts.at(-1).status,
        finalClassification: classifyAggregate(policy, receipts),
        cleanFirstAttempt: receipts.length === 1 && receipts[0].status === 'clean-success',
        qualificationEligible: policy.classification === 'correctness'
            && receipts.length === 1 && receipts[0].status === 'clean-success'
    });
    writeExclusive(path.join(producerRoot, 'aggregate.json'), aggregate);
    const loadAttempt = (reference) => JSON.parse(fs.readFileSync(path.join(producerRoot, reference.path), 'utf8'));
    validateAggregateAttemptReceipt(aggregate, {
        registry,
        loadAttempt,
        verifyAuthority: input.verifyAuthority,
        verifyArtifact: (relative, digest, receipt) =>
        {
            return verifyFileDigest(
                path.join(producerRoot, `attempt-${receipt.attemptNumber}`),
                relative,
                digest
            );
        }
    });
    return Object.freeze({
        producerRoot,
        attempts: Object.freeze(receipts),
        aggregate
    });
}

export function validateDockerEquivalentAttemptReceipt(receipt, options = {})
{
    const validated = validateAttemptReceipt(receipt, options);
    if (!validated.command.some((value) => value === 'docker' || value.includes('docker'))
        || validated.exitCode === null
        || !validated.artifactPaths.includes(validated.stdoutPath)
        || !validated.artifactPaths.includes(validated.stderrPath))
    {
        throw new Error('Docker equivalent attempt requires real command/process/log evidence');
    }
    return validated;
}
