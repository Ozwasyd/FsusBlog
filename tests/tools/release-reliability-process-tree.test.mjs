import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
    runPhysicalExecution
} from '../../tools/test/physical-execution-process-tree.mjs';

const fastPolicy = {
    schema: 'fsusblog.physical-execution-process-policy.v1',
    gracefulTerminationMs: 80,
    forceTerminationMs: 1500,
    pipeCloseTimeoutMs: 500,
    observationIntervalMs: 10,
    zeroMemberObservations: 2,
    maximumCapturedOutputBytesPerStream: 1024 * 1024,
    unixProcessGroupRequired: true,
    linuxCgroupRequired: true,
    windowsJobObjectRequired: true
};

function temporaryRoot(name)
{
    return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-release-process-${name}-`));
}

function processExists(pid)
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch (error)
    {
        if (error.code === 'ESRCH')
        {
            return false;
        }
        throw error;
    }
}

async function waitForLog(file, marker)
{
    const deadlineAt = Date.now() + 5000;
    while (Date.now() <= deadlineAt)
    {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(marker))
        {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`log marker did not appear: ${marker}`);
}

async function runFixture({ root, command, signal = null, physicalExecution = runPhysicalExecution })
{
    const stdoutLog = path.join(root, 'producer.stdout.log');
    const stderrLog = path.join(root, 'producer.stderr.log');
    fs.writeFileSync(stdoutLog, '');
    fs.writeFileSync(stderrLog, '');
    let evidence = null;
    let error = null;
    try
    {
        evidence = await physicalExecution({
            command,
            cwd: root,
            env: process.env,
            signal,
            policy: fastPolicy,
            residualRoot: path.join(root, 'residuals'),
            stdout: {
                write(chunk)
                {
                    fs.appendFileSync(stdoutLog, chunk);
                    return true;
                }
            },
            stderr: {
                write(chunk)
                {
                    fs.appendFileSync(stderrLog, chunk);
                    return true;
                }
            }
        });
    }
    catch (caught)
    {
        error = caught instanceof Error ? caught : new Error(String(caught));
        evidence = error.physicalExecution ?? null;
    }
    return {
        error,
        physicalExecution: evidence,
        exitCode: error && Number.isInteger(error.exitCode) ? error.exitCode : error ? null : 0,
        logComplete: evidence?.logComplete ?? error === null,
        logTruncationReason: evidence?.logTruncationReason ??
            (error && evidence === null
                ? 'physical-execution-failed-before-log-closure'
                : null),
        forcedPipeClose: evidence?.forcedPipeClose ?? false
    };
}

test('Release producer leader exit with a stdout-owning grandchild is contained and cannot pass', {
    skip: process.platform !== 'linux'
}, async (context) =>
{
    const root = temporaryRoot('leader-exit');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outcome = await runFixture({
        root,
        command: [
            process.execPath,
            '-e',
            [
                "const { spawn } = require('node:child_process')",
                "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })",
                "console.log('grandchild', child.pid)",
                'child.unref()'
            ].join(';')
        ]
    });
    assert.match(outcome.error?.message ?? '', /parent exited before/u);
    assert.equal(outcome.physicalExecution.postObservation, 'zero-members');
    assert.equal(outcome.logComplete, true);
    assert.equal(outcome.logTruncationReason, null);
    assert.equal(outcome.forcedPipeClose, false);
    assert.ok(outcome.physicalExecution.lifecycle.includes('bounded-pipe-close'));
    assert.ok(outcome.physicalExecution.processInventory.some(
        (entry) => entry.role === 'descendant'
    ));
    for (const entry of outcome.physicalExecution.processInventory)
    {
        assert.equal(processExists(entry.pid), false, `PID ${entry.pid} escaped containment`);
    }
});

test('Release producer cancellation escalates TERM to KILL and seals logs after stable zero members', {
    skip: process.platform !== 'linux'
}, async (context) =>
{
    const root = temporaryRoot('term-kill');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const controller = new AbortController();
    const stdoutLog = path.join(root, 'producer.stdout.log');
    const execution = runFixture({
        root,
        signal: controller.signal,
        command: [
            process.execPath,
            '-e',
            "process.on('SIGTERM',()=>{});console.log('producer-ready');setInterval(()=>{},1000)"
        ]
    });
    await waitForLog(stdoutLog, 'producer-ready');
    controller.abort(Object.assign(new Error('Release cancellation fixture'), {
        name: 'AbortError',
        signal: 'SIGTERM'
    }));
    const outcome = await execution;
    assert.equal(outcome.error?.name, 'AbortError');
    assert.deepEqual(
        outcome.physicalExecution.termination.map((entry) => entry.phase),
        ['graceful', 'forced']
    );
    assert.equal(outcome.physicalExecution.postObservation, 'zero-members');
    assert.equal(outcome.logComplete, true);
    assert.equal(outcome.forcedPipeClose, false);
    assert.ok(outcome.physicalExecution.lifecycle.indexOf('bounded-pipe-close')
        < outcome.physicalExecution.lifecycle.indexOf('post-observe-zero-members'));
});

test('Release producer rejects unavailable Windows Job Object containment', async (context) =>
{
    const root = temporaryRoot('windows-unavailable');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outcome = await runFixture({
        root,
        command: ['cmd.exe', '/c', 'exit', '0'],
        physicalExecution: async (options) =>
        {
            return runPhysicalExecution({
                ...options,
                platform: 'win32',
                windowsJobAdapter: false
            });
        }
    });
    assert.match(outcome.error?.message ?? '', /Windows Job Object adapter is unavailable/u);
    assert.equal(outcome.exitCode, null);
    assert.equal(outcome.logComplete, false);
    assert.equal(
        outcome.logTruncationReason,
        'physical-execution-failed-before-log-closure'
    );
});
