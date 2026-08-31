import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    attachCurrentRunEvidenceHandoff,
    initializeCurrentRunEvidenceCheckpoint,
    parseCurrentRunEvidenceHandoffs,
    resumeCurrentRunEvidenceCheckpoint
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test/current-run-evidence-checkpoint.mjs';
import {
    beginCurrentRunEvidencePublication,
    createEvidenceParentReceipt,
    finalizeCurrentRunEvidencePublication,
    prepareCurrentRunEvidencePublication,
    readCurrentRunEvidencePublication,
    recoverCurrentRunEvidencePublication,
    resolveEvidenceReferencePayload
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/test/current-run-evidence-publication.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { governanceContentDigest } from '../../tools/test/evidence-location-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const d = (value) => `sha256:${value.repeat(64)}`;

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-evidence-publication-'));
    fs.mkdirSync(path.join(root, 'artifacts/current-run'), { recursive: true });
    const contextBody = {
        schema: 'fsusblog.current-run-evidence-context.v1',
        schedulerRunId: 'run-1',
        attemptId: 'attempt-1',
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: d('b'),
        candidateIdentity: { id: 'candidate', digest: d('c') },
        buildIdentity: { id: 'build', digest: d('d') },
        ownedRoots: ['artifacts/current-run']
    };
    const context = { ...contextBody, contentDigest: governanceContentDigest(contextBody) };
    const options = {
        authorityId: 'authority',
        context,
        outputPath: 'artifacts/current-run/reference.json',
        payloadPath: 'artifacts/current-run/payload.json',
        payloadSchema: 'payload.v1',
        producerId: 'producer',
        repositoryRoot: root,
        terminalStatus: 'success'
    };
    const entry = {
        consumerId: 'consumer', authorityId: options.authorityId,
        producerId: options.producerId, receiptSchema: 'fsusblog.current-run-evidence-reference.v1',
        locatorMode: 'explicit-run-path',
        requiredIdentityFields: ['attemptId', 'buildIdentity', 'candidateIdentity', 'schedulerRunId',
            'sourceCommit', 'worktreeFingerprint'],
        requiredDigestFields: ['contentDigest', 'producerReceiptDigest'],
        expectedCardinality: 'exact-one', allowedRoots: ['artifacts/current-run'],
        publicationMode: 'hooked', producerSource: 'producer.mjs', producerCallsite: 'caller.mjs',
        producerBindingClass: 'cli',
        producerExecutable: 'node caller.mjs', producerCommand: 'node --import hook caller.mjs',
        outputBindingKey: 'FSUSBLOG_TEST_EVIDENCE_PATH',
        handoffBindingKey: 'FSUSBLOG_TEST_EVIDENCE_HANDOFF_PATH',
        payloadBindingKey: 'FSUSBLOG_TEST_EVIDENCE_PAYLOAD_PATH', checkpointCommand: 'checkpoint'
    };
    const registryBody = { schema: 'fsusblog.evidence-locator-registry.v1', version: 1, entries: [entry] };
    const registry = { ...registryBody, contentDigest: governanceContentDigest(registryBody) };
    return { root, context, options, entry, registry };
}

function writePayload(f, value = { schema: 'payload.v1', ok: true })
{
    fs.writeFileSync(path.join(f.root, f.options.payloadPath), `${JSON.stringify(value)}\n`);
}

function produce(f)
{
    const session = beginCurrentRunEvidencePublication(f.options);
    writePayload(f);
    return finalizeCurrentRunEvidencePublication({ ...f.options, sessionId: session.sessionId });
}

test('terminal success publishes one sealed explicit ref and complete handoff', () =>
{
    const f = fixture();
    try
    {
        const result = produce(f);
        assert.equal(resolveEvidenceReferencePayload(result.receipt, {
            repositoryRoot: f.root, ownedRoots: f.context.ownedRoots
        }).payload.ok, true);
        assert.deepEqual(Object.keys(result.handoff).sort(), [
            'attemptId', 'authorityId', 'buildIdentity', 'candidateIdentity', 'contentDigest',
            'inputDigest', 'path', 'producerId', 'producerReceiptDigest', 'receiptContentDigest',
            'schedulerRunId', 'schema', 'sourceCommit', 'worktreeFingerprint'
        ]);
        assert.equal(readCurrentRunEvidencePublication({ outputPath: f.options.outputPath,
            repositoryRoot: f.root }).state.state, 'finalized');
        assert.throws(() => beginCurrentRunEvidencePublication(f.options), /already has a final reference/u);
    }
    finally
    {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('failure cancel missing output and directory substitutes never publish success', () =>
{
    for (const terminalStatus of ['failure', 'cancelled'])
    {
        const f = fixture();
        try
        {
            const session = beginCurrentRunEvidencePublication(f.options);
            writePayload(f);
            assert.throws(() => finalizeCurrentRunEvidencePublication({ ...f.options,
                sessionId: session.sessionId, terminalStatus }), /only terminal success/u);
            assert.equal(fs.existsSync(path.join(f.root, f.options.outputPath)), false);
        }
        finally
        {
            fs.rmSync(f.root, { recursive: true, force: true });
        }
    }
    const missing = fixture();
    try
    {
        const session = beginCurrentRunEvidencePublication(missing.options);
        fs.writeFileSync(path.join(missing.root, 'artifacts/current-run/unrelated.json'),
            JSON.stringify({ schema: 'payload.v1', ok: true }));
        assert.throws(() => finalizeCurrentRunEvidencePublication({ ...missing.options,
            sessionId: session.sessionId }), /payload is missing/u);
        assert.equal(fs.existsSync(path.join(missing.root, missing.options.outputPath)), false);
    }
    finally
    {
        fs.rmSync(missing.root, { recursive: true, force: true });
    }
});

test('sealed crash recovery aborts pre-receipt work and completes exact staged bytes', () =>
{
    const beforeReceipt = fixture();
    try
    {
        beginCurrentRunEvidencePublication(beforeReceipt.options);
        const recovered = recoverCurrentRunEvidencePublication({ context: beforeReceipt.context,
            outputPath: beforeReceipt.options.outputPath, repositoryRoot: beforeReceipt.root });
        assert.equal(recovered.state.state, 'aborted');
        assert.equal(recovered.handoff, null);
    }
    finally
    {
        fs.rmSync(beforeReceipt.root, { recursive: true, force: true });
    }

    const afterReceipt = fixture();
    try
    {
        const session = beginCurrentRunEvidencePublication(afterReceipt.options);
        writePayload(afterReceipt);
        prepareCurrentRunEvidencePublication({ ...afterReceipt.options, sessionId: session.sessionId });
        const recovered = recoverCurrentRunEvidencePublication({ context: afterReceipt.context,
            outputPath: afterReceipt.options.outputPath, repositoryRoot: afterReceipt.root });
        assert.equal(recovered.state.state, 'finalized');
        assert.equal(recovered.handoff.inputDigest, recovered.state.reference.inputDigest);
    }
    finally
    {
        fs.rmSync(afterReceipt.root, { recursive: true, force: true });
    }
});

test('pointer and prepared-byte tamper fail closed', () =>
{
    const pointerTamper = fixture();
    try
    {
        produce(pointerTamper);
        const pointerFile = path.join(pointerTamper.root, `${pointerTamper.options.outputPath}.publication.json`);
        const pointer = JSON.parse(fs.readFileSync(pointerFile, 'utf8'));
        pointer.target.inputDigest = d('e');
        fs.writeFileSync(pointerFile, JSON.stringify(pointer));
        assert.throws(() => readCurrentRunEvidencePublication({ outputPath: pointerTamper.options.outputPath,
            repositoryRoot: pointerTamper.root }), /contentDigest mismatch/u);
    }
    finally
    {
        fs.rmSync(pointerTamper.root, { recursive: true, force: true });
    }

    const stagedTamper = fixture();
    try
    {
        const session = beginCurrentRunEvidencePublication(stagedTamper.options);
        writePayload(stagedTamper);
        const prepared = prepareCurrentRunEvidencePublication({ ...stagedTamper.options,
            sessionId: session.sessionId });
        fs.appendFileSync(prepared.staged, 'tamper');
        assert.throws(() => recoverCurrentRunEvidencePublication({ context: stagedTamper.context,
            outputPath: stagedTamper.options.outputPath, repositoryRoot: stagedTamper.root }),
        /prepared evidence reference bytes mismatch/u);
    }
    finally
    {
        fs.rmSync(stagedTamper.root, { recursive: true, force: true });
    }
});

test('checkpoint accepts producer-supplied digests once and rejects old attempts or legacy blocks', () =>
{
    const f = fixture();
    try
    {
        const result = produce(f);
        const checkpoint = {
            schema: 'fsusblog.test-matrix.checkpoint.v1', runId: f.context.schedulerRunId,
            sourceState: { commit: f.context.sourceCommit,
                worktreeFingerprint: f.context.worktreeFingerprint },
            currentRunEvidenceReferences: initializeCurrentRunEvidenceCheckpoint(f.context)
        };
        attachCurrentRunEvidenceHandoff({ checkpoint, context: f.context, entry: f.entry,
            handoff: result.handoff, registry: f.registry, repositoryRoot: f.root });
        assert.equal(checkpoint.currentRunEvidenceReferences.references[0].inputDigest,
            result.handoff.inputDigest);
        assert.throws(() => attachCurrentRunEvidenceHandoff({ checkpoint, context: f.context,
            entry: f.entry, handoff: result.handoff, registry: f.registry, repositoryRoot: f.root }),
        /already contains/u);
        assert.throws(() => attachCurrentRunEvidenceHandoff({ checkpoint: {}, context: f.context,
            entry: f.entry, handoff: result.handoff, registry: f.registry, repositoryRoot: f.root }),
        /lacks a current-attempt/u);
        const oldBody = { ...f.context, attemptId: 'attempt-2' };
        delete oldBody.contentDigest;
        const oldContext = { ...oldBody, contentDigest: governanceContentDigest(oldBody) };
        assert.throws(() => attachCurrentRunEvidenceHandoff({ checkpoint, context: oldContext,
            entry: f.entry, handoff: result.handoff, registry: f.registry, repositoryRoot: f.root }),
        /attemptId mismatch/u);
    }
    finally
    {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('parent preserves exact child descriptors and rejects rewrite or identity drift', () =>
{
    const f = fixture();
    try
    {
        const result = produce(f);
        const child = { ...result.receipt, path: result.handoff.path,
            inputDigest: result.handoff.inputDigest };
        const parent = createEvidenceParentReceipt({ context: f.context,
            parentAuthorityId: 'parent', producerId: 'parent-producer', childReferences: [child] });
        assert.deepEqual(parent.children[0], {
            authorityId: child.authorityId, producerId: child.producerId,
            producerReceiptDigest: child.producerReceiptDigest,
            path: child.path, inputDigest: child.inputDigest
        });
        const rewritten = structuredClone(child);
        rewritten.payload.path = 'artifacts/current-run/rewritten.json';
        assert.throws(() => createEvidenceParentReceipt({ context: f.context,
            parentAuthorityId: 'parent', producerId: 'parent', childReferences: [rewritten] }),
        /contentDigest mismatch/u);
        assert.throws(() => createEvidenceParentReceipt({ context: f.context,
            parentAuthorityId: 'parent', producerId: 'parent',
            childReferences: [{ ...child, sourceCommit: 'f'.repeat(40) }] }), /sourceCommit mismatch/u);
        assert.throws(() => createEvidenceParentReceipt({ context: f.context,
            parentAuthorityId: 'parent', producerId: 'parent',
            childReferences: [{ ...child, buildIdentity: { id: 'old', digest: d('f') } }] }),
        /buildIdentity mismatch/u);
    }
    finally
    {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('a real hooked producer process publishes this-attempt payload and never wraps an old receipt', () =>
{
    const registry = JSON.parse(fs.readFileSync(path.join(repositoryRoot,
        'config/testing/evidence-locator-registry.json'), 'utf8'));
    const entry = registry.entries.find((candidate) =>
        candidate.consumerId === 'evidence-consumer.docs.check-public-preview-docs');
    const directory = `artifacts/current-run/issue-2017-hook-${process.pid}`;
    const absoluteDirectory = path.join(repositoryRoot, directory);
    fs.mkdirSync(absoluteDirectory, { recursive: true });
    const contextBody = {
        schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: `run-${process.pid}`,
        attemptId: 'attempt-1', sourceCommit: 'a'.repeat(40), worktreeFingerprint: d('b'),
        candidateIdentity: { id: 'candidate', digest: d('c') },
        buildIdentity: { id: 'build', digest: d('d') }, ownedRoots: ['artifacts/current-run']
    };
    const context = { ...contextBody, contentDigest: governanceContentDigest(contextBody) };
    const contextPath = path.join(directory, 'context.json');
    const outputPath = path.join(directory, 'reference.json');
    const payloadPath = path.join(directory, 'payload.json');
    const producerPath = path.join(directory, 'producer.mjs');
    fs.writeFileSync(path.join(repositoryRoot, contextPath), `${JSON.stringify(context)}\n`);
    fs.writeFileSync(path.join(repositoryRoot, producerPath),
        `import fs from 'node:fs';\nconst payload = process.env.${entry.payloadBindingKey};\n`
        + 'fs.writeFileSync(payload, JSON.stringify({ schema: "payload.v1", ok: true, '
        + 'schedulerRunId: process.env.FSUSBLOG_HOOK_RUN_ID }));\n');
    try
    {
        const result = spawnSync(`node --import ./tools/test/current-run-evidence-producer-hook.mjs ${producerPath}`, {
            cwd: repositoryRoot,
            env: { ...process.env, FSUSBLOG_CURRENT_RUN_EVIDENCE_CONSUMER: entry.consumerId,
                FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: contextPath,
                FSUSBLOG_HOOK_RUN_ID: context.schedulerRunId,
                [entry.outputBindingKey]: outputPath, [entry.payloadBindingKey]: payloadPath },
            shell: true, encoding: 'utf8'
        });
        assert.equal(result.status, 0, result.stderr);
        const [handoff] = parseCurrentRunEvidenceHandoffs(result.stdout);
        assert.equal(handoff.path, outputPath);
        assert.equal(handoff.authorityId, entry.authorityId);
        assert.equal(JSON.parse(fs.readFileSync(path.join(repositoryRoot, payloadPath), 'utf8')).ok, true);
        fs.rmSync(path.join(repositoryRoot, outputPath));
        fs.rmSync(path.join(repositoryRoot, `${outputPath}.publication.json`));
        fs.rmSync(path.join(repositoryRoot, `${outputPath}.handoff.json`));
        const oldPayload = {
            schema: 'payload.v1', ok: true, schedulerRunId: 'old-run', attemptId: 'attempt-0',
            sourceCommit: context.sourceCommit, worktreeFingerprint: context.worktreeFingerprint
        };
        const wrapped = spawnSync(`node --import ./tools/test/current-run-evidence-producer-hook.mjs ${producerPath}`, {
            cwd: repositoryRoot,
            env: { ...process.env, FSUSBLOG_CURRENT_RUN_EVIDENCE_CONSUMER: entry.consumerId,
                FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT: contextPath,
                FSUSBLOG_HOOK_RUN_ID: 'old-run',
                [entry.outputBindingKey]: outputPath, [entry.payloadBindingKey]: payloadPath },
            shell: true, encoding: 'utf8'
        });
        assert.notEqual(wrapped.status, 0);
        assert.match(`${wrapped.stderr}${wrapped.stdout}`, /payload must be absent|schedulerRunId mismatch/u);
        assert.equal(oldPayload.attemptId, 'attempt-0');
    }
    finally
    {
        fs.rmSync(absoluteDirectory, { recursive: true, force: true });
    }
});

test('wrapping an old-attempt payload or scanning a sibling file never publishes a new ref', () =>
{
    const f = fixture();
    try
    {
        const session = beginCurrentRunEvidencePublication(f.options);
        writePayload(f, { schema: 'payload.v1', ok: true, attemptId: 'attempt-0',
            schedulerRunId: f.context.schedulerRunId, sourceCommit: f.context.sourceCommit,
            worktreeFingerprint: f.context.worktreeFingerprint });
        assert.throws(() => finalizeCurrentRunEvidencePublication({ ...f.options,
            sessionId: session.sessionId }), /payload attemptId mismatch/u);
        assert.equal(fs.existsSync(path.join(f.root, f.options.outputPath)), false);
        writePayload(f);
        fs.writeFileSync(path.join(f.root, 'artifacts/current-run/sibling.json'),
            JSON.stringify({ schema: 'payload.v1', ok: true }));
        const result = finalizeCurrentRunEvidencePublication({ ...f.options, sessionId: session.sessionId });
        assert.equal(result.receipt.payload.path.replaceAll('\\', '/'), f.options.payloadPath);
        assert.equal(fs.existsSync(path.join(f.root, 'artifacts/current-run/sibling.json')), true);
    }
    finally
    {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('aborted publication can retry the same attempt and resume keeps same-attempt checkpoint refs', () =>
{
    const f = fixture();
    try
    {
        beginCurrentRunEvidencePublication(f.options);
        const recovered = recoverCurrentRunEvidencePublication({ context: f.context,
            outputPath: f.options.outputPath, repositoryRoot: f.root });
        assert.equal(recovered.state.state, 'aborted');
        const retried = produce(f);
        assert.equal(retried.handoff.attemptId, f.context.attemptId);
        const checkpoint = {
            schema: 'fsusblog.test-matrix.checkpoint.v1', runId: f.context.schedulerRunId,
            sourceState: { commit: f.context.sourceCommit, worktreeFingerprint: f.context.worktreeFingerprint },
            currentRunEvidenceReferences: initializeCurrentRunEvidenceCheckpoint(f.context)
        };
        attachCurrentRunEvidenceHandoff({ checkpoint, context: f.context, entry: f.entry,
            handoff: retried.handoff, registry: f.registry, repositoryRoot: f.root });
        const kept = resumeCurrentRunEvidenceCheckpoint(checkpoint, f.context);
        assert.equal(kept.references[0].inputDigest, retried.handoff.inputDigest);
        const oldBody = { ...f.context, attemptId: 'attempt-0' };
        delete oldBody.contentDigest;
        const oldContext = { ...oldBody, contentDigest: governanceContentDigest(oldBody) };
        const dropped = resumeCurrentRunEvidenceCheckpoint(checkpoint, oldContext);
        assert.equal(dropped.references.length, 0);
        assert.equal(dropped.attemptId, 'attempt-0');
    }
    finally
    {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});
