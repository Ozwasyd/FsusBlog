import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const frontendBuildReadyMarkerSchema = 'fsusblog.local-production.frontend-build-ready.v1';
export const frontendBuildStageReceiptSchema = 'fsusblog.frontend-build-stage-receipt.v1';

function requiredIdentityValue(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!normalized)
    {
        throw new Error(`frontend build stage receipt ${label} must be non-empty`);
    }
    return normalized;
}

export function validateFrontendBuildStageReceiptIdentity(receipt, {
    runId,
    sourceState
})
{
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
    {
        throw new Error('frontend build stage receipt must be an object');
    }
    const expectedRunId = requiredIdentityValue(runId, 'expected run ID');
    const expectedCommit = requiredIdentityValue(sourceState?.commit, 'expected source commit');
    const expectedFingerprint = requiredIdentityValue(
        sourceState?.worktreeFingerprint,
        'expected source fingerprint'
    );
    if (receipt.schema !== frontendBuildStageReceiptSchema)
    {
        throw new Error('frontend build stage receipt schema mismatch');
    }
    if (receipt.status !== 'success')
    {
        throw new Error('frontend build stage receipt status is not success');
    }
    if (receipt.schedulerRunId !== expectedRunId)
    {
        throw new Error('frontend build stage receipt run ID mismatch');
    }
    if (receipt.sourceState?.commit !== expectedCommit
    || receipt.sourceState?.worktreeFingerprint !== expectedFingerprint)
    {
        throw new Error('frontend build stage receipt source identity mismatch');
    }
    return {
        schema: frontendBuildStageReceiptSchema,
        status: 'success',
        schedulerRunId: expectedRunId,
        sourceCommit: expectedCommit,
        sourceFingerprint: expectedFingerprint
    };
}

function safeReceiptPath(root, candidate, expectedPath)
{
    const normalized = String(candidate ?? '').trim().replaceAll('\\', '/');
    if (!normalized || path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../'))
    {
        throw new Error('frontend build stage receipt marker path is unsafe');
    }
    if (expectedPath && normalized !== String(expectedPath).replaceAll('\\', '/'))
    {
        throw new Error('frontend build stage receipt marker path mismatch');
    }
    const absolute = path.resolve(root, normalized);
    if (absolute === root || !absolute.startsWith(`${root}${path.sep}`))
    {
        throw new Error('frontend build stage receipt marker path escapes the repository');
    }
    return { normalized, absolute };
}

function exactStringArray(value, expected, label)
{
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    {
        throw new Error(`frontend build stage receipt ${label} must be a string array`);
    }
    if (JSON.stringify(value) !== JSON.stringify(expected))
    {
        throw new Error(`frontend build stage receipt ${label} mismatch`);
    }
}

function sha256File(file)
{
    return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function snapshotOutput(absolute, stageRoot)
{
    const stats = fs.lstatSync(absolute);
    if (stats.isSymbolicLink())
    {
        throw new Error(`frontend build output must not be a symlink: ${absolute}`);
    }
    if (stats.isFile())
    {
        return { status: 'file', size: stats.size, sha256: sha256File(absolute) };
    }
    if (!stats.isDirectory())
    {
        throw new Error(`frontend build output has unsupported type: ${absolute}`);
    }
    const entries = [];
    const visit = (directory) =>
    {
        const children = fs.readdirSync(directory, { withFileTypes: true });
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children)
        {
            const childPath = path.join(directory, child.name);
            const relative = path.relative(absolute, childPath).replaceAll(path.sep, '/');
            const childStats = fs.lstatSync(childPath);
            if (childStats.isSymbolicLink())
            {
                throw new Error(`frontend build output must not contain symlinks: ${childPath}`);
            }
            if (childStats.isDirectory())
            {
                entries.push({ path: `${relative}/`, type: 'directory' });
                visit(childPath);
            }
            else if (childStats.isFile())
            {
                entries.push({
                    path: relative,
                    type: 'file',
                    size: childStats.size,
                    sha256: sha256File(childPath)
                });
            }
            else
            {
                throw new Error(`frontend build output has unsupported child type: ${childPath}`);
            }
        }
    };
    visit(absolute);
    return {
        status: 'directory',
        entries: entries.length,
        size: entries.reduce((total, entry) => total + Number(entry.size ?? 0), 0),
        sha256: `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`,
        root: path.relative(stageRoot, absolute).replaceAll(path.sep, '/') || '.'
    };
}

function validateOutputShape(output, label)
{
    const digest = /^sha256:[a-f0-9]{64}$/u;
    if (output?.status === 'skipped' && Object.keys(output).length === 1)
    {
        return;
    }
    if (output?.status === 'file'
    && Object.keys(output).sort().join(',') === 'sha256,size,status'
    && Number.isInteger(output.size) && output.size >= 0 && digest.test(output.sha256))
    {
        return;
    }
    if (output?.status === 'directory'
    && Object.keys(output).sort().join(',') === 'entries,root,sha256,size,status'
    && Number.isInteger(output.entries) && output.entries >= 0
    && Number.isInteger(output.size) && output.size >= 0
    && typeof output.root === 'string' && output.root
    && digest.test(output.sha256))
    {
        return;
    }
    throw new Error(`frontend build stage receipt output is invalid: ${label}`);
}

function validateFrontendBuildStageSemantics(receipt, {
    expectedStages,
    stageCwd,
    criticalOutputPaths = []
})
{
    if (!Array.isArray(expectedStages) || expectedStages.length === 0)
    {
        throw new Error('frontend build stage receipt expected stage roster must be non-empty');
    }
    if (!Array.isArray(receipt.stages) || receipt.stages.length !== expectedStages.length)
    {
        throw new Error('frontend build stage receipt stage roster mismatch');
    }
    const expectedIds = expectedStages.map((stage) => stage.id);
    const actualIds = receipt.stages.map((stage) => stage?.id);
    if (new Set(actualIds).size !== actualIds.length
    || JSON.stringify(actualIds) !== JSON.stringify(expectedIds))
    {
        throw new Error('frontend build stage receipt stage roster mismatch');
    }
    const outputOwners = new Map();
    for (const [index, expected] of expectedStages.entries())
    {
        const actual = receipt.stages[index];
        exactStringArray(actual.command, expected.command, `${expected.id}.command`);
        exactStringArray(actual.dependsOn, expected.dependsOn, `${expected.id}.dependsOn`);
        exactStringArray(actual.ownedOutputs, expected.ownedOutputs, `${expected.id}.ownedOutputs`);
        if (!['success', 'skipped'].includes(actual.status)
      || (actual.status === 'skipped' && expected.ownedOutputs.length > 0))
        {
            throw new Error(`frontend build stage receipt ${expected.id} status is not successful`);
        }
        if (!actual.outputs || typeof actual.outputs !== 'object' || Array.isArray(actual.outputs)
      || JSON.stringify(Object.keys(actual.outputs)) !== JSON.stringify(expected.ownedOutputs))
        {
            throw new Error(`frontend build stage receipt ${expected.id} output roster mismatch`);
        }
        for (const outputPath of expected.ownedOutputs)
        {
            const output = actual.outputs[outputPath];
            validateOutputShape(output, `${expected.id}:${outputPath}`);
            if (actual.status === 'success' && output.status === 'skipped')
            {
                throw new Error(`frontend build stage receipt ${expected.id} has a skipped success output`);
            }
            if (actual.status === 'skipped' && output.status !== 'skipped')
            {
                throw new Error(`frontend build stage receipt ${expected.id} has materialized skipped output`);
            }
            outputOwners.set(outputPath, { stageId: expected.id, output });
        }
    }
    const stageRoot = path.resolve(stageCwd);
    for (const outputPath of criticalOutputPaths)
    {
        const owner = outputOwners.get(outputPath);
        if (!owner)
        {
            throw new Error(`frontend build stage receipt critical output is undeclared: ${outputPath}`);
        }
        const absolute = path.isAbsolute(outputPath) ? path.resolve(outputPath) : path.resolve(stageRoot, outputPath);
        let current;
        try
        {
            current = snapshotOutput(absolute, stageRoot);
        }
        catch (error)
        {
            throw new Error(`frontend build stage receipt critical output is missing: ${outputPath}`, { cause: error });
        }
        if (JSON.stringify(owner.output) !== JSON.stringify(current))
        {
            throw new Error(`frontend build stage receipt critical output digest mismatch: ${outputPath}`);
        }
    }
}

export function validateFrontendBuildStageReceiptBinding({
    root,
    marker,
    runId,
    sourceState,
    expectedPath,
    expectedStages,
    stageCwd,
    criticalOutputPaths
})
{
    const repositoryRoot = path.resolve(root);
    const binding = marker?.stageReceipt;
    const receiptPath = safeReceiptPath(repositoryRoot, binding?.path, expectedPath);
    let bytes;
    try
    {
        const stats = fs.lstatSync(receiptPath.absolute);
        if (!stats.isFile() || stats.isSymbolicLink())
        {
            throw new Error('receipt is not a regular file');
        }
        bytes = fs.readFileSync(receiptPath.absolute);
    }
    catch (error)
    {
        throw new Error(`frontend build stage receipt is unreadable: ${receiptPath.normalized}`, { cause: error });
    }
    const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (!/^sha256:[a-f0-9]{64}$/u.test(String(binding?.contentDigest ?? ''))
    || binding.contentDigest !== contentDigest)
    {
        throw new Error('frontend build stage receipt content digest mismatch');
    }
    let receipt;
    try
    {
        receipt = JSON.parse(bytes);
    }
    catch (error)
    {
        throw new Error('frontend build stage receipt is invalid JSON', { cause: error });
    }
    const identity = validateFrontendBuildStageReceiptIdentity(receipt, { runId, sourceState });
    validateFrontendBuildStageSemantics(receipt, {
        expectedStages,
        stageCwd,
        criticalOutputPaths
    });
    if (JSON.stringify(binding?.identity) !== JSON.stringify(identity))
    {
        throw new Error('frontend build stage receipt marker identity mismatch');
    }
    return {
        path: receiptPath.normalized,
        absolutePath: receiptPath.absolute,
        contentDigest,
        identity,
        receipt
    };
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

export function publishFrontendBuildTerminalMarker({
    file,
    runId,
    buildLayout,
    status,
    reason,
    validateExistingSuccess,
    now = () => new Date()
})
{
    if (!['failure', 'cancelled'].includes(status))
    {
        throw new Error(`invalid frontend build terminal status: ${status}`);
    }

    try
    {
        const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (existing.schema === frontendBuildReadyMarkerSchema
      && existing.status === 'success'
      && existing.schedulerRunId === runId
      && (typeof validateExistingSuccess !== 'function' || validateExistingSuccess(existing) === true))
        {
            return { marker: existing, preserved: true };
        }
    }
    catch
    {
        // Invalid or unreadable prior markers are replaced by the new terminal marker.
    }

    const publishedAt = now().toISOString();
    const marker = {
        schema: frontendBuildReadyMarkerSchema,
        status,
        physicalBundleId: 'build-static',
        producerStepId: 'sync-static-assets',
        schedulerRunId: runId,
        buildLayout,
        reason: String(reason ?? status),
        publishedAt,
        generatedAt: publishedAt
    };
    writeJsonAtomic(file, marker);
    return { marker, preserved: false };
}
