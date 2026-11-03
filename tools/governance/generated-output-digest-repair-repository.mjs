import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';

import { readFileAtRevision } from './change-contract.mjs';

const revisionPattern = /^[a-f0-9]{40}$/u;
const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
const maximumHistoryRevisions = 128;
const maximumReplayBytes = 64 * 1024 * 1024;
const maximumTraceBytes = 16 * 1024 * 1024;
const commandTimeoutMs = 10_000;
const regularModes = new Set(['100644', '100755']);
const sandboxRoot = '/work';
const sandboxNode = '/runtime/node';
const trustedSystemPath = '/usr/bin:/bin';
const sandboxExecutablePaths = Object.freeze({ bwrap: '/usr/bin/bwrap', strace: '/usr/bin/strace', ldd: '/usr/bin/ldd' });
const absentRuntimeProbes = new Set(['/sys/devices/system/cpu/online', '/sys/devices/system/cpu/cpu0/tsc_freq_khz',
    '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.high']);

function requireValue(condition, message)
{
    if (!condition)
    {
        throw new Error(`generated repair repository: ${message}`);
    }
}

function hash(bytes)
{
    return createHash('sha256').update(bytes).digest('hex');
}

function exactRevision(value)
{
    requireValue(typeof value === 'string' && revisionPattern.test(value), 'an exact commit SHA is required');
    return value;
}

function exactPath(value)
{
    requireValue(typeof value === 'string' && pathPattern.test(value), 'an exact repository file path is required');
    return value;
}

function exactPhysicalRoot(root)
{
    const absolute = path.resolve(root);
    const canonical = fs.realpathSync(absolute);
    requireValue(fs.realpathSync(canonical) === canonical && fs.lstatSync(canonical).isDirectory(),
        'repository root must be a canonical physical directory');
    return canonical;
}

function fileSnapshot(file)
{
    const stat = fs.lstatSync(file);
    requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
        && fs.realpathSync(file) === file && stat.size <= maximumReplayBytes,
    'replay file must be a bounded, unaliased regular file');
    return { mode: stat.mode & 0o111 ? '100755' : '100644', bytes: fs.readFileSync(file) };
}

function trustedRuntimeIdentity(source, { executable = false, exact = false, systemOwned = true } = {})
{
    const resolved = fs.realpathSync(source);
    requireValue(!exact || resolved === source, `trusted executable path was replaced or redirected: ${source}`);
    const stat = fs.lstatSync(resolved, { bigint: true });
    requireValue(stat.isFile() && (!systemOwned || stat.uid === 0n) && (stat.mode & 0o022n) === 0n
        && (!executable || (stat.mode & 0o111n) !== 0n), `runtime file is not system-owned and immutable to the task: ${source}`);
    for (let directory = path.dirname(resolved); systemOwned; directory = path.dirname(directory))
    {
        const ancestor = fs.lstatSync(directory, { bigint: true });
        requireValue(ancestor.isDirectory() && ancestor.uid === 0n && (ancestor.mode & 0o022n) === 0n,
            `runtime ancestor is writable outside system ownership: ${directory}`);
        if (directory === '/')
        {
            break;
        }
    }
    return { source, resolved, executable, exact, systemOwned, dev: stat.dev, ino: stat.ino, mode: stat.mode,
        uid: stat.uid, gid: stat.gid, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
        sha256: hash(fs.readFileSync(resolved)) };
}

function assertRuntimeIdentities(identities)
{
    for (const identity of identities)
    {
        requireValue(isDeepStrictEqual(trustedRuntimeIdentity(identity.source, identity), identity),
            `trusted runtime identity drifted: ${identity.source}`);
    }
}

function parseTrace(text, producer, runtimeFiles)
{
    const reads = new Set();
    const writes = new Set();
    let nodeExecutions = 0;
    let deniedOperations = 0;
    const supervisorPids = new Set();
    const lines = text.split('\n');
    for (const line of lines)
    {
        const pid = line.match(/^(\d+)\s/u)?.[1];
        if (line.includes(`execve("${sandboxNode}"`))
        {
            nodeExecutions += 1;
            supervisorPids.delete(pid);
        }
        else if (nodeExecutions === 0)
        {
            supervisorPids.add(pid);
        }
        if (nodeExecutions === 0 || supervisorPids.has(pid))
        {
            continue;
        }
        const opened = line.match(/\bopen(?:at|at2)?\([^\n]*?"(?<file>[^"\n]+)", (?<flags>O_[^\n]+)\)\s+=/u)?.groups;
        if (opened && (opened.flags.includes('O_RDONLY') || opened.flags.includes('O_RDWR') || opened.flags.includes('O_WRONLY')))
        {
            const directoryDescriptor = line.match(/\bopenat(?:2)?\((?:AT_FDCWD|\d+)<([^>]+)>,/u)?.[1];
            const file = path.posix.resolve(directoryDescriptor ?? sandboxRoot, opened.file);
            requireValue(!opened.file.includes('\\'), 'escaped syscall path is unverifiable');
            if (file.startsWith(`${sandboxRoot}/`))
            {
                const relative = file.slice(sandboxRoot.length + 1);
                if (opened.flags.includes('O_WRONLY') || opened.flags.includes('O_RDWR'))
                {
                    requireValue(relative === producer.output, `attempted write outside canonical output: ${relative}`);
                    writes.add(relative);
                }
                else if (relative !== producer.output)
                {
                    requireValue(producer.closure.includes(relative), `attempted read outside declared closure: ${relative}`);
                    if (!/\)\s+= -1/u.test(line))
                    {
                        reads.add(relative);
                    }
                }
            }
            // Successful non-repository file reads must match an exact mount;
            // sharing a mounted runtime file's directory confers no authority.
            else if (opened.flags.includes('O_WRONLY') || opened.flags.includes('O_RDWR'))
            {
                requireValue(false, `attempted write outside canonical output: ${file}`);
            }
            else if (nodeExecutions > 0 && !runtimeFiles.includes(file) && !file.startsWith('/proc/')
                && !file.startsWith('/dev/')
                && (!absentRuntimeProbes.has(file) || !/\)\s+= -1 ENOENT/u.test(line)))
            {
                requireValue(false, `attempted read outside the sparse runtime and source mounts: ${file}`);
            }
        }
        if (nodeExecutions > 0 && /\b(?:socket|connect|bind|listen|accept|sendto|sendmsg)\(/u.test(line))
        {
            requireValue(false, 'producer attempted a network operation');
        }
        if (nodeExecutions > 0 && /\b(?:link|linkat|symlink|symlinkat|rename|renameat|renameat2|unlink|unlinkat|mkdir|mkdirat|mknod|mknodat|chdir|fchdir|chroot|mount|umount2)\(/u.test(line))
        {
            requireValue(false, 'producer attempted an unregistered filesystem mutation');
        }
        if (nodeExecutions > 0 && /\)\s+= -1 (?:EROFS|EACCES|EPERM)/u.test(line))
        {
            deniedOperations += 1;
        }
        const fdWrite = line.match(/\b(?:write|writev|pwrite64|ftruncate|fchmod|fchown)\(\d+<(?<file>\/work\/[^>]+)>/u)?.groups;
        if (fdWrite)
        {
            const relative = path.posix.normalize(fdWrite.file).slice(sandboxRoot.length + 1);
            requireValue(relative === producer.output, `descriptor wrote outside canonical output: ${relative}`);
            writes.add(relative);
        }
    }
    requireValue(nodeExecutions === 1, 'producer execution must contain exactly one canonical Node process');
    requireValue(deniedOperations === 0, 'producer attempted an operation denied by its sandbox');
    return { readPaths: [...reads].sort(), writePaths: [...writes].sort() };
}

/**
 * Construct real Git and replay capabilities from the trusted checker checkout.
 * A repair manifest cannot supply command, closure, root or adapter overrides.
 */
export function createGeneratedOutputDigestRepairRepository({ root, authorityRoot, base, producer })
{
    const repositoryRoot = exactPhysicalRoot(root);
    const policyRoot = exactPhysicalRoot(authorityRoot);
    exactRevision(base);
    const registered = structuredClone(producer);
    const gitEnvironment = {
        ...process.env,
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_NO_LAZY_FETCH: '1',
        GIT_GRAFT_FILE: '/dev/null'
    };
    const git = (args, cwd = repositoryRoot) => execFileSync('git', ['-c', 'advice.graftFileDeprecated=false', ...args], {
        cwd, env: gitEnvironment, maxBuffer: maximumTraceBytes, timeout: commandTimeoutMs
    });
    requireValue(git(['rev-parse', '--show-toplevel']).toString('utf8').trim() === repositoryRoot,
        'candidate root is not the Git checkout root');
    requireValue(git(['rev-parse', '--verify', 'HEAD'], policyRoot).toString('utf8').trim() === base,
        'authority checkout does not hold the exact trusted base');
    requireValue(registered && Array.isArray(registered.closure) && registered.closure.length <= 256
        && registered.closure.every((file) => pathPattern.test(file)) && pathPattern.test(registered.output),
    'trusted replay producer has invalid paths');
    const isAncestor = (ancestor, descendant) =>
    {
        exactRevision(ancestor);
        exactRevision(descendant);
        const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
            cwd: repositoryRoot, env: gitEnvironment, timeout: commandTimeoutMs
        });
        requireValue(!result.error && [0, 1].includes(result.status), 'Git ancestry is unverifiable');
        return result.status === 0;
    };
    const revisions = (args, maximum) =>
    {
        requireValue(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= maximumHistoryRevisions,
            'history limit is invalid');
        const entries = git(['rev-list', `--max-count=${maximum + 1}`, ...args]).toString('utf8').trim().split('\n').filter(Boolean);
        requireValue(entries.length <= maximum && entries.every((entry) => revisionPattern.test(entry)),
            'Git history exceeds its bound or contains invalid revisions');
        return entries;
    };
    const optionalBlob = (revision, file) =>
    {
        exactRevision(revision);
        exactPath(file);
        const listing = git(['ls-tree', '-z', '--full-tree', revision, '--', file]).toString('utf8');
        if (listing === '')
        {
            return null;
        }
        const entry = listing.match(/^(?<mode>\d{6}) blob (?<object>[a-f0-9]{40})\t(?<file>[^\0]+)\0$/u)?.groups;
        requireValue(entry && entry.file === file && regularModes.has(entry.mode), 'Git path is not one exact regular blob');
        // Reuse the current contract's bounded exact-blob reader. It also
        // disables replacement objects and verifies declared/read byte lengths.
        return { mode: entry.mode, object: entry.object, bytes: readFileAtRevision(repositoryRoot, revision, file) };
    };
    const blob = (revision, file) =>
    {
        const value = optionalBlob(revision, file);
        requireValue(value !== null, 'Git path is not one exact regular blob');
        return value;
    };
    let runtime = null;
    const loadRuntime = () =>
    {
        if (runtime)
        {
            return runtime;
        }
        requireValue(process.platform === 'linux', 'isolated digest repair replay requires Linux');
        const executableIdentities = Object.values(sandboxExecutablePaths)
            .map((source) => trustedRuntimeIdentity(source, { executable: true, exact: true }));
        const { bwrap, strace, ldd } = sandboxExecutablePaths;
        const node = fs.realpathSync(process.execPath);
        // Node is the already-running trusted checker runtime, not a command
        // selected from candidate PATH. Retain its exact identity throughout
        // replay without requiring a root-owned installation of that runtime.
        const nodeIdentity = trustedRuntimeIdentity(node, { executable: true, exact: true, systemOwned: false });
        assertRuntimeIdentities(executableIdentities);
        const listing = execFileSync(ldd, [node], {
            env: { PATH: trustedSystemPath, LANG: 'C', LC_ALL: 'C' }, timeout: commandTimeoutMs, encoding: 'utf8'
        });
        assertRuntimeIdentities([...executableIdentities, nodeIdentity]);
        const libraries = [...new Set([...listing.matchAll(/(?:=>\s+)?(\/[^\s()]+)\s+\(/gu)].map((match) => match[1]))].sort();
        requireValue(libraries.length > 0 && !listing.includes('not found'), 'Node runtime library closure is unavailable');
        const mounts = libraries.map((file) => ({ source: fs.realpathSync(file), destination: file }));
        if (fs.existsSync('/etc/ld.so.cache'))
        {
            mounts.push({ source: '/etc/ld.so.cache', destination: '/etc/ld.so.cache' });
        }
        mounts.push({ source: node, destination: sandboxNode });
        runtime = { bwrap, strace, mounts, identities: [...executableIdentities, nodeIdentity,
            ...mounts.filter((mount) => mount.source !== node).map((mount) => trustedRuntimeIdentity(mount.source))] };
        return runtime;
    };
    const replay = ({ revision, producer: requested, attempt }) =>
    {
        exactRevision(revision);
        requireValue(isDeepStrictEqual(requested, registered) && [0, 1].includes(attempt),
            'replay request differs from its trusted registration');
        const tools = loadRuntime();
        assertRuntimeIdentities(tools.identities);
        const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-digest-replay-'));
        const checkout = path.join(temporaryRoot, 'checkout');
        fs.mkdirSync(checkout);
        try
        {
            const initial = new Map();
            let totalBytes = 0;
            for (const file of [...registered.closure, registered.output])
            {
                const source = blob(revision, file);
                totalBytes += source.bytes.length;
                requireValue(totalBytes <= maximumReplayBytes, 'sparse replay inputs exceed the byte budget');
                const target = path.join(checkout, file);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, source.bytes, { flag: 'wx', mode: source.mode === '100755' ? 0o755 : 0o644 });
                initial.set(file, fileSnapshot(target));
            }
            const outputFile = path.join(checkout, registered.output);
            const observations = [];
            const run = (pass) =>
            {
                assertRuntimeIdentities(tools.identities);
                const trace = path.join(temporaryRoot, `pass-${pass}.strace`);
                const sandboxArgs = [
                    '--unshare-user', '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
                    '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
                    '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'LC_ALL', 'C.UTF-8', '--setenv', 'TZ', 'UTC',
                    '--setenv', 'OPENSSL_CONF', '/dev/null',
                    '--proc', '/proc', '--dev', '/dev', '--dir', sandboxRoot,
                    ...tools.mounts.flatMap((mount) => ['--ro-bind', mount.source, mount.destination]),
                    ...registered.closure.flatMap((file) => ['--ro-bind', path.join(checkout, file), `${sandboxRoot}/${file}`]),
                    '--bind', outputFile, `${sandboxRoot}/${registered.output}`,
                    '--remount-ro', '/', '--remount-ro', '/proc', '--chdir', sandboxRoot,
                    '--', sandboxNode, ...registered.command.arguments
                ];
                const result = spawnSync(tools.strace, [
                    '-f', '-qq', '-yy', '-s', '65536', '-e', 'trace=%file,network,write,writev,pwrite64,ftruncate,fchmod,fchown',
                    '-o', trace, '--', tools.bwrap, ...sandboxArgs
                ], {
                    cwd: checkout, env: { PATH: trustedSystemPath, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
                    timeout: commandTimeoutMs, killSignal: 'SIGKILL', maxBuffer: maximumTraceBytes
                });
                assertRuntimeIdentities(tools.identities);
                requireValue(fs.existsSync(trace) && fs.statSync(trace).size <= maximumTraceBytes,
                    'sandbox trace is missing or exceeds the byte budget');
                const observation = parseTrace(fs.readFileSync(trace, 'utf8'), registered,
                    tools.mounts.map((mount) => mount.destination));
                requireValue(!result.error && result.status === 0 && result.signal === null,
                    `canonical sandbox producer failed (exit=${result.status}, signal=${result.signal ?? 'none'})`);
                observations.push(observation);
                return fileSnapshot(outputFile);
            };
            const first = run(1);
            const second = run(2);
            const changedPaths = [];
            for (const [file, previous] of initial)
            {
                const current = fileSnapshot(path.join(checkout, file));
                if (!isDeepStrictEqual(previous, current))
                {
                    changedPaths.push(file);
                }
            }
            const actualFiles = [];
            const walk = (directory, prefix = '') =>
            {
                for (const name of fs.readdirSync(directory))
                {
                    const file = path.join(directory, name);
                    const relative = prefix ? `${prefix}/${name}` : name;
                    const stat = fs.lstatSync(file);
                    requireValue(!stat.isSymbolicLink(), 'replay left a symlink');
                    if (stat.isDirectory())
                    {
                        walk(file, relative);
                    }
                    else
                    {
                        actualFiles.push(relative);
                    }
                }
            };
            walk(checkout);
            for (const file of actualFiles)
            {
                if (!initial.has(file))
                {
                    changedPaths.push(file);
                }
            }
            return { revision, isolationId: temporaryRoot, first, second,
                readPaths: [...new Set(observations.flatMap((entry) => entry.readPaths))].sort(),
                writePaths: [...new Set(observations.flatMap((entry) => entry.writePaths))].sort(),
                changedPaths: [...new Set(changedPaths)].sort() };
        }
        finally
        {
            fs.rmSync(temporaryRoot, { recursive: true, force: true });
        }
    };
    return {
        authorityRevision: base,
        blob,
        optionalBlob,
        commit(revision)
        {
            exactRevision(revision);
            const fields = git(['show', '-s', '--format=%H%x00%P%x00%s%x00%B', revision]).toString('utf8').trimEnd().split('\0');
            const [commit, parents, subject, ...message] = fields;
            return { commit, parents: parents ? parents.split(' ') : [], subject, message: message.join('\0') };
        },
        isAncestor,
        firstParentRevisions(ancestor, descendant, maximum)
        {
            exactRevision(ancestor);
            exactRevision(descendant);
            const common = git(['merge-base', ancestor, descendant]).toString('utf8').trim();
            return revisions(['--first-parent', '--reverse', `${common}..${descendant}`], maximum);
        },
        revisionsBetween(ancestor, descendant, maximum)
        {
            requireValue(isAncestor(ancestor, descendant), 'history endpoints are not ancestral');
            return revisions(['--topo-order', '--reverse', `${ancestor}..${descendant}`], maximum);
        },
        changedPaths(ancestor, descendant)
        {
            exactRevision(ancestor);
            exactRevision(descendant);
            return git(['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', ancestor, descendant, '--'])
                .toString('utf8').split('\0').filter(Boolean).sort();
        },
        replay
    };
}
