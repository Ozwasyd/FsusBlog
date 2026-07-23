#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const identitySchema = 'fsusblog.local-runtime-process-identity.v1';
const commitPattern = /^[a-f0-9]{40}$/u;
const fingerprintPattern = /^[a-f0-9]{64}$/u;
const runtimeRoles = [
    { role: 'backend', pidFile: 'backend.pid' },
    { role: 'debug-frontend', pidFile: 'dev-server.pid' }
];

function readPrivateFile(file)
{
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try
    {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile()
            || (stat.mode & 0o777) !== 0o600
            || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
            || stat.size > 64 * 1024)
        {
            throw new Error(`${path.basename(file)} is not a private runtime identity file`);
        }
        return fs.readFileSync(descriptor, 'utf8');
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function readProcess(pid, procRoot = '/proc')
{
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const environment = Object.fromEntries(
        fs.readFileSync(path.join(procRoot, String(pid), 'environ'), 'utf8')
            .split('\0')
            .filter(Boolean)
            .map((entry) =>
            {
                const separator = entry.indexOf('=');
                return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
            })
    );
    return {
        pid,
        processGroupId: Number.parseInt(tail[2] ?? '', 10),
        sessionId: Number.parseInt(tail[3] ?? '', 10),
        startTimeTicks: tail[19] ?? '',
        environment
    };
}

function requireSourceState(sourceState)
{
    const commit = String(sourceState?.commit ?? '').trim();
    const worktreeFingerprint = String(sourceState?.worktreeFingerprint ?? '').trim();
    if (!commitPattern.test(commit) || !fingerprintPattern.test(worktreeFingerprint))
    {
        throw new Error('expected public-preview source identity is incomplete');
    }
    return { commit, worktreeFingerprint };
}

function assertRuntimeIdentity({ identity, observed, expected, namespace, role })
{
    const actualSource = identity.sourceState ?? {};
    if (identity.schema !== identitySchema
        || identity.pid !== observed.pid
        || identity.processGroupId !== observed.pid
        || observed.processGroupId !== observed.pid
        || observed.sessionId !== observed.pid
        || String(identity.startTimeTicks) !== String(observed.startTimeTicks)
        || identity.namespace !== namespace
        || identity.role !== role
        || identity.sourceState?.commit !== expected.commit
        || identity.sourceState?.worktreeFingerprint !== expected.worktreeFingerprint
        || observed.environment.FSUSBLOG_TEST_SOURCE_COMMIT !== expected.commit
        || observed.environment.FSUSBLOG_TEST_SOURCE_FINGERPRINT !== expected.worktreeFingerprint
        || observed.environment.FSUSBLOG_TEST_NAMESPACE !== namespace
        || observed.environment.FSUSBLOG_RUNTIME_ROLE !== role)
    {
        throw new Error(
            `${role} runtime source identity mismatch: expected=${expected.commit}/${expected.worktreeFingerprint} `
            + `actual=${actualSource.commit ?? 'missing'}/${actualSource.worktreeFingerprint ?? 'missing'}`
        );
    }
}

export function verifyPublicPreviewRuntimeIdentity({
    root,
    namespace,
    expectedSourceState,
    observeProcess = (pid) => readProcess(pid)
})
{
    const expected = requireSourceState(expectedSourceState);
    const normalizedNamespace = String(namespace ?? '').trim();
    if (!normalizedNamespace)
    {
        throw new Error('public-preview runtime namespace is missing');
    }
    const runtimeDirectory = path.join(path.resolve(root), '.tmp/acceptance', normalizedNamespace);
    const result = {};
    for (const entry of runtimeRoles)
    {
        const pidFile = path.join(runtimeDirectory, entry.pidFile);
        const identityFile = pidFile.replace(/\.pid$/u, '.identity.json');
        const pidText = readPrivateFile(pidFile).trim();
        if (!/^\d+$/u.test(pidText))
        {
            throw new Error(`${entry.role} runtime pid is invalid`);
        }
        const pid = Number.parseInt(pidText, 10);
        const identity = JSON.parse(readPrivateFile(identityFile));
        const observed = observeProcess(pid);
        assertRuntimeIdentity({
            identity,
            observed,
            expected,
            namespace: normalizedNamespace,
            role: entry.role
        });
        result[entry.role] = { pid, sourceState: identity.sourceState };
    }
    return result;
}

function option(name)
{
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : '';
}

function main()
{
    const result = verifyPublicPreviewRuntimeIdentity({
        root: option('--root') || process.cwd(),
        namespace: option('--namespace'),
        expectedSourceState: {
            commit: option('--source-commit'),
            worktreeFingerprint: option('--source-fingerprint')
        }
    });
    const roles = Object.keys(result).sort().join(',');
    console.log(`[public-preview-runtime] identity ok roles=${roles}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main();
    }
    catch (error)
    {
        console.error(`[public-preview-runtime] ${error.message}`);
        process.exitCode = 1;
    }
}
