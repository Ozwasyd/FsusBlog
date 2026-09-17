import fs from 'node:fs';
import path from 'node:path';

import { locateCurrentRunEvidence } from './current-run-evidence-locator.mjs';
import {
    EVIDENCE_TERMINAL_HANDOFF_PREFIX,
    EVIDENCE_TERMINAL_HANDOFF_SCHEMA,
    readCurrentRunEvidencePublication
} from './current-run-evidence-publication.mjs';
import {
    governanceContentDigest,
    validateCurrentRunEvidenceContext,
    validateEvidenceLocatorRegistry
} from './evidence-location-contract.mjs';

export const CHECKPOINT_EVIDENCE_REFERENCES_SCHEMA =
    'fsusblog.test-matrix.current-run-evidence-references.v1';

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function same(left, right)
{
    return governanceContentDigest({ value: left }) === governanceContentDigest({ value: right });
}

function referenceBlock(context, references = [])
{
    const body = {
        schema: CHECKPOINT_EVIDENCE_REFERENCES_SCHEMA,
        schedulerRunId: context.schedulerRunId,
        attemptId: context.attemptId,
        sourceCommit: context.sourceCommit,
        worktreeFingerprint: context.worktreeFingerprint,
        candidateIdentity: context.candidateIdentity,
        buildIdentity: context.buildIdentity,
        references
    };
    return { ...body, contentDigest: governanceContentDigest(body) };
}

export function initializeCurrentRunEvidenceCheckpoint(context)
{
    validateCurrentRunEvidenceContext(context);
    return referenceBlock(context);
}

export function resumeCurrentRunEvidenceCheckpoint(previous, context)
{
    validateCurrentRunEvidenceContext(context);
    const block = previous?.currentRunEvidenceReferences;
    if (!block)
    {
        return initializeCurrentRunEvidenceCheckpoint(context);
    }
    assert(block.schema === CHECKPOINT_EVIDENCE_REFERENCES_SCHEMA,
        'scheduler checkpoint lacks a current-attempt evidence reference block');
    assert(block.contentDigest === governanceContentDigest(block),
        'scheduler checkpoint evidence reference block contentDigest mismatch');
    const sameAttempt = block.schedulerRunId === context.schedulerRunId
        && block.attemptId === context.attemptId
        && block.sourceCommit === context.sourceCommit
        && block.worktreeFingerprint === context.worktreeFingerprint
        && same(block.candidateIdentity, context.candidateIdentity)
        && same(block.buildIdentity, context.buildIdentity);
    if (!sameAttempt)
    {
        return initializeCurrentRunEvidenceCheckpoint(context);
    }
    assertReferenceBlock(block, context);
    return block;
}

function assertReferenceBlock(block, context)
{
    assert(block?.schema === CHECKPOINT_EVIDENCE_REFERENCES_SCHEMA,
        'scheduler checkpoint lacks a current-attempt evidence reference block');
    assert(block.contentDigest === governanceContentDigest(block),
        'scheduler checkpoint evidence reference block contentDigest mismatch');
    for (const field of ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint'])
    {
        assert(block[field] === context[field], `scheduler checkpoint evidence ${field} mismatch`);
    }
    for (const field of ['candidateIdentity', 'buildIdentity'])
    {
        assert(same(block[field], context[field]), `scheduler checkpoint evidence ${field} mismatch`);
    }
    assert(Array.isArray(block.references), 'scheduler checkpoint evidence references must be an array');
}

function assertHandoff(handoff, context, entry)
{
    assert(handoff?.schema === EVIDENCE_TERMINAL_HANDOFF_SCHEMA,
        'producer terminal handoff schema mismatch');
    assert(handoff.contentDigest === governanceContentDigest(handoff),
        'producer terminal handoff contentDigest mismatch');
    for (const field of ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint'])
    {
        assert(handoff[field] === context[field], `producer terminal handoff ${field} mismatch`);
    }
    for (const field of ['candidateIdentity', 'buildIdentity'])
    {
        assert(same(handoff[field], context[field]), `producer terminal handoff ${field} mismatch`);
    }
    assert(handoff.authorityId === entry.authorityId && handoff.producerId === entry.producerId,
        'producer terminal handoff authority identity mismatch');
    for (const field of ['inputDigest', 'receiptContentDigest', 'producerReceiptDigest'])
    {
        assert(/^sha256:[0-9a-f]{64}$/u.test(handoff[field] ?? ''),
            `producer terminal handoff ${field} is invalid`);
    }
    assert(typeof handoff.path === 'string' && handoff.path.length > 0,
        'producer terminal handoff path is missing');
}

export function attachCurrentRunEvidenceHandoff({ checkpoint, context, entry,
    handoff, registry, repositoryRoot })
{
    validateCurrentRunEvidenceContext(context);
    validateEvidenceLocatorRegistry(registry);
    const canonical = registry.entries.find((candidate) => candidate.consumerId === entry?.consumerId);
    assert(canonical && same(canonical, entry), 'checkpoint registry entry is not canonical');
    assertReferenceBlock(checkpoint.currentRunEvidenceReferences, context);
    assertHandoff(handoff, context, entry);
    const input = entry.locatorMode === 'content-addressed-reference'
        ? { reference: { path: handoff.path, objectDigest: handoff.inputDigest } }
        : { explicitInputs: [handoff.path] };
    const located = locateCurrentRunEvidence({ context, registry, registryEntry: entry,
        repositoryRoot, ...input });
    assert(located.bindingReceipt.inputDigest === handoff.inputDigest,
        'producer terminal handoff inputDigest mismatch');
    assert(located.receipt.contentDigest === handoff.receiptContentDigest,
        'producer terminal handoff receipt content digest mismatch');
    assert(located.receipt.producerReceiptDigest === handoff.producerReceiptDigest,
        'producer terminal handoff producer receipt digest mismatch');
    const publication = readCurrentRunEvidencePublication({ outputPath: handoff.path, repositoryRoot }).state;
    assert(publication.state === 'finalized', 'checkpoint evidence publication is not finalized');
    assert(publication.reference.path === handoff.path
        && publication.reference.inputDigest === handoff.inputDigest
        && publication.reference.contentDigest === handoff.receiptContentDigest
        && publication.reference.producerReceiptDigest === handoff.producerReceiptDigest,
    'checkpoint evidence publication reference mismatch');
    const references = [...checkpoint.currentRunEvidenceReferences.references];
    assert(!references.some((reference) => reference.authorityId === entry.authorityId),
        'scheduler checkpoint already contains this authority reference');
    references.push({
        consumerId: entry.consumerId,
        authorityId: entry.authorityId,
        producerId: entry.producerId,
        path: handoff.path,
        inputDigest: handoff.inputDigest,
        contentDigest: handoff.receiptContentDigest,
        producerReceiptDigest: handoff.producerReceiptDigest
    });
    references.sort((left, right) => left.authorityId.localeCompare(right.authorityId));
    checkpoint.currentRunEvidenceReferences = referenceBlock(context, references);
    return checkpoint;
}

export function parseCurrentRunEvidenceHandoffs(logText)
{
    const handoffs = [];
    for (const line of String(logText).split(/\r?\n/u))
    {
        const index = line.indexOf(EVIDENCE_TERMINAL_HANDOFF_PREFIX);
        if (index < 0)
        {
            continue;
        }
        const value = line.slice(index + EVIDENCE_TERMINAL_HANDOFF_PREFIX.length).trim();
        handoffs.push(JSON.parse(value));
    }
    const identities = new Set(handoffs.map((handoff) => handoff.authorityId));
    assert(identities.size === handoffs.length, 'producer log contains multiple final refs for one authority');
    return handoffs;
}

export function attachCurrentRunEvidenceReferenceToCheckpoint({
    checkpointPath, context, entry, handoff, registry, repositoryRoot
})
{
    const absoluteCheckpoint = path.resolve(repositoryRoot, checkpointPath);
    assert(fs.existsSync(absoluteCheckpoint) && fs.statSync(absoluteCheckpoint).isFile(),
        'scheduler checkpoint is missing');
    const checkpoint = JSON.parse(fs.readFileSync(absoluteCheckpoint, 'utf8'));
    assert(checkpoint?.schema === 'fsusblog.test-matrix.checkpoint.v1',
        'scheduler checkpoint schema mismatch');
    assert(checkpoint.runId === context.schedulerRunId,
        'scheduler checkpoint run does not match current-run evidence context');
    assert(checkpoint.sourceState?.commit === context.sourceCommit
        && checkpoint.sourceState?.worktreeFingerprint === context.worktreeFingerprint,
    'scheduler checkpoint source identity mismatch');
    attachCurrentRunEvidenceHandoff({ checkpoint, context, entry, handoff, registry, repositoryRoot });
    checkpoint.revision = Math.max(0, Number(checkpoint.revision) || 0) + 1;
    checkpoint.updatedAt = new Date().toISOString();
    const temporary = `${absoluteCheckpoint}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, absoluteCheckpoint);
    return checkpoint;
}
