import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    bindReservationServer,
    canonicalize,
    createPortLeaseAllocator,
    defaultRoleCatalog,
    sealPortLeaseManifest,
    verifySealedPortLeaseManifest
} from '../../tools/test-matrix/production-fresh-port-lease.mjs';

const modulePath = path.resolve('tools/test-matrix/production-fresh-port-lease.mjs');

function listen(port, host = '127.0.0.1')
{
    return new Promise((resolve, reject) =>
    {
        const server = net.createServer();
        server.once('error', reject);
        server.listen({ port, host }, () => resolve(server));
    });
}

function ssListenerLines(port)
{
    try
    {
        return execFileSync('ss', ['-H', '-ltn', `( sport = :${port} )`], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        })
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
    }
    catch
    {
        return null;
    }
}

function tempDir(t, prefix)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

async function freePortForPin(role = 'postgres')
{
    const probe = createPortLeaseAllocator({ runId: 'probe', namespace: 'probe', roles: defaultRoleCatalog().filter((entry) => entry.role === role) });
    const leases = await probe.allocate();
    const port = leases[0].port;
    await probe.releaseAll('probe-release');
    return port;
}

test('concurrent allocators in the same range never return duplicate ports', async () =>
{
    for (let round = 0; round < 6; round += 1)
    {
        const runId = `concurrent-${round}`;
        const first = createPortLeaseAllocator({ runId: `${runId}-a`, namespace: 'concurrent', roles: defaultRoleCatalog().filter((entry) => entry.role === 'postgres') });
        const second = createPortLeaseAllocator({ runId: `${runId}-b`, namespace: 'concurrent', roles: defaultRoleCatalog().filter((entry) => entry.role === 'postgres') });
        const [a, b] = await Promise.all([first.allocate(), second.allocate()]);
        try
        {
            assert.notEqual(a[0].port, b[0].port, `round ${round}: duplicate concurrent port`);
            assert.ok(a[0].port >= 20000 && a[0].port <= 21999);
            assert.ok(b[0].port >= 20000 && b[0].port <= 21999);
        }
        finally
        {
            await Promise.all([first.releaseAll('test-done'), second.releaseAll('test-done')]);
        }
    }
});

test('reservation is OS-held but invisible to ss while blocking a second allocator', async () =>
{
    const port = await freePortForPin('postgres');
    const first = createPortLeaseAllocator({
        runId: 'ss-invisible-a',
        namespace: 'ss-invisible',
        roles: defaultRoleCatalog().filter((entry) => entry.role === 'postgres'),
        pins: { postgres: port }
    });
    await first.allocate();
    try
    {
        const ssLines = ssListenerLines(port);
        assert.ok(ssLines === null || ssLines.length === 0, `reservation must not appear as a listener: ${ssLines?.join(',')}`);
        const second = createPortLeaseAllocator({
            runId: 'ss-invisible-b',
            namespace: 'ss-invisible',
            roles: defaultRoleCatalog().filter((entry) => entry.role === 'postgres'),
            pins: { postgres: port }
        });
        await assert.rejects(second.allocate(), /unavailable/u);
    }
    finally
    {
        await first.releaseAll('test-done');
    }
    const third = createPortLeaseAllocator({
        runId: 'ss-invisible-c',
        namespace: 'ss-invisible',
        roles: defaultRoleCatalog().filter((entry) => entry.role === 'postgres'),
        pins: { postgres: port }
    });
    const leases = await third.allocate();
    assert.equal(leases[0].port, port);
    await third.releaseAll('test-done');
});

test('third process preemption before env write fails while reservation is held', async () =>
{
    const port = await freePortForPin('redis');
    const allocator = createPortLeaseAllocator({
        runId: 'preempt',
        namespace: 'preempt',
        roles: defaultRoleCatalog().filter((entry) => entry.role === 'redis'),
        pins: { redis: port }
    });
    await allocator.allocate();
    try
    {
        await assert.rejects(listen(port), (error) => error.code === 'EADDRINUSE');
    }
    finally
    {
        await allocator.releaseAll('test-done');
    }
    const server = await listen(port);
    server.close();
});

test('multi-port allocation is all-or-nothing and leaves no partial leases', async () =>
{
    const firstPort = await freePortForPin('postgres');
    const secondPort = await freePortForPin('redis');
    const blocker = await bindReservationServer({ host: '127.0.0.1', port: secondPort });
    try
    {
        const allocator = createPortLeaseAllocator({
            runId: 'all-or-nothing',
            namespace: 'all-or-nothing',
            roles: defaultRoleCatalog().filter((entry) => ['postgres', 'redis'].includes(entry.role)),
            pins: { postgres: firstPort, redis: secondPort }
        });
        await assert.rejects(allocator.allocate(), /unavailable/u);
        assert.ok(
            allocator.snapshot().length > 0 && allocator.snapshot().every((lease) => lease.handoffState === 'released'),
            'failed allocation must release every partially allocated lease'
        );
    }
    finally
    {
        await blocker.close();
    }
    const retry = createPortLeaseAllocator({
        runId: 'all-or-nothing-retry',
        namespace: 'all-or-nothing',
        roles: defaultRoleCatalog().filter((entry) => ['postgres', 'redis'].includes(entry.role)),
        pins: { postgres: firstPort, redis: secondPort }
    });
    const leases = await retry.allocate();
    assert.deepEqual(leases.map((lease) => lease.role).sort(), ['postgres', 'redis']);
    await retry.releaseAll('test-done');
});

test('IPv6 listener occupying the port blocks allocation even though IPv4 is free', async () =>
{
    const port = await freePortForPin('debug-backend');
    const ipv6 = await bindReservationServer({ host: '::1', port, ipv6Only: true });
    try
    {
        const v4Probe = await listen(port);
        v4Probe.close();
        const allocator = createPortLeaseAllocator({
            runId: 'ipv6-conflict',
            namespace: 'ipv6-conflict',
            roles: defaultRoleCatalog().filter((entry) => entry.role === 'debug-backend'),
            pins: { 'debug-backend': port }
        });
        await assert.rejects(allocator.allocate(), /unavailable/u);
    }
    finally
    {
        await ipv6.close();
    }
    const retry = createPortLeaseAllocator({
        runId: 'ipv6-conflict-retry',
        namespace: 'ipv6-conflict',
        roles: defaultRoleCatalog().filter((entry) => entry.role === 'debug-backend'),
        pins: { 'debug-backend': port }
    });
    const leases = await retry.allocate();
    assert.equal(leases[0].port, port);
    await retry.releaseAll('test-done');
});

test('cancel releases every reservation so the same ports become available', async () =>
{
    const firstPort = await freePortForPin('debug-frontend');
    const secondPort = await freePortForPin('release-preview');
    const allocator = createPortLeaseAllocator({
        runId: 'cancel',
        namespace: 'cancel',
        roles: defaultRoleCatalog().filter((entry) => ['debug-frontend', 'release-preview'].includes(entry.role)),
        pins: { 'debug-frontend': firstPort, 'release-preview': secondPort }
    });
    const leases = await allocator.allocate();
    const released = await allocator.releaseAll('cancel');
    assert.deepEqual(
        released.map((lease) => lease.handoffState),
        ['released', 'released']
    );
    const retry = createPortLeaseAllocator({
        runId: 'cancel-retry',
        namespace: 'cancel',
        roles: defaultRoleCatalog().filter((entry) => ['debug-frontend', 'release-preview'].includes(entry.role)),
        pins: { 'debug-frontend': firstPort, 'release-preview': secondPort }
    });
    const retried = await retry.allocate();
    assert.deepEqual(retried.map((lease) => lease.port).sort(), [firstPort, secondPort].sort());
    await retry.releaseAll('test-done');
    assert.equal(leases.length, 2);
});

test('sealed manifest covers every lease contract field, canonical ordering, and rejects tampering', async (t) =>
{
    const root = tempDir(t, 'fsusblog-port-lease-manifest-');
    const allocator = createPortLeaseAllocator({
        runId: 'manifest',
        namespace: 'manifest',
        roles: defaultRoleCatalog().filter((entry) => ['postgres', 'redis'].includes(entry.role))
    });
    const leases = await allocator.allocate();
    const manifest = sealPortLeaseManifest({
        runId: 'manifest',
        namespace: 'manifest',
        reservationOwnerIdentity: allocator.reservationOwnerIdentity,
        createdAt: new Date().toISOString(),
        controlSocketPath: path.join(root, 'control.sock'),
        tokenFilePath: path.join(root, 'token'),
        pidFilePath: path.join(root, 'pid'),
        terminalReceiptPath: path.join(root, 'terminal.json'),
        leases
    });
    for (const lease of leases)
    {
        for (const field of [
            'portLeaseId',
            'role',
            'label',
            'protocol',
            'addressFamily',
            'conflictCheckedFamilies',
            'bindAddress',
            'port',
            'containerPort',
            'outputBindingKey',
            'reservationOwnerIdentity',
            'reservationTokenDigest',
            'createdAt',
            'handoffState',
            'boundListenerIdentityRef',
            'handedOffAt',
            'failedReason',
            'contentDigest'
        ])
        {
            assert.ok(Object.hasOwn(lease, field), `lease ${lease.role} is missing ${field}`);
        }
    }
    assert.doesNotThrow(() => verifySealedPortLeaseManifest(manifest));
    const byRole = (a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0);
    assert.deepEqual(canonicalize(manifest.leases), canonicalize([...manifest.leases].sort(byRole)));
    const tampered = JSON.parse(JSON.stringify(manifest));
    tampered.leases[0].port += 1;
    assert.throws(() => verifySealedPortLeaseManifest(tampered), /invalid|digest/u);
    await allocator.releaseAll('test-done');
});

test('serve CLI writes a terminal receipt when released with a reason', async (t) =>
{
    const root = tempDir(t, 'fsusblog-port-lease-cli-');
    const port = await freePortForPin('postgres');
    const manifestPath = path.join(root, 'port-leases.json');
    const controlSocketPath = path.join(root, 'control.sock');
    const tokenFilePath = path.join(root, 'token');
    const pidFilePath = path.join(root, 'pid');
    const terminalReceiptPath = path.join(root, 'terminal.json');
    const args = [
        modulePath,
        'serve',
        '--run-id',
        'cli-release',
        '--namespace',
        'cli-release',
        '--roles',
        'postgres',
        '--pin',
        `postgres:${port}`,
        '--manifest',
        manifestPath,
        '--control-socket',
        controlSocketPath,
        '--token-file',
        tokenFilePath,
        '--pid-file',
        pidFilePath,
        '--terminal-receipt',
        terminalReceiptPath
    ];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    t.after(() =>
    {
        if (child.exitCode === null)
        {
            try
            {
                child.kill('SIGKILL');
            }
            catch
            {
                // already exited
            }
        }
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline)
    {
        if (fs.existsSync(pidFilePath) && fs.existsSync(controlSocketPath) && fs.existsSync(manifestPath))
        {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fs.existsSync(manifestPath), 'daemon did not write manifest');
    const token = fs.readFileSync(tokenFilePath, 'utf8').trim();
    assert.match(token, /^[a-f0-9]{64}$/u);
    execFileSync(process.execPath, [
        modulePath,
        'release-all',
        '--manifest',
        manifestPath,
        '--token-file',
        tokenFilePath,
        '--reason',
        'cancel'
    ], { encoding: 'utf8' });
    await new Promise((resolve) => child.once('exit', resolve));
    const receipt = JSON.parse(fs.readFileSync(terminalReceiptPath, 'utf8'));
    assert.equal(receipt.terminalState, 'released');
    assert.equal(receipt.reason, 'cancel');
    const retry = createPortLeaseAllocator({
        runId: 'cli-release-retry',
        namespace: 'cli-release',
        roles: defaultRoleCatalog().filter((entry) => entry.role === 'postgres'),
        pins: { postgres: port }
    });
    const leases = await retry.allocate();
    assert.equal(leases[0].port, port);
    await retry.releaseAll('test-done');
});
