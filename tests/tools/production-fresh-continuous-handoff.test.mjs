import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createPortLeaseAllocator, defaultRoleCatalog } from '@fsusblog/governance-tools/test-matrix/production-fresh-port-lease';

const childSource = `
const http = require('node:http');
const fs = require('node:fs');
const fd = Number(process.env.FSUSBLOG_RUNTIME_LISTEN_FD);
if (fs.readlinkSync('/proc/self/fd/' + fd) !== process.env.FSUSBLOG_RUNTIME_LISTEN_SOCKET) process.exit(2);
http.createServer((request, response) => response.end(process.env.FSUSBLOG_RUNTIME_LISTEN_ATTEMPT_ID))
    .listen({fd});
`;

test('continuous container allocation requires pinned images and explicit resource admission before mutation', () =>
{
    const roles = defaultRoleCatalog();
    assert.throws(() => createPortLeaseAllocator({
        runId: 'admission-negative', namespace: 'admission-negative', continuousHandoff: true, roles
    }), /container reservation requires/u);
    assert.throws(() => createPortLeaseAllocator({
        runId: 'admission-negative', namespace: 'admission-negative', continuousHandoff: true, roles,
        containerReservations: {postgres: {taskId: 'probe', name: 'fsusblog-test-admission', gateRoot: '/tmp',
            imageReference: 'postgres:latest', resourceArgs: []}}
    }), /pinned image reference/u);
});

async function competitor(port, host)
{
    const server = net.createServer();
    try
    {
        await new Promise((resolve, reject) =>
        {
            server.once('error', reject);
            server.listen({port, host, ipv6Only: host === '::1'}, resolve);
        });
    }
    finally
    {
        if (server.listening)
        {
            await new Promise((resolve) => server.close(resolve));
        }
    }
}

async function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-continuous-handoff-'));
    const allocator = createPortLeaseAllocator({
        runId: 'continuous-test', namespace: 'continuous-test', continuousHandoff: true,
        roles: defaultRoleCatalog().filter((role) => role.role === 'debug-frontend')
    });
    t.after(async () =>
    {
        await allocator.releaseAll('test-done');
        fs.rmSync(root, {recursive: true, force: true});
    });
    const [lease] = await allocator.allocate();
    return {allocator, lease, specification: {
        argv: [process.execPath, '-e', childSource], cwd: root,
        logFile: path.join(root, 'child.log'), env: {}
    }};
}

async function waitForCanary(port, expected)
{
    const deadline = Date.now() + 5000;
    let firstError;
    while (Date.now() < deadline)
    {
        try
        {
            await new Promise((resolve, reject) =>
            {
                const socket = net.connect(port, '127.0.0.1');
                let response = '';
                let matched = false;
                socket.setTimeout(1000, () => socket.destroy(new Error('canary timed out')));
                socket.once('error', reject);
                socket.once('connect', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n'));
                socket.on('data', (chunk) =>
                {
                    response += chunk;
                    const boundary = response.indexOf('\r\n\r\n');
                    if (boundary >= 0 && response.slice(boundary + 4).length === expected.length)
                    {
                        try
                        {
                            assert.match(response, /^HTTP\/1\.1 200 /u);
                            assert.equal(response.slice(boundary + 4), expected);
                            matched = true;
                            // Client initiates FIN. A server-side TIME_WAIT is not
                            // a leaked lease and must not obscure ownership cleanup.
                            socket.end();
                        }
                        catch (error)
                        {
                            socket.destroy(error);
                        }
                    }
                });
                socket.once('close', () => matched ? resolve() : reject(new Error('canary closed without its payload')));
            });
            return;
        }
        catch (error)
        {
            firstError ??= error;
            await delay(10);
        }
    }
    throw firstError;
}

test('continuous handoff retains both family guards and authorizes only its actual child socket', async (t) =>
{
    const {allocator, lease, specification} = await fixture(t);
    await assert.rejects(allocator.beginHandoff(lease.role), /release-before-bind is forbidden/);
    for (const host of ['127.0.0.1', '::1'])
    {
        await assert.rejects(competitor(lease.port, host), {code: 'EADDRINUSE'});
    }
    const launched = await allocator.launchNative(lease.role, specification);
    const identity = launched.handoffOwnerIdentity;
    t.after(() =>
    {
        try
        {
            process.kill(identity.pid, 'SIGTERM');
        }
        catch
        {
            // The exact disposable child may already have exited during cleanup.
        }
    });
    assert.match(identity.socketIdentity, /^socket:\[\d+\]$/u);
    assert.equal(identity.runId, 'continuous-test');
    await waitForCanary(lease.port, identity.attemptId);
    await assert.rejects(allocator.completeHandoff(lease.role, `pid:${process.pid}`), /authorized same-attempt/);
    const completed = await allocator.completeHandoff(lease.role, `pid:${identity.pid}`);
    assert.equal(completed.handoffState, 'bound');
    assert.equal(completed.handoffOwnerIdentity.socketIdentity, identity.socketIdentity);
    for (const host of ['127.0.0.1', '::1'])
    {
        await assert.rejects(competitor(lease.port, host), {code: 'EADDRINUSE'});
    }
    await allocator.releaseAll('handoff-finished');
    // The application retains the same socket after the reservation duplicate closes.
    await waitForCanary(lease.port, identity.attemptId);
});

test('pending native handoff cancellation drains its exact child and releases both guards', async (t) =>
{
    const {allocator, lease, specification} = await fixture(t);
    const launched = await allocator.launchNative(lease.role, specification);
    await waitForCanary(lease.port, launched.handoffOwnerIdentity.attemptId);
    await allocator.releaseAll('cancel-before-business-acceptance');
    assert.throws(() => process.kill(launched.handoffOwnerIdentity.pid, 0), {code: 'ESRCH'});
    for (const host of ['127.0.0.1', '::1'])
    {
        await competitor(lease.port, host);
    }
});

test('failed or repeated native launch cannot release ownership into a replacement listener', async (t) =>
{
    const {allocator, lease, specification} = await fixture(t);
    const launched = await allocator.launchNative(lease.role, specification);
    await assert.rejects(allocator.launchNative(lease.role, specification), /cannot launch/);
    await waitForCanary(lease.port, launched.handoffOwnerIdentity.attemptId);
    await allocator.failHandoff(lease.role, 'canary-rejected');
    assert.equal(allocator.snapshot()[0].handoffState, 'failed');
    assert.throws(() => process.kill(launched.handoffOwnerIdentity.pid, 0), {code: 'ESRCH'});
    await assert.rejects(allocator.completeHandoff(lease.role, `pid:${launched.handoffOwnerIdentity.pid}`), /cannot complete/);
    for (const host of ['127.0.0.1', '::1'])
    {
        await competitor(lease.port, host);
    }
});

test('native launch failure preserves the failure and rolls back its socket reservations', async (t) =>
{
    const {allocator, lease, specification} = await fixture(t);
    specification.argv = ['/nonexistent-fsusblog-test-application'];
    await assert.rejects(allocator.launchNative(lease.role, specification), /No such file/);
    assert.equal(allocator.snapshot()[0].failedReason, 'native-launch-failed');
    for (const host of ['127.0.0.1', '::1'])
    {
        await competitor(lease.port, host);
    }
});

test('completion concurrent with explicit cancellation cannot revive a released lease', async (t) =>
{
    const {allocator, lease, specification} = await fixture(t);
    const launched = await allocator.launchNative(lease.role, specification);
    const identity = launched.handoffOwnerIdentity;
    await waitForCanary(lease.port, identity.attemptId);
    await Promise.all([
        allocator.completeHandoff(lease.role, `pid:${identity.pid}`),
        allocator.releaseAll('explicit-cancel', {cancelBound: true})
    ]);
    assert.equal(allocator.snapshot()[0].handoffState, 'released');
    assert.throws(() => process.kill(identity.pid, 0), {code: 'ESRCH'});
    for (const host of ['127.0.0.1', '::1'])
    {
        await competitor(lease.port, host);
    }
});

test('cancellation drains and reaps a socket-owning descendant that ignores SIGTERM', async (t) =>
{
    const {allocator, lease, specification} = await fixture(t);
    const leaf = "import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('leaf=%s'%os.getpid(),flush=True);\nwhile True: time.sleep(0.1)";
    const parent = "import os,socket,subprocess,sys,time; fd=int(os.environ['FSUSBLOG_RUNTIME_LISTEN_FD']); s=socket.socket(fileno=fd); s.listen(); subprocess.Popen([sys.executable,'-c'," + JSON.stringify(leaf) + "],pass_fds=(fd,)); print('ready',flush=True);\nwhile True: time.sleep(0.1)";
    specification.argv = ['python3', '-c', parent];
    const launched = await allocator.launchNative(lease.role, specification);
    const deadline = Date.now() + 5000;
    let leafPid;
    while (Date.now() < deadline)
    {
        leafPid = Number(fs.readFileSync(specification.logFile, 'utf8').match(/leaf=(\d+)/u)?.[1]);
        if (leafPid)
        {
            break;
        }
        await delay(10);
    }
    assert.ok(leafPid, 'the real descendant must run before testing cancellation');
    await allocator.releaseAll('cancel-descendant');
    assert.throws(() => process.kill(launched.handoffOwnerIdentity.pid, 0), {code: 'ESRCH'});
    assert.throws(() => process.kill(leafPid, 0), {code: 'ESRCH'});
    for (const host of ['127.0.0.1', '::1'])
    {
        await competitor(lease.port, host);
    }
});
