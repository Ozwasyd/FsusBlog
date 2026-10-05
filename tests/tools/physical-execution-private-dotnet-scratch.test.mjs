import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPhysicalExecutionLinuxSystemdAdapter } from '../../tools/test/physical-execution-linux-systemd-adapter.mjs';
import { physicalExecutionProcessTreeSchema } from '../../tools/test/physical-execution-process-tree.mjs';

import {
    admitsPrivateDotnetScratch,
    finalizePrivateDotnetScratch,
    preparePrivateDotnetScratch,
    privateDotnetScratchPath,
    verifyPrivateDotnetScratchBinding,
    verifyPrivateTmpNamespace
} from '../../tools/test/physical-execution-private-dotnet-scratch.mjs';

function fixture(t, base = os.tmpdir())
{
    const root = fs.mkdtempSync(path.join(base, 'fsusblog-private-dotnet-scratch-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const tmpRoot = path.join(root, 'private-tmp');
    fs.mkdirSync(tmpRoot, { mode: 0o700 });
    const stat = fs.statSync(tmpRoot);
    return {
        root,
        tmpRoot,
        hostNamespace: 'mnt:[100]',
        unitNamespace: 'mnt:[101]',
        hostTmpIdentity: { dev: stat.dev, ino: stat.ino + 1 },
        privateTmp: 'yes'
    };
}

test('only the pinned matrix governance attempt admits private .NET scratch', () =>
{
    const environment = { FSUSBLOG_CONTENT_FIELD_DOTNET: '/opt/pinned/dotnet' };
    for (const producerId of ['matrix-governance', 'validate-matrix'])
    {
        assert.equal(admitsPrivateDotnetScratch({ producerId, attemptId: 'matrix-governance', environment }), true);
        assert.equal(admitsPrivateDotnetScratch({ producerId, attemptId: 'other', environment }), false);
    }
    assert.equal(admitsPrivateDotnetScratch({ producerId: 'backend-fast', attemptId: 'matrix-governance', environment }), false);
    assert.equal(admitsPrivateDotnetScratch({
        producerId: 'matrix-governance', attemptId: 'matrix-governance',
        environment: { FSUSBLOG_CONTENT_FIELD_DOTNET: 'dotnet' }
    }), false);
    assert.equal(privateDotnetScratchPath, '/tmp/.dotnet/shm');
});

test('private scratch admits exact owned path, observes output, and removes it', (t) =>
{
    const options = fixture(t);
    const state = preparePrivateDotnetScratch(options);
    const output = path.join(options.tmpRoot, '.dotnet/shm/session-1');
    fs.writeFileSync(output, 'mutex');
    const result = finalizePrivateDotnetScratch(state, { unitNamespace: options.unitNamespace });
    assert.deepEqual(result.observed.map((entry) => entry.path), ['session-1']);
    assert.equal(result.cleanup, 'removed');
    assert.equal(fs.existsSync(path.join(options.tmpRoot, '.dotnet')), false);
});

test('property without an isolated mount and private /tmp is refused before any write', (t) =>
{
    const options = fixture(t);
    for (const change of [
        { privateTmp: 'no' },
        { privateTmp: null },
        { unitNamespace: options.hostNamespace },
        { hostTmpIdentity: fs.statSync(options.tmpRoot) }
    ])
    {
        assert.throws(() => preparePrivateDotnetScratch({ ...options, ...change }),
            /proven distinct PrivateTmp/u);
        assert.equal(fs.existsSync(path.join(options.tmpRoot, '.dotnet')), false);
    }
    assert.throws(() => verifyPrivateTmpNamespace({
        ...options, unitNamespace: 'unverifiable'
    }), /proven distinct PrivateTmp/u);
});

test('foreign and symlinked scratch paths refuse; cleanup refuses identity drift', (t) =>
{
    const options = fixture(t);
    const dotnet = path.join(options.tmpRoot, '.dotnet');
    fs.mkdirSync(dotnet);
    assert.throws(() => preparePrivateDotnetScratch(options), /EEXIST/u);
    fs.rmdirSync(dotnet);
    fs.symlinkSync(options.root, dotnet);
    assert.throws(() => preparePrivateDotnetScratch(options), /EEXIST/u);
    fs.unlinkSync(dotnet);
    const state = preparePrivateDotnetScratch(options);
    assert.throws(() => finalizePrivateDotnetScratch(state, { unitNamespace: 'mnt:[102]' }),
        /namespace changed/u);
    fs.renameSync(dotnet, `${dotnet}-old`);
    fs.mkdirSync(dotnet);
    assert.throws(() => finalizePrivateDotnetScratch(state, { unitNamespace: options.unitNamespace }),
        /identity drift/u);
    assert.equal(fs.existsSync(`${dotnet}-old`), true);
});

test('private scratch binding refuses stale run, source, worktree, producer, and carrier', (t) =>
{
    const options = fixture(t);
    const toolCache = path.join(options.root, 'tool-cache');
    const controlRoot = path.join(toolCache, 'physical-systemd-test');
    fs.mkdirSync(controlRoot, { recursive: true });
    const environment = {
        FSUSBLOG_CONTENT_FIELD_DOTNET: '/opt/pinned/dotnet',
        FSUSBLOG_TEST_RUN_ID: 'run-1',
        FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40),
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'sha256:source',
        FSUSBLOG_TOOL_CACHE: toolCache
    };
    const binding = {
        schema: 'fsusblog.private-dotnet-scratch.v1',
        path: privateDotnetScratchPath,
        producerId: 'matrix-governance',
        schedulerRunId: 'run-1',
        attemptId: 'matrix-governance',
        sourceCommit: environment.FSUSBLOG_TEST_SOURCE_COMMIT,
        sourceFingerprint: environment.FSUSBLOG_TEST_SOURCE_FINGERPRINT,
        worktreeFingerprint: `sha256:${'b'.repeat(64)}`,
        workingDirectory: fs.realpathSync(options.root)
    };
    const verify = (candidate, env = environment, carrier = controlRoot) =>
        verifyPrivateDotnetScratchBinding(candidate, {
            environment: env, cwd: options.root, controlRoot: carrier
        });
    assert.doesNotThrow(() => verify(binding));
    for (const change of [
        { schedulerRunId: 'old-run' },
        { sourceCommit: 'c'.repeat(40) },
        { sourceFingerprint: 'old-source' },
        { worktreeFingerprint: 'sha256:old' },
        { producerId: 'backend-fast' },
        { attemptId: 'other' },
        { workingDirectory: toolCache }
    ])
    {
        assert.throws(() => verify({ ...binding, ...change }), /binding is invalid/u);
    }
    const crossedCarrier = path.join(options.root, 'other-cache', 'control');
    fs.mkdirSync(crossedCarrier, { recursive: true });
    assert.throws(() => verify(binding, environment, crossedCarrier), /binding is invalid/u);
});

test('real systemd unit proves private /tmp or refuses before host scratch is touched', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const capability = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' });
    if (capability.status !== 0)
    {
        t.skip('systemd user authority unavailable');
        return;
    }
    if (!fs.existsSync('/dev/shm'))
    {
        t.skip('shared memory carrier unavailable');
        return;
    }
    const options = fixture(t, '/dev/shm');
    const toolCache = path.join(options.root, 'tool-cache');
    fs.mkdirSync(toolCache);
    const marker = path.join(options.root, 'command-ran');
    const hostScratchBefore = fs.existsSync(privateDotnetScratchPath)
        ? fs.statSync(privateDotnetScratchPath) : null;
    const environment = {
        ...process.env,
        FSUSBLOG_CONTENT_FIELD_DOTNET: '/opt/pinned/dotnet',
        FSUSBLOG_TEST_RUN_ID: 'physical-run',
        FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40),
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'sha256:physical-source',
        FSUSBLOG_TOOL_CACHE: toolCache
    };
    const binding = {
        schema: 'fsusblog.private-dotnet-scratch.v1',
        path: privateDotnetScratchPath,
        producerId: 'matrix-governance',
        schedulerRunId: environment.FSUSBLOG_TEST_RUN_ID,
        attemptId: 'matrix-governance',
        sourceCommit: environment.FSUSBLOG_TEST_SOURCE_COMMIT,
        sourceFingerprint: environment.FSUSBLOG_TEST_SOURCE_FINGERPRINT,
        worktreeFingerprint: `sha256:${'b'.repeat(64)}`,
        workingDirectory: fs.realpathSync(options.root)
    };
    const policy = {
        schema: 'fsusblog.physical-execution-process-policy.v1',
        gracefulTerminationMs: 80,
        forceTerminationMs: 1500,
        pipeCloseTimeoutMs: 1500,
        observationIntervalMs: 10,
        zeroMemberObservations: 2,
        maximumCapturedOutputBytesPerStream: 1024 * 1024,
        unixProcessGroupRequired: true,
        linuxCgroupRequired: true,
        windowsJobObjectRequired: true
    };
    const adapter = createPhysicalExecutionLinuxSystemdAdapter();
    let evidence;
    try
    {
        evidence = await adapter.run({
            command: [process.execPath, '-e',
                `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
            cwd: options.root,
            env: environment,
            linuxReadWritePaths: [toolCache, options.root],
            privateDotnetScratch: binding,
            policy,
            stdout: { write() {} },
            stderr: { write() {} },
            schema: physicalExecutionProcessTreeSchema
        });
    }
    catch (error)
    {
        assert.match(error.message, /proven distinct PrivateTmp mount namespace/u);
        assert.equal(fs.existsSync(marker), false);
    }
    if (evidence)
    {
        assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
        assert.equal(evidence.authority.privateDotnetScratch.cleanup, 'removed');
    }
    const hostScratchAfter = fs.existsSync(privateDotnetScratchPath)
        ? fs.statSync(privateDotnetScratchPath) : null;
    assert.equal(hostScratchAfter?.dev ?? null, hostScratchBefore?.dev ?? null);
    assert.equal(hostScratchAfter?.ino ?? null, hostScratchBefore?.ino ?? null);
});
