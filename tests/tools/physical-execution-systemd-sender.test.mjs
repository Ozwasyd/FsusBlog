import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { verifySystemdSenderTerminal } = await import(new URL('../../tools/test/physical-execution-systemd-sender.mjs', import.meta.url));

const senderFile = fileURLToPath(new URL('../../tools/test/physical-execution-systemd-sender.mjs', import.meta.url));

function waitForFile(file, timeoutMs = 10000)
{
    return new Promise((resolve, reject) =>
    {
        const deadline = Date.now() + timeoutMs;
        const inspect = () =>
        {
            if (fs.existsSync(file))
            {
                resolve();
            }
            else if (Date.now() >= deadline)
            {
                reject(new Error(`sender file was not written: ${file}`));
            }
            else
            {
                setTimeout(inspect, 10);
            }
        };
        inspect();
    });
}

async function senderFixture(t, { release })
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-sender-'));
    const submitted = path.join(root, 'submitted');
    const authorityId = randomUUID();
    fs.symlinkSync(process.execPath, path.join(root, 'systemd-run'));
    const command = `require('node:fs').writeFileSync(${JSON.stringify(submitted)}, 'submitted'); setTimeout(() => {}, 200)`;
    const plan = { authorityId, args: ['-e', command], cwd: root };
    fs.writeFileSync(path.join(root, 'sender-plan.json'), `${JSON.stringify(plan)}\n`, { mode: 0o600 });
    const child = spawn(process.execPath, [senderFile, root], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? '/usr/bin:/bin'}` }
    });
    let diagnostics = '';
    child.stderr.on('data', (chunk) => diagnostics += chunk.toString());
    const ready = new Promise((resolve, reject) =>
    {
        child.once('message', resolve);
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`sender exited before ready: ${code} ${diagnostics}`)));
    });
    const terminal = new Promise((resolve, reject) =>
    {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    t.after(async () =>
    {
        if (child.exitCode === null && child.signalCode === null)
        {
            child.kill('SIGKILL');
        }
        await terminal;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const handshake = await ready;
    assert.equal(handshake.authorityId, authorityId);
    assert.equal(handshake.processIdentity.pid, child.pid);
    if (release)
    {
        child.send({ type: 'release', authorityId, planDigest: handshake.planDigest });
        await waitForFile(submitted);
    }
    else
    {
        assert.equal(fs.existsSync(submitted), false, 'the sender cannot submit before the durable owner releases it');
    }
    child.disconnect();
    assert.deepEqual(await terminal, { code: 0, signal: null }, diagnostics);
    const receiptFile = path.join(root, 'sender-terminal.json');
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    assert.equal(verifySystemdSenderTerminal(receipt, handshake), true);
    assert.equal(receipt.submission, release ? 'sender-returned' : 'not-submitted');
    assert.equal(receipt.exitCode, release ? 0 : null);
    assert.equal(fs.existsSync(submitted), release);
    assert.equal(verifySystemdSenderTerminal({ ...receipt, terminalAt: '2026-09-23T00:00:00.000Z' }, handshake), false);
    assert.equal(verifySystemdSenderTerminal(receipt, { ...handshake, authorityId: randomUUID() }), false);
}

test('gated systemd sender persists signed not-submitted receipt after controller disconnect', {
    skip: process.platform !== 'linux'
}, async (t) => senderFixture(t, { release: false }));

test('released systemd sender survives controller disconnect and persists signed terminal receipt', {
    skip: process.platform !== 'linux'
}, async (t) => senderFixture(t, { release: true }));
