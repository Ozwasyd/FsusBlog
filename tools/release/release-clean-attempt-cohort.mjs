import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readCleanAttemptEvidenceSource } from './clean-attempt-evidence-source.mjs';
import { resolveTransportedCleanAttemptEvidence } from './clean-attempt-evidence-transport.mjs';
import { cleanFirstAttemptVerdict, fileBackedCleanAttemptEvidence } from './clean-first-attempt-verifier.mjs';

const {canonicalJson, digestCanonical, sealContentDigest} = await import(new URL('../test/attempt-provenance.mjs', import.meta.url));
const {requiredEvidenceAuthoritiesForContext, loadCanonicalRequiredEvidenceCatalog} = await import(new URL('../test-matrix/required-evidence-catalog.mjs', import.meta.url));
const {verifyProductionBuildReceipt} = await import(new URL('../ci/production-build-artifacts.mjs', import.meta.url));
const {validateCurrentRunEvidenceContext} = await import(new URL('../test/evidence-location-contract.mjs', import.meta.url));

export const cleanAttemptCohortSchema = 'fsusblog.release-clean-attempt-cohort.v1';

function archiveInputBytes(root, relative, { fileDigest, digest } = {})
{
    normalizedReference({ path: relative, digest: fileDigest ?? digest }, 'archive reference');
    const canonicalRoot = fs.realpathSync(root);
    const file = path.resolve(canonicalRoot, relative);
    const within = path.relative(canonicalRoot, file);
    const stat = fs.lstatSync(file);
    if (!within || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)
        || !stat.isFile() || fs.realpathSync(file) !== file)
    {
        throw new Error(`archive reference must be a contained regular non-symlink file: ${relative}`);
    }
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes;
    try
    {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
        {
            throw new Error(`archive reference changed identity: ${relative}`);
        }
        bytes = fs.readFileSync(descriptor);
        const finished = fs.fstatSync(descriptor);
        const current = fs.lstatSync(file);
        if (bytes.length !== opened.size || finished.size !== opened.size
            || finished.mtimeMs !== opened.mtimeMs || finished.ctimeMs !== opened.ctimeMs
            || current.dev !== opened.dev || current.ino !== opened.ino
            || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs
            || current.ctimeMs !== opened.ctimeMs || fs.realpathSync(file) !== file)
        {
            throw new Error(`archive reference changed while being read: ${relative}`);
        }
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    if ((fileDigest && `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== fileDigest)
        || (!fileDigest && sealContentDigest(JSON.parse(bytes)).contentDigest !== digest))
    {
        throw new Error(`archive reference digest mismatch: ${relative}`);
    }
    return bytes;
}

function referencedBytes(root, reference)
{
    return archiveInputBytes(root, reference.path, { fileDigest: reference.fileDigest });
}

function archiveDestination(root, relative)
{
    normalizedReference({ path: relative, digest: `sha256:${'0'.repeat(64)}` }, 'archive destination');
    // Inspect each existing ancestor before mkdir; recursive mkdir would follow
    // a symlink parent before the containment check could run.
    const absoluteRoot = path.resolve(root);
    let current = path.parse(absoluteRoot).root;
    for (const segment of [...absoluteRoot.slice(current.length).split(path.sep), ...relative.split('/').slice(0, -1)])
    {
        current = path.join(current, segment);
        if (!fs.existsSync(current))
        {
            fs.mkdirSync(current);
        }
        if (!fs.lstatSync(current).isDirectory() || fs.realpathSync(current) !== current)
        {
            throw new Error('archive destination must have contained non-symlink directory parents');
        }
    }
    const destination = path.resolve(absoluteRoot, relative);
    const within = path.relative(absoluteRoot, destination);
    if (!within || within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
    {
        throw new Error('archive destination escapes its owned root');
    }
    return destination;
}

export function verifyCleanAttemptCandidateGraph(candidate, repositoryRoot)
{
    if (candidate?.targetTier !== 'release-final' || typeof repositoryRoot !== 'string')
    {
        throw new Error('cohort qualification requires the existing release-final formal context and its independent receipt root');
    }
    const graph = candidate?.buildGraph;
    if (!graph || typeof graph.artifactRoot !== 'string')
    {
        throw new Error('external candidate requires the canonical production build receipt graph');
    }
    const bytes = referencedBytes(repositoryRoot, graph.receiptReference);
    const receipt = JSON.parse(bytes);
    const artifactRoot = path.resolve(repositoryRoot, graph.artifactRoot);
    if (path.resolve(artifactRoot, graph.receiptFile) !== path.resolve(repositoryRoot, graph.receiptReference.path))
    {
        throw new Error('build receipt reference does not belong to its canonical artifact root');
    }
    verifyProductionBuildReceipt({ artifactRoot, receiptFile: graph.receiptFile, repairReadOnlySeal: false,
        expectedReceiptDigest: candidate.buildIdentity,
        expectedSourceState: { commit: candidate.sourceCommit, worktreeFingerprint: candidate.worktreeFingerprint },
        expectedProducer: graph.producer });
    if (receipt.contentDigest !== graph.receiptReference.digest)
    {
        throw new Error('build receipt content digest mismatch');
    }
    const imageIdentity = JSON.parse(referencedBytes(repositoryRoot, candidate.imageIdentityReference));
    if (imageIdentity.schema !== 'fsusblog.release-reliability-run-identity.v1'
        || imageIdentity.status !== 'complete' || sealContentDigest(imageIdentity).contentDigest !== candidate.imageIdentityReference.digest
        || imageIdentity.contentDigest !== candidate.imageIdentityReference.digest
        || imageIdentity.sourceState?.commit !== candidate.sourceCommit
        || `sha256:${String(imageIdentity.sourceState?.worktreeFingerprint).replace(/^sha256:/u, '')}` !== candidate.worktreeFingerprint
        || imageIdentity.build?.contentDigest !== candidate.buildIdentity
        || imageIdentity.build?.fileDigest !== graph.receiptReference.fileDigest
        || imageIdentity.build?.imageDigest !== candidate.imageDigest
        || imageIdentity.build?.image?.imageDigest !== candidate.imageDigest
        || imageIdentity.build?.image?.revision !== candidate.sourceCommit
        || !candidate.slots?.some((slot) => slot.schedulerRunId === imageIdentity.runId))
    {
        throw new Error('external candidate image identity crosses canonical source/build/run receipt graph');
    }
    if (JSON.stringify(candidate.slots?.map((slot) => slot.slot)) !== JSON.stringify([1, 2, 3]))
    {
        throw new Error('external candidate requires the exact formal release-final contexts 1, 2, and 3');
    }
    for (const slot of candidate.slots)
    {
        const context = validateCurrentRunEvidenceContext(JSON.parse(referencedBytes(repositoryRoot, slot.contextReference)));
        if (context.sourceCommit !== candidate.sourceCommit || context.worktreeFingerprint !== candidate.worktreeFingerprint
            || context.schedulerRunId !== slot.schedulerRunId || context.buildIdentity.digest !== candidate.buildIdentity)
        {
            throw new Error(`external candidate slot ${slot.slot} crosses canonical current-run source/build identity`);
        }
    }
    return receipt;
}

// Freeze only explicitly referenced producer files. Paths in the archived source
// documents are rooted at the release archive, never at the original machine.
export function archiveCleanAttemptCohortInputs({ slots, expectedCandidate, repositoryRoot, archiveRoot,
    cohortId, rejectedOutputFile })
{
    if (rejectedOutputFile)
    {
        archiveDestination(archiveRoot, path.relative(path.resolve(archiveRoot), path.resolve(rejectedOutputFile)).replaceAll(path.sep, '/'));
    }
    // Admission is read-only here. Rejected events are sealed before ANY archive
    // copy, not after potentially exporting untrusted producer references.
    admitCleanAttemptCohort({ cohortId, buildIdentity: expectedCandidate.buildIdentity, slots,
        expectedCandidate, candidateRepositoryRoot: repositoryRoot, rejectedOutputFile });
    const entries = [];
    const copy = (sourceRoot, sourceRelative, reference, relative) =>
    {
        const destination = archiveDestination(archiveRoot, relative);
        const bytes = archiveInputBytes(sourceRoot, sourceRelative, reference);
        fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o444 });
        const fileDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        entries.push({ path: relative, fileDigest });
        return { path: relative, fileDigest };
    };
    const candidate = structuredClone(expectedCandidate);
    const build = JSON.parse(referencedBytes(repositoryRoot, candidate.buildGraph.receiptReference));
    const originalBuildRoot = path.resolve(repositoryRoot, candidate.buildGraph.artifactRoot);
    candidate.buildGraph.artifactRoot = 'cohort-evidence/build';
    candidate.buildGraph.receiptReference = { ...copy(repositoryRoot,
        expectedCandidate.buildGraph.receiptReference.path, expectedCandidate.buildGraph.receiptReference,
        `cohort-evidence/build/${candidate.buildGraph.receiptFile}`), digest: build.contentDigest };
    for (const artifact of build.artifacts)
    {
        normalizedReference({ path: artifact.path, digest: artifact.sha256 }, 'build artifact');
        copy(originalBuildRoot, artifact.path, { fileDigest: artifact.sha256 }, `cohort-evidence/build/${artifact.path}`);
    }
    for (const slot of candidate.slots)
    {
        slot.contextReference = copy(repositoryRoot, slot.contextReference.path, slot.contextReference,
            `cohort-evidence/slot-${slot.slot}/current-run-context.json`);
    }
    candidate.imageIdentityReference = { ...copy(repositoryRoot, candidate.imageIdentityReference.path, candidate.imageIdentityReference,
        'cohort-evidence/image-identity.json'), digest: candidate.imageIdentityReference.digest };
    const archivedSlots = slots.map((slot) => ({ slot: slot.slot, members: slot.members.map((member) =>
    {
        const prefix = `cohort-evidence/slot-${slot.slot}/${member.authorityId}`;
        const sourceFile = path.resolve(repositoryRoot, member.evidenceSource.path);
        const document = JSON.parse(referencedBytes(repositoryRoot, {
            path: path.relative(repositoryRoot, sourceFile).replaceAll(path.sep, '/'), fileDigest: member.evidenceSource.fileDigest }));
        const evidence = member.attemptEvidence;
        if (evidence.transport)
        {
            throw new Error('cohort archive requires restored canonical producer files, not an unresolved transport');
        }
        const aggregatePath = evidence.aggregateReference.path;
        const aggregate = JSON.parse(referencedBytes(evidence.evidenceRoot, evidence.aggregateReference));
        const producerRoot = path.posix.dirname(aggregatePath);
        copy(evidence.evidenceRoot, aggregatePath, evidence.aggregateReference, `${prefix}/attempt-evidence/${aggregatePath}`);
        for (const reference of aggregate.attempts)
        {
            normalizedReference(reference, 'raw attempt reference');
            const attemptPath = path.posix.join(producerRoot, reference.path);
            const attempt = JSON.parse(archiveInputBytes(evidence.evidenceRoot, attemptPath, reference));
            copy(evidence.evidenceRoot, attemptPath, reference, `${prefix}/attempt-evidence/${attemptPath}`);
            for (const artifact of attempt.artifactPaths)
            {
                const artifactReference = { fileDigest: attempt.artifactDigests[artifact] };
                normalizedReference({ path: artifact, digest: artifactReference.fileDigest }, 'raw attempt artifact');
                const relative = path.posix.join(producerRoot, `attempt-${attempt.attemptNumber}`, artifact);
                copy(evidence.evidenceRoot, relative, artifactReference, `${prefix}/attempt-evidence/${relative}`);
            }
        }
        for (const authority of document.authorityReferences)
        {
            const authorityRoot = path.resolve(repositoryRoot, document.authorityRoot);
            copy(authorityRoot, authority.artifactPath, { fileDigest: authority.artifactFileDigest }, `${prefix}/authorities/${authority.artifactPath}`);
            copy(authorityRoot, authority.verificationReceiptPath,
                document.authorityVerificationReceipts[authority.kind], `${prefix}/authorities/${authority.verificationReceiptPath}`);
        }
        document.evidenceRoot = `${prefix}/attempt-evidence`;
        document.authorityRoot = `${prefix}/authorities`;
        const sourceRelative = `${prefix}/source.json`;
        const destination = archiveDestination(archiveRoot, sourceRelative);
        const bytes = `${canonicalJson(document)}\n`;
        fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o444 });
        const evidenceSource = { path: sourceRelative, fileDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
        entries.push(evidenceSource);
        return { authorityId: member.authorityId, evidenceSource,
            attemptEvidence: readCleanAttemptEvidenceSource(sourceRelative, { repositoryRoot: archiveRoot }) };
    }) }));
    const candidateFile = archiveDestination(archiveRoot, 'clean-attempt-expected-candidate.json');
    fs.writeFileSync(candidateFile, `${canonicalJson(candidate)}\n`, { flag: 'wx', mode: 0o444 });
    const graph = sealContentDigest({ schema: 'fsusblog.release-clean-attempt-archive-graph.v1',
        entries: entries.sort((left, right) => left.path.localeCompare(right.path)) });
    fs.writeFileSync(archiveDestination(archiveRoot, 'clean-attempt-archive-graph.json'), `${canonicalJson(graph)}\n`, { flag: 'wx', mode: 0o444 });
    return { slots: archivedSlots, expectedCandidate: candidate, graph };
}

function verifyCohortAttempt(files, verifyAuthority, expectedIdentity, candidateOptions = {})
{
    return cleanFirstAttemptVerdict({ loadAggregate: files.loadAggregate, loadAttempt: files.loadAttempt,
        verifyArtifact: files.verifyArtifact, verifyAuthority, expectedIdentity, ...candidateOptions });
}

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
        : verifyCohortAttempt(files, verifyAuthority, expectedIdentity);
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
        && events.every((entry) => entry.status === 'admitted' && Array.isArray(entry.evidence.members))
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
            if (event.evidence.members)
            {
                const roster = requiredCleanAttemptCohortMembers();
                if (event.evidence.requiredCatalogDigest !== loadCanonicalRequiredEvidenceCatalog().contentDigest
                    || JSON.stringify(event.evidence.members.map((member) => member.authorityId))
                        !== JSON.stringify(roster.map((member) => member.authorityId))
                    || event.evidence.members.some((member, memberIndex) => member.producerId !== roster[memberIndex].producerId
                        || member.sourceCommit !== event.evidence.sourceCommit
                        || member.worktreeFingerprint !== event.evidence.worktreeFingerprint
                        || member.schedulerRunId !== event.evidence.schedulerRunId
                        || member.buildIdentity !== cohort.buildIdentity
                        || member.attemptNumber !== 1 || member.firstFailure !== false
                        || member.cleanFirstAttempt !== true || member.qualificationEligible !== true
                        || !member.domainReceiptReference || !member.logs || !member.artifacts?.length))
                {
                    throw new Error(`cohort event ${index + 1} has incomplete formal producer membership or candidate binding`);
                }
            }
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
        && cohort.events.every((event) => event.status === 'admitted' && Array.isArray(event.evidence.members))
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
    expectedCandidate,
    candidateRepositoryRoot,
    outputFile,
    rejectedOutputFile
})
{
    if (!Array.isArray(slots)
        || JSON.stringify(slots.map((entry) => entry?.slot)) !== JSON.stringify([1, 2, 3]))
    {
        throw new Error('release clean-attempt cohort input must contain exact ordered slots 1, 2, and 3');
    }
    let cohort = createCleanAttemptCohort(cohortId, buildIdentity);
    try
    {
        verifyCleanAttemptCandidateGraph(expectedCandidate, candidateRepositoryRoot);
    }
    catch (error)
    {
        throw new Error(`release clean-attempt cohort external candidate rejected: ${error.message}`, { cause: error });
    }
    const roster = requiredCleanAttemptCohortMembers();
    if (!expectedCandidate || expectedCandidate.buildIdentity !== buildIdentity
        || !/^[0-9a-f]{40}$/u.test(String(expectedCandidate.sourceCommit ?? ''))
        || !/^sha256:[0-9a-f]{64}$/u.test(String(expectedCandidate.worktreeFingerprint ?? '')))
    {
        throw new Error('cohort external candidate source/worktree/build identity is required');
    }
    for (const { slot, members } of slots)
    {
        const planned = expectedCandidate.slots?.find((entry) => entry.slot === slot);
        const reasons = [];
        const bindings = [];
        const actualIds = (members ?? []).map((entry) => entry.authorityId);
        if (JSON.stringify(actualIds) !== JSON.stringify(roster.map((entry) => entry.authorityId))
            || JSON.stringify(planned?.members?.map((entry) => entry.authorityId)) !== JSON.stringify(actualIds))
        {
            reasons.push({ code: 'cohort.membership-mismatch', message: `slot ${slot} must contain the exact formal producer authority roster`,
                slot, expected: roster.map((entry) => entry.authorityId), actual: actualIds });
        }
        else
        {
            for (const [index, member] of members.entries())
            {
                const expected = planned.members[index];
                const files = fileBackedCleanAttemptEvidence(member.attemptEvidence ?? {});
                const verdict = verifyCohortAttempt(files, member.attemptEvidence?.verifyAuthority,
                    { sourceCommit: expectedCandidate.sourceCommit,
                        worktreeFingerprint: expectedCandidate.worktreeFingerprint,
                        schedulerRunId: planned.schedulerRunId, producerId: roster[index].producerId },
                    { expectedAttemptIdentity: Object.fromEntries(['executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest']
                        .map((field) => [field, expected[field]])),
                    expectedConsumerIdentity: { sourceCommit: expectedCandidate.sourceCommit,
                        worktreeFingerprint: expectedCandidate.worktreeFingerprint, schedulerRunId: planned.schedulerRunId,
                        producerId: roster[index].producerId, buildIdentity,
                        executionEnvelopeDigest: expected.executionEnvelopeDigest, replayPlanDigest: expected.replayPlanDigest,
                        temporalContextDigest: expected.temporalContextDigest },
                    requiredConsumerIdentityFields: ['sourceCommit', 'worktreeFingerprint', 'schedulerRunId', 'producerId',
                        'buildIdentity', 'executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest'],
                    candidateBindings: [{ expected: { buildIdentity }, actual: { buildIdentity: member.attemptEvidence?.buildIdentity } }] });
                reasons.push(...verdict.reasons);
                const binding = evidenceBinding(verdict, member.attemptEvidence?.aggregateReference, files.aggregateReceipt);
                binding.authorityId = member.authorityId;
                binding.buildIdentity = buildIdentity;
                const reference = member.attemptEvidence?.domainReceiptReference;
                if (verdict.eligible && (member.attemptEvidence?.buildIdentity !== buildIdentity
                    || reference?.path !== expected.domainReceiptReference?.path
                    || reference?.digest !== expected.domainReceiptReference?.digest
                    || !verdict.attempt.artifactPaths.includes(reference?.path)
                    || verdict.attempt.artifactDigests[reference?.path] !== reference?.digest
                ))
                {
                    reasons.push({ code: 'cohort.candidate-binding-mismatch', message: `slot ${slot}/${member.authorityId} crosses current build/artifact/authority identity`,
                        slot, producerId: binding.producerId, schedulerRunId: binding.schedulerRunId,
                        attemptNumber: binding.attemptNumber, ref: reference?.path ?? null,
                        expected: expected.domainReceiptReference, actual: reference });
                }
                binding.domainReceiptReference = reference ?? null;
                binding.evidenceSource = member.evidenceSource ?? null;
                bindings.push(binding);
            }
        }
        if (!planned?.schedulerRunId || cohort.events.some((event) => event.evidence.schedulerRunId === planned.schedulerRunId))
        {
            reasons.push({ code: 'cohort.run-not-independent', message: `slot ${slot} requires its own independent scheduler run`, slot });
        }
        const evidence = { sourceCommit: expectedCandidate.sourceCommit, worktreeFingerprint: expectedCandidate.worktreeFingerprint,
            buildIdentity, schedulerRunId: planned?.schedulerRunId ?? null,
            aggregateReceipt: bindings[0]?.aggregateReceipt ?? { path: 'rejected/cohort.json', digest: digestCanonical(bindings) },
            requiredCatalogDigest: loadCanonicalRequiredEvidenceCatalog().contentDigest, members: bindings };
        const event = sealContentDigest({ schema: 'fsusblog.release-clean-attempt-cohort-event.v1',
            sequence: slot, slot, previousEventDigest: cohort.events.at(-1)?.contentDigest ?? null,
            status: reasons.length ? 'rejected' : 'admitted', reasons, evidence });
        cohort = sealContentDigest({ ...cohort, previousRevisionDigest: cohort.contentDigest,
            events: [...cohort.events, event], qualificationEligible: slot === 3
                && [...cohort.events, event].every((entry) => entry.status === 'admitted') });
    }
    if (outputFile || (!cohort.qualificationEligible && rejectedOutputFile))
    {
        persistCleanAttemptCohortRevision(outputFile ?? rejectedOutputFile, cohort);
    }
    if (!cohort.qualificationEligible)
    {
        const rejected = cohort.events.find((event) => event.status === 'rejected');
        const reasons = rejected?.reasons.map((reason) => reason.code).join(', ') || 'cohort.not-qualified';
        throw new Error(`release clean-attempt cohort slot ${rejected?.slot ?? 'unknown'} rejected: ${reasons}`);
    }
    return cohort;
}

export function requiredCleanAttemptCohortMembers()
{
    return [...requiredEvidenceAuthoritiesForContext()
        .map((entry) => ({ authorityId: entry.authorityId, producerId: entry.canonicalOwner })),
    { authorityId: 'production-build-artifacts', producerId: 'production-build-artifacts' }]
        .sort((left, right) => left.authorityId.localeCompare(right.authorityId));
}

export function verifyCleanAttemptCohortManifest(manifest, manifestPath, repositoryRoot)
{
    void repositoryRoot;
    const candidateRelative = manifest.artifacts?.cleanAttemptCandidate;
    if (typeof candidateRelative !== 'string' || path.isAbsolute(candidateRelative)
        || path.posix.normalize(candidateRelative) !== candidateRelative
        || candidateRelative.split('/').includes('..'))
    {
        throw new Error('release manifest requires independent cleanAttemptCandidate artifact');
    }
    const candidateFile = path.resolve(path.dirname(manifestPath), candidateRelative);
    if (!fs.lstatSync(candidateFile).isFile() || fs.realpathSync(candidateFile) !== candidateFile
        || manifest.artifactDigests?.cleanAttemptCandidate?.algorithm !== 'sha256'
        || createHash('sha256').update(fs.readFileSync(candidateFile)).digest('hex')
            !== manifest.artifactDigests?.cleanAttemptCandidate?.value)
    {
        throw new Error('cleanAttemptCandidate file digest mismatch or invalid file');
    }
    const expectedCandidate = JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
    if (expectedCandidate.sourceCommit !== manifest.commitSha || expectedCandidate.imageDigest !== manifest.imageDigest)
    {
        throw new Error('external cleanAttemptCandidate crosses current release source/build identity');
    }
    verifyCleanAttemptCandidateGraph(expectedCandidate, path.dirname(manifestPath));
    const graphRelative = manifest.artifacts?.cleanAttemptGraph;
    const graphBytes = referencedBytes(path.dirname(manifestPath), { path: graphRelative,
        fileDigest: `sha256:${manifest.artifactDigests?.cleanAttemptGraph?.value}` });
    const archiveGraph = JSON.parse(graphBytes);
    if (manifest.artifactDigests?.cleanAttemptGraph?.algorithm !== 'sha256'
        || archiveGraph.schema !== 'fsusblog.release-clean-attempt-archive-graph.v1'
        || sealContentDigest(archiveGraph).contentDigest !== archiveGraph.contentDigest
        || !Array.isArray(archiveGraph.entries) || new Set(archiveGraph.entries.map((entry) => entry.path)).size !== archiveGraph.entries.length)
    {
        throw new Error('clean-attempt archive digest graph is invalid');
    }
    for (const entry of archiveGraph.entries)
    {
        referencedBytes(path.dirname(manifestPath), entry);
    }
    const relative = manifest.artifacts?.cleanAttemptCohort;
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split('/').includes('..'))
    {
        throw new Error('release manifest requires an exact cleanAttemptCohort artifact');
    }
    const file = path.resolve(path.dirname(manifestPath), relative);
    if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file)
    {
        throw new Error('cleanAttemptCohort must be a regular non-symlink file');
    }
    const bytes = fs.readFileSync(file);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== `sha256:${manifest.artifactDigests?.cleanAttemptCohort?.value}`
        || manifest.artifactDigests?.cleanAttemptCohort?.algorithm !== 'sha256')
    {
        throw new Error('cleanAttemptCohort file digest mismatch');
    }
    const cohort = validateCleanAttemptCohort(JSON.parse(bytes));
    if (!cohort.qualificationEligible || cohort.buildIdentity !== expectedCandidate.buildIdentity
        || cohort.events.some((event) => event.evidence.sourceCommit !== manifest.commitSha)
        || cohort.cohortId !== manifest.releaseNamespace)
    {
        throw new Error('cleanAttemptCohort crosses current release/source/build identity or is not qualified');
    }
    const slots = cohort.events.map((event) => ({ slot: event.slot, members: event.evidence.members.map((member) =>
    {
        const source = member.evidenceSource;
        if (!archiveGraph.entries.some((entry) => entry.path === source?.path && entry.fileDigest === source.fileDigest))
        {
            throw new Error(`cohort slot ${event.slot}/${member.authorityId} evidence source missing or tampered`);
        }
        referencedBytes(path.dirname(manifestPath), source);
        return { authorityId: member.authorityId, evidenceSource: source,
            attemptEvidence: readCleanAttemptEvidenceSource(source.path, { repositoryRoot: path.dirname(manifestPath) }) };
    }) }));
    const replay = admitCleanAttemptCohort({ cohortId: cohort.cohortId, buildIdentity: cohort.buildIdentity,
        slots, expectedCandidate, candidateRepositoryRoot: path.dirname(manifestPath) });
    if (canonicalJson(replay.events) !== canonicalJson(cohort.events))
    {
        throw new Error('cleanAttemptCohort admission replay differs from the sealed receipt');
    }
    return true;
}
