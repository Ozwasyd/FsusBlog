import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { identity, sha256 } = await import(new URL('../../tools/operations/local-task-plan.mjs', import.meta.url));
const { holdImageCustody, inspectAncestry, readOnlyBlockArguments, runObserved, requireParentClosure, expectedChildClosure, main: carrierMain } = await import(new URL('../../tools/operations/recover-failed-run-carrier.mjs', import.meta.url));
const { buildCaptures, buildSshArguments, quoteShell } = await import(new URL('../../tools/operations/export-failed-run-evidence.mjs', import.meta.url));
const { buildOriginalCall, validateInputMounts } = await import(new URL('../../tools/operations/guest-preparation-caller.mjs', import.meta.url));

const repo = fileURLToPath(new URL('../..', import.meta.url));
const tempParent = process.env.FSUSBLOG_OPERATIONS_FIXTURE_ROOT ?? os.tmpdir();
if (!tempParent || !path.isAbsolute(tempParent) || !fs.statSync(tempParent).isDirectory())
{
    throw new Error('explicit owned fixture parent required');
}
const root = fs.mkdtempSync(path.join(tempParent, 'carrier-controls-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
function image(name, backing = null, parent = null)
{
    const file = path.join(root, `${name}.qcow2`);
    const bytes = Buffer.alloc(256);
    bytes.writeUInt32BE(0x514649fb, 0);
    bytes.writeUInt32BE(3, 4);
    bytes.writeBigUInt64BE(128n, 8);
    bytes.writeUInt32BE(backing?.length ?? 0, 16);
    bytes.writeBigUInt64BE(4096n, 24);
    if (backing)
    {
        bytes.write(backing, 128);
    }
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    return { name, file, sha256: sha256(bytes), identity: identity(fs.statSync(file, { bigint: true })), backing, parent };
}

function currentFixtureClosure(images, inputs, aliases, directories, boot, shares = [])
{
    const records = inputs.map(item => ({ ...item, identity: identity(fs.statSync(item.file, { bigint: true })) }));
    return {
        images: images.map(item => ({ ...item, virtualSize: '4096' })),
        seed: records.find(item => item.file === boot.seed),
        toolchain: {
            inputs: records.filter(item => item.file !== boot.seed),
            aliases: aliases.map(item => ({ ...item, resolved: fs.realpathSync(item.file) })),
            directories: directories.map(file => ({ file, identity: identity(fs.statSync(file, { bigint: true })) })),
            bootFiles: Object.fromEntries(['qemuImg', 'qemuSystem', 'firmware', 'firmwareDirectory', 'libraryDirectory', 'moduleDirectory'].map(key => [key, boot[key]]))
        },
        shares
    };
}
function failedReceipt(closure, changes = {})
{
    return {
        schema: 'fsusblog.failed-run-carrier.v2', mode: 'inspect', planSha256: 'a'.repeat(64), runRoot: null,
        beforeClosure: structuredClone(closure), afterClosure: structuredClone(closure),
        parentActualPath: null, parentActualSha: null, recoveryImage: null, ancestry: [], afterAncestry: [], executions: [], signals: [], descriptorCloseErrors: [], procCensusUnknown: [], childTerminal: true, wholeProcessTreeZero: 'UNKNOWN', cleanupObligation: null, resourceGeometry: {},
        firstFailure: { message: 'controlled original failure', resourceObservation: null, verificationFailure: null }, originalCliTerminal: 'UNKNOWN', failedCheckpointResume: false, autoSdkExecution: false, guestCommandsObservedByLauncher: false, partialPreparationQualified: false, qualificationEligible: false, custodyScope: 'Controlled fixture only', ...changes
    };
}
function simpleClosure()
{
    const fixture = fs.mkdtempSync(path.join(root, 'closure-'));
    const base = image(`base-${path.basename(fixture).toLowerCase()}`);
    const boot = {};
    const inputs = ['qemuImg', 'qemuSystem', 'seed', 'firmware'].map(key => {
        const file = path.join(fixture, key);
        fs.writeFileSync(file, key);
        boot[key] = file;
        return { file, sha256: sha256(fs.readFileSync(file)) };
    });
    const dirs = ['firmwareDirectory', 'libraryDirectory', 'moduleDirectory'].map(key => {
        const file = path.join(fixture, key);
        fs.mkdirSync(file);
        boot[key] = file;
        return file;
    });
    return currentFixtureClosure([base], inputs, [], dirs, boot);
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
    const receipt = failedReceipt(simpleClosure());
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

test('original caller SIGINT reaches the owned child and primary signal failure is retained', async () => {
    const runRoot = fs.mkdtempSync(path.join(root, 'operator-signal-'));
    const executions = [];
    const signals = [];
    await assert.rejects(runObserved(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { runRoot, env: {}, limits: { logBytes: 128, deadlineMs: 3000, killGraceMs: 1000, pollIntervalMs: 10 }, executions, signals, onSpawn() { setTimeout(() => process.emit('SIGINT'), 100); } }), /caller SIGINT/);
    assert.equal(executions.length, 1);
    assert.equal(executions[0].terminal, true);
    assert.equal(executions[0].signal, 'SIGINT');
    assert.ok(signals.includes('SIGINT'));
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

test('original caller builds one original owner argv with current explicit guest environment', () =>
{
    const plan = { runId: 'owned-run', source: { repository: '/task/source', head: 'a'.repeat(40), tree: 'b'.repeat(40), filesystem: 'ext4' }, tool: { node: '/task/node', nodeSha256: 'c'.repeat(64), moduleSha256: 'd'.repeat(64), sdk: '/task/sdk', feed: '/task/feed', feedDigest: 'e'.repeat(64) }, guest: { uid: 1234, gid: 5678, user: 'guest', home: '/guest', runtimeDirectory: '/run/user/1234', userBus: '/run/user/1234/bus' }, limits: { logBytes: 128, deadlineMs: 3000, killGraceMs: 50, pollIntervalMs: 10 } };
    const call = buildOriginalCall(plan);
    assert.equal(call.args[0], '/task/source/tools/docs/prepare-behavior-doc-nuget.mjs');
    assert.equal(call.env.HOME, '/guest');
    assert.equal(call.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1234/bus');
    assert.deepEqual(call.args.slice(1), ['--run-id', 'owned-run', '--out', '/task/source/.tmp/behavior-doc-nuget-preparation/owned-run.json', '--feed-root', '/task/feed', '--feed-digest', 'e'.repeat(64)]);
    const matrix = buildOriginalCall({ ...plan, tool: { ...plan.tool, purpose: 'matrix-native' } });
    assert.deepEqual(matrix.args.slice(-2), ['--purpose', 'matrix-native']);
    assert.equal(matrix.env.FSUSBLOG_CONTENT_FIELD_DOTNET, '/task/sdk/dotnet');
    assert.throws(() => buildOriginalCall({ ...plan, tool: { ...plan.tool, purpose: 'foreign' } }), /Unknown/u);
});

test('carrier default inspect holds current closure without any execution or disk effects; helper drift refuses', async () =>
{
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
    const source = path.join(repo, 'tools/operations/recover-failed-run-carrier.mjs');
    const helper = path.join(repo, 'tools/operations/local-task-plan.mjs');
    const plan = { schema: 'fsusblog.local-task-plan.v1', taskRoot: fixture, taskLock, sourceSha256: sha256(fs.readFileSync(source)), sourceInputs: [{ file: helper, sha256: sha256(fs.readFileSync(helper)) }], images: [base], inputs, toolchainAliases: aliases, shares: [], ancestry: [{ file: receipt, sha256: '0'.repeat(64), parentSha256: null }], boot: { qemuImg: inputs[0].file, qemuSystem: inputs[1].file, seed: inputs[2].file, firmware: inputs[3].file, firmwareDirectory: dirs[0], libraryDirectory: dirs[1], moduleDirectory: dirs[2], guestMemoryMiB: 1, cpus: 1, recoveryPort: 12345 }, limits: { minMemoryBytes: 1, minDiskBytes: 1, headroomBytes: 1, cowBytes: 1, logBytes: 128, deadlineMs: 1000, bootReserveBytes: 1, killGraceMs: 50, pollIntervalMs: 10 } };
    fs.writeFileSync(receipt, JSON.stringify(failedReceipt(currentFixtureClosure(plan.images, inputs, aliases, dirs, plan.boot))));
    plan.ancestry[0].sha256 = sha256(fs.readFileSync(receipt));
    const planFile = path.join(fixture, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify(plan));
    const before = fs.readdirSync(fixture).sort();
    const originalLog = console.log;
    const messages = [];
    console.log = value => messages.push(JSON.parse(value));
    try
    {
        assert.equal(await carrierMain(['--plan', planFile, '--plan-sha256', sha256(fs.readFileSync(planFile))]), 0);
        assert.deepEqual(messages[0].executions, []);
        assert.equal(messages[0].runRoot, null);
        assert.deepEqual(fs.readdirSync(fixture).sort(), before);
        const originalOpen = fs.openSync;
        fs.openSync = (file, flags, ...rest) =>
        {
            if (file === plan.boot.seed && flags === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW))
            {
                throw new Error('controlled seed custody failure');
            }
            return originalOpen(file, flags, ...rest);
        };
        try
        {
            assert.equal(await carrierMain(['--plan', planFile, '--plan-sha256', sha256(fs.readFileSync(planFile))]), 1);
        }
        finally
        {
            fs.openSync = originalOpen;
        }
        const produced = messages.at(-1);
        assert.equal(produced.firstFailure.message, 'controlled seed custody failure');
        assert.equal(produced.schema, 'fsusblog.failed-run-carrier.v2');
        const producedFile = path.join(fixture, 'producer-failed.json');
        fs.writeFileSync(producedFile, JSON.stringify(produced));
        const consumed = inspectAncestry([...plan.ancestry, { file: producedFile, sha256: sha256(fs.readFileSync(producedFile)), parentSha256: plan.ancestry[0].sha256 }], fixture);
        requireParentClosure(consumed, produced.afterClosure, fixture);
        const goodParent = JSON.parse(fs.readFileSync(receipt));
        for (const altered of [
            value =>
            {
                value.beforeClosure.images = [];
                value.afterClosure.images = [];
            },
            value =>
            {
                value.beforeClosure.seed.sha256 = 'f'.repeat(64);
                value.afterClosure.seed.sha256 = 'f'.repeat(64);
            },
            value =>
            {
                value.beforeClosure.toolchain.inputs[0].sha256 = 'f'.repeat(64);
                value.afterClosure.toolchain.inputs[0].sha256 = 'f'.repeat(64);
            }
        ])
        {
            const substituted = structuredClone(goodParent);
            altered(substituted);
            fs.writeFileSync(receipt, JSON.stringify(substituted));
            plan.ancestry[0].sha256 = sha256(fs.readFileSync(receipt));
            fs.writeFileSync(planFile, JSON.stringify(plan));
            assert.equal(await carrierMain(['--plan', planFile, '--plan-sha256', sha256(fs.readFileSync(planFile))]), 1);
            assert.deepEqual(messages.at(-1).executions, []);
            assert.equal(messages.at(-1).runRoot, null);
        }
        fs.writeFileSync(receipt, JSON.stringify(goodParent));
        plan.ancestry[0].sha256 = sha256(fs.readFileSync(receipt));
        plan.sourceInputs[0].sha256 = '0'.repeat(64);
        fs.writeFileSync(planFile, JSON.stringify(plan));
        await assert.rejects(carrierMain(['--plan', planFile, '--plan-sha256', sha256(fs.readFileSync(planFile))]), /source helper SHA drift/);
    }
    finally
    {
        console.log = originalLog;
    }
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


test('failed parent binds current seed/toolchain/share/image closure and only its exact output overlay may extend it', () => {
    const closure = simpleClosure();
    const actual = failedReceipt(closure);
    const ancestry = [{ actual }];
    requireParentClosure(ancestry, closure, root);
    for (const mutate of [
        value => { value.seed.sha256 = '0'.repeat(64); },
        value => { value.toolchain.inputs[0].sha256 = '0'.repeat(64); },
        value => { value.images[0].sha256 = '0'.repeat(64); },
        value => { value.toolchain.aliases = [{ file: path.join(root, 'alias'), target: 'x', resolved: value.toolchain.inputs[0].file, identity: value.toolchain.inputs[0].identity }]; },
        value => { value.shares.push({ tag: 'unrelated', directory: path.join(root, 'unrelated-share'), identity: value.seed.identity }); }
    ]) {
        const current = structuredClone(closure);
        mutate(current);
        assert.throws(() => requireParentClosure(ancestry, current, root), /parent actual closure/);
    }
    const outputRoot = fs.mkdtempSync(path.join(root, 'failed-output-'));
    const overlay = image('exact-recovery-output', closure.images[0].file, closure.images[0].name);
    const file = path.join(outputRoot, 'overlay.qcow2');
    fs.renameSync(overlay.file, file);
    actual.runRoot = outputRoot;
    actual.recoveryImage = { ...overlay, file, identity: identity(fs.statSync(file, { bigint: true })), virtualSize: '4096' };
    const current = expectedChildClosure(actual, root);
    requireParentClosure(ancestry, current, root);
    const first = path.join(root, 'canonical-first.json');
    fs.writeFileSync(first, JSON.stringify(actual));
    const firstSha = sha256(fs.readFileSync(first));
    const second = path.join(root, 'canonical-second.json');
    fs.writeFileSync(second, JSON.stringify(failedReceipt(current, { parentActualPath: first, parentActualSha: firstSha })));
    const roster = [{ file: first, sha256: firstSha, parentSha256: null }, { file: second, sha256: sha256(fs.readFileSync(second)), parentSha256: firstSha }];
    const consumed = inspectAncestry(roster, root);
    requireParentClosure(consumed, current, root);
    actual.recoveryImage.file = path.join(root, 'unrelated-overlay.qcow2');
    assert.throws(() => expectedChildClosure(actual, root), /parent-owned recovery overlay/);
    const omitted = failedReceipt(current);
    delete omitted.afterClosure.toolchain;
    fs.writeFileSync(second, JSON.stringify(omitted));
    assert.throws(() => inspectAncestry([{ file: second, sha256: sha256(fs.readFileSync(second)), parentSha256: null }], root), /closed carrier/);
});

test('guest readonly mount coverage requires exactly the selected SDK and feed without substitution or duplicates', () => {
    const plan = { tool: { sdk: '/owned/sdk', feed: '/owned/feed' }, mounts: [{ directory: '/owned/sdk', source: 'sdk-source', type: '9p' }, { directory: '/owned/feed', source: 'feed-source', type: '9p' }] };
    validateInputMounts(plan);
    for (const mounts of [[], [plan.mounts[0]], [plan.mounts[0], plan.mounts[0]], [plan.mounts[0], { ...plan.mounts[1], directory: '/owned/unrelated' }], [...plan.mounts, { directory: '/owned/unrelated', source: 'other', type: '9p' }]]) {
        assert.throws(() => validateInputMounts({ ...plan, mounts }), /SDK\/feed/);
    }
});
