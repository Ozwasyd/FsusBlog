import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const collector = path.join(repositoryRoot, 'tools/test/collect-release-reliability-fixture.mjs');
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sourceCommit = 'a'.repeat(40);
const sourceFingerprint = 'b'.repeat(64);
const runtimeImageDigest = `sha256:${'a'.repeat(64)}`;
const networkName = 'fixture-network';
const networkId = 'fixture-network-id';
const healthcheck = {
    Test: ['CMD-SHELL', 'curl -fsS http://127.0.0.1:8080/health/live'],
    Interval: 30_000_000_000,
    Timeout: 5_000_000_000,
    StartPeriod: 45_000_000_000,
    Retries: 3
};
const containerOverrides = {
    FSUSBLOG_DATA_ROOT: '/app/data',
    PublicAot__SsrClientRoot: '/app/wwwroot',
    ASPNETCORE_URLS: 'http://0.0.0.0:8080',
    AllowedHosts: '127.0.0.1;localhost',
    ConnectionStrings__DefaultConnection: 'Host=postgres;Port=5432;Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Include Error Detail=true',
    ConnectionStrings__Redis: 'redis:6379,abortConnect=false,connectTimeout=10000',
    RedisOptions__Configuration: 'redis:6379,abortConnect=false,connectTimeout=10000',
    DOTNET_DbgEnableMiniDump: '1',
    DOTNET_DbgMiniDumpType: '4',
    DOTNET_DbgMiniDumpName: '/app/runtime-cache/coredump.%p',
    DOTNET_EnableCrashReport: '1',
    DOTNET_CreateDumpDiagnostics: '1',
    DOTNET_CreateDumpLogToFile: '/app/runtime-cache/createdump.log'
};

function createFixture(context)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-fixture-collector-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runtimeEnvironment = [
        'FSUSBLOG_TEST_RUN_ID=fixture-run',
        'FSUSBLOG_TEST_NAMESPACE=fixture-namespace',
        'FSUSBLOG_POSTGRES_CONTAINER_NAME=postgres',
        'FSUSBLOG_REDIS_CONTAINER_NAME=redis',
        'FSUSBLOG_DEBUG_BACKEND_PORT=24501',
        'FSUSBLOG_DEBUG_FRONTEND_PORT=26501',
        'FSUSBLOG_RELEASE_PREVIEW_PORT=28501',
        'FSUSBLOG_DEBUG_BACKEND_URL=http://127.0.0.1:24501',
        'FSUSBLOG_DEBUG_FRONTEND_URL=http://127.0.0.1:26501',
        'FSUSBLOG_RELEASE_PREVIEW_URL=http://127.0.0.1:28501',
        'ASPNETCORE_URLS=http://127.0.0.1:24501',
        'ConnectionStrings__DefaultConnection=Host=127.0.0.1;Port=20001;Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Include Error Detail=true',
        'ConnectionStrings__Redis=127.0.0.1:22001',
        'RedisOptions__Configuration=127.0.0.1:22001',
        'FSUSBLOG_DATA_ROOT=/host/run-bound/data',
        'PublicAot__SsrClientRoot=/host/run-bound/frontend/dist'
    ];
    for (const [relative, contents] of Object.entries({
        'fixture/config.env': `${runtimeEnvironment.join('\n')}\n`,
        'fixture/schema.sql': 'CREATE TABLE fixture(id integer);\n',
        'fixture/seed.json': '{"seed":[1]}\n',
        'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs': 'public static class AuditRetentionCatalog {}\n'
    }))
    {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
    }
    const configuredEnvironment = [
        ...runtimeEnvironment.filter((entry) => (
            !Object.keys(containerOverrides).some((key) => entry.startsWith(`${key}=`))
        )),
        ...Object.entries(containerOverrides).map(([key, value]) => `${key}=${value}`),
        'FSUSBLOG_RUNTIME_ROLE=backend',
        `FSUSBLOG_TEST_SOURCE_COMMIT=${sourceCommit}`,
        `FSUSBLOG_TEST_SOURCE_FINGERPRINT=${sourceFingerprint}`
    ];
    const processIdentity = {
        pid: 1,
        processGroupId: 1,
        sessionId: 1,
        startTimeTicks: '12345',
        executable: '/app/FsusBlog.Server',
        commandLine: ['/app/FsusBlog.Server'],
        workingDirectory: '/app',
        environment: Object.fromEntries(configuredEnvironment.map((entry) => entry.split(/=(.*)/su).slice(0, 2)))
    };
    const labels = { 'io.fsusblog.test.run-id': 'fixture-run', 'io.fsusblog.test.namespace': 'fixture-namespace' };
    const containers = Object.fromEntries(['postgres', 'redis'].map((name) => [name, {
        Id: `fixture-${name}-id`,
        Image: `sha256:${name.padEnd(64, '0').slice(0, 64)}`,
        State: { Running: true },
        Config: { Image: `${name}:fixture`, Labels: { ...labels } },
        NetworkSettings: {
            Networks: {
                [networkName]: {
                    Aliases: [name],
                    IPAddress: name === 'postgres' ? '172.28.0.2' : '172.28.0.3',
                    NetworkID: networkId
                }
            }
        }
    }]));
    containers.backend = {
        Id: 'fixture-backend-id',
        Image: runtimeImageDigest,
        Path: '/app/FsusBlog.Server',
        Args: [],
        State: {
            Running: true,
            Pid: 4242,
            StartedAt: '2026-07-26T00:00:00Z',
            Health: { Status: 'healthy' }
        },
        Config: {
            Image: 'fixture/runtime:immutable',
            Env: configuredEnvironment,
            ExposedPorts: { '8080/tcp': {} },
            Healthcheck: structuredClone(healthcheck),
            Labels: { ...labels }
        },
        HostConfig: {
            PortBindings: {
                '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '24501' }]
            }
        },
        NetworkSettings: {
            Networks: {
                [networkName]: {
                    Aliases: ['backend'],
                    IPAddress: '172.28.0.4',
                    NetworkID: networkId
                }
            },
            Ports: {
                '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '24501' }]
            }
        }
    };
    const network = {
        Id: networkId,
        Name: networkName,
        Driver: 'bridge',
        Labels: { ...labels },
        Containers: Object.fromEntries(Object.values(containers).map((container) => [
            container.Id,
            { Name: container.Id }
        ]))
    };
    const image = {
        Id: runtimeImageDigest,
        Config: {
            Healthcheck: structuredClone(healthcheck),
            Labels: { 'org.opencontainers.image.revision': sourceCommit }
        },
        RootFS: { Layers: [`sha256:${'b'.repeat(64)}`] }
    };
    const stateFile = path.join(root, 'docker-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ ...containers, image, network, processIdentity }));
    const tools = path.join(root, 'tools');
    fs.mkdirSync(tools, { recursive: true });
    fs.writeFileSync(path.join(tools, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.FSUSBLOG_FIXTURE_DOCKER_STATE, 'utf8'));
if (process.argv[2] === 'image' && process.argv[3] === 'inspect') {
  process.stdout.write(JSON.stringify([state.image]));
  process.exit(0);
}
if (process.argv[2] === 'network' && process.argv[3] === 'inspect') {
  process.stdout.write(JSON.stringify([state.network]));
  process.exit(0);
}
if (process.argv[2] === 'exec') {
  const command = process.argv.at(-1);
  const identity = state.processIdentity;
  if (command.includes('/proc/1/stat')) {
    const tail = ['S', '0', String(identity.processGroupId), String(identity.sessionId), ...Array(15).fill('0'), String(identity.startTimeTicks)];
    process.stdout.write('1 (FsusBlog.Server) ' + tail.join(' ') + '\\n');
  } else if (command.includes('/proc/1/environ')) {
    process.stdout.write(Object.entries(identity.environment).map(([key, value]) => key + '=' + value).join('\\n') + '\\n');
  } else if (command.includes('/proc/1/exe')) {
    process.stdout.write(identity.executable + '\\n');
  } else if (command.includes('/proc/1/cmdline')) {
    process.stdout.write(identity.commandLine.join('\\n') + '\\n');
  } else if (command.includes('/proc/1/cwd')) {
    process.stdout.write(identity.workingDirectory + '\\n');
  } else process.exit(1);
  process.exit(0);
}
const value = state[process.argv.at(-1)];
if (process.argv[2] !== 'inspect' || !value) process.exit(1);
process.stdout.write(JSON.stringify([value]));
`);
    fs.chmodSync(path.join(tools, 'docker'), 0o755);
    return { root, tools, stateFile, containers, image, network, processIdentity };
}

function writeState(fixture)
{
    fs.writeFileSync(fixture.stateFile, JSON.stringify({
        ...fixture.containers,
        image: fixture.image,
        network: fixture.network,
        processIdentity: fixture.processIdentity
    }));
}

function collect(fixture)
{
    return spawnSync(process.execPath, [
        collector,
        '--root', fixture.root,
        '--run-id', 'fixture-run',
        '--namespace', 'fixture-namespace',
        '--fixture-root', 'fixture',
        '--config', 'fixture/config.env',
        '--schema', 'fixture/schema.sql',
        '--seed', 'fixture/seed.json',
        '--audit-retention-policy', 'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs',
        '--postgres', 'postgres',
        '--redis', 'redis',
        '--backend-container', 'backend',
        '--network', networkName,
        '--source-commit', sourceCommit,
        '--source-fingerprint', sourceFingerprint,
        '--runtime-image', 'fixture/runtime:immutable',
        '--image-digest', runtimeImageDigest,
        '--out', 'fixture/topology.json'
    ], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${fixture.tools}${path.delimiter}${process.env.PATH ?? ''}`,
            FSUSBLOG_FIXTURE_DOCKER_STATE: fixture.stateFile
        }
    });
}

test('fixture collector seals Docker-native backend procfs identity and fixture bytes', (context) =>
{
    const fixture = createFixture(context);
    const result = collect(fixture);
    assert.equal(result.status, 0, result.stderr);
    const topology = JSON.parse(fs.readFileSync(path.join(fixture.root, 'fixture/topology.json'), 'utf8'));
    assert.equal(topology.runtime.backendContainer.id, fixture.containers.backend.Id);
    assert.equal(topology.runtime.backendContainer.hostPid, fixture.containers.backend.State.Pid);
    assert.equal(topology.runtime.backendContainer.health.status, 'healthy');
    assert.deepEqual(topology.runtime.backendContainer.health.configuration, healthcheck);
    assert.match(
        topology.runtime.backendContainer.health.configurationDigest,
        /^sha256:[0-9a-f]{64}$/u
    );
    assert.deepEqual(topology.runtime.backendContainer.portBinding, {
        containerPort: 8080,
        hostIp: '127.0.0.1',
        hostPort: 24501,
        protocol: 'tcp'
    });
    assert.equal(topology.runtime.network.id, networkId);
    assert.equal(topology.runtime.network.driver, 'bridge');
    assert.ok(topology.runtime.network.postgres.aliases.includes('postgres'));
    assert.ok(topology.runtime.network.redis.aliases.includes('redis'));
    assert.deepEqual(topology.runtime.environmentProjection.effective, {
        ...Object.fromEntries(
            fs.readFileSync(path.join(fixture.root, 'fixture/config.env'), 'utf8')
                .trim()
                .split('\n')
                .map((entry) => entry.split(/=(.*)/su).slice(0, 2))
        ),
        ...containerOverrides,
        FSUSBLOG_RUNTIME_ROLE: 'backend',
        FSUSBLOG_TEST_SOURCE_COMMIT: sourceCommit,
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceFingerprint
    });
    assert.deepEqual(topology.runtime.process, fixture.processIdentity);
    assert.equal(topology.config.fileDigest, digest(fs.readFileSync(path.join(fixture.root, 'fixture/config.env'))));
    assert.equal(
        topology.auditRetentionPolicy.fileDigest,
        digest(fs.readFileSync(path.join(
            fixture.root,
            'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs'
        )))
    );
    assert.match(topology.contentDigest, /^sha256:[0-9a-f]{64}$/u);
});

test('fixture collector fails closed for stopped and cross-namespace service containers', (context) =>
{
    for (const mutate of [
        (fixture) => { fixture.containers.postgres.State.Running = false; },
        (fixture) => { fixture.containers.redis.Config.Labels['io.fsusblog.test.namespace'] = 'other-namespace'; }
    ])
    {
        const fixture = createFixture(context);
        mutate(fixture);
        writeState(fixture);
        const result = collect(fixture);
        assert.notEqual(result.status, 0);
    }
});

test('fixture collector rejects Docker/procfs PID, env, audited override, command, session, and image mismatches', (context) =>
{
    for (const mutate of [
        (fixture) => { fixture.containers.backend.State.Running = false; },
        (fixture) => { delete fixture.containers.backend.State.Health; },
        (fixture) => { fixture.containers.backend.State.Health.Status = 'unhealthy'; },
        (fixture) => { fixture.containers.backend.Config.Healthcheck.Retries = 1; },
        (fixture) => { delete fixture.image.Config.Healthcheck; },
        (fixture) => { fixture.containers.backend.State.Pid = 1; },
        (fixture) => { fixture.containers.backend.Image = `sha256:${'f'.repeat(64)}`; },
        (fixture) => { fixture.containers.backend.Config.Env[0] = 'FSUSBLOG_TEST_RUN_ID=other-run'; },
        (fixture) => {
            const index = fixture.containers.backend.Config.Env.indexOf('FSUSBLOG_DATA_ROOT=/app/data');
            fixture.containers.backend.Config.Env[index] = 'FSUSBLOG_DATA_ROOT=/host/run-bound/data';
        },
        (fixture) => {
            const index = fixture.containers.backend.Config.Env.indexOf('ASPNETCORE_URLS=http://0.0.0.0:8080');
            fixture.containers.backend.Config.Env[index] = 'ASPNETCORE_URLS=http://127.0.0.1:24501';
        },
        (fixture) => {
            fixture.containers.backend.Config.Env.push('UNDECLARED_AMBIENT=value');
            fixture.processIdentity.environment.UNDECLARED_AMBIENT = 'value';
        },
        (fixture) => {
            fixture.containers.backend.HostConfig.PortBindings['8080/tcp'][0].HostIp = '0.0.0.0';
        },
        (fixture) => {
            fixture.containers.backend.NetworkSettings.Ports['8080/tcp'][0].HostPort = '8080';
        },
        (fixture) => {
            fixture.containers.postgres.NetworkSettings.Networks[networkName].Aliases = ['wrong-postgres'];
        },
        (fixture) => {
            fixture.network.Labels['io.fsusblog.test.run-id'] = 'other-run';
        },
        (fixture) => {
            fixture.network.Driver = 'host';
        },
        (fixture) => {
            delete fixture.network.Containers[fixture.containers.redis.Id];
        },
        (fixture) => { fixture.processIdentity.environment.FSUSBLOG_TEST_NAMESPACE = 'other-namespace'; },
        (fixture) => { fixture.processIdentity.commandLine = ['/app/Other.Server']; },
        (fixture) => { fixture.processIdentity.processGroupId = 2; },
        (fixture) => { fixture.processIdentity.sessionId = 2; }
    ])
    {
        const fixture = createFixture(context);
        mutate(fixture);
        writeState(fixture);
        const result = collect(fixture);
        assert.notEqual(result.status, 0);
    }
});
