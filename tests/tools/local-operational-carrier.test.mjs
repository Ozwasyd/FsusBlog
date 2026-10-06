import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { identity, sha256 } from '../../tools/operations/local-task-plan.mjs';
import { holdImageCustody, inspectAncestry, readOnlyBlockArguments, runObserved, main as carrierMain } from '../../tools/operations/recover-failed-run-carrier.mjs';
import { buildCaptures, buildSshArguments, quoteShell } from '../../tools/operations/export-failed-run-evidence.mjs';
import { buildOriginalCall } from '../../tools/operations/guest-preparation-caller.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const tempParent = process.env.FSUSBLOG_OPERATIONS_FIXTURE_ROOT ?? os.tmpdir();
if (!tempParent || !path.isAbsolute(tempParent) || !fs.statSync(tempParent).isDirectory()) throw new Error('explicit owned fixture parent required');
const root = fs.mkdtempSync(path.join(tempParent, 'carrier-controls-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
function image(name, backing = null, parent = null) {
    const file = path.join(root, `${name}.qcow2`);
    const bytes = Buffer.alloc(256);
    bytes.writeUInt32BE(0x514649fb, 0);
    bytes.writeUInt32BE(3, 4);
    bytes.writeBigUInt64BE(128n, 8);
    bytes.writeUInt32BE(backing?.length ?? 0, 16);
    bytes.writeBigUInt64BE(4096n, 24);
    if (backing) bytes.write(backing, 128);
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    return { name, file, sha256: sha256(bytes), identity: identity(fs.statSync(file, { bigint: true })), backing, parent };
}

test('held image custody preserves ordered backing graph, raw SHA and physical epochs', () => {
    const base = image('base');
    const images = [base, image('failed', base.file, 'base')];
    const custody = holdImageCustody(images, root);
    try {
        const args = readOnlyBlockArguments(custody.held);
        const blocks = args.filter((_, index) => index % 2 === 1).map(JSON.parse);
        assert.ok(blocks.every(block => block['read-only']));
        assert.equal(blocks.at(-1).backing, 'base');
        custody.seal();
        fs.writeFileSync(images[1].file, Buffer.alloc(256));
        assert.throws(custody.verify, /epoch drift/);
    } finally { custody.close(); }
});

test('QCOW invalid header, pending incompatible feature and wrong ancestry refuse', () => {
    const clean = image('ancestry-base');
    const broken = image('broken', clean.file, 'ancestry-base');
    broken.backing = 'unexpected';
    assert.throws(() => holdImageCustody([clean, broken], root), /ancestry mismatch/);
    const forged = image('forged', '/proc/self/fd/3', 'ancestry-base');
    assert.throws(() => holdImageCustody([clean, forged], root), /physical backing parent/);
    const dirty = image('dirty');
    const bytes = fs.readFileSync(dirty.file);
    bytes.writeBigUInt64BE(1n, 72);
    fs.writeFileSync(dirty.file, bytes);
    dirty.identity = identity(fs.statSync(dirty.file, { bigint: true }));
    dirty.sha256 = sha256(bytes);
    assert.throws(() => holdImageCustody([dirty], root), /clean header/);
});

test('exact failed receipt ancestry refuses resume, unbound parent and absent closure', () => {
    const file = path.join(root, 'parent.json');
    const receipt = { childTerminal: true, failedCheckpointResume: false, beforeImages: [], afterImages: [], beforeSeed: {}, afterSeed: {}, beforeShares: [], afterShares: [], beforeToolchain: {}, afterToolchain: {}, firstFailure: { message: 'fixture failure' } };
    fs.writeFileSync(file, JSON.stringify(receipt));
    const item = { file, sha256: sha256(fs.readFileSync(file)), parentSha256: null };
    assert.equal(inspectAncestry([item], root)[0].originalCliTerminal, 'UNKNOWN');
    assert.throws(() => inspectAncestry([{ ...item, parentSha256: 'a'.repeat(64) }], root), /ancestry SHA/);
    receipt.failedCheckpointResume = true;
    fs.writeFileSync(file, JSON.stringify(receipt));
    assert.throws(() => inspectAncestry([{ ...item, sha256: sha256(fs.readFileSync(file)) }], root), /terminal refusal/);
});

test('raw argv/status are retained and bounded stdout causes owned child terminal cleanup', async () => {
    const runRoot = fs.mkdtempSync(path.join(root, 'raw-'));
    const executions = [];
    const signals = [];
    await assert.rejects(runObserved(process.execPath, ['-e', "process.stdout.write(Buffer.alloc(4096)); setInterval(()=>{},1000)"], { runRoot, env: {}, limits: { logBytes: 128, deadlineMs: 3000, killGraceMs: 50, pollIntervalMs: 10 }, executions, signals }), /raw log byte bound/);
    assert.equal(executions.length, 1);
    assert.equal(executions[0].terminal, true);
    assert.equal(fs.statSync(executions[0].logs.stdout).size, 128);
    assert.ok(signals.includes('SIGTERM'));
    assert.throws(() => process.kill(executions[0].pid, 0), { code: 'ESRCH' });
});

test('original singlecall child nonzero and callback failure remain observable', async () => {
    const runRoot = fs.mkdtempSync(path.join(root, 'terminal-'));
    const executions = [];
    await assert.rejects(runObserved(process.execPath, ['-e', 'process.exit(7)'], { runRoot, env: {}, limits: { logBytes: 128, deadlineMs: 3000, killGraceMs: 50, pollIntervalMs: 10 }, executions, signals: [] }), /terminal 7/);
    assert.equal(executions[0].status, 7);
    const callbackExecutions = [];
    const callbackRoot = fs.mkdtempSync(path.join(root, 'callback-'));
    await assert.rejects(runObserved(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { runRoot: callbackRoot, env: {}, limits: { logBytes: 128, deadlineMs: 3000, killGraceMs: 50, pollIntervalMs: 10 }, executions: callbackExecutions, signals: [], onSpawn() { throw new Error('identity fixture failure'); } }), /identity fixture failure/);
    assert.equal(callbackExecutions[0].terminal, true);
});

test('read-only exporter retains old-boot raw/log/descriptor scopes and rejects arbitrary modes', () => {
    const guest = { taskRoot: '/task/guest', runId: 'current-run', bootId: 'a'.repeat(32), uid: 1234, head: 'b'.repeat(40), tree: 'c'.repeat(40) };
    const captures = buildCaptures(guest);
    assert.equal(captures.length, 8);
    assert.ok(captures.some(item => item.command.includes('_UID=1234')));
    assert.ok(captures.some(item => item.name === 'physical-records.tar'));
    assert.ok(captures.some(item => item.name === 'original-descriptor-and-raw-status'));
    assert.equal(quoteShell("a'b"), "'a'\\''b'");
    assert.throws(() => buildCaptures({ ...guest, runId: 'run; touch injected' }), /identity/);
    assert.throws(() => buildSshArguments({ executable: '/ssh', sha256: '', identityFile: '/key', identitySha256: '', knownHostsFile: '/known', knownHostsSha256: '', host: 'example.org', port: 22, user: 'guest', hostKeyAlias: 'guest' }), /local carrier/);
    const result = spawnSync(process.execPath, [path.join(repo, 'tools/operations/export-failed-run-evidence.mjs'), '--mode', 'execute'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
});

test('original caller builds one original owner argv with current explicit guest environment', () => {
    const plan = { runId: 'owned-run', source: { repository: '/task/source', head: 'a'.repeat(40), tree: 'b'.repeat(40), filesystem: 'ext4' }, tool: { node: '/task/node', nodeSha256: 'c'.repeat(64), moduleSha256: 'd'.repeat(64), sdk: '/task/sdk', feed: '/task/feed', feedDigest: 'e'.repeat(64) }, guest: { uid: 1234, gid: 5678, user: 'guest', home: '/guest', runtimeDirectory: '/run/user/1234', userBus: '/run/user/1234/bus' }, limits: { logBytes: 128, deadlineMs: 3000, killGraceMs: 50, pollIntervalMs: 10 } };
    const call = buildOriginalCall(plan);
    assert.equal(call.args[0], '/task/source/tools/docs/prepare-behavior-doc-nuget.mjs');
    assert.equal(call.env.HOME, '/guest');
    assert.equal(call.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1234/bus');
    assert.deepEqual(call.args.slice(1), ['--run-id', 'owned-run', '--out', '/task/source/.tmp/behavior-doc-nuget-preparation/owned-run.json', '--feed-root', '/task/feed', '--feed-digest', 'e'.repeat(64)]);
});

test('carrier default inspect holds current closure without any execution or disk effects; helper drift refuses', async () => {
    const fixture = fs.mkdtempSync(path.join(root, 'inspect-'));
    const move = item => {
        const file = path.join(fixture, path.basename(item.file));
        fs.renameSync(item.file, file);
        return { ...item, file, identity: identity(fs.statSync(file, { bigint: true })) };
    };
    const base = move(image('inspect-base'));
    const toolNames = ['qemu-img', 'qemu-system', 'seed', 'firmware'];
    const inputs = toolNames.map(name => {
        const file = path.join(fixture, name);
        fs.writeFileSync(file, name);
        return { file, sha256: sha256(fs.readFileSync(file)) };
    });
    const dirs = ['firmware-dir', 'library-dir', 'module-dir'].map(name => { const dir = path.join(fixture, name); fs.mkdirSync(dir); return dir; });
    const libraryFile = path.join(dirs[1], 'library.bin');
    fs.writeFileSync(libraryFile, 'owned-library');
    inputs.push({ file: libraryFile, sha256: sha256(fs.readFileSync(libraryFile)) });
    const aliasFile = path.join(dirs[1], 'library.so');
    fs.symlinkSync('library.bin', aliasFile);
    const aliases = [{ file: aliasFile, target: 'library.bin', identity: identity(fs.lstatSync(aliasFile, { bigint: true })) }];
    const taskLock = path.join(fixture, 'task.lock');
    fs.writeFileSync(taskLock, '');
    const receipt = path.join(fixture, 'failed-parent.json');
    fs.writeFileSync(receipt, JSON.stringify({ childTerminal: true, firstFailure: { message: 'controlled' }, beforeImages: [], afterImages: [], beforeSeed: {}, afterSeed: {}, beforeShares: [], afterShares: [], beforeToolchain: {}, afterToolchain: {} }));
    const source = path.join(repo, 'tools/operations/recover-failed-run-carrier.mjs');
    const helper = path.join(repo, 'tools/operations/local-task-plan.mjs');
    const plan = { schema: 'fsusblog.local-task-plan.v1', taskRoot: fixture, taskLock, sourceSha256: sha256(fs.readFileSync(source)), sourceInputs: [{ file: helper, sha256: sha256(fs.readFileSync(helper)) }], images: [base], inputs, toolchainAliases: aliases, shares: [], ancestry: [{ file: receipt, sha256: sha256(fs.readFileSync(receipt)), parentSha256: null }], boot: { qemuImg: inputs[0].file, qemuSystem: inputs[1].file, seed: inputs[2].file, firmware: inputs[3].file, firmwareDirectory: dirs[0], libraryDirectory: dirs[1], moduleDirectory: dirs[2], guestMemoryMiB: 1, cpus: 1, recoveryPort: 12345 }, limits: { minMemoryBytes: 1, minDiskBytes: 1, headroomBytes: 1, cowBytes: 1, logBytes: 128, deadlineMs: 1000, bootReserveBytes: 1, killGraceMs: 50, pollIntervalMs: 10 } };
    const planFile = path.join(fixture, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify(plan));
    const before = fs.readdirSync(fixture).sort();
    const originalLog = console.log;
    const messages = [];
    console.log = value => messages.push(JSON.parse(value));
    try {
        assert.equal(await carrierMain(['--plan', planFile, '--plan-sha256', sha256(fs.readFileSync(planFile))]), 0);
        assert.deepEqual(messages[0].executions, []);
        assert.equal(messages[0].runRoot, null);
        assert.deepEqual(fs.readdirSync(fixture).sort(), before);
        plan.sourceInputs[0].sha256 = '0'.repeat(64);
        fs.writeFileSync(planFile, JSON.stringify(plan));
        await assert.rejects(carrierMain(['--plan', planFile, '--plan-sha256', sha256(fs.readFileSync(planFile))]), /source helper SHA drift/);
    } finally { console.log = originalLog; }
});

test('exclusive raw log setup refuses an existing symlink and closes earlier descriptor', async () => {
    const runRoot = fs.mkdtempSync(path.join(root, 'log-alias-'));
    const protectedFile = path.join(runRoot, 'protected');
    fs.writeFileSync(protectedFile, 'unchanged');
    fs.symlinkSync(protectedFile, path.join(runRoot, 'execution-0-stderr.log'));
    const beforeFds = fs.readdirSync('/proc/self/fd').length;
    const executions = [];
    await assert.rejects(runObserved(process.execPath, ['-e', 'process.exit(0)'], { runRoot, env: {}, limits: { logBytes: 128, deadlineMs: 1000, killGraceMs: 50, pollIntervalMs: 10 }, executions, signals: [] }), /exist/);
    assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'unchanged');
    assert.equal(executions.length, 0);
    assert.equal(fs.readdirSync('/proc/self/fd').length, beforeFds);
});
