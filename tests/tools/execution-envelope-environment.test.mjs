import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createMinimalCorrectnessEnvironment,
    observeExecutableIdentity,
    prepareCorrectnessEnvironment,
    verifyExecutableIdentity
} from '../../tools/test/execution-envelope-environment.mjs';
import {
    loadExecutionEnvelopeApplicability,
    loadExecutionEnvelopePolicy
} from '../../tools/test-matrix/execution-envelope-policy.mjs';

const policy = loadExecutionEnvelopePolicy();
const catalog = loadExecutionEnvelopeApplicability();

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
