import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sourceIdentity } from './test-asset-audit/preflight.mjs';

const requiredChecks = ['dom-depth-static', 'markdown-render-budget'];

function digest(value)
{
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function withoutDigest(value)
{
    const document = { ...value };
    delete document.contentDigest;
    return document;
}

function validateIdentity(value, expected)
{
    if (value.runId !== expected.runId)
    {
        throw new Error(`${value.checkId} run identity mismatch`);
    }
    if (value.source?.commit !== expected.source?.commit
    || value.source?.worktreeFingerprint !== expected.source?.worktreeFingerprint)
    {
        throw new Error(`${value.checkId} source identity mismatch`);
    }
}

export function sealFrontendStructureProducerReceipt(input)
{
    if (!requiredChecks.includes(input?.checkId))
    {
        throw new Error(`unknown frontend structure producer: ${input?.checkId ?? '<missing>'}`);
    }
    if (!['ok', 'failed'].includes(input?.status))
    {
        throw new Error(`${input.checkId} producer status must be ok or failed`);
    }
    if (!input.runId || !input.source?.commit || !input.source?.worktreeFingerprint)
    {
        throw new Error(`${input.checkId} producer requires source and run identity`);
    }
    if (typeof input.artifact !== 'string' || !input.artifact.startsWith('.tmp/'))
    {
        throw new Error(`${input.checkId} producer requires a private artifact path`);
    }
    const receipt = {
        schema: 'fsusblog.frontend-structure-producer-receipt.v1',
        checkId: input.checkId,
        status: input.status,
        runId: input.runId,
        source: input.source,
        artifact: input.artifact,
        artifactDigest: input.artifactDigest,
        physicalExecutionCount: 1
    };
    return { ...receipt, contentDigest: digest(receipt) };
}

export function writeFrontendStructureProducerReceipt(file, receipt)
{
    const absolute = path.resolve(file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.renameSync(temporary, absolute);
}

export function validateFrontendStructureProducerReceipt(receipt, expected)
{
    if (receipt?.schema !== 'fsusblog.frontend-structure-producer-receipt.v1')
    {
        throw new Error('frontend structure producer receipt has an invalid schema');
    }
    if (receipt.status !== 'ok')
    {
        throw new Error(`${receipt.checkId} producer failed`);
    }
    validateIdentity(receipt, expected);
    if (receipt.physicalExecutionCount !== 1)
    {
        throw new Error(`${receipt.checkId} producer physical execution count must be one`);
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(receipt.artifactDigest ?? ''))
    {
        throw new Error(`${receipt.checkId} producer artifact digest is invalid`);
    }
    if (receipt.contentDigest !== digest(withoutDigest(receipt)))
    {
        throw new Error(`${receipt.checkId} producer receipt digest mismatch`);
    }
    return receipt;
}

export function currentFrontendStructureIdentity(root, env = process.env)
{
    const detected = sourceIdentity(root);
    return {
        runId: String(env.FSUSBLOG_TEST_RUN_ID ?? '').trim() || 'direct',
        source: {
            commit: String(env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim() || detected.commit,
            worktreeFingerprint: String(env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim()
        || detected.worktreeFingerprint
        }
    };
}

export function writeFrontendStructureProducerForArtifact({
    root,
    checkId,
    status,
    artifactFile,
    receiptFile,
    env = process.env
})
{
    const absoluteArtifact = path.resolve(artifactFile);
    const artifact = path.relative(root, absoluteArtifact).replaceAll(path.sep, '/');
    const identity = currentFrontendStructureIdentity(root, env);
    const receipt = sealFrontendStructureProducerReceipt({
        checkId,
        status,
        artifact,
        artifactDigest: `sha256:${createHash('sha256').update(fs.readFileSync(absoluteArtifact)).digest('hex')}`,
        ...identity
    });
    writeFrontendStructureProducerReceipt(receiptFile, receipt);
    return receipt;
}

export function joinFrontendRenderStructureReceipts({ receipts, runId, source, root = null })
{
    if (!Array.isArray(receipts))
    {
        throw new Error('frontend structure producer receipts are required');
    }
    const ids = receipts.map((receipt) => receipt?.checkId);
    if (new Set(ids).size !== ids.length)
    {
        throw new Error('duplicate producer receipt');
    }
    for (const checkId of requiredChecks)
    {
        if (!ids.includes(checkId))
        {
            throw new Error(`missing producer receipt: ${checkId}`);
        }
    }
    const unexpected = ids.filter((id) => !requiredChecks.includes(id));
    if (unexpected.length > 0)
    {
        throw new Error(`unexpected producer receipt: ${unexpected.join(', ')}`);
    }
    const verified = receipts.map((receipt) =>
        validateFrontendStructureProducerReceipt(receipt, { runId, source }));
    if (root)
    {
        for (const receipt of verified)
        {
            const artifactFile = path.resolve(root, receipt.artifact);
            if (!fs.existsSync(artifactFile))
            {
                throw new Error(`${receipt.checkId} producer artifact is missing`);
            }
            const artifactDigest = `sha256:${createHash('sha256').update(fs.readFileSync(artifactFile)).digest('hex')}`;
            if (artifactDigest !== receipt.artifactDigest)
            {
                throw new Error(`${receipt.checkId} producer artifact digest mismatch`);
            }
        }
    }
    return {
        schema: 'fsusblog.frontend-render-structure.v2',
        status: 'ok',
        evidenceClass: 'correctness',
        affectsCorrectness: true,
        executionBoundary: 'current-run-receipt-join',
        runId,
        source,
        checks: requiredChecks,
        physicalExecutions: Object.fromEntries(verified.map((receipt) => [
            receipt.checkId,
            receipt.physicalExecutionCount
        ])),
        producerReceipts: Object.fromEntries(verified.map((receipt) => [
            receipt.checkId,
            {
                artifact: receipt.artifact,
                artifactDigest: receipt.artifactDigest,
                contentDigest: receipt.contentDigest
            }
        ]))
    };
}
