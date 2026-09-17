import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    discoverBackendProcessTarget,
    readLoadProfilePolicy,
    readReleaseResourceOpenFileDescriptors,
    readReleaseResourceRssBytes
} = await import(
    pathToFileURL(path.join(root, 'tools/test/lanes/runtime-evidence-probe.mjs')).href
);

test('load profile policy parser accepts repository CRLF or LF input', () =>
{
    const policy = readLoadProfilePolicy('expected-peak');
    assert.deepEqual(policy.declared, {
        concurrency: 50,
        rounds: 12,
        durationMs: 60000
    });
    assert.equal(policy.thresholds.minRps, 1);
    assert.match(policy.fileDigest, /^sha256:[0-9a-f]{64}$/u);
});

test('release-bound runtime probes cannot reload ambient namespace secrets', () =>
{
    const source = fs.readFileSync(
        path.join(root, 'tools/test/lanes/runtime-evidence-probe.mjs'),
        'utf8'
    );
    assert.match(
        source,
        /if \(!process\.env\.FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID\)\s*\{\s*loadBootstrapEnv/u
    );
});

test('release resource probes use the verified Docker container process namespace', () =>
{
    const containerId = 'a'.repeat(64);
    const hostPid = 4242;
    const calls = [];
    const spawnProcess = (executable, args) =>
    {
        calls.push({ executable, args });
        if (args[0] === 'inspect')
        {
            return {
                status: 0,
                stdout: JSON.stringify([{
                    Id: containerId,
                    State: { Running: true, Pid: hostPid }
                }]),
                stderr: ''
            };
        }
        const command = args.at(-1);
        return {
            status: 0,
            stdout: command.includes('VmRSS') ? '67108864\n' : '37\n',
            stderr: ''
        };
    };
    const target = discoverBackendProcessTarget({
        environment: {
            FSUSBLOG_RELEASE_RESOURCE_CONTAINER_ID: containerId,
            FSUSBLOG_RELEASE_RESOURCE_PID: String(hostPid)
        },
        spawnProcess
    });
    assert.deepEqual(target, {
        status: 'ok',
        kind: 'docker-container',
        containerId,
        pid: hostPid,
        source: 'verified-docker-container-env'
    });
    assert.deepEqual(
        readReleaseResourceRssBytes(target, { spawnProcess }),
        {
            status: 'ok',
            value: 67108864,
            source: `docker:${containerId}:/proc/1/status`
        }
    );
    assert.deepEqual(
        readReleaseResourceOpenFileDescriptors(target, { spawnProcess }),
        {
            status: 'ok',
            value: 37,
            source: `docker:${containerId}:/proc/1/fd`
        }
    );
    assert.equal(calls.filter(({ args }) => args[0] === 'exec').length, 2);
    assert.ok(calls.every(({ executable }) => executable === 'docker'));
});

test('release resource container identity rejects a changed host PID', () =>
{
    const containerId = 'b'.repeat(64);
    const target = discoverBackendProcessTarget({
        environment: {
            FSUSBLOG_RELEASE_RESOURCE_CONTAINER_ID: containerId,
            FSUSBLOG_RELEASE_RESOURCE_PID: '4242'
        },
        spawnProcess: () => ({
            status: 0,
            stdout: JSON.stringify([{
                Id: containerId,
                State: { Running: true, Pid: 5252 }
            }]),
            stderr: ''
        })
    });
    assert.equal(target.status, 'missing');
    assert.match(target.reason, /verified host PID/u);
});
