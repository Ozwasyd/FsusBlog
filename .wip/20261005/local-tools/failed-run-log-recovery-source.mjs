import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const qa = '/home/lyuaoss/projects/FsusBlog/.tmp/c86-isolated-qa.nEpdgY';
const task = '/home/lyuaoss/projects/FsusBlog/.tmp/batch-3664-local-validation-v2-20261004.1LnfcW';
const original = path.join(qa, 'qa-disk.qcow2');
const base = path.join(qa, 'debian-13-generic-amd64.qcow2');
const preparedData = path.join(task, 'c86-overlay-attempt-kVpNRf/overlay.qcow2');
const preparedDataSha = '5e6bf29c98a8f71c859df10fb054069d623d9ea75dd618f65161788312bbc0bd';
const preparedDataEpoch = '1791114942455805618';
const diagnosticData = path.join(task, 'c86-overlay-attempt-fSc1m1/overlay.qcow2');
const diagnosticDataSha = '6e926e90a4c54f7a5d548d49a0fa9c67cd672dcbc7c75097ed38103fa7b38012';
const diagnosticDataEpoch = '1791118155247250720';
const completedData = path.join(task, 'c86-overlay-attempt-eTGrQX/overlay.qcow2');
const completedDataSha = '88e0dfbee55d604457f3b6620efb8bd85527625ccfc7b626d7f9e266e846a10d';
const completedDataEpoch = '1791126317015046580';
const failedData = path.join(task, 'c86-overlay-attempt-BHOEW5/overlay.qcow2');
const failedDataSha = 'ed42c26d28a29deb2230f4f5e7d4c221f81bae5b9d7089e4824649a3b2c1a122';
const failedDataEpoch = '1791129692574818747';
const parentActualPath = path.join(task, 'c86-overlay-attempt-BHOEW5/environment.actual.json');
const parentActualSha = '68bbe39a84d5f33ec20d510bcf905becf744dfe8ae73d859df03b78833d120ae';
let parentActual, beforePreparedDataSha, afterPreparedDataSha, beforeDiagnosticDataSha, afterDiagnosticDataSha,
    beforeCompletedDataSha, afterCompletedDataSha, beforeFailedDataSha, afterFailedDataSha;
const images = [
    [original, 1190457, 8573353984, 0o644, base],
    [base, 1190397, 433651712, 0o664, null],
    [preparedData, 1865138, 236847104, 0o644, '/proc/self/fd/3'],
    [diagnosticData, 1865146, 194117632, 0o644, '/proc/self/fd/6'],
    [completedData, 1865253, 138543104, 0o644, '/proc/self/fd/7'],
    [failedData, 1865379, 501874688, 0o644, '/proc/self/fd/8']
];
const rootFloor = 1593835520n;
const hostMemoryFloor = 2147483648;
const guestMemoryBytes = 768 * 1024 * 1024;
const hostHeadroomBytes = 268 * 1024 * 1024;
const cowLimit = 64 * 1024 * 1024;
const bootReserveBytes = 40n * 1024n * 1024n;
const logLimit = 16 * 1024 * 1024;
const deadlineMs = 2700000;
// BOOT_ONLY_FAILED_V11_LOG_RECOVERY: no guest command, SDK/CLI, preparation or failed-checkpoint resume.
const seed = path.join(qa, 'seed.iso');
const shares = [
    ['qa-inputs', path.join(qa, 'inputs')],
    ['qa-sdk', '/mnt/dev-cache/lyuaoss/dotnet-10.0.302'],
    ['qa-nuget', '/mnt/dev-cache/lyuaoss/nuget-packages'],
    ['qa-feed', '/dev/shm/fsusblog-3652-real-sdk-20261003.msbqCp/offline-feed']
];
const packageManifest = path.join(qa, 'evidence/toolchain-packages.sha256');
const packageManifestSha = '5795a0a6b039f65c122b4de409cd532d4faa1ea2f501d7bc26c0bb14d278ed46';
const held = [];
let beforeToolchain, afterToolchain, beforeShares, afterShares, beforeSeed, afterSeed;
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    LD_LIBRARY_PATH: path.join(qa, 'toolchain/usr/lib/x86_64-linux-gnu'),
    QEMU_MODULE_DIR: path.join(qa, 'toolchain/usr/lib/x86_64-linux-gnu/qemu') };
let runRoot, controlRoot, child, firstFailure, beforeImages;
let afterImages;
let signals = [];
let started = false;
let childTerminal = false;
const executions = [];
const procCensusUnknown = [];
const metadataBaselineUnavailable = [];

function identity(file) {
    if (fs.realpathSync(file) !== file) throw Error(`noncanonical input: ${file}`);
    const s = fs.lstatSync(file);
    const epoch = fs.lstatSync(file, { bigint: true });
    if (BigInt(s.dev) !== epoch.dev || BigInt(s.ino) !== epoch.ino) throw Error('input changed during stat');
    if (!s.isFile() || s.uid !== 1000 || s.nlink !== 1) throw Error(`unexpected input identity: ${file}`);
    return { dev: s.dev, ino: s.ino, mode: s.mode & 0o7777, uid: s.uid, gid: s.gid,
        size: s.size, mtimeNs: epoch.mtimeNs.toString(), ctimeNs: epoch.ctimeNs.toString(), allocatedBytes: s.blocks * 512 };
}
function inspectImages() {
    return images.map(([file, inode, size, mode, backing]) => {
        const s = identity(file);
        if (s.dev !== 64771 || s.ino !== inode || s.size !== size || s.mode !== mode)
            throw Error(`retained image changed: ${file}`);
        if (file === preparedData && (s.mtimeNs !== preparedDataEpoch || s.ctimeNs !== preparedDataEpoch || s.allocatedBytes !== 462496 * 512))
            throw Error('prepared readonly data epoch changed');
        if (file === diagnosticData && (s.mtimeNs !== diagnosticDataEpoch || s.ctimeNs !== diagnosticDataEpoch || s.allocatedBytes !== 379024 * 512))
            throw Error('diagnostic readonly data epoch changed');
        if (file === completedData && (s.mtimeNs !== completedDataEpoch || s.ctimeNs !== completedDataEpoch || s.allocatedBytes !== 270480 * 512 || s.gid !== 1000))
            throw Error('completed readonly data epoch changed');
        if (file === failedData && (s.mtimeNs !== failedDataEpoch || s.ctimeNs !== failedDataEpoch || s.allocatedBytes !== 980136 * 512 || s.gid !== 1000))
            throw Error('failed readonly data epoch changed');
        const fd = fs.openSync(file, 'r');
        try {
            const h = Buffer.alloc(104);
            if (fs.readSync(fd, h, 0, h.length, 0) !== h.length || h.readUInt32BE(0) !== 0x514649fb ||
                h.readUInt32BE(4) !== 3 || h.readBigUInt64BE(72) !== 0n) throw Error('retained QCOW header refusal');
            const n = h.readUInt32BE(16), offset = h.readBigUInt64BE(8);
            if (n > 1023 || offset > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('backing-name bound refusal');
            const b = Buffer.alloc(n);
            if (n && fs.readSync(fd, b, 0, n, Number(offset)) !== n) throw Error('short backing-name read');
            if ((n ? b.toString('utf8') : null) !== backing) throw Error('unexpected retained backing chain');
            return { file, ...s, backing };
        } finally { fs.closeSync(fd); }
    });
}
function sealToolchain() {
    const result = [];
    const root = path.join(qa, 'toolchain');
    const roots = ['usr/bin/qemu-system-x86_64', 'usr/bin/qemu-img',
        'usr/lib/x86_64-linux-gnu', 'usr/share/qemu', 'usr/share/seabios'];
    let total = 0, entries = 0;
    const visited = new Set();
    function visit(file) {
        if (visited.has(file)) return;
        visited.add(file);
        if (++entries > 10000) throw Error('toolchain roster bound');
        const st = fs.lstatSync(file);
        if (st.isDirectory()) { for (const n of fs.readdirSync(file).sort()) visit(path.join(file, n)); return; }
        if (st.isSymbolicLink()) {
            const resolved = fs.realpathSync(file);
            if (!resolved.startsWith(root + '/')) throw Error('toolchain alias escapes retained prefix');
            result.push({ file, link: fs.readlinkSync(file), resolved }); visit(resolved); return;
        }
        if (!st.isFile() || st.uid !== 1000 || st.nlink !== 1) throw Error('unexpected toolchain member');
        total += st.size;
        if (total > 256 * 1024 * 1024) throw Error('toolchain byte bound');
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const before = fs.fstatSync(fd), hash = crypto.createHash('sha256'), b = Buffer.alloc(65536);
            let n; while ((n = fs.readSync(fd, b, 0, b.length, null))) hash.update(b.subarray(0, n));
            const after = fs.fstatSync(fd);
            if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
                before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('toolchain changed while sealing');
            result.push({ file, dev: after.dev, ino: after.ino, mode: after.mode & 0o7777,
                uid: after.uid, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, sha256: hash.digest('hex') });
        } finally { fs.closeSync(fd); }
    }
    if (crypto.createHash('sha256').update(fs.readFileSync(packageManifest)).digest('hex') !== packageManifestSha)
        throw Error('original toolchain package manifest changed');
    for (const relative of roots) visit(path.join(root, relative));
    return { packageManifest, packageManifestSha, entries: result, sealedBytes: total,
        scope: 'actual tool binary/private library/module/firmware identity, not revalidated archive extraction or host-library isolation' };
}
function inspectShares() {
    return shares.map(([tag, directory]) => {
        if (fs.realpathSync(directory) !== directory) throw Error('readonly share alias');
        const s = fs.lstatSync(directory);
        if (!s.isDirectory() || s.uid !== 1000) throw Error('readonly share owner/type');
        return { tag, directory, dev: s.dev, ino: s.ino, mode: s.mode & 0o7777, uid: s.uid };
    });
}
function requireNoLiveQemuOrImageOpen() {
    for (const id of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
        if (Number(id) === process.pid) continue;
        let stage = 'comm';
        try {
            const comm = fs.readFileSync('/proc/' + id + '/comm', 'utf8').trim();
            if (/^qemu-system|^qemu-kvm|^qemu-img$/.test(comm)) throw Error('live QEMU/image tool exists: ' + id);
            stage = 'owner';
            if (fs.statSync('/proc/' + id).uid !== 1000) continue;
            stage = 'fd-directory';
            for (const n of fs.readdirSync('/proc/' + id + '/fd')) {
                let link;
                try { link = fs.readlinkSync('/proc/' + id + '/fd/' + n); }
                catch (e) {
                    if (e.code === 'ENOENT') continue;
                    if (e.code === 'EACCES' || e.code === 'EPERM') {
                        procCensusUnknown.push({ pid: Number(id), stage: 'fd-link', fd: n, code: e.code });
                        continue;
                    }
                    throw e;
                }
                if ([original, base, seed, preparedData, diagnosticData, completedData, failedData].includes(link)) throw Error('retained input already open: ' + id);
            }
        } catch (e) {
            if (e.code === 'EACCES' || e.code === 'EPERM') procCensusUnknown.push({ pid: Number(id), stage, code: e.code });
            else if (e.code !== 'ENOENT' && e.code !== 'ESRCH') throw e;
        }
    }
}
function holdReadOnly(file) {
    const expected = identity(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    held.push({ file, fd, expected });
    const s = fs.fstatSync(fd);
    const epoch = fs.fstatSync(fd, { bigint: true });
    if (s.dev !== expected.dev || s.ino !== expected.ino || s.size !== expected.size ||
        epoch.mtimeNs.toString() !== expected.mtimeNs || epoch.ctimeNs.toString() !== expected.ctimeNs) throw Error('held input identity mismatch');
}
function requireHeldUnchanged() {
    for (const { file, fd, expected } of held) {
        const actual = identity(file), st = fs.fstatSync(fd);
        const epoch = fs.fstatSync(fd, { bigint: true });
        if (JSON.stringify(actual) !== JSON.stringify(expected) || st.dev !== expected.dev ||
            st.ino !== expected.ino || st.size !== expected.size || st.mode !== (fs.constants.S_IFREG | expected.mode) ||
            st.nlink !== 1 || epoch.mtimeNs.toString() !== expected.mtimeNs || epoch.ctimeNs.toString() !== expected.ctimeNs)
            throw Error('held retained input changed: ' + file);
    }
}
function readExpectedFailedParentActual() {
    const st = identity(parentActualPath);
    if (st.size > 1024 * 1024) throw Error('parent actual receipt bound');
    const bytes = fs.readFileSync(parentActualPath);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== parentActualSha) throw Error('parent actual bytes changed');
    const actual = JSON.parse(bytes.toString('utf8'));
    const fileIdentity = identity(parentActualPath);
    if (JSON.stringify(st) !== JSON.stringify(fileIdentity)) throw Error('parent actual changed while reading');
    const failure = actual.firstFailure;
    const observation = failure?.resourceObservation;
    if (actual.runRoot !== path.dirname(failedData) || failure?.name !== 'Error' ||
        failure?.message !== 'task VM resource floor refusal' || failure?.code !== null ||
        failure?.imageVerificationFailure !== null || actual.bootInputVerificationFailure !== null ||
        observation?.memoryAvailableBytes !== 2130616320 || observation?.memoryRequired !== 2147483648 ||
        observation?.rootAvailableBytes !== '2034167808' || observation?.diskRequired !== '1593835520' ||
        JSON.stringify(actual.signals) !== JSON.stringify(['SIGTERM']) || actual.childTerminal !== true ||
        !Array.isArray(actual.descriptorCloseErrors) || actual.descriptorCloseErrors.length !== 0 ||
        !Array.isArray(actual.executions) || actual.executions.length !== 2 ||
        actual.executions.some((e, i) => e.file !== path.join(qa, 'toolchain/usr/bin/' + (i ? 'qemu-system-x86_64' : 'qemu-img')) ||
            !e.started || !e.terminal || e.code !== 0 || e.signal !== null) ||
        JSON.stringify(actual.beforeImages) !== JSON.stringify(actual.afterImages) ||
        JSON.stringify(actual.beforeSeed) !== JSON.stringify(actual.afterSeed) ||
        JSON.stringify(actual.beforeShares) !== JSON.stringify(actual.afterShares) ||
        JSON.stringify(actual.beforeToolchain) !== JSON.stringify(actual.afterToolchain) ||
        actual.beforePreparedDataSha !== preparedDataSha || actual.afterPreparedDataSha !== preparedDataSha ||
        actual.beforeDiagnosticDataSha !== diagnosticDataSha || actual.afterDiagnosticDataSha !== diagnosticDataSha ||
        actual.beforeCompletedDataSha !== completedDataSha || actual.afterCompletedDataSha !== completedDataSha ||
        actual.parentActualPath !== path.join(task, 'c86-overlay-attempt-eTGrQX/environment.actual.json') ||
        actual.parentActualSha !== 'cfe0af02eb1e4893a93aed8bcdeae2a59d721aecf3bce020a37560612e8a487f')
        throw Error('expected failed parent/input-closure mismatch');
    return actual; // Preserve the exact failed environment; CLI terminal/preparation remain unqualified.
}
function sealPreparedData(file = preparedData, size = 236847104, expectedSha = preparedDataSha) {
    const item = held.find(x => x.file === file);
    if (!item) throw Error('prepared data descriptor unavailable');
    requireHeldUnchanged();
    const hash = crypto.createHash('sha256'), b = Buffer.alloc(65536);
    let offset = 0;
    while (offset < size) {
        const n = fs.readSync(item.fd, b, 0, Math.min(b.length, size - offset), offset);
        if (!n) throw Error('prepared data short seal');
        hash.update(b.subarray(0, n)); offset += n;
    }
    const digest = hash.digest('hex');
    requireHeldUnchanged();
    if (digest !== expectedSha) throw Error('prepared data whole-file SHA mismatch');
    return digest;
}
function resources() {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
    if (!match) throw Error('MemAvailable unavailable');
    const memoryAvailableBytes = Number(match[1]) * 1024;
    const stat = fs.statfsSync(task, { bigint: true });
    return { memoryAvailableBytes, rootAvailableBytes: (stat.bavail * stat.bsize).toString() };
}
function readHeldFailedVirtualSize() {
    const item = held.find(x => x.file === failedData);
    if (!item || beforeFailedDataSha !== failedDataSha) throw Error('failed data header is not sealed');
    requireHeldUnchanged();
    const headerField = Buffer.alloc(8);
    if (fs.readSync(item.fd, headerField, 0, headerField.length, 24) !== headerField.length)
        throw Error('failed readonly virtual size short read');
    const virtualSize = headerField.readBigUInt64BE(0);
    if (virtualSize <= 0n || virtualSize > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('failed readonly virtual size unavailable');
    requireHeldUnchanged();
    return virtualSize.toString();
}
function guard(beforeStart = false) {
    const r = resources();
    const memoryRequired = hostMemoryFloor + (beforeStart ? guestMemoryBytes + hostHeadroomBytes : 0);
    const initialDiskRequired = rootFloor + BigInt(cowLimit + logLimit) + bootReserveBytes;
    const diskRequired = beforeStart ? initialDiskRequired : rootFloor;
    if (r.memoryAvailableBytes < memoryRequired || BigInt(r.rootAvailableBytes) < diskRequired) {
        const error = Error('task VM resource floor refusal');
        error.resourceObservation = { ...r, memoryRequired, diskRequired: diskRequired.toString() };
        throw error;
    }
    if (runRoot) {
        const overlay = path.join(runRoot, 'overlay.qcow2');
        if (fs.existsSync(overlay) && fs.lstatSync(overlay).blocks * 512 > cowLimit) throw Error('host COW allocated-growth limit');
        for (const name of ['stdout.log', 'stderr.log', 'serial.log']) {
            const file = path.join(runRoot, name);
            if (fs.existsSync(file) && fs.lstatSync(file).size > logLimit) throw Error('task VM log bound');
        }
    }
}
function fail(error) { firstFailure ??= error; }
function signal(signal) {
    signals.push(signal);
    if (child && !childTerminal) { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') fail(e); } }
}
function run(file, args) {
    return new Promise((resolve, reject) => {
        child = spawn(file, args, { cwd: runRoot, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', ...held.map(x => x.fd)] });
        const execution = { file, pid: child.pid ?? null, started: Number.isSafeInteger(child.pid), terminal: false };
        executions.push(execution);
        started ||= execution.started;
        console.log(JSON.stringify({ phase: 'task-boot-only-failed-v11-log-recovery-tool-started', runRoot, ...execution, qualificationEligible: false }));
        childTerminal = false;
        const streams = ['stdout', 'stderr'].map(name => fs.createWriteStream(path.join(runRoot, `${name}.log`), { flags: 'a', mode: 0o600 }));
        child.stdout.pipe(streams[0]); child.stderr.pipe(streams[1]);
        for (const stream of streams) stream.on('error', e => { fail(e); signal('SIGTERM'); });
        const timer = setTimeout(() => { fail(Error('task VM operational deadline')); signal('SIGTERM'); }, deadlineMs);
        let killTimer;
        const interval = setInterval(() => {
            try { guard(); } catch (e) { fail(e); signal('SIGTERM'); }
            if (firstFailure && !killTimer) killTimer = setTimeout(() => signal('SIGKILL'), 1000);
        }, 250);
        child.on('error', fail);
        child.on('close', (code, endedBy) => {
            childTerminal = true;
            Object.assign(execution, { terminal: true, code, signal: endedBy });
            clearTimeout(timer); clearTimeout(killTimer); clearInterval(interval);
            Promise.all(streams.map(s => new Promise((done, bad) => { s.on('error', bad); s.end(done); }))).then(() => {
                if (firstFailure) reject(firstFailure);
                else if (code !== 0 || endedBy) reject(Error(`original tool terminal ${code}/${endedBy}`));
                else resolve();
            }, reject);
        });
    });
}
async function unusedPort() {
    const s = net.createServer();
    await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); });
    const port = s.address().port;
    await new Promise((resolve, reject) => s.close(e => e ? reject(e) : resolve()));
    return port; // QEMU must still bind successfully; discovery is not a reservation.
}
process.on('SIGTERM', () => { fail(Error('operator SIGTERM')); signal('SIGTERM'); });
process.on('SIGINT', () => { fail(Error('operator SIGINT')); signal('SIGINT'); });
try {
    if (process.getuid() !== 1000 || process.getgid() !== 1000 || fs.realpathSync(task) !== task) throw Error('task owner/path refusal');
    requireNoLiveQemuOrImageOpen();
    parentActual = readExpectedFailedParentActual();
    beforeImages = inspectImages();
    beforeSeed = identity(seed);
    if (beforeSeed.dev !== 64771 || beforeSeed.ino !== 1190458 || beforeSeed.size !== 374784 || beforeSeed.mode !== 0o664)
        throw Error('original seed identity changed');
    beforeShares = inspectShares();
    beforeToolchain = sealToolchain();
    if (JSON.stringify(beforeImages.slice(0, 5)) !== JSON.stringify(parentActual.afterImages) ||
        JSON.stringify(beforeSeed) !== JSON.stringify(parentActual.afterSeed) ||
        JSON.stringify(beforeToolchain) !== JSON.stringify(parentActual.afterToolchain) ||
        JSON.stringify(beforeShares) !== JSON.stringify(parentActual.afterShares)) throw Error('current original inputs differ from parent actual closure');
    holdReadOnly(original); holdReadOnly(base); holdReadOnly(seed); holdReadOnly(preparedData); holdReadOnly(diagnosticData); holdReadOnly(completedData); holdReadOnly(failedData);
    beforePreparedDataSha = sealPreparedData();
    beforeDiagnosticDataSha = sealPreparedData(diagnosticData, 194117632, diagnosticDataSha);
    beforeCompletedDataSha = sealPreparedData(completedData, 138543104, completedDataSha);
    beforeFailedDataSha = sealPreparedData(failedData, 501874688, failedDataSha);
    const failedVirtualSize = readHeldFailedVirtualSize();
    requireHeldUnchanged();
    requireNoLiveQemuOrImageOpen();
    guard(true);
    runRoot = fs.mkdtempSync(path.join(task, 'c86-overlay-attempt-'));
    fs.chmodSync(runRoot, 0o700);
    controlRoot = fs.mkdtempSync('/dev/shm/c86-boot-control-');
    fs.chmodSync(controlRoot, 0o700);
    const overlay = path.join(runRoot, 'overlay.qcow2');
    // Header/SHA/held-FD validation already sealed the parent. Do not implicitly open its embedded FD chain.
    await run(path.join(qa, 'toolchain/usr/bin/qemu-img'), ['create', '-u', '-f', 'qcow2', '-F', 'qcow2', '-b', '/proc/self/fd/9', overlay, failedVirtualSize]);
    const port = await unusedPort();
    const args = ['-name', path.basename(runRoot), '-machine', 'pc,smm=off', '-accel', 'tcg,thread=multi',
        '-cpu', 'max', '-smp', '2', '-m', '768', '-L', path.join(qa, 'toolchain/usr/share/qemu'),
        '-bios', path.join(qa, 'toolchain/usr/share/seabios/bios-256k.bin'),
        '-blockdev', JSON.stringify({ driver: 'file', filename: '/proc/self/fd/4', 'node-name': 'retained-base-file', 'read-only': true }),
        '-blockdev', JSON.stringify({ driver: 'qcow2', file: 'retained-base-file', backing: null, 'node-name': 'retained-base', 'read-only': true }),
        '-blockdev', JSON.stringify({ driver: 'file', filename: '/proc/self/fd/3', 'node-name': 'retained-qa-file', 'read-only': true }),
        '-blockdev', JSON.stringify({ driver: 'qcow2', file: 'retained-qa-file', backing: 'retained-base', 'node-name': 'retained-qa', 'read-only': true }),
        '-blockdev', JSON.stringify({ driver: 'file', filename: '/proc/self/fd/6', 'node-name': 'prepared-data-file', 'read-only': true }),
        '-blockdev', JSON.stringify({ driver: 'qcow2', file: 'prepared-data-file', backing: 'retained-qa', 'node-name': 'prepared-data', 'read-only': true }),
        '-blockdev', JSON.stringify({ driver: 'file', filename: '/proc/self/fd/7', 'node-name': 'diagnostic-data-file', 'read-only': true }),
        '-blockdev', JSON.stringify({ driver: 'qcow2', file: 'diagnostic-data-file', backing: 'prepared-data', 'node-name': 'diagnostic-data', 'read-only': true }),
        '-blockdev', JSON.stringify({ driver: 'file', filename: '/proc/self/fd/8', 'node-name': 'completed-data-file', 'read-only': true }),
        '-blockdev', JSON.stringify({ driver: 'qcow2', file: 'completed-data-file', backing: 'diagnostic-data', 'node-name': 'completed-data', 'read-only': true }),
        '-blockdev', JSON.stringify({ driver: 'file', filename: '/proc/self/fd/9', 'node-name': 'failed-data-file', 'read-only': true }),
        '-blockdev', JSON.stringify({ driver: 'qcow2', file: 'failed-data-file', backing: 'completed-data', 'node-name': 'failed-data', 'read-only': true }),
        '-blockdev', JSON.stringify({ driver: 'file', filename: overlay, 'node-name': 'task-overlay-file' }),
        '-blockdev', JSON.stringify({ driver: 'qcow2', file: 'task-overlay-file', backing: 'failed-data', 'node-name': 'task-overlay' }),
        '-device', 'virtio-blk-pci,drive=task-overlay',
        '-drive', 'file=/proc/self/fd/5,format=raw,if=ide,media=cdrom,readonly=on',
        '-netdev', `user,id=qa-offline,restrict=on,hostfwd=tcp:127.0.0.1:${port}-:22`,
        '-device', 'virtio-net-pci,netdev=qa-offline,romfile=', '-display', 'none', '-vga', 'none',
        '-serial', `file:${runRoot}/serial.log`, '-monitor', 'none',
        '-qmp', `unix:${controlRoot}/qmp.sock,server=on,wait=off`, '-pidfile', path.join(controlRoot, 'qemu.pid')];
    for (const [tag, directory] of shares) args.push('-fsdev',
        `local,id=${tag},path=${directory},security_model=none,readonly=on`,
        '-device', `virtio-9p-pci,fsdev=${tag},mount_tag=${tag}`);
    requireHeldUnchanged();
    guard(true);
    await run(path.join(qa, 'toolchain/usr/bin/qemu-system-x86_64'), args);
} catch (error) { fail(error); }
finally {
    try {
        if (!beforeImages) metadataBaselineUnavailable.push('images');
        else { afterImages = inspectImages(); if (JSON.stringify(beforeImages) !== JSON.stringify(afterImages)) throw Error('retained image metadata changed'); }
    }
    catch (error) { if (firstFailure) firstFailure.imageVerificationFailure = error.message; else fail(error); }
    try {
        requireHeldUnchanged();
        if (beforePreparedDataSha) afterPreparedDataSha = sealPreparedData();
        else metadataBaselineUnavailable.push('prepared-data-whole-file-SHA');
        if (beforeDiagnosticDataSha) afterDiagnosticDataSha = sealPreparedData(diagnosticData, 194117632, diagnosticDataSha);
        else metadataBaselineUnavailable.push('diagnostic-data-whole-file-SHA');
        if (beforeCompletedDataSha) afterCompletedDataSha = sealPreparedData(completedData, 138543104, completedDataSha);
        else metadataBaselineUnavailable.push('completed-data-whole-file-SHA');
        if (beforeFailedDataSha) afterFailedDataSha = sealPreparedData(failedData, 501874688, failedDataSha);
        else metadataBaselineUnavailable.push('failed-data-whole-file-SHA');
        if (parentActual) {
            const afterParentActual = readExpectedFailedParentActual();
            if (JSON.stringify(parentActual) !== JSON.stringify(afterParentActual)) throw Error('parent actual lineage changed');
        }
        if (beforeSeed) afterSeed = identity(seed); else metadataBaselineUnavailable.push('seed');
        if (beforeShares) afterShares = inspectShares(); else metadataBaselineUnavailable.push('shares');
        if (beforeToolchain) afterToolchain = sealToolchain(); else metadataBaselineUnavailable.push('toolchain');
        if ((beforeSeed && JSON.stringify(beforeSeed) !== JSON.stringify(afterSeed)) ||
            (beforeShares && JSON.stringify(beforeShares) !== JSON.stringify(afterShares)) ||
            (beforeToolchain && JSON.stringify(beforeToolchain) !== JSON.stringify(afterToolchain))) throw Error('retained boot inputs changed');
    } catch (e) { if (firstFailure) firstFailure.bootInputVerificationFailure = e.message; else fail(e); }
    const descriptorCloseErrors = [];
    for (const { fd } of held) { try { fs.closeSync(fd); } catch (e) { descriptorCloseErrors.push(e.code ?? e.name); } }
    if (descriptorCloseErrors.length && !firstFailure) fail(Error('held input close failed'));
    const result = { purpose: 'BOOT_ONLY_FAILED_V11_LOG_RECOVERY', autoSdkExecution: false, autoRestoreExecution: false,
        guestCommandsObservedByLauncher: false, manualRecoveryReadsRequireSeparateActualEvidence: true,
        userDbusInitializationPerformedByLauncher: false, coldDbusTimeoutRootCauseProven: false,
        cowLimitScope: '64 MiB boot-only log-recovery operator COW limit; may stop on actual recovery growth. No SDK/CLI/preparation or failed-checkpoint resume; partial packages are not qualified.',
        resourceGeometry: { guestMemoryBytes, hostMemoryFloor, hostHeadroomBytes, cowLimit, logLimit,
            bootReserveBytes: bootReserveBytes.toString(),
            initialMemoryRequiredBytes: hostMemoryFloor + guestMemoryBytes + hostHeadroomBytes,
            initialDiskRequiredBytes: (rootFloor + BigInt(cowLimit + logLimit) + bootReserveBytes).toString(),
            note: 'Read actual host capacity and refuse insufficient resources. V9 boot-only 768 MiB budget applies solely to log recovery, not SDK/backend/matrix qualification. Original policies/deadlines and the failed CLI remain unchanged. Root separately performs read-only old-boot/UID1000 journal/raw export; this launcher executes no guest command.' },
        bootInputVerificationFailure: firstFailure?.bootInputVerificationFailure ?? null, descriptorCloseErrors,
        parentActualPath, parentActualSha, preparedData, preparedDataSha, beforePreparedDataSha, afterPreparedDataSha,
        diagnosticData, diagnosticDataSha, beforeDiagnosticDataSha, afterDiagnosticDataSha,
        completedData, completedDataSha, beforeCompletedDataSha, afterCompletedDataSha,
        failedData, failedDataSha, beforeFailedDataSha, afterFailedDataSha,
        expectedFailedParentFirstFailure: parentActual?.firstFailure ?? null,
        parentOriginalCliTerminal: 'UNKNOWN', partialPreparationQualified: false,
        failedCheckpointResume: false, parentActualQualificationInherited: false,
        beforeSeed, afterSeed, beforeShares, afterShares, beforeToolchain, afterToolchain,
        procCensusUnknown, procCensusUnknownCount: procCensusUnknown.length, metadataBaselineUnavailable,
        custodyScope: 'readable process/image census only; unreadable entries UNKNOWN. Exact RO held FDs inherited into QEMU with pre/post epochs. No global/exclusive custody or SDK qualification claim.',
        schema: 'c86-task-overlay-environment-source/v1', qualificationEligible: false,
        launcherStartedCandidate: false, originalCliQualified: false, started, childTerminal, executions,
        wholeProcessTreeZero: 'UNKNOWN', cleanupObligation: started ? 'retained carrier requires exact process/QMP recovery proof' : null,
        runRoot: runRoot ?? null, controlRoot: controlRoot ?? null, beforeImages, afterImages, signals,
        firstFailure: firstFailure ? { name: firstFailure.name, message: firstFailure.message,
            code: firstFailure.code ?? null, stack: firstFailure.stack ?? null,
            resourceObservation: firstFailure.resourceObservation ?? null,
            imageVerificationFailure: firstFailure.imageVerificationFailure ?? null } : null };
    if (runRoot) fs.writeFileSync(path.join(runRoot, 'environment.actual.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(result));
    process.exitCode = firstFailure ? 1 : 0;
}
