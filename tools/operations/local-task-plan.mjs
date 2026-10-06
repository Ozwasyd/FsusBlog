import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

export const taskEnvironment = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });

export function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function identity(stat) {
    return Object.fromEntries(['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])]));
}

export function requireInside(root, file) {
    if (!path.isAbsolute(root) || !path.isAbsolute(file) || path.resolve(root) !== root || path.resolve(file) !== file || file === root || !file.startsWith(`${root}${path.sep}`)) {
        throw new Error('canonical strict task descendant required');
    }
    return file;
}

/** Reject every symlink ancestor and require current UID ownership at the selected resource. */
export function requireCanonicalOwnedPath(file, { directory = false, insideRoot = null } = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || fs.realpathSync(file) !== file) {
        throw new Error('canonical path required');
    }
    if (insideRoot) requireInside(insideRoot, file);
    let current = file;
    while (current !== path.dirname(current)) {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error('symlink ancestor refused');
        current = path.dirname(current);
    }
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.uid !== BigInt(process.getuid()) || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1n)) {
        throw new Error('task resource owner/type/link refused');
    }
    return stat;
}

export function readRegular(file, limit = 64 * 1024 * 1024) {
    const before = requireCanonicalOwnedPath(file);
    if (!Number.isSafeInteger(limit) || limit < 0 || before.size > BigInt(limit)) throw new Error('regular read bound refused');
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let primary;
    try {
        if (!isDeepStrictEqual(identity(before), identity(fs.fstatSync(descriptor, { bigint: true })))) throw new Error('regular FD identity drift');
        const chunks = [];
        let length = 0;
        while (true) {
            const chunk = Buffer.alloc(Math.min(65536, limit - length + 1));
            const received = fs.readSync(descriptor, chunk, 0, chunk.length, null);
            if (received === 0) break;
            length += received;
            if (length > limit) throw new Error('regular live read bound refused');
            chunks.push(chunk.subarray(0, received));
        }
        const bytes = Buffer.concat(chunks, length);
        if (!isDeepStrictEqual(identity(before), identity(fs.fstatSync(descriptor, { bigint: true }))) || !isDeepStrictEqual(identity(before), identity(fs.lstatSync(file, { bigint: true })))) throw new Error('regular read epoch drift');
        return { bytes, identity: identity(before), sha256: sha256(bytes) };
    } catch (error) {
        primary = error;
        throw error;
    } finally {
        try { fs.closeSync(descriptor); } catch (error) {
            if (!primary) throw error;
            primary.closeFailures = [...(primary.closeFailures ?? []), error.message];
        }
    }
}

export function readFrozenPlan(planPath, expectedSha256, requiredKeys) {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) throw new Error('explicit frozen plan SHA-256 required');
    const original = readRegular(planPath, 1024 * 1024);
    if (original.sha256 !== expectedSha256) throw new Error('frozen plan digest changed');
    const plan = JSON.parse(original.bytes);
    const keys = ['schema', 'taskRoot', ...requiredKeys];
    if (!plan || Array.isArray(plan) || typeof plan !== 'object' || new Set(keys).size !== keys.length || Object.keys(plan).length !== keys.length || keys.some(key => !Object.hasOwn(plan, key)) || plan.schema !== 'fsusblog.local-task-plan.v1') throw new Error('closed task plan shape refused');
    requireCanonicalOwnedPath(plan.taskRoot, { directory: true });
    requireInside(plan.taskRoot, planPath);
    return { plan, planSha256: original.sha256 };
}

export function writeNewJson(file, value) {
    requireCanonicalOwnedPath(path.dirname(file), { directory: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 4)}\n`, { flag: 'wx', mode: 0o600 });
}

/** Bind the current handwritten launcher/import closure independently of old run identities. */
export function requireSourceClosure(roster, files) {
    if (!Array.isArray(roster) || roster.length !== files.length || new Set(roster.map(row => row?.file)).size !== files.length) throw new Error('exact current source closure required');
    for (const file of files) {
        const row = roster.find(item => item?.file === file);
        if (!row || Object.keys(row).sort().join(',') !== 'file,sha256' || !/^[a-f0-9]{64}$/.test(row.sha256) || readRegular(file).sha256 !== row.sha256) throw new Error('current launcher/import source digest drift');
    }
}

export function runBounded(executable, args, { input, maxBuffer = 4 * 1024 * 1024, timeout = 60000, env = taskEnvironment } = {}) {
    if (!path.isAbsolute(executable) || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !Number.isSafeInteger(maxBuffer) || maxBuffer <= 0 || !Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('bounded structured command required');
    const actual = spawnSync(executable, args, { input, encoding: 'utf8', maxBuffer, timeout, env });
    if (actual.error) throw actual.error;
    return { stdout: actual.stdout, stderr: actual.stderr, status: actual.status, signal: actual.signal };
}

/** An observed flock is an admission control, never evidence that resources are idle. */
export function requireHeldTaskLock(lockPath) {
    const stat = requireCanonicalOwnedPath(lockPath);
    const argv = fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    if (path.basename(argv[0] ?? '') !== 'flock' || !argv.includes(lockPath) || !argv.includes('-n') || !argv.includes('--close')) throw new Error('direct current task flock parent required');
    const major = ((stat.dev >> 8n) & 0xfffn) | ((stat.dev >> 32n) & ~0xfffn);
    const minor = (stat.dev & 0xffn) | ((stat.dev >> 12n) & ~0xffn);
    const held = fs.readFileSync('/proc/locks', 'utf8').split('\n').some(row => {
        const fields = row.trim().split(/\s+/);
        const parts = fields[5]?.split(':');
        return fields[1] === 'FLOCK' && fields[2] === 'ADVISORY' && fields[3] === 'WRITE' && fields[4] === String(process.ppid) && parts?.length === 3 && BigInt(`0x${parts[0]}`) === major && BigInt(`0x${parts[1]}`) === minor && BigInt(parts[2]) === stat.ino;
    });
    if (!held) throw new Error('actual parent task flock is not observable');
}

export function parsePlanCli(argv, modes) {
    const options = { mode: 'inspect' };
    for (let index = 0; index < argv.length; index += 2) {
        const key = ({ '--plan': 'planPath', '--plan-sha256': 'planSha256', '--mode': 'mode' })[argv[index]];
        if (!key || argv[index + 1] === undefined || Object.hasOwn(options, key) && key !== 'mode' || key === 'mode' && options.explicitMode) throw new Error('closed plan CLI requires unique key/value pairs');
        options[key] = argv[index + 1];
        if (key === 'mode') options.explicitMode = true;
    }
    if (!options.planPath || !options.planSha256 || !['inspect', ...modes].includes(options.mode)) throw new Error('plan, plan digest and supported mode required');
    return options;
}
