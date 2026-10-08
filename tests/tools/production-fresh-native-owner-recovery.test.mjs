import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';

import {createPortLeaseAllocator, defaultRoleCatalog, verifyNativeReservationCleanup}
    from '@fsusblog/governance-tools/test-matrix/production-fresh-port-lease';

const source = "import os,socket,subprocess,sys,time; fd=int(os.environ['FSUSBLOG_RUNTIME_LISTEN_FD']); s=socket.socket(fileno=fd); s.listen(); subprocess.Popen([sys.executable,'-c',\"import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('leaf=%s'%os.getpid(),flush=True); time.sleep(60)\"],pass_fds=(fd,)); print('ready',flush=True); time.sleep(60)";
const modulePath = path.resolve('tools/test-matrix/production-fresh-port-lease.mjs');

async function eventually(probe)
{
    const deadline = Date.now() + 10000;
    while (true)
    {
        try
        {
            return probe();
        }
        catch (error)
        {
            if (Date.now() >= deadline)
            {
                throw error;
            }
            await delay(20);
        }
    }
}

async function bind(port, host)
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

async function launchFixture(t, escaped = false)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-native-owner-recovery-'));
    const allocator = createPortLeaseAllocator({runId: 'owner-recovery', namespace: 'owner-recovery',
        continuousHandoff: true, roles: defaultRoleCatalog().filter((role) => role.role === 'debug-backend')});
    t.after(async () =>
    {
        await allocator.releaseAll('test-terminal', {cancelBound: true});
        fs.rmSync(root, {recursive: true, force: true});
    });
    const [lease] = await allocator.allocate();
    const logFile = path.join(root, 'runtime.log');
    const launched = await allocator.launchNative(lease.role, {argv: ['python3', '-c', escaped ? source.replace('pass_fds=(fd,));', 'pass_fds=(fd,),start_new_session=True);') : source], cwd: root, logFile, env: {}});
    const identity = launched.handoffOwnerIdentity;
    const leafPid = await eventually(() =>
    {
        const pid = Number(fs.readFileSync(logFile, 'utf8').match(/leaf=(\d+)/u)?.[1]);
        assert.ok(pid);
        return pid;
    });
    return {allocator, lease, identity, leafPid, root};
}

for (const [completed, escaped] of [[false, false], [true, false], [false, true]])
{
    test(`SIGKILL native reservation owner drains and reaps its ${escaped ? 'session-changing' : completed ? 'bound' : 'pending'} application group`, async (t) =>
    {
        const {allocator, lease, identity, leafPid} = await launchFixture(t, escaped);
        if (escaped)
        {
            const sessionId = fs.readFileSync(`/proc/${leafPid}/stat`, 'utf8').split(')').at(-1).trim().split(/\s+/u)[3];
            assert.equal(Number(sessionId), leafPid);
        }
        if (completed)
        {
            await allocator.completeHandoff(lease.role, `pid:${identity.pid}`);
        }
        const owner = Number(fs.readFileSync(`/proc/${identity.guardian.pid}/stat`, 'utf8')
            .split(')').at(-1).trim().split(/\s+/u)[1]);
        process.kill(owner, 'SIGKILL');
        await allocator.releaseAll('owner-crashed', {cancelBound: true});
        const observation = await verifyNativeReservationCleanup({pid: identity.pid,
            processStartIdentity: identity.processStartIdentity, socketIdentity: identity.socketIdentity, guardian: identity.guardian});
        assert.equal(observation.reason, 'control-eof');
        assert.ok(observation.signals.includes('SIGKILL'));
        assert.ok(observation.members.some((member) => member.pid === leafPid));
        for (const pid of [identity.pid, leafPid])
        {
            assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
        }
        assert.equal(allocator.snapshot()[0].handoffState, 'released');
        for (const host of ['127.0.0.1', '::1'])
        {
            await bind(lease.port, host);
        }
    });
}

test('SIGKILL allocator daemon permits exact native cleanup recovery and repeated recovery', async (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-native-daemon-recovery-'));
    const manifest = path.join(root, 'manifest.json');
    const daemon = spawn(process.execPath, [modulePath, 'serve', '--run-id', 'daemon-recovery', '--namespace', 'daemon-recovery',
        '--roles', 'debug-backend', '--continuous-handoff', '1', '--manifest', manifest,
        '--control-socket', path.join(root, 'control.sock'), '--token-file', path.join(root, 'token'),
        '--pid-file', path.join(root, 'pid'), '--terminal-receipt', path.join(root, 'terminal.json')], {stdio: 'ignore'});
    t.after(() =>
    {
        try
        {
            daemon.kill('SIGTERM');
        }
        catch
        {
            // The exact test daemon may already have exited.
        }
        fs.rmSync(root, {recursive: true, force: true});
    });
    await eventually(() => assert.ok(fs.existsSync(path.join(root, 'pid'))));
    const specification = path.join(root, 'specification.json');
    fs.writeFileSync(specification, JSON.stringify({argv: ['python3', '-c', source], cwd: root,
        logFile: path.join(root, 'runtime.log'), env: {}}), {mode: 0o600});
    const launched = spawnSync(process.execPath, [modulePath, 'launch-native', '--manifest', manifest,
        '--token-file', path.join(root, 'token'), '--role', 'debug-backend', '--specification', specification], {encoding: 'utf8'});
    assert.equal(launched.status, 0, launched.stderr);
    const lease = JSON.parse(fs.readFileSync(manifest, 'utf8')).leases[0];
    const leafPid = await eventually(() =>
    {
        const pid = Number(fs.readFileSync(path.join(root, 'runtime.log'), 'utf8').match(/leaf=(\d+)/u)?.[1]);
        assert.ok(pid);
        return pid;
    });
    const exit = new Promise((resolve) => daemon.once('exit', resolve));
    daemon.kill('SIGKILL');
    await exit;
    for (let attempt = 0; attempt < 2; attempt++)
    {
        const recovered = spawnSync(process.execPath, [modulePath, 'recover', '--manifest', manifest], {encoding: 'utf8'});
        assert.equal(recovered.status, 0, recovered.stderr);
        const terminal = JSON.parse(fs.readFileSync(path.join(root, 'terminal.json'), 'utf8'));
        assert.equal(terminal.terminalState, 'released');
        assert.equal(terminal.cleanupObservations[0].observation.verified, true);
    }
    for (const pid of [lease.handoffOwnerIdentity.pid, leafPid])
    {
        assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
    }
    for (const host of ['127.0.0.1', '::1'])
    {
        await bind(lease.port, host);
    }
});

test('a sealed cleanup claim cannot certify a still-live application or a different guardian', async (t) =>
{
    const {allocator, lease, identity} = await launchFixture(t);
    const raw = {pid: identity.pid, processStartIdentity: identity.processStartIdentity,
        socketIdentity: identity.socketIdentity, guardian: identity.guardian};
    const receipt = path.join(identity.guardian.directory, 'cleanup.json');
    const payload = {schema: 'fsusblog.native-reservation-cleanup.v1', guardian: identity.guardian,
        application: raw, verified: true, members: [], reason: 'forged-success', failure: null, signals: [], transferred: false};
    const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
    fs.writeFileSync(receipt, JSON.stringify({...payload,
        contentDigest: `sha256:${createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex')}`}), {mode: 0o600});
    await assert.rejects(verifyNativeReservationCleanup(raw), /not reaped/u);
    fs.unlinkSync(receipt);
    await allocator.releaseAll('test-terminal', {cancelBound: true});
    const wrongGuardian = {...raw, guardian: {...raw.guardian, token: '0'.repeat(64)}};
    await assert.rejects(verifyNativeReservationCleanup(wrongGuardian), /does not match/u);
    await fs.promises.rename(identity.guardian.directory, `${identity.guardian.directory}.real`);
    fs.symlinkSync(`${identity.guardian.directory}.real`, identity.guardian.directory);
    await assert.rejects(verifyNativeReservationCleanup(raw), /directory identity drift/u);
    for (const host of ['127.0.0.1', '::1'])
    {
        await bind(lease.port, host);
    }
});
