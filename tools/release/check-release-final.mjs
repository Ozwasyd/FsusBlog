#!/usr/bin/env node
/* eslint-disable import-x/no-relative-parent-imports */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    locateCurrentRunEvidence,
    verifyCurrentRunEvidenceBinding
} from '../test/current-run-evidence-locator.mjs';
import {
    releaseFinalDirectConsumerIds,
    resolveEvidenceReferencePayload
} from '../test/current-run-evidence-publication.mjs';
import { validateCurrentRunEvidenceContext } from '../test/evidence-location-contract.mjs';
import {
    readEvidenceDocument as readJson
} from '../test-matrix/content-addressed-evidence-store.mjs';
import { validateLocalProfileCheckpointEvidence } from '../test-matrix/scheduler.mjs';

import { loadReleaseFinalBindingInputs, verifyCommittedReleaseFinalAuthorityBinding } from './publish-release-final-bindings.mjs';
import {
    createReleaseFinalVerifiedAuthorityBinding,
    verifyReleaseFinalVerifiedAuthorityBinding,
    ReleaseFinalAuthorityBindingError
} from './test-evidence-receipts.mjs';
const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));

// Shared local/CI source-stage entry. In-memory verification remains
// unqualified; production consumption uses the committed-reference API below.
export async function consumeReleaseFinalVerifiedBindings(options)
{
    const binding = await createReleaseFinalVerifiedAuthorityBinding(options);
    return verifyReleaseFinalVerifiedAuthorityBinding(binding, options);
}

export { assessReleaseFinalTerminalPrerequisites } from './test-evidence-receipts.mjs';

const directEvidenceContract = Object.freeze({
    'evidence-consumer.test-matrix.behavior-evidence-pre-runtime': ['behaviorPreRuntime', 'fsusblog.behavior-evidence-pre-runtime-receipt.v1'],
    'evidence-consumer.release-final.direct.behavior-consistency': ['behaviorConsistency', 'fsusblog.behavior-document-consistency-final-report.v1'],
    'evidence-consumer.release-final.direct.behavior-post-runtime': ['behaviorPostRuntime', 'fsusblog.behavior-evidence-post-runtime-receipt.v1'],
    'evidence-consumer.release-final.direct.browser-contract': ['browserContract', 'fsusblog.browser-contract-receipt.v2'],
    'evidence-consumer.release-final.direct.browserless-correctness': ['browserlessCorrectness', 'fsusblog.browserless-correctness-receipt.v1'],
    'evidence-consumer.release-final.direct.production-build': ['productionBuild', 'fsusblog.ci-production-build-receipt.v1'],
    'evidence-consumer.release-final.direct.public-preview': ['publicPreview', 'fsusblog.public-preview-screenshot-verification.v1']
});

export function locateReleaseFinalDirectEvidence({ context, parentPath, registry, repositoryRoot = root })
{
    const parentEntry = registry.entries.find((entry) =>
        entry.consumerId === 'evidence-consumer.release.release-final-domain-evidence');
    const parentLocated = locateCurrentRunEvidence({ context, registry, registryEntry: parentEntry,
        repositoryRoot, explicitInputs: [parentPath] });
    verifyCurrentRunEvidenceBinding(parentLocated.bindingReceipt,
        { context, registry, registryEntry: parentEntry, repositoryRoot });
    const children = parentLocated.receipt.children ?? [];
    const expectedAuthorities = releaseFinalDirectConsumerIds.map((consumerId) =>
        registry.entries.find((entry) => entry.consumerId === consumerId)?.authorityId).sort();
    const actualAuthorities = children.map((child) => child.authorityId).sort();
    if (JSON.stringify(actualAuthorities) !== JSON.stringify(expectedAuthorities))
    {
        throw new Error('release-final parent does not contain the exact direct authority set');
    }
    const directEvidence = {};
    for (const child of children)
    {
        const entry = registry.entries.find((candidate) => candidate.authorityId === child.authorityId);
        const located = locateCurrentRunEvidence({ context, registry, registryEntry: entry,
            repositoryRoot, explicitInputs: [child.path] });
        verifyCurrentRunEvidenceBinding(located.bindingReceipt,
            { context, registry, registryEntry: entry, repositoryRoot });
        if (located.bindingReceipt.inputDigest !== child.inputDigest
            || located.receipt.producerReceiptDigest !== child.producerReceiptDigest)
        {
            throw new Error(`release-final parent child binding mismatch: ${child.authorityId}`);
        }
        const resolved = resolveEvidenceReferencePayload(located.receipt,
            { repositoryRoot, ownedRoots: context.ownedRoots });
        const [key, schema] = directEvidenceContract[entry.consumerId] ?? [];
        if (!key || resolved.payload?.schema !== schema)
        {
            throw new Error(`release-final direct payload schema mismatch: ${entry.consumerId}`);
        }
        directEvidence[key] = { file: resolved.file, receipt: resolved.payload,
            locatorBindingReceipt: located.bindingReceipt,
            payloadDigest: located.receipt.payload.digest };
    }
    return { directEvidence, parentBindingReceipt: parentLocated.bindingReceipt };
}

export function validateQualifiedLocalProfile(checkpointFile, manifest, checkpointRoot = root)
{
    const errors = [];
    if (!checkpointFile || !fs.existsSync(checkpointFile) || !fs.statSync(checkpointFile).isFile())
    {
        return ['qualified local-profile checkpoint is missing'];
    }
    let checkpoint;
    try
    {
        checkpoint = readJson(checkpointFile);
    }
    catch
    {
        return ['qualified local-profile checkpoint is invalid JSON'];
    }
    const projection = checkpoint?.logicalTierProjection;
    if (!projection || typeof projection !== 'object')
    {
        return ['qualified local-profile checkpoint has no logicalTierProjection'];
    }
    try
    {
        validateLocalProfileCheckpointEvidence(checkpoint, checkpointRoot);
    }
    catch (error)
    {
        errors.push(`local-profile projection sealed validation failed: ${error.message}`);
    }
    if (projection.status !== 'complete-success' || projection.qualificationEligible !== true)
    {
        errors.push('local-profile projection is not qualification-eligible complete-success');
    }
    if (projection.sourceState?.commit !== manifest.commitSha)
    {
        errors.push('local-profile projection commit does not match release manifest');
    }
    for (const [tierId, entry] of Object.entries(projection.entries ?? {}))
    {
        if (entry?.evidenceKind === 'summary-only' || entry?.status !== 'success')
        {
            errors.push(`local-profile projection entry ${tierId} is not executed success`);
            continue;
        }
        if (entry.evidenceKind === 'external-executed'
            && (!entry.authorityId || entry.schedulerRunId !== projection.runId
                || !entry.buildIdentity?.artifactDigestTableDigest || !entry.blockedPlaceholder))
        {
            errors.push(`local-profile projection entry ${tierId} external receipt binding is invalid`);
        }
    }
    return errors;
}

// Exact explicit transport for both local and CI. This consumes the existing
// immutable v2 manifest and its canonical committed wrapper; it creates no
// alternate final authority, writes no output and never invokes the producer.
export async function runReleaseFinalizer(argv, { repositoryRoot = root } = {})
{
    const keys = ['--current-run-context', '--inputs', '--inputs-digest', '--checkpoint',
        '--committed-revision', '--reference', '--reference-digest', '--handoff', '--handoff-digest'];
    const args = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        const key = argv[index];
        if (!keys.includes(key) || Object.hasOwn(args, key)
            || typeof argv[index + 1] !== 'string' || argv[index + 1].trim().length === 0)
        {
            throw new ReleaseFinalAuthorityBindingError('UNSUPPORTED_INPUT',
                'finalizer requires unique explicit binding, wrapper, handoff and committed checkpoint inputs');
        }
        args[key] = argv[index + 1];
    }
    if (keys.some((key) => !Object.hasOwn(args, key)))
    {
        throw new ReleaseFinalAuthorityBindingError('MISSING_INPUT', 'all explicit finalizer inputs are required');
    }
    const revision = args['--committed-revision'];
    if (!/^[1-9][0-9]*$/u.test(revision) || !Number.isSafeInteger(Number(revision)))
    {
        throw new ReleaseFinalAuthorityBindingError('COMMITTED_REVISION_REQUIRED',
            'independently expected after-write committed revision must be a positive safe integer');
    }
    const contextFile = path.resolve(repositoryRoot, args['--current-run-context']);
    if (fs.realpathSync(contextFile) !== contextFile || !fs.lstatSync(contextFile).isFile())
    {
        throw new ReleaseFinalAuthorityBindingError('CONTEXT_PATH_REJECTED',
            'current-run context must be an explicit regular non-symlink file');
    }
    const context = readJson(contextFile);
    validateCurrentRunEvidenceContext(context);
    const bindings = loadReleaseFinalBindingInputs(args['--inputs'], args['--inputs-digest'], { repositoryRoot, context });
    return verifyCommittedReleaseFinalAuthorityBinding({ bindings,
        checkpointFile: args['--checkpoint'], expectedCommittedRevision: Number(revision),
        reference: { path: args['--reference'], objectDigest: args['--reference-digest'] },
        handoffReference: { path: args['--handoff'], digest: args['--handoff-digest'] } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    runReleaseFinalizer(process.argv.slice(2)).then((result) =>
    {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        // Readback proves a committed reference. The public reader does not
        // grant terminal/domain qualification, so this lane remains fail closed.
        if (result.qualificationEligible !== true)
        {
            console.error('[release-final] TERMINAL_QUALIFICATION_UNAVAILABLE: committed reference verification does not qualify a release');
            process.exitCode = 1;
        }
    }).catch((error) =>
    {
        console.error(`${error.reasonCode ?? 'FINALIZER_REJECTED'}: ${error.message}`);
        for (const command of error.localProducerCommands ?? [])
        {
            console.error(command);
        }
        process.exitCode = 1;
    });
}
