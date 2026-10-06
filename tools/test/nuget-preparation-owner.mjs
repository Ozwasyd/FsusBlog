import { createExecutionFailureOwner, observeExecutionFailure, retainExecutionFailure, retainExecutionRecovery, throwExecutionFailure } from './execution-failure-diagnostic.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sealSourceIdentity } from '../fact-extractors/identity.mjs';
import { snapshotSourceState, runDag } from '../test-matrix/scheduler.mjs';
import { acquireProductionFreshExclusiveLease, assertProductionFreshExclusiveLease } from '../test-matrix/production-fresh-exclusive-lease.mjs';
import { acquireProductionCapacityReservation, assertProductionCapacityReservation } from '../test-matrix/production-capacity-reservation.mjs';
import { bindBehaviorDocNugetPreparationDiskDemand, bindNugetParentControlDiskDemand, bindMatrixNugetDiskDemand,
    readProductionDiskDemandCatalog, buildProductionDiskDemandPlan, defaultProductionDiskRoots, canonicalFilesystemIdentity } from '../test-matrix/production-disk-demand.mjs';
import { runProductionBuildLifecycle } from '../test-matrix/production-build-lifecycle.mjs';
import { bindProductionBuildLayoutSource, retainProductionBuildResourceBoundary, retainProductionBuildServiceContainment,
    markProductionBuildServiceCreationAttempt, registerProductionBuildCompiler, validateProductionRunId } from '../test-matrix/production-build-layout.mjs';
import { loadPhysicalExecutionProcessPolicy, observePhysicalExecutionFailure, runPhysicalExecution } from './physical-execution-process-tree.mjs';
import { readProductionSystemdResourceBoundaryBinding, assertProductionSystemdExecutionBoundary, createSystemdResourceTransport, inspectProductionSystemdServiceBinding } from '../test-matrix/production-systemd-resource-boundary.mjs';
import { nugetPreparationDeclaration, nugetPreparationClosure, observeNugetPreparationToolchain,
    inventoryNugetOfflineFeed, readPreparedNuget } from './behavior-doc-nuget-preparation.mjs';
import { inspectOwnedPrivateTmp, inspectOwnedPreparationOutputs } from './execution-envelope-directories.mjs';
import { prepareNetworkBindings } from './execution-envelope-network.mjs';
import { managedPreparationPurposes, versionArguments, resolveExecutablePath } from './execution-envelope-environment.mjs';
import { Writable } from 'node:stream';
import { matrixGovernanceArguments } from './matrix-governance-command.mjs';

const ownerRepositoryRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const owners = new WeakMap();
const sdkIdentity = (sdk) => createHash('sha256').update(JSON.stringify(sdk)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const command = (argv) => argv.map(quote).join(' ');
const parentSources = ['tools/docs/run-nuget-preparation.mjs', 'tools/test/nuget-preparation-owner.mjs',
    'tools/test/matrix-governance-command.mjs', 'tools/test/run-deterministic-command.mjs', 'tools/test/run-once.mjs',
    'tools/test-matrix/scheduler.mjs', 'tools/test-matrix/production-fresh-exclusive-lease.mjs',
    'tools/test-matrix/production-capacity-reservation.mjs', 'tools/test-matrix/production-disk-demand.mjs',
    'tools/test-matrix/production-build-lifecycle.mjs', 'tools/test-matrix/production-build-layout.mjs',
    'tools/test-matrix/production-resource-enforcement.mjs', 'tools/test-matrix/production-systemd-resource-boundary.mjs',
    'tools/test/execution-envelope-environment.mjs', 'tools/test/execution-envelope-network.mjs',
    'tools/test/execution-envelope-directories.mjs', 'tools/test/execution-failure-diagnostic.mjs',
    'tools/test/native/execution-envelope-landlock.c'];

/** An input/disk observation only; the original transport authenticates the native manager. */
function observeNugetSystemdRuntimeRoot(transport)
{
    const runtimeIdentity = transport.runtimeIdentity();
    const runtimeRoot = path.dirname(runtimeIdentity.busSocket.path);
    if (runtimeIdentity.uid !== process.getuid() || runtimeRoot !== `/run/user/${runtimeIdentity.uid}`
        || runtimeIdentity.busSocket.path !== path.join(runtimeRoot, 'bus'))
        throw new Error('NuGet systemd runtime must derive from its original current-UID bus identity');
    const target = path.join(runtimeRoot, 'systemd/transient');
    const directories = [runtimeRoot, path.join(runtimeRoot, 'systemd'), target].map((directory) =>
    {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
            || stat.uid !== runtimeIdentity.uid || (stat.mode & 0o022)
            || (directory === runtimeRoot && (stat.mode & 0o077)))
            throw new Error('NuGet systemd runtime directory must be literal and current-UID owned');
        return { path: directory, device: stat.dev, inode: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode };
    });
    const filesystem = canonicalFilesystemIdentity(target);
    if (filesystem.canonicalPath !== target)
        throw new Error('NuGet systemd runtime filesystem is not its actual transient target');
    return { runtimeIdentity, root: target, directories,
        filesystem: { filesystemIdentity: filesystem.filesystemIdentity, canonicalPath: filesystem.canonicalPath } };
}

/** Only the fixed parent privately constructs this wrapper around its genuine original transport. */
function guardNugetSystemdTransport(transport, guard)
{
    return Object.freeze({ ...transport,
        start(...args) { guard(); return transport.start(...args); },
        startLauncher(...args) { guard(); return transport.startLauncher(...args); },
        setLimits(...args) { guard(); return transport.setLimits(...args); }
        // Original readonly observations and stop remain available for independently owned cleanup.
    });
}

function guardNugetSystemdMutation(capability)
{
    const state = owners.get(capability);
    if (!state) throw new Error('NuGet native mutation requires its original parent');
    liveOwner(capability, { root: state.root, runId: state.runId, purpose: state.purpose, producerId: state.stage.id });
    state.reservations[0].value.guardProducer(state.declaration.owner);
    if (state.reservations.length > 1) state.reservations.at(-1).value.guardProducer(state.stage.id);
}

/** A same-process wrapper only; original owners independently validate their issued objects and current records. */
function liveOwner(capability, { root, runId, purpose, producerId })
{
    const state = owners.get(capability);
    if (!state || state.closed || state.root !== root || state.runId !== runId || state.purpose !== purpose
        || state.stage.id !== producerId)
        throw new Error('NuGet parent capability is foreign, revoked or outside its fixed stage');
    if (state.execution?.signal?.aborted) throw state.execution.signal.reason;
    assertProductionFreshExclusiveLease(state.lease, { root, runId, sourceState: state.sourceState });
    for (const reservation of state.reservations)
        assertProductionCapacityReservation(reservation.value, { plan: reservation.plan, runId,
            repositoryRoot: root, repositoryLeaseOwnerToken: state.lease.owner.ownerToken });
    if (!equal(sealSourceIdentity(root), state.source)
        || !equal(nugetPreparationClosure(root, purpose), state.closure)
        || !equal(observeNugetPreparationToolchain(root, 'matrix-governance'), state.sdk)
        || !equal(observeNugetSystemdRuntimeRoot(state.systemdTransport), state.systemdRuntime)
        || inventoryNugetOfflineFeed(state.feed.root, state.closure).treeDigest !== state.feed.treeDigest)
        throw new Error('NuGet parent source, SDK or archive declaration drifted');
    return state;
}

export function assertNugetPreparationOwner(capability, expected)
{
    liveOwner(capability, expected);
}

export function assertNugetScheduledTier(capability, tier)
{
    const state = owners.get(capability);
    if (!state) throw new Error('NuGet scheduler requires its actual live parent');
    assertNugetPreparationOwner(capability, { root: state.root, runId: state.runId,
        purpose: state.purpose, producerId: tier.id });
    if (!['behavior-doc-nuget-preparation', 'matrix-nuget-preparation', 'matrix-governance', 'validate-matrix'].includes(tier.id)
        || tier.services?.length || tier.residentLeaseProducer || tier.residentLeaseConsumer || tier.physicalBundleId
        || tier.command !== command(state.stage.argv) || !equal(tier.cacheInputs, state.stage.inputs)
        || tier.nugetSdkIdentity !== sdkIdentity(state.sdk)
        || tier.executionDependsOn?.length || state.executing || state.stage.used)
        throw new Error('NuGet scheduler tier differs from its single-use exact declared operation');
}

export function requireNugetPreparationExecution(capability, expected)
{
    const state = liveOwner(capability, expected);
    const execution = state.execution;
    const context = execution?.resourceContext;
    if (!state.executing || !execution?.resourceBoundary || context?.root !== state.root
        || context.runId !== state.runId || context.bundleId !== state.stage.id
        || !equal(context.sourceState, state.sourceState)
        || !equal(execution.resourceBoundary.reference?.context, context))
        throw new Error('NuGet parent lacks its current original scheduled native boundary');
    assertProductionSystemdExecutionBoundary(execution.resourceBoundary, { expectedContext: context });
    if (!execution.processOwner || !['retain', 'beforeCreation', 'register'].every((name) =>
        typeof execution.processOwner[name] === 'function')
        || !Number.isSafeInteger(execution.processOwner.commandBudgetMs) || execution.processOwner.commandBudgetMs <= 0)
        throw new Error('NuGet parent lacks its original retained process-owner ports');
    const binding = readProductionSystemdResourceBoundaryBinding(context, { reference: execution.resourceBoundary.reference });
    if (!equal(binding.owner.runtimeIdentity, state.systemdRuntime.runtimeIdentity))
        throw new Error('NuGet native boundary differs from its reserved original runtime');
    return { lease: state.lease, reservation: state.reservations.at(-1).value,
        plan: state.reservations.at(-1).plan, sdk: structuredClone(state.sdk), physicalOptions: Object.freeze({
            resourceBoundary: execution.resourceBoundary, resourceContext: Object.freeze(structuredClone(execution.resourceContext)),
            processOwner: Object.freeze({ ...execution.processOwner }), residualRoot: execution.residualRoot,
            policy: Object.freeze({ ...execution.policy }), signal: execution.signal,
            stdout: execution.stdout, stderr: execution.stderr }),
        resourceReference: execution.resourceBoundary.reference };
}

/** No new grant: the fixed stage's original owners re-open their real records before preparation effects. */
export function assertNugetManagedPreparationAdmission(capability, expected)
{
    requireNugetPreparationExecution(capability, expected);
    guardNugetSystemdMutation(capability);
}

/** Restore the original complete tool owner inside an already issued same-process fixed stage. */
export function createNugetManagedPreparationOwner(capability, { expected, directories, signal })
{
    const execution = requireNugetPreparationExecution(capability, expected);
    signal = signal ? AbortSignal.any([execution.physicalOptions.signal, signal]) : execution.physicalOptions.signal;
    const state = owners.get(capability);
    assertNugetManagedPreparationAdmission(capability, expected);
    const inspected = inspectOwnedPrivateTmp(directories?.privateTmpCapability);
    if (inspected.runId !== state.runId || inspected.ownedRoot !== directories.fragment.ownedRoot
        || inspected.producerId !== directories.fragment.producerId
        || inspected.attemptId !== directories.fragment.attemptId
        || !(inspected.producerId === state.stage.id
            || state.stage.id === state.declaration.owner && inspected.producerId === state.declaration.consumers[0]))
        throw new Error('managed preparation requires its actual fixed-stage retained directory');
    directories = { fragment: structuredClone(directories.fragment), environment: Object.freeze({ ...directories.environment }),
        privateTmpCapability: directories.privateTmpCapability };
    if (inspected.toolCache !== directories.fragment.directories.toolCache || inspected.source !== directories.fragment.directories.temp
        || Object.values(directories.fragment.directories).some((directory) =>
            fs.realpathSync(directory) !== directory || !directory.startsWith(inspected.ownedRoot + path.sep)))
        throw new Error('managed preparation directory inputs differ from the original retained capability');
    const outputRoots = inspectOwnedPreparationOutputs(directories.privateTmpCapability);
    let transferDirectories = null;
    const transferIdentity = (directory, allowSeal = false) =>
    {
        const stat = fs.lstatSync(directory, { bigint: true });
        const mode = Number(stat.mode & 0o7777n);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
            || stat.uid !== BigInt(process.getuid()) || !(mode === 0o700 || allowSeal && path.basename(directory) === 'packages' && mode === 0o555))
            throw new Error('managed preparation transfer must retain its actual private output directory');
        return { path: directory, device: String(stat.dev), inode: String(stat.ino), uid: String(stat.uid), gid: String(stat.gid) };
    };
    if (state.stage.id === state.declaration.owner)
    {
        const packages = outputRoots.find((directory) => path.basename(directory) === 'packages');
        const artifacts = outputRoots.find((directory) => path.basename(directory) === 'artifacts');
        const transfer = packages && path.dirname(packages);
        if (outputRoots.length !== 2 || !packages || !artifacts || path.dirname(artifacts) !== transfer
            || path.dirname(transfer) !== path.join(state.root, '.tmp', state.declaration.owner)
            || !/^transfer-[A-Za-z0-9]{6}$/u.test(path.basename(transfer)))
            throw new Error('managed preparation requires its exact original transfer packages/artifacts declaration');
        transferDirectories = [transfer, packages, artifacts].map((directory) => transferIdentity(directory));
        directories.environment = Object.freeze({ ...directories.environment, NUGET_PACKAGES: packages });
    }
    const assertTransfer = (allowSeal = false, revalidateAlias = true) =>
    {
        if (revalidateAlias && !equal(inspectOwnedPreparationOutputs(directories.privateTmpCapability), outputRoots))
            throw new Error('managed preparation original output declarations drifted');
        if (transferDirectories && !equal(transferDirectories,
            transferDirectories.map((entry) => transferIdentity(entry.path, allowSeal))))
            throw new Error('managed preparation original transfer output incarnation drifted');
    };
    const requests = new WeakMap();
    const tools = [];
    let closed = false;
    let finalized = false;
    let pending = 0;
    const assertOpen = () =>
    {
        signal?.throwIfAborted();
        if (closed) throw new Error('original managed preparation is closed');
        assertNugetManagedPreparationAdmission(capability, expected);
        inspectOwnedPrivateTmp(directories.privateTmpCapability);
        assertTransfer();
    };
    const derive = (request) =>
    {
        assertTransfer();
        if (!Object.isFrozen(request) || !Object.isFrozen(request.command) || !Object.isFrozen(request.environment)
            || !managedPreparationPurposes.includes(request.purpose) || request.cwd !== state.root
            || request.environment.PATH !== state.execution.env.PATH
            || Object.entries(directories.environment).some(([name, value]) => request.environment[name] !== value)
            || request.environment.FSUSBLOG_TEST_RUN_ID !== state.runId
            || request.environment.FSUSBLOG_TEST_SOURCE_COMMIT !== state.sourceState.commit
            || String(request.environment.FSUSBLOG_TEST_SOURCE_FINGERPRINT).replace(/^sha256:/u, '') !== (state.stage.id === state.declaration.owner ? state.source.worktreeFingerprint : state.sourceState.worktreeFingerprint))
            throw new Error('managed preparation request is foreign to its real source/run owner');
        const executable = request.command[0];
        if (!path.isAbsolute(executable) || fs.realpathSync(executable) !== executable)
            throw new Error('managed preparation requires its canonical executable');
        if (request.purpose === 'executable-version')
        {
            const name = path.basename(executable);
            const selected = ['node', 'cc', 'strace', 'ip', 'msbuild'].flatMap((selector) =>
            {
                try { return [fs.realpathSync(resolveExecutablePath(selector, { pathValue: request.environment.PATH }))]; }
                catch { return []; }
            });
            const helper = path.join(directories.fragment.directories.toolCache, 'execution-envelope-landlock');
            const argumentsExpected = name === 'ip' ? ['-Version'] : versionArguments(executable);
            if (![...selected, state.sdk.executable, helper].includes(executable)
                || !equal(request.command.slice(1), argumentsExpected))
                throw new Error('managed executable version differs from its original fixed selector');
        }
        else
        {
            const target = path.join(directories.fragment.directories.toolCache, 'execution-envelope-landlock');
            const source = path.join(state.root, 'tools/test/native/execution-envelope-landlock.c');
            if (executable !== fs.realpathSync(resolveExecutablePath('cc', { pathValue: request.environment.PATH }))
                || !equal(request.command.slice(1), ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', target, source]))
                throw new Error('managed helper build differs from its original compiler/source/output tuple');
        }
        const bindings = prepareNetworkBindings({ directories: directories.fragment.directories,
            ownedDirectoryEnvelope: directories, writableRoots: [],
            environment: request.environment, producerId: directories.fragment.producerId, attemptId: directories.fragment.attemptId });
        return { command: [...request.command], cwd: request.cwd, env: { ...request.environment },
            linuxPrivateNetwork: true, linuxNetworkPolicy: null, linuxReadWritePaths: bindings.readWritePaths,
            linuxOwnedPrivateTmp: directories.privateTmpCapability, privateDotnetScratch: null };
    };
    const ports = Object.freeze({
        assertPreparationAdmission: assertOpen,
        async assertPreparationExecution({ request, phase, physicalExecution })
        {
            pending++;
            try
            {
                if (phase === 'before') assertOpen();
                // Original grants/records are real same-process values; the await is fenced before any effect.
                if (!equal(await snapshotSourceState(state.root), state.sourceState))
                    throw new Error('managed preparation original source snapshot drifted');
                if (phase === 'before') assertOpen();
                const derived = derive(request);
                if (phase === 'before')
                {
                    if (physicalExecution !== null || requests.has(request)
                        || tools.some((tool) => ['admitting-execution', 'running'].includes(tool.phase)))
                        throw new Error('managed preparation request was already admitted');
                    const tool = { derived, phase: 'admitted', physicalExecution: null, started: false, binding: null, zero: false };
                    requests.set(request, tool); tools.push(tool); return;
                }
                const tool = requests.get(request);
                assertProductionSystemdExecutionBoundary(execution.physicalOptions.resourceBoundary,
                    { expectedContext: execution.physicalOptions.resourceContext });
                if (phase !== 'after' || !tool || tool.phase !== 'terminal' || physicalExecution !== tool.physicalExecution
                    || !equal(derived, tool.derived) || physicalExecution?.postObservation !== 'zero-members'
                    || !equal(physicalExecution.resourceExecutionAdmission?.reference, execution.resourceReference)
                    || !tool.zero || !equal(physicalExecution.resourceExecutionAdmission?.serviceBinding, tool.binding)
                    || !equal(tool.binding, physicalExecution.containmentAuthority?.serviceBinding)
                    || physicalExecution.authority?.networkIsolation !== 'systemd-private-network'
                    || !equal(physicalExecution.authority?.filesystemIsolation?.readWritePaths, tool.derived.linuxReadWritePaths)
                    || inspectProductionSystemdServiceBinding(tool.binding,
                        { commandBudgetMs: execution.physicalOptions.processOwner.commandBudgetMs }).status !== 'absent')
                    throw new Error('managed preparation lacks its original actual absent physical terminal');
                tool.phase = 'verified';
            }
            finally { pending--; }
        },
        async executePreparation(request)
        {
            assertOpen();
            const tool = requests.get(request);
            if (!tool || tool.phase !== 'admitted') throw new Error('managed preparation lacks its single-use actual request');
            tool.phase = 'admitting-execution';
            try
            {
                if (!equal(await snapshotSourceState(state.root), state.sourceState))
                    throw new Error('managed preparation original source snapshot drifted');
                assertOpen();
                if (!equal(derive(request), tool.derived)) throw new Error('managed preparation tuple drifted');
                tool.phase = 'running'; tool.started = true;
                const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
                tool.physicalExecution = await runPhysicalExecution({ ...execution.physicalOptions, ...tool.derived,
                    signal, failureOwner: state.failureOwner, stdout: sink(), stderr: sink() });
                return tool.physicalExecution;
            }
            catch (reason)
            {
                tool.physicalExecution = tool.started ? observePhysicalExecutionFailure(state.failureOwner).physicalExecution : null;
                throw reason;
            }
            finally
            {
                tool.phase = 'terminal';
                tool.zero = tool.started && observePhysicalExecutionFailure(state.failureOwner).physicalTerminal === 'zero-members';
                tool.binding = structuredClone(tool.physicalExecution?.resourceExecutionAdmission?.serviceBinding ?? null);
            }
        },
        assertFinalizablePreparation()
        {
            closed = true;
            state.managedPreparationRetained = true;
            // First finalization reopens the original live alias. Later cleanup may have
            // removed that alias; its already captured output incarnations still re-open independently.
            assertTransfer(true, !finalized);
            assertProductionSystemdExecutionBoundary(execution.physicalOptions.resourceBoundary,
                { expectedContext: execution.physicalOptions.resourceContext });
            if (pending || tools.some((tool) => !['terminal', 'verified'].includes(tool.phase)))
                throw new Error('managed preparation retains an unsettled original request');
            for (const tool of tools)
            {
                if (tool.started && (!tool.zero
                    || inspectProductionSystemdServiceBinding(tool.binding,
                        { commandBudgetMs: execution.physicalOptions.processOwner.commandBudgetMs }).status !== 'absent'))
                    throw new Error('managed preparation retains an unverified actual tool');
            }
            const observed = observePhysicalExecutionFailure(state.failureOwner);
            if (tools.some((tool) => tool.started) && observed.physicalTerminal !== 'zero-members')
                throw new Error('managed preparation aggregate terminal is unknown');
            state.managedPreparationRetained = false;
            finalized = true;
            return { physicalStarted: tools.some((tool) => tool.started),
                physicalExecution: tools.some((tool) => tool.started) ? observed.physicalExecution : null };
        }
    });
    return ports;
}

/** Read-only past invocation observation; cancellation never requires mutating or inspecting its reason. */
export function observeOwnedNugetStageFailure(capability, tier)
{
    const state = owners.get(capability);
    if (!state || state.closed || tier.id !== state.stage.id
        || tier.command !== command(state.stage.argv) || !equal(tier.cacheInputs, state.stage.inputs)
        || tier.nugetSdkIdentity !== sdkIdentity(state.sdk))
        throw new Error('NuGet failure observation requires its exact original issued stage');
    const failure = observeExecutionFailure(state.failureOwner);
    const physical = observePhysicalExecutionFailure(state.failureOwner);
    return Object.freeze({ failed: failure.failed, reason: failure.reason, diagnostic: failure.diagnostic,
        physicalStarted: physical.physicalStarted, physicalTerminal: physical.physicalTerminal,
        physicalExecution: physical.physicalExecution });
}

/** Called only through the original scheduler registration/release handshake, never a JSON grant. */
export async function executeOwnedNugetStage(capability, tier, physicalOptions)
{
    assertNugetScheduledTier(capability, tier);
    const state = owners.get(capability);
    state.executing = true;
    state.stage.used = true;
    state.execution = physicalOptions;
    const priorEnvironment = new Map();
    let native = null;
    try
    {
        requireNugetPreparationExecution(capability, { root: state.root, runId: state.runId,
            purpose: state.purpose, producerId: tier.id });
        // The fixed native stage is serialized. Its scheduler environment remains data, not authority.
        for (const [key, value] of Object.entries(physicalOptions.env))
        {
            priorEnvironment.set(key, process.env[key]);
            process.env[key] = value;
        }
        if (tier.id === state.declaration.owner)
        {
            const { prepareBehaviorDocNuget } = await import('../docs/prepare-behavior-doc-nuget.mjs');
            requireNugetPreparationExecution(capability, { root: state.root, runId: state.runId,
                purpose: state.purpose, producerId: tier.id });
            const result = await prepareBehaviorDocNuget({ repositoryRoot: state.root, runId: state.runId,
                outputFile: state.outputFile, feedRoot: state.feed.root, feedDigest: state.feed.treeDigest,
                purpose: state.purpose, parentOwner: capability, failureOwner: state.failureOwner });
            state.preparation = result.preparation;
            native = result.physicalExecution;
        }
        else
        {
            const { runDeterministicCommand } = await import('./run-deterministic-command.mjs');
            requireNugetPreparationExecution(capability, { root: state.root, runId: state.runId,
                purpose: state.purpose, producerId: tier.id });
            const result = await runDeterministicCommand(state.stage.runnerArgv, capability, state.failureOwner);
            native = result?.physicalExecution;
        }
        const observedTerminal = observePhysicalExecutionFailure(state.failureOwner);
        state.nativeRecords.push(!observedTerminal.physicalStarted ? { neverStarted: true }
            : { ...observedTerminal.physicalExecution, postObservation: observedTerminal.physicalTerminal ?? 'unverifiable' });
        assertNugetPreparationOwner(capability, { root: state.root, runId: state.runId,
            purpose: state.purpose, producerId: tier.id });
        return native;
    }
    catch (error)
    {
        retainExecutionFailure(state.failureOwner, error);
        const observation = observePhysicalExecutionFailure(state.failureOwner);
        if (!native) state.nativeRecords.push(!observation.physicalStarted ? { neverStarted: true }
            : { ...observation.physicalExecution, postObservation: observation.physicalTerminal ?? 'unverifiable' });
        throwExecutionFailure(state.failureOwner);
    }
    finally
    {
        for (const [key, value] of priorEnvironment)
        {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        state.execution = null;
        state.executing = false;
    }
}

/** Genuine dependency owner; no adapters, no outward SDK grant and no correctness qualification. */
export async function runOwnedNugetPreparation({ repositoryRoot, runId, outputFile, feedRoot, feedDigest,
    purpose, cpuUnits, memoryGiB, consumerId = null, failureOwner = createExecutionFailureOwner() })
{
    const root = fs.realpathSync(repositoryRoot);
    if (root !== ownerRepositoryRoot) throw new Error('NuGet parent must execute its actual imported source repository');
    const declaration = nugetPreparationDeclaration(purpose);
    if (validateProductionRunId(runId) !== runId || !Number.isFinite(cpuUnits) || cpuUnits <= 0
        || !Number.isFinite(memoryGiB) || memoryGiB <= 0
        || (consumerId && (purpose !== 'matrix-governance' || !declaration.consumers.includes(consumerId))))
        throw new Error('NuGet parent requires an explicit fixed purpose, run and native resource request');
    if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim())
        throw new Error('NuGet parent requires its actual clean frozen source');
    const source = sealSourceIdentity(root);
    const policy = loadPhysicalExecutionProcessPolicy();
    const systemdTransport = createSystemdResourceTransport({ commandBudgetMs: policy.systemdControlCommandTimeoutMs });
    const systemdRuntime = observeNugetSystemdRuntimeRoot(systemdTransport);
    const sourceState = await snapshotSourceState(root);
    const closure = nugetPreparationClosure(root, purpose);
    const sdk = observeNugetPreparationToolchain(root, 'matrix-governance');
    const ownerRoot = path.join(root, '.tmp', declaration.owner);
    let ancestor = ownerRoot;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const feed = inventoryNugetOfflineFeed(feedRoot, closure, Number(fs.statfsSync(ancestor).bsize));
    if (feed.treeDigest !== feedDigest) throw new Error('NuGet parent finite archive feed drifted');
    const output = path.resolve(outputFile);
    if (!output.startsWith(ownerRoot + path.sep)) throw new Error('NuGet parent descriptor is outside its fixed owner');
    const carrierRoot = fs.realpathSync(os.tmpdir());
    const carrierStat = fs.lstatSync(carrierRoot);
    if (carrierRoot !== path.resolve(os.tmpdir()) || (carrierStat.mode & 0o077) || carrierStat.uid !== process.getuid())
        throw new Error('NuGet parent requires an existing canonical private task-owned TMPDIR');
    const nativeRoot = path.join(root, '.tmp/nuget-native-parent', runId);
    const roots = { ...defaultProductionDiskRoots(root, { includeDockerStorage: false }),
        behaviorDocNugetPreparationRoot: ownerRoot,
        nugetParentControlRoot: path.join(root, '.tmp'), nugetParentCarrierRoot: carrierRoot,
        nugetSystemdManagementRoot: '/var/tmp', nugetSystemdRuntimeRoot: systemdRuntime.root };
    const catalog = bindNugetParentControlDiskDemand(bindBehaviorDocNugetPreparationDiskDemand(
        readProductionDiskDemandCatalog(root), feed, purpose), declaration.owner);
    const plan = buildProductionDiskDemandPlan({ root, maxParallel: 1, catalog, roots,
        tiers: [{ id: declaration.owner, executionDependsOn: [], exclusiveResources: [] }] });
    const inputs = [...new Set([...closure.sourceClosureDigests.map((entry) => entry.path),
        ...parentSources, declaration.solution, feed.root, sdk.executable,
        ...sdk.files.map((file) => path.join(path.dirname(sdk.executable), file.path))])].sort();
    const argv = [process.execPath, 'tools/docs/prepare-behavior-doc-nuget.mjs',
        ...(purpose === 'matrix-governance' ? ['--purpose', purpose] : []),
        '--run-id', runId, '--out', output, '--feed-root', feed.root, '--feed-digest', feed.treeDigest];
    const assertPreflight = () =>
    {
        if (!equal(sealSourceIdentity(root), source) || !equal(nugetPreparationClosure(root, purpose), closure)
            || !equal(observeNugetPreparationToolchain(root, 'matrix-governance'), sdk)
            || !equal(observeNugetSystemdRuntimeRoot(systemdTransport), systemdRuntime)
            || inventoryNugetOfflineFeed(feed.root, closure).treeDigest !== feed.treeDigest)
            throw new Error('NuGet parent preflight source, SDK or finite feed drifted');
    };
    const confirmedSourceState = await snapshotSourceState(root);
    if (!equal(confirmedSourceState, sourceState))
        throw new Error('NuGet parent official scheduler source drifted before owner admission');
    assertPreflight();
    const capability = Object.freeze({});
    const state = { root, runId, source, sourceState, closure, sdk, systemdTransport, systemdRuntime, feed, purpose, outputFile: output,
        declaration, reservations: [], nativeRecords: [], closed: false, executing: false,
        stage: { id: declaration.owner, argv, inputs, used: false } };
    state.failureOwner = failureOwner;
    try
    {
        state.lease = acquireProductionFreshExclusiveLease({ root, runId,
            targetTierId: 'production-correctness', sourceState });
        assertPreflight();
        const reservation = acquireProductionCapacityReservation({ plan, runId,
            candidateIdentityDigest: state.lease.owner.candidateIdentityDigest,
            repositoryRoot: root, repositoryLeaseOwner: state.lease.owner });
        state.reservations.push({ value: reservation, plan });
        owners.set(capability, state);
        assertNugetPreparationOwner(capability, { root, runId, purpose, producerId: declaration.owner });
        reservation.guardProducer(declaration.owner);
        const ownedSystemdTransport = guardNugetSystemdTransport(systemdTransport, () => guardNugetSystemdMutation(capability));
        const result = await runProductionBuildLifecycle({ prepareOptions: {
            root, runId, namespace: 'nuget-preparation', sourceState, fresh: true },
        execute: async ({ buildLayout, recordSchedulerResult, setFinalization }) =>
        {
            reservation.retainBuildOwner(buildLayout);
            const stage = async (phase) =>
            {
                assertNugetPreparationOwner(capability, { root, runId, purpose, producerId: state.stage.id });
                // Re-measure parent control headroom before each original scheduler mutation phase.
                reservation.guardProducer(declaration.owner);
                const tier = { id: state.stage.id, command: command(state.stage.argv), cacheInputs: state.stage.inputs,
                    nugetSdkIdentity: sdkIdentity(sdk),
                    executionDependsOn: [], exclusiveResources: [], cpuUnits, memoryGiB,
                    budgetMs: 1200000, terminationGraceMs: policy.gracefulTerminationMs };
                const scheduled = await runDag({ root, runId, namespace: 'nuget-preparation', sourceState,
                    runsRoot: path.join(nativeRoot, phase), tiers: [tier], targetTierId: tier.id, maxParallel: 1,
                    wallClockBudgetMs: 1200000, resourceEnforcementMode: 'strict', nugetPreparationOwner: capability,
                    env: { FSUSBLOG_CONTENT_FIELD_DOTNET: sdk.executable,
                        ...(purpose === 'behavior-doc' ? { PATH: path.dirname(sdk.executable) + path.delimiter + process.env.PATH } : {}),
                        FSUSBLOG_TEST_RUN_ID: runId, FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
                        FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint },
                    beforeTierStart: () =>
                    {
                        assertNugetPreparationOwner(capability, { root, runId, purpose, producerId: state.stage.id });
                        reservation.guardProducer(declaration.owner);
                        if (state.reservations.length > 1) state.reservations.at(-1).value.guardProducer(state.stage.id);
                    },
                    onSourceState: (observed) => bindProductionBuildLayoutSource(buildLayout, observed),
                    resourceEnforcementOptions: { systemdTransport: ownedSystemdTransport, systemdBoundary: {
                        commandBudgetMs: policy.systemdControlCommandTimeoutMs,
                        startupBudgetMs: policy.systemdResourceStartupTimeoutMs,
                        retainBinding: (reference) =>
                        {
                            guardNugetSystemdMutation(capability);
                            const observed = readProductionSystemdResourceBoundaryBinding(reference.context, { reference });
                            if (!equal(observed.owner.runtimeIdentity, systemdRuntime.runtimeIdentity))
                                throw new Error('NuGet creation runtime differs from its original reserved input');
                            return retainProductionBuildResourceBoundary(buildLayout, reference,
                                { commandBudgetMs: policy.systemdControlCommandTimeoutMs });
                        } } },
                    retainManagedContainment: (authority) => retainProductionBuildServiceContainment(buildLayout, authority),
                    markManagedContainmentCreationAttempt: (authority, _tier, sender) =>
                    {
                        guardNugetSystemdMutation(capability);
                        return markProductionBuildServiceCreationAttempt(buildLayout, authority, sender);
                    },
                    registerManagedProcess: (identity, _tier, authority) => registerProductionBuildCompiler(buildLayout, identity, authority)
                });
                assertNugetPreparationOwner(capability, { root, runId, purpose, producerId: state.stage.id });
                recordSchedulerResult(scheduled);
                if (scheduled.status !== 'success') throw Object.assign(new Error('NuGet original scheduled stage failed'),
                    { scheduled, physicalExecution: state.nativeRecords.at(-1) });
                return scheduled;
            };
            const preparationStage = await stage('preparation');
            reservation.completeProducer(declaration.owner);
            let consumerStage = null;
            if (consumerId)
            {
                const prepared = await readPreparedNuget({ repositoryRoot: root, runId,
                    producerId: consumerId, file: output });
                assertNugetPreparationOwner(capability, { root, runId, purpose, producerId: declaration.owner });
                const consumerCatalog = bindMatrixNugetDiskDemand(readProductionDiskDemandCatalog(root), prepared, consumerId);
                const consumerPlan = buildProductionDiskDemandPlan({ root, maxParallel: 1, catalog: consumerCatalog,
                    roots: { ...defaultProductionDiskRoots(root, { includeDockerStorage: false }),
                        matrixNugetArtifactRoot: path.join(root, '.tmp') },
                    tiers: [{ id: consumerId, executionDependsOn: [], exclusiveResources: [] }] });
                const consumerReservation = acquireProductionCapacityReservation({ plan: consumerPlan, runId,
                    candidateIdentityDigest: state.lease.owner.candidateIdentityDigest, repositoryRoot: root,
                    repositoryLeaseOwner: state.lease.owner });
                state.reservations.push({ value: consumerReservation, plan: consumerPlan });
                consumerReservation.retainBuildOwner(buildLayout);
                const runnerArgv = matrixGovernanceArguments({ root, consumerId, preparationFile: output });
                state.stage = { id: consumerId, argv: [process.execPath, 'tools/test/run-deterministic-command.mjs', ...runnerArgv],
                    runnerArgv, inputs: [...new Set([...inputs, ...prepared.inputPaths])].sort(), used: false };
                consumerReservation.guardProducer(consumerId);
                consumerStage = await stage('consumer');
                consumerReservation.completeProducer(consumerId);
            }
            if (consumerId) reservation.completeProducer(declaration.owner);
            setFinalization({ status: 'success' });
            return { purpose, runId, descriptor: output, preparationStage, consumerStage,
                qualificationEligible: false };
        } });
        return result;
    }
    catch (error) { retainExecutionFailure(state.failureOwner, error); throwExecutionFailure(state.failureOwner); }
    finally
    {
        state.closed = true;
        owners.delete(capability);
        const safe = !state.managedPreparationRetained && state.nativeRecords.every((record) => record?.neverStarted || record?.postObservation === 'zero-members');
        if (!safe) retainExecutionRecovery(state.failureOwner, {
            repositoryLeasePath: state.lease?.leasePath,
            capacityReservationFiles: state.reservations.map((entry) => entry.value.activeFile),
            reason: 'NuGet parent physical terminal unknown; original owners retained' });
        if (safe)
        {
            let cleanupFailed = false;
            for (const reservation of [...state.reservations].reverse())
                try { reservation.value.release(observeExecutionFailure(state.failureOwner).failed ? 'recovery-required' : 'released'); }
                catch (error) { cleanupFailed = true; retainExecutionFailure(state.failureOwner, error); }
            // A retained build/resource authority also retains the repository lease.
            if (!cleanupFailed)
                try { state.lease?.release(observeExecutionFailure(state.failureOwner).failed ? 'failed' : 'complete'); }
                catch (error) { cleanupFailed = true; retainExecutionFailure(state.failureOwner, error); }
            if (cleanupFailed) retainExecutionRecovery(state.failureOwner, {
                repositoryLeasePath: state.lease?.leasePath,
                capacityReservationFiles: state.reservations.map((entry) => entry.value.activeFile),
                reason: 'original owner release unverified; recovery records retained' });
        }
        // eslint-disable-next-line no-unsafe-finally
        throwExecutionFailure(state.failureOwner);
    }
}
