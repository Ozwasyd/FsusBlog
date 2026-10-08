import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';

const {runProcess} = await import(new URL('../../tools/test-fixtures/producers/spawn-helper.mjs', import.meta.url));

function isAlive(pid)
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

async function ownedChild(callback, {ignoreTerm = true} = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-spawn-helper-'));
    const pidFile = path.join(root, 'child.pid');
    const script = path.join(root, 'child.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs';
process.on('SIGTERM', () => ${ignoreTerm ? '{}' : 'process.exit(0)'});
fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`);
    let pid = null;
    const ready = async () =>
    {
        const deadline = performance.now() + 5000;
        while (!fs.existsSync(pidFile))
        {
            assert.ok(performance.now() < deadline, 'task-owned child readiness deadline');
            await delay(10);
        }
        pid = Number(fs.readFileSync(pidFile, 'utf8'));
        return pid;
    };
    try
    {
        await callback({script, pidFile, ready});
    }
    finally
    {
        pid ??= fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null;
        if (pid && isAlive(pid))
        {
            process.kill(pid, 'SIGKILL');
        }
        const deadline = performance.now() + 5000;
        while (pid && isAlive(pid))
        {
            assert.ok(performance.now() < deadline, 'task-owned child cleanup deadline');
            await delay(10);
        }
        fs.rmSync(root, {recursive: true});
    }
}

test('successful child preserves exact code stdout and stderr', async () =>
{
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("out");process.stderr.write("err")']);
    assert.deepEqual(result, {code: 0, stdout: 'out', stderr: 'err'});
});

test('ordinary nonzero exit preserves its error diagnostics', async () =>
{
    await assert.rejects(runProcess(process.execPath, ['-e', 'process.stderr.write("ordinary-error");process.exit(7)']),
        /producer process failed \(code=7\).*ordinary-error/su);
});

test('spawn failure preserves the ordinary ENOENT error', async () =>
{
    const missing = path.join(os.tmpdir(), `fixture-missing-command-${process.pid}`);
    await assert.rejects(runProcess(missing, []), {code: 'ENOENT'});
});

test('already aborted input refuses before creating any child marker', async () =>
{
    const controller = new AbortController();
    const reason = new Error('already-aborted');
    controller.abort(reason);
    await ownedChild(async ({script, pidFile}) =>
    {
        await assert.rejects(runProcess(process.execPath, [script, pidFile], {signal: controller.signal}),
            (error) => error === reason);
        assert.equal(fs.existsSync(pidFile), false);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
});

test('abort counterexample waits for actual child close after repeated abort and escalation', async () =>
{
    await ownedChild(async ({script, pidFile, ready}) =>
    {
        const controller = new AbortController();
        const reason = new Error('original-abort');
        const result = runProcess(process.execPath, [script, pidFile], {signal: controller.signal, timeoutMs: 5000})
            .then(() => null, (error) => error);
        const pid = await ready();
        controller.abort(reason);
        controller.abort(new Error('repeated-abort'));
        assert.equal(await result, reason);
        assert.equal(isAlive(pid), false, 'promise settlement must follow the owned child terminal observation');
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
});

test('graceful child close still preserves the original abort reason', async () =>
{
    await ownedChild(async ({script, pidFile, ready}) =>
    {
        const controller = new AbortController();
        const reason = new Error('graceful-abort');
        const result = runProcess(process.execPath, [script, pidFile], {signal: controller.signal})
            .then(() => null, (error) => error);
        const pid = await ready();
        controller.abort(reason);
        assert.equal(await result, reason);
        assert.equal(isAlive(pid), false);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }, {ignoreTerm: false});
});

test('timeout waits for actual terminal and keeps its existing error contract', async () =>
{
    await ownedChild(async ({script, pidFile, ready}) =>
    {
        const result = runProcess(process.execPath, [script, pidFile], {timeoutMs: 1000})
            .then(() => null, (error) => error);
        const pid = await ready();
        assert.match((await result).message, /producer process timed out after 1000ms:/u);
        assert.equal(isAlive(pid), false);
    });
});

test('abort after an already exited child leaves success and the next child intact', async () =>
{
    const controller = new AbortController();
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("first")'], {signal: controller.signal});
    controller.abort(new Error('after-exit'));
    assert.deepEqual(result, {code: 0, stdout: 'first', stderr: ''});
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.deepEqual(await runProcess(process.execPath, ['-e', 'process.stdout.write("next")']),
        {code: 0, stdout: 'next', stderr: ''});
});

test('non-Error abort reason retains the existing generic aborted error', async () =>
{
    await ownedChild(async ({script, pidFile, ready}) =>
    {
        const controller = new AbortController();
        const result = runProcess(process.execPath, [script, pidFile], {signal: controller.signal})
            .then(() => null, (error) => error);
        const pid = await ready();
        controller.abort('plain-reason');
        assert.equal((await result).message, 'aborted');
        assert.equal(isAlive(pid), false);
    }, {ignoreTerm: false});
});
