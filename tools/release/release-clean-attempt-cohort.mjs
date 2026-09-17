import fs from 'node:fs';
import path from 'node:path';

const {canonicalJson, digestCanonical, sealContentDigest} = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));
import { resolveTransportedCleanAttemptEvidence } from './clean-attempt-evidence-transport.mjs';
import { cleanFirstAttemptVerdict, fileBackedCleanAttemptEvidence } from './clean-first-attempt-verifier.mjs';

export const cleanAttemptCohortSchema = 'fsusblog.release-clean-attempt-cohort.v1';

function normalizedReference(reference, label)
{
    if (!reference || typeof reference !== 'object'
        || typeof reference.path !== 'string' || !reference.path
        || !/^sha256:[0-9a-f]{64}$/u.test(String(reference.digest ?? '')))
    {
        throw new Error(`${label} requires an exact path and SHA-256 digest`);
    }
    const relative = reference.path;
    if (relative.includes('\\') || /^[a-z]:/iu.test(relative)
        || path.posix.isAbsolute(relative)
        || path.posix.normalize(relative) !== relative
        || relative.split('/').some((segment) => segment === '..' || segment === '.'))
    {
        throw new Error(`${label} requires a canonical relative path`);
    }
    return { path: relative, digest: reference.digest,
        ...(reference.fileDigest === undefined ? {} : { fileDigest: reference.fileDigest }) };
}

function evidenceBinding(verdict, aggregateReference, aggregateReceipt)
{
    const aggregate = verdict.aggregate;
    const attempt = verdict.attempt;
    return {
        producerId: aggregate?.producerId ?? null,
        schedulerRunId: aggregate?.schedulerRunId ?? null,
        sourceCommit: aggregate?.sourceCommit ?? null,
        worktreeFingerprint: aggregate?.worktreeFingerprint ?? null,
        retryPolicyId: aggregate?.retryPolicyId ?? null,
        aggregateReceipt: aggregate ? normalizedReference(aggregateReference, 'aggregateReceipt') : {
            path: typeof aggregateReference?.path === 'string' ? aggregateReference.path : null,
            digest: typeof aggregateReference?.digest === 'string' ? aggregateReference.digest : null,
            fileDigest: typeof aggregateReference?.fileDigest === 'string' ? aggregateReference.fileDigest : null
        },
        attemptReceipt: attempt && aggregateReceipt?.attempts?.[0]
            ? normalizedReference({
                path: aggregateReceipt.attempts[0].path,
                digest: aggregateReceipt.attempts[0].digest
            }, 'attemptReceipt')
            : null,
        attemptNumber: attempt?.attemptNumber ?? null,
        firstFailure: attempt?.firstFailure ?? null,
        cleanFirstAttempt: aggregate?.cleanFirstAttempt ?? false,
        qualificationEligible: aggregate?.qualificationEligible ?? false,
        executionEnvelopeDigest: attempt?.executionEnvelopeDigest ?? null,
        replayPlanDigest: attempt?.replayPlanDigest ?? null,
        temporalContextDigest: attempt?.temporalContextDigest ?? null,
        logs: attempt ? {
            stdout: {
                path: attempt.stdoutPath,
                digest: attempt.artifactDigests[attempt.stdoutPath]
            },
            stderr: {
                path: attempt.stderrPath,
                digest: attempt.artifactDigests[attempt.stderrPath]
            }
        } : null,
        artifacts: attempt ? attempt.artifactPaths.map((artifactPath) => ({
            path: artifactPath,
            digest: attempt.artifactDigests[artifactPath]
        })) : []
    };
}

export function createCleanAttemptCohort(cohortId, buildIdentity)
{
    if (typeof cohortId !== 'string' || !cohortId.trim()
        || !/^sha256:[0-9a-f]{64}$/u.test(String(buildIdentity ?? '')))
    {
        throw new Error('cohortId and buildIdentity are required');
    }
    return sealContentDigest({
        schema: cleanAttemptCohortSchema,
        cohortId: cohortId.trim(),
        buildIdentity,
        previousRevisionDigest: null,
        events: [],
        qualificationEligible: false
    });
}

export function appendCleanAttemptCohortSlot(cohort, {
    slot,
    evidenceRoot,
    aggregateReference,
    verifyAuthority,
    expectedIdentity = {},
    transport = null
})
{
    validateCleanAttemptCohort(cohort);
    if (!Number.isInteger(slot) || slot < 1 || slot > 3)
    {
        throw new Error(`cohort slot must be 1, 2, or 3; got ${slot}`);
    }
    if (cohort.events.some((event) => event.slot === slot))
    {
        throw new Error(`cohort.slot-immutable: slot ${slot} already has an append-only admission event`);
    }
    let resolvedTransport = null;
    let transportError = null;
    if (transport)
    {
        try
        {
            resolvedTransport = resolveTransportedCleanAttemptEvidence({
                repositoryRoot: transport.repositoryRoot ?? evidenceRoot,
                transportManifestPath: transport.transportManifestPath ?? transport.manifestPath,
                transportManifest: transport.manifest,
                authorityId: transport.authorityId,
                referencePath: transport.referencePath,
                expectedIdentity
            });
        }
        catch (error)
        {
            transportError = error;
        }
    }
    const files = fileBackedCleanAttemptEvidence({
        evidenceRoot: resolvedTransport?.evidenceRoot ?? evidenceRoot,
        aggregateReference: resolvedTransport?.aggregateReference ?? aggregateReference,
        transportEntries: resolvedTransport?.transportEntries
    });
    const verdict = transportError
        ? {
            schema: 'fsusblog.clean-first-attempt-verdict.v1',
            eligible: false,
            reasons: [{
                code: transportError.reasonCode ?? 'attempt.transport-manifest-invalid',
                message: transportError.message,
                producerId: expectedIdentity.producerId ?? null,
                schedulerRunId: expectedIdentity.schedulerRunId ?? null
            }],
            aggregate: null,
            attempt: null
        }
        : cleanFirstAttemptVerdict({
            loadAggregate: files.loadAggregate,
            loadAttempt: files.loadAttempt,
            verifyAuthority,
            verifyArtifact: files.verifyArtifact,
            expectedIdentity
        });
    const aggregateReceipt = files.aggregateReceipt;
    const boundAggregateReference = resolvedTransport?.aggregateReference ?? aggregateReference;
    const binding = evidenceBinding(verdict, boundAggregateReference, aggregateReceipt);
    binding.buildIdentity = cohort.buildIdentity;
    if (resolvedTransport)
    {
        binding.transport = {
            manifestPath: transport.transportManifestPath ?? transport.manifestPath ?? null,
            manifestDigest: resolvedTransport.transportManifest.contentDigest,
            authorityId: transport.authorityId,
            referencePath: resolvedTransport.reference.extractedPath
                ?? resolvedTransport.transportObject.extractedPath,
            aggregatePath: resolvedTransport.aggregateReference.path
        };
    }
    const duplicateRun = cohort.events.find((event) => (
        event.evidence.schedulerRunId !== null
        && event.evidence.schedulerRunId === binding.schedulerRunId
    ));
    const duplicateAttemptRoot = cohort.events.find((event) => (
        typeof event.evidence.aggregateReceipt.path === 'string'
        && typeof binding.aggregateReceipt.path === 'string'
        && path.posix.dirname(event.evidence.aggregateReceipt.path)
            === path.posix.dirname(binding.aggregateReceipt.path)
    ));
    const reasons = [...verdict.reasons];
    const sourceAnchor = cohort.events.find((entry) => entry.status === 'admitted');
    if (verdict.eligible && sourceAnchor)
    {
        for (const field of ['sourceCommit', 'worktreeFingerprint'])
        {
            if (binding[field] !== sourceAnchor.evidence[field])
            {
                reasons.push({
                    code: 'cohort.source-identity-mismatch',
                    message: `slot ${slot} changes ${field} from slot ${sourceAnchor.slot}`,
                    slot,
                    conflictingSlot: sourceAnchor.slot,
                    producerId: binding.producerId,
                    schedulerRunId: binding.schedulerRunId,
                    field,
                    expected: sourceAnchor.evidence[field],
                    actual: binding[field]
                });
            }
        }
    }
    if (duplicateRun)
    {
        reasons.push({
            code: 'cohort.run-not-independent',
            message: `slot ${slot} reuses schedulerRunId ${binding.schedulerRunId} from slot ${duplicateRun.slot}`,
            slot,
            conflictingSlot: duplicateRun.slot,
            producerId: binding.producerId,
            schedulerRunId: binding.schedulerRunId
        });
    }
    if (duplicateAttemptRoot)
    {
        reasons.push({
            code: 'cohort.attempt-root-not-independent',
            message: `slot ${slot} reuses attempt root ${path.posix.dirname(binding.aggregateReceipt.path)} from slot ${duplicateAttemptRoot.slot}`,
            slot,
            conflictingSlot: duplicateAttemptRoot.slot,
            producerId: binding.producerId,
            schedulerRunId: binding.schedulerRunId
        });
    }
    const event = sealContentDigest({
        schema: 'fsusblog.release-clean-attempt-cohort-event.v1',
        sequence: cohort.events.length + 1,
        slot,
        previousEventDigest: cohort.events.at(-1)?.contentDigest ?? null,
        status: verdict.eligible && reasons.length === 0 ? 'admitted' : 'rejected',
        reasons,
        evidence: binding
    });
    const events = [...cohort.events, event];
    const qualificationEligible = events.length === 3
        && events.every((entry) => entry.status === 'admitted')
        && new Set(events.map((entry) => entry.evidence.schedulerRunId)).size === 3
        && new Set(events.map((entry) => path.posix.dirname(entry.evidence.aggregateReceipt.path))).size === 3;
    return sealContentDigest({
        schema: cleanAttemptCohortSchema,
        cohortId: cohort.cohortId,
        buildIdentity: cohort.buildIdentity,
        previousRevisionDigest: cohort.contentDigest,
        events,
        qualificationEligible
    });
}

export function validateCleanAttemptCohort(cohort)
{
    if (cohort?.schema !== cleanAttemptCohortSchema)
    {
        throw new Error(`cohort schema must be ${cleanAttemptCohortSchema}`);
    }
    const unsigned = { ...cohort };
    delete unsigned.contentDigest;
    if (cohort.contentDigest !== digestCanonical(unsigned))
    {
        throw new Error('cohort content digest mismatch');
    }
    if (!Array.isArray(cohort.events) || cohort.events.length > 3)
    {
        throw new Error('cohort must contain at most three append-only events');
    }
    let previous = null;
    let sourceAnchor = null;
    const slots = new Set();
    for (const [index, event] of cohort.events.entries())
    {
        if (event?.schema !== 'fsusblog.release-clean-attempt-cohort-event.v1'
            || !Number.isInteger(event.slot) || event.slot < 1 || event.slot > 3
            || !['admitted', 'rejected'].includes(event.status)
            || !Array.isArray(event.reasons)
            || (event.status === 'admitted' && event.reasons.length !== 0)
            || (event.status === 'rejected' && event.reasons.length === 0)
            || event.reasons.some((item) => (
                typeof item?.code !== 'string' || !item.code.trim()
                || typeof item?.message !== 'string' || !item.message.trim()
            )))
        {
            throw new Error(`cohort event ${index + 1} has an invalid slot or disposition`);
        }
        const eventUnsigned = { ...event };
        delete eventUnsigned.contentDigest;
        if (event.sequence !== index + 1
            || event.previousEventDigest !== previous
            || event.contentDigest !== digestCanonical(eventUnsigned)
            || slots.has(event.slot))
        {
            throw new Error(`cohort event ${index + 1} breaks the append-only slot chain`);
        }
        slots.add(event.slot);
        if (event.evidence?.buildIdentity !== cohort.buildIdentity)
        {
            throw new Error(`cohort event ${index + 1} changes build identity`);
        }
        if (event.status === 'admitted')
        {
            normalizedReference(event.evidence?.aggregateReceipt, `cohort event ${index + 1} aggregateReceipt`);
            if (sourceAnchor && ['sourceCommit', 'worktreeFingerprint'].some((field) => (
                event.evidence[field] !== sourceAnchor[field]
            )))
            {
                throw new Error(`cohort event ${index + 1} changes source identity`);
            }
            sourceAnchor ??= event.evidence;
        }
        previous = event.contentDigest;
    }
    const eligible = cohort.events.length === 3
        && cohort.events.every((event) => event.status === 'admitted')
        && new Set(cohort.events.map((event) => event.evidence.schedulerRunId)).size === 3
        && new Set(cohort.events.map((event) => path.posix.dirname(event.evidence.aggregateReceipt.path))).size === 3;
    if (cohort.qualificationEligible !== eligible)
    {
        throw new Error('cohort qualification does not match three independent admitted slots');
    }
    return cohort;
}

export function persistCleanAttemptCohortRevision(file, cohort)
{
    validateCleanAttemptCohort(cohort);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${canonicalJson(cohort)}\n`, { flag: 'wx', mode: 0o444 });
}

export function admitCleanAttemptCohort({
    cohortId,
    buildIdentity,
    slots,
    outputFile
})
{
    if (!Array.isArray(slots)
        || JSON.stringify(slots.map((entry) => entry?.slot)) !== JSON.stringify([1, 2, 3]))
    {
        throw new Error('release clean-attempt cohort input must contain exact ordered slots 1, 2, and 3');
    }
    let cohort = createCleanAttemptCohort(cohortId, buildIdentity);
    for (const { slot, attemptEvidence } of slots)
    {
        cohort = appendCleanAttemptCohortSlot(cohort, {
            slot,
            evidenceRoot: attemptEvidence?.evidenceRoot,
            aggregateReference: attemptEvidence?.aggregateReference,
            verifyAuthority: attemptEvidence?.verifyAuthority,
            expectedIdentity: attemptEvidence?.expectedIdentity,
            transport: attemptEvidence?.transport
        });
    }
    persistCleanAttemptCohortRevision(outputFile, cohort);
    if (!cohort.qualificationEligible)
    {
        const rejected = cohort.events.find((event) => event.status === 'rejected');
        const reasons = rejected?.reasons.map((reason) => reason.code).join(', ') || 'cohort.not-qualified';
        throw new Error(`release clean-attempt cohort slot ${rejected?.slot ?? 'unknown'} rejected: ${reasons}`);
    }
    return cohort;
}
