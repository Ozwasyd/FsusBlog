import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    validateCurrentRunEvidenceContext,
    validateEvidenceLocatorRegistry
} from './evidence-location-contract.mjs';

export const EVIDENCE_BINDING_RECEIPT_SCHEMA = 'fsusblog.current-run-evidence-locator-binding.v1';
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function canonicalize(value)
{
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digestValue(value)
{
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

function digestFile(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

export function evidenceContentDigest(receipt)
{
    const { contentDigest: _content, producerReceiptDigest: _producer, ...payload } = receipt;
    return digestValue(payload);
}

export function evidenceProducerReceiptDigest(receipt)
{
    const { producerReceiptDigest: _producer, ...payload } = receipt;
    return digestValue(payload);
}

function assert(condition, message)
{
    if (!condition) throw new Error(message);
}

function equalIdentity(left, right)
{
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function assertSafeExplicitPath(file, entry, context, repositoryRoot)
{
    assert(typeof file === 'string' && file.length > 0, 'explicit evidence path is required');
    const absolute = path.resolve(repositoryRoot, file);
    assert(fs.existsSync(absolute), `explicit evidence path is missing: ${file}`);
    assert(fs.statSync(absolute).isFile(), `explicit evidence path is not a file: ${file}`);
    const real = fs.realpathSync(absolute);
    const allowed = entry.allowedRoots.filter((root) => context.ownedRoots.includes(root));
    assert(allowed.length > 0, 'registry allowedRoots do not intersect current-run ownedRoots');
    const inside = allowed.some((root) =>
    {
        const rootPath = path.resolve(repositoryRoot, root);
        if (!fs.existsSync(rootPath)) return false;
        const realRoot = fs.realpathSync(rootPath);
        return real === realRoot || real.startsWith(`${realRoot}${path.sep}`);
    });
    assert(inside, `explicit evidence path escapes current-run owned roots: ${file}`);
    return real;
}

function validateEvidence(receipt, entry, context)
{
    assert(receipt?.schema === entry.receiptSchema, 'evidence receipt schema mismatch');
    for (const field of ['schedulerRunId', 'attemptId', 'sourceCommit', 'worktreeFingerprint'])
    {
        assert(receipt[field] === context[field], `evidence ${field} mismatch`);
    }
    for (const field of ['candidateIdentity', 'buildIdentity'])
    {
        assert(equalIdentity(receipt[field], context[field]), `evidence ${field} mismatch`);
    }
    assert(receipt.authorityId === entry.authorityId, 'evidence authorityId mismatch');
    assert(receipt.producerId === entry.producerId, 'evidence producerId mismatch');
    assert(digestPattern.test(receipt.contentDigest ?? ''), 'evidence contentDigest is invalid');
    assert(receipt.contentDigest === evidenceContentDigest(receipt), 'evidence contentDigest mismatch');
    assert(digestPattern.test(receipt.producerReceiptDigest ?? ''), 'evidence producerReceiptDigest is invalid');
    assert(receipt.producerReceiptDigest === evidenceProducerReceiptDigest(receipt),
        'evidence producerReceiptDigest mismatch');
}

function validateLocatorArguments(options)
{
    const allowed = new Set(['context', 'explicitInputs', 'reference', 'registry', 'registryEntry', 'repositoryRoot']);
    for (const key of Object.keys(options))
    {
        assert(allowed.has(key), `locator API does not accept ${key}`);
    }
}

export function locateCurrentRunEvidence(options)
{
    validateLocatorArguments(options);
    const { context, explicitInputs, reference, registry, registryEntry: entry, repositoryRoot } = options;
    validateCurrentRunEvidenceContext(context);
    validateEvidenceLocatorRegistry(registry);
    const canonicalEntry = registry.entries.find((candidate) => candidate.consumerId === entry?.consumerId);
    assert(canonicalEntry && equalIdentity(canonicalEntry, entry), 'locator registry entry is not canonical');
    const explicitCount = Array.isArray(explicitInputs) ? explicitInputs.length : 0;
    const referenceCount = reference ? 1 : 0;
    assert(explicitCount + referenceCount === 1, explicitCount + referenceCount === 0
        ? 'exact-one evidence input is missing'
        : 'exact-one evidence input is ambiguous');
    assert((entry.locatorMode === 'explicit-run-path' && explicitCount === 1)
        || (entry.locatorMode === 'content-addressed-reference' && referenceCount === 1),
    'evidence input does not match registered locator mode');
    const inputPath = explicitCount === 1 ? explicitInputs[0] : reference.path;
    const realPath = assertSafeExplicitPath(inputPath, entry, context, repositoryRoot);
    const inputDigest = digestFile(realPath);
    if (reference)
    {
        assert(digestPattern.test(reference.objectDigest ?? ''), 'content-addressed reference digest is invalid');
        assert(reference.objectDigest === inputDigest, 'content-addressed reference digest mismatch');
    }
    const receipt = JSON.parse(fs.readFileSync(realPath, 'utf8'));
    validateEvidence(receipt, entry, context);
    const payload = {
        schema: EVIDENCE_BINDING_RECEIPT_SCHEMA,
        consumerId: entry.consumerId,
        authorityId: entry.authorityId,
        producerId: entry.producerId,
        locatorMode: entry.locatorMode,
        input: reference
            ? { kind: 'content-addressed-reference', path: inputPath, objectDigest: reference.objectDigest }
            : { kind: 'explicit-run-path', path: inputPath },
        inputDigest,
        contentDigest: receipt.contentDigest,
        producerReceiptDigest: receipt.producerReceiptDigest,
        contextDigest: context.contentDigest,
        registryDigest: registry.contentDigest,
        identityVerified: true,
        failurePath: 'fail-closed-without-fallback'
    };
    return { receipt, bindingReceipt: { ...payload, bindingDigest: digestValue(payload) } };
}

export function verifyCurrentRunEvidenceBinding(bindingReceipt, { context, registry, registryEntry, repositoryRoot })
{
    assert(bindingReceipt?.schema === EVIDENCE_BINDING_RECEIPT_SCHEMA, 'binding receipt schema mismatch');
    const { bindingDigest, ...payload } = bindingReceipt;
    assert(bindingDigest === digestValue(payload), 'binding receipt digest mismatch');
    const options = bindingReceipt.input.kind === 'explicit-run-path'
        ? { explicitInputs: [bindingReceipt.input.path] }
        : { reference: { path: bindingReceipt.input.path, objectDigest: bindingReceipt.input.objectDigest } };
    const located = locateCurrentRunEvidence({ context, registry, registryEntry, repositoryRoot, ...options });
    assert(equalIdentity(located.bindingReceipt, bindingReceipt), 'binding receipt does not match independent verification');
    return bindingReceipt;
}
