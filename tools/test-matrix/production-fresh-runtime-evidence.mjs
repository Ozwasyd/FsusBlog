import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    appendFreshRuntimeCleanupFailure,
    captureFreshRuntimeCleanup,
    cleanupStaleLocalRuntimes,
    verifyFreshRuntimeCleanupReceipt,
    writeFreshRuntimeCleanupReceipt
} from './local-runtime-cleanup.mjs';
import { outputPath } from './production-fresh-run-bound-outputs.mjs';
import {
    recordCheckpointFailure,
    recordCheckpointRuntimeCleanup,
    readRuntimeCleanupAttemptLedger,
    recordRuntimeCleanupAttempt
} from './scheduler.mjs';

function relativeToRoot(root, file)
{
    return path.relative(root, file).replaceAll(path.sep, '/');
}

function atomicWriteJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pending = `${file}.next-${process.pid}`;
    fs.writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(pending, file);
}

export function runtimeCleanupReceiptReference(root, receipt)
{
    return {
        path: relativeToRoot(root, receipt.file),
        status: receipt.receipt.status,
        digest: receipt.receipt.contentDigest
    };
}

function assertContained(root, candidate)
{
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(candidate);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`))
    {
        throw new Error(`runtime cleanup evidence escapes its owner root: ${candidate}`);
    }
    return resolved;
}

function assertNoSymlinkComponents(root, candidate, { createDirectories = false } = {})
{
    const resolvedRoot = path.resolve(root);
    const contained = assertContained(resolvedRoot, candidate);
    const rootStat = fs.lstatSync(resolvedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    {
        throw new Error(`runtime cleanup evidence owner must be a real directory: ${resolvedRoot}`);
    }
    let current = resolvedRoot;
    for (const segment of path.relative(resolvedRoot, contained).split(path.sep).filter(Boolean))
    {
        current = path.join(current, segment);
        let stat;
        try
        {
            stat = fs.lstatSync(current);
        }
        catch (error)
        {
            if (error.code !== 'ENOENT')
            {
                throw error;
            }
        }
        if (!stat && createDirectories)
        {
            fs.mkdirSync(current);
            stat = fs.lstatSync(current);
        }
        if (!stat)
        {
            continue;
        }
        if (stat.isSymbolicLink())
        {
            throw new Error(`symlink is not allowed in runtime cleanup evidence: ${current}`);
        }
        if (current !== contained && !stat.isDirectory())
        {
            throw new Error(`runtime cleanup evidence ancestor must be a directory: ${current}`);
        }
    }
    if (createDirectories)
    {
        const containedStat = fs.lstatSync(contained);
        if (containedStat.isSymbolicLink() || !containedStat.isDirectory())
        {
            throw new Error(`runtime cleanup evidence owner must be a real directory: ${contained}`);
        }
    }
    return contained;
}

function verifiedReceiptBytes(receipt)
{
    const source = path.resolve(receipt.file);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile())
    {
        throw new Error(`runtime cleanup receipt source must be a regular file: ${source}`);
    }
    const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
    let descriptor;
    let bytes;
    try
    {
        descriptor = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
        const openedStat = fs.fstatSync(descriptor);
        if (!openedStat.isFile())
        {
            throw new Error(`runtime cleanup receipt source must be a regular file: ${source}`);
        }
        bytes = fs.readFileSync(descriptor);
    }
    catch (error)
    {
        if (error.code === 'ELOOP')
        {
            throw new Error(`runtime cleanup receipt source must not be a symlink: ${source}`, {
                cause: error
            });
        }
        throw error;
    }
    finally
    {
        if (descriptor !== undefined)
        {
            fs.closeSync(descriptor);
        }
    }
    const document = JSON.parse(bytes.toString('utf8'));
    verifyFreshRuntimeCleanupReceipt(receipt.receipt);
    verifyFreshRuntimeCleanupReceipt(document);
    if (document.contentDigest !== receipt.receipt.contentDigest)
    {
        throw new Error('runtime cleanup receipt source content differs from the verified receipt');
    }
    return bytes;
}

function verifyPublishedReceipt(file, expectedDigest)
{
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile())
    {
        throw new Error(`bound runtime cleanup receipt must be a regular file: ${file}`);
    }
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    verifyFreshRuntimeCleanupReceipt(document);
    if (document.contentDigest !== expectedDigest)
    {
        throw new Error(`bound runtime cleanup receipt already exists with different content: ${file}`);
    }
    return document;
}

function publishRuntimeCleanupReceipt({ ownerRoot, file, receipt })
{
    const bytes = verifiedReceiptBytes(receipt);
    assertNoSymlinkComponents(ownerRoot, path.dirname(file), { createDirectories: true });
    assertNoSymlinkComponents(ownerRoot, file);
    if (fs.existsSync(file))
    {
        verifyPublishedReceipt(file, receipt.receipt.contentDigest);
        return { ...receipt, file };
    }
    const pending = `${file}.pending-${process.pid}-${randomBytes(8).toString('hex')}`;
    fs.writeFileSync(pending, bytes, { mode: 0o600, flag: 'wx' });
    try
    {
        verifyPublishedReceipt(pending, receipt.receipt.contentDigest);
        try
        {
            fs.linkSync(pending, file);
        }
        catch (error)
        {
            if (error.code !== 'EEXIST')
            {
                throw error;
            }
            verifyPublishedReceipt(file, receipt.receipt.contentDigest);
        }
    }
    finally
    {
        fs.rmSync(pending, { force: true });
    }
    verifyPublishedReceipt(file, receipt.receipt.contentDigest);
    return { ...receipt, file };
}

export function bindFreshRuntimeCleanupReceipt({ layout, receipt })
{
    const verification = verifyFreshRuntimeCleanupReceipt(receipt.receipt);
    if (receipt.receipt.runId !== layout.runId)
    {
        throw new Error('runtime cleanup receipt runId does not match the Production Fresh output attempt');
    }
    if (receipt.receipt.phase === 'preflight' && verification.status !== 'complete')
    {
        throw new Error('blocked runtime cleanup preflight receipt cannot bind to an output attempt');
    }
    const relative = [
        'runtime',
        'runtime-cleanup-receipts',
        `${receipt.receipt.phase}-${receipt.receipt.attemptId}.json`
    ].join('/');
    const file = outputPath(layout, relative);
    return publishRuntimeCleanupReceipt({
        ownerRoot: path.resolve(layout.outputRoot),
        file,
        receipt
    });
}

function bindBlockedFreshRuntimeCleanupReceipt({ root, runsRoot, runId, receipt })
{
    const repositoryRoot = path.resolve(root);
    const canonicalRunsRoot = path.join(repositoryRoot, '.tmp', 'test-runs');
    if (path.resolve(runsRoot) !== canonicalRunsRoot)
    {
        throw new Error('blocked runtime cleanup evidence requires the canonical scheduler runs root');
    }
    const verification = verifyFreshRuntimeCleanupReceipt(receipt.receipt);
    if (verification.status !== 'blocked'
    || receipt.receipt.phase !== 'preflight'
    || receipt.receipt.runId !== runId)
    {
        throw new Error('blocked runtime cleanup receipt identity is invalid');
    }
    const runRoot = assertContained(canonicalRunsRoot, path.join(canonicalRunsRoot, runId));
    assertNoSymlinkComponents(repositoryRoot, runRoot, { createDirectories: true });
    const file = path.join(
        runRoot,
        'preflight',
        'runtime-cleanup',
        `${receipt.receipt.attemptId}.json`);
    return publishRuntimeCleanupReceipt({ ownerRoot: runRoot, file, receipt });
}

function preflightSummaryFile(runsRoot, runId)
{
    return path.join(runsRoot, runId, 'preflight', 'summary.json');
}

export function runProductionFreshRuntimeCleanupPhase({
    root,
    phase,
    source,
    preflightSource = source,
    currentRunId = '',
    runsRoot = null,
    cleanupOptions = {},
    cleanupRuntime = cleanupStaleLocalRuntimes
})
{
    if (!['preflight', 'postflight'].includes(phase))
    {
        throw new Error(`unsupported Production Fresh runtime cleanup phase: ${phase}`);
    }
    const cleanup = captureFreshRuntimeCleanup(() => cleanupRuntime({
        ...cleanupOptions,
        root,
        currentRunId,
        schedulerRunsRoot: runsRoot,
        sourceState: source,
        discoverUntracked: true
    }), { stage: `${phase}-inventory-cleanup` });
    return {
        ...cleanup,
        sourceStateMatchesPreflight: phase === 'preflight'
      || (source.commit === preflightSource.commit
        && source.worktreeFingerprint === preflightSource.worktreeFingerprint)
    };
}

function runtimeCleanupAttemptLedgerBinding({
    root,
    profileId,
    runId,
    invocationId,
    sourceState,
    receiptDirectory
})
{
    const repositoryRoot = path.resolve(root);
    const ledgerKey = createHash('sha256')
        .update(JSON.stringify({ repositoryRoot, runId, invocationId }))
        .digest('hex');
    const ledgerRunId = `runtime-cleanup-${ledgerKey.slice(0, 32)}`;
    const ledgerRunsRoot = `${path.resolve(receiptDirectory)}.attempt-ledgers`;
    return {
        checkpointFile: path.join(ledgerRunsRoot, ledgerRunId, 'checkpoint.json'),
        ledgerRunId,
        identity: {
            targetTierId: profileId,
            schedulerRunId: runId,
            invocationId,
            repositoryRoot,
            sourceState
        }
    };
}

function blockedAttemptReceipt(ledger, binding, receiptDirectory)
{
    const attempt = ledger.attempts.find((entry) => entry.attemptId === ledger.blockedAttemptId);
    if (!attempt || attempt.status !== 'blocked')
    {
        throw new Error('runtime cleanup attempt ledger has no blocking receipt');
    }
    const directory = path.resolve(receiptDirectory);
    const receiptFile = path.resolve(attempt.receiptFile);
    if (receiptFile !== directory && !receiptFile.startsWith(`${directory}${path.sep}`))
    {
        throw new Error('runtime cleanup attempt ledger receipt escapes its evidence directory');
    }
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const verification = verifyFreshRuntimeCleanupReceipt(receipt);
    if (verification.status !== 'blocked'
    || receipt.runId !== binding.identity.schedulerRunId
    || receipt.invocationId !== binding.identity.invocationId
    || receipt.attemptId !== attempt.attemptId
    || receipt.phase !== 'preflight'
    || receipt.contentDigest !== attempt.digest)
    {
        throw new Error('runtime cleanup attempt ledger blocking receipt identity is invalid');
    }
    return { file: receiptFile, receipt, verification };
}

export function executeProductionFreshPreflight({
    root,
    profileId,
    profile,
    runId,
    runsRoot,
    runtimeNamespace,
    invocationId,
    sourceState,
    physicalTiers,
    executionSource,
    wallClockStartedAtMs,
    receiptDirectory,
    cleanupOptions = {},
    cleanupRuntime = cleanupStaleLocalRuntimes,
    additionalCleanup = null,
    additionalCleanupStage = 'preflight-additional-cleanup'
})
{
    const ledgerBinding = runtimeCleanupAttemptLedgerBinding({
        root,
        profileId,
        runId,
        invocationId,
        sourceState,
        receiptDirectory
    });
    let existingLedger;
    try
    {
        existingLedger = readRuntimeCleanupAttemptLedger(
            ledgerBinding.checkpointFile,
            ledgerBinding.ledgerRunId,
            ledgerBinding.identity);
    }
    catch (error)
    {
        recordProductionFreshFailure({
            root,
            profileId,
            profile,
            runId,
            runsRoot,
            runtimeNamespace,
            sourceState,
            physicalTiers,
            executionSource,
            wallClockStartedAtMs,
            failure: {
                tierId: profileId,
                exitCode: 1,
                reason: `Production Fresh preflight attempt ledger read failed: ${error.message}`
            },
            stage: 'runtime-cleanup-preflight-attempt-ledger-read-failed'
        });
        throw error;
    }
    if (existingLedger.status === 'blocked')
    {
        let receipt;
        try
        {
            receipt = blockedAttemptReceipt(existingLedger, ledgerBinding, receiptDirectory);
        }
        catch (error)
        {
            recordProductionFreshFailure({
                root,
                profileId,
                profile,
                runId,
                runsRoot,
                runtimeNamespace,
                sourceState,
                physicalTiers,
                executionSource,
                wallClockStartedAtMs,
                failure: {
                    tierId: profileId,
                    exitCode: 1,
                    reason: `Production Fresh preflight blocking attempt evidence failed: ${error.message}`
                },
                stage: 'runtime-cleanup-preflight-attempt-evidence-failed'
            });
            throw error;
        }
        recordBlockedProductionFreshPreflight({
            root,
            profileId,
            profile,
            runId,
            runsRoot,
            runtimeNamespace,
            sourceState,
            receipt,
            physicalTiers,
            executionSource,
            wallClockStartedAtMs
        });
    }
    let cleanup = runProductionFreshRuntimeCleanupPhase({
        root,
        phase: 'preflight',
        source: sourceState,
        currentRunId: runId,
        runsRoot,
        cleanupOptions,
        cleanupRuntime
    });
    let additionalCleanupResult = null;
    if (typeof additionalCleanup === 'function')
    {
        try
        {
            additionalCleanupResult = additionalCleanup();
        }
        catch (error)
        {
            cleanup = appendFreshRuntimeCleanupFailure(
                cleanup,
                error,
                additionalCleanupStage);
        }
    }
    let receipt;
    try
    {
        receipt = writeFreshRuntimeCleanupReceipt({
            root,
            phase: 'preflight',
            runId,
            invocationId,
            source: sourceState,
            cleanup,
            directory: receiptDirectory
        });
    }
    catch (error)
    {
        recordProductionFreshFailure({
            root,
            profileId,
            profile,
            runId,
            runsRoot,
            runtimeNamespace,
            sourceState,
            physicalTiers,
            executionSource,
            wallClockStartedAtMs,
            failure: {
                tierId: profileId,
                exitCode: 1,
                reason: `Production Fresh preflight receipt persistence failed: ${error.message}`
            },
            stage: 'runtime-cleanup-preflight-receipt-failed'
        });
        throw error;
    }
    let sealedLedger;
    try
    {
        sealedLedger = recordRuntimeCleanupAttempt(
            ledgerBinding.checkpointFile,
            ledgerBinding.ledgerRunId,
            ledgerBinding.identity,
            {
                attemptId: receipt.receipt.attemptId,
                phase: receipt.receipt.phase,
                status: receipt.receipt.status,
                digest: receipt.receipt.contentDigest,
                receiptFile: path.resolve(receipt.file),
                startedAt: receipt.receipt.startedAt,
                finishedAt: receipt.receipt.finishedAt
            });
    }
    catch (error)
    {
        recordProductionFreshFailure({
            root,
            profileId,
            profile,
            runId,
            runsRoot,
            runtimeNamespace,
            sourceState,
            physicalTiers,
            executionSource,
            wallClockStartedAtMs,
            failure: {
                tierId: profileId,
                exitCode: 1,
                reason: `Production Fresh preflight attempt ledger persistence failed: ${error.message}`
            },
            stage: 'runtime-cleanup-preflight-attempt-ledger-failed'
        });
        throw error;
    }
    if (sealedLedger.status === 'blocked')
    {
        const blockedReceipt = receipt.verification.status === 'blocked'
            ? receipt
            : blockedAttemptReceipt(sealedLedger, ledgerBinding, receiptDirectory);
        recordBlockedProductionFreshPreflight({
            root,
            profileId,
            profile,
            runId,
            runsRoot,
            runtimeNamespace,
            sourceState,
            receipt: blockedReceipt,
            physicalTiers,
            executionSource,
            wallClockStartedAtMs
        });
    }
    return { cleanup, receipt, additionalCleanupResult };
}

function blockedPreflightSummary({
    profile,
    runId,
    physicalTiers,
    executionSource,
    wallClockStartedAtMs,
    checkpoint,
    failure
})
{
    return {
        schema: 'fsusblog.local-production.run.v1',
        status: 'failure',
        executionSource,
        schedulerRunId: runId,
        budgetMs: profile.budgetMs,
        durationMs: Math.max(0, Date.now() - wallClockStartedAtMs),
        physicalBundles: physicalTiers.map((tier) => ({
            id: tier.physicalBundleId,
            status: checkpoint.tiers?.[tier.id]?.status ?? 'not-run',
            durationMs: checkpoint.tiers?.[tier.id]?.durationMs ?? 0
        })),
        projectedTierIds: [],
        summaryOnlyTierIds: profile.summaryOnly ?? [],
        ungeneratedTierIds: profile.bundles.flatMap((bundle) => bundle.members),
        failure,
        failures: checkpoint.failures ?? [failure],
        runtimeCleanup: checkpoint.runtimeCleanup ?? {},
        generatedAt: new Date().toISOString()
    };
}

export function recordProductionFreshFailure({
    profileId,
    profile,
    runId,
    runsRoot,
    runtimeNamespace,
    sourceState,
    physicalTiers,
    executionSource,
    wallClockStartedAtMs,
    failure,
    stage,
    eventType = stage,
    step = 'runtime-cleanup',
    recordFailure = recordCheckpointFailure
})
{
    const checkpointPath = path.join(runsRoot, runId, 'checkpoint.json');
    const checkpoint = recordFailure(checkpointPath, runId, failure, {
        targetTierId: profileId,
        sourceState,
        runtimeNamespace,
        startedAt: new Date(wallClockStartedAtMs).toISOString(),
        stage,
        eventType,
        step
    });
    atomicWriteJson(preflightSummaryFile(runsRoot, runId), blockedPreflightSummary({
        profileId,
        profile,
        runId,
        physicalTiers,
        executionSource,
        wallClockStartedAtMs,
        checkpoint,
        failure
    }));
    return { checkpoint, checkpointPath, failure };
}

export function recordBlockedProductionFreshPreflight({
    root,
    profileId,
    profile,
    runId,
    runsRoot,
    runtimeNamespace,
    sourceState,
    receipt,
    physicalTiers,
    executionSource,
    wallClockStartedAtMs,
    recordRuntimeCleanup = recordCheckpointRuntimeCleanup,
    recordFailure = recordCheckpointFailure
})
{
    const verification = verifyFreshRuntimeCleanupReceipt(receipt.receipt);
    if (verification.status !== 'blocked')
    {
        throw new Error('blocked Production Fresh preflight recorder requires a blocked receipt');
    }
    const checkpointPath = path.join(runsRoot, runId, 'checkpoint.json');
    const failure = {
        tierId: profileId,
        exitCode: 1,
        reason: `Production Fresh runtime cleanup preflight blocked: ${verification.failures.join('; ')}`
    };
    const checkpointOptions = {
        targetTierId: profileId,
        sourceState,
        runtimeNamespace,
        startedAt: new Date(wallClockStartedAtMs).toISOString(),
        stage: 'runtime-cleanup-preflight-blocked',
        eventType: 'runtime-cleanup-preflight-blocked',
        step: 'runtime-cleanup'
    };
    let checkpoint;
    try
    {
        const boundReceipt = bindBlockedFreshRuntimeCleanupReceipt({
            root,
            runsRoot,
            runId,
            receipt
        });
        checkpoint = recordRuntimeCleanup(
            checkpointPath,
            runId,
            { preflight: runtimeCleanupReceiptReference(root, boundReceipt) },
            failure,
            checkpointOptions);
    }
    catch (error)
    {
        const bindingFailure = {
            tierId: profileId,
            exitCode: 1,
            reason: `Production Fresh preflight evidence binding failed: ${error.message}`
        };
        recordProductionFreshFailure({
            root,
            profileId,
            profile,
            runId,
            runsRoot,
            runtimeNamespace,
            sourceState,
            physicalTiers,
            executionSource,
            wallClockStartedAtMs,
            failure: bindingFailure,
            stage: 'runtime-cleanup-preflight-binding-failed',
            eventType: 'runtime-cleanup-preflight-binding-failed',
            recordFailure
        });
        throw error;
    }
    atomicWriteJson(preflightSummaryFile(runsRoot, runId), blockedPreflightSummary({
        profileId,
        profile,
        runId,
        physicalTiers,
        executionSource,
        wallClockStartedAtMs,
        checkpoint,
        failure
    }));
    const error = new Error(failure.reason);
    error.checkpointPath = checkpointPath;
    throw error;
}
