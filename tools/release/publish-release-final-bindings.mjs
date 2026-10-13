#!/usr/bin/env node
/* eslint-disable import-x/no-relative-parent-imports */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { locateCurrentRunEvidence, verifyCurrentRunEvidenceBinding } from '../test/current-run-evidence-locator.mjs';
import {
    beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication,
    readCurrentRunEvidencePublication, resolveEvidenceReferencePayload,
    EVIDENCE_TERMINAL_HANDOFF_SCHEMA
} from '../test/current-run-evidence-publication.mjs';
import { governanceContentDigest, validateCurrentRunEvidenceContext, validateEvidenceLocatorRegistry } from '../test/evidence-location-contract.mjs';
import { loadCanonicalRequiredEvidenceCatalog } from '../test-matrix/required-evidence-catalog.mjs';

import { readOwnerEvidenceReference } from './required-evidence-owner-input.mjs';
import { createDomainVerifierRegistry } from './required-evidence-verifier-registry.mjs';
import {
    createReleaseFinalVerifiedAuthorityBinding, verifyReleaseFinalVerifiedAuthorityBinding,
    releaseFinalVerifiedAuthorityBindingSchema, ReleaseFinalAuthorityBindingError
} from './test-evidence-receipts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const producerSource = 'tools/release/publish-release-final-bindings.mjs';
const consumerId = 'evidence-consumer.release.publish-release-final-bindings';

// One producer's registration request, not a catalog or a second registry.
// The shared locator owner must admit this exact row before production writes.
export const releaseFinalBindingOutputRegistration = Object.freeze({
    consumerId, authorityId: `${consumerId}.current-run`, producerId: `${consumerId}.producer`,
    receiptSchema: 'fsusblog.current-run-evidence-reference.v1', locatorMode: 'explicit-run-path',
    requiredIdentityFields: Object.freeze(['attemptId', 'buildIdentity', 'candidateIdentity',
        'schedulerRunId', 'sourceCommit', 'worktreeFingerprint']),
    requiredDigestFields: Object.freeze(['contentDigest', 'producerReceiptDigest']),
    expectedCardinality: 'exact-one', allowedRoots: Object.freeze(['artifacts/current-run']),
    publicationMode: 'embedded', producerSource, producerCallsite: producerSource,
    producerExecutable: `node ${producerSource}`, producerCommand: `node ${producerSource}`,
    producerBindingClass: 'cli',
    outputBindingKey: 'FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_PATH',
    handoffBindingKey: 'FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_HANDOFF_PATH',
    checkpointCommand: `node tools/test/attach-current-run-evidence-checkpoint.mjs --consumer ${consumerId}`
});

function requireCheck(condition, code, message)
{
    if (!condition)
    {
        throw new ReleaseFinalAuthorityBindingError(code, message);
    }
}

function requireKeys(options, keys)
{
    requireCheck(options && typeof options === 'object' && !Array.isArray(options)
        && Object.keys(options).every((key) => keys.includes(key)),
    'UNSUPPORTED_INPUT', 'producer accepts only explicit binding and output inputs');
}

function registeredOutput(bindings)
{
    validateEvidenceLocatorRegistry(bindings?.locatorRegistry);
    const entries = bindings.locatorRegistry.entries.filter((entry) => entry.consumerId === consumerId);
    requireCheck(entries.length === 1
        && governanceContentDigest({ entry: entries[0] })
            === governanceContentDigest({ entry: releaseFinalBindingOutputRegistration }),
    'FINAL_OUTPUT_NOT_REGISTERED', 'canonical v2 final-binding output registration is missing or differs from its producer');
    return entries[0];
}

function canonicalOwnedOutput(outputPath, bindings, entry)
{
    requireCheck(typeof outputPath === 'string' && !path.isAbsolute(outputPath)
        && !outputPath.includes('\\') && !outputPath.split('/').some((part) => ['', '.', '..'].includes(part)),
    'OUTPUT_PATH_REJECTED', 'final-binding output must be an explicit canonical relative path');
    const parent = path.dirname(path.resolve(bindings.repositoryRoot, outputPath));
    const realParent = fs.realpathSync(parent);
    requireCheck(realParent === parent && entry.allowedRoots.some((ownedRoot) =>
    {
        if (!bindings.context.ownedRoots.includes(ownedRoot))
        {
            return false;
        }
        const owned = fs.realpathSync(path.resolve(bindings.repositoryRoot, ownedRoot));
        return realParent === owned || realParent.startsWith(`${owned}${path.sep}`);
    }), 'OUTPUT_PATH_REJECTED', 'final-binding output escapes registered current-run owned roots');
    return path.resolve(bindings.repositoryRoot, outputPath);
}

const digestBytes = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

// Generate from original authority inputs; never accept a prebuilt final receipt.
// A sealed publication/handoff is output transport, not durable scheduler success.
export async function publishReleaseFinalVerifiedAuthorityBinding(options)
{
    requireKeys(options, ['bindings', 'outputPath']);
    const { bindings, outputPath } = options;
    const entry = registeredOutput(bindings);
    const binding = await createReleaseFinalVerifiedAuthorityBinding(bindings);
    await verifyReleaseFinalVerifiedAuthorityBinding(binding, bindings);
    const output = canonicalOwnedOutput(outputPath, bindings, entry);
    const bytes = Buffer.from(`${JSON.stringify(binding, null, 2)}\n`);
    const payloadDigest = digestBytes(bytes);
    const payloadPath = path.posix.join(path.posix.dirname(outputPath),
        `release-final-bindings.${payloadDigest.slice(7)}.json`);
    const session = beginCurrentRunEvidencePublication({ authorityId: entry.authorityId,
        producerId: entry.producerId, context: bindings.context, outputPath, payloadPath,
        repositoryRoot: bindings.repositoryRoot });
    fs.writeFileSync(path.resolve(bindings.repositoryRoot, payloadPath), bytes, { flag: 'wx' });
    const published = finalizeCurrentRunEvidencePublication({ authorityId: entry.authorityId,
        producerId: entry.producerId, context: bindings.context, outputPath, payloadPath,
        payloadSchema: releaseFinalVerifiedAuthorityBindingSchema, repositoryRoot: bindings.repositoryRoot,
        sessionId: session.sessionId, terminalStatus: 'success' });
    const reference = { path: outputPath, objectDigest: digestBytes(fs.readFileSync(output)) };
    const handoffReference = { path: `${outputPath}.handoff.json`,
        digest: digestBytes(fs.readFileSync(`${output}.handoff.json`)) };
    await verifyPublishedReleaseFinalAuthorityBinding({ bindings, reference, handoffReference });
    return Object.freeze({ status: 'published-uncommitted', qualificationEligible: false,
        reference: Object.freeze(reference), handoffReference: Object.freeze(handoffReference),
        payloadDigest, bindingDigest: binding.contentDigest, publicationDigest: published.publication.contentDigest });
}

export async function verifyPublishedReleaseFinalAuthorityBinding(options)
{
    requireKeys(options, ['bindings', 'explicitInputs', 'reference', 'handoffReference']);
    const { bindings, explicitInputs, reference, handoffReference } = options;
    const entry = registeredOutput(bindings);
    requireCheck((explicitInputs === undefined) !== (reference === undefined),
        'UNSUPPORTED_INPUT', 'exactly one explicit final output input is required');
    if (reference !== undefined)
    {
        requireKeys(reference, ['path', 'objectDigest']);
        // Publication transports the raw file digest; the sole registered
        // locator still consumes an explicit run path, with no mode fallback.
        readOwnerEvidenceReference({ path: reference.path, digest: reference.objectDigest }, bindings);
    }
    const located = locateCurrentRunEvidence({ context: bindings.context, registry: bindings.locatorRegistry,
        registryEntry: entry, repositoryRoot: bindings.repositoryRoot,
        explicitInputs: reference === undefined ? explicitInputs : [reference.path] });
    verifyCurrentRunEvidenceBinding(located.bindingReceipt, { context: bindings.context,
        registry: bindings.locatorRegistry, registryEntry: entry, repositoryRoot: bindings.repositoryRoot });
    const outputPath = path.relative(bindings.repositoryRoot,
        path.resolve(bindings.repositoryRoot, located.bindingReceipt.input.path)).replaceAll(path.sep, '/');
    const resolved = resolveEvidenceReferencePayload(located.receipt,
        { repositoryRoot: bindings.repositoryRoot, ownedRoots: bindings.context.ownedRoots });
    await verifyReleaseFinalVerifiedAuthorityBinding(resolved.payload, bindings);
    const { state } = readCurrentRunEvidencePublication({ outputPath, repositoryRoot: bindings.repositoryRoot });
    requireCheck(state.state === 'finalized' && state.outputPath === outputPath
        && state.payloadPath === located.receipt.payload.path
        && state.reference?.inputDigest === located.bindingReceipt.inputDigest
        && state.reference?.contentDigest === located.receipt.contentDigest
        && state.reference?.producerReceiptDigest === located.receipt.producerReceiptDigest,
    'PUBLICATION_REJECTED', 'final-binding publication is not finalized or differs from its exact reference');
    requireCheck(handoffReference?.path === `${outputPath}.handoff.json`,
        'HANDOFF_REJECTED', 'explicit canonical final-binding handoff reference is required');
    const { receipt: handoff } = readOwnerEvidenceReference(handoffReference, bindings);
    requireCheck(handoff.schema === EVIDENCE_TERMINAL_HANDOFF_SCHEMA
        && handoff.contentDigest === governanceContentDigest(handoff)
        && handoff.path === outputPath && handoff.inputDigest === located.bindingReceipt.inputDigest
        && handoff.receiptContentDigest === located.receipt.contentDigest
        && handoff.producerReceiptDigest === located.receipt.producerReceiptDigest,
    'HANDOFF_REJECTED', 'final-binding handoff schema or exact reference digest mismatch');
    for (const field of ['authorityId', 'producerId', 'schedulerRunId', 'attemptId',
        'sourceCommit', 'worktreeFingerprint', 'candidateIdentity', 'buildIdentity'])
    {
        requireCheck(governanceContentDigest({ value: state[field] })
            === governanceContentDigest({ value: located.receipt[field] })
            && governanceContentDigest({ value: handoff[field] })
                === governanceContentDigest({ value: located.receipt[field] }),
        'PUBLICATION_IDENTITY_MISMATCH', `final-binding publication/handoff ${field} mismatch`);
    }
    return Object.freeze({ binding: resolved.payload, locator: located.bindingReceipt,
        publicationDigest: state.contentDigest, status: 'published-uncommitted', qualificationEligible: false });
}

// Consume the scheduler owner's actual public API. Its after-write revision is
// an independent caller input, never the writer's baseline plus one. Readback
// proves a committed reference, not terminal or domain qualification.
export async function verifyCommittedReleaseFinalAuthorityBinding(options)
{
    requireKeys(options, ['bindings', 'checkpointFile', 'expectedCommittedRevision',
        'explicitInputs', 'reference', 'handoffReference']);
    const { bindings, checkpointFile, expectedCommittedRevision, explicitInputs, reference, handoffReference } = options;
    const entry = registeredOutput(bindings);
    requireCheck(Number.isSafeInteger(expectedCommittedRevision) && expectedCommittedRevision > 0,
        'COMMITTED_REVISION_REQUIRED', 'independently expected after-write committed revision is required');
    requireCheck(typeof checkpointFile === 'string' && checkpointFile.trim().length > 0,
        'CHECKPOINT_REQUIRED', 'explicit canonical scheduler checkpoint file is required');
    const verified = await verifyPublishedReleaseFinalAuthorityBinding({ bindings, handoffReference,
        ...(reference === undefined ? {} : { reference }),
        ...(explicitInputs === undefined ? {} : { explicitInputs }) });
    const scheduler = await import(new URL('../test-matrix/scheduler.mjs', import.meta.url));
    requireCheck(scheduler.schedulerCommittedEvidenceReadbackVersion === 1
        && typeof scheduler.verifyCommittedSchedulerEvidence === 'function',
    'SCHEDULER_READBACK_UNAVAILABLE', 'canonical scheduler committed-evidence readback v1 is not integrated');
    const committed = scheduler.verifyCommittedSchedulerEvidence({ checkpointFile, expectedCommittedRevision,
        context: bindings.context, registry: bindings.locatorRegistry, registryEntry: entry,
        repositoryRoot: bindings.repositoryRoot, expectedPayloadSchema: releaseFinalVerifiedAuthorityBindingSchema });
    const retained = committed.finalOutputRef;
    requireCheck(committed.committedRevision === expectedCommittedRevision
        && committed.finalOutputDigest === verified.locator.inputDigest
        && retained?.path === verified.locator.input.path
        && retained.inputDigest === verified.locator.inputDigest
        && retained.contentDigest === verified.locator.contentDigest
        && retained.producerReceiptDigest === verified.locator.producerReceiptDigest
        && retained.consumerId === entry.consumerId && retained.authorityId === entry.authorityId
        && retained.producerId === entry.producerId,
    'COMMITTED_OUTPUT_MISMATCH', 'committed wrapper reference differs from the independently verified final output');
    return Object.freeze({ binding: verified.binding, committedReadback: committed,
        publicationDigest: verified.publicationDigest,
        status: 'committed-reference-verified', qualificationEligible: false });
}

// Shared read-only input loading for local/CI consumers and the registered
// producer. Consumers never call the producer or accept injected owner APIs.
export function loadReleaseFinalBindingInputs(inputPath, inputDigest, { repositoryRoot = root, context } = {})
{
    requireCheck(typeof inputPath === 'string', 'MISSING_INPUT', 'explicit owned input path is required');
    requireCheck(!path.isAbsolute(inputPath) && !inputPath.includes('\\')
        && !inputPath.split('/').some((part) => ['', '.', '..'].includes(part)),
    'INPUT_PATH_REJECTED', 'producer inputs must be a canonical relative path');
    const file = path.resolve(repositoryRoot, inputPath);
    requireCheck(fs.realpathSync(file) === file && fs.lstatSync(file).isFile(),
        'INPUT_PATH_REJECTED', 'producer input must be a regular non-symlink file');
    const bytes = fs.readFileSync(file);
    requireCheck(digestBytes(bytes) === inputDigest, 'INPUT_DIGEST_MISMATCH', 'producer input digest mismatch');
    const inputs = JSON.parse(bytes);
    requireKeys(inputs, ['context', 'expectedPlanIdentity', 'testPlan', 'bindingInputs']);
    validateCurrentRunEvidenceContext(inputs.context);
    readOwnerEvidenceReference({ path: inputPath, digest: inputDigest },
        { repositoryRoot, context: inputs.context });
    const catalog = loadCanonicalRequiredEvidenceCatalog();
    const locatorRegistry = JSON.parse(fs.readFileSync(path.join(repositoryRoot,
        'config/testing/evidence-locator-registry.json'), 'utf8'));
    if (context !== undefined)
    {
        validateCurrentRunEvidenceContext(context);
        requireCheck(governanceContentDigest(context) === governanceContentDigest(inputs.context),
            'CURRENT_RUN_CONTEXT_MISMATCH', 'independent current-run context differs from original binding inputs');
    }
    const verifierRegistry = createDomainVerifierRegistry({ catalog, repositoryRoot });
    return { ...inputs, catalog, locatorRegistry, verifierRegistry, repositoryRoot };
}

export async function runReleaseFinalBindingProducer(argv, { repositoryRoot = root } = {})
{
    const args = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        const key = argv[index];
        requireCheck(['--inputs', '--inputs-digest', '--output'].includes(key)
            && !Object.hasOwn(args, key) && typeof argv[index + 1] === 'string',
        'UNSUPPORTED_INPUT', 'expected unique --inputs, --inputs-digest and --output arguments');
        args[key] = argv[index + 1];
    }
    requireCheck(Object.keys(args).length === 3, 'MISSING_INPUT', 'explicit input path/digest and output path are required');
    const bindings = loadReleaseFinalBindingInputs(args['--inputs'], args['--inputs-digest'], { repositoryRoot });
    return publishReleaseFinalVerifiedAuthorityBinding({ outputPath: args['--output'], bindings });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    runReleaseFinalBindingProducer(process.argv.slice(2)).then((result) =>
    {
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch((error) =>
    {
        console.error(`${error.reasonCode ?? 'PRODUCER_REJECTED'}: ${error.message}`);
        for (const command of error.localProducerCommands ?? [])
        {
            console.error(command);
        }
        process.exitCode = 1;
    });
}
