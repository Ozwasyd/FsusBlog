#!/usr/bin/env node
import { createExecutionFailureOwner, observeExecutionFailure, retainExecutionFailure, retainExecutionRecovery, throwExecutionFailure, formatExecutionFailure } from '../test/execution-failure-diagnostic.mjs';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nugetPreparationClosure, nugetPreparationDeclaration, nugetPreparationCommand, observeNugetPreparationToolchain, observeNugetInputFile, requireNugetResourceChannel, behaviorDocNugetFeedConfiguration, inventoryNugetOfflineFeed, inventoryPreparedNuget, validatePreparedNugetPackages } from '../test/behavior-doc-nuget-preparation.mjs';
import { finalizeRunOwnedDirectories, prepareRunOwnedDirectories } from '../test/execution-envelope-directories.mjs';
import { observeExecutableIdentityAsync, prepareCorrectnessEnvironmentAsync, verifyExecutableIdentity } from '../test/execution-envelope-environment.mjs';
import { finalizeNetworkSandbox, loadExecutionNetworkPolicy, prepareNetworkSandboxAsync } from '../test/execution-envelope-network.mjs';
import { runPhysicalExecution, observePhysicalExecutionFailure } from '../test/physical-execution-process-tree.mjs';
import { fingerprintPaths, runBoundExecution, validateRunBoundProjection } from '../test/run-once.mjs';
import { sealSourceIdentity } from '../fact-extractors/identity.mjs';
import { loadExecutionEnvelopeApplicability, loadExecutionEnvelopePolicy } from '../test-matrix/execution-envelope-policy.mjs';
import { bindBehaviorDocNugetPreparationDiskDemand, buildProductionDiskDemandPlan, defaultProductionDiskRoots, readProductionDiskDemandCatalog } from '../test-matrix/production-disk-demand.mjs';
import { acquireProductionCapacityReservation } from '../test-matrix/production-capacity-reservation.mjs';
import { acquireProductionFreshExclusiveLease } from '../test-matrix/production-fresh-exclusive-lease.mjs';
import { snapshotSourceState } from '../test-matrix/scheduler.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Independent, offline dependency preparation only; no correctness admission is generated here. */
export async function prepareBehaviorDocNuget({ repositoryRoot, runId, outputFile, feedRoot, feedDigest, purpose = 'behavior-doc', parentOwner = null, failureOwner = createExecutionFailureOwner() })
{
    if (!String(runId ?? '').trim()) throw new Error('NuGet preparation requires an explicit scheduler run');
    const root = fs.realpathSync(repositoryRoot);
    const source = sealSourceIdentity(root);
    const declaration = nugetPreparationDeclaration(purpose);
    const closure = nugetPreparationClosure(root, purpose);
    const sdk = observeNugetPreparationToolchain(root, purpose);
    const preparationParent = path.join(root, '.tmp/' + declaration.owner);
    const output = path.resolve(outputFile);
    if (!output.startsWith(preparationParent + path.sep))
    { throw new Error('NuGet preparation descriptor must stay inside its preparation owner'); }
    let allocationAncestor = preparationParent;
    while (!fs.existsSync(allocationAncestor)) allocationAncestor = path.dirname(allocationAncestor);
    if (fs.realpathSync(allocationAncestor) !== allocationAncestor)
        throw new Error('NuGet preparation parent must be canonical');
    const feed = inventoryNugetOfflineFeed(feedRoot, closure, Number(fs.statfsSync(allocationAncestor).bsize));
    if (feed.treeDigest !== feedDigest) throw new Error('Explicit offline feed digest drifted');
    const controller = new AbortController();
    const abort = (value) => controller.abort(Object.assign(new Error(`NuGet preparation cancelled: ${value}`),
        { name: 'AbortError', signal: value }));
    const onSigint = () => abort('SIGINT');
    const onSigterm = () => abort('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    let lease, reservation, directories, attemptRoot, preparationOwner;
    let physicalStarted = false, terminalEvidence = null;
    let complete = false;
    try
    {
        // This dependency phase uses the existing candidate/resource lease, not a new controller or qualification.
        const sourceState = await snapshotSourceState(root);
        const parentModule = parentOwner ? await import('../test/nuget-preparation-owner.mjs') : null;
        const parentExecution = parentOwner ? parentModule.requireNugetPreparationExecution(parentOwner,
            { root, runId, purpose, producerId: declaration.owner }) : null;
        if (!parentExecution)
            throw new Error('NuGet preparation requires its complete original same-process managed owner; nested preparation protocol activation is pending');
        const executionSignal = parentExecution ? AbortSignal.any([controller.signal, parentExecution.physicalOptions.signal]) : controller.signal;
        const parentSdk = purpose === 'behavior-doc' ? parentExecution?.sdk ?? null : null;
        const resourceReference = parentExecution?.resourceReference
            ?? await requireNugetResourceChannel({ root, runId, sourceState });
        const assertInputs = () =>
        {
            executionSignal.throwIfAborted();
            if (parentOwner) parentModule.assertNugetManagedPreparationAdmission(parentOwner,
                { root, runId, purpose, producerId: declaration.owner });
            if (JSON.stringify(sealSourceIdentity(root)) !== JSON.stringify(source)
                || JSON.stringify(nugetPreparationClosure(root, purpose)) !== JSON.stringify(closure)
                || JSON.stringify(observeNugetPreparationToolchain(root, purpose)) !== JSON.stringify(sdk)
                || inventoryNugetOfflineFeed(feed.root, closure).treeDigest !== feed.treeDigest)
                throw new Error('NuGet preparation source, toolchain or finite feed drifted');
        };
        assertInputs();
        let plan;
        if (parentExecution)
        {
            ({ lease, reservation, plan } = parentExecution);
        }
        else
        {
            lease = acquireProductionFreshExclusiveLease({
                root, runId, targetTierId: 'production-correctness', sourceState
            });
            const catalog = bindBehaviorDocNugetPreparationDiskDemand(readProductionDiskDemandCatalog(root), feed, purpose);
            plan = buildProductionDiskDemandPlan({ root,
                tiers: [{ id: declaration.owner, executionDependsOn: [], exclusiveResources: [] }],
                maxParallel: 1, catalog, roots: {
                    ...defaultProductionDiskRoots(root, { includeDockerStorage: false }),
                    behaviorDocNugetPreparationRoot: preparationParent
                } });
            reservation = acquireProductionCapacityReservation({ plan, runId,
                candidateIdentityDigest: lease.owner.candidateIdentityDigest,
                repositoryRoot: root, repositoryLeaseOwner: lease.owner });
            reservation.guardProducer(declaration.owner);
        }
        assertInputs();
        fs.mkdirSync(preparationParent, { recursive: true, mode: 0o700 });
        if (fs.realpathSync(preparationParent) !== preparationParent) throw new Error('Preparation owner drifted');
        attemptRoot = fs.mkdtempSync(path.join(preparationParent, 'transfer-'));
        const packagesRoot = path.join(attemptRoot, 'packages');
        const artifactsRoot = path.join(attemptRoot, 'artifacts');
        const stagedFeed = path.join(attemptRoot, 'feed');
        const configFile = path.join(attemptRoot, 'NuGet.Config');
        for (const directory of [packagesRoot, artifactsRoot, stagedFeed]) fs.mkdirSync(directory, { mode: 0o700 });
        for (const entry of feed.entries)
        {
            if (parentOwner) assertInputs();
            if (executionSignal.aborted) throw executionSignal.reason;
            const original = path.join(feed.root, entry.path);
            const stat = fs.lstatSync(original);
            if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o222)
                || fs.realpathSync(original) !== original)
            { throw new Error('Offline feed file ceased to be a sealed regular input'); }
            const bytes = fs.readFileSync(original);
            if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
            { throw new Error('Offline feed bytes drifted before staging'); }
            if (parentOwner) assertInputs();
            fs.writeFileSync(path.join(stagedFeed, entry.path), bytes, { flag: 'wx', mode: entry.mode });
            await new Promise((resolve) => setImmediate(resolve));
        }
        fs.chmodSync(stagedFeed, 0o555);
        if (inventoryNugetOfflineFeed(stagedFeed, closure).treeDigest !== feed.treeDigest
            || inventoryNugetOfflineFeed(feed.root, closure).treeDigest !== feed.treeDigest)
        { throw new Error('Offline feed copy or source drifted'); }
        fs.writeFileSync(configFile, behaviorDocNugetFeedConfiguration({ feedRoot: stagedFeed, packagesRoot }),
            { flag: 'wx', mode: 0o400 });
        const command = nugetPreparationCommand({ purpose, packagesRoot, artifactsRoot,
            feedRoot: stagedFeed, configFile, toolchain: sdk });
        const outputContract = [artifactsRoot, stagedFeed, packagesRoot, configFile].sort();
        const key = declaration.transfer + '-' + randomUUID();
        directories = prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root, runId,
            producerId: declaration.consumers[0], attemptId: key, outputs: [packagesRoot, artifactsRoot],
            assertPreparationAdmission: assertInputs });
        preparationOwner = parentModule.createNugetManagedPreparationOwner(parentOwner, {
            expected: { root, runId, purpose, producerId: declaration.owner }, directories, signal: executionSignal });
        const environment = await prepareCorrectnessEnvironmentAsync({ command, cwd: root, parentEnvironment: process.env,
            producerAllowlist: purpose === 'behavior-doc' ? ['DOTNET_ROOT', 'PATH'] : ['PATH'],
            injectedEnvironment: { ...directories.environment, NUGET_PACKAGES: packagesRoot,
                FSUSBLOG_TEST_RUN_ID: runId, FSUSBLOG_TEST_SOURCE_COMMIT: source.sourceCommit,
                FSUSBLOG_TEST_SOURCE_FINGERPRINT: source.worktreeFingerprint },
            policy: loadExecutionEnvelopePolicy(), catalog: loadExecutionEnvelopeApplicability(), ...preparationOwner });
        assertInputs();
        const network = await prepareNetworkSandboxAsync({ command: environment.command, cwd: root,
            ownedDirectoryEnvelope: directories,
            directories: directories.fragment.directories, writableRoots: directories.fragment.writableRoots,
            plannedEndpoints: [], environment: environment.environment, policy: loadExecutionNetworkPolicy(),
            signal: executionSignal, ...preparationOwner });
        assertInputs();
        const toolchain = environment.fragment.actualExecutable;
        const physicalRoot = path.join(root, '.tmp/physical-executions');
        const inputDigest = await fingerprintPaths(
            [...closure.sourceClosureDigests.map((value) => value.path),
                declaration.solution, 'tools/docs/prepare-behavior-doc-nuget.mjs',
                'tools/test/behavior-doc-nuget-preparation.mjs', feed.root, configFile],
            { root, values: [JSON.stringify(source), JSON.stringify(command), JSON.stringify(toolchain),
                feed.treeDigest, digest(directories.fragment), digest(network.fragment), environment.fragmentDigest,
                plan.planDigest, JSON.stringify(sdk), JSON.stringify(parentSdk), JSON.stringify(resourceReference)] });
        const result = await runBoundExecution({ root: physicalRoot, runId, key, command, cwd: root, inputDigest,
            environmentDigest: digest({ environment: environment.fragment, directories: directories.fragment, network: network.fragment }),
            outputContract, requiredOutputs: outputContract,
            commit: source.sourceCommit, worktreeFingerprint: source.worktreeFingerprint,
            consumerId: declaration.transfer, signal: executionSignal, failureOwner
        }, async () =>
        {
            let physicalExecution, actualNetwork, actualDirectories;
            try
            {
                if (parentOwner) assertInputs();
                if (executionSignal.aborted) throw executionSignal.reason;
                if (JSON.stringify(sealSourceIdentity(root)) !== JSON.stringify(source)
                    || inventoryNugetOfflineFeed(feed.root, closure).treeDigest !== feed.treeDigest
                    || inventoryNugetOfflineFeed(stagedFeed, closure).treeDigest !== feed.treeDigest)
                { throw new Error('Source or offline feed drifted before physical restore'); }
                assertInputs();
                if (parentOwner) parentModule.requireNugetPreparationExecution(parentOwner,
                    { root, runId, purpose, producerId: declaration.owner });
                else await requireNugetResourceChannel({ root, runId, sourceState, expectedReference: resourceReference });
                assertInputs();
                physicalStarted = true;
                physicalExecution = await runPhysicalExecution({
                    ...(parentExecution ? parentExecution.physicalOptions : {}),
                    failureOwner, command: network.command, cwd: root,
                    env: environment.environment, signal: executionSignal,
                    linuxPrivateNetwork: network.linuxPrivateNetwork, linuxNetworkPolicy: network.linuxNetworkPolicy,
                    linuxReadWritePaths: network.linuxReadWritePaths,
                    linuxOwnedPrivateTmp: network.linuxOwnedPrivateTmp });
            }
            catch (error) { retainExecutionFailure(failureOwner, error); physicalExecution = observePhysicalExecutionFailure(failureOwner).physicalExecution; }
            terminalEvidence = physicalExecution;
            try { actualNetwork = finalizeNetworkSandbox(network); }
            catch (error) { retainExecutionFailure(failureOwner, error); }
            throwExecutionFailure(failureOwner);
            const observedExecutable = await observeExecutableIdentityAsync(command[0], {
                pathValue: environment.environment.PATH, cwd: root, environment: environment.environment, ...preparationOwner });
            assertInputs();
            verifyExecutableIdentity(toolchain, observedExecutable);
            try
            {
                preparationOwner.assertFinalizablePreparation();
                if (observePhysicalExecutionFailure(failureOwner).physicalTerminal !== 'zero-members')
                    throw new Error('NuGet preparation has no verified zero-residue terminal');
                actualDirectories = finalizeRunOwnedDirectories(directories);
            }
            catch (error) { retainExecutionFailure(failureOwner, error); }
            throwExecutionFailure(failureOwner);
            if (JSON.stringify(sealSourceIdentity(root)) !== JSON.stringify(source)
                || inventoryNugetOfflineFeed(feed.root, closure).treeDigest !== feed.treeDigest
                || inventoryNugetOfflineFeed(stagedFeed, closure).treeDigest !== feed.treeDigest)
            { throw Object.assign(new Error('Source, toolchain or offline feed drifted during restore'), { physicalExecution }); }
            assertInputs();
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
            try { validatePreparedNugetPackages(inventoryPreparedNuget(packagesRoot), closure, feed); }
            catch (error) { retainExecutionFailure(failureOwner, error); throwExecutionFailure(failureOwner); }
            if (!parentOwner) reservation.completeProducer(declaration.owner);
            return { ...physicalExecution, phase: 'independent-dependency-transfer', qualificationEligible: false,
                command, toolchain, sdk, ...(parentSdk ? { parentSdk } : {}), resourceReference, schedulerSource: sourceState, offlineFeed: { root: stagedFeed, sourceRoot: feed.root, treeDigest: feed.treeDigest,
                    allocatedBytes: feed.allocatedBytes, expandedAllocatedBytes: feed.expandedAllocatedBytes },
                executionEnvelopeFragments: { environment: environment.fragment, network: actualNetwork, directories: actualDirectories },
                capacityPlanDigest: plan.planDigest };
        });
        const transfer = { root: physicalRoot, runId, key, consumerId: declaration.transfer,
            projectionFile: result.projectionFile, receiptFile: result.receiptFile };
        const verifiedIdentity = [result.receiptFile, result.projectionFile].map(observeNugetInputFile);
        const verified = await validateRunBoundProjection({ ...transfer, verifyOutputs: true });
        if (verifiedIdentity[0].sha256 !== createHash('sha256').update(verified.receiptBytes).digest('hex')
            || verifiedIdentity[1].sha256 !== createHash('sha256').update(verified.projectionBytes).digest('hex'))
            throw new Error('Preparation transfer verification consumed foreign bytes');
        assertInputs();
        if (JSON.stringify(await snapshotSourceState(root)) !== JSON.stringify(sourceState))
            throw new Error('Scheduler source drifted before preparation publication');
        assertInputs();
        const seed = inventoryPreparedNuget(packagesRoot);
        const preparation = { purpose, ...(parentSdk ? { parentSdk } : {}), schedulerSource: sourceState, source, closure, root: packagesRoot, artifactsRoot, feedRoot: stagedFeed, configFile,
            treeDigest: seed.treeDigest, transfer: { ...transfer, receiptDigest: verified.receipt.receiptDigest } };
        fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
        if (fs.realpathSync(path.dirname(output)) !== path.dirname(output))
        { throw new Error('NuGet preparation descriptor parent is not canonical'); }
        assertInputs();
        if (JSON.stringify(verifiedIdentity) !== JSON.stringify([result.receiptFile, result.projectionFile].map(observeNugetInputFile)))
            throw new Error('Transfer bytes or identity drifted before preparation publication');
        fs.writeFileSync(output, JSON.stringify(preparation, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
        complete = true;
        return parentOwner ? { preparation, physicalExecution: terminalEvidence } : preparation;
    }
    catch (error)
    {
        retainExecutionFailure(failureOwner, error);
        throwExecutionFailure(failureOwner);
    }
    finally
    {
        let cleanupFailed = false;
        const cleanup = (operation) =>
        {
            try { operation(); } catch (error) { cleanupFailed = true; retainExecutionFailure(failureOwner, error); }
        };
        const observation = observePhysicalExecutionFailure(failureOwner);
        let mayCleanup = !observation.physicalStarted || observation.physicalTerminal === 'zero-members';
        if (preparationOwner && mayCleanup)
        {
            try { preparationOwner.assertFinalizablePreparation(); }
            catch (error) { mayCleanup = false; cleanupFailed = true; retainExecutionFailure(failureOwner, error); }
        }
        if (!mayCleanup)
            retainExecutionRecovery(failureOwner, { attemptRoot, ownedRoot: directories?.fragment.ownedRoot,
                capacityReservationFile: reservation?.activeFile,
                capacityReservationId: reservation?.receipt.reservationId,
                repositoryLeasePath: lease?.leasePath,
                reason: 'physical terminal does not verify zero residue; active resources preserved' });
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
        if (mayCleanup && !parentOwner)
        {
            cleanup(() => reservation?.release(complete ? 'released' : 'recovery-required'));
            if (!cleanupFailed) cleanup(() => lease?.release(complete ? 'complete' : controller.signal.aborted ? 'cancelled' : 'failed'));
        }
        if (cleanupFailed) retainExecutionRecovery(failureOwner, { attemptRoot, ownedRoot: directories?.fragment.ownedRoot,
            capacityReservationFile: reservation?.activeFile, repositoryLeasePath: lease?.leasePath,
            reason: 'original cleanup or release unverified; recovery records retained' });
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
        // eslint-disable-next-line no-unsafe-finally
        throwExecutionFailure(failureOwner);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    let args = process.argv.slice(2);
    let purpose = 'behavior-doc';
    if (args[0] === '--purpose')
    {
        if (args[1] !== 'matrix-governance') throw new Error('Only the fixed matrix purpose may be explicitly selected');
        purpose = args[1]; args = args.slice(2);
    }
    if (args.length !== 8 || args[0] !== '--run-id' || args[2] !== '--out'
        || args[4] !== '--feed-root' || args[6] !== '--feed-digest')
    { throw new Error('Usage: prepare-behavior-doc-nuget.mjs --run-id id --out input.json --feed-root sealed-flat-nupkg-feed --feed-digest sha256'); }
    const failureOwner = createExecutionFailureOwner();
    try
    {
        await prepareBehaviorDocNuget({ repositoryRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
            runId: args[1], outputFile: args[3], feedRoot: args[5], feedDigest: args[7], purpose, failureOwner });
    }
    catch (reason)
    {
        retainExecutionFailure(failureOwner, reason);
        console.error(`[nuget-preparation] ${formatExecutionFailure(reason, failureOwner)}`);
        process.exitCode = 1;
    }
}
