import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    evidenceContentDigest,
    evidenceProducerReceiptDigest
} from './current-run-evidence-locator.mjs';
import { validateCurrentRunEvidenceContext } from './evidence-location-contract.mjs';

export const EVIDENCE_REFERENCE_SCHEMA = 'fsusblog.current-run-evidence-reference.v1';
export const releaseFinalDirectConsumerIds = Object.freeze([
    'evidence-consumer.release-final.direct.behavior-consistency',
    'evidence-consumer.release-final.direct.behavior-post-runtime',
    'evidence-consumer.release-final.direct.browser-contract',
    'evidence-consumer.release-final.direct.browserless-correctness',
    'evidence-consumer.release-final.direct.production-build',
    'evidence-consumer.release-final.direct.public-preview'
]);

function digestFile(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function assert(condition, message)
{
    if (!condition) throw new Error(message);
}

function inside(file, root)
{
    return file === root || file.startsWith(`${root}${path.sep}`);
}

export function publishCurrentRunEvidenceReference({
    authorityId,
    context,
    outputPath,
    payloadPath,
    payloadSchema,
    producerId,
    repositoryRoot,
    terminalStatus
})
{
    validateCurrentRunEvidenceContext(context);
    assert(terminalStatus === 'success', 'only terminal success may publish an evidence reference');
    const payload = path.resolve(repositoryRoot, payloadPath);
    const output = path.resolve(repositoryRoot, outputPath);
    assert(fs.existsSync(payload) && fs.statSync(payload).isFile(), 'producer payload is missing');
    const outputParent = path.dirname(output);
    assert(fs.existsSync(outputParent) && fs.statSync(outputParent).isDirectory(),
        'evidence reference output parent must already exist');
    const realPayload = fs.realpathSync(payload);
    const realOutputParent = fs.realpathSync(outputParent);
    const ownedRoots = context.ownedRoots.map((root) =>
    {
        const ownedRoot = path.resolve(repositoryRoot, root);
        assert(fs.existsSync(ownedRoot) && fs.statSync(ownedRoot).isDirectory(),
            `current-run owned root is missing: ${root}`);
        return fs.realpathSync(ownedRoot);
    });
    assert(ownedRoots.some((root) => inside(realPayload, root) && inside(realOutputParent, root)),
        'payload and reference must share a current-run owned root');
    assert(!fs.existsSync(output), 'authority already has a final reference for this run attempt');
    const payloadDocument = JSON.parse(fs.readFileSync(realPayload, 'utf8'));
    assert(payloadDocument?.schema === payloadSchema, 'producer payload schema mismatch');
    const relativePayload = path.relative(repositoryRoot, realPayload).replaceAll(path.sep, '/');
    const body = {
        schema: EVIDENCE_REFERENCE_SCHEMA,
        schedulerRunId: context.schedulerRunId,
        attemptId: context.attemptId,
        sourceCommit: context.sourceCommit,
        worktreeFingerprint: context.worktreeFingerprint,
        candidateIdentity: context.candidateIdentity,
        buildIdentity: context.buildIdentity,
        authorityId,
        producerId,
        payload: { path: relativePayload, schema: payloadSchema, digest: digestFile(realPayload) }
    };
    const withContent = { ...body, contentDigest: evidenceContentDigest(body) };
    const receipt = { ...withContent, producerReceiptDigest: evidenceProducerReceiptDigest(withContent) };
    const journal = `${output}.publication.json`;
    const staged = `${output}.prepared-${process.pid}`;
    fs.writeFileSync(journal, `${JSON.stringify({ schema: 'fsusblog.evidence-reference-publication.v1',
        state: 'prepared', authorityId, schedulerRunId: context.schedulerRunId,
        attemptId: context.attemptId, outputPath: path.relative(repositoryRoot, output).replaceAll(path.sep, '/'),
        producerReceiptDigest: receipt.producerReceiptDigest }, null, 2)}\n`, { flag: 'wx' });
    try
    {
        fs.writeFileSync(staged, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
        fs.renameSync(staged, output);
        fs.writeFileSync(journal, `${JSON.stringify({ schema: 'fsusblog.evidence-reference-publication.v1',
            state: 'finalized', authorityId, schedulerRunId: context.schedulerRunId,
            attemptId: context.attemptId, outputPath: path.relative(repositoryRoot, output).replaceAll(path.sep, '/'),
            producerReceiptDigest: receipt.producerReceiptDigest }, null, 2)}\n`);
    }
    catch (error)
    {
        fs.rmSync(staged, { force: true });
        throw error;
    }
    return receipt;
}

export function createEvidenceParentReceipt({ context, parentAuthorityId, producerId, childReferences })
{
    validateCurrentRunEvidenceContext(context);
    assert(Array.isArray(childReferences) && childReferences.length > 0, 'parent childReferences are required');
    const keys = childReferences.map((item) => item.authorityId);
    assert(new Set(keys).size === keys.length, 'parent contains multiple references for one authority');
    for (const child of childReferences)
    {
        assert(child.schedulerRunId === context.schedulerRunId && child.attemptId === context.attemptId,
            'parent reference crosses run attempt');
        assert(typeof child.path === 'string' && child.path.length > 0
            && /^sha256:[0-9a-f]{64}$/u.test(child.inputDigest ?? ''),
        'parent child must carry an explicit path and digest');
    }
    const body = {
        schema: 'fsusblog.current-run-evidence-parent.v1',
        schedulerRunId: context.schedulerRunId,
        attemptId: context.attemptId,
        sourceCommit: context.sourceCommit,
        worktreeFingerprint: context.worktreeFingerprint,
        candidateIdentity: context.candidateIdentity,
        buildIdentity: context.buildIdentity,
        authorityId: parentAuthorityId,
        producerId,
        children: childReferences.map((child) => ({ authorityId: child.authorityId,
            producerId: child.producerId, producerReceiptDigest: child.producerReceiptDigest,
            path: child.path, inputDigest: child.inputDigest }))
    };
    const withContent = { ...body, contentDigest: evidenceContentDigest(body) };
    return { ...withContent, producerReceiptDigest: evidenceProducerReceiptDigest(withContent) };
}

export function resolveEvidenceReferencePayload(reference, { repositoryRoot, ownedRoots })
{
    assert(reference?.schema === EVIDENCE_REFERENCE_SCHEMA, 'evidence reference schema mismatch');
    const file = path.resolve(repositoryRoot, reference.payload?.path ?? '');
    const real = fs.realpathSync(file);
    const allowed = ownedRoots.map((root) => fs.realpathSync(path.resolve(repositoryRoot, root)));
    assert(allowed.some((root) => inside(real, root)), 'evidence payload reference escapes owned roots');
    assert(digestFile(real) === reference.payload.digest, 'evidence payload reference digest mismatch');
    const payload = JSON.parse(fs.readFileSync(real, 'utf8'));
    assert(payload?.schema === reference.payload.schema, 'evidence payload reference schema mismatch');
    return { file: real, payload };
}
