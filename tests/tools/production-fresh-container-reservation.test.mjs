import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { recoverReleaseContainerPublisher, reserveContainerPublisher, validateContainerReservationOptions } from '../../tools/test-matrix/production-fresh-container-reservation.mjs';

const resources = ['--cpus', '1', '--memory-reservation', '67108864', '--memory', '268435456', '--pids-limit', '128'];
const valid = {
    role: 'redis', runId: 'probe-run', namespace: 'probe-namespace', taskId: 'publisher-probe',
    name: 'fsusblog-test-publisher-probe', gateRoot: '/tmp', port: 32000, containerPort: 6379,
    imageReference: `redis@sha256:${'a'.repeat(64)}`, resourceArgs: resources
};

test('publisher reservation rejects mutable images and unbounded or escaping resource options', () =>
{
    validateContainerReservationOptions(valid);
    validateContainerReservationOptions({ ...valid, resourceArgs: [...resources,
        '--label', 'io.fsusblog.test.run-id=probe-run', '--label', 'io.fsusblog.test.namespace=probe-namespace',
        '--label', 'io.fsusblog.test.bundle-id=probe-bundle', '--label', 'io.fsusblog.test.step-id=probe-step'] });
    for (const change of [
        { imageReference: 'redis:7-alpine' }, { resourceArgs: [] },
        { resourceArgs: [...resources, '--privileged', 'true'] },
        { resourceArgs: [...resources, '--label', 'io.fsusblog.test.run-id=another-run'] },
        { resourceArgs: [...resources, '--label', 'io.fsusblog.test.namespace=another-namespace'] },
        { resourceArgs: [...resources, '--label', 'io.fsusblog.test.reservation-role=redis'] },
        { env: { FSUSBLOG_RESERVATION_ACTIVATION: 'forged' } },
        { name: 'production-redis' }, { containerPort: 5432 },
        { resourceArgs: ['--cpus', '1', '--memory', '1', '--memory-reservation', '2', '--pids-limit', '128'] }
    ]) assert.throws(() => validateContainerReservationOptions({ ...valid, ...change }));
});

async function bind(port)
{
    return new Promise((resolve, reject) =>
    {
        const server = net.createServer();
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(server));
    });
}

async function choosePort()
{
    const server = await bind(0);
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

function docker(args)
{
    return execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function eventually(probe)
{
    const end = Date.now() + 20000;
    let failure;
    while (Date.now() < end)
    {
        try { return await probe(); }
        catch (error) { failure = error; }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw failure;
}

function redisHostCanary(port, attempt)
{
    return new Promise((resolve, reject) =>
    {
        const socket = net.connect({ host: '127.0.0.1', port });
        const key = `fsusblog:probe:${attempt}`;
        let response = '';
        socket.setTimeout(1000, () => socket.destroy(new Error('redis host canary timed out')));
        socket.once('error', reject);
        socket.on('data', (chunk) =>
        {
            response += chunk.toString();
            if (response.includes(`$${attempt.length}\r\n${attempt}\r\n`))
            {
                socket.end();
                resolve(response);
            }
        });
        socket.on('end', () => reject(new Error(`redis host canary ended: ${response}`)));
        socket.once('connect', () => socket.write(`*3\r\n$3\r\nSET\r\n$${key.length}\r\n${key}\r\n$${attempt.length}\r\n${attempt}\r\n*2\r\n$3\r\nGET\r\n$${key.length}\r\n${key}\r\n`));
    });
}

function postgresHostCanary(python, port, attempt)
{
    return execFileSync(python, ['-c',
        'import psycopg,sys; c=psycopg.connect(host="127.0.0.1", port=int(sys.argv[1]), user="fsusblog", password="isolated_probe", dbname="fsusblog", connect_timeout=1); print(c.execute("SELECT %s::text", (sys.argv[2],)).fetchone()[0]); c.close()',
        String(port), attempt], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('real final publishers retain socket and attempt identity through business activation and cleanup',
    { skip: process.env.FSUSBLOG_CONTAINER_RESERVATION_INTEGRATION !== '1', timeout: 60000 }, async () =>
{
    const gateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fsusblog-publisher-test-'));
    const reservations = [];
    const evidence = [];
    const attempt = randomUUID();
    const python = process.env.FSUSBLOG_CONTAINER_RESERVATION_PG_PYTHON;
    assert.ok(python, 'real host-port PostgreSQL canary requires an explicit Python with psycopg');
    try
    {
        for (const role of ['postgres', 'redis'])
        {
            const imageReference = JSON.parse(docker(['image', 'inspect', `${role}:${role === 'postgres' ? '17' : '7'}-alpine`]))[0].RepoDigests[0];
            const reservation = await reserveContainerPublisher({
                ...valid, role, gateRoot, runId: attempt, namespace: `probe-${attempt}`,
                imageReference, port: await choosePort(), containerPort: role === 'postgres' ? 5432 : 6379,
                name: `fsusblog-test-publisher-${role}-${attempt}`,
                resourceArgs: [...resources, '--label', `io.fsusblog.test.run-id=${attempt}`,
                    '--label', `io.fsusblog.test.namespace=probe-${attempt}`,
                    '--label', 'io.fsusblog.test.bundle-id=probe-bundle', '--label', 'io.fsusblog.test.step-id=probe-step'],
                env: role === 'postgres' ? { POSTGRES_USER: 'fsusblog', POSTGRES_PASSWORD: 'isolated_probe', POSTGRES_DB: 'fsusblog' } : {}
            });
            reservations.push(reservation);
            const before = await reservation.observe();
            assert.equal(before.labels['io.fsusblog.test.bundle-id'], 'probe-bundle');
            assert.equal(before.labels['io.fsusblog.test.step-id'], 'probe-step');
            await assert.rejects(reservation.transferToRuntime(), /before activation/u);
            await assert.rejects(bind(before.publisher.port), { code: 'EADDRINUSE' });
            const id = before.containerId;
            assert.throws(() => docker(['exec', id, ...(role === 'postgres' ? ['pg_isready', '-U', 'fsusblog', '-d', 'fsusblog'] : ['redis-cli', 'ping'])]));
            await assert.rejects(async () => role === 'postgres' ? postgresHostCanary(python, before.publisher.port, attempt) : redisHostCanary(before.publisher.port, attempt));
            const [activated, concurrentActivated] = await Promise.all([reservation.activate(), reservation.activate()]);
            assert.deepEqual(activated, before);
            assert.deepEqual(concurrentActivated, before);
            assert.deepEqual(await reservation.activate(), before);
            const business = role === 'postgres'
                ? () => docker(['exec', id, 'psql', '-U', 'fsusblog', '-d', 'fsusblog', '-Atc', `SELECT '${attempt}'`])
                : () => docker(['exec', id, 'redis-cli', 'SET', `fsusblog:probe:${attempt}`, attempt]);
            const result = await eventually(business);
            assert.equal(result, role === 'postgres' ? attempt : 'OK');
            if (role === 'redis') assert.equal(docker(['exec', id, 'redis-cli', 'GET', `fsusblog:probe:${attempt}`]), attempt);
            const hostCanary = await eventually(() => role === 'postgres'
                ? postgresHostCanary(python, before.publisher.port, attempt)
                : redisHostCanary(before.publisher.port, attempt));
            assert.equal(hostCanary, role === 'postgres' ? attempt : `+OK\r\n$${attempt.length}\r\n${attempt}\r\n`);
            assert.deepEqual(await reservation.observe(), before);
            await assert.rejects(bind(before.publisher.port), { code: 'EADDRINUSE' });
            evidence.push({ role, before, after: await reservation.observe(), pendingBusinessRejected: true, competitorRejectedBeforeAndAfter: true, hostPortCanary: attempt });
        }
        // A later failed reservation never removes the competing listener or earlier owned publishers.
        const occupied = await bind(0);
        const occupiedPort = occupied.address().port;
        try
        {
            await assert.rejects(reserveContainerPublisher({
                ...valid, gateRoot, port: occupiedPort,
                imageReference: reservations[1].ownerIdentity.imageReference,
                name: `fsusblog-test-publisher-failed-${attempt}`
            }), /(?:allocated|in use)/u);
            assert.equal(occupied.listening, true);
            for (const reservation of reservations) await reservation.observe();
            assert.throws(() => docker(['inspect', `fsusblog-test-publisher-failed-${attempt}`]));
        }
        finally { await new Promise((resolve) => occupied.close(resolve)); }
        await assert.rejects(reserveContainerPublisher({
            ...valid, gateRoot, port: await choosePort(), imageReference: reservations[1].ownerIdentity.imageReference,
            name: `fsusblog-test-publisher-redis-${attempt}`
        }), /already in use/u);
        await reservations[1].observe();
        const interrupted = await reserveContainerPublisher({
            ...valid, gateRoot, port: await choosePort(), imageReference: reservations[1].ownerIdentity.imageReference,
            name: `fsusblog-test-publisher-interrupted-${attempt}`
        });
        try
        {
            await fs.writeFile(path.join(interrupted.gateDirectory, 'activate'), 'wrong-attempt\n', { flag: 'wx', mode: 0o400 });
            await eventually(() =>
            {
                const state = JSON.parse(docker(['inspect', interrupted.ownerIdentity.containerId]))[0].State;
                assert.equal(state.Running, false);
                assert.equal(state.ExitCode, 76);
            });
            await assert.rejects(interrupted.observe(), /mapping drift/u);
        }
        finally { await interrupted.close(); }
        await fs.chmod(gateRoot, 0o755);
        try
        {
            await assert.rejects(reserveContainerPublisher({
                ...valid, gateRoot, port: await choosePort(), imageReference: reservations[1].ownerIdentity.imageReference,
                name: `fsusblog-test-publisher-unsafe-gate-${attempt}`
            }), /owner-only/u);
            assert.throws(() => docker(['inspect', `fsusblog-test-publisher-unsafe-gate-${attempt}`]));
        }
        finally { await fs.chmod(gateRoot, 0o700); }
        const controller = new AbortController();
        const cancelled = await reserveContainerPublisher({
            ...valid, gateRoot, port: await choosePort(), signal: controller.signal,
            imageReference: reservations[1].ownerIdentity.imageReference,
            name: `fsusblog-test-publisher-cancelled-${attempt}`
        });
        const cancelledId = cancelled.ownerIdentity.containerId;
        controller.abort(new Error('isolated probe cancellation'));
        await cancelled.close();
        assert.throws(() => docker(['inspect', cancelledId]));
        await assert.rejects(cancelled.activate(), /released/u);
        const transferredController = new AbortController();
        const transferred = await reserveContainerPublisher({
            ...valid, gateRoot, port: await choosePort(), signal: transferredController.signal,
            imageReference: reservations[1].ownerIdentity.imageReference,
            name: `fsusblog-test-publisher-transferred-${attempt}`
        });
        try
        {
            await transferred.activate();
            const transferredIdentity = await transferred.transferToRuntime();
            transferredController.abort(new Error('reservation owner terminal after handoff'));
            assert.deepEqual(await transferred.observe(), transferredIdentity);
            await eventually(() => redisHostCanary(transferredIdentity.port, attempt));
            await assert.rejects(bind(transferredIdentity.port), { code: 'EADDRINUSE' });
        }
        finally { await transferred.close(); }
        assert.throws(() => docker(['inspect', transferred.ownerIdentity.containerId]));
        assert.equal((await fs.readdir(gateRoot)).length, 2);
        // Recover the exact reservation after a real owner process is killed, without a live helper object.
        const recoveryOptions = {
            ...valid, gateRoot, port: await choosePort(), imageReference: reservations[1].ownerIdentity.imageReference,
            name: `fsusblog-test-publisher-recovery-${attempt}`
        };
        const child = spawn(process.execPath, ['--input-type=module', '-e',
            'import {reserveContainerPublisher} from "./tools/test-matrix/production-fresh-container-reservation.mjs"; const r=await reserveContainerPublisher(JSON.parse(process.env.RESERVATION_OPTIONS)); console.log(JSON.stringify({ownerIdentity:r.ownerIdentity,gateDirectory:r.gateDirectory})); setInterval(()=>{},1000);'],
        { env: { ...process.env, RESERVATION_OPTIONS: JSON.stringify(recoveryOptions) }, stdio: ['ignore', 'pipe', 'pipe'] });
        let recovery;
        try
        {
            recovery = await new Promise((resolve, reject) =>
            {
                let output = '';
                let errors = '';
                const timer = setTimeout(() => reject(new Error('recovery owner preparation timed out')), 10000);
                child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
                child.stdout.on('data', (chunk) =>
                {
                    output += chunk.toString();
                    if (output.includes('\n'))
                    {
                        clearTimeout(timer);
                        resolve(JSON.parse(output.split('\n')[0]));
                    }
                });
                child.once('exit', (code) =>
                {
                    clearTimeout(timer);
                    reject(new Error(`recovery owner exited ${code}: ${errors}`));
                });
            });
        }
        finally
        {
            const exited = new Promise((resolve) => child.once('exit', resolve));
            child.kill('SIGKILL');
            await exited;
        }
        // Altered run/generation and gate path cannot remove this reservation.
        await assert.rejects(recoverReleaseContainerPublisher({
            ...recovery, ownerIdentity: { ...recovery.ownerIdentity, runId: 'another-run' }
        }), /identity drift/u);
        docker(['inspect', recovery.ownerIdentity.containerId]);
        const displaced = `${recovery.gateDirectory}-displaced`;
        await fs.rename(recovery.gateDirectory, displaced);
        await fs.symlink(displaced, recovery.gateDirectory);
        try { await assert.rejects(recoverReleaseContainerPublisher(recovery), /path drift/u); }
        finally
        {
            await fs.unlink(recovery.gateDirectory);
            await fs.rename(displaced, recovery.gateDirectory);
        }
        const scriptPath = path.join(recovery.gateDirectory, 'entrypoint.sh');
        const originalScript = await fs.readFile(scriptPath);
        await fs.chmod(scriptPath, 0o700);
        await fs.writeFile(scriptPath, '#!/bin/sh\nexit 0\n');
        await fs.chmod(scriptPath, 0o500);
        try { await assert.rejects(recoverReleaseContainerPublisher(recovery), /script drift/u); }
        finally
        {
            await fs.chmod(scriptPath, 0o700);
            await fs.writeFile(scriptPath, originalScript);
            await fs.chmod(scriptPath, 0o500);
        }
        const recovered = await recoverReleaseContainerPublisher(JSON.parse(JSON.stringify(recovery)));
        assert.equal(recovered.containerOutcome, 'removed-exact-owner');
        assert.equal(recovered.gateOutcome, 'removed-exact-owner');
        assert.throws(() => docker(['inspect', recovery.ownerIdentity.containerId]));
        await assert.rejects(fs.lstat(recovery.gateDirectory), { code: 'ENOENT' });
        const recoveredPort = await bind(recoveryOptions.port);
        await new Promise((resolve) => recoveredPort.close(resolve));
        const disappeared = await reserveContainerPublisher({
            ...valid, gateRoot, port: await choosePort(), imageReference: reservations[1].ownerIdentity.imageReference,
            name: `fsusblog-test-publisher-disappeared-${attempt}`
        });
        docker(['rm', '--force', '--volumes', disappeared.ownerIdentity.containerId]);
        const absent = await recoverReleaseContainerPublisher({ ownerIdentity: disappeared.ownerIdentity, gateDirectory: disappeared.gateDirectory });
        assert.equal(absent.containerOutcome, 'exact-id-not-found');
        evidence.push({ recoveryOwnerKilled: true, recovered, absent, mismatchedIdentityAndSymlinkRejected: true });
        // A container restart cannot reuse the old continuous listener identity.
        docker(['restart', reservations[1].ownerIdentity.containerId]);
        await assert.rejects(reservations[1].observe(), /identity drift/u);
        await assert.rejects(recoverReleaseContainerPublisher({
            ownerIdentity: reservations[1].ownerIdentity, gateDirectory: reservations[1].gateDirectory
        }), /identity drift/u);
    }
    finally
    {
        for (const reservation of reservations)
        {
            const port = reservation.ownerIdentity.publisher.port;
            await reservation.close();
            await reservation.close();
            assert.throws(() => docker(['inspect', reservation.ownerIdentity.containerId]));
            const rebound = await bind(port);
            await new Promise((resolve) => rebound.close(resolve));
        }
        assert.deepEqual(await fs.readdir(gateRoot), []);
        await fs.rm(gateRoot, { recursive: true });
    }
    if (process.env.FSUSBLOG_CONTAINER_RESERVATION_EVIDENCE)
    {
        await fs.writeFile(process.env.FSUSBLOG_CONTAINER_RESERVATION_EVIDENCE, `${JSON.stringify({ attempt, evidence, cleanupVerified: true }, null, 2)}\n`);
    }
});
