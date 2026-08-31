import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    collectProcessGroupOrJobIdentity,
    collectProcessIdentity,
    currentProcessIdentity,
    parseMacProcessIdentityFields,
    processDescendantIdentities,
    processIdentityStatus
} from '../../tools/test/process-identity.mjs';
import {
    heartbeatRunOnceLock,
    reclaimStaleRunOnceLock,
    runOnce,
    validateRunOnceLockLifecycleReceipt
} from '../../tools/test/run-once.mjs';

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-run-once-identity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function writeOwner(root, namespace, key, owner)
{
    const directory = path.join(root, namespace, `${key}.lock`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'owner.json'), `${JSON.stringify(owner)}\n`);
}

function liveOwner(namespace, key, overrides = {})
{
    const identity = currentProcessIdentity();
    return {
        ...identity,
        schema: 'fsusblog.run-once-lock-owner.v3',
        ownerToken: 'old-owner',
        schedulerRunId: 'scheduler',
        namespace,
        executionKey: key,
        createdAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        heartbeatEveryMs: 1,
        staleAfterMs: 60_000,
        unverifiableGraceMs: 60_000,
        ...overrides
    };
}

async function assertOwnerMutationIsReclaimed(t, key, transform)
{
    const root = fixture(t);
    const namespace = 'identity';
    writeOwner(root, namespace, key, transform(liveOwner(namespace, key)));
    const output = path.join(root, 'output');
    const result = await runOnce(
        { root, namespace, key, fingerprint: 'current', requiredOutputs: [output], lockTimeoutMs: 300, heartbeatMs: 1 },
        async () => fs.writeFileSync(output, 'ok')
    );
    assert.equal(result.status, 'executed');
}

test('PID reuse alone reclaims a stale run-once owner', async (t) =>
{
    await assertOwnerMutationIsReclaimed(t, 'start-mismatch', (owner) => ({
        ...owner,
        processStartIdentity: `${owner.processStartIdentity}:reused`
    }));
});

test('executable path mismatch alone reclaims a stale run-once owner', async (t) =>
{
    await assertOwnerMutationIsReclaimed(t, 'path-mismatch', (owner) => ({
        ...owner,
        executablePath: `${owner.executablePath}.replacement`
    }));
});

test('executable byte digest mismatch alone reclaims a stale run-once owner', async (t) =>
{
    await assertOwnerMutationIsReclaimed(t, 'digest-mismatch', (owner) => ({
        ...owner,
        executableDigest: `sha256:${'0'.repeat(64)}`
    }));
});

test('command digest mismatch alone reclaims a stale run-once owner', async (t) =>
{
    await assertOwnerMutationIsReclaimed(t, 'command-mismatch', (owner) => ({
        ...owner,
        commandDigest: `sha256:${'f'.repeat(64)}`
    }));
});

test('Windows collector binds creation, executable and command while rejecting PPID snapshots as Job authority', () =>
{
    const execute = (_command, args) =>
    {
        const script = args.at(-1);
        if (script.includes('Select-Object ProcessId,ParentProcessId'))
        {
            return JSON.stringify([
                { ProcessId: 100, ParentProcessId: 1 },
                { ProcessId: 101, ParentProcessId: 100 }
            ]);
        }
        const pid = Number(script.match(/ProcessId=(\d+)/u)?.[1]);
        return JSON.stringify({
            ProcessId: pid,
            CreationDate: pid === 100 ? '20260726180102.000000+480' : '20260726180103.000000+480',
            ExecutablePath: process.execPath,
            CommandLine: `"${process.execPath}" "C:\\Program Files\\builder ${pid}.js"`
        });
    };
    const identity = collectProcessIdentity(100, { platform: 'win32', execute });
    assert.equal(identity.status, 'verified');
    assert.equal(identity.processStartIdentity, 'windows:20260726180102.000000+480');
    const tree = collectProcessGroupOrJobIdentity(100, { platform: 'win32', execute });
    assert.equal(tree.status, 'unverifiable');
    assert.match(tree.reason, /not a durable Job Object authority/u);
    const descendants = processDescendantIdentities(identity, { platform: 'win32', execute });
    assert.equal(descendants.status, 'unverifiable');
    assert.match(descendants.reason, /durable Job Object authority/u);
});

test('macOS collector uses microsecond start identity and full-width space-safe command fields', (t) =>
{
    const root = fixture(t);
    const executable = path.join(root, 'Runtime With Spaces', 'node binary');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'mac-executable');
    const requestedFields = [];
    const execute = (command, args) =>
    {
        if (command === '/usr/bin/python3')
        {
            if (args[1].includes('proc_pidinfo'))
            {
                requestedFields.push('proc-start');
                return '1785060062:123456\n';
            }
            if (args[1].includes('proc_pidpath'))
            {
                requestedFields.push('proc-path');
                return `${executable}\n`;
            }
            throw new Error('unexpected macOS libproc script');
        }
        if (args[0] === '-axo')
        {
            return '200 200\n201 200\n';
        }
        assert.equal(args[0], '-ww');
        const field = args[2];
        requestedFields.push(field);
        if (field === 'command=')
        {
            return `"${executable}" "argument with spaces"\n`;
        }
        if (args[0] === '-o' && args[1] === 'pgid=')
        {
            return '200\n';
        }
        throw new Error(`unexpected ps field: ${field}`);
    };
    const identity = collectProcessIdentity(200, { platform: 'darwin', execute });
    assert.equal(identity.status, 'verified');
    assert.equal(identity.processStartIdentity, 'darwin:1785060062:123456');
    assert.equal(identity.executablePath, executable);
    assert.deepEqual(requestedFields, ['proc-start', 'proc-path', 'command=']);
});

test('macOS identity distinguishes same-second PID reuse and never accepts truncated or unavailable identity', (t) =>
{
    const root = fixture(t);
    const executable = path.join(root, 'node');
    fs.writeFileSync(executable, 'mac-executable');
    const collect = (startIdentity, commandSuffix) =>
        collectProcessIdentity(200, {
            platform: 'darwin',
            execute(command, args)
            {
                if (command === '/usr/bin/python3')
                {
                    if (args[1].includes('proc_pidinfo'))
                    {
                        return `${startIdentity}\n`;
                    }
                    if (args[1].includes('proc_pidpath'))
                    {
                        return `${executable}\n`;
                    }
                    throw new Error('unexpected macOS libproc script');
                }
                const field = args[2];
                if (field === 'command=')
                {
                    return `${executable} ${'x'.repeat(512)}${commandSuffix}\n`;
                }
                throw new Error('unexpected macOS collector command');
            }
        });
    const first = collect('1785060062:000001', '-first');
    const reused = collect('1785060062:000002', '-first');
    const fullCommandChanged = collect('1785060062:000001', '-second');
    assert.equal(first.status, 'verified');
    assert.notEqual(first.processStartIdentity, reused.processStartIdentity);
    assert.notEqual(first.commandDigest, fullCommandChanged.commandDigest);
    const unavailable = collectProcessIdentity(200, {
        platform: 'darwin',
        execute(command)
        {
            if (command === '/usr/bin/python3')
            {
                throw new Error('libproc denied');
            }
            return '';
        }
    });
    assert.equal(unavailable.status, 'unverifiable');
});

test('cross-platform collector never degrades to PID-only identity', () =>
{
    const missing = collectProcessIdentity(process.pid, {
        platform: 'linux',
        procRoot: path.join(os.tmpdir(), 'missing-proc')
    });
    assert.equal(missing.status, 'unverifiable');
    assert.notEqual(processIdentityStatus({ pid: process.pid }).status, 'live');
    const windows = collectProcessIdentity(process.pid, {
        platform: 'win32',
        execute: () =>
        {
            throw new Error('PowerShell unavailable');
        }
    });
    assert.equal(windows.status, 'unverifiable');
    assert.deepEqual(
        parseMacProcessIdentityFields({
            startIdentity: 'Sat Jul 26 18:01:02 2026',
            executablePath: '/Applications/Node Runtime/bin/node',
            command: '/Applications/Node Runtime/bin/node --token=secret'
        }),
        {
            startIdentity: 'Sat Jul 26 18:01:02 2026',
            executablePath: '/Applications/Node Runtime/bin/node',
            command: '/Applications/Node Runtime/bin/node --token=secret'
        }
    );
});

test('Linux proc stat parsing survives parenthesized command names and discovers a real child identity', async (t) =>
{
    const procRoot = fixture(t);
    const processRoot = path.join(procRoot, '123');
    fs.mkdirSync(path.join(procRoot, 'sys/kernel/random'), { recursive: true });
    fs.mkdirSync(processRoot);
    fs.writeFileSync(path.join(procRoot, 'sys/kernel/random/boot_id'), 'boot-id\n');
    const fields = Array.from({ length: 20 }, () => '0');
    fields[18] = '42';
    fs.writeFileSync(path.join(processRoot, 'stat'), `123 (name with ) parentheses) S ${fields.join(' ')}\n`);
    fs.writeFileSync(path.join(processRoot, 'cmdline'), 'node\0fixture\0');
    const executable = path.join(procRoot, 'fixture-executable');
    fs.writeFileSync(executable, 'aaaa');
    fs.symlinkSync(executable, path.join(processRoot, 'exe'));
    const firstIdentity = collectProcessIdentity(123, { procRoot });
    assert.equal(firstIdentity.processStartIdentity, 'linux:boot-id:42');
    const executableTime = fs.statSync(executable).mtime;
    fs.writeFileSync(executable, 'bbbb');
    fs.utimesSync(executable, executableTime, executableTime);
    const changedIdentity = collectProcessIdentity(123, { procRoot });
    assert.notEqual(changedIdentity.executableDigest, firstIdentity.executableDigest);

    const zombieRoot = path.join(procRoot, '124');
    fs.mkdirSync(zombieRoot);
    const zombieFields = Array.from({ length: 20 }, () => '0');
    zombieFields[0] = '123';
    fs.writeFileSync(path.join(zombieRoot, 'stat'), `124 (exited child) Z ${zombieFields.join(' ')}\n`);
    const exitedDescendants = processDescendantIdentities(firstIdentity, { procRoot });
    assert.equal(exitedDescendants.status, 'verified', exitedDescendants.reason);
    assert.deepEqual(exitedDescendants.identities, []);

    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    t.after(() => child.kill('SIGKILL'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const descendants = processDescendantIdentities(currentProcessIdentity());
    assert.equal(descendants.status, 'verified', descendants.reason);
    assert.ok(descendants.identities.some((identity) => identity.pid === child.pid));
});

test('a live owner cannot be replaced by a different heartbeat token', async (t) =>
{
    const root = fixture(t);
    const namespace = 'heartbeat';
    const key = 'compile';
    const identity = currentProcessIdentity();
    const owner = {
        ...identity,
        schema: 'fsusblog.run-once-lock-owner.v3',
        ownerToken: 'real-owner',
        schedulerRunId: null,
        namespace,
        executionKey: key,
        createdAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        heartbeatEveryMs: 1,
        staleAfterMs: 60_000,
        unverifiableGraceMs: 60_000
    };
    writeOwner(root, namespace, key, owner);
    const ownerFile = path.join(root, namespace, `${key}.lock/owner.json`);
    const beforeHeartbeat = JSON.parse(fs.readFileSync(ownerFile, 'utf8')).heartbeatAt;
    assert.equal(
        await heartbeatRunOnceLock({
            ownerFile,
            ownerToken: 'wrong-owner',
            ownerIdentity: identity,
            heartbeatAt: '2099-01-01T00:00:00.000Z'
        }),
        false
    );
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).heartbeatAt, beforeHeartbeat);
    await assert.rejects(
        runOnce({ root, namespace, key, fingerprint: 'current', lockTimeoutMs: 80, heartbeatMs: 1 }, async () =>
        {}),
        /timed out waiting/u
    );
    assert.equal(
        JSON.parse(fs.readFileSync(path.join(root, namespace, `${key}.lock/owner.json`), 'utf8')).ownerToken,
        'real-owner'
    );
});

test('a complete live owner is retained despite an old heartbeat and old filesystem mtimes', async (t) =>
{
    const root = fixture(t);
    const namespace = 'live-old-metadata';
    const key = 'compile';
    const oldCreatedAt = new Date(1_000).toISOString();
    const oldHeartbeatAt = new Date(2_000).toISOString();
    const owner = liveOwner(namespace, key, {
        createdAt: oldCreatedAt,
        heartbeatAt: oldHeartbeatAt,
        staleAfterMs: 1,
        unverifiableGraceMs: 1
    });
    writeOwner(root, namespace, key, owner);
    const lock = path.join(root, namespace, `${key}.lock`);
    fs.utimesSync(lock, new Date(0), new Date(0));
    fs.utimesSync(path.join(lock, 'owner.json'), new Date(0), new Date(0));
    assert.equal(await reclaimStaleRunOnceLock(lock, 1), false);
    assert.equal(fs.existsSync(lock), true);
});

test('heartbeat requires both the owner token and exact process identity and rejects non-monotonic or future time', async (t) =>
{
    const root = fixture(t);
    const namespace = 'heartbeat-identity';
    const key = 'compile';
    const owner = liveOwner(namespace, key);
    writeOwner(root, namespace, key, owner);
    const ownerFile = path.join(root, namespace, `${key}.lock/owner.json`);
    assert.equal(
        await heartbeatRunOnceLock({
            ownerFile,
            ownerToken: owner.ownerToken,
            ownerIdentity: { ...owner, commandDigest: `sha256:${'0'.repeat(64)}` }
        }),
        false
    );
    assert.equal(
        await heartbeatRunOnceLock({
            ownerFile,
            ownerToken: owner.ownerToken,
            ownerIdentity: owner,
            heartbeatAt: new Date(Date.parse(owner.heartbeatAt) - 1).toISOString()
        }),
        false
    );
    assert.equal(
        await heartbeatRunOnceLock({
            ownerFile,
            ownerToken: owner.ownerToken,
            ownerIdentity: owner,
            heartbeatAt: new Date(Date.now() + 60_000).toISOString()
        }),
        false
    );
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).heartbeatAt, owner.heartbeatAt);
});

test('reclaim compare-before-delete preserves a replacement owner that wins the token race', async (t) =>
{
    const root = fixture(t);
    const namespace = 'token-race';
    const key = 'compile';
    const identity = currentProcessIdentity();
    const stale = {
        ...identity,
        schema: 'fsusblog.run-once-lock-owner.v3',
        ownerToken: 'stale-owner',
        processStartIdentity: `${identity.processStartIdentity}:stale`,
        schedulerRunId: null,
        namespace,
        executionKey: key,
        createdAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
        heartbeatEveryMs: 1,
        staleAfterMs: 1,
        unverifiableGraceMs: 1
    };
    writeOwner(root, namespace, key, stale);
    const lock = path.join(root, namespace, `${key}.lock`);
    const reclaimed = await reclaimStaleRunOnceLock(lock, 1, {
        beforeDelete: ({ ownerFile }) =>
            fs.writeFileSync(
                ownerFile,
                `${JSON.stringify({
                    ...identity,
                    schema: 'fsusblog.run-once-lock-owner.v3',
                    ownerToken: 'replacement-owner',
                    schedulerRunId: null,
                    namespace,
                    executionKey: key,
                    createdAt: new Date().toISOString(),
                    heartbeatAt: new Date().toISOString(),
                    heartbeatEveryMs: 1,
                    staleAfterMs: 1,
                    unverifiableGraceMs: 1
                })}\n`
            )
    });
    assert.equal(reclaimed, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).ownerToken, 'replacement-owner');
});

test('temporarily unreadable identity honors grace then reports owner-unverifiable', async (t) =>
{
    const root = fixture(t);
    const namespace = 'identity-grace';
    const key = 'compile';
    const identity = currentProcessIdentity();
    const lock = path.join(root, namespace, `${key}.lock`);
    writeOwner(root, namespace, key, {
        ...identity,
        schema: 'fsusblog.run-once-lock-owner.v3',
        ownerToken: 'unreadable-owner',
        schedulerRunId: null,
        namespace,
        executionKey: key,
        createdAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        heartbeatEveryMs: 1,
        staleAfterMs: 1000,
        unverifiableGraceMs: 1000
    });
    const identityStatus = () => ({ status: 'unverifiable', actual: { reason: 'collector temporarily denied' } });
    assert.equal(await reclaimStaleRunOnceLock(lock, 1000, { identityStatus }), false);
    const old = new Date(0);
    const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    owner.createdAt = old.toISOString();
    owner.heartbeatAt = old.toISOString();
    fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify(owner)}\n`);
    await assert.rejects(reclaimStaleRunOnceLock(lock, 1, { identityStatus }), /owner-unverifiable/u);
    assert.equal(fs.existsSync(lock), true);
});

test('missing owner metadata observes grace and then fails closed instead of deleting the lock', async (t) =>
{
    const root = fixture(t);
    const namespace = 'missing-owner';
    const key = 'compile';
    const lock = path.join(root, namespace, `${key}.lock`);
    fs.mkdirSync(lock, { recursive: true });
    assert.equal(await reclaimStaleRunOnceLock(lock, 1, { nowMs: 1_000 }), false);
    assert.equal(fs.existsSync(lock), true);
    fs.utimesSync(lock, new Date(0), new Date(0));
    await assert.rejects(reclaimStaleRunOnceLock(lock, 1, { nowMs: 1_002 }), /owner-unverifiable/u);
    assert.equal(fs.existsSync(lock), true);
});

test('future owner timestamps use a bounded observation grace and cannot retain a lock forever', async (t) =>
{
    const root = fixture(t);
    const namespace = 'future-heartbeat';
    const key = 'compile';
    const lock = path.join(root, namespace, `${key}.lock`);
    writeOwner(
        root,
        namespace,
        key,
        liveOwner(namespace, key, {
            createdAt: '9999-01-01T00:00:00.000Z',
            heartbeatAt: '9999-01-01T00:00:00.000Z'
        })
    );
    assert.equal(await reclaimStaleRunOnceLock(lock, 5, { nowMs: 1_000 }), false);
    await assert.rejects(reclaimStaleRunOnceLock(lock, 5, { nowMs: 1_006 }), /owner-unverifiable/u);
});

test('run-once state persists and validates the dedicated lock lifecycle policy receipt', async (t) =>
{
    const root = fixture(t);
    const namespace = 'lifecycle';
    const key = 'compile';
    const output = path.join(root, 'output');
    const result = await runOnce(
        {
            root,
            namespace,
            key,
            fingerprint: 'source',
            requiredOutputs: [output],
            staleLockMs: 321,
            heartbeatMs: 7
        },
        async () => fs.writeFileSync(output, 'ok')
    );
    const state = JSON.parse(fs.readFileSync(result.stateFile, 'utf8'));
    assert.equal(
        validateRunOnceLockLifecycleReceipt(state.lockLifecycleReceipt, {
            namespace,
            executionKey: key
        }),
        true
    );
    assert.equal(state.lockLifecycleReceipt.policy.heartbeatEveryMs, 7);
    assert.equal(state.lockLifecycleReceipt.policy.staleAfterMs, 321);
    assert.equal(typeof state.lockLifecycleReceipt.ownerToken, 'string');
    const tampered = structuredClone(state.lockLifecycleReceipt);
    tampered.policy.staleAfterMs += 1;
    assert.throws(
        () => validateRunOnceLockLifecycleReceipt(tampered, { namespace, executionKey: key }),
        /integrity validation failed/u
    );
});
