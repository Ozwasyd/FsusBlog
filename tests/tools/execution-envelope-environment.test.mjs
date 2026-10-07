import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

const {createMinimalCorrectnessEnvironment, observeExecutableIdentity, prepareCorrectnessEnvironment, verifyExecutableIdentity} = await import(new URL('../../tools/test/execution-envelope-environment.mjs', import.meta.url));
const {loadExecutionEnvelopeApplicability, loadExecutionEnvelopePolicy} = await import(new URL('../../tools/test-matrix/execution-envelope-policy.mjs', import.meta.url));
const policy = loadExecutionEnvelopePolicy();
const catalog = loadExecutionEnvelopeApplicability();

const { executeManagedPreparation, observeExecutableIdentityAsync, prepareCorrectnessEnvironmentAsync } = await import(new URL('../../tools/test/execution-envelope-environment.mjs', import.meta.url));
const { retainNestedPreparationFailure } = await import(new URL('../../tools/test/physical-execution-nested-channel.mjs', import.meta.url));
test('correctness environment contains only fixed values, PATH, injected identity, and producer allowlist', () =>
{
    const result = createMinimalCorrectnessEnvironment({
        parentEnvironment: {
            PATH: '/controlled/bin',
            DECLARED: 'yes',
            UNDECLARED: 'must-not-cross',
            HTTP_PROXY: 'must-not-cross',
            NODE_OPTIONS: '--must-not-cross',
            DOTNET_ROOT: '/must-not-cross'
        },
        producerAllowlist: ['DECLARED'],
        injectedEnvironment: { FSUSBLOG_TEST_RUN_ID: 'run-1' },
        policy
    });
    assert.deepEqual(Object.keys(result.childEnvironment).sort(), [
        'DECLARED',
        'FSUSBLOG_TEST_RUN_ID',
        'LANG',
        'LC_ALL',
        'PATH',
        'TZ'
    ]);
    assert.equal(result.childEnvironment.UNDECLARED, undefined);
    assert.equal(result.childEnvironment.HTTP_PROXY, undefined);
    assert.equal(result.childEnvironment.NODE_OPTIONS, undefined);
    assert.equal(result.childEnvironment.DOTNET_ROOT, undefined);
    assert.equal(result.observation.inheritedAmbientCount, 0);
});

test('sensitive allowlisted inputs record presence, type, and digest without plaintext', () =>
{
    const secret = 'fixture-secret-plaintext';
    const result = createMinimalCorrectnessEnvironment({
        parentEnvironment: { PATH: '/bin', FIXTURE_SECRET: secret },
        producerAllowlist: ['FIXTURE_SECRET'],
        policy
    });
    const observation = result.observation.variables.find((entry) =>
        entry.name === 'FIXTURE_SECRET');
    assert.equal(result.childEnvironment.FIXTURE_SECRET, secret);
    assert.equal(observation.present, true);
    assert.equal(observation.type, 'string');
    assert.equal(observation.value, null);
    assert.match(observation.valueDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(result.observation), new RegExp(secret, 'u'));
});

test('declared pinned dotnet host crosses only the explicit child environment boundary', () =>
{
    const name = 'FSUSBLOG_CONTENT_FIELD_DOTNET';
    const host = '/isolated/dotnet-10.0.302/dotnet';
    const parentEnvironment = {
        PATH: '/controlled/bin',
        [name]: host,
        DOTNET_ROOT: '/unrelated/dotnet'
    };
    const admitted = createMinimalCorrectnessEnvironment({
        parentEnvironment,
        producerAllowlist: [name],
        policy
    });
    assert.equal(admitted.childEnvironment[name], host);
    assert.equal(admitted.childEnvironment.DOTNET_ROOT, undefined);
    assert.equal(admitted.observation.variables.find((entry) =>
        entry.name === name)?.valueDigest != null, true);
    const denied = createMinimalCorrectnessEnvironment({
        parentEnvironment,
        producerAllowlist: [],
        policy
    });
    assert.equal(denied.childEnvironment[name], undefined);
});

test('executable identity includes absolute path, real path, version, and binary digest', () =>
{
    const identity = observeExecutableIdentity(process.execPath, {
        pathValue: process.env.PATH
    });
    assert.equal(identity.absolutePath, process.execPath);
    assert.ok(identity.realPath.startsWith('/'));
    assert.match(identity.version, /^v\d+/u);
    assert.match(identity.sha256, /^sha256:[a-f0-9]{64}$/u);
});

test('path, digest, and version drift fail before command admission', () =>
{
    const planned = {
        absolutePath: '/tools/node',
        realPath: '/tools/node',
        version: 'v1',
        sha256: `sha256:${'a'.repeat(64)}`
    };
    for (const [field, value] of [
        ['absolutePath', '/other/node'],
        ['realPath', '/other/node'],
        ['version', 'v2'],
        ['sha256', `sha256:${'b'.repeat(64)}`]
    ])
    {
        assert.throws(
            () => verifyExecutableIdentity(planned, { ...planned, [field]: value }),
            /executable drift/u
        );
    }
});

test('planned and spawn-time executable observations must match exactly', () =>
{
    let call = 0;
    assert.throws(() => prepareCorrectnessEnvironment({
        command: ['node', '-e', '0'],
        parentEnvironment: { PATH: '/tools' },
        producerAllowlist: [],
        injectedEnvironment: { FSUSBLOG_TEST_RUN_ID: 'run-1' },
        policy,
        catalog,
        observeExecutable: () =>
        {
            call += 1;
            return {
                requestedName: 'node',
                absolutePath: '/tools/node',
                realPath: '/tools/node',
                version: 'v1',
                sha256: `sha256:${call === 1 ? 'a' : 'b'.repeat(64)}`
            };
        }
    }), /executable drift/u);
});

test('spawn-time executable keeps the declared name after exact absolute identity verification', () =>
{
    const observedNames = [];
    const result = prepareCorrectnessEnvironment({
        command: ['node', '-e', '0'],
        parentEnvironment: { PATH: '/tools' },
        producerAllowlist: [],
        injectedEnvironment: { FSUSBLOG_TEST_RUN_ID: 'run-1' },
        policy,
        catalog,
        observeExecutable: (name) =>
        {
            observedNames.push(name);
            return {
                requestedName: name,
                absolutePath: '/tools/node',
                realPath: '/tools/node',
                version: 'v1',
                sha256: `sha256:${'a'.repeat(64)}`
            };
        }
    });
    assert.deepEqual(observedNames, ['node', '/tools/node']);
    assert.equal(result.fragment.plannedExecutable.requestedName, 'node');
    assert.equal(result.fragment.actualExecutable.requestedName, 'node');
    assert.deepEqual(result.fragment.actualExecutable, result.fragment.plannedExecutable);
    assert.deepEqual(result.command, ['/tools/node', '-e', '0']);
});

test('PATH-resolved node normalizes only its non-measurement command label', () =>
{
    const result = prepareCorrectnessEnvironment({
        command: ['node', '-e', '0'],
        parentEnvironment: { PATH: process.env.PATH },
        producerAllowlist: [],
        injectedEnvironment: { FSUSBLOG_TEST_RUN_ID: 'run-node-label' },
        policy,
        catalog
    });
    const planned = result.fragment.plannedExecutable;
    const actual = result.fragment.actualExecutable;
    assert.equal(planned.requestedName, 'node');
    assert.equal(actual.requestedName, 'node');
    assert.ok(path.isAbsolute(planned.absolutePath));
    for (const field of ['absolutePath', 'realPath', 'version', 'sha256'])
    {
        assert.equal(actual[field], planned[field]);
    }
    assert.equal(result.command[0], planned.absolutePath);
});

test('PATH-resolved node still rejects every measured executable identity drift', () =>
{
    const planned = {
        absolutePath: '/tools/node',
        realPath: '/tools/node-real',
        version: 'v1',
        sha256: `sha256:${'a'.repeat(64)}`
    };
    for (const [field, value] of [
        ['absolutePath', '/other/node'],
        ['realPath', '/other/node-real'],
        ['version', 'v2'],
        ['sha256', `sha256:${'b'.repeat(64)}`]
    ])
    {
        let call = 0;
        assert.throws(() => prepareCorrectnessEnvironment({
            command: ['node', '-e', '0'],
            parentEnvironment: { PATH: '/tools' },
            producerAllowlist: [],
            injectedEnvironment: { FSUSBLOG_TEST_RUN_ID: 'run-node-drift' },
            policy,
            catalog,
            observeExecutable: (name) => ({
                requestedName: name,
                ...planned,
                ...(call++ === 0 ? {} : { [field]: value })
            })
        }), new RegExp(`executable drift: ${field}`, 'u'));
    }
});

test('missing or unobservable executable fails closed', () =>
{
    assert.throws(() => observeExecutableIdentity('missing', {
        pathValue: '/missing',
        resolve: () =>
        {
            throw new Error('missing');
        }
    }), /missing/u);
    assert.throws(() => observeExecutableIdentity('/tools/node', {
        pathValue: '/tools',
        resolve: (value) => value,
        realpath: (value) => value,
        readFile: () => Buffer.from('binary'),
        observeVersion: () => ({ status: 1, stdout: '', stderr: '' })
    }), /version is unobservable/u);
});


function componentPreparationEvidence(stdout = 'fixture-tool-v1\n')
{
    const maximumBytesPerStream = 1_048_576;
    return {
        schema: 'fsusblog.physical-execution-process-tree.v1', platform: 'linux',
        policy: { maximumCapturedOutputBytesPerStream: maximumBytesPerStream },
        authority: { kind: 'linux-cgroup-process-group', established: true },
        lifecycle: ['post-observe-zero-members', 'bounded-pipe-close', 'seal-completed-receipt'],
        termination: [], postObservation: 'zero-members', logComplete: true,
        logTruncationReason: null, forcedPipeClose: false,
        processInventory: [{ role: 'direct-child', pid: 123, startIdentity: 'component-only-start', exitCode: 0, signal: null }],
        stdout, stderr: '',
        outputCapture: {
            maximumBytesPerStream, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0,
            stdoutCapturedBytes: Buffer.byteLength(stdout), stderrCapturedBytes: 0,
            stdoutTruncated: false, stderrTruncated: false
        }
    };
}

function componentPreparationRequest()
{
    return { purpose: 'executable-version', command: ['/fixture/tool', '--version'],
        cwd: path.resolve('component-owned-directory'), environment: { LANG: 'C.UTF-8', TMPDIR: '/fixture/owned' } };
}

function componentPreparationOwner(evidence = componentPreparationEvidence())
{
    const accepted = new WeakSet();
    const calls = [];
    return {
        evidence, calls,
        executePreparation: async (request) =>
        {
            assert.ok(accepted.has(request));
            calls.push({ phase: 'execute', request });
            return evidence;
        },
        assertPreparationExecution: async ({ request, phase, physicalExecution }) =>
        {
            calls.push({ phase, request });
            if (phase === 'before')
            {
                assert.equal(physicalExecution, null);
                accepted.add(request);
            }
            else
            {
                assert.ok(accepted.has(request));
                assert.equal(physicalExecution, evidence);
            }
        }
    };
}

test('component async preparation requires both original-owner callbacks before effects', async () =>
{
    let executions = 0;
    const executePreparation = async () =>
    {
        executions += 1;
        return componentPreparationEvidence();
    };
    for (const ports of [{}, { executePreparation }, { assertPreparationExecution: async () =>
    {} }])
    {
        await assert.rejects(executeManagedPreparation(componentPreparationRequest(), ports), /held-managed/u);
    }
    assert.equal(executions, 0);
});

test('component async preparation carries one detached frozen tuple through before execute and after', async () =>
{
    const request = componentPreparationRequest();
    const owner = componentPreparationOwner();
    assert.equal(await executeManagedPreparation(request, owner), owner.evidence);
    assert.deepEqual(owner.calls.map((call) => call.phase), ['before', 'execute', 'after']);
    const actual = owner.calls[0].request;
    assert.notEqual(actual, request);
    assert.notEqual(actual.command, request.command);
    assert.notEqual(actual.environment, request.environment);
    assert.ok(Object.isFrozen(actual) && Object.isFrozen(actual.command) && Object.isFrozen(actual.environment));
    for (const call of owner.calls)
    {
        assert.equal(call.request, actual);
    }
    assert.deepEqual(actual, request);
});

test('component async preparation rejects incomplete failed deadline and unverifiable terminals after a valid control', async () =>
{
    const control = componentPreparationOwner();
    assert.equal(await executeManagedPreparation(componentPreparationRequest(), control), control.evidence);
    for (const mutate of [
        (e) =>
        {
            delete e.schema;
        }, (e) =>
        {
            e.platform = 'win32';
        },
        (e) =>
        {
            e.authority.established = false;
        }, (e) =>
        {
            e.postObservation = 'unverifiable';
        },
        (e) =>
        {
            e.logComplete = false;
        }, (e) =>
        {
            e.logTruncationReason = 'pipe-close-deadline-exceeded';
        },
        (e) =>
        {
            e.forcedPipeClose = true;
        }, (e) =>
        {
            e.lifecycle = ['seal-completed-receipt'];
        },
        (e) =>
        {
            e.processInventory = [];
        }, (e) =>
        {
            e.processInventory[0].startIdentity = null;
        },
        (e) =>
        {
            e.processInventory[0].exitCode = 124;
            e.lifecycle[2] = 'seal-cancelled-or-failed-receipt';
        },
        (e) =>
        {
            e.processInventory[0].signal = 'SIGTERM';
        },
        (e) =>
        {
            e.termination = [{ phase: 'forced', signal: 'SIGKILL' }];
        }
    ])
    {
        const evidence = componentPreparationEvidence();
        mutate(evidence);
        const owner = componentPreparationOwner(evidence);
        await assert.rejects(executeManagedPreparation(componentPreparationRequest(), owner), (error) =>
        {
            assert.match(error.message, /incomplete or failed/u);
            assert.equal(error.physicalExecution, evidence);
            return true;
        });
        assert.deepEqual(owner.calls.map((call) => call.phase), ['before', 'execute', 'after']);
    }
});

test('component async preparation refuses missing truncated and mismatched stream captures', async () =>
{
    for (const stream of ['stdout', 'stderr'])
    {
        for (const mutate of [
            (c) =>
            {
                delete c[`${stream}Truncated`];
            }, (c) =>
            {
                c[`${stream}Truncated`] = true;
            },
            (c) =>
            {
                c[`${stream}Bytes`] = -1;
            }, (c) =>
            {
                c[`${stream}CapturedBytes`] += 1;
            },
            (c) =>
            {
                c[`${stream}Bytes`] = c.maximumBytesPerStream + 1;
                c[`${stream}CapturedBytes`] = c[`${stream}Bytes`];
            }
        ])
        {
            const owner = componentPreparationOwner();
            mutate(owner.evidence.outputCapture);
            await assert.rejects(executeManagedPreparation(componentPreparationRequest(), owner), /capture is incomplete or unbounded/u);
        }
    }
    const owner = componentPreparationOwner();
    delete owner.evidence.outputCapture;
    await assert.rejects(executeManagedPreparation(componentPreparationRequest(), owner), /incomplete or failed/u);
});

test('component original-owner before assertion rejects identity drift and cancellation without execution', async () =>
{
    for (const field of ['run', 'source', 'producer', 'attempt', 'peer-incarnation', 'cancelled'])
    {
        const owner = componentPreparationOwner();
        let executed = false;
        const failure = new Error(`component owner refused ${field}`);
        await assert.rejects(executeManagedPreparation(componentPreparationRequest(), {
            executePreparation: async () =>
            {
                executed = true;
                return owner.evidence;
            },
            assertPreparationExecution: async () =>
            {
                throw failure;
            }
        }), (error) => error === failure);
        assert.equal(executed, false);
    }
});

test('component original-owner after assertion rejects changed ownership and retains actual terminal', async () =>
{
    const owner = componentPreparationOwner();
    const failure = new Error('component peer changed during awaited execution');
    const phases = [];
    await assert.rejects(executeManagedPreparation(componentPreparationRequest(), {
        executePreparation: owner.executePreparation,
        assertPreparationExecution: async (value) =>
        {
            phases.push(value.phase);
            await owner.assertPreparationExecution(value);
            if (value.phase === 'after')
            {
                throw failure;
            }
        }
    }), (error) => error === failure && error.physicalExecution === owner.evidence);
    assert.deepEqual(phases, ['before', 'after']);
});

test('component async preparation preserves tool first cause when the post-owner assertion also fails', async () =>
{
    const evidence = componentPreparationEvidence();
    const primary = Object.assign(new Error('component tool deadline'), { exitCode: 124, physicalExecution: evidence });
    const secondary = new Error('component owner no longer verifiable');
    const phases = [];
    await assert.rejects(executeManagedPreparation(componentPreparationRequest(), {
        executePreparation: async () =>
        {
            throw primary;
        },
        assertPreparationExecution: async ({ phase, physicalExecution }) =>
        {
            phases.push(phase);
            if (phase === 'after')
            {
                assert.equal(physicalExecution, evidence);
                throw secondary;
            }
        }
    }), (error) => error === primary && error.exitCode === 124
        && error.physicalExecution === evidence && error.preparationOwnerAssertionError === secondary);
    assert.deepEqual(phases, ['before', 'after']);
});

test('component async executable observation reuses original version arguments and identity fields', async () =>
{
    for (const [name, arguments_] of [['node', ['--version']], ['msbuild', ['-version', '-nologo']]])
    {
        const owner = componentPreparationOwner();
        const identity = await observeExecutableIdentityAsync(name, {
            ...owner, cwd: path.resolve('.'), pathValue: '/fixture', environment: { PATH: '/fixture' },
            resolve: (requested) => `/fixture/${requested}`, realpath: (file) => file,
            readFile: () => Buffer.from('component-binary')
        });
        assert.equal(identity.requestedName, name);
        assert.equal(identity.version, 'fixture-tool-v1');
        assert.match(identity.sha256, /^sha256:[a-f0-9]{64}$/u);
        assert.deepEqual(owner.calls[1].request.command, [`/fixture/${name}`, ...arguments_]);
    }
});

test('component async executable observation rejects invented version arguments before tool execution', async () =>
{
    const owner = componentPreparationOwner();
    await assert.rejects(observeExecutableIdentityAsync('node', {
        ...owner, cwd: path.resolve('.'), pathValue: '/fixture', environment: { PATH: '/fixture' },
        resolve: () => '/fixture/node', realpath: (file) => file, readFile: () => Buffer.from('binary'),
        versionArgs: ['--execute-anything']
    }), /original tool observation rule/u);
    assert.deepEqual(owner.calls, []);
});

test('component async correctness preparation awaits both original exact executable observations', async () =>
{
    const owner = componentPreparationOwner();
    const result = await prepareCorrectnessEnvironmentAsync({
        command: [process.execPath, '-e', '0'], cwd: path.resolve('.'),
        parentEnvironment: { PATH: process.env.PATH }, producerAllowlist: [],
        injectedEnvironment: { FSUSBLOG_TEST_RUN_ID: 'component-async-run' }, policy, catalog, ...owner
    });
    assert.deepEqual(owner.calls.map((call) => call.phase), ['before', 'execute', 'after', 'before', 'execute', 'after']);
    assert.deepEqual(result.fragment.actualExecutable, result.fragment.plannedExecutable);
    assert.equal(result.fragment.admission, 'planned-actual-exact');
    assert.deepEqual(result.command.slice(1), ['-e', '0']);
    assert.equal(result.environment.FSUSBLOG_TEST_RUN_ID, 'component-async-run');
});

test('controller factory refuses absent original retention and tool owners before preparation', async () =>
{
    const { prepareAuthenticatedNestedEnvelope } = await import(new URL('../../tools/test/run-deterministic-command.mjs', import.meta.url));
    await assert.rejects(prepareAuthenticatedNestedEnvelope({}), /original retained directory and complete private tool owner/u);
});

test('controller factory refuses an incomplete finalization owner before admission or preparation', async () =>
{
    const { prepareAuthenticatedNestedEnvelope } = await import(new URL('../../tools/test/run-deterministic-command.mjs', import.meta.url));
    let effects = 0;
    await assert.rejects(prepareAuthenticatedNestedEnvelope({
        assertAdmission: () =>
        {
            effects += 1;
        }, retainAttempt: () =>
        {
            effects += 1;
        },
        preparationOwner: { executePreparation: () =>
        {
            effects += 1;
        },
        assertPreparationExecution: () =>
        {
            effects += 1;
        } }
    }), /complete private tool owner/u);
    assert.equal(effects, 0);
});

test('controller factory preserves actual owner admission refusal without directory retention or tools', async () =>
{
    const { prepareAuthenticatedNestedEnvelope } = await import(new URL('../../tools/test/run-deterministic-command.mjs', import.meta.url));
    const refusal = new Error('component original owner admission refused');
    let effects = 0;
    await assert.rejects(prepareAuthenticatedNestedEnvelope({
        assertAdmission: () =>
        {
            throw refusal;
        }, retainAttempt: () =>
        {
            effects += 1;
        },
        preparationOwner: { executePreparation: () =>
        {
            effects += 1;
        },
        assertPreparationExecution: () =>
        {
            effects += 1;
        },
        assertFinalizablePreparation: () =>
        {
            effects += 1;
        } }
    }), (error) => error === refusal);
    assert.equal(effects, 0);
});

function componentFailureOwner({ execute, afterFails = false, afterReason } = {})
{
    const state = { tool: null, physicalExecution: null };
    return {
        state,
        executePreparation: execute ?? (async () => componentPreparationEvidence()),
        assertPreparationExecution: async ({ request, phase, physicalExecution, preparationFailure }) =>
        {
            if (phase === 'before')
            {
                state.tool = { request };
                return;
            }
            assert.equal(request, state.tool.request);
            state.physicalExecution = physicalExecution;
            retainNestedPreparationFailure(state.tool, preparationFailure);
            if (afterFails)
            {
                throw afterReason;
            }
        }
    };
}

async function componentRejection(promise)
{
    let failed = false;
    let reason;
    try
    {
        await promise;
    }
    catch (error)
    {
        failed = true;
        reason = error;
    }
    assert.equal(failed, true, 'the original public consumer must reject, including when the reason is undefined');
    return reason;
}

test('component public preparation keeps frozen first reason across execution await and after-owner failure', async () =>
{
    const controller = new AbortController();
    const primary = Object.freeze(new Error('immutable original awaiting cancellation'));
    const secondary = Object.assign(new Error('original post-owner unavailable'), {
        recoveryObligation: { ownedRoot: '/component-fixture/retained', reason: 'unknown physical terminal' }
    });
    let release;
    const admission = new Promise((resolve) =>
    {
        release = resolve;
    });
    let entered;
    const pending = new Promise((resolve) =>
    {
        entered = resolve;
    });
    const owner = componentFailureOwner({ afterFails: true, afterReason: secondary,
        execute: async () =>
        {
            entered();
            await admission;
            controller.signal.throwIfAborted();
        } });
    const result = executeManagedPreparation(componentPreparationRequest(), owner);
    await pending;
    controller.abort(primary);
    release();
    assert.equal(await componentRejection(result), primary);
    const retained = owner.state.tool.preparationFailure;
    assert.equal(retained.failed, true);
    assert.equal(retained.reason, primary);
    assert.equal(retained.secondaryFailed, true);
    assert.equal(retained.secondaryReason, secondary);
    assert.equal(retained.secondaryReason.recoveryObligation, secondary.recoveryObligation);
    assert.equal(retained.physicalExecution, null);
    assert.ok(retained.metadataFailures.length > 0);
    assert.equal(Object.hasOwn(primary, 'preparationOwnerAssertionError'), false);
});

test('component public preparation preserves every falsy first reason without output validation fallthrough', async () =>
{
    for (const primary of [0, -0, false, '', null, undefined, NaN, 0n])
    {
        const owner = componentFailureOwner({ execute: async () =>
        {
            throw primary;
        } });
        assert.ok(Object.is(await componentRejection(executeManagedPreparation(componentPreparationRequest(), owner)), primary));
        const retained = owner.state.tool.preparationFailure;
        assert.equal(retained.failed, true);
        assert.ok(Object.is(retained.reason, primary));
        assert.equal(retained.secondaryFailed, false);
        assert.equal(retained.physicalExecution, null);
    }
});

test('component public preparation retains falsy primary and falsy secondary independently', async () =>
{
    for (const [primary, secondary] of [[undefined, null], [null, undefined], [0, false], [false, ''], ['', 0]])
    {
        const owner = componentFailureOwner({ execute: async () =>
        {
            throw primary;
        },
        afterFails: true, afterReason: secondary });
        assert.ok(Object.is(await componentRejection(executeManagedPreparation(componentPreparationRequest(), owner)), primary));
        const retained = owner.state.tool.preparationFailure;
        assert.equal(retained.failed, true);
        assert.ok(Object.is(retained.reason, primary));
        assert.equal(retained.secondaryFailed, true);
        assert.ok(Object.is(retained.secondaryReason, secondary));
    }
});

test('component public preparation keeps truthy primitive and immutable object first reasons', async () =>
{
    for (const primary of ['original primitive', 37, Symbol('original reason'), Object.freeze({ original: true })])
    {
        const secondary = new Error('component secondary owner failure');
        const owner = componentFailureOwner({ execute: async () =>
        {
            throw primary;
        },
        afterFails: true, afterReason: secondary });
        assert.equal(await componentRejection(executeManagedPreparation(componentPreparationRequest(), owner)), primary);
        const retained = owner.state.tool.preparationFailure;
        assert.equal(retained.reason, primary);
        assert.equal(retained.secondaryReason, secondary);
    }
});

test('component public preparation retains successful raw physical output when after alone throws falsy or frozen reason', async () =>
{
    for (const primary of [undefined, null, false, 0, '', Object.freeze(new Error('immutable after refusal'))])
    {
        const physicalExecution = componentPreparationEvidence();
        const owner = componentFailureOwner({ execute: async () => physicalExecution,
            afterFails: true, afterReason: primary });
        assert.ok(Object.is(await componentRejection(executeManagedPreparation(componentPreparationRequest(), owner)), primary));
        const retained = owner.state.tool.preparationFailure;
        assert.equal(retained.failed, true);
        assert.ok(Object.is(retained.reason, primary));
        assert.equal(retained.secondaryFailed, false);
        assert.equal(retained.physicalExecution, physicalExecution);
        assert.equal(owner.state.physicalExecution, physicalExecution);
    }
});

test('component public preparation getter and compatibility setter faults remain diagnostics, not first reason', async () =>
{
    const primary = new Error('original reason with hostile metadata');
    const getterFailure = new Error('physical metadata getter fault');
    const setterFailure = new Error('secondary compatibility setter fault');
    Object.defineProperty(primary, 'physicalExecution', { get()
    {
        throw getterFailure;
    } });
    Object.defineProperty(primary, 'preparationOwnerAssertionError', { set()
    {
        throw setterFailure;
    } });
    const secondary = new Error('original after-owner failure');
    const owner = componentFailureOwner({ execute: async () =>
    {
        throw primary;
    },
    afterFails: true, afterReason: secondary });
    assert.equal(await componentRejection(executeManagedPreparation(componentPreparationRequest(), owner)), primary);
    const retained = owner.state.tool.preparationFailure;
    assert.equal(retained.reason, primary);
    assert.equal(retained.secondaryReason, secondary);
    assert.equal(retained.physicalExecution, null);
    assert.ok(retained.metadataFailures.some((entry) => entry.reason === getterFailure));
    assert.ok(retained.metadataFailures.some((entry) => entry.reason === setterFailure));
});

test('component public preparation keeps mutable Error compatibility and original physical object', async () =>
{
    const physicalExecution = componentPreparationEvidence();
    const primary = Object.assign(new Error('original mutable deadline'), { physicalExecution, exitCode: 124 });
    const secondary = new Error('original secondary owner refusal');
    const owner = componentFailureOwner({ execute: async () =>
    {
        throw primary;
    },
    afterFails: true, afterReason: secondary });
    assert.equal(await componentRejection(executeManagedPreparation(componentPreparationRequest(), owner)), primary);
    assert.equal(primary.physicalExecution, physicalExecution);
    assert.equal(primary.preparationOwnerAssertionError, secondary);
    assert.equal(primary.exitCode, 124);
    assert.equal(owner.state.tool.preparationFailure.physicalExecution, physicalExecution);
    assert.equal(owner.state.tool.preparationFailure.metadataFailures.length, 0);
});

test('component public preparation benign success retains readonly diagnostics without granting authority', async () =>
{
    const physicalExecution = componentPreparationEvidence();
    const owner = componentFailureOwner({ execute: async () => physicalExecution });
    assert.equal(await executeManagedPreparation(componentPreparationRequest(), owner), physicalExecution);
    const retained = owner.state.tool.preparationFailure;
    assert.ok(Object.isFrozen(retained));
    assert.equal(retained.failed, false);
    assert.equal(retained.reason, undefined);
    assert.equal(retained.secondaryFailed, false);
    assert.equal(retained.physicalExecution, physicalExecution);
    assert.equal(Reflect.set(retained, 'failed', true), false);
    assert.equal(Reflect.set(retained, 'physicalExecution', { postObservation: 'zero-members' }), false);
    assert.equal(retained.physicalExecution, owner.state.physicalExecution);
});

test('component public preparation validation failure stays visible in the original retained diagnostic carrier', async () =>
{
    const physicalExecution = componentPreparationEvidence();
    physicalExecution.postObservation = 'unverifiable';
    const owner = componentFailureOwner({ execute: async () => physicalExecution });
    const primary = await componentRejection(executeManagedPreparation(componentPreparationRequest(), owner));
    assert.match(primary.message, /incomplete or failed/u);
    assert.equal(primary.physicalExecution, physicalExecution);
    assert.equal(owner.state.tool.preparationFailure.failed, true);
    assert.equal(owner.state.tool.preparationFailure.reason, primary);
    assert.equal(owner.state.tool.preparationFailure.physicalExecution, physicalExecution);
});
