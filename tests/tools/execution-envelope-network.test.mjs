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

const { inspectOwnedPrivateTmp, finalizeRunOwnedDirectoriesAfterPhysical } = await import(new URL('../../tools/test/execution-envelope-directories.mjs', import.meta.url));

const { prepareNetworkSandboxAsync } = await import(new URL('../../tools/test/execution-envelope-network.mjs', import.meta.url));
test('network policy is default deny with no ambient external endpoint', () =>
{
    assert.deepEqual(validateExecutionNetworkPolicy(policy), []);
    assert.equal(policy.correctnessDefault, 'deny');
    assert.deepEqual(policy.externalEndpoints, []);
    assert.equal(policy.buildRestorePolicy.phase, 'separate-from-correctness');
});

test('pinned matrix governance grants only private .NET mutex scratch to Landlock, never host /tmp to systemd', {
    skip: process.platform !== 'linux'
}, (t) =>
{
    const directoryEnvelope = prepareRunOwnedDirectories({
        repositoryRoot: process.cwd(),
        cwd: process.cwd(),
        runId: `private-dotnet-scratch-${process.pid}`,
        producerId: 'matrix-governance',
        attemptId: 'matrix-governance'
    });
    t.after(() => finalizeRunOwnedDirectories(directoryEnvelope));
    const environment = {
        ...directoryEnvelope.environment,
        FSUSBLOG_TEST_RUN_ID: directoryEnvelope.fragment.runId,
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
        FSUSBLOG_CONTENT_FIELD_DOTNET: '/opt/pinned/dotnet'
    };
    const prepared = prepareNetworkSandbox({
        command: [process.execPath, '-e', 'process.exit(0)'],
        cwd: process.cwd(),
        directories: directoryEnvelope.fragment.directories,
        ownedDirectoryEnvelope: directoryEnvelope,
        writableRoots: directoryEnvelope.fragment.writableRoots,
        environment,
        policy,
        producerId: 'matrix-governance',
        attemptId: 'matrix-governance'
    });
    assert.equal(prepared.privateDotnetScratch, true);
    assert.equal(prepared.linuxOwnedPrivateTmp, directoryEnvelope.privateTmpCapability);
    assert.equal(prepared.linuxReadWritePaths.includes('/tmp'), false);
    assert.equal(prepared.linuxReadWritePaths.includes('/tmp/.dotnet/shm'), false);
    assert.equal(prepared.fragment.sandbox.filesystem.privateDotnetScratch, '/tmp/.dotnet/shm');
    const index = prepared.command.indexOf('/tmp/.dotnet/shm');
    assert.ok(index > 0);
    assert.equal(prepared.command[index - 1], '--writable');
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

test('original Landlock helper supports missing and present ABI 5 UAPI declarations without changing write denial', {
    skip: process.platform !== 'linux'
}, (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-landlock-header-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const source = path.resolve(import.meta.dirname, '../../tools/test/native/execution-envelope-landlock.c');
    const allowed = path.join(directory, 'allowed');
    const denied = path.join(directory, 'denied.txt');
    fs.mkdirSync(allowed, { mode: 0o700 });
    fs.writeFileSync(denied, 'unchanged');
    const executables = [];
    for (const declaration of ['missing', 'present'])
    {
        const include = path.join(directory, declaration);
        fs.mkdirSync(path.join(include, 'linux'), { recursive: true });
        fs.writeFileSync(path.join(include, 'linux/landlock.h'), [
            '#include_next <linux/landlock.h>',
            ...(declaration === 'missing' ? ['#undef LANDLOCK_ACCESS_FS_IOCTL_DEV'] : [
                '#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV',
                '#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)',
                '#endif',
                '_Static_assert(LANDLOCK_ACCESS_FS_IOCTL_DEV == (1ULL << 15), "Linux v6.10 UAPI value");'
            ]),
            ''
        ].join('\n'));
        const executable = path.join(directory, declaration + '-landlock');
        const compiled = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
            '-I', include, '-o', executable, source], { encoding: 'utf8' });
        assert.equal(compiled.status, 0, compiled.stderr);
        const result = spawnSync(executable, ['--writable', allowed, '--writable-file', '/dev/null',
            '--', process.execPath, '-e', [
                "const fs = require('node:fs')",
                `fs.writeFileSync(${JSON.stringify(path.join(allowed, declaration + '.txt'))}, 'allowed')`,
                "fs.writeFileSync('/dev/null', 'allowed')",
                `try { fs.writeFileSync(${JSON.stringify(denied)}, 'changed'); process.exit(2); } catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }`,
                "console.log('original-landlock-write-denial-confirmed')"
            ].join(';')], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), 'original-landlock-write-denial-confirmed');
        assert.equal(fs.readFileSync(path.join(allowed, declaration + '.txt'), 'utf8'), 'allowed');
        assert.equal(fs.readFileSync(denied, 'utf8'), 'unchanged');
        executables.push(executable);
    }
    assert.deepEqual(fs.readFileSync(executables[0]), fs.readFileSync(executables[1]));
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

test('Landlock error text adapts GNU pointer and POSIX status results with one conversion', {
    skip: process.platform !== 'linux'
}, (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-landlock-error-text-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const source = fileURLToPath(new URL('../../tools/test/native/execution-envelope-landlock.c', import.meta.url));
    // Typed adapters cover both API signatures without claiming a different real libc.
    const variants = [
        {
            name: 'pointer',
            returnType: 'char*',
            body: [
                '    static char text[] = "pointer-owned diagnostic";',
                '    if (strcmp(getenv("FSUSBLOG_ERROR_TEXT_RESULT"), "null") == 0)',
                '    {',
                '        return NULL;',
                '    }',
                '    if (strcmp(getenv("FSUSBLOG_ERROR_TEXT_RESULT"), "buffer") == 0)',
                '    {',
                '        memcpy(buffer, "buffer-owned diagnostic", sizeof("buffer-owned diagnostic"));',
                '        return buffer;',
                '    }',
                '    return text;'
            ],
            cases: [
                ['pointer', 'pointer-owned diagnostic'],
                ['buffer', 'buffer-owned diagnostic'],
                ['null', 'error description unavailable']
            ]
        },
        {
            name: 'status',
            returnType: 'int',
            body: [
                '    if (strcmp(getenv("FSUSBLOG_ERROR_TEXT_RESULT"), "success") == 0)',
                '    {',
                '        memcpy(buffer, "buffer-owned diagnostic", sizeof("buffer-owned diagnostic"));',
                '        return 0;',
                '    }',
                '    if (strcmp(getenv("FSUSBLOG_ERROR_TEXT_RESULT"), "range") == 0)',
                '    {',
                '        return ERANGE;',
                '    }',
                '    if (strcmp(getenv("FSUSBLOG_ERROR_TEXT_RESULT"), "invalid") == 0)',
                '    {',
                '        return EINVAL;',
                '    }',
                '    return -1;'
            ],
            cases: [
                ['success', 'buffer-owned diagnostic'],
                ['range', 'error description unavailable'],
                ['invalid', 'error description unavailable'],
                ['negative', 'error description unavailable']
            ]
        }
    ];
    for (const variant of variants)
    {
        const fixture = path.join(directory, `${variant.name}.c`);
        const output = path.join(directory, variant.name);
        fs.writeFileSync(fixture, [
            '#define _GNU_SOURCE',
            '#include <errno.h>',
            '#include <stdlib.h>',
            '#include <string.h>',
            '',
            'static int calls;',
            `static ${variant.returnType} ErrorTextAdapter(int error, char* buffer, size_t length)`,
            '{',
            '    if (error != ENOENT || ++calls != 1 || length < 64)',
            '    {',
            '        _Exit(77);',
            '    }',
            '    errno = EIO;',
            ...variant.body,
            '}',
            '',
            '#define strerror_r ErrorTextAdapter',
            '#define main LandlockProgramMain',
            `#include ${JSON.stringify(source)}`,
            '#undef main',
            '',
            'int main(void)',
            '{',
            '    errno = ENOENT;',
            '    Fail("adapter probe");',
            '    return 125;',
            '}',
            ''
        ].join('\n'));
        const compilation = spawnSync('cc', [
            '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-o', output, fixture
        ], { encoding: 'utf8', timeout: 30_000 });
        assert.equal(compilation.status, 0, compilation.stderr);
        for (const [resultType, diagnostic] of variant.cases)
        {
            const result = spawnSync(output, [], {
                encoding: 'utf8',
                env: {
                    PATH: process.env.PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
                    FSUSBLOG_ERROR_TEXT_RESULT: resultType
                },
                timeout: 30_000
            });
            assert.equal(result.status, 125, `${variant.name}/${resultType}: ${result.stderr}`);
            assert.equal(result.stdout, '', resultType);
            assert.equal(result.stderr, `execution-envelope-landlock: adapter probe: ${diagnostic}\n`, resultType);
        }
    }
});

test('owned private /tmp capabilities refuse serialized, cross-owner, stale and altered inputs', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-owned-tmp-capability-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepare = (attemptId) => prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root,
        runId: 'owned-tmp-run', producerId: 'producer', attemptId });
    const owner = prepare('first');
    const other = prepare('second');
    const environment = { ...owner.environment, FSUSBLOG_TEST_RUN_ID: 'owned-tmp-run', PATH: process.env.PATH };
    const readWritePaths = Object.values(owner.fragment.directories);
    const binding = inspectOwnedPrivateTmp(owner.privateTmpCapability, { environment, readWritePaths });
    assert.equal(binding.source, owner.fragment.directories.temp);
    assert.equal(binding.destination, '/tmp');
    assert.throws(() => inspectOwnedPrivateTmp(JSON.parse(JSON.stringify(owner.privateTmpCapability))), /capability/u);
    assert.throws(() => inspectOwnedPrivateTmp(other.privateTmpCapability, { environment, readWritePaths }), /drifted/u);
    assert.throws(() => inspectOwnedPrivateTmp(owner.privateTmpCapability, {
        environment: { ...environment, FSUSBLOG_TEST_RUN_ID: 'older-run' }, readWritePaths
    }), /drifted/u);
    assert.throws(() => inspectOwnedPrivateTmp(owner.privateTmpCapability, { environment, readWritePaths: [] }), /drifted/u);
    fs.chmodSync(binding.source, 0o755);
    assert.throws(() => inspectOwnedPrivateTmp(owner.privateTmpCapability), /drifted/u);
    fs.chmodSync(binding.source, 0o700);
    const retired = binding.source + '-retired';
    fs.renameSync(binding.source, retired);
    fs.mkdirSync(binding.source, { mode: 0o700 });
    assert.throws(() => inspectOwnedPrivateTmp(owner.privateTmpCapability), /drifted/u);
    fs.rmdirSync(binding.source);
    fs.symlinkSync(other.fragment.directories.temp, binding.source);
    assert.throws(() => inspectOwnedPrivateTmp(owner.privateTmpCapability), /drifted/u);
    fs.unlinkSync(binding.source);
    assert.throws(() => inspectOwnedPrivateTmp(owner.privateTmpCapability), /ENOENT/u);
});

test('native owned private /tmp refuses absent binding before its command', { skip: process.platform !== 'linux' }, (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-owned-tmp-absent-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const owner = prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root,
        runId: 'owned-tmp-absent', producerId: 'producer', attemptId: 'attempt' });
    const environment = { ...owner.environment, FSUSBLOG_TEST_RUN_ID: 'owned-tmp-absent', PATH: process.env.PATH };
    const sentinel = path.join(owner.fragment.directories.temp, 'must-not-execute');
    const sandbox = prepareNetworkSandbox({ command: [process.execPath, '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'bad')`], cwd: root,
        directories: owner.fragment.directories, ownedDirectoryEnvelope: owner,
        writableRoots: owner.fragment.writableRoots, environment, policy });
    const result = spawnSync(sandbox.command[0], sandbox.command.slice(1), { cwd: root, env: environment, encoding: 'utf8' });
    assert.equal(result.status, 125, result.stderr);
    assert.match(result.stderr, /owned temporary alias object identity mismatch/u);
    assert.equal(fs.existsSync(sentinel), false);
    assert.equal(finalizeNetworkSandbox(sandbox).admission, 'planned-actual-exact');
    assert.equal(finalizeRunOwnedDirectories(owner).cleanup.status, 'complete');
});

test('original physical owner binds only current owned /tmp and retains external write denial', {
    skip: process.platform !== 'linux'
}, async (context) =>
{
    fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
    const root = fs.mkdtempSync(path.join(process.cwd(), '.tmp/fsusblog-owned-tmp-physical-'));
    const owner = prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root,
        runId: 'owned-tmp-physical', producerId: 'producer', attemptId: 'attempt' });
    let terminal;
    let physicalStarted = false;
    context.after(() =>
    {
        finalizeRunOwnedDirectoriesAfterPhysical(owner, { physicalStarted, physicalExecution: terminal });
        fs.rmSync(root, { recursive: true, force: true });
    });
    const hostTmp = fs.statSync('/tmp', { bigint: true });
    const hostNamespace = fs.readlinkSync('/proc/self/ns/mnt');
    const name = `fsusblog-alias-${process.pid}-${path.basename(root)}`;
    const external = path.join(root, 'read-only-source');
    fs.writeFileSync(external, 'unchanged');
    const source = owner.fragment.directories.temp;
    const environment = { ...owner.environment, FSUSBLOG_TEST_RUN_ID: 'owned-tmp-physical', PATH: process.env.PATH,
        LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' };
    const sandbox = prepareNetworkSandbox({ command: [process.execPath, '-e', [
        "const fs = require('node:fs')",
        `fs.writeFileSync('/tmp/${name}', 'owned-alias')`,
        `if (fs.readFileSync(${JSON.stringify(path.join(source, name))}, 'utf8') !== 'owned-alias') throw Error('wrong alias')`,
        `try { fs.writeFileSync(${JSON.stringify(external)}, 'bad'); throw Error('external writable'); } catch (e) { if (!['EACCES','EPERM','EROFS'].includes(e.code)) throw e; }`,
        "try { fs.writeFileSync('/var/tmp/fsusblog-must-not-write', 'bad'); throw Error('var/tmp writable'); } catch (e) { if (!['EACCES','EPERM','EROFS'].includes(e.code)) throw e; }"
    ].join(';')], cwd: root, directories: owner.fragment.directories, ownedDirectoryEnvelope: owner,
        writableRoots: owner.fragment.writableRoots, environment, policy });
    assert.equal(sandbox.linuxReadWritePaths.includes('/tmp'), false);
    assert.equal(sandbox.linuxReadWritePaths.includes('/var/tmp'), false);
    const quiet = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    try
    {
        physicalStarted = true;
        terminal = await runPhysicalExecution({ command: sandbox.command, cwd: root, env: environment,
            linuxNetworkPolicy: sandbox.linuxNetworkPolicy, linuxReadWritePaths: sandbox.linuxReadWritePaths,
            linuxOwnedPrivateTmp: sandbox.linuxOwnedPrivateTmp, stdout: quiet, stderr: quiet });
    }
    catch (error) { terminal = error.physicalExecution; throw error; }
    assert.equal(terminal.postObservation, 'zero-members');
    const actual = terminal.executionAdmission.ownedPrivateTmp;
    assert.equal(actual.sourceDevice, actual.aliasDevice);
    assert.equal(actual.sourceInode, actual.aliasInode);
    assert.notEqual(actual.mountNamespace, hostNamespace);
    assert.equal(terminal.authority.filesystemIsolation.ownedPrivateTmp.bindPaths, `${source}:/tmp`);
    assert.equal(fs.readFileSync(path.join(source, name), 'utf8'), 'owned-alias');
    assert.equal(fs.existsSync(path.join('/tmp', name)), false);
    assert.equal(fs.readFileSync(external, 'utf8'), 'unchanged');
    const hostAfter = fs.statSync('/tmp', { bigint: true });
    assert.deepEqual([hostAfter.dev, hostAfter.ino], [hostTmp.dev, hostTmp.ino]);
    assert.equal(fs.readlinkSync('/proc/self/ns/mnt'), hostNamespace);
    assert.equal(finalizeNetworkSandbox(sandbox).admission, 'planned-actual-exact');
});


function componentNetworkOwner(context)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-network-async-component-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let retained;
    const owner = prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root,
        runId: 'component-network-run', producerId: 'component-network-producer', attemptId: 'component-attempt',
        retainPrepared: (prepared) =>
        {
            retained = prepared;
        } });
    assert.equal(retained, owner);
    const toolDirectory = owner.fragment.directories.home;
    for (const tool of ['strace', 'cc'])
    {
        fs.writeFileSync(path.join(toolDirectory, tool), 'component-only executable bytes', { mode: 0o700 });
    }
    const environment = { ...owner.environment, PATH: toolDirectory, FSUSBLOG_TEST_RUN_ID: 'component-network-run',
        FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40), FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'sha256:' + 'b'.repeat(64),
        LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' };
    const terminals = new WeakMap();
    const calls = [];
    let compileFailure = null;
    const callbacks = {
        assertPreparationExecution: async ({ request, phase, physicalExecution }) =>
        {
            calls.push({ phase, request });
            assert.equal(request.cwd, root);
            assert.equal(request.environment.TMPDIR, owner.fragment.directories.temp);
            assert.equal(request.environment.FSUSBLOG_TEST_RUN_ID, environment.FSUSBLOG_TEST_RUN_ID);
            assert.equal(request.environment.FSUSBLOG_TEST_SOURCE_COMMIT, environment.FSUSBLOG_TEST_SOURCE_COMMIT);
            assert.ok(Object.isFrozen(request) && Object.isFrozen(request.environment));
            if (phase === 'before')
            {
                assert.equal(physicalExecution, null);
                terminals.set(request, null);
            }
            else
            {
                assert.ok(terminals.has(request));
                assert.equal(physicalExecution, terminals.get(request));
            }
        },
        executePreparation: async (request) =>
        {
            assert.ok(terminals.has(request));
            calls.push({ phase: 'execute', request });
            const stdout = request.purpose === 'executable-version' ? 'component-tool-v1\n' : '';
            const terminal = {
                schema: 'fsusblog.physical-execution-process-tree.v1', platform: 'linux',
                policy: { maximumCapturedOutputBytesPerStream: 1_048_576 },
                authority: { kind: 'linux-cgroup-process-group', established: true },
                postObservation: 'zero-members', logComplete: true, logTruncationReason: null, forcedPipeClose: false,
                lifecycle: ['post-observe-zero-members', 'bounded-pipe-close', 'seal-completed-receipt'], termination: [],
                processInventory: [{ role: 'direct-child', pid: 123, startIdentity: 'component-only-start', exitCode: 0, signal: null }],
                stdout, stderr: '', outputCapture: { maximumBytesPerStream: 1_048_576,
                    stdoutBytes: Buffer.byteLength(stdout), stdoutCapturedBytes: Buffer.byteLength(stdout), stdoutTruncated: false,
                    stderrBytes: 0, stderrCapturedBytes: 0, stderrTruncated: false }
            };
            terminals.set(request, terminal);
            if (request.purpose === 'landlock-helper-build')
            {
                if (compileFailure)
                {
                    throw Object.assign(compileFailure, { physicalExecution: terminal });
                }
                const output = request.command[request.command.indexOf('-o') + 1];
                assert.equal(output, path.join(owner.fragment.directories.toolCache, 'execution-envelope-landlock'));
                fs.writeFileSync(output, 'component-only helper bytes', { mode: 0o700 });
            }
            return terminal;
        }
    };
    return { root, owner, calls, callbacks, failCompile: (error) =>
    {
        compileFailure = error;
    },
    input: { command: ['/component/business'], cwd: root, directories: owner.fragment.directories,
        ownedDirectoryEnvelope: owner, writableRoots: owner.fragment.writableRoots, environment, policy,
        producerId: 'component-network-producer', attemptId: 'component-attempt', platform: 'linux' } };
}

test('component async network preparation requires both owner callbacks and never falls back to native spawn', async () =>
{
    let executed = false;
    const input = { command: ['/component/business'], cwd: path.resolve('.'), directories: {}, writableRoots: [],
        environment: { PATH: '/component/no-tools' }, policy, platform: 'linux' };
    for (const callbacks of [{}, { executePreparation: async () =>
    {
        executed = true;
    } },
    { assertPreparationExecution: async () =>
    {} }])
    {
        await assert.rejects(prepareNetworkSandboxAsync({ ...input, ...callbacks }), /held-managed owner port/u);
    }
    assert.equal(executed, false);
});

test('component async network preparation uses original compiler arguments and actual owned directory capability', async (context) =>
{
    const fixture = componentNetworkOwner(context);
    const result = await prepareNetworkSandboxAsync({ ...fixture.input, ...fixture.callbacks });
    const executions = fixture.calls.filter((call) => call.phase === 'execute');
    assert.deepEqual(executions.map((call) => call.request.purpose), [
        'executable-version', 'executable-version', 'landlock-helper-build', 'executable-version'
    ]);
    assert.deepEqual(executions[2].request.command, [path.join(fixture.owner.fragment.directories.home, 'cc'),
        '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-o',
        path.join(fixture.owner.fragment.directories.toolCache, 'execution-envelope-landlock'),
        path.resolve(import.meta.dirname, '../../tools/test/native/execution-envelope-landlock.c')]);
    assert.equal(result.linuxOwnedPrivateTmp, fixture.owner.privateTmpCapability);
    assert.deepEqual(result.linuxReadWritePaths.filter((entry) => entry.startsWith('/dev/')), ['/dev/null']);
    assert.equal(result.linuxReadWritePaths.includes('/tmp'), false);
    assert.equal(result.linuxReadWritePaths.includes('/var/tmp'), false);
    assert.equal(result.privateDotnetScratch, false);
    assert.equal(result.fragment.admission, 'pending');
    assert.equal(result.fragment.actual, null);
    assert.equal(finalizeRunOwnedDirectories(fixture.owner).cleanup.status, 'complete');
});

test('component async network build failure retains first cause and original actual terminal without unrestricted retry', async (context) =>
{
    const fixture = componentNetworkOwner(context);
    const primary = new Error('component compiler failed');
    fixture.failCompile(primary);
    await assert.rejects(prepareNetworkSandboxAsync({ ...fixture.input, ...fixture.callbacks }), (error) =>
        error === primary && error.physicalExecution?.postObservation === 'zero-members');
    assert.deepEqual(fixture.calls.filter((call) => call.phase === 'execute').map((call) => call.request.purpose), [
        'executable-version', 'executable-version', 'landlock-helper-build'
    ]);
    assert.equal(fixture.calls.at(-1).phase, 'after');
    assert.equal(finalizeRunOwnedDirectories(fixture.owner).cleanup.status, 'complete');
});

test('original directory producer retention hook keeps the sole actual opaque capability and never-started cleanup', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-directory-retain-component-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let retained;
    const owner = prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root, runId: 'retain-run',
        producerId: 'retain-producer', attemptId: 'retain-attempt', retainPrepared: (prepared) =>
        {
            retained = prepared;
        } });
    assert.equal(retained, owner);
    const binding = inspectOwnedPrivateTmp(retained.privateTmpCapability, {
        environment: { ...owner.environment, FSUSBLOG_TEST_RUN_ID: 'retain-run' },
        readWritePaths: Object.values(owner.fragment.directories)
    });
    assert.equal(binding.source, owner.fragment.directories.temp);
    assert.equal(finalizeRunOwnedDirectories(owner).cleanup.status, 'complete');
    assert.equal(fs.existsSync(owner.fragment.ownedRoot), false);
});

test('original directory producer retention failure retains first cause and proves actual never-started removal', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-directory-retain-failure-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const primary = new Error('component owner refused retained preparation');
    let retained;
    assert.throws(() => prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root, runId: 'retain-failure',
        producerId: 'retain-producer', attemptId: 'retain-attempt', retainPrepared: (prepared) =>
        {
            retained = prepared;
            throw primary;
        } }), (error) => error === primary);
    assert.ok(retained?.privateTmpCapability);
    assert.deepEqual(retained.fragment.cleanup, { status: 'complete', removedOwnedRoot: true });
    assert.equal(fs.existsSync(retained.fragment.ownedRoot), false);
});

test('original directory producer refuses an asynchronous retention acknowledgement before later tool effects', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-directory-retain-async-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let retained;
    assert.throws(() => prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root, runId: 'retain-async',
        producerId: 'retain-producer', attemptId: 'retain-attempt', retainPrepared: (prepared) =>
        {
            retained = prepared;
            return Promise.resolve();
        } }), /retention must complete synchronously/u);
    assert.deepEqual(retained.fragment.cleanup, { status: 'complete', removedOwnedRoot: true });
    assert.equal(fs.existsSync(retained.fragment.ownedRoot), false);
});

test('component preparation-only terminal reaches the original directory guard as actually started', async (context) =>
{
    const { combinePreparationAndBusinessTerminal } = await import(new URL('../../tools/test/run-deterministic-command.mjs', import.meta.url));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-preparation-terminal-component-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const owner = prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root,
        runId: 'terminal-run', producerId: 'terminal-producer', attemptId: 'terminal-attempt' });
    // This is a supplied component terminal, not an observed native tool proof.
    const toolTerminal = { postObservation: 'zero-members', component: 'preparation' };
    const state = combinePreparationAndBusinessTerminal({ physicalStarted: true, physicalExecution: toolTerminal },
        { physicalStarted: false, physicalExecution: null }, { ownedRoot: owner.fragment.ownedRoot });
    assert.equal(state.physicalStarted, true);
    assert.equal(state.physicalExecution, toolTerminal);
    assert.equal(finalizeRunOwnedDirectoriesAfterPhysical(owner, state).cleanup.status, 'complete');
    assert.equal(fs.existsSync(owner.fragment.ownedRoot), false);
});

test('component two-stage zero terminals preserve the business proof without fabricating an aggregate', async () =>
{
    const { combinePreparationAndBusinessTerminal } = await import(new URL('../../tools/test/run-deterministic-command.mjs', import.meta.url));
    const toolTerminal = { postObservation: 'zero-members', component: 'preparation' };
    const businessTerminal = { postObservation: 'zero-members', component: 'business' };
    const state = combinePreparationAndBusinessTerminal({ physicalStarted: true, physicalExecution: toolTerminal },
        { physicalStarted: true, physicalExecution: businessTerminal }, { ownedRoot: '/component-owned-root' });
    assert.equal(state.physicalStarted, true);
    assert.equal(state.physicalExecution, businessTerminal);
    assert.notEqual(state.physicalExecution, toolTerminal);
});

test('component unknown terminal in either started phase retains the original directory', async (context) =>
{
    const { combinePreparationAndBusinessTerminal } = await import(new URL('../../tools/test/run-deterministic-command.mjs', import.meta.url));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-preparation-unknown-component-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const owner = prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root,
        runId: 'unknown-run', producerId: 'unknown-producer', attemptId: 'unknown-attempt' });
    const zero = { postObservation: 'zero-members', component: true };
    for (const phase of ['preparation', 'business'])
    {
        for (const terminal of [null, { postObservation: 'unverifiable' }, { postObservation: 'residual-members' }])
        {
            const preparation = { physicalStarted: true, physicalExecution: phase === 'preparation' ? terminal : zero };
            const business = { physicalStarted: true, physicalExecution: phase === 'business' ? terminal : zero };
            assert.throws(() => finalizeRunOwnedDirectoriesAfterPhysical(owner,
                combinePreparationAndBusinessTerminal(preparation, business, { ownedRoot: owner.fragment.ownedRoot })),
            (error) => error.recoveryObligation?.ownedRoot === owner.fragment.ownedRoot
                && error.recoveryObligation.reason.startsWith(phase));
            assert.equal(fs.existsSync(owner.fragment.ownedRoot), true);
        }
    }
    assert.throws(() => combinePreparationAndBusinessTerminal({ physicalStarted: false, physicalExecution: zero },
        { physicalStarted: false, physicalExecution: null }, { ownedRoot: owner.fragment.ownedRoot }), /preparation terminal/u);
    assert.equal(fs.existsSync(owner.fragment.ownedRoot), true);
});

test('standalone null preparation preserves the original business state and directory refusal', async (context) =>
{
    const { combinePreparationAndBusinessTerminal } = await import(new URL('../../tools/test/run-deterministic-command.mjs', import.meta.url));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-standalone-terminal-component-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const owner = prepareRunOwnedDirectories({ repositoryRoot: root, cwd: root,
        runId: 'standalone-run', producerId: 'standalone-producer', attemptId: 'standalone-attempt' });
    const business = { physicalStarted: true, physicalExecution: null };
    const state = combinePreparationAndBusinessTerminal(null, business, { ownedRoot: owner.fragment.ownedRoot });
    assert.equal(state, business);
    assert.throws(() => finalizeRunOwnedDirectoriesAfterPhysical(owner, state), /unverifiable physical residue/u);
    assert.equal(fs.existsSync(owner.fragment.ownedRoot), true);
});
