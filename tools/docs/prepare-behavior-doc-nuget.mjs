#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { behaviorDocNugetClosure, behaviorDocNugetFeedConfiguration, inventoryNugetOfflineFeed, inventoryPreparedNuget, validatePreparedNugetPackages } from '../test/behavior-doc-nuget-preparation.mjs';
import { finalizeRunOwnedDirectories, prepareRunOwnedDirectories } from '../test/execution-envelope-directories.mjs';
import { observeExecutableIdentity, prepareCorrectnessEnvironment, verifyExecutableIdentity } from '../test/execution-envelope-environment.mjs';
import { finalizeNetworkSandbox, loadExecutionNetworkPolicy, prepareNetworkSandbox } from '../test/execution-envelope-network.mjs';
import { runPhysicalExecution } from '../test/physical-execution-process-tree.mjs';
import { fingerprintPaths, runBoundExecution, validateRunBoundProjection } from '../test/run-once.mjs';
import { sealSourceIdentity } from '../fact-extractors/identity.mjs';
import { loadExecutionEnvelopeApplicability, loadExecutionEnvelopePolicy } from '../test-matrix/execution-envelope-policy.mjs';
import { bindBehaviorDocNugetPreparationDiskDemand, buildProductionDiskDemandPlan, defaultProductionDiskRoots, readProductionDiskDemandCatalog } from '../test-matrix/production-disk-demand.mjs';
import { acquireProductionCapacityReservation } from '../test-matrix/production-capacity-reservation.mjs';
import { acquireProductionFreshExclusiveLease } from '../test-matrix/production-fresh-exclusive-lease.mjs';
import { snapshotSourceState } from '../test-matrix/scheduler.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Independent, offline dependency preparation only; no correctness admission is generated here. */
export async function prepareBehaviorDocNuget({ repositoryRoot, runId, outputFile, feedRoot, feedDigest })
{
    if (!String(runId ?? '').trim()) throw new Error('NuGet preparation requires an explicit scheduler run');
    const root = fs.realpathSync(repositoryRoot);
    const source = sealSourceIdentity(root);
    const closure = behaviorDocNugetClosure(root);
    const preparationParent = path.join(root, '.tmp/behavior-doc-nuget-preparation');
    const output = path.resolve(outputFile);
    if (!output.startsWith(preparationParent + path.sep))
    { throw new Error('NuGet preparation descriptor must stay inside its preparation owner'); }
    fs.mkdirSync(preparationParent, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(preparationParent) !== preparationParent)
    { throw new Error('NuGet preparation parent must be canonical'); }
    const feed = inventoryNugetOfflineFeed(feedRoot, closure, Number(fs.statfsSync(preparationParent).bsize));
    if (feed.treeDigest !== feedDigest) throw new Error('Explicit offline feed digest drifted');
    const controller = new AbortController();
    const abort = (value) => controller.abort(Object.assign(new Error(`NuGet preparation cancelled: ${value}`),
        { name: 'AbortError', signal: value }));
    const onSigint = () => abort('SIGINT');
    const onSigterm = () => abort('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    let lease, reservation, directories, attemptRoot, firstFailure = null;
    let physicalStarted = false, terminalEvidence = null;
    let complete = false;
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
        for (const directory of [packagesRoot, artifactsRoot, stagedFeed]) fs.mkdirSync(directory, { mode: 0o700 });
        for (const entry of feed.entries)
        {
            if (controller.signal.aborted) throw controller.signal.reason;
            const original = path.join(feed.root, entry.path);
            const stat = fs.lstatSync(original);
            if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o222)
                || fs.realpathSync(original) !== original)
            { throw new Error('Offline feed file ceased to be a sealed regular input'); }
            const bytes = fs.readFileSync(original);
            if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
            { throw new Error('Offline feed bytes drifted before staging'); }
            fs.writeFileSync(path.join(stagedFeed, entry.path), bytes, { flag: 'wx', mode: entry.mode });
            await new Promise((resolve) => setImmediate(resolve));
        }
        fs.chmodSync(stagedFeed, 0o555);
        if (inventoryNugetOfflineFeed(stagedFeed, closure).treeDigest !== feed.treeDigest
            || inventoryNugetOfflineFeed(feed.root, closure).treeDigest !== feed.treeDigest)
        { throw new Error('Offline feed copy or source drifted'); }
        fs.writeFileSync(configFile, behaviorDocNugetFeedConfiguration({ feedRoot: stagedFeed, packagesRoot }),
            { flag: 'wx', mode: 0o400 });
        const command = ['dotnet', 'restore', 'tools/contracts/BehaviorDocRestore.slnx',
            '--locked-mode', '--packages', packagesRoot, '--artifacts-path', artifactsRoot,
            '/p:NuGetAudit=false', '/p:Configuration=Release', '--disable-parallel', '--source', stagedFeed,
            '--configfile', configFile];
        const outputContract = [artifactsRoot, stagedFeed, packagesRoot, configFile].sort();
        const key = 'behavior-doc-nuget-transfer-' + randomUUID();
        directories = prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root, runId,
            producerId: 'behavior-doc-static-admission', attemptId: key, outputs: [packagesRoot, artifactsRoot] });
        const environment = prepareCorrectnessEnvironment({ command, parentEnvironment: process.env,
            producerAllowlist: ['DOTNET_ROOT', 'PATH'],
            injectedEnvironment: { ...directories.environment, NUGET_PACKAGES: packagesRoot,
                FSUSBLOG_TEST_RUN_ID: runId, FSUSBLOG_TEST_SOURCE_COMMIT: source.sourceCommit,
                FSUSBLOG_TEST_SOURCE_FINGERPRINT: source.worktreeFingerprint },
            policy: loadExecutionEnvelopePolicy(), catalog: loadExecutionEnvelopeApplicability() });
        const network = prepareNetworkSandbox({ command: environment.command, cwd: root,
            directories: directories.fragment.directories, writableRoots: directories.fragment.writableRoots,
            plannedEndpoints: [], environment: environment.environment, policy: loadExecutionNetworkPolicy() });
        const toolchain = environment.fragment.actualExecutable;
        const physicalRoot = path.join(root, '.tmp/physical-executions');
        const inputDigest = await fingerprintPaths(
            [...closure.sourceClosureDigests.map((value) => value.path),
                'tools/contracts/BehaviorDocRestore.slnx', 'tools/docs/prepare-behavior-doc-nuget.mjs',
                'tools/test/behavior-doc-nuget-preparation.mjs', feed.root, configFile],
            { root, values: [JSON.stringify(source), JSON.stringify(command), JSON.stringify(toolchain),
                feed.treeDigest, digest(directories.fragment), digest(network.fragment), environment.fragmentDigest,
                plan.planDigest] });
        const result = await runBoundExecution({ root: physicalRoot, runId, key, command, cwd: root, inputDigest,
            environmentDigest: digest({ environment: environment.fragment, directories: directories.fragment, network: network.fragment }),
            outputContract, requiredOutputs: outputContract,
            commit: source.sourceCommit, worktreeFingerprint: source.worktreeFingerprint,
            consumerId: 'behavior-doc-nuget-transfer', signal: controller.signal
        }, async () =>
        {
            let physicalExecution, failure = null, actualNetwork, actualDirectories;
            try
            {
                if (controller.signal.aborted) throw controller.signal.reason;
                if (JSON.stringify(sealSourceIdentity(root)) !== JSON.stringify(source)
                    || inventoryNugetOfflineFeed(feed.root, closure).treeDigest !== feed.treeDigest
                    || inventoryNugetOfflineFeed(stagedFeed, closure).treeDigest !== feed.treeDigest)
                { throw new Error('Source or offline feed drifted before physical restore'); }
                physicalStarted = true;
                physicalExecution = await runPhysicalExecution({ command: network.command, cwd: root,
                    env: environment.environment, signal: controller.signal,
                    linuxPrivateNetwork: network.linuxPrivateNetwork, linuxNetworkPolicy: network.linuxNetworkPolicy,
                    linuxReadWritePaths: network.linuxReadWritePaths });
            }
            catch (error) { failure = error; physicalExecution = error.physicalExecution; }
            terminalEvidence = physicalExecution;
            try { actualNetwork = finalizeNetworkSandbox(network); }
            catch (error) { if (failure) failure.cleanupError = error; else failure = error; }
            if (!physicalStarted || physicalExecution?.postObservation === 'zero-members')
            {
                try { actualDirectories = finalizeRunOwnedDirectories(directories); }
                catch (error) { if (failure) failure.cleanupError ??= error; else failure = error; }
            }
            else failure ??= Object.assign(new Error('NuGet preparation has no verified zero-residue terminal'), { physicalExecution });
            if (failure) { failure.physicalExecution ??= physicalExecution; throw failure; }
            verifyExecutableIdentity(toolchain, observeExecutableIdentity('dotnet', { pathValue: process.env.PATH }));
            if (JSON.stringify(sealSourceIdentity(root)) !== JSON.stringify(source)
                || inventoryNugetOfflineFeed(feed.root, closure).treeDigest !== feed.treeDigest
                || inventoryNugetOfflineFeed(stagedFeed, closure).treeDigest !== feed.treeDigest)
            { throw Object.assign(new Error('Source, toolchain or offline feed drifted during restore'), { physicalExecution }); }
            const sealTree = (directory) =>
            {
                for (const name of fs.readdirSync(directory))
                {
                    const file = path.join(directory, name);
                    const stat = fs.lstatSync(file);
                    if (stat.isDirectory() && !stat.isSymbolicLink()) sealTree(file);
                    else if (stat.isFile() && stat.nlink === 1) fs.chmodSync(file, stat.mode & 0o555);
                    else throw Object.assign(new Error('NuGet produced linked or nonregular payload'), { physicalExecution });
                }
                fs.chmodSync(directory, 0o555);
            };
            sealTree(packagesRoot);
            try { validatePreparedNugetPackages(inventoryPreparedNuget(packagesRoot), closure); }
            catch (error) { error.physicalExecution = physicalExecution; throw error; }
            reservation.completeProducer('behavior-doc-nuget-preparation');
            return { ...physicalExecution, phase: 'independent-dependency-transfer', qualificationEligible: false,
                command, toolchain, offlineFeed: { root: stagedFeed, sourceRoot: feed.root, treeDigest: feed.treeDigest,
                    allocatedBytes: feed.allocatedBytes, expandedAllocatedBytes: feed.expandedAllocatedBytes },
                executionEnvelopeFragments: { environment: environment.fragment, network: actualNetwork, directories: actualDirectories },
                capacityPlanDigest: plan.planDigest };
        });
        const transfer = { root: physicalRoot, runId, key, consumerId: 'behavior-doc-nuget-transfer',
            projectionFile: result.projectionFile, receiptFile: result.receiptFile };
        const verified = await validateRunBoundProjection({ ...transfer, verifyOutputs: true });
        const seed = inventoryPreparedNuget(packagesRoot);
        const preparation = { source, closure, root: packagesRoot, artifactsRoot, feedRoot: stagedFeed, configFile,
            treeDigest: seed.treeDigest, transfer: { ...transfer, receiptDigest: verified.receipt.receiptDigest } };
        fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
        if (fs.realpathSync(path.dirname(output)) !== path.dirname(output))
        { throw new Error('NuGet preparation descriptor parent is not canonical'); }
        fs.writeFileSync(output, JSON.stringify(preparation, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
        complete = true;
        return preparation;
    }
    catch (error) { firstFailure = error; throw error; }
    finally
    {
        let cleanupFailure = null;
        const cleanup = (operation) =>
        {
            try { operation(); } catch (error) { cleanupFailure ??= error; }
        };
        const mayCleanup = !physicalStarted || terminalEvidence?.postObservation === 'zero-members';
        if (!mayCleanup && firstFailure)
            firstFailure.recoveryObligation = { attemptRoot, ownedRoot: directories?.fragment.ownedRoot,
                capacityReservationFile: reservation?.activeFile,
                capacityReservationId: reservation?.receipt.reservationId,
                repositoryLeasePath: lease?.leasePath,
                reason: 'physical terminal does not verify zero residue; active resources preserved' };
        if (mayCleanup && directories && !directories.fragment.cleanup.removedOwnedRoot)
            cleanup(() => finalizeRunOwnedDirectories(directories));
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
                        if (stat.isDirectory() && !stat.isSymbolicLink()) writable(child);
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
            if (firstFailure) firstFailure.cleanupError ??= cleanupFailure;
            else throw cleanupFailure;
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const args = process.argv.slice(2);
    if (args.length !== 8 || args[0] !== '--run-id' || args[2] !== '--out'
        || args[4] !== '--feed-root' || args[6] !== '--feed-digest')
    { throw new Error('Usage: prepare-behavior-doc-nuget.mjs --run-id id --out input.json --feed-root sealed-flat-nupkg-feed --feed-digest sha256'); }
    await prepareBehaviorDocNuget({ repositoryRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
        runId: args[1], outputFile: args[3], feedRoot: args[5], feedDigest: args[7] });
}
