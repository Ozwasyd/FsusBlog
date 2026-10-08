import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { observeExecutableIdentity } from './execution-envelope-environment.mjs';
import { buildLandlockHelper } from './execution-envelope-network.mjs';
import { currentProcessIdentity, processIdentityStatus } from './process-identity.mjs';

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
    const forbidden = [repositoryRoot, os.userInfo().homedir, ...forbiddenRoots].map((entry) =>
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
    const sdkTargetsPath = path.join(root, 'mutation-build-boundary.targets');
    const sdkTargetsBytes = '<Project><PropertyGroup><UseSharedCompilation>false</UseSharedCompilation></PropertyGroup></Project>\n';
    fs.writeFileSync(sdkTargetsPath, sdkTargetsBytes, { flag: 'wx', mode: 0o400 });
    const receipt = {
        schema: 'fsusblog.release-mutation-attempt-root.v1',
        sdkBoundary: { path: sdkTargetsPath, fileDigest: `sha256:${createHash('sha256').update(sdkTargetsBytes).digest('hex')}` },
        runId, invocationId, attemptId, sourceState,
        immutableBuild: { path: buildFile, contentDigest: verified.receipt.contentDigest },
        root, resolvedRealpath: fs.realpathSync(root), paths,
        filesystemIdentity: directoryIdentity(root),
        directoryIdentities: Object.fromEntries(Object.entries(paths).map(([name, directory]) =>
            [name, directoryIdentity(directory)])),
        forbiddenRoots: [fs.realpathSync(repositoryRoot), os.userInfo().homedir, path.dirname(buildFile), ...forbiddenRoots],
        owner: { pid: process.pid, uid: process.getuid(), processIdentity: currentProcessIdentity() },
        createdAt: new Date().toISOString(), cleanupPolicy: 'retain-on-failure',
        writeDomain: [root], producerSpawned: false, authoritativeEvidence: null
    };
    receipt.contentDigest = digest(receipt);
    fs.writeFileSync(path.join(root, 'root-receipt.json'), `${JSON.stringify(receipt, null, 4)}\n`,
        { flag: 'wx', mode: 0o400 });
    return receipt;
}

function verifyRootIdentity(receipt, expected, requireLiveOwner)
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
    if (receipt.sdkBoundary?.path !== path.join(receipt.root, 'mutation-build-boundary.targets')
        || physicalPath(receipt.sdkBoundary.path) !== receipt.sdkBoundary.path
        || receipt.sdkBoundary.fileDigest !== `sha256:${createHash('sha256').update(fs.readFileSync(receipt.sdkBoundary.path)).digest('hex')}`)
    {
        throw new Error('mutation SDK boundary target identity drift');
    }
    const stored = JSON.parse(fs.readFileSync(path.join(receipt.root, 'root-receipt.json'), 'utf8'));
    if (JSON.stringify(stored) !== JSON.stringify(receipt))
    {
        throw new Error('mutation root receipt bytes differ from the pinned owner');
    }
    if (receipt.owner.uid !== process.getuid() || receipt.owner.pid !== receipt.owner.processIdentity?.pid
        || (requireLiveOwner && processIdentityStatus(receipt.owner.processIdentity).status !== 'live'))
    {
        throw new Error('mutation attempt root owner is stale or unverifiable');
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

export function verifyMutationAttemptRoot(receipt, expected)
{
    return verifyRootIdentity(receipt, expected, true);
}

function mutationControlPath(repositoryRoot, invocationId, name)
{
    segment(invocationId, 'invocationId');
    const file = path.join(repositoryRoot, '.tmp/release-reliability', invocationId, name);
    let cursor = file;
    while (cursor !== repositoryRoot)
    {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
        {
            throw new Error('mutation control reference contains a filesystem alias');
        }
        cursor = path.dirname(cursor);
    }
    return file;
}

export function publishMutationAttemptReference(receipt, expected)
{
    verifyMutationAttemptRoot(receipt, expected);
    const file = mutationControlPath(receipt.forbiddenRoots[0], receipt.invocationId, 'mutation-attempt-reference.json');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({
        schema: 'fsusblog.release-mutation-attempt-reference.v1', rootReceipt: receipt
    }, null, 4)}\n`, { flag: 'wx', mode: 0o400 });
    return file;
}

export async function readMutationAttemptObservation({ repositoryRoot, runId, invocationId, sourceState, buildReceiptDigest })
{
    const file = mutationControlPath(repositoryRoot, invocationId, 'mutation-attempt-reference.json');
    if (!fs.existsSync(file))
    {
        return { status: 'not-allocated', root: null, terminal: null };
    }
    const admission = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (admission.schema !== 'fsusblog.release-mutation-attempt-reference.v1')
    {
        throw new Error('mutation control owner schema mismatch');
    }
    const receipt = admission.rootReceipt;
    const expected = { runId, invocationId, attemptId: `${invocationId}.attempt-1`,
        sourceState: receipt.sourceState, buildReceiptDigest };
    if (receipt.sourceState.commit !== sourceState.commit
        || receipt.sourceState.worktreeFingerprint.replace(/^sha256:/u, '') !== sourceState.worktreeFingerprint.replace(/^sha256:/u, '')
        || receipt.forbiddenRoots[0] !== fs.realpathSync(repositoryRoot))
    {
        throw new Error('mutation control owner source identity mismatch');
    }
    const reference = JSON.parse(fs.readFileSync(mutationControlPath(repositoryRoot, invocationId, 'mutation-attempt-terminal.json'), 'utf8'));
    const terminal = await verifyMutationRootTerminal(receipt, expected, reference, { requireSuccess: false });
    return { status: 'retained', root: receipt.root, filesystemIdentity: receipt.filesystemIdentity,
        rootReceiptDigest: receipt.contentDigest, writeDomain: receipt.writeDomain,
        producerSpawned: terminal.producerSpawned, producerOutcome: terminal.producerOutcome,
        cleanup: terminal.cleanup, terminal: { path: reference.path, fileDigest: reference.fileDigest, status: terminal.status } };
}

export function writeMutationRootTerminal(receipt, expected, {
    phase, producerSpawned, producerOutcome, firstBlockingReason = null, authoritativeEvidence = null, enforcement = null
})
{
    verifyMutationAttemptRoot(receipt, expected);
    const passed = producerSpawned === true && producerOutcome?.exitCode === 0
        && producerOutcome.signal === null && firstBlockingReason === null && authoritativeEvidence !== null;
    if (authoritativeEvidence !== null && !passed)
    {
        throw new Error('failed mutation attempt cannot publish authoritative evidence');
    }
    const terminal = {
        schema: 'fsusblog.release-mutation-root-terminal.v1',
        rootReceiptDigest: receipt.contentDigest,
        runId: receipt.runId, invocationId: receipt.invocationId, attemptId: receipt.attemptId,
        sourceState: receipt.sourceState, immutableBuild: receipt.immutableBuild,
        root: receipt.root, writeDomain: receipt.writeDomain,
        reachedPhase: phase, producerSpawned, producerOutcome, firstBlockingReason, enforcement,
        authoritativeEvidence, status: passed ? 'passed' : 'failed',
        cleanup: { policy: receipt.cleanupPolicy, outcome: 'retained', rootExists: fs.existsSync(receipt.root) },
        finishedAt: new Date().toISOString()
    };
    terminal.contentDigest = digest(terminal);
    const file = path.join(receipt.root, 'root-terminal.json');
    fs.writeFileSync(file, `${JSON.stringify(terminal, null, 4)}\n`, { flag: 'wx', mode: 0o400 });
    const reference = { terminal, path: file, fileDigest: `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}` };
    const control = mutationControlPath(receipt.forbiddenRoots[0], receipt.invocationId, 'mutation-attempt-reference.json');
    if (fs.existsSync(control))
    {
        const admission = JSON.parse(fs.readFileSync(control, 'utf8'));
        if (admission.rootReceipt?.contentDigest !== receipt.contentDigest)
        {
            throw new Error('mutation terminal cannot overwrite another control owner');
        }
        fs.writeFileSync(mutationControlPath(receipt.forbiddenRoots[0], receipt.invocationId, 'mutation-attempt-terminal.json'),
            `${JSON.stringify({ ...reference, rootReceiptDigest: receipt.contentDigest }, null, 4)}\n`, { flag: 'wx', mode: 0o400 });
    }
    return reference;
}

// Read-only evidence verification never grants reuse of an exited allocating owner.
export async function verifyMutationRootTerminal(receipt, expected, reference, { requireSuccess = true } = {})
{
    verifyRootIdentity(receipt, expected, false);
    await verifyCurrentSource(receipt.forbiddenRoots[0], expected.sourceState);
    verifyProductionBuildReceipt({
        artifactRoot: path.dirname(receipt.immutableBuild.path), receiptFile: path.basename(receipt.immutableBuild.path),
        expectedSourceState: expected.sourceState, expectedReceiptDigest: expected.buildReceiptDigest,
        expectedProducer: { runId: expected.runId, job: 'production-build-artifacts' },
        expectedInputRoot: receipt.forbiddenRoots[0], repairReadOnlySeal: false
    });
    const file = path.join(receipt.root, 'root-terminal.json');
    if (reference.path !== file || fs.lstatSync(file).isSymbolicLink()
        || reference.fileDigest !== `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`)
    {
        throw new Error('mutation terminal reference or bytes mismatch');
    }
    const terminal = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { contentDigest, ...content } = terminal;
    if (terminal.schema !== 'fsusblog.release-mutation-root-terminal.v1' || contentDigest !== digest(content)
        || terminal.rootReceiptDigest !== receipt.contentDigest
        || ['runId', 'invocationId', 'attemptId', 'root'].some(field => terminal[field] !== receipt[field])
        || JSON.stringify(terminal.sourceState) !== JSON.stringify(receipt.sourceState)
        || JSON.stringify(terminal.immutableBuild) !== JSON.stringify(receipt.immutableBuild)
        || JSON.stringify(terminal.writeDomain) !== JSON.stringify(receipt.writeDomain)
        || terminal.cleanup?.policy !== 'retain-on-failure' || terminal.cleanup.outcome !== 'retained'
        || terminal.cleanup.rootExists !== true)
    {
        throw new Error('mutation terminal owner/outcome/cleanup binding mismatch');
    }
    if (!requireSuccess && terminal.status === 'failed'
        && terminal.authoritativeEvidence === null && typeof terminal.firstBlockingReason === 'string'
        && terminal.firstBlockingReason.length > 0)
    {
        return terminal;
    }
    if (terminal.status !== 'passed' || terminal.producerSpawned !== true
        || terminal.producerOutcome?.exitCode !== 0 || terminal.producerOutcome.signal !== null
        || terminal.firstBlockingReason !== null || !terminal.authoritativeEvidence)
    {
        throw new Error('mutation terminal has no successful authoritative producer outcome');
    }
    const evidence = physicalPath(terminal.authoritativeEvidence.path);
    if (!contains(receipt.paths.physical, evidence) || !fs.lstatSync(evidence).isFile()
        || terminal.authoritativeEvidence.fileDigest !== `sha256:${createHash('sha256').update(fs.readFileSync(evidence)).digest('hex')}`)
    {
        throw new Error('mutation terminal authoritative evidence escapes or differs from owned output');
    }
    return terminal;
}

export function prepareMutationWriteBoundary(receipt, expected, environment)
{
    verifyMutationAttemptRoot(receipt, expected);
    const output = path.join(receipt.root, 'execution-envelope-landlock');
    const binding = buildLandlockHelper({ output, pathValue: environment.PATH, environment });
    const dotnet = observeExecutableIdentity('dotnet', { pathValue: environment.PATH });
    const readRoots = [...new Set([receipt.forbiddenRoots[0], path.dirname(receipt.immutableBuild.path),
        path.dirname(fs.realpathSync(process.execPath)), path.dirname(dotnet.realPath),
        '/usr', '/lib', '/lib64', '/etc', '/proc', '/sys'].filter(entry => fs.existsSync(entry)).map(entry => fs.realpathSync(entry)))];
    const readFiles = ['/dev/urandom', '/dev/random'].filter(entry => fs.existsSync(entry));
    const boundaryArguments = [
        ...readRoots.flatMap(entry => ['--readable', entry]),
        ...readFiles.flatMap(entry => ['--readable-file', entry]),
        '--writable', receipt.root, '--writable-file', '/dev/null'
    ];
    const probe = spawnSync(binding.helper.absolutePath,
        [...boundaryArguments, '--', '/bin/true'],
        { env: environment, encoding: 'utf8' });
    if (probe.status !== 0)
    {
        throw new Error(`mutation write boundary is unavailable: ${probe.stderr}`);
    }
    return {
        binding: { ...binding, readDomain: readRoots, readFiles, dotnet },
        dotnetExecutable: dotnet.realPath,
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
            if (`sha256:${createHash('sha256').update(fs.readFileSync(dotnet.realPath)).digest('hex')}` !== dotnet.sha256)
            {
                throw new Error('mutation bound SDK executable identity drift');
            }
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
                [...boundaryArguments, '--', command, ...args],
                { ...options, env: environment });
        }
    };
}
