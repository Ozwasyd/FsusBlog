#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { behaviorDocNugetClosure, behaviorDocNugetFeedConfiguration, inventoryNugetOfflineFeed, inventoryPreparedNuget, matrixNativeNugetClosure, nugetPreparationCommand, nugetPreparationEnvironment, observeMatrixNativeNugetToolInputs, validatePreparedNugetPackages } = await import(new URL('../test/behavior-doc-nuget-preparation.mjs', import.meta.url));
const { finalizeRunOwnedDirectories, prepareRunOwnedDirectories } = await import(new URL('../test/execution-envelope-directories.mjs', import.meta.url));
const { observeExecutableIdentity, prepareCorrectnessEnvironment, verifyExecutableIdentity } = await import(new URL('../test/execution-envelope-environment.mjs', import.meta.url));
const { finalizeNetworkSandbox, loadExecutionNetworkPolicy, prepareNetworkSandbox } = await import(new URL('../test/execution-envelope-network.mjs', import.meta.url));
const { createExecutionFailureOwner, executionFailureDataProperty, observeExecutionFailure, retainExecutionFailure, retainExecutionFailureCompatibility, retainExecutionRecovery } = await import(new URL('../test/execution-failure-diagnostic.mjs', import.meta.url));
const { runPhysicalExecution } = await import(new URL('../test/physical-execution-process-tree.mjs', import.meta.url));
const { fingerprintPaths, runBoundExecution, validateRunBoundProjection } = await import(new URL('../test/run-once.mjs', import.meta.url));
const { sealSourceIdentity } = await import(new URL('../fact-extractors/identity.mjs', import.meta.url));
const { loadExecutionEnvelopeApplicability, loadExecutionEnvelopePolicy } = await import(new URL('../test-matrix/execution-envelope-policy.mjs', import.meta.url));
const { bindBehaviorDocNugetPreparationDiskDemand, buildProductionDiskDemandPlan, defaultProductionDiskRoots, readProductionDiskDemandCatalog } = await import(new URL('../test-matrix/production-disk-demand.mjs', import.meta.url));
const { acquireProductionCapacityReservation } = await import(new URL('../test-matrix/production-capacity-reservation.mjs', import.meta.url));
const { acquireProductionFreshExclusiveLease } = await import(new URL('../test-matrix/production-fresh-exclusive-lease.mjs', import.meta.url));
const { snapshotSourceState } = await import(new URL('../test-matrix/scheduler.mjs', import.meta.url));

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function writeStagedFeedFile(file, bytes, mode)
{
    fs.writeFileSync(file, bytes, { flag: 'wx', mode });
    fs.chmodSync(file, mode);
}

/** Independent, offline dependency preparation only; no correctness admission is generated here. */
export async function prepareBehaviorDocNuget({ repositoryRoot, runId, outputFile, feedRoot, feedDigest, purpose = 'behavior-doc' })
{
    if (!['behavior-doc', 'matrix-native'].includes(purpose))
    {
        throw new Error('Unknown NuGet preparation purpose');
    }
    if (!String(runId ?? '').trim())
    {
        throw new Error('NuGet preparation requires an explicit scheduler run');
    }
    const root = fs.realpathSync(repositoryRoot);
    const source = sealSourceIdentity(root);
    const closure = purpose === 'matrix-native' ? matrixNativeNugetClosure(root) : behaviorDocNugetClosure(root);
    const matrixNativeToolInputs = purpose === 'matrix-native' ? observeMatrixNativeNugetToolInputs(root) : null;
    const consumerId = purpose === 'matrix-native' ? 'matrix-native-nuget-transfer' : 'behavior-doc-nuget-transfer';
    const verifyNativeTools = () =>
    {
        if (matrixNativeToolInputs && JSON.stringify(observeMatrixNativeNugetToolInputs(root)) !== JSON.stringify(matrixNativeToolInputs))
        {
            throw new Error('Matrix native SDK/compiler/runtime input bytes drifted');
        }
    };
    const preparationParent = path.join(root, '.tmp/behavior-doc-nuget-preparation');
    const output = path.resolve(outputFile);
    if (!output.startsWith(preparationParent + path.sep))
    {
        throw new Error('NuGet preparation descriptor must stay inside its preparation owner');
    }
    fs.mkdirSync(preparationParent, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(preparationParent) !== preparationParent)
    {
        throw new Error('NuGet preparation parent must be canonical');
    }
    const feed = inventoryNugetOfflineFeed(feedRoot, closure, Number(fs.statfsSync(preparationParent).bsize));
    if (feed.treeDigest !== feedDigest)
    {
        throw new Error('Explicit offline feed digest drifted');
    }
    const controller = new AbortController();
    const abort = (value) => controller.abort(Object.assign(new Error(`NuGet preparation cancelled: ${value}`),
        { name: 'AbortError', signal: value }));
    const onSigint = () => abort('SIGINT');
    const onSigterm = () => abort('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    let lease;
    let reservation;
    let directories;
    let attemptRoot;
    let firstFailure = null;
    const diagnosticOwner = createExecutionFailureOwner();
    let physicalStarted = false;
    let terminalEvidence = null;
    let complete = false;
    let preparationResult;
    let operationFailed = false;
    try
    {
        // This dependency phase uses the existing candidate/resource lease, not a new controller or qualification.
        const sourceState = await snapshotSourceState(root);
        lease = acquireProductionFreshExclusiveLease({
            root, runId, targetTierId: 'production-correctness', sourceState
        });
        const catalog = bindBehaviorDocNugetPreparationDiskDemand(readProductionDiskDemandCatalog(root), feed);
        const plan = buildProductionDiskDemandPlan({ root,
            tiers: [{ id: 'behavior-doc-nuget-preparation', executionDependsOn: [], exclusiveResources: [] }],
            maxParallel: 1, catalog, roots: {
                ...defaultProductionDiskRoots(root, { includeDockerStorage: false }),
                behaviorDocNugetPreparationRoot: preparationParent
            } });
        reservation = acquireProductionCapacityReservation({ plan, runId,
            candidateIdentityDigest: lease.owner.candidateIdentityDigest,
            repositoryRoot: root, repositoryLeaseOwner: lease.owner });
        reservation.guardProducer('behavior-doc-nuget-preparation');
        attemptRoot = fs.mkdtempSync(path.join(preparationParent, 'transfer-'));
        const packagesRoot = path.join(attemptRoot, 'packages');
        const artifactsRoot = path.join(attemptRoot, 'artifacts');
        const stagedFeed = path.join(attemptRoot, 'feed');
        const configFile = path.join(attemptRoot, 'NuGet.Config');
        for (const directory of [packagesRoot, artifactsRoot, stagedFeed])
        {
            fs.mkdirSync(directory, { mode: 0o700 });
        }
        for (const entry of feed.entries)
        {
            if (controller.signal.aborted)
            {
                throw controller.signal.reason;
            }
            const original = path.join(feed.root, entry.path);
            const stat = fs.lstatSync(original);
            if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o222)
                || fs.realpathSync(original) !== original)
            {
                throw new Error('Offline feed file ceased to be a sealed regular input');
            }
            const bytes = fs.readFileSync(original);
            if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
            {
                throw new Error('Offline feed bytes drifted before staging');
            }
            const stagedFile = path.join(stagedFeed, entry.path);
            writeStagedFeedFile(stagedFile, bytes, entry.mode);
            await new Promise((resolve) => setImmediate(resolve));
        }
        fs.chmodSync(stagedFeed, 0o555);
        if (inventoryNugetOfflineFeed(stagedFeed, closure).treeDigest !== feed.treeDigest
            || inventoryNugetOfflineFeed(feed.root, closure).treeDigest !== feed.treeDigest)
        {
            throw new Error('Offline feed copy or source drifted');
        }
        fs.writeFileSync(configFile, behaviorDocNugetFeedConfiguration({ feedRoot: stagedFeed, packagesRoot }),
            { flag: 'wx', mode: 0o400 });
        const command = nugetPreparationCommand({ purpose, packagesRoot, artifactsRoot, feedRoot: stagedFeed, configFile });
        const outputContract = [artifactsRoot, stagedFeed, packagesRoot, configFile].sort();
        const key = consumerId + '-' + randomUUID();
        directories = prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root, runId,
            producerId: 'behavior-doc-static-admission', attemptId: key, outputs: [packagesRoot, artifactsRoot] });
        const environment = prepareCorrectnessEnvironment({ command, parentEnvironment: process.env,
            producerAllowlist: ['DOTNET_ROOT', 'PATH'],
            injectedEnvironment: nugetPreparationEnvironment({ directories, packagesRoot, runId, source }),
            policy: loadExecutionEnvelopePolicy(), catalog: loadExecutionEnvelopeApplicability() });
        const network = prepareNetworkSandbox({ command: environment.command, cwd: root,
            ownedDirectoryEnvelope: directories,
            directories: directories.fragment.directories, writableRoots: directories.fragment.writableRoots,
            plannedEndpoints: [], environment: environment.environment, policy: loadExecutionNetworkPolicy() });
        const toolchain = environment.fragment.actualExecutable;
        const physicalRoot = path.join(root, '.tmp/physical-executions');
        const inputDigest = await fingerprintPaths(
            [...closure.sourceClosureDigests.map((value) => value.path),
                command[2], 'tools/docs/prepare-behavior-doc-nuget.mjs',
                'tools/test/behavior-doc-nuget-preparation.mjs', feed.root, configFile],
            { root, values: [JSON.stringify(source), JSON.stringify(command), JSON.stringify(toolchain),
                feed.treeDigest, JSON.stringify(matrixNativeToolInputs), digest(directories.fragment), digest(network.fragment), environment.fragmentDigest,
                plan.planDigest] });
        const result = await runBoundExecution({ root: physicalRoot, runId, key, command, cwd: root, inputDigest,
            environmentDigest: digest({ environment: environment.fragment, directories: directories.fragment, network: network.fragment }),
            outputContract, requiredOutputs: outputContract,
            commit: source.sourceCommit, worktreeFingerprint: source.worktreeFingerprint,
            consumerId, signal: controller.signal
        }, async () =>
        {
            let physicalExecution;
            let failure = null;
            let failed = false;
            let actualNetwork;
            let actualDirectories;
            try
            {
                if (controller.signal.aborted)
                {
                    throw controller.signal.reason;
                }
                if (JSON.stringify(sealSourceIdentity(root)) !== JSON.stringify(source)
                    || inventoryNugetOfflineFeed(feed.root, closure).treeDigest !== feed.treeDigest
                    || inventoryNugetOfflineFeed(stagedFeed, closure).treeDigest !== feed.treeDigest)
                {
                    throw new Error('Source or offline feed drifted before physical restore');
                }
                verifyNativeTools();
                physicalStarted = true;
                physicalExecution = await runPhysicalExecution({ command: network.command, cwd: root,
                    env: environment.environment, signal: controller.signal,
                    linuxPrivateNetwork: network.linuxPrivateNetwork, linuxNetworkPolicy: network.linuxNetworkPolicy,
                    linuxReadWritePaths: network.linuxReadWritePaths,
                    linuxOwnedPrivateTmp: network.linuxOwnedPrivateTmp });
            }
            catch (error)
            {
                failed = true;
                failure = retainExecutionFailure(diagnosticOwner, error);
                physicalExecution = executionFailureDataProperty(error, 'physicalExecution');
            }
            terminalEvidence = physicalExecution;
            try
            {
                actualNetwork = finalizeNetworkSandbox(network);
            }
            catch (error)
            {
                retainExecutionFailure(diagnosticOwner, error);
                if (failed)
                {
                    retainExecutionFailureCompatibility(failure, 'cleanupError', error);
                }
                else
                {
                    failed = true;
                    failure = error;
                }
            }
            if (!physicalStarted || physicalExecution?.postObservation === 'zero-members')
            {
                try
                {
                    actualDirectories = finalizeRunOwnedDirectories(directories);
                }
                catch (error)
                {
                    retainExecutionFailure(diagnosticOwner, error);
                    if (failed)
                    {
                        retainExecutionFailureCompatibility(failure, 'cleanupError', error);
                    }
                    else
                    {
                        failed = true;
                        failure = error;
                    }
                }
            }
            else
            {
                const terminalFailure = Object.assign(new Error('NuGet preparation has no verified zero-residue terminal'), { physicalExecution });
                failure = retainExecutionFailure(diagnosticOwner, terminalFailure);
                failed = true;
            }
            if (failed)
            {
                retainExecutionFailureCompatibility(failure, 'physicalExecution', physicalExecution);
                throw failure;
            }
            verifyExecutableIdentity(toolchain, observeExecutableIdentity('dotnet', { pathValue: process.env.PATH }));
            try
            {
                verifyNativeTools();
            }
            catch (error)
            {
                error.physicalExecution = physicalExecution;
                throw error;
            }
            if (JSON.stringify(sealSourceIdentity(root)) !== JSON.stringify(source)
                || inventoryNugetOfflineFeed(feed.root, closure).treeDigest !== feed.treeDigest
                || inventoryNugetOfflineFeed(stagedFeed, closure).treeDigest !== feed.treeDigest)
            {
                throw Object.assign(new Error('Source, toolchain or offline feed drifted during restore'), { physicalExecution });
            }
            const sealTree = (directory) =>
            {
                for (const name of fs.readdirSync(directory))
                {
                    const file = path.join(directory, name);
                    const stat = fs.lstatSync(file);
                    if (stat.isDirectory() && !stat.isSymbolicLink())
                    {
                        sealTree(file);
                    }
                    else if (stat.isFile() && stat.nlink === 1)
                    {
                        fs.chmodSync(file, stat.mode & 0o555);
                    }
                    else
                    {
                        throw Object.assign(new Error('NuGet produced linked or nonregular payload'), { physicalExecution });
                    }
                }
                fs.chmodSync(directory, 0o555);
            };
            sealTree(packagesRoot);
            try
            {
                validatePreparedNugetPackages(inventoryPreparedNuget(packagesRoot), closure, feed);
            }
            catch (error)
            {
                error.physicalExecution = physicalExecution;
                throw error;
            }
            reservation.completeProducer('behavior-doc-nuget-preparation');
            return { ...physicalExecution, phase: 'independent-dependency-transfer', qualificationEligible: false,
                command, toolchain, ...(matrixNativeToolInputs ? { matrixNativeToolInputs } : {}),
                offlineFeed: { root: stagedFeed, sourceRoot: feed.root, treeDigest: feed.treeDigest,
                    allocatedBytes: feed.allocatedBytes, expandedAllocatedBytes: feed.expandedAllocatedBytes },
                executionEnvelopeFragments: { environment: environment.fragment, network: actualNetwork, directories: actualDirectories },
                capacityPlanDigest: plan.planDigest };
        });
        const transfer = { root: physicalRoot, runId, key, consumerId,
            projectionFile: result.projectionFile, receiptFile: result.receiptFile };
        const verified = await validateRunBoundProjection({ ...transfer, verifyOutputs: true });
        const seed = inventoryPreparedNuget(packagesRoot);
        const preparation = { source, closure, root: packagesRoot, artifactsRoot, feedRoot: stagedFeed, configFile,
            treeDigest: seed.treeDigest, transfer: { ...transfer, receiptDigest: verified.receipt.receiptDigest } };
        fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
        if (fs.realpathSync(path.dirname(output)) !== path.dirname(output))
        {
            throw new Error('NuGet preparation descriptor parent is not canonical');
        }
        fs.writeFileSync(output, JSON.stringify(preparation, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
        complete = true;
        preparationResult = preparation;
    }
    catch (error)
    {
        firstFailure = retainExecutionFailure(diagnosticOwner, error);
        operationFailed = true;
    }
    {
        let cleanupFailure = null;
        const cleanup = (operation) =>
        {
            try
            {
                operation();
            }
            catch (error)
            {
                cleanupFailure ??= error;
            }
        };
        const mayCleanup = !physicalStarted || terminalEvidence?.postObservation === 'zero-members';
        if (!mayCleanup && operationFailed)
        {
            const recoveryObligation = { attemptRoot, ownedRoot: directories?.fragment.ownedRoot,
                capacityReservationFile: reservation?.activeFile,
                capacityReservationId: reservation?.receipt.reservationId,
                repositoryLeasePath: lease?.leasePath,
                reason: 'physical terminal does not verify zero residue; active resources preserved' };
            retainExecutionRecovery(diagnosticOwner, recoveryObligation);
            retainExecutionFailureCompatibility(firstFailure, 'recoveryObligation', recoveryObligation);
        }
        if (mayCleanup && directories && !directories.fragment.cleanup.removedOwnedRoot)
        {
            cleanup(() => finalizeRunOwnedDirectories(directories));
        }
        if (mayCleanup && !complete && attemptRoot)
        {
            cleanup(() =>
            {
                const writable = (directory) =>
                {
                    fs.chmodSync(directory, 0o700);
                    for (const name of fs.readdirSync(directory))
                    {
                        const child = path.join(directory, name);
                        const stat = fs.lstatSync(child);
                        if (stat.isDirectory() && !stat.isSymbolicLink())
                        {
                            writable(child);
                        }
                    }
                };
                writable(attemptRoot);
                fs.rmSync(attemptRoot, { recursive: true });
            });
        }
        // recovery-required is only an original release label; it does not hold capacity.
        // Unknown residue must retain both existing authorities, not release quota underneath live children.
        if (mayCleanup)
        {
            cleanup(() => reservation?.release(complete ? 'released' : 'recovery-required'));
            cleanup(() => lease?.release(complete ? 'complete' : controller.signal.aborted ? 'cancelled' : 'failed'));
        }
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
        if (cleanupFailure)
        {
            retainExecutionFailure(diagnosticOwner, cleanupFailure);
            if (operationFailed)
            {
                retainExecutionFailureCompatibility(firstFailure, 'cleanupError', cleanupFailure);
            }
            else
            {
                throw cleanupFailure;
            }
        }
    }
    if (operationFailed)
    {
        throw observeExecutionFailure(diagnosticOwner).reason;
    }
    return preparationResult;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const args = process.argv.slice(2);
    let purpose = 'behavior-doc';
    if (args.length === 10 && args[8] === '--purpose')
    {
        purpose = args.splice(8)[1];
    }
    if (args.length !== 8 || args[0] !== '--run-id' || args[2] !== '--out'
        || args[4] !== '--feed-root' || args[6] !== '--feed-digest')
    {
        throw new Error('Usage: prepare-behavior-doc-nuget.mjs --run-id id --out input.json --feed-root sealed-flat-nupkg-feed --feed-digest sha256 [--purpose behavior-doc|matrix-native]');
    }
    await prepareBehaviorDocNuget({ repositoryRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
        runId: args[1], outputFile: args[3], feedRoot: args[5], feedDigest: args[7], purpose });
}
