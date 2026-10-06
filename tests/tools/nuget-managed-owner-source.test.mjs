import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { executeManagedPreparation, managedPreparationPurposes, versionArguments } from '../../tools/test/execution-envelope-environment.mjs';
import { createExecutionFailureOwner, observeExecutionFailure, retainExecutionFailure } from '../../tools/test/execution-failure-diagnostic.mjs';

// SOURCE_ADAPTER_ONLY: execute the actual owner body with model ports. No actual owner,
// filesystem writes, resource grant, service or native execution is produced by these controls.
const source = fs.readFileSync(new URL('../../tools/test/nuget-preparation-owner.mjs', import.meta.url), 'utf8');
const start = source.indexOf('export function createNugetManagedPreparationOwner(');
const stop = source.indexOf('/** Read-only past invocation observation;', start);
const body = source.slice(start, stop).replace('export function', 'function');
function model({ stage = 'matrix-nuget-preparation', purpose = 'matrix-governance', terminal = 'zero-members', admissionAwait = null } = {})
{
    const declaration = purpose === 'behavior-doc'
        ? { owner: 'behavior-doc-nuget-preparation', consumers: ['behavior-doc-static-admission'] }
        : { owner: 'matrix-nuget-preparation', consumers: ['matrix-governance'] };
    const capability = Object.freeze({});
    const signal = new AbortController();
    const dirs = Object.fromEntries(['home','temp','npmCache','nugetPackages','dotnetHome','toolCache'].map((name) => [name, '/owned/' + name]));
    const directories = { fragment: { ownedRoot: '/owned', producerId: declaration.consumers[0], attemptId: 'attempt', directories: dirs },
        environment: { HOME: dirs.home, USERPROFILE: dirs.home, TMPDIR: dirs.temp, TEMP: dirs.temp, TMP: dirs.temp,
            NPM_CONFIG_CACHE: dirs.npmCache, NUGET_PACKAGES: dirs.nugetPackages, DOTNET_CLI_HOME: dirs.dotnetHome, FSUSBLOG_TOOL_CACHE: dirs.toolCache }, privateTmpCapability: Object.freeze({}) };
    const state = { root: '/source', runId: 'run', stage: { id: stage }, declaration,
        source: { worktreeFingerprint: 'original-seal' }, sourceState: { commit: 'original-commit', worktreeFingerprint: 'scheduler-snapshot' },
        sdk: { executable: '/sdk/dotnet' }, failureOwner: createExecutionFailureOwner(), execution: { env: { PATH: '/selector' } } };
    const transfer = '/source/.tmp/' + declaration.owner + '/transfer-ABC123';
    const outputRoots = stage === state.declaration.owner ? [transfer + '/artifacts',transfer + '/packages'] : ['/source/consumer-output'];
    const reference = Object.freeze({ current: 'original-resource-reference' });
    const binding = { current: 'actual-service-binding' };
    let effects = 0;
    let observation = { physicalStarted: false, physicalExecution: null, physicalTerminal: null };
    const owners = new WeakMap([[capability, state]]);
    const context = { owners, path, Writable, AbortSignal, structuredClone, managedPreparationPurposes, versionArguments,
        process: { getuid: () => 1000 },
        fs: { realpathSync: (file) => file, lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 1000n, gid: 1000n, dev: 1n, ino: 2n, mode: 0o700n }) }, equal: (a,b) => JSON.stringify(a) === JSON.stringify(b),
        inspectOwnedPreparationOutputs: () => outputRoots,
        inspectOwnedPrivateTmp: () => ({ runId: 'run', ownedRoot: '/owned', producerId: declaration.consumers[0], attemptId: 'attempt', toolCache: dirs.toolCache, source: dirs.temp }),
        requireNugetPreparationExecution(cap)
        { if (!owners.has(cap)) throw new Error('foreign opaque owner'); return { physicalOptions: { signal: signal.signal, resourceBoundary: reference,
            resourceContext: reference, processOwner: { commandBudgetMs: 5 } }, resourceReference: reference }; },
        assertNugetManagedPreparationAdmission(cap) { if (!owners.has(cap)) throw new Error('foreign opaque owner'); signal.signal.throwIfAborted(); },
        resolveExecutablePath: (name) => '/tools/' + name,
        prepareNetworkBindings: () => ({ readWritePaths: Object.values(dirs) }),
        snapshotSourceState: async () => { admissionAwait?.(signal); return state.sourceState; },
        assertProductionSystemdExecutionBoundary: () => {}, inspectProductionSystemdServiceBinding: () => ({ status: 'absent' }),
        observePhysicalExecutionFailure: () => observation,
        async runPhysicalExecution(options)
        {
            effects++;
            const stdout = 'tool v1';
            const physical = { schema: 'fsusblog.physical-execution-process-tree.v1', platform: 'linux', postObservation: terminal,
                resourceExecutionAdmission: { reference, serviceBinding: binding }, containmentAuthority: { serviceBinding: binding },
                authority: { kind: 'linux-cgroup-process-group', established: true, networkIsolation: 'systemd-private-network',
                    filesystemIsolation: { readWritePaths: options.linuxReadWritePaths } },
                logComplete: true, logTruncationReason: null, forcedPipeClose: false,
                lifecycle: ['post-observe-zero-members','bounded-pipe-close','seal-completed-receipt'], termination: [],
                processInventory: [{ role: 'direct-child', pid: 5, startIdentity: 'model', exitCode: 0, signal: null }],
                policy: { maximumCapturedOutputBytesPerStream: 1024 }, stdout, stderr: '',
                outputCapture: { maximumBytesPerStream: 1024, stdoutTruncated: false, stderrTruncated: false,
                    stdoutBytes: stdout.length, stdoutCapturedBytes: stdout.length, stderrBytes: 0, stderrCapturedBytes: 0 } };
            observation = { physicalStarted: true, physicalExecution: physical, physicalTerminal: terminal };
            return physical;
        }
    };
    vm.runInNewContext(body + '\nthis.factory=createNugetManagedPreparationOwner;', context);
    const request = (fingerprint = stage === state.declaration.owner ? 'original-seal' : 'scheduler-snapshot') => ({ purpose: 'executable-version', command: ['/sdk/dotnet','--version'], cwd: '/source',
        environment: { ...directories.environment, PATH: '/selector', ...(stage === state.declaration.owner ? { NUGET_PACKAGES: transfer + '/packages' } : {}), FSUSBLOG_TEST_RUN_ID: 'run', FSUSBLOG_TEST_SOURCE_COMMIT: 'original-commit', FSUSBLOG_TEST_SOURCE_FINGERPRINT: fingerprint } });
    return { capability, directories, outputRoots, context, create: (cap = capability) => context.factory(cap, { expected: {}, directories, signal: signal.signal }),
        request, state, signal, effects: () => effects };
}

for (const stage of ['matrix-nuget-preparation','matrix-governance'])
{
    test(`actual ${stage} owner binds its distinct official fingerprint and complete original terminal`, async () =>
    {
        const m = model({ stage });
        const owner = m.create();
        await executeManagedPreparation(m.request(), owner);
        assert.equal(m.effects(), 1);
        assert.equal(owner.assertFinalizablePreparation().physicalStarted, true);
        assert.equal(m.state.managedPreparationRetained, false);
        await assert.rejects(executeManagedPreparation(m.request(), owner), /closed/u);
    });
}

test('actual owner refuses foreign capabilities and wrong official source mapping before effects', async () =>
{
    const m = model();
    assert.throws(() => m.create(Object.freeze({})), /foreign opaque owner/u);
    await assert.rejects(executeManagedPreparation(m.request('scheduler-snapshot'), m.create()), /foreign/u);
    assert.equal(m.effects(), 0);
});

test('actual owner fences cancellation after original source await before tool execution', async () =>
{
    const reason = Object.freeze(new Error('original cancellation'));
    const m = model({ admissionAwait(controller) { controller.abort(reason); } });
    await assert.rejects(executeManagedPreparation(m.request(), m.create()), (error) => error === reason);
    assert.equal(m.effects(), 0);
});

test('actual owner retains original parent when a tool terminal is unknown', async () =>
{
    const m = model({ terminal: 'unverifiable' });
    const owner = m.create();
    await assert.rejects(executeManagedPreparation(m.request(), owner), /actual absent/u);
    assert.throws(() => owner.assertFinalizablePreparation(), /unverified actual tool/u);
    assert.equal(m.state.managedPreparationRetained, true);
});

test('actual scheduler observation rejects a foreign tier and preserves primitive first reason', () =>
{
    const start = source.indexOf('export function observeOwnedNugetStageFailure(');
    const stop = source.indexOf('/** Called only through', start);
    const owner = Object.freeze({}); const failureOwner = createExecutionFailureOwner();
    retainExecutionFailure(failureOwner, null);
    const state = { stage: { id: 'fixed', argv: ['original'], inputs: ['input'] }, sdk: 'sdk', failureOwner };
    const context = { owners: new WeakMap([[owner,state]]), equal: (a,b) => JSON.stringify(a) === JSON.stringify(b),
        command: (argv) => argv.join(' '), sdkIdentity: (sdk) => sdk, observeExecutionFailure,
        observePhysicalExecutionFailure: () => ({ physicalStarted: true, physicalTerminal: null, physicalExecution: null }) };
    vm.runInNewContext(source.slice(start,stop).replace('export function','function') + '\nthis.observe=observeOwnedNugetStageFailure;',context);
    const tier = { id: 'fixed', command: 'original', cacheInputs: ['input'], nugetSdkIdentity: 'sdk' };
    const result = context.observe(owner,tier);
    assert.equal(result.failed,true); assert.equal(result.reason,null); assert.equal(result.physicalTerminal,null);
    assert.throws(() => context.observe(owner,{ ...tier, command: 'foreign' }), /exact original issued stage/u);
});

// Exercise actual caller preparation blocks, rather than proving only that exported helpers exist.
for (const [relative, stage] of [['tools/docs/prepare-behavior-doc-nuget.mjs','matrix-nuget-preparation'],
    ['tools/test/run-deterministic-command.mjs','matrix-governance']])
{
    test(`actual ${relative} connects retained directories and both async factories to the fixed owner`, async () =>
    {
        const m = model({ stage });
        const caller = fs.readFileSync(new URL('../../' + relative, import.meta.url), 'utf8');
        const start = caller.indexOf(relative.startsWith('tools/docs') ? '        directories = prepareRunOwnedDirectories({' : '    directoryEnvelope = prepareRunOwnedDirectories({');
        const end = caller.indexOf(relative.startsWith('tools/docs') ? '        const toolchain =' : '\n    catch (error)',start);
        const block = caller.slice(start,end) + (relative.startsWith('tools/docs') ? '' : 'catch (reason) { throw reason; }');
        const events = [];
        const context = { console, process: { env: { PATH: '/selector' }, execPath: '/tools/node' },
            root: '/source', repoRoot: '/source', cwd: '/source', runId: 'run', purpose: 'matrix-governance',
            parentOwner: m.capability, parentModule: { createNugetManagedPreparationOwner: () => m.create() },
            directories: null, directoryEnvelope: null, preparationOwner: null,
            command: ['/sdk/dotnet','restore'], packagesRoot: '/source/.tmp/matrix-nuget-preparation/transfer-ABC123/packages', artifactsRoot: '/source/.tmp/matrix-nuget-preparation/transfer-ABC123/artifacts', key: 'attempt',
            declaration: { owner: stage, consumers: ['matrix-governance'] }, options: { key: 'attempt', outputs: [], environmentNames: [] },
            preparedNuget: { purpose: 'matrix-governance' }, producerId: 'matrix-governance', sourceCommit: 'original-commit',
            sourceFingerprint: 'scheduler-snapshot', source: { sourceCommit: 'original-commit', worktreeFingerprint: 'original-seal' },
            executionSignal: m.signal.signal, temporalContext: {}, temporalRoleEnvironment: {}, temporalChildObserver: '/observer',
            policy: {}, catalog: {}, producerEnvelope: { requiredServices: [] }, serviceEnvelope: null,
            materializeTemporalEnvironment: () => ({}), loadExecutionEnvelopePolicy: () => ({}), loadExecutionEnvelopeApplicability: () => ({}),
            loadExecutionNetworkPolicy: () => ({}), projectPlannedEndpoints: () => [],
            assertInputs() { events.push('guard'); }, publicationGuard() { events.push('guard'); },
            prepareRunOwnedDirectories(options) { options.assertPreparationAdmission(); events.push('directories'); return m.directories; },
            async prepareCorrectnessEnvironmentAsync(options)
            {
                events.push('environment');
                const request = m.request();
                request.environment = { ...request.environment, ...options.injectedEnvironment };
                await executeManagedPreparation(request,options);
                return { command: options.command, environment: request.environment, fragment: {} };
            },
            async prepareNetworkSandboxAsync(options)
            {
                events.push('network'); assert.equal(options.signal,m.signal.signal);
                await executeManagedPreparation(m.request(),options);
                return { command: options.command, fragment: {} };
            }
        };
        await vm.runInNewContext('(async()=>{' + block + '})()',context);
        assert.deepEqual(events,['guard','directories','environment','guard','network','guard']);
        assert.equal(m.effects(),2);
    });
}

test('actual retained directory constructor rejects missing live admission before creating any owned path', async () =>
{
    const { prepareRunOwnedDirectories } = await import('../../tools/test/execution-envelope-directories.mjs');
    let calls = 0;
    const target = '/component-fixture-never-created/run-owned';
    const first = Object.freeze(new Error('original owner revoked'));
    assert.throws(() => prepareRunOwnedDirectories({ repositoryRoot: '/component-fixture-never-created', cwd: '/component-fixture-never-created',
        runId: 'run', producerId: 'matrix-governance', attemptId: 'attempt', authorityRoot: target,
        assertPreparationAdmission() { calls++; throw first; } }), (reason) => reason === first);
    assert.equal(calls,1); assert.equal(fs.existsSync(target),false);
    assert.throws(() => prepareRunOwnedDirectories({ repositoryRoot: '/component-fixture-never-created', cwd: '/component-fixture-never-created',
        runId: 'run', producerId: 'matrix-governance', attemptId: 'attempt', authorityRoot: target,
        assertPreparationAdmission() { return Promise.resolve(); } }), /synchronous original owner assertion/u);
    assert.equal(fs.existsSync(target),false);
});


test('actual prep owner rejects a foreign package cache or replaced declared transfer before effects', async () =>
{
    const m = model(); const owner = m.create();
    const foreign = m.request(); foreign.environment.NUGET_PACKAGES = '/source/foreign';
    await assert.rejects(executeManagedPreparation(foreign,owner), /foreign/u);
    assert.equal(m.effects(),0);
    m.context.fs.lstatSync = () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 1000n, gid: 1000n, dev: 1n, ino: 3n, mode: 0o700n });
    await assert.rejects(executeManagedPreparation(m.request(),owner), /incarnation drifted/u);
    assert.equal(m.effects(),0);
});

test('actual directory owner keeps its issued output declaration independent of mutable fragments', async (t) =>
{
    const { prepareRunOwnedDirectories, inspectOwnedPreparationOutputs, finalizeRunOwnedDirectories } =
        await import('../../tools/test/execution-envelope-directories.mjs');
    const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../.tmp/managed-output-component-fixtures');
    fs.mkdirSync(base,{ recursive: true, mode: 0o700 });
    const root = fs.mkdtempSync(path.join(base,'fixture-'));
    const transfer = path.join(root,'.tmp/matrix-nuget-preparation/transfer-ABC123');
    const packages = path.join(transfer,'packages'); const artifacts = path.join(transfer,'artifacts');
    fs.mkdirSync(packages,{ recursive: true, mode: 0o700 }); fs.mkdirSync(artifacts,{ mode: 0o700 });
    let prepared;
    t.after(() =>
    {
        if (prepared && !prepared.fragment.cleanup.removedOwnedRoot) finalizeRunOwnedDirectories(prepared);
        fs.rmSync(root,{ recursive: true, force: true });
        fs.rmdirSync(base);
    });
    prepared = prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root, runId: 'component-run',
        producerId: 'matrix-governance', attemptId: 'component-attempt', outputs: [packages,artifacts],
        assertPreparationAdmission() {} });
    const cap = prepared.privateTmpCapability;
    assert.deepEqual(inspectOwnedPreparationOutputs(cap),[artifacts,packages]);
    prepared.fragment.writableRoots = ['/untrusted-fragment-root'];
    assert.deepEqual(inspectOwnedPreparationOutputs(cap),[artifacts,packages]);
    assert.throws(() => inspectOwnedPreparationOutputs(Object.freeze({})),/original current-attempt/u);
    prepared.fragment.writableRoots = [artifacts,packages];
    finalizeRunOwnedDirectories(prepared);
    assert.throws(() => inspectOwnedPreparationOutputs(cap));
});


test('actual finalizer independently reopens captured output incarnations after owned alias cleanup and sealing', async () =>
{
    const m = model(); const owner = m.create();
    await executeManagedPreparation(m.request(),owner);
    owner.assertFinalizablePreparation();
    m.context.inspectOwnedPreparationOutputs = () => { throw new Error('removed original alias'); };
    m.context.fs.lstatSync = (file) => ({ isDirectory: () => true, isSymbolicLink: () => false,
        uid: 1000n, gid: 1000n, dev: 1n, ino: 2n, mode: file.endsWith('/packages') ? 0o555n : 0o700n });
    assert.equal(owner.assertFinalizablePreparation().physicalStarted,true);
    m.context.fs.lstatSync = () => ({ isDirectory: () => true, isSymbolicLink: () => false,
        uid: 1000n, gid: 1000n, dev: 1n, ino: 3n, mode: 0o700n });
    assert.throws(() => owner.assertFinalizablePreparation(), /incarnation drifted/u);
    assert.equal(m.state.managedPreparationRetained,true);
});


test('actual original BehaviorDoc preparation keeps its own fixed transfer namespace and nine environment bindings', async () =>
{
    const m = model({ stage: 'behavior-doc-nuget-preparation', purpose: 'behavior-doc' });
    const owner = m.create();
    assert.equal(Object.keys(m.request().environment).filter((name) => name !== 'PATH' && !name.startsWith('FSUSBLOG_TEST_')).length,9);
    assert.equal(m.request().environment.NUGET_PACKAGES,'/source/.tmp/behavior-doc-nuget-preparation/transfer-ABC123/packages');
    await executeManagedPreparation(m.request(),owner);
    assert.equal(m.effects(),1);
    assert.equal(owner.assertFinalizablePreparation().physicalStarted,true);
});
