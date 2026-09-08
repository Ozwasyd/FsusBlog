import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Writable } from 'node:stream';

import {
    finalizeRunOwnedDirectories,
    prepareRunOwnedDirectories
} from '../../tools/test/execution-envelope-directories.mjs';
import {
    finalizeNetworkSandbox,
    loadExecutionNetworkPolicy,
    prepareNetworkSandbox,
    projectPlannedEndpoints,
    validateExecutionNetworkPolicy
} from '../../tools/test/execution-envelope-network.mjs';
import { runPhysicalExecution } from '../../tools/test/physical-execution-process-tree.mjs';

const policy = loadExecutionNetworkPolicy();

test('network policy is default deny with no ambient external endpoint', () =>
{
    assert.deepEqual(validateExecutionNetworkPolicy(policy), []);
    assert.equal(policy.correctnessDefault, 'deny');
    assert.deepEqual(policy.externalEndpoints, []);
    assert.equal(policy.buildRestorePolicy.phase, 'separate-from-correctness');
});

test('service endpoints project exact protocol, loopback address, and current-run port', () =>
{
    assert.deepEqual(projectPlannedEndpoints({
        services: ['postgres', 'redis'],
        serviceEnvelope: {
            planned: {
                services: [
                    { id: 'postgres', kind: 'container', ports: [{ hostPort: '15432' }] },
                    { id: 'redis', kind: 'container', ports: [{ hostPort: '16379' }] }
                ]
            }
        },
        policy
    }), [
        {
            id: 'postgres',
            protocol: 'tcp',
            host: '127.0.0.1',
            port: 15432,
            dns: 'not-applicable-literal-loopback',
            certificate: 'not-applicable-plaintext-local-service',
            proxy: 'denied'
        },
        {
            id: 'redis',
            protocol: 'tcp',
            host: '127.0.0.1',
            port: 16379,
            dns: 'not-applicable-literal-loopback',
            certificate: 'not-applicable-plaintext-local-service',
            proxy: 'denied'
        }
    ]);
    assert.throws(() => projectPlannedEndpoints({
        services: ['postgres'],
        serviceEnvelope: { planned: { services: [] } },
        policy
    }), /port is missing/u);
    assert.deepEqual(projectPlannedEndpoints({
        services: ['backend'],
        serviceEnvelope: {
            planned: {
                services: [{
                    id: 'backend',
                    kind: 'run-owned-process',
                    topology: { port: 5179 }
                }]
            }
        },
        policy
    }), [{
        id: 'backend',
        protocol: 'tcp',
        host: '127.0.0.1',
        port: 5179,
        dns: 'not-applicable-literal-loopback',
        certificate: 'not-applicable-plaintext-local-service',
        proxy: 'denied'
    }]);
    assert.throws(() => projectPlannedEndpoints({
        services: ['unknown'],
        serviceEnvelope: {
            planned: {
                services: [{
                    id: 'unknown',
                    kind: 'run-owned-process',
                    topology: { port: 5180 }
                }]
            }
        },
        policy
    }), /declaration is missing/u);
});

test('sandbox unavailable fails closed instead of running unrestricted', () =>
{
    assert.throws(() => prepareNetworkSandbox({
        command: [process.execPath, '-e', '0'],
        cwd: process.cwd(),
        directories: { temp: '/tmp', toolCache: '/tmp' },
        writableRoots: [],
        environment: { PATH: process.env.PATH },
        policy,
        platform: 'darwin'
    }), /sandbox is unavailable/u);
});

test('unplanned external, DNS, and denied attempts reject exact admission', (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-network-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const prepared = {
        networkLog: path.join(directory, 'network.strace'),
        fragment: {
            planned: {
                endpoints: [],
                proxy: { HTTP_PROXY: null, HTTPS_PROXY: null, NO_PROXY: null },
                certificates: { SSL_CERT_DIR: null, SSL_CERT_FILE: null, NODE_EXTRA_CA_CERTS: null }
            },
            actual: null,
            admission: 'pending'
        }
    };
    fs.writeFileSync(
        prepared.networkLog,
        '1 connect(3, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("8.8.8.8")}, 16) = -1 ENETUNREACH\n'
    );
    assert.throws(() => finalizeNetworkSandbox(prepared), /planned\/actual drift/u);
    assert.equal(prepared.fragment.admission, 'rejected');
    assert.equal(prepared.fragment.actual.dns.length, 1);
    assert.equal(prepared.fragment.actual.deniedAttempts.length, 1);
});

test('empty observed network exact-matches a no-network correctness plan', (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-network-empty-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const prepared = {
        networkLog: path.join(directory, 'network.strace'),
        fragment: {
            planned: {
                endpoints: [],
                proxy: { HTTP_PROXY: null },
                certificates: { SSL_CERT_FILE: null }
            },
            actual: null,
            admission: 'pending'
        }
    };
    fs.writeFileSync(prepared.networkLog, '1 socket(AF_UNIX, SOCK_STREAM, 0) = 3\n');
    assert.equal(finalizeNetworkSandbox(prepared).admission, 'planned-actual-exact');
});

test('Landlock grants only the exact null device while retaining default-deny writes', {
    skip: process.platform !== 'linux'
}, (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-landlock-file-'));
    const deniedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-landlock-denied-'));
    context.after(() => {
        fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(deniedDirectory, { recursive: true, force: true });
    });
    const deniedFile = path.join(deniedDirectory, 'unchanged.txt');
    fs.writeFileSync(deniedFile, 'unchanged');
    const directories = Object.fromEntries([
        'home', 'temp', 'npmCache', 'nugetPackages', 'dotnetHome', 'toolCache'
    ].map((name) => {
        const value = path.join(directory, name);
        fs.mkdirSync(value, { recursive: true, mode: 0o700 });
        return [name, value];
    }));
    const environment = {
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
        HOME: directories.home,
        TMPDIR: directories.temp,
        TMP: directories.temp,
        TEMP: directories.temp
    };
    const prepared = prepareNetworkSandbox({
        command: [
            process.execPath,
            '-e',
            `const fs = require('node:fs'); fs.writeFileSync('/dev/null', 'allowed'); try { fs.writeFileSync(${JSON.stringify(deniedFile)}, 'changed'); process.exit(2); } catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }`
        ],
        cwd: process.cwd(),
        directories,
        writableRoots: Object.values(directories),
        environment,
        policy
    });
    const result = spawnSync(prepared.command[0], prepared.command.slice(1), {
        cwd: process.cwd(),
        env: environment,
        encoding: 'utf8'
    });
    if (result.status === 125 && /Landlock ABI is unavailable/u.test(result.stderr))
    {
        context.skip('Landlock ABI unavailable on this Linux host');
        return;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(deniedFile, 'utf8'), 'unchanged');
    assert.deepEqual(prepared.linuxReadWritePaths.filter((entry) => entry.startsWith('/dev/')), ['/dev/null']);
    assert.equal(finalizeNetworkSandbox(prepared).admission, 'planned-actual-exact');
});

test('systemd address policy permits an exact current-run loopback service and denies other addresses', {
    skip: process.platform !== 'linux'
}, async (context) =>
{
    const capability = spawnSync('systemctl', ['--user', 'show-environment'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (capability.status !== 0)
    {
        context.skip(`systemd user authority unavailable: ${String(capability.stderr).trim()}`);
        return;
    }
    const directoryEnvelope = prepareRunOwnedDirectories({
        repositoryRoot: process.cwd(),
        cwd: process.cwd(),
        runId: `network-loopback-${process.pid}`,
        producerId: 'systemd-loopback',
        attemptId: 'current-run'
    });
    const directories = directoryEnvelope.fragment.directories;
    const server = net.createServer((socket) => socket.end());
    context.after(() => {
        server.close();
        finalizeRunOwnedDirectories(directoryEnvelope);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const environment = {
        ...directoryEnvelope.environment,
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
    };
    const prepared = prepareNetworkSandbox({
        command: [
            process.execPath,
            '-e',
            `require('node:net').connect(${port}, '127.0.0.1').on('connect', function () { this.end(); })`
        ],
        cwd: process.cwd(),
        directories,
        writableRoots: directoryEnvelope.fragment.writableRoots,
        plannedEndpoints: [{
            id: 'current-run-service',
            protocol: 'tcp',
            host: '127.0.0.1',
            port,
            dns: 'not-applicable-literal-loopback',
            certificate: 'not-applicable-plaintext-local-service',
            proxy: 'denied'
        }],
        environment,
        policy
    });
    assert.ok(prepared.linuxReadWritePaths.includes('/dev/null'));
    assert.deepEqual(
        prepared.command.slice(
            prepared.command.indexOf(prepared.fragment.sandbox.filesystem.helper.absolutePath) + 1,
            prepared.command.indexOf('--', prepared.command.indexOf(prepared.fragment.sandbox.filesystem.helper.absolutePath) + 1)
        ).filter((entry, index, values) => values[index - 1] === '--writable-file'),
        ['/dev/null']
    );
    const quiet = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    await runPhysicalExecution({
        command: prepared.command,
        cwd: process.cwd(),
        env: environment,
        controlEnv: process.env,
        linuxPrivateNetwork: prepared.linuxPrivateNetwork,
        linuxNetworkPolicy: prepared.linuxNetworkPolicy,
        linuxReadWritePaths: prepared.linuxReadWritePaths,
        stdout: quiet,
        stderr: quiet
    });
    assert.equal(finalizeNetworkSandbox(prepared).admission, 'planned-actual-exact');
});

test('physical runner permits declared canonical outputs and denies undeclared/read-only paths', {
    skip: process.platform !== 'linux'
}, async (context) =>
{
    const capability = spawnSync('systemctl', ['--user', 'show-environment'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (capability.status !== 0)
    {
        context.skip(`systemd user authority unavailable: ${String(capability.stderr).trim()}`);
        return;
    }

    const runId = `network-permission-${process.pid}-${Date.now()}`;
    const declaredSuffix = `${process.pid}-${Date.now()}`;
    const declaredOutput = `.tmp/gate-logs/physical-runner-${declaredSuffix}.json`;
    const environmentOutput = `.tmp/env/physical-runner-${declaredSuffix}.json`;
    const declaredFile = path.resolve(process.cwd(), declaredOutput);
    const environmentFile = path.resolve(process.cwd(), environmentOutput);
    const undeclaredFile = path.resolve(
        process.cwd(),
        `.tmp/physical-runner-undeclared-${declaredSuffix}.txt`
    );
    const readOnlyFile = path.resolve(process.cwd(), 'AGENTS.md');
    const readOnlyBefore = fs.readFileSync(readOnlyFile);
    fs.writeFileSync(undeclaredFile, 'unchanged');

    const directoryEnvelope = prepareRunOwnedDirectories({
        repositoryRoot: process.cwd(),
        cwd: process.cwd(),
        runId,
        producerId: 'systemd-output-ownership',
        attemptId: 'declared-canonical-output',
        outputs: [declaredOutput, environmentOutput]
    });
    let networkFinalized = false;
    let directoryFinalized = false;
    let networkSandbox = null;
    context.after(() => {
        if (networkSandbox && !networkFinalized)
        {
            finalizeNetworkSandbox(networkSandbox);
        }
        if (!directoryFinalized)
        {
            finalizeRunOwnedDirectories(directoryEnvelope);
        }
        for (const file of [declaredFile, environmentFile, undeclaredFile])
        {
            fs.rmSync(file, { force: true });
        }
    });

    const environment = {
        ...directoryEnvelope.environment,
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC'
    };
    networkSandbox = prepareNetworkSandbox({
        command: [
            process.execPath,
            '-e',
            [
                "const fs = require('node:fs')",
                `const deny = (target) => { try { fs.writeFileSync(target, 'changed'); process.exitCode = 42; } catch (error) { if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error; } }`,
                `fs.writeFileSync(${JSON.stringify(declaredFile)}, 'declared')`,
                `fs.writeFileSync(${JSON.stringify(environmentFile)}, 'environment')`,
                `deny(${JSON.stringify(undeclaredFile)})`,
                `deny(${JSON.stringify(readOnlyFile)})`,
                "console.log('write-ownership-verified')"
            ].join(';')
        ],
        cwd: process.cwd(),
        directories: directoryEnvelope.fragment.directories,
        writableRoots: directoryEnvelope.fragment.writableRoots,
        environment,
        policy
    });
    const quiet = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    await runPhysicalExecution({
        command: networkSandbox.command,
        cwd: process.cwd(),
        env: environment,
        controlEnv: process.env,
        linuxPrivateNetwork: networkSandbox.linuxPrivateNetwork,
        linuxNetworkPolicy: networkSandbox.linuxNetworkPolicy,
        linuxReadWritePaths: networkSandbox.linuxReadWritePaths,
        stdout: quiet,
        stderr: quiet
    });

    assert.equal(fs.readFileSync(declaredFile, 'utf8'), 'declared');
    assert.equal(fs.readFileSync(environmentFile, 'utf8'), 'environment');
    assert.equal(fs.readFileSync(undeclaredFile, 'utf8'), 'unchanged');
    assert.deepEqual(fs.readFileSync(readOnlyFile), readOnlyBefore);
    assert.ok(networkSandbox.linuxReadWritePaths.includes(
        path.dirname(declaredFile)
    ));
    assert.ok(networkSandbox.linuxReadWritePaths.includes(
        path.dirname(environmentFile)
    ));
    assert.equal(finalizeNetworkSandbox(networkSandbox).admission, 'planned-actual-exact');
    networkFinalized = true;
    assert.equal(finalizeRunOwnedDirectories(directoryEnvelope).cleanup.status, 'complete');
    directoryFinalized = true;
});
