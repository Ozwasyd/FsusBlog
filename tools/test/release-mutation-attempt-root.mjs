import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildLandlockHelper } from './execution-envelope-network.mjs';

const { verifyProductionBuildReceipt } = await import(new URL('../ci/production-build-artifacts.mjs', import.meta.url));
const { snapshotGitWorktree } = await import(new URL('../test-matrix/scheduler.mjs', import.meta.url));

const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const contains = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
const overlaps = (left, right) => contains(left, right) || contains(right, left);

export function assertMutationMountIsolation(output, mountInfo)
{
    for (const line of mountInfo.trim().split('\n'))
    {
        const fields = line.split(' ');
        const decode = (field) => field.replace(/\\([0-7]{3})/gu,
            (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
        const mount = decode(fields[4]);
        const mountedRoot = decode(fields[3]);
        if (contains(output, mount) || (contains(mount, output) && mountedRoot !== '/'))
        {
            throw new Error(`mutation root contains or descends through a mounted filesystem alias: ${mount}`);
        }
    }
}

function segment(value, label)
{
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value ?? ''))
    {
        throw new Error(`mutation ${label} is not path-safe`);
    }
    return value;
}

function physicalPath(value)
{
    const absolute = path.resolve(value);
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean))
    {
        current = path.join(current, part);
        try
        {
            if (fs.lstatSync(current).isSymbolicLink())
            {
                throw new Error(`mutation root refuses a filesystem alias: ${current}`);
            }
        }
        catch (error)
        {
            if (error.code !== 'ENOENT')
            {
                throw error;
            }
        }
    }
    return absolute;
}

// Refuse mounts at/below the proposed owner rather than guessing a bind mount's origin.
export function assertMutationRootLocation({ repositoryRoot, outputRoot, forbiddenRoots = [], allowedOwnedRoot = null })
{
    if (process.platform !== 'linux')
    {
        throw new Error('mutation filesystem identity enforcement currently requires Linux');
    }
    const output = physicalPath(outputRoot);
    const forbidden = [repositoryRoot, os.homedir(), ...forbiddenRoots].map((entry) =>
        fs.existsSync(entry) ? fs.realpathSync(entry) : physicalPath(entry));
    for (const excluded of forbidden)
    {
        if (overlaps(output.toLowerCase(), excluded.toLowerCase()))
        {
            throw new Error(`mutation root overlaps a forbidden source/shared/retained/user root: ${excluded}`);
        }
    }
    let ancestor = output;
    while (ancestor !== path.dirname(ancestor))
    {
        if (fs.existsSync(path.join(ancestor, 'root-receipt.json')) && ancestor !== allowedOwnedRoot)
        {
            throw new Error(`mutation root overlaps another owned attempt: ${ancestor}`);
        }
        ancestor = path.dirname(ancestor);
    }
    assertMutationMountIsolation(output, fs.readFileSync('/proc/self/mountinfo', 'utf8'));
    return output;
}

function directoryIdentity(directory)
{
    const stat = fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
        || Number(stat.uid) !== process.getuid() || Number(stat.mode & 0o777n) !== 0o700)
    {
        throw new Error(`mutation owned directory identity is invalid: ${directory}`);
    }
    return { device: String(stat.dev), inode: String(stat.ino), uid: String(stat.uid) };
}

async function verifyCurrentSource(repositoryRoot, sourceState)
{
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' });
    const snapshot = await snapshotGitWorktree(repositoryRoot);
    if (commit.status !== 0 || !/^[a-f0-9]{40}$/u.test(sourceState?.commit ?? '')
        || sourceState.commit !== commit.stdout.trim()
        || sourceState.worktreeFingerprint?.replace(/^sha256:/u, '') !== snapshot.fingerprint.replace(/^sha256:/u, ''))
    {
        throw new Error('mutation current source/worktree identity mismatch');
    }
}

export async function createMutationAttemptRoot({
    repositoryRoot, outputRoot, runId, invocationId, attemptId, sourceState,
    buildReceiptPath, buildReceiptDigest, forbiddenRoots = []
})
{
    const output = assertMutationRootLocation({ repositoryRoot, outputRoot, forbiddenRoots });
    for (const [label, value] of Object.entries({ runId, invocationId, attemptId }))
    {
        segment(value, label);
    }
    await verifyCurrentSource(repositoryRoot, sourceState);
    if (!/^sha256:[a-f0-9]{64}$/u.test(buildReceiptDigest ?? ''))
    {
        throw new Error('mutation requires an explicit immutable build receipt digest');
    }
    const buildFile = physicalPath(buildReceiptPath);
    const verified = verifyProductionBuildReceipt({
        artifactRoot: path.dirname(buildFile), receiptFile: path.basename(buildFile),
        expectedSourceState: sourceState, expectedReceiptDigest: buildReceiptDigest,
        expectedProducer: { runId, job: 'production-build-artifacts' },
        expectedInputRoot: repositoryRoot, repairReadOnlySeal: false
    });
    assertMutationRootLocation({ repositoryRoot, outputRoot: output,
        forbiddenRoots: [...forbiddenRoots, path.dirname(buildFile)] });
    // No recursive creation/deletion: an existing attempt can never become a fresh owner.
    fs.mkdirSync(output, { mode: 0o700 });
    const root = path.join(output, runId, invocationId, attemptId);
    fs.mkdirSync(path.join(output, runId), { mode: 0o700 });
    fs.mkdirSync(path.join(output, runId, invocationId), { mode: 0o700 });
    fs.mkdirSync(root, { mode: 0o700 });
    const paths = Object.fromEntries(['build', 'physical', 'scratch', 'home', 'tool-cache', 'smoke'].map((name) =>
    {
        const directory = path.join(root, name);
        fs.mkdirSync(directory, { mode: 0o700 });
        return [name, directory];
    }));
    const receipt = {
        schema: 'fsusblog.release-mutation-attempt-root.v1',
        runId, invocationId, attemptId, sourceState,
        immutableBuild: { path: buildFile, contentDigest: verified.receipt.contentDigest },
        root, resolvedRealpath: fs.realpathSync(root), paths,
        filesystemIdentity: directoryIdentity(root),
        directoryIdentities: Object.fromEntries(Object.entries(paths).map(([name, directory]) =>
            [name, directoryIdentity(directory)])),
        forbiddenRoots: [fs.realpathSync(repositoryRoot), os.homedir(), path.dirname(buildFile), ...forbiddenRoots],
        owner: { pid: process.pid, uid: process.getuid() },
        createdAt: new Date().toISOString(), cleanupPolicy: 'retain-on-failure',
        writeDomain: [root], producerSpawned: false, authoritativeEvidence: null
    };
    receipt.contentDigest = digest(receipt);
    fs.writeFileSync(path.join(root, 'root-receipt.json'), `${JSON.stringify(receipt, null, 4)}\n`,
        { flag: 'wx', mode: 0o400 });
    return receipt;
}

export function verifyMutationAttemptRoot(receipt, expected)
{
    const { contentDigest, ...content } = receipt;
    if (receipt.schema !== 'fsusblog.release-mutation-attempt-root.v1' || contentDigest !== digest(content)
        || ['runId', 'invocationId', 'attemptId'].some((field) => receipt[field] !== expected[field])
        || JSON.stringify(receipt.sourceState) !== JSON.stringify(expected.sourceState)
        || receipt.immutableBuild.contentDigest !== expected.buildReceiptDigest)
    {
        throw new Error('mutation attempt/source/build receipt identity mismatch');
    }
    assertMutationRootLocation({ repositoryRoot: receipt.forbiddenRoots[0],
        outputRoot: receipt.root, forbiddenRoots: receipt.forbiddenRoots.slice(1), allowedOwnedRoot: receipt.root });
    if (receipt.resolvedRealpath !== receipt.root
        || JSON.stringify(directoryIdentity(receipt.root)) !== JSON.stringify(receipt.filesystemIdentity))
    {
        throw new Error('mutation root filesystem identity drift');
    }
    for (const [name, directory] of Object.entries(receipt.paths))
    {
        if (directory !== path.join(receipt.root, name)
            || JSON.stringify(directoryIdentity(directory)) !== JSON.stringify(receipt.directoryIdentities[name]))
        {
            throw new Error('mutation output directory identity drift');
        }
    }
    return receipt;
}

export function prepareMutationWriteBoundary(receipt, expected, environment)
{
    verifyMutationAttemptRoot(receipt, expected);
    const output = path.join(receipt.root, 'execution-envelope-landlock');
    const binding = buildLandlockHelper({ output, pathValue: environment.PATH, environment });
    const probe = spawnSync(binding.helper.absolutePath,
        ['--writable', receipt.root, '--writable-file', '/dev/null', '--', '/bin/true'],
        { env: environment, encoding: 'utf8' });
    if (probe.status !== 0)
    {
        throw new Error(`mutation write boundary is unavailable: ${probe.stderr}`);
    }
    return {
        binding,
        async run(command, args, options = {})
        {
            verifyMutationAttemptRoot(receipt, expected);
            await verifyCurrentSource(receipt.forbiddenRoots[0], expected.sourceState);
            verifyProductionBuildReceipt({
                artifactRoot: path.dirname(receipt.immutableBuild.path),
                receiptFile: path.basename(receipt.immutableBuild.path),
                expectedSourceState: expected.sourceState, expectedReceiptDigest: expected.buildReceiptDigest,
                expectedProducer: { runId: expected.runId, job: 'production-build-artifacts' },
                expectedInputRoot: receipt.forbiddenRoots[0], repairReadOnlySeal: false
            });
            const helper = binding.helper;
            if (fs.lstatSync(helper.absolutePath).isSymbolicLink()
                || fs.realpathSync(helper.absolutePath) !== helper.realPath
                || `sha256:${createHash('sha256').update(fs.readFileSync(helper.realPath)).digest('hex')}` !== helper.sha256)
            {
                throw new Error('mutation write boundary helper identity drift');
            }
            if (!path.isAbsolute(command))
            {
                throw new Error('mutation producer command must be an exact absolute executable');
            }
            return spawnSync(binding.helper.absolutePath,
                ['--writable', receipt.root, '--writable-file', '/dev/null', '--', command, ...args],
                { ...options, env: environment });
        }
    };
}
