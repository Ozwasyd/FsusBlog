import fs from 'node:fs';
import path from 'node:path';

import { retentionSourceState } from '../test-retention/audit.mjs';

function validateSourceState(sourceState, label)
{
    const commit = String(sourceState?.commit ?? '');
    const worktreeFingerprint = String(sourceState?.worktreeFingerprint ?? '');
    if (!/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9a-f]{64}$/u.test(worktreeFingerprint))
    {
        throw new Error(`${label} source state is missing or invalid`);
    }
    return { commit, worktreeFingerprint };
}

function readStableJson(file)
{
    let descriptor;
    try
    {
        const pathBefore = fs.lstatSync(file);
        if (!pathBefore.isFile() || pathBefore.isSymbolicLink())
        {
            throw new Error(`audit input is not a regular file: ${file}`);
        }
        descriptor = fs.openSync(file, 'r');
        const before = fs.fstatSync(descriptor);
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor);
        const pathAfter = fs.lstatSync(file);
        if (
            pathBefore.dev !== before.dev
            || pathBefore.ino !== before.ino
            || before.ino !== after.ino
            || before.dev !== after.dev
            || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs
            || before.ctimeMs !== after.ctimeMs
            || bytes.length !== after.size
            || pathAfter.dev !== after.dev
            || pathAfter.ino !== after.ino
        )
        {
            throw new Error(`audit input changed while being read: ${file}`);
        }
        try
        {
            return JSON.parse(bytes.toString('utf8'));
        }
        catch (error)
        {
            throw new Error(`audit input is invalid JSON: ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    finally
    {
        if (descriptor !== undefined)
        {
            fs.closeSync(descriptor);
        }
    }
}

export async function loadLifecycleAuditInput({
    root,
    auditInput,
    currentSourceState = null
})
{
    const file = path.resolve(root, auditInput);
    if (!fs.existsSync(file))
    {
        throw new Error(`audit input does not exist: ${path.relative(root, file)}`);
    }

    const audit = readStableJson(file);
    if (audit?.schema !== 'fsusblog.test-retention-audit.v2')
    {
        throw new Error(`audit input must use fsusblog.test-retention-audit.v2, got ${audit?.schema ?? 'missing'}`);
    }
    if (
        !Array.isArray(audit.files)
        || !Array.isArray(audit.testRecords)
        || audit.files.length === 0
        || audit.testRecords.length === 0
        || !Number.isInteger(audit?.counts?.totalFiles)
        || audit.counts.totalFiles <= 0
    )
    {
        throw new Error('audit input is empty');
    }
    if (audit.counts.totalFiles !== audit.files.length)
    {
        throw new Error(`audit input file count is incomplete: counts.totalFiles=${audit.counts.totalFiles} files=${audit.files.length}`);
    }
    if (
        !Number.isInteger(audit?.retainedEvidence?.testRecordCount)
        || audit.retainedEvidence.testRecordCount !== audit.testRecords.length
    )
    {
        throw new Error(`audit input test-record count is incomplete: retained=${audit?.retainedEvidence?.testRecordCount ?? 'missing'} records=${audit.testRecords.length}`);
    }

    const observed = validateSourceState(
        currentSourceState ?? await retentionSourceState(root),
        'current'
    );
    const auditSource = validateSourceState(audit.sourceState, 'audit');
    const producerSource = validateSourceState(audit?.producer?.sourceState, 'audit producer');
    if (
        auditSource.commit !== producerSource.commit
        || auditSource.worktreeFingerprint !== producerSource.worktreeFingerprint
    )
    {
        throw new Error('audit input producer source state does not match the audit source state');
    }
    if (
        auditSource.commit !== observed.commit
        || auditSource.worktreeFingerprint !== observed.worktreeFingerprint
    )
    {
        throw new Error('audit input source state does not match the current commit/worktree');
    }
    return audit;
}

export async function resolveLifecycleAudit({
    root,
    auditInput = null,
    produceStandaloneAudit,
    currentSourceState = null
})
{
    let file = auditInput;
    if (!file)
    {
        if (typeof produceStandaloneAudit !== 'function')
        {
            throw new Error('standalone lifecycle audit producer is missing');
        }
        file = await produceStandaloneAudit();
    }
    return loadLifecycleAuditInput({
        root,
        auditInput: file,
        currentSourceState
    });
}
