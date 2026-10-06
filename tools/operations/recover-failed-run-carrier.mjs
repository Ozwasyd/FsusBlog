import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { identity, parsePlanCli, readFrozenPlan, readRegular, requireCanonicalOwnedPath, requireHeldTaskLock, requireInside, writeNewJson } from './local-task-plan.mjs';

function closed(value, keys) {
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('closed carrier record required');
}
function positive(value) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('positive bounded carrier limit required');
}

/** Decode only the fixed QCOW header and bounded backing name, never resume VM state. */
export function inspectQcow(fd, expectedBacking) {
    const header = Buffer.alloc(104);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || header.readUInt32BE(0) !== 0x514649fb || header.readUInt32BE(4) !== 3 || header.readBigUInt64BE(72) !== 0n) throw new Error('QCOW v3 clean header required');
    const length = header.readUInt32BE(16);
    const offset = header.readBigUInt64BE(8);
    const virtualSize = header.readBigUInt64BE(24);
    if (length > 1023 || offset > BigInt(Number.MAX_SAFE_INTEGER) || virtualSize <= 0n || virtualSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('QCOW header bound refused');
    const bytes = Buffer.alloc(length);
    if (length && fs.readSync(fd, bytes, 0, length, Number(offset)) !== length) throw new Error('short backing read');
    const backing = length ? bytes.toString('utf8') : null;
    if (backing !== expectedBacking) throw new Error('QCOW backing ancestry mismatch');
    return { backing, virtualSize: String(virtualSize) };
}

/** Keep exact read-only descriptors and recheck both names and FD epochs before and after use. */
export function holdImageCustody(images, taskRoot) {
    const held = [];
    function verify() {
        for (const item of held) {
            const named = identity(requireCanonicalOwnedPath(item.file, { insideRoot: taskRoot }));
            const descriptor = identity(fs.fstatSync(item.fd, { bigint: true }));
            if (!isDeepStrictEqual(named, item.identity) || !isDeepStrictEqual(descriptor, item.identity)) throw new Error('held image physical epoch drift');
        }
    }
    function seal(item) {
        verify();
        const hash = crypto.createHash('sha256');
        const block = Buffer.alloc(65536);
        const size = Number(item.identity.size);
        for (let offset = 0; offset < size;) {
            const length = fs.readSync(item.fd, block, 0, Math.min(block.length, size - offset), offset);
            if (!length) throw new Error('held image short seal');
            hash.update(block.subarray(0, length));
            offset += length;
        }
        verify();
        if (hash.digest('hex') !== item.sha256) throw new Error('held image SHA drift');
    }
    function close(primary) {
        let first = primary;
        const errors = [];
        for (const item of held) {
            try { fs.closeSync(item.fd); } catch (error) { errors.push(error.message); first ??= error; }
        }
        if (!primary && first) throw first;
        return errors;
    }
    try {
        const names = new Set();
        for (const image of images) {
            closed(image, ['name', 'file', 'sha256', 'identity', 'backing', 'parent']);
            if (!/^[a-z][a-z0-9-]*$/.test(image.name) || names.has(image.name) || image.parent !== null && !names.has(image.parent) || image.parent === null && image.backing !== null || image.parent !== null && typeof image.backing !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256)) throw new Error('ordered unique image ancestry required');
            names.add(image.name);
            const current = identity(requireCanonicalOwnedPath(image.file, { insideRoot: taskRoot }));
            if (!isDeepStrictEqual(current, image.identity) || !Number.isSafeInteger(Number(current.size))) throw new Error('current image epoch binding required');
            const fd = fs.openSync(image.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const item = { ...image, fd };
            held.push(item);
            verify();
            Object.assign(item, inspectQcow(fd, image.backing));
            if (item.parent !== null) {
                const parent = held.find(member => member.name === item.parent);
                const backingPath = path.resolve(path.dirname(item.file), item.backing);
                if (backingPath !== parent.file || item.virtualSize !== parent.virtualSize) throw new Error('physical backing parent/virtual size mismatch');
            }
            seal(item);
        }
        return { held, verify, seal: () => held.forEach(seal), close };
    } catch (error) { close(error); throw error; }
}

export function inspectAncestry(roster, taskRoot) {
    let previous = null;
    return roster.map(item => {
        closed(item, ['file', 'sha256', 'parentSha256']);
        requireInside(taskRoot, item.file);
        const read = readRegular(item.file, 1024 * 1024);
        if (read.sha256 !== item.sha256 || item.parentSha256 !== previous) throw new Error('failed receipt ancestry SHA mismatch');
        const actual = JSON.parse(read.bytes);
        if (previous !== null && actual.parentActualSha !== previous || !actual.childTerminal || actual.failedCheckpointResume === true) throw new Error('failed receipt ancestry/terminal refusal');
        for (const key of ['Images', 'Seed', 'Shares', 'Toolchain']) {
            if (!Object.hasOwn(actual, `before${key}`) || !Object.hasOwn(actual, `after${key}`) || !isDeepStrictEqual(actual[`before${key}`], actual[`after${key}`])) throw new Error('failed receipt retained input closure unavailable');
        }
        previous = item.sha256;
        return { file: item.file, sha256: read.sha256, firstFailure: actual.firstFailure ?? null, originalCliTerminal: 'UNKNOWN', qualificationInherited: false };
    });
}

export function readOnlyBlockArguments(held) {
    const args = [];
    held.forEach((item, index) => {
        args.push('-blockdev', JSON.stringify({ driver: 'file', filename: `/proc/self/fd/${index + 3}`, 'node-name': `${item.name}-file`, 'read-only': true }));
        args.push('-blockdev', JSON.stringify({ driver: 'qcow2', file: `${item.name}-file`, backing: item.parent, 'node-name': item.name, 'read-only': true }));
    });
    return args;
}

function census(files) {
    const unknown = [];
    for (const pid of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value) && Number(value) !== process.pid)) {
        try {
            const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
            if (/^qemu-system|^qemu-kvm|^qemu-img$/.test(comm)) throw new Error(`live QEMU/image tool exists: ${pid}`);
            if (fs.statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
            for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
                try { if (files.includes(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))) throw new Error(`retained input already open: ${pid}`); }
                catch (error) { if (error.code === 'ENOENT') continue; if (['EACCES', 'EPERM'].includes(error.code)) unknown.push({ pid, fd, code: error.code }); else throw error; }
            }
        } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; if (['EACCES', 'EPERM'].includes(error.code)) unknown.push({ pid, code: error.code }); else throw error; }
    }
    return unknown;
}

/** Bound raw bytes while observing original argv, signal forwarding and terminal cleanup. */
export async function runObserved(file, args, { runRoot, cwd = runRoot, env, descriptors = [], limits, guard = () => {}, executions, signals, onSpawn = () => {} }) {
    for (const key of ['logBytes', 'deadlineMs', 'killGraceMs', 'pollIntervalMs']) positive(limits[key]);
    let stdoutFd;
    let stderrFd;
    let child;
    let failure;
    let timer;
    let interval;
    let killTimer;
    const listeners = [];
    try {
        requireCanonicalOwnedPath(runRoot, { directory: true });
        const index = executions.length;
        const logs = { stdout: path.join(runRoot, `execution-${index}-stdout.log`), stderr: path.join(runRoot, `execution-${index}-stderr.log`) };
        const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
        stdoutFd = fs.openSync(logs.stdout, flags, 0o600);
        stderrFd = fs.openSync(logs.stderr, flags, 0o600);
        child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', ...descriptors] });
        const actual = { file, args, pid: child.pid ?? null, started: Number.isSafeInteger(child.pid), terminal: false, logs };
        executions.push(actual);
        function stop(signal) {
            signals.push(signal);
            if (!actual.terminal && child.pid) {
                try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') failure ??= error; }
            }
        }
        function refuse(error, signal = 'SIGTERM') {
            failure ??= error;
            stop(signal);
            killTimer ??= setTimeout(() => stop('SIGKILL'), limits.killGraceMs);
        }
        for (const signal of ['SIGTERM', 'SIGINT']) {
            const listener = () => refuse(new Error(`caller ${signal}`), signal);
            process.on(signal, listener);
            listeners.push([signal, listener]);
        }
        const counts = { stdout: 0, stderr: 0 };
        for (const [name, fd] of [['stdout', stdoutFd], ['stderr', stderrFd]]) {
            child[name].on('data', bytes => {
                try {
                    const remaining = Math.max(0, limits.logBytes - counts[name]);
                    if (remaining) fs.writeSync(fd, bytes.subarray(0, remaining));
                    counts[name] += bytes.length;
                    if (counts[name] > limits.logBytes) refuse(new Error('raw log byte bound'));
                } catch (error) { refuse(error); }
            });
        }
        timer = setTimeout(() => refuse(new Error('carrier operational deadline')), limits.deadlineMs);
        interval = setInterval(() => { try { guard(); } catch (error) { refuse(error); } }, limits.pollIntervalMs);
        try { onSpawn(child); } catch (error) { refuse(error); }
        child.on('error', error => { failure ??= error; });
        await new Promise(resolve => child.on('close', (status, signal) => { Object.assign(actual, { terminal: true, status, signal, rawBytes: counts }); resolve(); }));
        if (failure) throw failure;
        if (actual.status !== 0 || actual.signal) throw new Error(`original tool terminal ${actual.status}/${actual.signal}`);
    } catch (error) {
        failure ??= error;
        throw error;
    } finally {
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearInterval(interval);
        for (const [signal, listener] of listeners) process.off(signal, listener);
        const closeErrors = [];
        for (const fd of [stdoutFd, stderrFd].filter(value => value !== undefined)) { try { fs.closeSync(fd); } catch (error) { closeErrors.push(error); } }
        if (failure && closeErrors.length) failure.closeFailures = closeErrors.map(error => error.message);
        if (!failure && closeErrors.length) throw closeErrors[0];
    }
}

export async function main(argv) {
    const cli = parsePlanCli(argv, ['boot-fresh-log-carrier']);
    const { plan, planSha256 } = readFrozenPlan(cli.planPath, cli.planSha256, ['taskLock', 'sourceSha256', 'sourceInputs', 'images', 'inputs', 'toolchainAliases', 'shares', 'ancestry', 'boot', 'limits']);
    if (readRegular(fileURLToPath(import.meta.url)).sha256 !== plan.sourceSha256) throw new Error('current launcher source drift');
    const expectedSourceInputs = ['./local-task-plan.mjs'].map(name => fileURLToPath(new URL(name, import.meta.url)));
    if (!Array.isArray(plan.sourceInputs) || plan.sourceInputs.length !== expectedSourceInputs.length) throw new Error('complete current source helper closure required');
    for (const file of expectedSourceInputs) {
        const item = plan.sourceInputs.find(member => member?.file === file);
        closed(item, ['file', 'sha256']);
        if (readRegular(file).sha256 !== item.sha256) throw new Error('current source helper SHA drift');
    }
    requireCanonicalOwnedPath(plan.taskLock, { insideRoot: plan.taskRoot });
    if (!Array.isArray(plan.images) || !plan.images.length || !Array.isArray(plan.inputs) || !Array.isArray(plan.shares) || !Array.isArray(plan.ancestry) || !plan.ancestry.length) throw new Error('explicit carrier input rosters required');
    closed(plan.boot, ['qemuImg', 'qemuSystem', 'seed', 'firmware', 'firmwareDirectory', 'libraryDirectory', 'moduleDirectory', 'guestMemoryMiB', 'cpus', 'recoveryPort']);
    closed(plan.limits, ['minMemoryBytes', 'minDiskBytes', 'headroomBytes', 'cowBytes', 'logBytes', 'deadlineMs', 'bootReserveBytes', 'killGraceMs', 'pollIntervalMs']);
    Object.values(plan.limits).forEach(positive);
    positive(plan.boot.guestMemoryMiB);
    positive(plan.boot.cpus);
    if (!Number.isSafeInteger(plan.boot.recoveryPort) || plan.boot.recoveryPort < 1 || plan.boot.recoveryPort > 65535) throw new Error('explicit loopback recovery port required');
    const custody = holdImageCustody(plan.images, plan.taskRoot);
    let failure;
    let runRoot;
    let beforeInputs;
    let afterInputs;
    let beforeShares;
    let afterShares;
    let beforeAliases;
    let afterAliases;
    let ancestry;
    let afterAncestry;
    let unknown = [];
    const executions = [];
    const signals = [];
    let seedFd;
    const inspectInputs = () => plan.inputs.map(item => {
        closed(item, ['file', 'sha256']);
        requireInside(plan.taskRoot, item.file);
        const actual = readRegular(item.file);
        if (actual.sha256 !== item.sha256) throw new Error('boot toolchain/input hash drift');
        return { file: item.file, sha256: actual.sha256, identity: actual.identity };
    });
    const inspectAliases = () => {
        if (!Array.isArray(plan.toolchainAliases)) throw new Error('explicit toolchain alias roster required');
        const names = new Set();
        return plan.toolchainAliases.map(item => {
            closed(item, ['file', 'target', 'identity']);
            requireInside(plan.taskRoot, item.file);
            requireCanonicalOwnedPath(path.dirname(item.file), { directory: true, insideRoot: plan.taskRoot });
            const info = fs.lstatSync(item.file, { bigint: true });
            if (!info.isSymbolicLink() || info.uid !== BigInt(process.getuid()) || names.has(item.file) || !isDeepStrictEqual(identity(info), item.identity) || fs.readlinkSync(item.file) !== item.target) throw new Error('bound toolchain alias physical epoch drift');
            names.add(item.file);
            const target = fs.realpathSync(item.file);
            requireInside(plan.taskRoot, target);
            if (!plan.inputs.some(input => input.file === target) || !['firmwareDirectory', 'libraryDirectory', 'moduleDirectory'].some(key => target.startsWith(`${plan.boot[key]}/`))) throw new Error('toolchain alias target outside sealed toolchain directory/roster');
            return { ...item, resolved: target };
        });
    };
    const inspectShares = () => plan.shares.map(item => {
        closed(item, ['tag', 'directory', 'identity']);
        if (!/^[a-z][a-z0-9-]*$/.test(item.tag)) throw new Error('share tag refusal');
        const current = identity(requireCanonicalOwnedPath(item.directory, { directory: true, insideRoot: plan.taskRoot }));
        if (!isDeepStrictEqual(current, item.identity)) throw new Error('readonly share physical epoch drift');
        return { ...item };
    });
    try {
        beforeInputs = inspectInputs();
        beforeAliases = inspectAliases();
        beforeShares = inspectShares();
        ancestry = inspectAncestry(plan.ancestry, plan.taskRoot);
        if (!ancestry.at(-1).firstFailure) throw new Error('last bound parent must be an actual failed receipt');
        for (const key of ['qemuImg', 'qemuSystem', 'seed', 'firmware']) if (!beforeInputs.some(item => item.file === plan.boot[key])) throw new Error('boot file absent from frozen toolchain/input roster');
        const inputNames = new Set(beforeInputs.map(item => item.file));
        if (inputNames.size !== beforeInputs.length) throw new Error('duplicate toolchain/input roster');
        const visited = new Set();
        function requireRosterClosure(directory) {
            if (visited.has(directory)) return;
            visited.add(directory);
            if (visited.size > 10000) throw new Error('toolchain roster count bound');
            requireCanonicalOwnedPath(directory, { directory: true, insideRoot: plan.taskRoot });
            for (const name of fs.readdirSync(directory)) {
                const file = path.join(directory, name);
                const info = fs.lstatSync(file);
                if (info.isDirectory()) requireRosterClosure(file);
                else if (info.isSymbolicLink()) { if (!beforeAliases.some(item => item.file === file)) throw new Error('unbound toolchain alias refused'); }
                else if (!info.isFile() || !inputNames.has(file)) throw new Error('unsealed toolchain member refused');
            }
        }
        for (const key of ['firmwareDirectory', 'libraryDirectory', 'moduleDirectory']) requireRosterClosure(plan.boot[key]);
        seedFd = fs.openSync(plan.boot.seed, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const seedIdentity = beforeInputs.find(item => item.file === plan.boot.seed).identity;
        if (!isDeepStrictEqual(identity(fs.fstatSync(seedFd, { bigint: true })), seedIdentity)) throw new Error('seed read-only FD epoch drift');
        if (cli.mode === 'boot-fresh-log-carrier') {
            requireHeldTaskLock(plan.taskLock);
            unknown = census([...custody.held.map(item => item.file), ...plan.inputs.map(item => item.file)]);
            function guard(initial = false) {
                const match = /^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
                if (!match) throw new Error('host memory observation unavailable');
                const disk = fs.statfsSync(plan.taskRoot, { bigint: true });
                const memoryAvailable = BigInt(match[1]) * 1024n;
                const memoryRequired = BigInt(plan.limits.minMemoryBytes) + (initial ? BigInt(plan.boot.guestMemoryMiB) * 1024n * 1024n + BigInt(plan.limits.headroomBytes) : 0n);
                const diskRequired = BigInt(plan.limits.minDiskBytes) + (initial ? BigInt(plan.limits.cowBytes) + BigInt(plan.limits.logBytes) * 3n + BigInt(plan.limits.bootReserveBytes) : 0n);
                if (memoryAvailable < memoryRequired || disk.bavail * disk.bsize < diskRequired) {
                    const error = new Error('task carrier resource floor refusal');
                    error.resourceObservation = { memoryAvailableBytes: String(memoryAvailable), memoryRequired: String(memoryRequired), rootAvailableBytes: String(disk.bavail * disk.bsize), diskRequired: String(diskRequired) };
                    throw error;
                }
                custody.verify();
                if (!isDeepStrictEqual(identity(fs.fstatSync(seedFd, { bigint: true })), seedIdentity)) throw new Error('seed held FD epoch drift');
                if (runRoot) for (const name of ['overlay.qcow2', 'serial.log', ...executions.flatMap(item => Object.values(item.logs ?? {}).map(file => path.basename(file)))]) {
                    const file = path.join(runRoot, name);
                    if (!fs.existsSync(file)) continue;
                    const stat = fs.lstatSync(file);
                    if (name === 'overlay.qcow2' ? stat.blocks * 512 > plan.limits.cowBytes : stat.size > plan.limits.logBytes) throw new Error('carrier COW/raw log bound');
                }
            }
            guard(true);
            runRoot = fs.mkdtempSync(path.join(plan.taskRoot, 'failed-run-carrier-'));
            fs.chmodSync(runRoot, 0o700);
            const overlay = path.join(runRoot, 'overlay.qcow2');
            const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LD_LIBRARY_PATH: plan.boot.libraryDirectory, QEMU_MODULE_DIR: plan.boot.moduleDirectory };
            const options = { runRoot, env, descriptors: [...custody.held.map(item => item.fd), seedFd], limits: plan.limits, guard, executions, signals };
            const parent = custody.held.at(-1);
            await runObserved(plan.boot.qemuImg, ['create', '-u', '-f', 'qcow2', '-F', 'qcow2', '-b', `/proc/self/fd/${custody.held.length + 2}`, overlay, parent.virtualSize], options);
            const args = ['-machine', 'pc,smm=off', '-accel', 'tcg,thread=multi', '-cpu', 'max', '-smp', String(plan.boot.cpus), '-m', String(plan.boot.guestMemoryMiB), '-L', plan.boot.firmwareDirectory, '-bios', plan.boot.firmware, ...readOnlyBlockArguments(custody.held), '-blockdev', JSON.stringify({ driver: 'file', filename: overlay, 'node-name': 'task-overlay-file' }), '-blockdev', JSON.stringify({ driver: 'qcow2', file: 'task-overlay-file', backing: parent.name, 'node-name': 'task-overlay' }), '-device', 'virtio-blk-pci,drive=task-overlay', '-drive', `file=/proc/self/fd/${custody.held.length + 3},format=raw,if=ide,media=cdrom,readonly=on`, '-netdev', `user,id=task-recovery,restrict=on,hostfwd=tcp:127.0.0.1:${plan.boot.recoveryPort}-:22`, '-device', 'virtio-net-pci,netdev=task-recovery,romfile=', '-display', 'none', '-vga', 'none', '-serial', `file:${runRoot}/serial.log`, '-monitor', 'none', '-qmp', `unix:${runRoot}/qmp.sock,server=on,wait=off`, '-pidfile', path.join(runRoot, 'qemu.pid')];
            for (const item of plan.shares) args.push('-fsdev', `local,id=${item.tag},path=${item.directory},security_model=none,readonly=on`, '-device', `virtio-9p-pci,fsdev=${item.tag},mount_tag=${item.tag}`);
            guard(true);
            await runObserved(plan.boot.qemuSystem, args, options);
        }
    } catch (error) { failure = error; }
    finally {
        try {
            custody.seal();
            afterInputs = inspectInputs();
            afterAliases = inspectAliases();
            afterShares = inspectShares();
            afterAncestry = inspectAncestry(plan.ancestry, plan.taskRoot);
            if (beforeAliases && !isDeepStrictEqual(beforeAliases, afterAliases) || beforeInputs && !isDeepStrictEqual(beforeInputs, afterInputs) || beforeShares && !isDeepStrictEqual(beforeShares, afterShares) || ancestry && !isDeepStrictEqual(ancestry, afterAncestry)) throw new Error('carrier input/receipt before-after drift');
        } catch (error) { if (failure) failure.verificationFailure = error.message; else failure = error; }
        let seedCloseError;
        if (seedFd !== undefined) {
            try {
                if (beforeInputs && !isDeepStrictEqual(identity(fs.fstatSync(seedFd, { bigint: true })), beforeInputs.find(item => item.file === plan.boot.seed).identity)) throw new Error('seed final held FD epoch drift');
            } catch (error) { failure ??= error; }
            try { fs.closeSync(seedFd); } catch (error) { seedCloseError = error.message; failure ??= error; }
        }
        const descriptorCloseErrors = custody.close(failure);
        if (seedCloseError) descriptorCloseErrors.push(seedCloseError);
        const result = { schema: 'fsusblog.failed-run-carrier.v1', mode: cli.mode, planSha256, runRoot: runRoot ?? null, beforeImages: plan.images, afterImages: failure?.verificationFailure ? null : plan.images, beforeInputs, afterInputs, beforeAliases, afterAliases, beforeShares, afterShares, ancestry, afterAncestry, executions, signals, descriptorCloseErrors, procCensusUnknown: unknown, childTerminal: executions.every(item => item.terminal), wholeProcessTreeZero: 'UNKNOWN', cleanupObligation: executions.some(item => item.started) ? 'exact task process/QMP recovery proof required' : null, resourceGeometry: { ...plan.limits, guestMemoryMiB: plan.boot.guestMemoryMiB, cpus: plan.boot.cpus }, firstFailure: failure ? { message: failure.message, resourceObservation: failure.resourceObservation ?? null, verificationFailure: failure.verificationFailure ?? null } : null, originalCliTerminal: 'UNKNOWN', failedCheckpointResume: false, autoSdkExecution: false, guestCommandsObservedByLauncher: false, partialPreparationQualified: false, qualificationEligible: false, custodyScope: 'Exact read-only image FDs, current hashes, ancestry and pre/post epochs; unreadable process census remains UNKNOWN.' };
        if (runRoot) writeNewJson(path.join(runRoot, 'environment.actual.json'), result);
        console.log(JSON.stringify(result));
    }
    return failure ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(status => { process.exitCode = status; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
