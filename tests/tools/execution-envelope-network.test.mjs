import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {finalizeRunOwnedDirectories, prepareRunOwnedDirectories} = await import(new URL('../../tools/test/execution-envelope-directories.mjs', import.meta.url));
const {finalizeNetworkSandbox, loadExecutionNetworkPolicy, prepareNetworkSandbox, projectPlannedEndpoints, validateExecutionNetworkPolicy} = await import(new URL('../../tools/test/execution-envelope-network.mjs', import.meta.url));
const {runPhysicalExecution} = await import(new URL('../../tools/test/physical-execution-process-tree.mjs', import.meta.url));
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

test('Landlock helper accepts old and matching UAPI headers but rejects a conflicting right', {
    skip: process.platform !== 'linux'
}, (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-landlock-uapi-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const source = fileURLToPath(new URL('../../tools/test/native/execution-envelope-landlock.c', import.meta.url));
    for (const [variant, definition, expectedSuccess] of [
        ['old-header', '', true],
        ['matching-header', '#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)', true],
        ['conflicting-header', '#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 14)', false]
    ])
    {
        const includeRoot = path.join(directory, variant);
        const headerDirectory = path.join(includeRoot, 'linux');
        fs.mkdirSync(headerDirectory, { recursive: true });
        fs.writeFileSync(path.join(headerDirectory, 'landlock.h'), [
            '#include_next <linux/landlock.h>',
            '#undef LANDLOCK_ACCESS_FS_IOCTL_DEV',
            definition,
            ''
        ].join('\n'));
        const compilation = spawnSync('cc', [
            '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
            '-I', includeRoot, '-o', path.join(directory, `${variant}-helper`), source
        ], { encoding: 'utf8' });
        if (expectedSuccess)
        {
            assert.equal(compilation.status, 0, `${variant}: ${compilation.stderr}`);
        }
        else
        {
            assert.notEqual(compilation.status, 0, `${variant} unexpectedly compiled`);
            assert.match(compilation.stderr, /Landlock ioctl right must match the Linux UAPI/u);
        }
    }
});

test('Landlock grants only the exact null device while retaining default-deny writes', {
    skip: process.platform !== 'linux'
}, (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-landlock-file-'));
    const deniedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-landlock-denied-'));
    context.after(() =>
    {
        fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(deniedDirectory, { recursive: true, force: true });
    });
    const deniedFile = path.join(deniedDirectory, 'unchanged.txt');
    fs.writeFileSync(deniedFile, 'unchanged');
    const directories = Object.fromEntries([
        'home', 'temp', 'npmCache', 'nugetPackages', 'dotnetHome', 'toolCache'
    ].map((name) =>
    {
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
    const allowedFile = path.join(directories.temp, 'allowed.txt');
    const prepared = prepareNetworkSandbox({
        command: [
            process.execPath,
            '-e',
            `const fs = require('node:fs'); fs.writeFileSync('/dev/null', 'allowed'); fs.writeFileSync(${JSON.stringify(allowedFile)}, 'allowed'); try { fs.writeFileSync(${JSON.stringify(deniedFile)}, 'changed'); process.exit(2); } catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }`
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
    assert.equal(fs.readFileSync(allowedFile, 'utf8'), 'allowed');
    assert.equal(fs.readFileSync(deniedFile, 'utf8'), 'unchanged');
    assert.deepEqual(prepared.linuxReadWritePaths, ['/dev/null', ...Object.values(directories)].sort());
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
    context.after(() =>
    {
        server.close();
        finalizeRunOwnedDirectories(directoryEnvelope);
    });
    await new Promise((resolve, reject) =>
    {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const environment = {
        ...directoryEnvelope.environment,
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC'
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
    const quiet = new Writable({ write(_chunk, _encoding, callback)
    {
        callback();
    } });
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
    context.after(() =>
    {
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
    const quiet = new Writable({ write(_chunk, _encoding, callback)
    {
        callback();
    } });
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

test('Landlock failures preserve exact diagnostics and exit 125 after diagnostic errno drift', {
    skip: process.platform !== 'linux'
}, (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-landlock-errors-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const source = fileURLToPath(new URL('../../tools/test/native/execution-envelope-landlock.c', import.meta.url));
    const wrapper = path.join(directory, 'syscall-errors.c');
    const output = path.join(directory, 'landlock-errors-helper');
    // These link-time fault adapters observe error branches, not actual confinement.
    fs.writeFileSync(wrapper, [
        '#define _GNU_SOURCE',
        '#include <errno.h>',
        '#include <stdarg.h>',
        '#include <stdio.h>',
        '#include <stdlib.h>',
        '#include <string.h>',
        '#include <linux/landlock.h>',
        '#include <sys/prctl.h>',
        '#include <sys/syscall.h>',
        '',
        'static int FailureAt(const char* stage, int error)',
        '{',
        '    if (strcmp(getenv("FSUSBLOG_LANDLOCK_FAULT"), stage) == 0)',
        '    {',
        '        errno = error;',
        '        return 1;',
        '    }',
        '    return 0;',
        '}',
        '',
        'long __wrap_syscall(long number, ...)',
        '{',
        '    if (number == __NR_landlock_create_ruleset)',
        '    {',
        '        va_list arguments;',
        '        va_start(arguments, number);',
        '        const struct landlock_ruleset_attr* attributes = va_arg(arguments, const struct landlock_ruleset_attr*);',
        '        va_end(arguments);',
        '        if (attributes == NULL)',
        '        {',
        '            return FailureAt("abi", EOPNOTSUPP) ? -1 : 5;',
        '        }',
        '        return FailureAt("create", EACCES) ? -1 : 10;',
        '    }',
        '    if (number == __NR_landlock_add_rule)',
        '    {',
        '        return FailureAt("add", EPERM) ? -1 : 0;',
        '    }',
        '    if (number == __NR_landlock_restrict_self)',
        '    {',
        '        return FailureAt("restrict", EPERM) ? -1 : 0;',
        '    }',
        '    errno = ENOSYS;',
        '    return -1;',
        '}',
        '',
        'int __wrap_open(const char* filename, int flags, ...)',
        '{',
        '    (void)filename;',
        '    (void)flags;',
        '    return FailureAt("open", ENOENT) ? -1 : 20;',
        '}',
        '',
        'int __wrap_close(int descriptor)',
        '{',
        '    return FailureAt(descriptor == 10 ? "close-ruleset" : "close-path", EBADF) ? -1 : 0;',
        '}',
        '',
        'int __wrap_prctl(int option, ...)',
        '{',
        '    if (option != PR_SET_NO_NEW_PRIVS)',
        '    {',
        '        errno = EINVAL;',
        '        return -1;',
        '    }',
        '    return FailureAt("privileges", EPERM) ? -1 : 0;',
        '}',
        '',
        'int __wrap_execv(const char* filename, char* const arguments[])',
        '{',
        '    if (strcmp(filename, "/declared-command") != 0',
        '        || strcmp(arguments[0], filename) != 0',
        '        || strcmp(arguments[1], "argument") != 0 || arguments[2] != NULL)',
        '    {',
        '        errno = EINVAL;',
        '        return -1;',
        '    }',
        '    errno = ENOEXEC;',
        '    return -1;',
        '}',
        '',
        'int __real_fputs(const char* text, FILE* stream);',
        'int __wrap_fputs(const char* text, FILE* stream)',
        '{',
        '    int result = __real_fputs(text, stream);',
        '    errno = EIO;',
        '    return result;',
        '}',
        ''
    ].join('\n'));
    const compilation = spawnSync('cc', [
        '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
        '-o', output, source, wrapper,
        '-Wl,--wrap=syscall,--wrap=open,--wrap=close,--wrap=prctl,--wrap=execv,--wrap=fputs'
    ], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(compilation.status, 0, compilation.stderr);
    const environment = {
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC'
    };
    const version = spawnSync(output, ['--version'], {
        encoding: 'utf8', env: environment, timeout: 30_000
    });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout, 'fsusblog-execution-envelope-landlock 2\n');
    assert.equal(version.stderr, '');
    const command = ['--writable', directory, '--', '/declared-command', 'argument'];
    for (const [stage, argumentsList, diagnostic] of [
        ['invalid', ['--unexpected'], 'invalid arguments'],
        ['missing', ['--'], 'command is missing'],
        ['relative', ['--', 'relative'], 'command must be absolute'],
        ['abi', command, 'Landlock ABI is unavailable: Operation not supported'],
        ['create', command, 'cannot create filesystem ruleset: Permission denied'],
        ['open', command, 'cannot open declared filesystem path: No such file or directory'],
        ['add', command, 'cannot add filesystem rule: Operation not permitted'],
        ['close-path', command, 'cannot close filesystem rule path: Bad file descriptor'],
        ['privileges', command, 'cannot set no-new-privileges: Operation not permitted'],
        ['restrict', command, 'cannot apply filesystem ruleset: Operation not permitted'],
        ['close-ruleset', command, 'cannot close filesystem ruleset: Bad file descriptor'],
        ['exec', command, 'cannot execute correctness command: Exec format error']
    ])
    {
        const result = spawnSync(output, argumentsList, {
            encoding: 'utf8',
            env: { ...environment, FSUSBLOG_LANDLOCK_FAULT: stage },
            timeout: 30_000
        });
        assert.equal(result.status, 125, `${stage}: ${result.stderr}`);
        assert.equal(result.stdout, '', stage);
        assert.equal(result.stderr, `execution-envelope-landlock: ${diagnostic}\n`, stage);
    }
});
