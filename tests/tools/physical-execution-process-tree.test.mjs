import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { captureResidentServiceOutput, createPhysicalExecutionLinuxSystemdAdapter,
    prepareResidentServiceOutput } = await import(new URL("../../tools/test/physical-execution-linux-systemd-adapter.mjs", import.meta.url));
const { createPhysicalExecutionWindowsJobAdapter } = await import(new URL("../../tools/test/physical-execution-windows-job-adapter.mjs", import.meta.url));
const {
    cleanupLivePhysicalExecutionResidentArtifacts,
    createPhysicalExecutionOutputTracker,
    loadPhysicalExecutionProcessPolicy,
    physicalExecutionProcessTreeSchema,
    residentServiceTransferSchema,
    resourceServiceContainmentIsComplete,
    runPhysicalExecution,
    terminatePhysicalExecutionAuthoritySync
} = await import(new URL("../../tools/test/physical-execution-process-tree.mjs", import.meta.url));
const { collectProcessGroupOrJobIdentity, collectProcessIdentity, processGroupMemberIdentities } = await import(new URL("../../tools/test/process-identity.mjs", import.meta.url));
const { runBoundExecution } = await import(new URL("../../tools/test/run-once.mjs", import.meta.url));
const { createProductionResourceEnforcer } = await import(new URL('../../tools/test-matrix/production-resource-enforcement.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../tools/test-fixtures/receipt/canonical.mjs', import.meta.url));
const { writePrivateJson } = await import(new URL('../../tools/test-fixtures/receipt/private-io.mjs', import.meta.url));

const quiet = { write()
{} };
const fastPolicy = {
    schema: 'fsusblog.physical-execution-process-policy.v1',
    gracefulTerminationMs: 80,
    forceTerminationMs: 1500,
    pipeCloseTimeoutMs: 1500,
    observationIntervalMs: 10,
    zeroMemberObservations: 2,
    maximumCapturedOutputBytesPerStream: 1024 * 1024,
    unixProcessGroupRequired: true,
    linuxCgroupRequired: true,
    windowsJobObjectRequired: true
};

function temporaryRoot(name)
{
    return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`));
}

test('resident service output carrier binds private files and rejects live inherited writers', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const root = temporaryRoot('resident-output');
    let holder;
    t.after(async () =>
    {
        if (holder && holder.exitCode === null && holder.signalCode === null)
        {
            holder.kill('SIGKILL');
            await new Promise((resolve) => holder.once('exit', resolve));
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    const carriers = prepareResidentServiceOutput(root);
    fs.appendFileSync(carriers.files.stdout.path, 'producer-stdout');
    fs.appendFileSync(carriers.files.stderr.path, 'producer-stderr');
    const captured = await captureResidentServiceOutput(carriers, {
        readMembers: () => [process.pid], supervisorPid: process.pid,
        outputTracker: createPhysicalExecutionOutputTracker({ policy: fastPolicy,
            stdout: new PassThrough(), stderr: new PassThrough() })
    });
    assert.equal(captured.logComplete, true);
    assert.equal(captured.stdout, 'producer-stdout');
    assert.equal(captured.stderr, 'producer-stderr');
    assert.equal(captured.outputFiles.stdout.byteCount, Buffer.byteLength('producer-stdout'));
    assert.equal(captured.outputFiles.stdout.digest,
        `sha256:${createHash('sha256').update('producer-stdout').digest('hex')}`);
    await assert.rejects(() => captureResidentServiceOutput(carriers, {
        readMembers: () => [process.pid], supervisorPid: process.pid,
        outputTracker: {
            attach()
            {},
            async close()
            {
                fs.appendFileSync(carriers.files.stderr.path, '-changed');
                return { logComplete: true };
            }
        }
    }), /stderr output changed during capture/u);
    holder = spawn(process.execPath, ['-e', `const fs=require('node:fs');
        fs.openSync(${JSON.stringify(carriers.files.stdout.path)}, 'r');
        fs.writeFileSync(${JSON.stringify(path.join(root, 'holder-ready'))}, 'ready');
        setInterval(() => {}, 1000);`], { stdio: 'ignore' });
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(path.join(root, 'holder-ready')) && Date.now() < deadline)
    {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(path.join(root, 'holder-ready')), true);
    await assert.rejects(() => captureResidentServiceOutput(carriers, {
        readMembers: () => [process.pid, holder.pid], supervisorPid: process.pid,
        outputTracker: createPhysicalExecutionOutputTracker({ policy: fastPolicy,
            stdout: new PassThrough(), stderr: new PassThrough() })
    }), /retains the producer output descriptor/u);
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));
    fs.chmodSync(carriers.files.stdout.path, 0o644);
    await assert.rejects(() => captureResidentServiceOutput(carriers, {
        readMembers: () => [process.pid], supervisorPid: process.pid,
        outputTracker: createPhysicalExecutionOutputTracker({ policy: fastPolicy,
            stdout: new PassThrough(), stderr: new PassThrough() })
    }), /output carrier identity changed/u);
});

test('hardened nonblocking systemd service keeps exact resident output carriers while active', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    if (spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' }).status !== 0)
    {
        t.skip('systemd user manager is unavailable');
        return;
    }
    const root = temporaryRoot('resident-output-systemd');
    const unit = `fsusblog-handoffprobe-${randomUUID().replaceAll('-', '')}.service`;
    const carriers = prepareResidentServiceOutput(root);
    const marker = path.join(root, 'resident.json');
    const show = () => spawnSync('systemctl', ['--user', 'show', unit, '--property=LoadState',
        '--property=ActiveState', '--property=ControlGroup', '--property=MainPID'], { encoding: 'utf8' });
    t.after(() =>
    {
        spawnSync('systemctl', ['--user', 'stop', unit], { encoding: 'utf8', timeout: 5000 });
        spawnSync('systemctl', ['--user', 'reset-failed', unit], { encoding: 'utf8', timeout: 5000 });
        const deadline = Date.now() + 2000;
        let absent;
        do
        {
            absent = show().stdout.includes('LoadState=not-found');
            if (absent)
            {
                break;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        } while (Date.now() < deadline);
        assert.equal(absent, true, `preserving resident output probe root because ${unit} was not collected`);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const command = `const fs=require('node:fs'); const {spawn}=require('node:child_process');
        const child=spawn('/bin/sleep',['5'],{detached:true,stdio:'ignore'});child.unref();
        fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,childPid:child.pid}));
        process.stdout.write('resident-producer-output');setInterval(()=>{},1000);`;
    const submission = spawnSync('systemd-run', ['--user', '--quiet', '--no-block', '--collect',
        '--service-type=exec', '--property=ExitType=cgroup', '--property=KillMode=control-group',
        '--property=ProtectSystem=strict', '--property=ProtectHome=read-only', '--property=PrivateTmp=yes',
        `--property=ReadWritePaths=${root}`, `--property=StandardOutput=append:${carriers.files.stdout.path}`,
        `--property=StandardError=append:${carriers.files.stderr.path}`, `--unit=${unit}`,
        process.execPath, '-e', command], { encoding: 'utf8', timeout: 5000 });
    assert.equal(submission.status, 0, submission.stderr);
    const deadline = Date.now() + 5000;
    while ((!fs.existsSync(marker) || !fs.readFileSync(carriers.files.stdout.path, 'utf8').includes('resident-producer-output'))
        && Date.now() < deadline)
    {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(marker), true, 'the exact resident probe must become live');
    const resident = JSON.parse(fs.readFileSync(marker, 'utf8'));
    const properties = Object.fromEntries(show().stdout.trim().split('\n').map((line) => line.split(/=(.*)/su).slice(0, 2)));
    assert.equal(properties.ActiveState, 'active');
    assert.equal(Number(properties.MainPID), resident.pid);
    const readMembers = () => fs.readFileSync(path.join('/sys/fs/cgroup', properties.ControlGroup, 'cgroup.procs'), 'utf8')
        .trim().split(/\s+/u).filter(Boolean).map(Number).sort((left, right) => left - right);
    assert.ok(readMembers().includes(resident.childPid));
    const captured = await captureResidentServiceOutput(carriers, {
        readMembers, supervisorPid: resident.pid,
        outputTracker: createPhysicalExecutionOutputTracker({ policy: fastPolicy,
            stdout: new PassThrough(), stderr: new PassThrough() })
    });
    assert.equal(captured.logComplete, true);
    assert.equal(captured.stdout, 'resident-producer-output');
    assert.equal(captured.outputFiles.stdout.byteCount, Buffer.byteLength('resident-producer-output'));
});

test('resource-bound adapter captures a nonblocking service after exact zero-member cleanup', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    if (spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' }).status !== 0)
    {
        t.skip('systemd user manager is unavailable');
        return;
    }
    const root = temporaryRoot('resident-adapter-file');
    const context = { root, runId: 'resident-adapter-file', namespace: 'component',
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
        schedulerOwnerToken: randomUUID() };
    const enforcer = await createProductionResourceEnforcer({
        runId: context.runId, bundleIds: ['worker'], mode: 'strict', machine: { cpuUnits: 2, memoryGiB: 2 },
        systemdBoundary: { context, commandBudgetMs: 5000, startupBudgetMs: 5000,
            retainBinding(reference)
            {
                writePrivateJson(path.join(root, 'independent-reference.json'), reference);
                return { bindingDigest: reference.bindingDigest };
            } }
    });
    t.after(() =>
    {
        assert.equal(enforcer.cleanup().status, 'removed');
        fs.rmSync(root, { recursive: true, force: true });
    });
    enforcer.update('worker', { cpuUnits: 1, memoryGiB: 0.25 });
    const evidence = await runPhysicalExecution({ command: [process.execPath, '-e',
        "process.stdout.write('file-mode-stdout');process.stderr.write('file-mode-stderr');"],
    cwd: root, resourceBoundary: enforcer.executionBoundary('worker'),
    resourceContext: { ...context, bundleId: 'worker' }, residentServiceOutput: true,
    processOwner: { commandBudgetMs: 5000,
        retain: async (authority) => ({ authorityDigest: digestCanonical(authority) }),
        beforeCreation: async (authority, sender) => ({ authorityDigest: digestCanonical({ ...authority,
            phase: 'create-attempted', creationSender: sender }) }),
        register: async (_identity, authority) => ({ owner: { managedContainmentAuthorities: [authority] } }) },
    residualRoot: path.join(root, 'residuals'), policy: loadPhysicalExecutionProcessPolicy(),
    stdout: null, stderr: null });
    assert.equal(evidence.postObservation, 'zero-members');
    assert.equal(evidence.logComplete, true);
    assert.equal(evidence.stdout, 'file-mode-stdout');
    assert.equal(evidence.stderr, 'file-mode-stderr');
    assert.ok(evidence.lifecycle.includes('bounded-file-output-capture'));
    assert.ok(evidence.containmentAuthority.residentOutput);
    assert.equal(evidence.outputFiles.stdout.byteCount, Buffer.byteLength('file-mode-stdout'));
    const authority = evidence.containmentAuthority;
    const supervisor = { ...authority.supervisorProcessIdentity,
        pid: authority.supervisorProcessIdentity.pid + 1 };
    const resident = { ...supervisor, pid: supervisor.pid + 1,
        processStartIdentity: `${supervisor.processStartIdentity}-resident` };
    const transfer = { schema: residentServiceTransferSchema,
        serviceBindingDigest: digestCanonical(authority.serviceBinding),
        inventoryDigest: `sha256:${'a'.repeat(64)}`,
        memberIdentities: [supervisor, resident].sort((left, right) => left.pid - right.pid),
        supervisorIdentity: supervisor,
        outputFiles: evidence.outputFiles, transferredAt: new Date().toISOString() };
    assert.equal(resourceServiceContainmentIsComplete({ ...authority, phase: 'resident-transferred',
        residentTransfer: transfer }), true);
    assert.equal(resourceServiceContainmentIsComplete({ ...authority, phase: 'resident-transferred',
        residentTransfer: { ...transfer, inventoryDigest: `sha256:${'0'.repeat(64)}`,
            serviceBindingDigest: `sha256:${'0'.repeat(64)}` } }), false);
    assert.equal(resourceServiceContainmentIsComplete({ ...authority, phase: 'resident-transferred',
        residentTransfer: { ...transfer, memberIdentities: [resident, supervisor] } }), false);
    assert.equal(resourceServiceContainmentIsComplete({ ...authority, phase: 'resident-transferred',
        residentTransfer: { ...transfer, outputFiles: { ...transfer.outputFiles,
            stdout: { ...transfer.outputFiles.stdout, path: '/tmp/foreign-output' } } } }), false);
});

test('resource-bound adapter transfers a live service only after an exact owner acknowledgement', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    if (spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' }).status !== 0)
    {
        t.skip('systemd user manager is unavailable');
        return;
    }
    const root = temporaryRoot('resident-adapter-transfer');
    const context = { root, runId: 'resident-adapter-transfer', namespace: 'component',
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
        schedulerOwnerToken: randomUUID() };
    const enforcer = await createProductionResourceEnforcer({
        runId: context.runId, bundleIds: ['worker'], mode: 'strict', machine: { cpuUnits: 2, memoryGiB: 2 },
        systemdBoundary: { context, commandBudgetMs: 5000, startupBudgetMs: 5000,
            retainBinding(reference)
            {
                writePrivateJson(path.join(root, 'independent-reference.json'), reference);
                return { bindingDigest: reference.bindingDigest };
            } }
    });
    let retained = null;
    let controlRoot = null;
    t.after(() =>
    {
        if (retained)
        {
            const termination = terminatePhysicalExecutionAuthoritySync({ authority: retained,
                reason: 'test-owned-resident-transfer-cleanup' });
            assert.equal(termination.postObservation, 'zero-members', termination.reason);
        }
        const carrier = controlRoot ?? retained?.controlRoot.path;
        if (carrier)
        {
            assert.match(path.basename(carrier), /^fsusblog-physical-systemd-[A-Za-z0-9]{6}$/u);
            if (retained?.phase === 'resident-transferred')
            {
                const artifacts = cleanupLivePhysicalExecutionResidentArtifacts([retained], {
                    validateAuthority: () => ({ status: 'verified' })
                });
                assert.ok(artifacts.every((entry) => entry.status === 'absent'));
            }
            else
            {
                fs.rmSync(carrier, { recursive: true, force: true });
            }
        }
        assert.equal(enforcer.cleanup().status, 'removed');
        fs.rmSync(root, { recursive: true, force: true });
    });
    enforcer.update('worker', { cpuUnits: 1, memoryGiB: 0.25 });
    const payload = path.join(root, 'producer.mjs');
    fs.writeFileSync(payload, `import { spawn } from 'node:child_process';
        const resident = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
            { detached: true, stdio: 'ignore' });
        resident.unref();
        process.stdout.write('producer-transferred');`);
    const evidence = await runPhysicalExecution({ command: [process.execPath, payload], cwd: root,
        resourceBoundary: enforcer.executionBoundary('worker'),
        resourceContext: { ...context, bundleId: 'worker' }, residentServiceOutput: true,
        processOwner: { commandBudgetMs: 5000,
            retain: async (authority) => ({ authorityDigest: digestCanonical(authority) }),
            beforeCreation: async (authority, sender) =>
            {
                retained = { ...authority, phase: 'create-attempted', creationSender: sender };
                return { authorityDigest: digestCanonical(retained) };
            },
            register: async (_identity, authority) =>
            {
                retained = authority;
                return { owner: { managedContainmentAuthorities: [authority] } };
            },
            transfer: async (authority, captured) =>
            {
                const residentTransfer = { schema: residentServiceTransferSchema,
                    serviceBindingDigest: digestCanonical(authority.serviceBinding),
                    inventoryDigest: `sha256:${'a'.repeat(64)}`,
                    memberIdentities: captured.memberIdentities,
                    supervisorIdentity: captured.supervisorIdentity,
                    outputFiles: captured.outputFiles, transferredAt: new Date().toISOString() };
                retained = { ...authority, phase: 'resident-transferred', residentTransfer };
                assert.equal(resourceServiceContainmentIsComplete(retained), true,
                    JSON.stringify({ members: captured.memberIdentities.map((entry) => ({ pid: entry.pid,
                        schema: entry.schema, status: entry.status, start: entry.processStartIdentity })),
                    supervisor: authority.supervisorProcessIdentity.pid,
                    output: captured.outputFiles }));
                return { authorityDigest: digestCanonical(retained), residentTransfer };
            } },
        residualRoot: path.join(root, 'residuals'), policy: loadPhysicalExecutionProcessPolicy(),
        stdout: null, stderr: null });
    controlRoot = evidence.controlRoot;
    assert.equal(evidence.postObservation, 'resident-transferred');
    assert.equal(evidence.cleanup.status, 'transferred');
    assert.equal(evidence.stdout, 'producer-transferred');
    assert.equal(evidence.containmentAuthority.phase, 'resident-transferred');
    assert.equal(evidence.containmentAuthority.residentTransfer.memberIdentities.length >= 2, true);
    const termination = terminatePhysicalExecutionAuthoritySync({ authority: retained,
        reason: 'test-owned-interrupted-resident-cleanup' });
    assert.equal(termination.postObservation, 'zero-members', termination.reason);
    const originalRename = fs.renameSync;
    try
    {
        fs.renameSync = (source, target) =>
        {
            if (source === path.join(controlRoot, 'resident-cleanup-plan.json.pending'))
            {
                throw new Error('simulated resident cleanup plan interruption');
            }
            return originalRename(source, target);
        };
        assert.throws(() => cleanupLivePhysicalExecutionResidentArtifacts([retained], {
            validateAuthority: () => ({ status: 'verified' })
        }), /simulated resident cleanup plan interruption/u);
    }
    finally
    {
        fs.renameSync = originalRename;
    }
    assert.equal(fs.existsSync(path.join(controlRoot, 'resident-cleanup-plan.json.pending')), true);
    assert.equal(fs.existsSync(path.join(controlRoot, 'stderr.log')), true);
    const originalUnlink = fs.unlinkSync;
    try
    {
        fs.unlinkSync = (file) =>
        {
            originalUnlink(file);
            if (file === path.join(controlRoot, 'stderr.log'))
            {
                throw new Error('simulated resident cleanup interruption');
            }
        };
        assert.throws(() => cleanupLivePhysicalExecutionResidentArtifacts([retained], {
            validateAuthority: () => ({ status: 'verified' })
        }), /simulated resident cleanup interruption/u);
    }
    finally
    {
        fs.unlinkSync = originalUnlink;
    }
    assert.equal(fs.existsSync(path.join(controlRoot, 'stderr.log')), false);
    assert.equal(fs.existsSync(path.join(controlRoot, 'resident-cleanup-plan.json')), true);
    const foreign = path.join(controlRoot, 'foreign.txt');
    fs.writeFileSync(foreign, 'foreign', { mode: 0o600 });
    assert.throws(() => cleanupLivePhysicalExecutionResidentArtifacts([retained], {
        validateAuthority: () => ({ status: 'verified' })
    }), /exact deletion prefix/u);
    fs.unlinkSync(foreign);
    const recovered = cleanupLivePhysicalExecutionResidentArtifacts([retained], {
        validateAuthority: () => ({ status: 'verified' })
    });
    assert.ok(recovered.every((entry) => entry.status === 'absent'));
});

test('nested transport closes connected peers after owner EOF or shutdown', { skip: process.platform !== 'linux' }, async (t) =>
{
    for (const shutdown of [false, true])
    {
        await t.test(shutdown ? 'explicit shutdown' : 'owner EOF', async (subtest) =>
        {
            const root = temporaryRoot('nested-transport');
            const socketPath = path.join(root, 'owner.sock');
            const broker = spawn(process.env.FSUSBLOG_PYTHON ?? 'python3', ['-I', '-S',
                fileURLToPath(new URL('../../tools/test/physical-execution-nested-socket.py', import.meta.url)), socketPath,
                String(fastPolicy.maximumCapturedOutputBytesPerStream * 16), '10', String(fastPolicy.pipeCloseTimeoutMs / 1000)],
            { stdio: ['pipe', 'pipe', 'pipe'] });
            let diagnostics = '';
            broker.stderr.on('data', (chunk) => diagnostics += chunk.toString());
            const terminal = new Promise((resolve, reject) =>
            {
                broker.once('error', reject);
                broker.once('close', (code, signal) => resolve({ code, signal }));
            });
            let peer;
            subtest.after(async () =>
            {
                peer?.destroy();
                if (broker.exitCode === null && broker.signalCode === null)
                {
                    broker.kill('SIGKILL');
                }
                await terminal;
                fs.rmSync(root, { recursive: true, force: true });
            });
            let buffered = '';
            const observed = new EventEmitter();
            broker.stdout.on('data', (chunk) =>
            {
                buffered += chunk.toString();
                for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n'))
                {
                    const message = JSON.parse(buffered.slice(0, end));
                    buffered = buffered.slice(end + 1);
                    observed.emit(message.kind, message);
                }
            });
            const bounded = async (pending) =>
            {
                let timer;
                try
                {
                    return await Promise.race([pending, new Promise((_resolve, reject) =>
                    {
                        timer = setTimeout(() => reject(new Error(`nested transport did not settle: ${diagnostics}`)),
                            fastPolicy.forceTerminationMs + fastPolicy.pipeCloseTimeoutMs);
                    })]);
                }
                finally
                {
                    clearTimeout(timer);
                }
            };
            await bounded(new Promise((resolve) => observed.once('ready', resolve)));
            const requested = new Promise((resolve) => observed.once('request', resolve));
            peer = net.createConnection(socketPath);
            peer.on('error', (error) => diagnostics += `peer: ${error.message}`);
            peer.write(`${JSON.stringify({ kind: 'transport-fixture' })}\n`);
            await bounded(requested);
            broker.stdin.end(shutdown ? `${JSON.stringify({ kind: 'shutdown' })}\n` : '');
            assert.deepEqual(await bounded(terminal), { code: 0, signal: null }, diagnostics);
        });
    }
});

test('resource-bound execution rejects reports and unsupported process-owner paths before spawn', async () =>
{
    let spawned = false;
    const adapter = createPhysicalExecutionLinuxSystemdAdapter({
        runSystemctl: () => ({ status: 0, stdout: '', stderr: '' }),
        spawnProcess: () =>
        {
            spawned = true;
        }
    });
    await assert.rejects(() => adapter.run({ resourceBoundary: {}, command: ['/usr/bin/true'] }), /live resource-owner capability/u);
    assert.equal(spawned, false);
    await assert.rejects(() => runPhysicalExecution({
        command: ['/usr/bin/true'], resourceBoundary: {}, platform: 'darwin'
    }), /canonical Linux process owner/u);
});

test('Linux physical pre-exec admission verifies the actual shared resource ancestor and honors revocation', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    for (const revoke of [false, true])
    {
        await t.test(revoke ? 'revoked before payload release' : 'actual service and payload ancestor', async (subtest) =>
        {
            const root = temporaryRoot('physical-resource-admission');
            const context = { root, runId: 'service-admission', namespace: 'component',
                sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
                schedulerOwnerToken: randomUUID() };
            const enforcer = await createProductionResourceEnforcer({
                runId: context.runId, bundleIds: ['worker'], mode: 'strict', machine: { cpuUnits: 2, memoryGiB: 2 },
                systemdBoundary: { context, commandBudgetMs: 5000, startupBudgetMs: 5000,
                    retainBinding(reference)
                    {
                        writePrivateJson(path.join(root, 'independent-reference.json'), reference);
                        return { bindingDigest: reference.bindingDigest };
                    } }
            });
            subtest.after(() =>
            {
                assert.equal(enforcer.cleanup().status, 'removed', 'real owned resources must be proven absent before deleting fixture records');
                fs.rmSync(root, { recursive: true, force: true });
            });
            const limits = enforcer.update('worker', { cpuUnits: 1, memoryGiB: 0.25 });
            const resourceBoundary = enforcer.executionBoundary('worker');
            const marker = path.join(root, 'payload.json');
            const command = [process.execPath, '-e', `const fs = require('node:fs');
                const group = fs.readFileSync('/proc/self/cgroup', 'utf8').trim().slice(3);
                const parent = require('node:path').dirname('/sys/fs/cgroup' + group);
                const controls = Object.fromEntries(['cpu.max','cpu.weight','memory.high','memory.max','pids.max']
                    .map(name => [name, fs.readFileSync(parent + '/' + name, 'utf8').trim()]));
                fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,group,controls}));`];
            const options = { command, cwd: root, env: process.env, resourceBoundary, resourceContext: { ...context, bundleId: 'worker' },
                policy: fastPolicy, stdout: quiet, stderr: quiet, schema: physicalExecutionProcessTreeSchema };
            await assert.rejects(() => runPhysicalExecution({ ...options, cwd: path.dirname(root),
                residualRoot: path.join(root, 'residuals') }), /escapes its bound repository/u);
            const alias = path.join(root, 'cwd-alias');
            fs.symlinkSync(root, alias);
            await assert.rejects(() => runPhysicalExecution({ ...options, cwd: alias,
                residualRoot: path.join(root, 'residuals') }), /literal working directory/u);
            assert.equal(fs.existsSync(marker), false);
            if (revoke)
            {
                let revocations = 0;
                const adapter = createPhysicalExecutionLinuxSystemdAdapter({
                    readProcessGroupIdentity(pid)
                    {
                        const identity = collectProcessGroupOrJobIdentity(pid, { platform: 'linux' });
                        assert.equal(enforcer.cleanup().status, 'retained-resources');
                        revocations += 1;
                        return identity;
                    }
                });
                await assert.rejects(() => adapter.run(options), (error) =>
                {
                    assert.match(error.message, /closed|finalizing/u);
                    assert.equal(error.physicalExecution?.cleanup.status, 'verified');
                    assert.equal(error.physicalExecution?.resourceExecutionAdmission, null);
                    return true;
                });
                assert.equal(revocations, 1);
                assert.equal(fs.existsSync(marker), false, 'a revoked admission must never sign payload release');
            }
            else
            {
                const evidence = await runPhysicalExecution({ ...options, residualRoot: path.join(root, 'residuals') });
                const payload = JSON.parse(fs.readFileSync(marker, 'utf8'));
                const admitted = evidence.resourceExecutionAdmission;
                assert.equal(payload.pid, admitted.processIdentity.pid);
                assert.equal(payload.group, admitted.service.controlGroup);
                assert.equal(path.posix.dirname(payload.group), admitted.parent.controlGroup);
                assert.equal(admitted.parent.path, limits.cgroupPath);
                assert.deepEqual(payload.controls, admitted.parent.controls);
                assert.equal(payload.controls['cpu.max'], limits.cpuMax);
                assert.equal(payload.controls['memory.max'], String(limits.memoryMaxBytes));
                assert.equal(evidence.cleanup.status, 'verified');
                assert.equal(evidence.postObservation, 'zero-members');
            }
        });
    }
});

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

async function waitForProcessAbsence(pid, timeoutMs)
{
    const deadlineAt = Date.now() + timeoutMs;
    while (Date.now() <= deadlineAt)
    {
        if (!processExists(pid))
        {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return !processExists(pid);
}

function readinessSink(marker = 'ready')
{
    let output = '';
    let resolve;
    const ready = new Promise((value) =>
    {
        resolve = value;
    });
    return {
        sink: {
            write(chunk)
            {
                output += chunk.toString();
                if (output.includes(marker))
                {
                    resolve();
                }
            }
        },
        ready
    };
}

async function expectFailure(options)
{
    try
    {
        await runPhysicalExecution({
            policy: fastPolicy,
            stdout: quiet,
            stderr: quiet,
            ...options
        });
    }
    catch (error)
    {
        return error;
    }
    assert.fail('physical execution unexpectedly succeeded');
}

function createStubSystemdExecution({
    handshake = 'result',
    result = { exitCode: 0, signal: null },
    initialMembers = [],
    commandStatuses = {},
    commandTransitions = {},
    finalizeTransition = null,
    localKillTransition = null,
    dbusDisappears = false,
    showNonzeroAt = [],
    showThrowsAfter = null,
    systemctlThrows = {},
    childError = null,
    childKillError = null,
    cgroupReadErrorAt = null,
    removeRootError = null,
    onHandshake = null,
    onCommandProcessGroupObserved = null,
    callerCgroup = '0::/user.slice/parent.service\n',
    unitControlGroup = '/user.slice/fsusblog-stub.scope',
    unitSlice = 'user.slice'
} = {})
{
    const state = {
        controlRoot: null,
        unitName: null,
        spawnArgs: null,
        members: [...initialMembers],
        loadState: 'loaded',
        showCount: 0,
        cgroupReadCount: 0,
        childKillCount: 0,
        finalizeTransitionApplied: false,
        commands: []
    };
    let child;
    const emitTerminal = (exitCode = 0, signal = null) =>
    {
        if (child.exitCode !== null || child.signalCode !== null)
        {
            return;
        }
        child.exitCode = exitCode;
        child.signalCode = signal;
        child.stdout.end();
        child.stderr.end();
        child.emit('exit', exitCode, signal);
    };
    const adapter = createPhysicalExecutionLinuxSystemdAdapter({
        spawnProcess(_executable, args)
        {
            state.spawnArgs = [...args];
            state.controlRoot = args.at(-1);
            state.unitName = args.find((argument) => argument.startsWith('--unit='))
                .slice('--unit='.length);
            child = new EventEmitter();
            child.exitCode = null;
            child.signalCode = null;
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.kill = (signal) =>
            {
                state.childKillCount += 1;
                if (childKillError)
                {
                    throw childKillError;
                }
                emitTerminal(null, signal);
                if (localKillTransition?.loadState)
                {
                    state.loadState = localKillTransition.loadState;
                }
                if (localKillTransition?.members)
                {
                    state.members = [...localKillTransition.members];
                }
                return true;
            };
            queueMicrotask(() =>
            {
                if (handshake !== 'before-ready')
                {
                    fs.writeFileSync(path.join(state.controlRoot, 'ready'), '101\n');
                }
                if (handshake === 'child' || handshake === 'result')
                {
                    const admission = JSON.parse(fs.readFileSync(path.join(state.controlRoot, 'admission.json'), 'utf8'));
                    fs.writeFileSync(path.join(state.controlRoot, 'child.json'), JSON.stringify({
                        pid: 202,
                        nonce: 'a'.repeat(64),
                        authorityId: admission.authorityId,
                        command: JSON.parse(fs.readFileSync(path.join(state.controlRoot, 'command.json'), 'utf8')),
                        environmentDigest: `sha256:${createHash('sha256').update(fs.readFileSync(path.join(state.controlRoot, 'environment.json'), 'utf8').trim()).digest('hex')}`,
                        executables: [],
                        startIdentity: 'stub-202',
                        processGroup: 202,
                        cgroup: `0::${unitControlGroup}\n`
                    }));
                }
                if (handshake === 'result')
                {
                    fs.writeFileSync(path.join(state.controlRoot, 'result.json'), `${JSON.stringify(result)}\n`);
                }
                if (childError)
                {
                    child.stdout.end();
                    child.stderr.end();
                    child.emit('error', childError);
                }
                onHandshake?.({ state, child });
            });
            return child;
        },
        runSystemctl(args)
        {
            state.commands.push(args);
            if (args[0] === 'show-environment')
            {
                return { status: 0, stdout: '', stderr: '' };
            }
            if (args[0] === 'show')
            {
                state.showCount += 1;
                if (showThrowsAfter !== null && state.showCount >= showThrowsAfter)
                {
                    throw new Error('stub unit query threw');
                }
                if (showNonzeroAt.includes(state.showCount))
                {
                    return { status: 1, stdout: '', stderr: 'stub unit query unavailable' };
                }
                if (dbusDisappears && state.showCount > 1)
                {
                    return { status: 1, stdout: '', stderr: 'DBus unavailable' };
                }
                return {
                    status: 0,
                    stdout: [
                        `LoadState=${state.loadState}`,
                        `ActiveState=${state.loadState === 'not-found' ? 'inactive' : 'failed'}`,
                        `ControlGroup=${unitControlGroup}`,
                        `Slice=${typeof unitSlice === 'function' ? unitSlice(state) : unitSlice}`,
                        'MainPID=101'
                    ].join('\n'),
                    stderr: ''
                };
            }
            const key = args[0] === 'kill'
                ? args.find((argument) => argument.startsWith('--signal='))
                    ?.slice('--signal='.length)
                : args[0];
            if (systemctlThrows[key])
            {
                throw systemctlThrows[key];
            }
            const transition = commandTransitions[key];
            if (transition?.emitTerminal)
            {
                emitTerminal(
                    transition.exitCode ?? 0,
                    transition.signal ?? null
                );
            }
            if (transition?.loadState)
            {
                state.loadState = transition.loadState;
            }
            if (transition?.members)
            {
                state.members = [...transition.members];
            }
            if (
                finalizeTransition &&
                !state.finalizeTransitionApplied &&
                state.controlRoot &&
                fs.existsSync(path.join(state.controlRoot, 'finalize'))
            )
            {
                state.finalizeTransitionApplied = true;
                if (finalizeTransition.emitTerminal)
                {
                    emitTerminal(
                        finalizeTransition.exitCode ?? 0,
                        finalizeTransition.signal ?? null
                    );
                }
                if (finalizeTransition.loadState)
                {
                    state.loadState = finalizeTransition.loadState;
                }
                if (finalizeTransition.members)
                {
                    state.members = [...finalizeTransition.members];
                }
            }
            const status = commandStatuses[key] ?? 0;
            return {
                status,
                stdout: '',
                stderr: status === 0 ? '' : `${key} failed`
            };
        },
        readCgroupMemberPids()
        {
            state.cgroupReadCount += 1;
            if (state.cgroupReadCount === cgroupReadErrorAt)
            {
                throw Object.assign(new Error('stub cgroup permission denied'), { code: 'EACCES' });
            }
            return state.cgroupReadCount === 1 ? [...state.members, 202] : [...state.members];
        },
        readExecutableSnapshot: () => [],
        resolvePython: () => process.execPath,
        readCurrentCgroup: () => typeof callerCgroup === 'function' ? callerCgroup(state) : callerCgroup,
        readProcessIdentity(pid)
        {
            return {
                status: 'verified',
                pid,
                processStartIdentity: `stub-${pid}`,
                executableDigest: `executable-${pid}`,
                executablePath: fs.realpathSync(process.execPath),
                commandDigest: `sha256:${createHash('sha256').update([
                    process.execPath,
                    '-I',
                    '-S',
                    fileURLToPath(new URL('../../tools/test/physical-execution-linux-preexec.py', import.meta.url))
                ].join('\0')).digest('hex')}`
            };
        },
        readProcessGroupIdentity(pid)
        {
            queueMicrotask(() => onCommandProcessGroupObserved?.({ state, child, pid }));
            return {
                status: 'verified',
                value: {
                    schema: 'fsusblog.process-group-or-job-identity.v1',
                    platform: 'linux',
                    kind: 'process-group',
                    groupId: pid,
                    leaderPid: pid,
                    leaderProcessStartIdentity: `stub-${pid}`
                }
            };
        },
        removeControlRoot(controlRoot)
        {
            if (removeRootError)
            {
                throw removeRootError;
            }
            fs.rmSync(controlRoot, { recursive: true, force: true });
        },
        handshakeTimeoutMs: 100
    });
    return { adapter, state };
}

test('child and sleeping grandchild are both absent after cancellation', async () =>
{
    const controller = new AbortController();
    const readiness = readinessSink();
    const result = runPhysicalExecution({
        command: [
            process.execPath,
            '-e',
            "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('ready',c.pid);setInterval(()=>{},1000)"
        ],
        signal: controller.signal,
        residualRoot: path.join(temporaryRoot('cancel-tree'), 'residuals'),
        policy: fastPolicy,
        stdout: readiness.sink,
        stderr: quiet
    });
    await readiness.ready;
    controller.abort(Object.assign(new Error('cancelled by test'), { name: 'AbortError', signal: 'SIGTERM' }));
    const error = await result.catch((value) => value);
    assert.equal(error.name, 'AbortError');
    assert.equal(error.physicalExecution.postObservation, 'zero-members');
    assert.ok(error.physicalExecution.processInventory.length >= 3);
    for (const entry of error.physicalExecution.processInventory)
    {
        assert.equal(processExists(entry.pid), false, `process ${entry.pid} remained alive`);
    }
});

test('parent exit with a live grandchild is terminated and cannot succeed', async () =>
{
    const error = await expectFailure({
        command: [
            process.execPath,
            '-e',
            "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref()"
        ],
        residualRoot: path.join(temporaryRoot('parent-exit'), 'residuals')
    });
    assert.match(error.message, /parent exited before its process group became empty/u);
    assert.ok(error.physicalExecution.termination.length > 0);
    for (const entry of error.physicalExecution.processInventory)
    {
        assert.equal(processExists(entry.pid), false);
    }
});

test('Linux resource-bound producer cannot report a resident setsid descendant as a completed tier', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const capability = spawnSync('systemctl', ['--user', 'show-environment'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    if (capability.status !== 0)
    {
        t.skip(`systemd user cgroup authority unavailable: ${String(capability.stderr).trim()}`);
        return;
    }
    const root = temporaryRoot('resident-producer-exit');
    const context = { root, runId: 'resident-producer-exit', namespace: 'component',
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
        schedulerOwnerToken: randomUUID() };
    const enforcer = await createProductionResourceEnforcer({
        runId: context.runId, bundleIds: ['worker'], mode: 'strict', machine: { cpuUnits: 2, memoryGiB: 2 },
        systemdBoundary: { context, commandBudgetMs: 5000, startupBudgetMs: 5000,
            retainBinding(reference)
            {
                writePrivateJson(path.join(root, 'independent-reference.json'), reference);
                return { bindingDigest: reference.bindingDigest };
            } }
    });
    t.after(() =>
    {
        assert.equal(enforcer.cleanup().status, 'removed', 'resident rejection must leave no task resource boundary');
        fs.rmSync(root, { recursive: true, force: true });
    });
    const limits = enforcer.update('worker', { cpuUnits: 1, memoryGiB: 0.25 });
    const marker = path.join(root, 'resident.json');
    const residentSource = `const fs = require('node:fs');
        const stat = fs.readFileSync('/proc/self/stat', 'utf8');
        const sessionId = Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[3]);
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,sessionId,
            cgroup:fs.readFileSync('/proc/self/cgroup','utf8').trim().slice(3)}));
        setInterval(() => {}, 1000);`;
    const producerSource = `const fs = require('node:fs');
        const child = require('node:child_process').spawn(process.execPath,
            ['-e', ${JSON.stringify(residentSource)}], {detached:true,stdio:'ignore'});
        child.unref();
        const deadline = Date.now() + 2000;
        const timer = setInterval(() => {
            if (fs.existsSync(${JSON.stringify(marker)})) { clearInterval(timer); process.exit(0); }
            if (Date.now() > deadline) { clearInterval(timer); process.exit(2); }
        }, 5);`;
    const error = await expectFailure({
        command: [process.execPath, '-e', producerSource], cwd: root,
        resourceBoundary: enforcer.executionBoundary('worker'),
        resourceContext: { ...context, bundleId: 'worker' },
        residualRoot: path.join(root, 'residuals'),
        policy: { ...fastPolicy, gracefulTerminationMs: 250 }
    });
    const resident = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(resident.sessionId, resident.pid, 'detached resident must be in its own session');
    assert.match(resident.cgroup, /\/fsusblog-physical-[a-f0-9]{32}\.service$/u);
    assert.ok(path.join('/sys/fs/cgroup', resident.cgroup).startsWith(`${limits.cgroupPath}/`));
    assert.match(error.message, /parent exited before its process group became empty/u);
    assert.equal(error.physicalExecution.postObservation, 'zero-members');
    assert.ok(error.physicalExecution.processInventory.some((entry) => entry.pid === resident.pid));
    assert.equal(await waitForProcessAbsence(resident.pid, 1500), true);
});

test('detached=false Unix bootstrap is rejected before business child spawn and cleaned', {
    skip: !['linux', 'darwin'].includes(process.platform)
}, async (context) =>
{
    const root = temporaryRoot('detached-false');
    const marker = path.join(root, 'business-child-started');
    let supervisorPid = null;
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const startedAt = Date.now();
    const error = await expectFailure({
        command: [
            process.execPath,
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`
        ],
        residualRoot: path.join(root, 'residuals'),
        spawnProcess(executable, argumentsList, options)
        {
            const child = spawn(executable, argumentsList, {
                ...options,
                detached: false
            });
            supervisorPid = child.pid;
            return child;
        }
    });
    assert.match(
        error.message,
        /did not become its run-owned process-group leader/u
    );
    assert.equal(fs.existsSync(marker), false);
    assert.ok(Number.isInteger(supervisorPid) && supervisorPid > 0);
    assert.equal(
        await waitForProcessAbsence(supervisorPid, fastPolicy.forceTerminationMs),
        true
    );
    assert.ok(
        Date.now() - startedAt
            < fastPolicy.forceTerminationMs + fastPolicy.pipeCloseTimeoutMs + 1000
    );
});

test('ignored graceful signal is followed by force kill and recorded', async () =>
{
    const controller = new AbortController();
    const readiness = readinessSink();
    const result = runPhysicalExecution({
        command: [process.execPath, '-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
        signal: controller.signal,
        residualRoot: path.join(temporaryRoot('force'), 'residuals'),
        policy: fastPolicy,
        stdout: readiness.sink,
        stderr: quiet
    });
    await readiness.ready;
    controller.abort(Object.assign(new Error('timeout'), { name: 'AbortError', signal: 'SIGTERM' }));
    const error = await result.catch((value) => value);
    assert.deepEqual(error.physicalExecution.termination.map((entry) => entry.phase), ['graceful', 'forced']);
    assert.ok(error.physicalExecution.processInventory.some((entry) => entry.signal === 'SIGKILL'));
});

test('a descendant spawned while cancelling remains contained and is terminated', async () =>
{
    const controller = new AbortController();
    const readiness = readinessSink();
    const lateSpawnPolicy = {
        ...fastPolicy,
        gracefulTerminationMs: fastPolicy.gracefulTerminationMs
            + fastPolicy.pipeCloseTimeoutMs
    };
    const result = runPhysicalExecution({
        command: [
            process.execPath,
            '-e',
            "const{spawn}=require('child_process');process.on('SIGTERM',()=>{spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});});console.log('ready');setInterval(()=>{},1000)"
        ],
        signal: controller.signal,
        residualRoot: path.join(temporaryRoot('late-spawn'), 'residuals'),
        policy: lateSpawnPolicy,
        stdout: readiness.sink,
        stderr: quiet
    });
    await readiness.ready;
    controller.abort(Object.assign(new Error('cancel'), { name: 'AbortError', signal: 'SIGTERM' }));
    const error = await result.catch((value) => value);
    assert.ok(error.physicalExecution.processInventory.some((entry) => entry.role === 'descendant'));
    for (const entry of error.physicalExecution.processInventory)
    {
        assert.equal(processExists(entry.pid), false);
    }
});

test('PID start identity mismatch prevents any signal from being sent', async () =>
{
    const controller = new AbortController();
    const residualRoot = path.join(temporaryRoot('pid-reuse'), 'residuals');
    const signalled = [];
    let authority = null;
    const result = runPhysicalExecution({
        command: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        signal: controller.signal,
        residualRoot,
        policy: fastPolicy,
        stdout: quiet,
        stderr: quiet,
        collectMembers(group)
        {
            authority = group;
            return { status: 'unverifiable', reason: 'process-group leader start identity mismatch' };
        },
        signalGroup(pid, signal)
        {
            signalled.push({ pid, signal });
        }
    });
    setTimeout(() => controller.abort(Object.assign(new Error('cancel'), { name: 'AbortError', signal: 'SIGTERM' })), 80);
    const error = await result.catch((value) => value);
    try
    {
        assert.equal(error.message, 'cancel');
        assert.match(
            error.physicalExecutionContainmentError?.message ?? '',
            /start identity mismatch/u
        );
        assert.deepEqual(signalled, []);
        assert.ok(authority);
    }
    finally
    {
        const expectedIdentities = (error.physicalExecution?.processInventory ?? []).map(
            (entry) => ({
                pid: entry.pid,
                processStartIdentity: entry.startIdentity,
                executableDigest: entry.executableDigest,
                commandDigest: entry.commandDigest
            })
        );
        const cleanupPolicy = {
            ...fastPolicy,
            forceTerminationMs: fastPolicy.forceTerminationMs
                + (2 * fastPolicy.pipeCloseTimeoutMs)
        };
        let cleanup = terminatePhysicalExecutionAuthoritySync({
            authority,
            reason: 'PID mismatch negative-test cleanup',
            policy: cleanupPolicy,
            expectedIdentities
        });
        if (!cleanup.terminated && cleanup.postObservation === 'members-remain')
        {
            const reaped = await Promise.all(expectedIdentities.map(
                (identity) => waitForProcessAbsence(
                    identity.pid,
                    cleanupPolicy.forceTerminationMs
                )
            ));
            assert.ok(reaped.every(Boolean), cleanup.reason);
            cleanup = terminatePhysicalExecutionAuthoritySync({
                authority,
                reason: 'PID mismatch negative-test cleanup after child reap',
                policy: cleanupPolicy,
                expectedIdentities
            });
        }
        assert.equal(cleanup.terminated, true, cleanup.reason);
        assert.equal(cleanup.postObservation, 'zero-members');
        for (const identity of expectedIdentities)
        {
            assert.equal(
                await waitForProcessAbsence(identity.pid, cleanupPolicy.forceTerminationMs),
                true,
                `negative-test cleanup leaked PID ${identity.pid}`
            );
        }
    }
});

test('post-observe collector failure blocks the next candidate before spawn', async () =>
{
    const controller = new AbortController();
    const residualRoot = path.join(temporaryRoot('collector'), 'residuals');
    let collections = 0;
    const result = runPhysicalExecution({
        command: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        signal: controller.signal,
        residualRoot,
        policy: fastPolicy,
        stdout: quiet,
        stderr: quiet,
        collectMembers(group, options)
        {
            collections += 1;
            if (collections > 1)
            {
                return { status: 'unverifiable', reason: 'injected collector failure' };
            }
            return processGroupMemberIdentities(group, options);
        }
    });
    setTimeout(() => controller.abort(Object.assign(new Error('cancel'), { name: 'AbortError', signal: 'SIGTERM' })), 80);
    const error = await result.catch((value) => value);
    assert.equal(error.message, 'cancel');
    assert.match(
        error.physicalExecutionContainmentError?.message ?? '',
        /post-observe failed: injected collector failure/u
    );
    assert.ok(fs.readdirSync(residualRoot).some((entry) => entry.endsWith('.json')));

    let spawns = 0;
    const blocked = await expectFailure({
        command: [process.execPath, '-e', 'process.exit(0)'],
        residualRoot,
        spawnProcess()
        {
            spawns += 1;
            assert.fail('spawn must remain zero while residual evidence is unresolved');
        }
    });
    assert.match(blocked.message, /preflight blocked by unresolved residual receipt/u);
    assert.equal(spawns, 0);
});

test('Windows requires a Job Object adapter and validates its kill-on-close evidence', async () =>
{
    const root = path.join(temporaryRoot('windows'), 'residuals');
    const missing = await expectFailure({
        command: ['cmd.exe', '/c', 'exit', '0'],
        platform: 'win32',
        residualRoot: root,
        windowsJobAdapter: false
    });
    assert.match(missing.message, /Windows Job Object adapter is unavailable/u);

    const evidence = await runPhysicalExecution({
        command: ['cmd.exe', '/c', 'exit', '0'],
        platform: 'win32',
        residualRoot: root,
        policy: fastPolicy,
        stdout: quiet,
        stderr: quiet,
        windowsJobAdapter: {
            async run()
            {
                return {
                    schema: physicalExecutionProcessTreeSchema,
                    platform: 'win32',
                    policy: fastPolicy,
                    authority: {
                        schema: 'fsusblog.process-group-or-job-identity.v1',
                        platform: 'win32',
                        kind: 'windows-job-object',
                        jobName: 'Local\\FsusBlogPhysicalExecution-test',
                        killPolicy: 'kill-on-close'
                    },
                    lifecycle: [
                        'created',
                        'running',
                        'bounded-pipe-close',
                        'post-observe-zero-members'
                    ],
                    termination: [],
                    postObservation: 'zero-members',
                    processInventory: [],
                    logComplete: true,
                    logTruncationReason: null,
                    forcedPipeClose: false,
                    outputCapture: {
                        maximumBytesPerStream: fastPolicy.maximumCapturedOutputBytesPerStream,
                        stdoutBytes: 0,
                        stderrBytes: 0,
                        stdoutCapturedBytes: 0,
                        stderrCapturedBytes: 0,
                        stdoutTruncated: false,
                        stderrTruncated: false
                    },
                    stdout: '',
                    stderr: ''
                };
            }
        }
    });
    assert.equal(evidence.authority.kind, 'windows-job-object');

    const script = fs.readFileSync(path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../tools/test/physical-execution-windows-job.ps1'
    ), 'utf8');
    assert.match(script, /JobObjectLimitKillOnJobClose/u);
    assert.match(script, /CreateProcess[\s\S]*CreateSuspended \| CreateNewProcessGroup[\s\S]*AssignProcessToJobObject[\s\S]*assignedFile[\s\S]*resumeFile[\s\S]*ResumeThread/u);
    assert.match(script, /GenerateConsoleCtrlEvent[\s\S]*ObserveEmpty[\s\S]*TerminateJobObject[\s\S]*ObserveEmpty/u);
});

test('Windows native Job Object physically contains and terminates a descendant tree', {
    skip: process.platform !== 'win32'
}, async () =>
{
    const controller = new AbortController();
    const readiness = readinessSink();
    const execution = runPhysicalExecution({
        command: [
            process.execPath,
            '-e',
            "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','process.on(\\'SIGTERM\\',()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('ready',c.pid);process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
        ],
        signal: controller.signal,
        residualRoot: path.join(temporaryRoot('windows-native-job'), 'residuals'),
        policy: { ...fastPolicy, gracefulTerminationMs: 500 },
        stdout: readiness.sink,
        stderr: quiet
    });
    await readiness.ready;
    controller.abort(Object.assign(new Error('Windows Job cancellation'), {
        name: 'AbortError',
        signal: 'SIGTERM'
    }));
    const error = await execution.catch((value) => value);
    assert.equal(error.physicalExecution.authority.kind, 'windows-job-object');
    assert.equal(error.physicalExecution.authority.killPolicy, 'kill-on-close');
    assert.equal(error.physicalExecution.postObservation, 'zero-members');
    assert.ok(error.physicalExecution.processInventory.length >= 2);
    for (const entry of error.physicalExecution.processInventory)
    {
        assert.equal(processExists(entry.pid), false);
    }
});

test('Windows Job adapter aborts a pre-ready handshake and bounds supervisor cleanup', async () =>
{
    const controller = new AbortController();
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    let controlRoot = null;
    let killCount = 0;
    child.kill = () =>
    {
        killCount += 1;
        child.exitCode = 1;
        child.stdout.end();
        child.stderr.end();
        queueMicrotask(() => child.emit('exit', 1, null));
        return true;
    };
    const adapter = createPhysicalExecutionWindowsJobAdapter({
        spawnProcess: (_executable, args) =>
        {
            controlRoot = path.dirname(args[args.indexOf('-ReadyFile') + 1]);
            return child;
        },
        queryMembers: () =>
        {
            throw new Error('member query must not run before the ready handshake');
        }
    });
    const startedAt = Date.now();
    const execution = adapter.run({
        command: ['cmd.exe', '/c', 'exit', '0'],
        cwd: process.cwd(),
        env: process.env,
        signal: controller.signal,
        policy: { ...fastPolicy, forceTerminationMs: 200 },
        stdout: quiet,
        stderr: quiet
    });
    setTimeout(() => controller.abort(Object.assign(new Error('pre-ready cancellation'), {
        name: 'AbortError',
        signal: 'SIGTERM'
    })), 20);
    const error = await execution.catch((value) => value);
    assert.equal(error.name, 'AbortError');
    assert.equal(error.message, 'pre-ready cancellation');
    assert.equal(error.physicalExecution.postObservation, 'unverifiable');
    assert.equal(error.physicalExecution.logComplete, true);
    assert.ok(error.physicalExecution.lifecycle.includes('bounded-pipe-close'));
    assert.equal(killCount, 1);
    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(fs.existsSync(controlRoot), false);
});

test('partial outputs remain evidence but cannot turn a failed execution into success', async () =>
{
    const root = temporaryRoot('partial-output');
    const output = path.join(root, 'partial.txt');
    await assert.rejects(
        runBoundExecution({
            root: path.join(root, 'receipts'),
            runId: 'partial-output-run',
            key: 'partial-output',
            command: [process.execPath, '-e', 'write-output-then-fail'],
            cwd: root,
            inputDigest: 'input',
            environmentDigest: 'environment',
            outputContract: ['partial.txt'],
            requiredOutputs: ['partial.txt'],
            commit: 'commit',
            worktreeFingerprint: 'worktree',
            testIds: ['partial-output'],
            consumerId: 'partial-output'
        }, async () => await runPhysicalExecution({
            command: [
                process.execPath,
                '-e',
                `require('node:fs').writeFileSync(${JSON.stringify(output)},'partial');console.log('preserved stdout');console.error('preserved stderr');process.exit(7)`
            ],
            cwd: root,
            residualRoot: path.join(root, 'residuals'),
            policy: fastPolicy,
            stdout: quiet,
            stderr: quiet
        })),
        /command failed \(exit 7\)/u
    );
    const receiptDirectory = path.join(root, 'receipts', 'partial-output-run', 'receipts', 'partial-output');
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDirectory, fs.readdirSync(receiptDirectory).find((entry) => entry.endsWith('.json'))), 'utf8'));
    assert.equal(receipt.status, 'failure');
    assert.equal(receipt.requiredOutputStates.length, 1);
    assert.match(receipt.physicalExecution.stdout, /preserved stdout/u);
    assert.match(receipt.physicalExecution.stderr, /preserved stderr/u);
    assert.ok(receipt.physicalExecution.processInventory.every((entry) => entry.startIdentity && entry.executableDigest && entry.commandDigest));
});

test('cancelled run-bound receipt retains stdout, stderr, and process inventory', async () =>
{
    const root = temporaryRoot('cancelled-receipt');
    const controller = new AbortController();
    const readiness = readinessSink();
    const execution = runBoundExecution({
        root: path.join(root, 'receipts'),
        runId: 'cancelled-receipt-run',
        key: 'cancelled-receipt',
        command: [process.execPath, '-e', 'cancelled-receipt'],
        cwd: root,
        inputDigest: 'input',
        environmentDigest: 'environment',
        commit: 'commit',
        worktreeFingerprint: 'worktree',
        testIds: ['cancelled-receipt'],
        consumerId: 'cancelled-receipt',
        signal: controller.signal
    }, async () => await runPhysicalExecution({
        command: [
            process.execPath,
            '-e',
            "console.log('ready retained stdout');console.error('retained stderr');setInterval(()=>{},1000)"
        ],
        cwd: root,
        signal: controller.signal,
        residualRoot: path.join(root, 'residuals'),
        policy: fastPolicy,
        stdout: readiness.sink,
        stderr: quiet
    }));
    await readiness.ready;
    controller.abort(Object.assign(new Error('cancelled receipt'), { name: 'AbortError', signal: 'SIGTERM' }));
    await assert.rejects(execution, { name: 'AbortError' });

    const receiptDirectory = path.join(root, 'receipts', 'cancelled-receipt-run', 'receipts', 'cancelled-receipt');
    const receipt = JSON.parse(fs.readFileSync(path.join(receiptDirectory, fs.readdirSync(receiptDirectory).find((entry) => entry.endsWith('.json'))), 'utf8'));
    assert.equal(receipt.status, 'cancelled');
    assert.equal(receipt.physicalExecution.postObservation, 'zero-members');
    assert.match(receipt.physicalExecution.stdout, /retained stdout/u);
    assert.match(receipt.physicalExecution.stderr, /retained stderr/u);
    assert.ok(receipt.physicalExecution.processInventory.length >= 2);
});

test('Linux systemd adapter carries the complete child environment without exposing secrets in argv', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const capability = spawnSync('systemctl', ['--user', 'show-environment'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (capability.status !== 0)
    {
        t.skip(`systemd user cgroup authority unavailable: ${String(capability.stderr).trim()}`);
        return;
    }
    const root = temporaryRoot('systemd-private-carrier');
    const resultFile = path.join(root, 'result.json');
    const secret = `fsusblog-systemd-secret-${Date.now()}-${Math.random()}`;
    const environment = {
        ...process.env,
        FSUSBLOG_SYSTEMD_SECRET: secret,
        FSUSBLOG_SYSTEMD_EMPTY: '',
        FSUSBLOG_SYSTEMD_UNICODE: '完整环境'
    };
    let supervisorSpawnargs = [];
    let bootstrapArguments = [];
    let carrierEnvironment;
    let commandMode;
    let environmentMode;
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const adapter = createPhysicalExecutionLinuxSystemdAdapter({
        spawnProcess(executable, args, options)
        {
            const controlRoot = args.at(-1);
            const commandFile = path.join(controlRoot, 'command.json');
            const environmentFile = path.join(controlRoot, 'environment.json');
            commandMode = fs.statSync(commandFile).mode & 0o777;
            environmentMode = fs.statSync(environmentFile).mode & 0o777;
            carrierEnvironment = JSON.parse(fs.readFileSync(environmentFile, 'utf8'));
            const bootstrapIndex = args.findIndex((argument) => argument.endsWith(
                '/physical-execution-linux-systemd-bootstrap.mjs'
            ));
            bootstrapArguments = args.slice(bootstrapIndex + 1);
            const child = spawn(executable, args, options);
            supervisorSpawnargs = child.spawnargs;
            return child;
        }
    });
    const evidence = await adapter.run({
        command: [
            process.execPath,
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({secret:process.env.FSUSBLOG_SYSTEMD_SECRET,empty:process.env.FSUSBLOG_SYSTEMD_EMPTY,unicode:process.env.FSUSBLOG_SYSTEMD_UNICODE,keys:Object.keys(process.env).sort()}))`
        ],
        cwd: root,
        env: environment,
        policy: fastPolicy,
        stdout: quiet,
        stderr: quiet,
        schema: physicalExecutionProcessTreeSchema
    });
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.equal(commandMode, 0o600);
    assert.equal(environmentMode, 0o600);
    assert.deepEqual(carrierEnvironment, environment);
    assert.equal(bootstrapArguments.length, 1);
    assert.match(bootstrapArguments[0], /fsusblog-physical-systemd-/u);
    assert.equal(supervisorSpawnargs.join('\0').includes(secret), false);
    assert.equal(supervisorSpawnargs.some((argument) => argument.startsWith('--setenv=')), false);
    assert.deepEqual(result, {
        secret,
        empty: '',
        unicode: '完整环境',
        keys: Object.keys(environment).sort()
    });
    assert.equal(evidence.authority.kind, 'linux-cgroup-process-group');
    assert.equal(evidence.postObservation, 'zero-members');
});

test('nested Linux systemd execution rejects copied capabilities and foreign services before target release', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const cwd = temporaryRoot('systemd-owned-boundary');
    const context = { root: cwd, runId: 'owned-boundary', namespace: 'component',
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
        schedulerOwnerToken: randomUUID() };
    const enforcer = await createProductionResourceEnforcer({
        runId: context.runId, bundleIds: ['worker'], mode: 'strict', machine: { cpuUnits: 2, memoryGiB: 2 },
        systemdBoundary: { context, commandBudgetMs: 5000, startupBudgetMs: 5000,
            retainBinding(reference)
            {
                writePrivateJson(path.join(cwd, 'independent-reference.json'), reference);
                return { bindingDigest: reference.bindingDigest };
            } }
    });
    t.after(() =>
    {
        assert.equal(enforcer.cleanup().status, 'removed');
        fs.rmSync(cwd, { recursive: true, force: true });
    });
    enforcer.update('worker', { cpuUnits: 1, memoryGiB: 0.25 });
    const boundary = enforcer.executionBoundary('worker');
    const options = {
        command: [process.execPath, '-e', 'process.exit(0)'], cwd, env: {}, policy: fastPolicy,
        stdout: quiet, stderr: quiet, schema: physicalExecutionProcessTreeSchema,
        resourceBoundary: boundary, resourceContext: { ...context, bundleId: 'worker' }
    };
    // The current owner requires its live capability, not the obsolete slice-name hint.
    for (const copied of ['/user.slice/owned.slice', { ...boundary }, JSON.parse(JSON.stringify(boundary))])
    {
        const denied = createStubSystemdExecution();
        await assert.rejects(denied.adapter.run({ ...options, resourceBoundary: copied }),
            /live resource-owner capability/u);
        assert.equal(denied.state.spawnArgs, null);
    }
    for (const changed of [
        { runId: 'foreign-run' }, { namespace: 'foreign-namespace' }, { bundleId: 'foreign-worker' },
        { sourceState: { ...context.sourceState, commit: 'c'.repeat(40) } },
        { schedulerOwnerToken: randomUUID() }
    ])
    {
        const denied = createStubSystemdExecution();
        await assert.rejects(denied.adapter.run({ ...options,
            resourceContext: { ...options.resourceContext, ...changed } }), /execution context differs/u);
        assert.equal(denied.state.spawnArgs, null);
    }
    const foreignUnit = createStubSystemdExecution({
        unitControlGroup: '/user.slice/foreign.slice/fsusblog-stub.scope', unitSlice: 'foreign.slice',
        finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] }
    });
    await assert.rejects(foreignUnit.adapter.run(options), /pre-exec process ancestry is invalid/u);
    assert.ok(foreignUnit.state.spawnArgs.includes(`--property=Slice=${boundary.admission.unitName}`));
    assert.equal(fs.existsSync(path.join(foreignUnit.state.controlRoot, 'release.json')), false);
});

test('Linux systemd adapter cleanup treats command results as evidence and final state as authority', async (t) =>
{
    const policy = {
        ...fastPolicy,
        gracefulTerminationMs: 100,
        forceTerminationMs: 250,
        pipeCloseTimeoutMs: 30,
        observationIntervalMs: 1,
        zeroMemberObservations: 2
    };
    const options = {
        command: [process.execPath, '-e', 'process.exit(0)'],
        cwd: temporaryRoot('systemd-stub-finalizer'),
        env: {},
        policy,
        stdout: quiet,
        stderr: quiet,
        schema: physicalExecutionProcessTreeSchema
    };
    t.after(() => fs.rmSync(options.cwd, { recursive: true, force: true }));

    await t.test('accepts stop and reset failures after exact collection and an empty cgroup', async () =>
    {
        const { adapter, state } = createStubSystemdExecution({
            commandStatuses: { stop: 1, 'reset-failed': 1 },
            finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] }
        });
        const evidence = await adapter.run(options);
        assert.equal(evidence.postObservation, 'zero-members');
        assert.equal(evidence.cleanup.status, 'verified');
        assert.equal(fs.existsSync(state.controlRoot), false);
        assert.ok(evidence.cleanup.commands.some((entry) => (
            entry.args[0] === 'reset-failed' && entry.status === 1
        )));
    });

    await t.test('preserves command exit as primary when cleanup remains loaded', async () =>
    {
        const { adapter, state } = createStubSystemdExecution({
            result: { exitCode: 1, signal: null },
            commandStatuses: { 'reset-failed': 1 },
            finalizeTransition: { emitTerminal: true, loadState: 'loaded', members: [] }
        });
        const error = await adapter.run(options).catch((value) => value);
        assert.equal(error.exitCode, 1);
        assert.match(error.message, /command failed \(exit 1\)/u);
        assert.match(error.physicalExecutionFinalizeError.message, /unit remained loaded/u);
        assert.equal(error.physicalExecution.cleanup.status, 'unverifiable');
        assert.equal(error.physicalExecution.controlRoot, state.controlRoot);
        assert.equal(fs.existsSync(state.controlRoot), true);
        fs.rmSync(state.controlRoot, { recursive: true, force: true });
    });

    await t.test('accepts failed SIGTERM when observation proves empty without forcing SIGKILL', async () =>
    {
        const controller = new AbortController();
        const reason = Object.assign(new Error('stub cancellation'), {
            name: 'AbortError',
            signal: 'SIGTERM'
        });
        const { adapter, state } = createStubSystemdExecution({
            handshake: 'child',
            initialMembers: [101, 303],
            commandStatuses: { SIGTERM: 1 },
            commandTransitions: { SIGTERM: { members: [] } },
            finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] },
            onCommandProcessGroupObserved()
            {
                controller.abort(reason);
            }
        });
        const error = await adapter.run({ ...options, signal: controller.signal }).catch((value) => value);
        assert.equal(error.name, 'AbortError');
        assert.equal(error.physicalExecution.cleanup.status, 'verified');
        assert.equal(error.physicalExecution.termination.length, 1);
        assert.equal(error.physicalExecution.termination[0].command.status, 1);
        assert.equal(state.commands.some((args) => args.includes('--signal=SIGKILL')), false);
        assert.equal(fs.existsSync(state.controlRoot), false);
    });

    await t.test('fails closed after SIGTERM SIGKILL and stop failures retain cgroup members', async () =>
    {
        const controller = new AbortController();
        const reason = Object.assign(new Error('stub cancellation with leak'), {
            name: 'AbortError',
            signal: 'SIGTERM'
        });
        const { adapter, state } = createStubSystemdExecution({
            handshake: 'child',
            initialMembers: [101, 303],
            commandStatuses: { SIGTERM: 1, SIGKILL: 1, stop: 1 },
            commandTransitions: {
                SIGTERM: { members: [101, 303] },
                SIGKILL: { members: [303] }
            },
            finalizeTransition: { emitTerminal: true, loadState: 'loaded', members: [303] },
            onCommandProcessGroupObserved()
            {
                controller.abort(reason);
            }
        });
        const error = await adapter.run({ ...options, signal: controller.signal }).catch((value) => value);
        assert.equal(error.name, 'AbortError');
        assert.match(error.physicalExecutionContainmentError.message, /remained nonempty/u);
        assert.match(error.physicalExecutionFinalizeError.message, /unit remained loaded|retained members/u);
        assert.equal(error.physicalExecution.cleanup.status, 'unverifiable');
        assert.ok(state.commands.some((args) => args.includes('--signal=SIGKILL')));
        assert.equal(fs.existsSync(state.controlRoot), true);
        fs.rmSync(state.controlRoot, { recursive: true, force: true });
    });

    await t.test('bounds a supervisor error before the ready handshake and retains recovery evidence', async () =>
    {
        const startedAt = Date.now();
        const { adapter, state } = createStubSystemdExecution({
            handshake: 'before-ready',
            childError: Object.assign(new Error('stub supervisor failed before ready'), { code: 'EIO' }),
            finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] }
        });
        const error = await adapter.run(options).catch((value) => value);
        assert.match(error.message, /before ready/u);
        assert.ok(Date.now() - startedAt < 500);
        assert.equal(error.physicalExecution.cleanup.status, 'unverifiable');
        assert.equal(error.physicalExecution.authority.established, null);
        assert.equal(error.physicalExecution.authority.unitName, null);
        assert.equal(error.physicalExecution.authority.attemptedUnitName, state.unitName);
        assert.equal(error.physicalExecution.controlRoot, state.controlRoot);
        assert.equal(fs.existsSync(state.controlRoot), true);
        fs.rmSync(state.controlRoot, { recursive: true, force: true });
    });

    await t.test('treats DBus loss after preflight as unverifiable and retains the control root', async () =>
    {
        const { adapter, state } = createStubSystemdExecution({
            dbusDisappears: true,
            finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] }
        });
        const error = await adapter.run(options).catch((value) => value);
        assert.match(error.message, /cleanup is unverifiable/u);
        assert.match(error.physicalExecutionFinalizeError.message, /DBus unavailable/u);
        assert.equal(error.physicalExecution.cleanup.status, 'unverifiable');
        assert.equal(error.physicalExecution.controlRoot, state.controlRoot);
        assert.equal(fs.existsSync(state.controlRoot), true);
        fs.rmSync(state.controlRoot, { recursive: true, force: true });
    });

    await t.test('keeps authority establishment unknown when the first unit query fails', async () =>
    {
        const { adapter, state } = createStubSystemdExecution({
            showNonzeroAt: [1],
            finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] }
        });
        const error = await adapter.run(options).catch((value) => value);
        assert.match(error.message, /systemd authority is unverifiable/u);
        assert.equal(error.physicalExecution.cleanup.status, 'verified');
        assert.equal(error.physicalExecution.authority.established, null);
        assert.equal(error.physicalExecution.authority.unitName, null);
        assert.equal(error.physicalExecution.authority.attemptedUnitName, state.unitName);
        assert.equal(fs.existsSync(state.controlRoot), false);
    });

    await t.test('uses the local child fallback after a failed no-effect stop', async () =>
    {
        const { adapter, state } = createStubSystemdExecution({
            commandStatuses: { stop: 1 },
            localKillTransition: { loadState: 'not-found', members: [] }
        });
        const evidence = await adapter.run(options);
        assert.equal(evidence.cleanup.status, 'verified');
        assert.equal(state.childKillCount, 1);
        assert.ok(evidence.cleanup.commands.some((entry) => (
            entry.args[0] === 'stop' && entry.status === 1
        )));
        assert.equal(fs.existsSync(state.controlRoot), false);
    });

    await t.test('fails closed when local child fallback does not change unit or cgroup state', async () =>
    {
        const { adapter, state } = createStubSystemdExecution({
            initialMembers: [101],
            commandStatuses: { stop: 1 }
        });
        const error = await adapter.run(options).catch((value) => value);
        assert.match(error.message, /cleanup is unverifiable/u);
        assert.equal(state.childKillCount, 1);
        assert.equal(error.physicalExecution.cleanup.unit.LoadState, 'loaded');
        assert.deepEqual(error.physicalExecution.cleanup.cgroupMembers, [101]);
        assert.equal(error.physicalExecution.cleanup.status, 'unverifiable');
        assert.equal(fs.existsSync(state.controlRoot), true);
        fs.rmSync(state.controlRoot, { recursive: true, force: true });
    });

    await t.test('captures a throwing systemctl command without throwing through final observation', async () =>
    {
        const { adapter, state } = createStubSystemdExecution({
            systemctlThrows: { stop: new Error('stub systemctl threw') },
            localKillTransition: { loadState: 'not-found', members: [] }
        });
        const evidence = await adapter.run(options);
        assert.equal(evidence.cleanup.status, 'verified');
        assert.ok(evidence.cleanup.commands.some((entry) => (
            entry.args[0] === 'stop' && entry.error?.message === 'stub systemctl threw'
        )));
        assert.equal(fs.existsSync(state.controlRoot), false);
    });

    await t.test('turns a throwing final unit query into secondary cleanup evidence', async () =>
    {
        const { adapter, state } = createStubSystemdExecution({
            showThrowsAfter: 2,
            finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] }
        });
        const error = await adapter.run(options).catch((value) => value);
        assert.match(error.message, /cleanup is unverifiable/u);
        assert.match(error.physicalExecutionFinalizeError.message, /unit query threw/u);
        assert.equal(error.physicalExecution.cleanup.status, 'unverifiable');
        assert.equal(fs.existsSync(state.controlRoot), true);
        fs.rmSync(state.controlRoot, { recursive: true, force: true });
    });

    await t.test('turns final cgroup EACCES into secondary cleanup evidence', async () =>
    {
        const { adapter, state } = createStubSystemdExecution({
            cgroupReadErrorAt: 3,
            finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] }
        });
        const error = await adapter.run(options).catch((value) => value);
        assert.match(error.message, /cleanup is unverifiable/u);
        assert.match(error.physicalExecutionFinalizeError.message, /permission denied/u);
        assert.equal(error.physicalExecution.cleanup.status, 'unverifiable');
        assert.equal(fs.existsSync(state.controlRoot), true);
        fs.rmSync(state.controlRoot, { recursive: true, force: true });
    });

    await t.test('captures a throwing local child kill and retains recovery evidence', async () =>
    {
        const { adapter, state } = createStubSystemdExecution({
            commandStatuses: { stop: 1 },
            childKillError: new Error('stub local child kill threw')
        });
        const error = await adapter.run(options).catch((value) => value);
        assert.match(error.message, /cleanup is unverifiable/u);
        assert.ok(error.physicalExecution.cleanup.commands.some((entry) => (
            entry.args[0] === 'local-child-kill' &&
            entry.error?.message === 'stub local child kill threw'
        )));
        assert.equal(fs.existsSync(state.controlRoot), true);
        fs.rmSync(state.controlRoot, { recursive: true, force: true });
    });

    await t.test('preserves abort before ready as primary and still runs the finalizer', async () =>
    {
        const controller = new AbortController();
        const reason = Object.assign(new Error('abort before ready'), {
            name: 'AbortError',
            signal: 'SIGTERM'
        });
        controller.abort(reason);
        const { adapter, state } = createStubSystemdExecution({
            handshake: 'before-ready',
            finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] }
        });
        const error = await adapter.run({ ...options, signal: controller.signal }).catch((value) => value);
        assert.equal(error, reason);
        assert.equal(error.physicalExecution.cleanup.status, 'verified');
        assert.equal(error.physicalExecution.authority.established, null);
        assert.equal(error.physicalExecution.authority.unitName, null);
        assert.equal(error.physicalExecution.authority.attemptedUnitName, state.unitName);
        assert.equal(fs.existsSync(state.controlRoot), false);
    });

    await t.test('bounds the ready handshake with the injected startup deadline', async () =>
    {
        const startedAt = Date.now();
        const { adapter, state } = createStubSystemdExecution({
            handshake: 'before-ready',
            finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] }
        });
        const error = await adapter.run(options).catch((value) => value);
        assert.match(error.message, /ready handshake timed out/u);
        assert.ok(Date.now() - startedAt < 500);
        assert.equal(error.physicalExecution.cleanup.status, 'verified');
        assert.equal(error.physicalExecution.authority.established, null);
        assert.equal(error.physicalExecution.authority.unitName, null);
        assert.equal(error.physicalExecution.authority.attemptedUnitName, state.unitName);
        assert.equal(fs.existsSync(state.controlRoot), false);
    });

    await t.test('preserves abort after ready and before child as primary', async () =>
    {
        const controller = new AbortController();
        let observeStart = true;
        const reason = Object.assign(new Error('abort after ready before child'), {
            name: 'AbortError',
            signal: 'SIGTERM'
        });
        const { adapter, state } = createStubSystemdExecution({
            handshake: 'ready',
            finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] },
            onHandshake()
            {
                const abortAfterStart = () =>
                {
                    if (!observeStart)
                    {
                        return;
                    }
                    if (fs.existsSync(path.join(state.controlRoot, 'start')))
                    {
                        controller.abort(reason);
                        return;
                    }
                    setImmediate(abortAfterStart);
                };
                setImmediate(abortAfterStart);
            }
        });
        const error = await adapter.run({ ...options, signal: controller.signal }).catch((value) => value);
        observeStart = false;
        assert.equal(error, reason);
        assert.equal(error.physicalExecution.authority.supervisorPid, 101);
        assert.equal(error.physicalExecution.authority.established, true);
        assert.equal(error.physicalExecution.cleanup.status, 'verified');
        assert.equal(fs.existsSync(state.controlRoot), false);
    });

    await t.test('normalizes a string abort reason and still records termination', async () =>
    {
        const controller = new AbortController();
        const { adapter, state } = createStubSystemdExecution({
            handshake: 'child',
            initialMembers: [101, 303],
            commandTransitions: { SIGTERM: { members: [] } },
            finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] },
            onCommandProcessGroupObserved()
            {
                controller.abort('cancel');
            }
        });
        const error = await adapter.run({ ...options, signal: controller.signal }).catch((value) => value);
        assert.equal(error.name, 'AbortError');
        assert.equal(error.message, 'physical execution cancelled');
        assert.equal(error.abortReason, 'cancel');
        assert.equal(error.cause, 'cancel');
        assert.ok(error.physicalExecution.termination.length > 0);
        assert.equal(error.physicalExecution.cleanup.status, 'verified');
        assert.equal(fs.existsSync(state.controlRoot), false);
    });

    await t.test('bounds the child handshake independently of the cleanup policy', async () =>
    {
        const startedAt = Date.now();
        const { adapter, state } = createStubSystemdExecution({
            handshake: 'ready',
            finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] }
        });
        const error = await adapter.run(options).catch((value) => value);
        assert.match(error.message, /child handshake timed out/u);
        assert.ok(Date.now() - startedAt < 500);
        assert.equal(error.physicalExecution.cleanup.status, 'verified');
        assert.equal(error.physicalExecution.authority.established, true);
        assert.equal(fs.existsSync(state.controlRoot), false);
    });

    await t.test('bounds a supervisor error after child and before result', async () =>
    {
        const { adapter, state } = createStubSystemdExecution({
            handshake: 'child',
            childError: Object.assign(new Error('stub supervisor failed before result'), { code: 'EIO' }),
            finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] }
        });
        const error = await adapter.run(options).catch((value) => value);
        assert.match(error.message, /before result/u);
        assert.equal(error.physicalExecution.cleanup.status, 'unverifiable');
        assert.equal(fs.existsSync(state.controlRoot), true);
        fs.rmSync(state.controlRoot, { recursive: true, force: true });
    });

    await t.test('marks async ENOENT as not-established without a residual blocker', async () =>
    {
        const spawnError = Object.assign(new Error('stub systemd-run ENOENT'), { code: 'ENOENT' });
        const { adapter, state } = createStubSystemdExecution({
            handshake: 'before-ready',
            childError: spawnError
        });
        const error = await adapter.run(options).catch((value) => value);
        assert.equal(error, spawnError);
        assert.equal(error.physicalExecution.postObservation, 'zero-members');
        assert.equal(error.physicalExecution.cleanup.status, 'not-established');
        assert.equal(error.physicalExecution.cleanup.authorityEstablished, false);
        assert.deepEqual(error.physicalExecution.cleanup.knownRuntimeResiduals, []);
        assert.equal(error.physicalExecution.authority.established, false);
        assert.equal(error.physicalExecution.authority.unitName, null);
        assert.equal(error.physicalExecution.residualBlock, undefined);
        assert.equal(fs.existsSync(state.controlRoot), false);
    });

    await t.test('treats control-root removal failure as unverifiable cleanup', async () =>
    {
        const { adapter, state } = createStubSystemdExecution({
            finalizeTransition: { emitTerminal: true, loadState: 'not-found', members: [] },
            removeRootError: Object.assign(new Error('stub root removal failed'), { code: 'EACCES' })
        });
        const error = await adapter.run(options).catch((value) => value);
        assert.match(error.message, /cleanup is unverifiable/u);
        assert.match(error.physicalExecutionFinalizeError.message, /root removal failed/u);
        assert.equal(error.physicalExecution.cleanup.status, 'unverifiable');
        assert.equal(error.physicalExecution.controlRoot, state.controlRoot);
        assert.equal(fs.existsSync(state.controlRoot), true);
        fs.rmSync(state.controlRoot, { recursive: true, force: true });
    });
});

test('Linux systemd admission preserves short-lived commands and exec errors', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const capability = spawnSync('systemctl', ['--user', 'show-environment'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (capability.status !== 0)
    {
        t.skip(`systemd user cgroup authority unavailable: ${String(capability.stderr).trim()}`);
        return;
    }
    const cwd = temporaryRoot('systemd-preexec');
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const missingInterpreter = path.join(cwd, 'missing-interpreter');
    fs.writeFileSync(missingInterpreter, '#!/fsusblog/nonexistent/interpreter\n', {
        mode: 0o700
    });
    const firstPath = path.join(cwd, 'first');
    const secondPath = path.join(cwd, 'second');
    fs.mkdirSync(firstPath);
    fs.mkdirSync(secondPath);
    for (const name of ['loop', 'denied', 'busy', 'plain'])
    {
        fs.copyFileSync('/usr/bin/true', path.join(secondPath, name));
    }
    fs.symlinkSync('loop', path.join(firstPath, 'loop'));
    fs.writeFileSync(path.join(firstPath, 'denied'), 'not executable', { mode: 0o600 });
    fs.copyFileSync('/usr/bin/true', path.join(firstPath, 'busy'));
    const busyDescriptor = fs.openSync(path.join(firstPath, 'busy'), 'r+');
    t.after(() => fs.closeSync(busyDescriptor));
    fs.writeFileSync(path.join(firstPath, 'plain'), 'exit 7\n', { mode: 0o700 });
    const searchEnvironment = { ...process.env, PATH: `${firstPath}:${secondPath}` };
    const cases = [
        { name: 'immediate success', command: ['/usr/bin/true'], repeats: 16 },
        { name: 'immediate nonzero', command: ['/usr/bin/false'], exitCode: 1 },
        { name: 'missing executable', command: [path.join(cwd, 'absent')], code: 'ENOENT' },
        { name: 'missing shebang interpreter', command: [missingInterpreter], code: 'ENOENT' },
        { name: 'PATH ELOOP does not execute a later candidate', command: ['loop'], code: 'ELOOP', env: searchEnvironment },
        { name: 'PATH EACCES permits the next candidate', command: ['denied'], env: searchEnvironment },
        { name: 'PATH entries retain trailing slash semantics', command: ['denied'], env: { ...searchEnvironment, PATH: `${firstPath}/:${secondPath}/` } },
        { name: 'PATH ETXTBSY does not execute a later candidate', command: ['busy'], code: 'ETXTBSY', env: searchEnvironment },
        { name: 'ENOEXEC retains the native shell fallback', command: ['plain'], exitCode: 7, env: searchEnvironment }
    ];
    for (const entry of cases)
    {
        await t.test(entry.name, async () =>
        {
            const native = spawnSync(entry.command[0], entry.command.slice(1), {
                cwd,
                env: entry.env ?? process.env,
                detached: true,
                stdio: 'ignore'
            });
            assert.equal(native.error?.code, entry.code);
            if (!entry.code)
            {
                assert.equal(native.status, entry.exitCode ?? 0);
            }
            for (let attempt = 0; attempt < (entry.repeats ?? 1); attempt += 1)
            {
                const adapter = createPhysicalExecutionLinuxSystemdAdapter();
                let failure;
                const evidence = await adapter.run({
                    command: entry.command,
                    cwd,
                    env: entry.env ?? process.env,
                    policy: fastPolicy,
                    stdout: quiet,
                    stderr: quiet,
                    schema: physicalExecutionProcessTreeSchema
                }).catch((error) =>
                {
                    failure = error;
                    return error.physicalExecution;
                });
                assert.equal(evidence?.postObservation, 'zero-members');
                assert.equal(evidence?.cleanup.status, 'verified');
                assert.equal(evidence?.controlRoot, null);
                assert.equal(evidence?.logComplete, true);
                if (entry.code)
                {
                    assert.equal(failure?.code, entry.code);
                }
                else if (entry.exitCode)
                {
                    assert.equal(failure?.exitCode, entry.exitCode);
                    assert.equal(failure?.signal, null);
                }
                else
                {
                    assert.equal(failure, undefined);
                }
            }
        });
    }
});

test('Linux pre-exec barrier rejects forged and stale releases before target execution', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    async function readCarrier(file, supervisor)
    {
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(file))
        {
            assert.equal(supervisor.exitCode, null);
            assert.ok(Date.now() < deadline, `carrier deadline: ${path.basename(file)}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return fs.readFileSync(file, 'utf8').trim();
    }
    for (const mode of ['invalid-signature', 'stale-registration', 'valid'])
    {
        await t.test(mode, async () =>
        {
            const root = temporaryRoot('independent-preexec-barrier');
            const marker = path.join(root, 'target.json');
            const customizationMarker = path.join(root, 'customized');
            fs.writeFileSync(path.join(root, 'sitecustomize.py'),
                `open(${JSON.stringify(customizationMarker)}, "w").close()\n`);
            const environment = { ...process.env, PYTHONPATH: root, PYTHONHOME: path.join(root, 'missing-home') };
            const command = [process.execPath, '-e',
                `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({path:process.env.PYTHONPATH,home:process.env.PYTHONHOME,args:process.argv.slice(1)}))`,
                '', 'argument with spaces'];
            const keys = generateKeyPairSync('ed25519');
            for (const [name, value] of Object.entries({
                command,
                environment,
                admission: {
                    authorityId: mode,
                    python: process.env.FSUSBLOG_PYTHON ?? 'python3',
                    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' })
                }
            }))
            {
                fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify(value), { mode: 0o600 });
            }
            const supervisor = spawn(process.execPath, [
                fileURLToPath(new URL('../../tools/test/physical-execution-linux-systemd-bootstrap.mjs', import.meta.url)), root
            ], { env: environment, stdio: 'ignore' });
            const terminal = new Promise((resolve) => supervisor.once('exit', resolve));
            let helperPid;
            try
            {
                await readCarrier(path.join(root, 'ready'), supervisor);
                fs.writeFileSync(path.join(root, 'start'), 'start\n', { mode: 0o600 });
                const registration = await readCarrier(path.join(root, 'child.json'), supervisor);
                const observed = JSON.parse(registration);
                helperPid = observed.pid;
                assert.equal(collectProcessIdentity(helperPid).status, 'verified');
                assert.deepEqual(observed.command, command);
                assert.equal(observed.environmentDigest, `sha256:${createHash('sha256').update(JSON.stringify(environment)).digest('hex')}`);
                assert.equal(fs.existsSync(marker), false);
                assert.equal(fs.existsSync(customizationMarker), false);
                const released = mode === 'stale-registration'
                    ? JSON.stringify({ ...observed, nonce: 'b'.repeat(64) }) : registration;
                const signingKey = mode === 'invalid-signature'
                    ? generateKeyPairSync('ed25519').privateKey : keys.privateKey;
                fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({
                    registration: released,
                    signature: sign(null, Buffer.from(released), signingKey).toString('base64')
                }), { mode: 0o600 });
                const result = JSON.parse(await readCarrier(path.join(root, 'result.json'), supervisor));
                if (mode === 'valid')
                {
                    assert.equal(result.exitCode, 0);
                    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), {
                        path: root, home: environment.PYTHONHOME, args: ['', 'argument with spaces']
                    });
                }
                else
                {
                    assert.match(result.spawnError.message, /release signature is invalid/u);
                    assert.equal(fs.existsSync(marker), false);
                }
                assert.equal(await waitForProcessAbsence(helperPid, 1000), true);
                assert.equal(fs.existsSync(customizationMarker), false);
            }
            finally
            {
                if (helperPid && processExists(helperPid))
                {
                    process.kill(-helperPid, 'SIGKILL');
                }
                fs.writeFileSync(path.join(root, 'finalize'), 'finalize\n', { mode: 0o600 });
                supervisor.kill('SIGTERM');
                await terminal;
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    }
});

test('Linux systemd admission rejects a changed target environment carrier', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const root = temporaryRoot('preexec-environment-admission');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const marker = path.join(root, 'target');
    const adapter = createPhysicalExecutionLinuxSystemdAdapter({
        spawnProcess(executable, args, options)
        {
            const environmentFile = path.join(args.at(-1), 'environment.json');
            const environment = JSON.parse(fs.readFileSync(environmentFile, 'utf8'));
            fs.writeFileSync(environmentFile, JSON.stringify({ ...environment, TARGET_VALUE: 'changed' }));
            return spawn(executable, args, options);
        }
    });
    const failure = await adapter.run({
        command: ['/bin/sh', '-c', `touch ${JSON.stringify(marker)}`],
        cwd: root, env: { ...process.env, TARGET_VALUE: 'original' },
        policy: fastPolicy, stdout: quiet, stderr: quiet,
        schema: physicalExecutionProcessTreeSchema
    }).catch((error) => error);
    assert.match(failure.message, /pre-exec command admission is invalid/u);
    assert.equal(failure.physicalExecution.postObservation, 'zero-members');
    assert.equal(failure.physicalExecution.cleanup.status, 'verified');
    assert.equal(fs.existsSync(marker), false);
});

test('Linux systemd abort before admission never executes the target', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const root = temporaryRoot('preexec-admission-abort');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const marker = path.join(root, 'target');
    const controller = new AbortController();
    let observed = false;
    const adapter = createPhysicalExecutionLinuxSystemdAdapter({
        readProcessGroupIdentity(pid)
        {
            const identity = collectProcessGroupOrJobIdentity(pid, { platform: 'linux' });
            observed = true;
            assert.equal(fs.existsSync(marker), false);
            controller.abort(new Error('abort before admission release'));
            return identity;
        }
    });
    const failure = await adapter.run({
        command: ['/bin/sh', '-c', `touch ${JSON.stringify(marker)}`],
        cwd: root,
        env: process.env,
        signal: controller.signal,
        policy: fastPolicy,
        stdout: quiet,
        stderr: quiet,
        schema: physicalExecutionProcessTreeSchema
    }).catch((error) => error);
    assert.equal(observed, true);
    assert.match(failure.message, /abort before admission release/u);
    assert.equal(failure.physicalExecution.postObservation, 'zero-members');
    assert.equal(failure.physicalExecution.cleanup.status, 'verified');
    assert.equal(fs.existsSync(marker), false);
});

test('Linux systemd release carrier stays unpublished until its JSON bytes are complete', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const capability = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' });
    if (capability.status !== 0)
    {
        t.skip('systemd user authority unavailable');
        return;
    }
    const cwd = temporaryRoot('systemd-atomic-release');
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    let controlRoot;
    let observedWrites = 0;
    const adapter = createPhysicalExecutionLinuxSystemdAdapter({
        spawnProcess(executable, args, options)
        {
            controlRoot = args.at(-1);
            return spawn(executable, args, options);
        }
    });
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = (descriptor, ...args) =>
    {
        if (Number.isInteger(descriptor) && controlRoot)
        {
            const file = fs.readlinkSync(`/proc/self/fd/${descriptor}`);
            if (path.dirname(file) === controlRoot && path.basename(file).startsWith('release.json'))
            {
                observedWrites++;
                assert.equal(fs.existsSync(path.join(controlRoot, 'release.json')), false,
                    'the bootstrap must not observe the release carrier before serialization finishes');
            }
        }
        return originalWrite(descriptor, ...args);
    };
    try
    {
        const evidence = await adapter.run({
            command: [process.execPath, '-e', 'process.exit(0)'], cwd, env: process.env,
            policy: fastPolicy, stdout: quiet, stderr: quiet, schema: physicalExecutionProcessTreeSchema
        });
        assert.equal(observedWrites, 1);
        assert.equal(evidence.cleanup.status, 'verified');
        assert.equal(evidence.postObservation, 'zero-members');
        assert.equal(fs.existsSync(controlRoot), false);
    }
    finally
    {
        fs.writeFileSync = originalWrite;
    }
});

test('Linux systemd release publication refuses a crossed carrier without overwriting it', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const capability = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' });
    if (capability.status !== 0)
    {
        t.skip('systemd user authority unavailable');
        return;
    }
    const cwd = temporaryRoot('systemd-crossed-release');
    const marker = path.join(cwd, 'command-ran');
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    let controlRoot;
    let observedPublication = 0;
    let foreignBytesPreserved = false;
    const adapter = createPhysicalExecutionLinuxSystemdAdapter({
        spawnProcess(executable, args, options)
        {
            controlRoot = args.at(-1);
            return spawn(executable, args, options);
        }
    });
    const originalLink = fs.linkSync;
    fs.linkSync = (temporary, file) =>
    {
        if (controlRoot && file === path.join(controlRoot, 'release.json'))
        {
            observedPublication++;
            const foreignBytes = '{"foreign":true}\n';
            fs.writeFileSync(file, foreignBytes, { flag: 'wx', mode: 0o600 });
            try
            {
                return originalLink(temporary, file);
            }
            catch (error)
            {
                foreignBytesPreserved = fs.readFileSync(file, 'utf8') === foreignBytes;
                throw error;
            }
        }
        return originalLink(temporary, file);
    };
    try
    {
        await assert.rejects(adapter.run({
            command: [process.execPath, '-e',
                `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
            cwd, env: process.env, policy: fastPolicy, stdout: quiet, stderr: quiet,
            schema: physicalExecutionProcessTreeSchema
        }), (error) =>
        {
            assert.equal(error.code, 'EEXIST');
            assert.equal(error.physicalExecution.cleanup.status, 'verified');
            assert.equal(error.physicalExecution.postObservation, 'zero-members');
            return true;
        });
        assert.equal(observedPublication, 1);
        assert.equal(foreignBytesPreserved, true);
        assert.equal(fs.existsSync(marker), false);
        assert.equal(fs.existsSync(controlRoot), false);
    }
    finally
    {
        fs.linkSync = originalLink;
    }
});

test('Linux systemd adapter finalizes failed and cancelled supervisors without control-root or unit leaks', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const capability = spawnSync('systemctl', ['--user', 'show-environment'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (capability.status !== 0)
    {
        t.skip(`systemd user cgroup authority unavailable: ${String(capability.stderr).trim()}`);
        return;
    }
    const roots = [];
    const units = [];
    const adapter = createPhysicalExecutionLinuxSystemdAdapter({
        spawnProcess(executable, args, options)
        {
            roots.push(args.at(-1));
            units.push(args.find((argument) => argument.startsWith('--unit=')).slice('--unit='.length));
            return spawn(executable, args, options);
        }
    });
    const options = {
        cwd: temporaryRoot('systemd-terminal-cleanup'),
        env: process.env,
        policy: fastPolicy,
        stdout: quiet,
        stderr: quiet,
        schema: physicalExecutionProcessTreeSchema
    };
    t.after(() => fs.rmSync(options.cwd, { recursive: true, force: true }));

    await assert.rejects(adapter.run({
        ...options,
        command: [process.execPath, '-e', 'process.exit(1)']
    }), /command failed \(exit 1\)/u);

    const controller = new AbortController();
    const readiness = readinessSink();
    const cancellation = adapter.run({
        ...options,
        command: [process.execPath, '-e', "console.log('ready');setInterval(()=>{},1000)"],
        signal: controller.signal,
        stdout: readiness.sink
    });
    await readiness.ready;
    controller.abort(Object.assign(new Error('cancelled systemd cleanup'), {
        name: 'AbortError',
        signal: 'SIGTERM'
    }));
    await assert.rejects(cancellation, { name: 'AbortError' });

    assert.deepEqual(roots.map((root) => fs.existsSync(root)), [false, false]);
    for (const unit of units)
    {
        const state = spawnSync('systemctl', [
            '--user',
            'show',
            unit,
            '--property=LoadState',
            '--value'
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        });
        assert.equal(state.status, 0, `${unit} LoadState query was unverifiable`);
        assert.equal(state.stdout.trim(), 'not-found', `${unit} remained loaded`);
    }

    let spawnErrorRoot;
    const spawnErrorAdapter = createPhysicalExecutionLinuxSystemdAdapter({
        spawnProcess(_executable, _args, options)
        {
            spawnErrorRoot = _args.at(-1);
            return spawn('/fsusblog/physical-execution/missing-systemd-run', [], options);
        }
    });
    await assert.rejects(spawnErrorAdapter.run({
        ...options,
        command: [process.execPath, '-e', 'process.exit(0)']
    }), { code: 'ENOENT' });
    assert.equal(fs.existsSync(spawnErrorRoot), false);
});

test('Linux cgroup authority contains a setsid daemon holding a port and inherited output FD', {
    skip: process.platform !== 'linux'
}, async (t) =>
{
    const capability = spawnSync('systemctl', ['--user', 'show-environment'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (capability.status !== 0)
    {
        t.skip(`systemd user cgroup authority unavailable: ${String(capability.stderr).trim()}`);
        return;
    }
    const root = temporaryRoot('daemon-port-fd');
    const marker = path.join(root, 'daemon.json');
    const daemonSource = [
        "const fs=require('fs'),net=require('net')",
        "process.on('SIGTERM',()=>{})",
        "const server=net.createServer(()=>{})",
        "server.listen(0,'127.0.0.1',()=>{",
        "fs.writeFileSync(process.env.FSUSBLOG_DAEMON_MARKER,JSON.stringify({pid:process.pid,port:server.address().port}))",
        "console.log('daemon-ready')",
        "})",
        "setInterval(()=>{},1000)"
    ].join(';');
    const parentSource = [
        "const{spawn}=require('child_process'),fs=require('fs')",
        `spawn('setsid',[process.execPath,'-e',${JSON.stringify(daemonSource)}],{detached:true,stdio:['ignore','inherit','inherit'],env:{...process.env,FSUSBLOG_DAEMON_MARKER:${JSON.stringify(marker)}}}).unref()`,
        `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);console.log('ready')}},5)`,
        "setInterval(()=>{},1000)"
    ].join(';');
    const controller = new AbortController();
    const readiness = readinessSink();
    const execution = runPhysicalExecution({
        command: [process.execPath, '-e', parentSource],
        signal: controller.signal,
        residualRoot: path.join(root, 'residuals'),
        policy: { ...fastPolicy, gracefulTerminationMs: 250 },
        stdout: readiness.sink,
        stderr: quiet
    });
    await readiness.ready;
    const daemon = JSON.parse(fs.readFileSync(marker, 'utf8'));
    controller.abort(Object.assign(new Error('daemon cancellation'), {
        name: 'AbortError',
        signal: 'SIGTERM'
    }));
    const error = await execution.catch((value) => value);
    assert.equal(error.physicalExecution.authority.kind, 'linux-cgroup-process-group');
    assert.equal(
        error.physicalExecution.authority.processGroup.groupId,
        error.physicalExecution.authority.processGroup.leaderPid
    );
    assert.equal(error.physicalExecution.postObservation, 'zero-members');
    assert.ok(error.physicalExecution.processInventory.some((entry) => entry.pid === daemon.pid));
    assert.equal(processExists(daemon.pid), false);
    await assert.rejects(new Promise((resolve, reject) =>
    {
        const socket = net.connect({ host: '127.0.0.1', port: daemon.port });
        socket.setTimeout(250);
        socket.once('connect', () =>
        {
            socket.destroy();
            resolve();
        });
        socket.once('error', reject);
        socket.once('timeout', () =>
        {
            socket.destroy();
            reject(new Error('connection timed out after daemon termination'));
        });
    }));
});
