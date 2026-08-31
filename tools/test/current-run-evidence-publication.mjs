import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { evidenceContentDigest, evidenceProducerReceiptDigest } from './current-run-evidence-locator.mjs';
import { governanceContentDigest, validateCurrentRunEvidenceContext } from './evidence-location-contract.mjs';

export const EVIDENCE_REFERENCE_SCHEMA = 'fsusblog.current-run-evidence-reference.v1';
export const EVIDENCE_PUBLICATION_SCHEMA = 'fsusblog.evidence-reference-publication.v1';
export const EVIDENCE_PUBLICATION_POINTER_SCHEMA = 'fsusblog.evidence-reference-publication-pointer.v1';
export const EVIDENCE_TERMINAL_HANDOFF_SCHEMA = 'fsusblog.current-run-evidence-terminal-handoff.v1';
export const EVIDENCE_TERMINAL_HANDOFF_PREFIX = 'FSUSBLOG_CURRENT_RUN_EVIDENCE_HANDOFF=';
export const releaseFinalDirectConsumerIds = Object.freeze([
    'evidence-consumer.release-final.direct.behavior-consistency',
    'evidence-consumer.release-final.direct.behavior-post-runtime',
    'evidence-consumer.release-final.direct.browser-contract',
    'evidence-consumer.release-final.direct.browserless-correctness',
    'evidence-consumer.release-final.direct.production-build',
    'evidence-consumer.release-final.direct.public-preview'
]);

function digestBytes(bytes)
{
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function digestFile(file)
{
    return digestBytes(fs.readFileSync(file));
}

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function inside(file, root)
{
    return file === root || file.startsWith(`${root}${path.sep}`);
}

function sameIdentity(left, right)
{
    return governanceContentDigest({ value: left }) === governanceContentDigest({ value: right });
}

function sealed(document)
{
    return { ...document, contentDigest: governanceContentDigest(document) };
}

function atomicWrite(file, bytes)
{
    const temporary = `${file}.next-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, file);
}

function canonicalPath(repositoryRoot, file)
{
    const root = path.resolve(repositoryRoot);
    const absolute = path.resolve(root, file);
    assert(inside(absolute, root), 'evidence publication path must be repository-relative');
    return { absolute, relative: path.relative(root, absolute).replaceAll(path.sep, '/') };
}

function assertOwnedFileParent(file, context, repositoryRoot)
{
    const parent = path.dirname(file);
    assert(fs.existsSync(parent) && fs.statSync(parent).isDirectory(),
        'evidence receipt output parent must already exist');
    const realParent = fs.realpathSync(parent);
    const roots = context.ownedRoots.map((root) =>
    {
        const absolute = path.resolve(repositoryRoot, root);
        assert(fs.existsSync(absolute) && fs.statSync(absolute).isDirectory(),
            `current-run owned root is missing: ${root}`);
        return fs.realpathSync(absolute);
    });
    assert(roots.some((root) => inside(realParent, root)),
        'evidence receipt output escapes current-run owned roots');
}

const pointerPath = (output) => `${output}.publication.json`;
const handoffPath = (output) => `${output}.handoff.json`;

function readSealed(file, schema, label)
{
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(document?.schema === schema, `${label} schema mismatch`);
    assert(document.contentDigest === governanceContentDigest(document), `${label} contentDigest mismatch`);
    return document;
}

export function readCurrentRunEvidencePublication({ outputPath, repositoryRoot })
{
    const output = canonicalPath(repositoryRoot, outputPath);
    const pointer = readSealed(pointerPath(output.absolute), EVIDENCE_PUBLICATION_POINTER_SCHEMA,
        'evidence publication pointer');
    const stateFile = path.resolve(path.dirname(output.absolute), pointer.target.path);
    assert(inside(stateFile, path.dirname(output.absolute)),
        'evidence publication state escapes output directory');
    assert(digestFile(stateFile) === pointer.target.inputDigest,
        'evidence publication pointer target digest mismatch');
    const state = readSealed(stateFile, EVIDENCE_PUBLICATION_SCHEMA, 'evidence publication state');
    assert(state.contentDigest === pointer.target.contentDigest,
        'evidence publication pointer content digest mismatch');
    return { pointer, state, stateFile };
}

function publishState(output, state)
{
    const document = sealed({ schema: EVIDENCE_PUBLICATION_SCHEMA, ...state });
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
    const digest = digestBytes(bytes);
    const stateName = `${path.basename(output)}.publication.${digest.slice(7)}.json`;
    const stateFile = path.join(path.dirname(output), stateName);
    if (fs.existsSync(stateFile))
    {
        assert(digestFile(stateFile) === digest, 'evidence publication state collision');
    }
    else
    {
        fs.writeFileSync(stateFile, bytes, { flag: 'wx' });
    }
    const pointer = sealed({
        schema: EVIDENCE_PUBLICATION_POINTER_SCHEMA,
        authorityId: document.authorityId,
        schedulerRunId: document.schedulerRunId,
        attemptId: document.attemptId,
        target: { path: stateName, inputDigest: digest, contentDigest: document.contentDigest }
    });
    atomicWrite(pointerPath(output), `${JSON.stringify(pointer, null, 2)}\n`);
    return document;
}

function assertContextIdentity(document, context, label)
{
    for (const field of ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint'])
    {
        assert(document?.[field] === context[field], `${label} ${field} mismatch`);
    }
    for (const field of ['candidateIdentity', 'buildIdentity'])
    {
        assert(sameIdentity(document?.[field], context[field]), `${label} ${field} mismatch`);
    }
}

function publicationIdentity({ authorityId, context, outputPath, payloadPath, producerId, sessionId })
{
    return {
        authorityId,
        producerId,
        schedulerRunId: context.schedulerRunId,
        attemptId: context.attemptId,
        sourceCommit: context.sourceCommit,
        worktreeFingerprint: context.worktreeFingerprint,
        candidateIdentity: context.candidateIdentity,
        buildIdentity: context.buildIdentity,
        outputPath,
        payloadPath,
        sessionId
    };
}

export function beginCurrentRunEvidencePublication({
    authorityId, context, outputPath, payloadPath, producerId, repositoryRoot
})
{
    validateCurrentRunEvidenceContext(context);
    const output = canonicalPath(repositoryRoot, outputPath);
    const payload = canonicalPath(repositoryRoot, payloadPath);
    assertOwnedFileParent(output.absolute, context, repositoryRoot);
    assertOwnedFileParent(payload.absolute, context, repositoryRoot);
    assert(!fs.existsSync(output.absolute), 'authority already has a final reference for this run attempt');
    assert(!fs.existsSync(payload.absolute), 'producer payload must be absent when this attempt starts');
    let previous = null;
    if (fs.existsSync(pointerPath(output.absolute)))
    {
        previous = readCurrentRunEvidencePublication({ outputPath, repositoryRoot }).state;
        assertContextIdentity(previous, context, 'evidence publication');
        assert(previous.authorityId === authorityId && previous.producerId === producerId,
            'evidence publication authority identity mismatch');
        assert(previous.state === 'aborted', previous.state === 'finalized'
            ? 'authority already has a final reference for this run attempt'
            : 'unfinished evidence publication requires explicit recovery');
    }
    const sessionId = crypto.randomBytes(16).toString('hex');
    const state = publishState(output.absolute, {
        state: 'prepared',
        sequence: Number(previous?.sequence ?? 0) + 1,
        parentStateDigest: previous?.contentDigest ?? null,
        ...publicationIdentity({ authorityId, context, outputPath: output.relative,
            payloadPath: payload.relative, producerId, sessionId })
    });
    return { sessionId, stateDigest: state.contentDigest, outputPath: output.relative,
        payloadPath: payload.relative };
}

function referenceReceipt({ authorityId, context, payload, payloadSchema, producerId })
{
    assert(fs.existsSync(payload.absolute) && fs.statSync(payload.absolute).isFile(),
        'producer payload is missing after terminal success');
    const realPayload = fs.realpathSync(payload.absolute);
    const payloadDocument = JSON.parse(fs.readFileSync(realPayload, 'utf8'));
    assert(payloadDocument?.schema === payloadSchema, 'producer payload schema mismatch');
    for (const field of ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint'])
    {
        if (payloadDocument[field] !== undefined)
        {
            assert(payloadDocument[field] === context[field], `producer payload ${field} mismatch`);
        }
    }
    for (const field of ['candidateIdentity', 'buildIdentity'])
    {
        if (payloadDocument[field] !== undefined)
        {
            assert(sameIdentity(payloadDocument[field], context[field]), `producer payload ${field} mismatch`);
        }
    }
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
        payload: { path: payload.relative, schema: payloadSchema, digest: digestFile(realPayload) }
    };
    const withContent = { ...body, contentDigest: evidenceContentDigest(body) };
    return { ...withContent, producerReceiptDigest: evidenceProducerReceiptDigest(withContent) };
}

function terminalHandoff({ context, outputPath, inputDigest, receipt })
{
    return sealed({
        schema: EVIDENCE_TERMINAL_HANDOFF_SCHEMA,
        schedulerRunId: context.schedulerRunId,
        attemptId: context.attemptId,
        sourceCommit: context.sourceCommit,
        worktreeFingerprint: context.worktreeFingerprint,
        candidateIdentity: context.candidateIdentity,
        buildIdentity: context.buildIdentity,
        authorityId: receipt.authorityId,
        producerId: receipt.producerId,
        path: outputPath,
        inputDigest,
        receiptContentDigest: receipt.contentDigest,
        producerReceiptDigest: receipt.producerReceiptDigest
    });
}

function writeHandoff(output, handoff)
{
    atomicWrite(handoffPath(output), `${JSON.stringify(handoff, null, 2)}\n`);
    return handoff;
}

function prepareReceipt({ authorityId, context, output, payloadPath, producerId, receipt,
    sessionId, repositoryRoot })
{
    const current = readCurrentRunEvidencePublication({ outputPath: output.relative, repositoryRoot }).state;
    assert(current.state === 'prepared', 'evidence publication is not prepared');
    assert(current.sessionId === sessionId, 'evidence publication session mismatch');
    assertContextIdentity(current, context, 'evidence publication');
    assert(current.authorityId === authorityId && current.producerId === producerId
        && current.outputPath === output.relative && current.payloadPath === payloadPath,
    'evidence publication binding mismatch');
    assert(!fs.existsSync(output.absolute), 'authority already has a final reference for this run attempt');
    const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    const inputDigest = digestBytes(bytes);
    const staged = `${output.absolute}.prepared.${sessionId}`;
    fs.writeFileSync(staged, bytes, { flag: 'wx' });
    const prepared = publishState(output.absolute, {
        ...publicationIdentity({ authorityId, context, outputPath: output.relative,
            payloadPath, producerId, sessionId }),
        state: 'receipt-prepared', sequence: current.sequence + 1,
        parentStateDigest: current.contentDigest, stagedPath: path.basename(staged),
        reference: { path: output.relative, inputDigest, contentDigest: receipt.contentDigest,
            producerReceiptDigest: receipt.producerReceiptDigest }
    });
    return { prepared, staged, inputDigest };
}

function completePreparedReceipt({ authorityId, context, output, payloadPath, producerId,
    receipt, sessionId, prepared, staged, inputDigest })
{
    fs.renameSync(staged, output.absolute);
    const finalized = publishState(output.absolute, {
        ...publicationIdentity({ authorityId, context, outputPath: output.relative,
            payloadPath, producerId, sessionId }),
        state: 'finalized', sequence: prepared.sequence + 1,
        parentStateDigest: prepared.contentDigest, reference: prepared.reference
    });
    const handoff = writeHandoff(output.absolute, terminalHandoff({ context,
        outputPath: output.relative, inputDigest, receipt }));
    return { receipt, handoff, publication: finalized };
}

export function prepareCurrentRunEvidencePublication({
    authorityId, context, outputPath, payloadPath, payloadSchema, producerId,
    repositoryRoot, sessionId, terminalStatus
})
{
    validateCurrentRunEvidenceContext(context);
    assert(terminalStatus === 'success', 'only terminal success may publish an evidence reference');
    const output = canonicalPath(repositoryRoot, outputPath);
    const payload = canonicalPath(repositoryRoot, payloadPath);
    const receipt = referenceReceipt({ authorityId, context, payload,
        payloadSchema, producerId, repositoryRoot });
    const prepared = prepareReceipt({ authorityId, context, output, payloadPath: payload.relative,
        producerId, receipt, sessionId, repositoryRoot });
    return { authorityId, context, output, payloadPath: payload.relative,
        producerId, receipt, sessionId, ...prepared };
}

export function finalizeCurrentRunEvidencePublication(options)
{
    const prepared = prepareCurrentRunEvidencePublication(options);
    return completePreparedReceipt(prepared);
}

export function recoverCurrentRunEvidencePublication({ context, outputPath, repositoryRoot })
{
    validateCurrentRunEvidenceContext(context);
    const output = canonicalPath(repositoryRoot, outputPath);
    const current = readCurrentRunEvidencePublication({ outputPath, repositoryRoot }).state;
    assertContextIdentity(current, context, 'evidence publication');
    if (current.state === 'finalized')
    {
        assert(fs.existsSync(output.absolute) && digestFile(output.absolute) === current.reference.inputDigest,
            'finalized evidence reference bytes mismatch');
        const receipt = JSON.parse(fs.readFileSync(output.absolute, 'utf8'));
        return { state: current, handoff: writeHandoff(output.absolute, terminalHandoff({ context,
            outputPath: output.relative, inputDigest: current.reference.inputDigest, receipt })) };
    }
    if (current.state === 'prepared')
    {
        const { contentDigest: parentStateDigest, ...identity } = current;
        const aborted = publishState(output.absolute, { ...identity, state: 'aborted',
            sequence: current.sequence + 1, parentStateDigest,
            reason: 'producer did not reach receipt preparation' });
        return { state: aborted, handoff: null };
    }
    assert(current.state === 'receipt-prepared', 'evidence publication recovery state is unsupported');
    const staged = path.join(path.dirname(output.absolute), current.stagedPath);
    const candidate = fs.existsSync(output.absolute) ? output.absolute : staged;
    assert(fs.existsSync(candidate) && digestFile(candidate) === current.reference.inputDigest,
        'prepared evidence reference bytes mismatch');
    if (!fs.existsSync(output.absolute))
    {
        fs.renameSync(staged, output.absolute);
    }
    else
    {
        fs.rmSync(staged, { force: true });
    }
    const parentStateDigest = current.contentDigest;
    const identity = { ...current };
    delete identity.contentDigest;
    delete identity.stagedPath;
    const finalized = publishState(output.absolute, { ...identity, state: 'finalized',
        sequence: current.sequence + 1, parentStateDigest });
    const receipt = JSON.parse(fs.readFileSync(output.absolute, 'utf8'));
    return { state: finalized, handoff: writeHandoff(output.absolute, terminalHandoff({ context,
        outputPath: output.relative, inputDigest: current.reference.inputDigest, receipt })) };
}

export function publishCurrentRunTerminalReceipt({
    authorityId, context, outputPath, producerReceiptDigest, receipt, repositoryRoot
})
{
    const payloadPath = receipt.payload?.path ?? outputPath;
    const session = beginCurrentRunEvidencePublication({ authorityId, context, outputPath,
        payloadPath, producerId: receipt.producerId, repositoryRoot });
    assert(receipt.producerReceiptDigest === producerReceiptDigest, 'producer receipt digest mismatch');
    const output = canonicalPath(repositoryRoot, outputPath);
    const prepared = prepareReceipt({ authorityId, context, output, payloadPath,
        producerId: receipt.producerId, receipt, sessionId: session.sessionId, repositoryRoot });
    return completePreparedReceipt({ authorityId, context, output, payloadPath,
        producerId: receipt.producerId, receipt, sessionId: session.sessionId, ...prepared });
}

export function publishCurrentRunEvidenceReference(options)
{
    const session = beginCurrentRunEvidencePublication(options);
    return finalizeCurrentRunEvidencePublication({ ...options, sessionId: session.sessionId }).receipt;
}

function assertReceiptIdentity(receipt, context)
{
    const sealedReceipt = { ...receipt };
    delete sealedReceipt.path;
    delete sealedReceipt.inputDigest;
    assertContextIdentity(sealedReceipt, context, 'evidence');
    assert(sealedReceipt.contentDigest === evidenceContentDigest(sealedReceipt), 'evidence contentDigest mismatch');
    assert(sealedReceipt.producerReceiptDigest === evidenceProducerReceiptDigest(sealedReceipt),
        'evidence producerReceiptDigest mismatch');
}

export function createEvidenceParentReceipt({ context, parentAuthorityId, producerId, childReferences })
{
    validateCurrentRunEvidenceContext(context);
    assert(Array.isArray(childReferences) && childReferences.length > 0, 'parent childReferences are required');
    const keys = childReferences.map((item) => item.authorityId);
    assert(new Set(keys).size === keys.length, 'parent contains multiple references for one authority');
    for (const child of childReferences)
    {
        assertReceiptIdentity(child, context);
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
