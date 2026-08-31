#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseMatrix } from '../test-matrix/parse-matrix.mjs';

import {
    createFlakyEvidenceCollection,
    FLAKY_EVIDENCE_COLLECTION_SCHEMA
} from './check-flaky-evidence.mjs';
import {
    collectionDocumentDigest,
    createJobSummaryCollection,
    JOB_SUMMARY_COLLECTION_SCHEMA
} from './check-job-summaries.mjs';

const {
    beginCurrentRunEvidencePublication,
    finalizeCurrentRunEvidencePublication
} = await import(new URL('../test/current-run-evidence-publication.mjs', import.meta.url));
const { packCurrentRunEvidenceTransport } = await import(
    new URL('../test/current-run-evidence-transport.mjs', import.meta.url));
const { governanceContentDigest, validateEvidenceLocatorRegistry } = await import(
    new URL('../test/evidence-location-contract.mjs', import.meta.url));
const { validatePrSmartGatePlan } = await import(
    new URL('../release/test-evidence-receipts-cli.mjs', import.meta.url));

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const jobAuthority = 'evidence-consumer.ci.check-job-summaries.current-run';
const flakyAuthority = 'evidence-consumer.ci.check-flaky-evidence.current-run';

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function requiredEnvironment(environment, name)
{
    const value = String(environment[name] ?? '').trim();
    assert(value.length > 0, `${name} is required`);
    return value;
}

function requiredDigest(value, name)
{
    assert(digestPattern.test(value), `${name} must be a sha256 digest`);
    return value;
}

function normalizeFingerprint(value)
{
    const normalized = String(value ?? '').trim().replace(/^sha256:/u, '');
    assert(/^[0-9a-f]{64}$/u.test(normalized),
        'FSUSBLOG_CI_PRODUCTION_SOURCE_FINGERPRINT must be a sha256 fingerprint');
    return `sha256:${normalized}`;
}

function inside(file, root)
{
    return file === root || file.startsWith(`${root}${path.sep}`);
}

function assertPlainFile(file, ownedRoot, label)
{
    const root = path.resolve(ownedRoot);
    const absolute = path.resolve(file);
    assert(inside(absolute, root), `${label} escapes its owned root`);
    const relative = path.relative(root, absolute).split(path.sep);
    let cursor = root;
    assert(fs.existsSync(cursor) && fs.statSync(cursor).isDirectory(), `${label} owned root is missing`);
    assert(!fs.lstatSync(cursor).isSymbolicLink(), `${label} owned root must not be a symlink`);
    for (const segment of relative)
    {
        cursor = path.join(cursor, segment);
        assert(fs.existsSync(cursor), `${label} is missing`);
        assert(!fs.lstatSync(cursor).isSymbolicLink(), `${label} must not traverse a symlink`);
    }
    assert(fs.statSync(absolute).isFile(), `${label} must be a regular file`);
    assert(fs.statSync(absolute).nlink === 1, `${label} must not be hard-linked`);
    assert(inside(fs.realpathSync(absolute), fs.realpathSync(root)), `${label} escapes its physical owned root`);
}

function walkJsonFiles(root, segment)
{
    const absoluteRoot = path.resolve(root);
    if (!fs.existsSync(absoluteRoot))
    {
        return [];
    }
    assert(!fs.lstatSync(absoluteRoot).isSymbolicLink(), 'downloaded artifact root must not be a symlink');
    assert(fs.statSync(absoluteRoot).isDirectory(), 'downloaded artifact root must be a directory');
    const results = [];
    const walk = (directory, artifactName) =>
    {
        assert(!fs.lstatSync(directory).isSymbolicLink(),
            `downloaded artifact path must not traverse a symlink: ${path.relative(absoluteRoot, directory)}`);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        {
            const file = path.join(directory, entry.name);
            assert(!entry.isSymbolicLink(),
                `downloaded artifact path must not traverse a symlink: ${path.relative(absoluteRoot, file)}`);
            if (entry.isDirectory())
            {
                walk(file, artifactName);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.json'))
            {
                continue;
            }
            const relative = path.relative(path.join(absoluteRoot, artifactName), file).replaceAll(path.sep, '/');
            const segments = relative.split('/');
            const evidenceRoot = segments.findIndex((value, index) => value === 'release-evidence'
                && segments[index + 1] === segment && index + 2 < segments.length);
            if (evidenceRoot >= 0)
            {
                assertPlainFile(file, absoluteRoot, `downloaded ${segment} evidence`);
                results.push({ artifactName, file, relative });
            }
        }
    };
    for (const artifact of fs.readdirSync(absoluteRoot, { withFileTypes: true }))
    {
        assert(!artifact.isSymbolicLink(), `downloaded artifact must not be a symlink: ${artifact.name}`);
        if (!artifact.isDirectory())
        {
            continue;
        }
        walk(path.join(absoluteRoot, artifact.name), artifact.name);
    }
    return results;
}

function localJobFiles(repositoryRoot, releaseEvidenceDirectory)
{
    const releaseRoot = path.resolve(repositoryRoot, releaseEvidenceDirectory);
    const jobs = path.join(releaseRoot, 'jobs');
    if (!fs.existsSync(jobs))
    {
        return [];
    }
    assert(!fs.lstatSync(jobs).isSymbolicLink(), 'local release-evidence jobs must not be a symlink');
    return fs.readdirSync(jobs, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
        .map((entry) =>
        {
            const file = path.join(jobs, entry.name);
            assertPlainFile(file, releaseRoot, 'local release-evidence job summary');
            return { artifactName: 'release-evidence', file,
                relative: `.tmp/release-evidence/${path.relative(releaseRoot, file).replaceAll(path.sep, '/')}` };
        });
}

function readJson(candidate, label)
{
    try
    {
        return JSON.parse(fs.readFileSync(candidate.file, 'utf8'));
    }
    catch (error)
    {
        throw new Error(`${label} is malformed: ${candidate.artifactName}/${candidate.relative}: ${error.message}`,
            { cause: error });
    }
}

function digestFile(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function collectionSource({ candidate, document })
{
    return {
        artifactName: candidate.artifactName,
        path: candidate.relative,
        inputDigest: candidate.inputDigest ?? digestFile(candidate.file),
        documentDigest: collectionDocumentDigest(document)
    };
}

function artifactOwnsSummary(candidate, summary)
{
    return candidate.artifactName === summary.ciJob;
}

function auxiliaryConsumerJob(candidate)
{
    const basename = path.posix.basename(candidate.relative);
    const match = /^ci-build-consumer-(?<job>[a-z0-9-]+)\.json$/u.exec(basename);
    assert(match, `production build verification path is not consumer-bound: ${candidate.artifactName}/${candidate.relative}`);
    return match.groups.job;
}

const directAuthorityWithoutJobSummary = new Set([
    'behavior-doc-static-admission',
    'behavior-evidence-pre-runtime',
    'plan-pr-risk',
    'production-build-artifacts'
]);

function selectedAuthorityJobs(plan)
{
    const selected = new Set(plan.selectedJobIds);
    return plan.summaryAuthorityJobIds.filter((job) => selected.has(job));
}

function expectedJobTiers(repositoryRoot, plan)
{
    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    const selectedTiers = new Set(plan.selectedTierIds);
    const expected = new Map();
    for (const tier of matrix.tiers)
    {
        if (selectedTiers.has(tier.id))
        {
            expected.set(tier.ciJob, [...(expected.get(tier.ciJob) ?? []), tier.id].sort());
        }
    }
    return expected;
}

function validateNeedsProjection(environment, plan)
{
    const needs = JSON.parse(requiredEnvironment(environment, 'QUALITY_GATE_NEEDS_JSON'));
    const expected = plan.summaryAuthorityJobIds.filter((job) => job !== 'release-evidence').sort();
    assert(JSON.stringify(Object.keys(needs).sort()) === JSON.stringify(expected),
        'release-evidence needs do not exactly match the production-summary authority projection');
    const selected = new Set(plan.selectedJobIds);
    const skipped = new Set(plan.skippedJobIds);
    for (const [job, value] of Object.entries(needs))
    {
        if (selected.has(job)) assert(value?.result === 'success', `selected authority job is not successful: ${job}`);
        else if (skipped.has(job)) assert(value?.result === 'skipped', `skipped authority job unexpectedly ran: ${job}`);
        else assert(false, `needs job is outside the PR plan: ${job}`);
    }
}

function productionReceipt(downloadRoot, context)
{
    const candidate = { artifactName: 'production-build-artifacts',
        relative: '.tmp/ci-production-build/receipt.json',
        file: path.join(downloadRoot, 'production-build-artifacts/.tmp/ci-production-build/receipt.json') };
    assertPlainFile(candidate.file, downloadRoot, 'production build receipt');
    const receipt = readJson(candidate, 'production build receipt');
    assert(receipt.schema === 'fsusblog.ci-production-build-receipt.v1',
        'production build receipt schema mismatch');
    assert(receipt.status === 'complete', 'production build receipt is not complete');
    assert(receipt.contentDigest === governanceContentDigest(receipt),
        'production build receipt content digest mismatch');
    assert(receipt.contentDigest === context.buildIdentity.digest, 'production build receipt digest mismatch');
    assert(receipt.sourceState?.commit === context.sourceCommit
        && normalizeFingerprint(receipt.sourceState?.worktreeFingerprint) === context.worktreeFingerprint,
    'production build receipt source identity mismatch');
    assert(String(receipt.producer?.runId) === context.schedulerRunId
        && String(receipt.producer?.runAttempt) === context.attemptId
        && receipt.producer?.job === 'production-build-artifacts',
    'production build receipt producer identity mismatch');
    return receipt;
}

function collectJobDocuments({ candidates, plan, context, expectedTiers, buildReceipt })
{
    const expectedJobs = selectedAuthorityJobs(plan)
        .filter((job) => !directAuthorityWithoutJobSummary.has(job));
    const grouped = new Map();
    for (const candidate of candidates)
    {
        const document = candidate.document ?? readJson(candidate, 'job summary evidence');
        const isJob = document?.schema === 'fsusblog.ci.job-result.v1';
        const isAuxiliary = document?.schema === 'fsusblog.ci-production-build-verification.v1';
        assert(isJob || isAuxiliary,
            `unsupported job evidence schema: ${candidate.artifactName}/${candidate.relative}`);
        if (isJob)
        {
            assert(document.commit === context.sourceCommit, `stale job summary commit: ${document.jobId ?? 'missing'}`);
            assert(String(document.runId) === context.schedulerRunId,
                `stale job summary runId: ${document.jobId ?? 'missing'}`);
            assert(String(document.attempt) === context.attemptId,
                `stale job summary attempt: ${document.jobId ?? 'missing'}`);
            assert(expectedJobs.includes(document.ciJob),
                `job summary is outside direct summary authority: ${document.ciJob ?? 'missing'}`);
            assert(artifactOwnsSummary(candidate, document),
                `job summary artifact name must exactly match ciJob: ${candidate.artifactName}/${document.ciJob}`);
            const expected = expectedTiers.get(document.ciJob) ?? [];
            assert(document.tierIds.every((tier) => expected.includes(tier)),
                `job summary claims an unselected tier: ${document.jobId}`);
        }
        else
        {
            const consumerJob = auxiliaryConsumerJob(candidate);
            assert(expectedJobs.includes(consumerJob),
                `production build verification is outside direct summary authority: ${consumerJob}`);
            assert(candidate.artifactName === consumerJob,
                `production build verification artifact name must exactly match consumer: ${consumerJob}`);
            assert(document.status === 'success', `production build verification is not successful: ${consumerJob}`);
            assert(document.receiptContentDigest === context.buildIdentity.digest,
                `stale production build receipt digest: ${consumerJob}`);
            assert(document.sourceState?.commit === context.sourceCommit
                && normalizeFingerprint(document.sourceState?.worktreeFingerprint) === context.worktreeFingerprint,
            `stale production build source identity: ${consumerJob}`);
            assert(String(document.producer?.runId) === context.schedulerRunId
                && String(document.producer?.runAttempt) === context.attemptId
                && document.producer?.job === 'production-build-artifacts',
            `stale production build producer identity: ${consumerJob}`);
            assert(document.receiptContentDigest === buildReceipt.contentDigest,
                `production build verification does not dereference the canonical receipt: ${consumerJob}`);
        }
        const key = isJob ? `job:${document.jobId}`
            : `aux:${document.schema}:${auxiliaryConsumerJob(candidate)}`;
        const existing = grouped.get(key);
        assert(!existing, `duplicate canonical job evidence: ${key}`);
        grouped.set(key, { candidate, document });
    }
    const documents = [...grouped.values()]
        .sort((left, right) => `${left.candidate.artifactName}/${left.candidate.relative}`
            .localeCompare(`${right.candidate.artifactName}/${right.candidate.relative}`));
    for (const job of expectedJobs)
    {
        const summaries = documents.filter(({ document }) => document.schema === 'fsusblog.ci.job-result.v1'
            && document.ciJob === job);
        assert(summaries.length === 1, `canonical job summary artifact cardinality mismatch: ${job}`);
        const covered = [...new Set(summaries.flatMap(({ document }) => document.tierIds))].sort();
        assert(JSON.stringify(covered) === JSON.stringify(expectedTiers.get(job) ?? []),
            `job summary tier cardinality mismatch: ${job}`);
    }
    return documents;
}

function collectFlakyDocuments({ candidates, plan, jobs })
{
    const allowedJobs = new Set(selectedAuthorityJobs(plan));
    const grouped = new Map();
    for (const candidate of candidates)
    {
        assert(allowedJobs.has(candidate.artifactName),
        `flaky evidence artifact is outside the PR plan ownership: ${candidate.artifactName}`);
        const document = candidate.document ?? readJson(candidate, 'flaky evidence');
        assert(document?.schema === 'fsusblog.ci.flaky.v1',
            `unsupported flaky evidence schema: ${candidate.artifactName}/${candidate.relative}`);
        const owner = jobs.find(({ candidate: summaryCandidate, document: summary }) =>
            summary.schema === 'fsusblog.ci.job-result.v1'
            && summaryCandidate.artifactName === candidate.artifactName
            && summary.status === 'success'
            && summary.artifacts.includes(candidate.relative));
        assert(owner, `flaky evidence is not referenced by a successful current-run job summary: ${candidate.relative}`);
        const key = `${document.suite ?? 'missing'}\u0000${document.test ?? 'missing'}`;
        assert(!grouped.has(key), `duplicate canonical flaky evidence: ${key.replace('\u0000', ':')}`);
        grouped.set(key, { candidate, document });
    }
    return [...grouped.values()]
        .sort((left, right) => `${left.candidate.artifactName}/${left.candidate.relative}`
            .localeCompare(`${right.candidate.artifactName}/${right.candidate.relative}`));
}

function classifyFlakyArtifactCandidates(candidates, expectedJobs)
{
    const evidence = [];
    const identities = new Set();
    for (const candidate of candidates)
    {
        assert(expectedJobs.has(candidate.artifactName),
            `flaky artifact is outside exact plan authority: ${candidate.artifactName}`);
        const segments = candidate.relative.split('/');
        const markers = segments.flatMap((segment, index) => segment === 'release-evidence'
            && segments[index + 1] === 'flaky' ? [index] : []);
        assert(markers.length === 1, `flaky artifact path has ambiguous role: ${candidate.relative}`);
        const suffix = segments.slice(markers[0] + 2);
        const identity = `${candidate.artifactName}\u0000${candidate.relative}`;
        assert(!identities.has(identity), `duplicate flaky artifact path: ${candidate.artifactName}/${candidate.relative}`);
        identities.add(identity);
        const document = readJson(candidate, 'flaky artifact');
        if (suffix.length === 1 && suffix[0] === 'registry.json')
        {
            assert(document?.schema === 'fsusblog.ci.flaky-registry.v1',
                `flaky registry schema mismatch: ${candidate.artifactName}/${candidate.relative}`);
            continue;
        }
        if (suffix.length === 4 && suffix[0] === 'attempts' && suffix[3] === 'attempt.json')
        {
            assert(document?.schema === 'fsusblog.ci.flaky-attempt.v1',
                `flaky attempt schema mismatch: ${candidate.artifactName}/${candidate.relative}`);
            continue;
        }
        assert(suffix.length === 1 && document?.schema === 'fsusblog.ci.flaky.v1',
            `unknown or misplaced flaky artifact: ${candidate.artifactName}/${candidate.relative}`);
        evidence.push({ ...candidate, document });
    }
    return evidence;
}

function writeExclusiveJson(repositoryRoot, relative, value)
{
    const file = path.resolve(repositoryRoot, relative);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function publishCollection({ repositoryRoot, context, registryEntry, payloadPath, referencePath,
    payloadSchema, payload })
{
    const session = beginCurrentRunEvidencePublication({
        authorityId: registryEntry.authorityId,
        context,
        outputPath: referencePath,
        payloadPath,
        producerId: registryEntry.producerId,
        repositoryRoot
    });
    writeExclusiveJson(repositoryRoot, payloadPath, payload);
    const published = finalizeCurrentRunEvidencePublication({
        authorityId: registryEntry.authorityId,
        context,
        outputPath: referencePath,
        payloadPath,
        payloadSchema,
        producerId: registryEntry.producerId,
        repositoryRoot,
        sessionId: session.sessionId,
        terminalStatus: 'success'
    });
    return published.receipt;
}

export function qualityGateTransportContext(environment)
{
    const schedulerRunId = requiredEnvironment(environment, 'GITHUB_RUN_ID');
    const attemptId = requiredEnvironment(environment, 'GITHUB_RUN_ATTEMPT');
    const sourceCommit = requiredEnvironment(environment, 'GITHUB_SHA');
    assert(/^[0-9a-f]{40}$/u.test(sourceCommit), 'GITHUB_SHA must be a full lowercase commit SHA');
    const planDigest = requiredDigest(requiredEnvironment(environment, 'FSUSBLOG_CI_PR_PLAN_DIGEST'),
        'FSUSBLOG_CI_PR_PLAN_DIGEST');
    const buildDigest = requiredDigest(requiredEnvironment(environment,
        'FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST'), 'FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST');
    const body = {
        schema: 'fsusblog.current-run-evidence-context.v1',
        schedulerRunId,
        attemptId,
        sourceCommit,
        worktreeFingerprint: normalizeFingerprint(requiredEnvironment(environment,
            'FSUSBLOG_CI_PRODUCTION_SOURCE_FINGERPRINT')),
        candidateIdentity: { id: 'pr-smart-gate-plan', digest: planDigest },
        buildIdentity: { id: 'production-build', digest: buildDigest },
        ownedRoots: ['artifacts/current-run']
    };
    return { ...body, contentDigest: governanceContentDigest(body) };
}

function qualityGatePlan(repositoryRoot, environment, context)
{
    const planPath = path.resolve(repositoryRoot, requiredEnvironment(environment,
        'FSUSBLOG_CI_PR_SMART_GATE_PLAN'));
    assertPlainFile(planPath, repositoryRoot, 'PR smart gate plan');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    validatePrSmartGatePlan(plan, environment, context.buildIdentity.digest);
    return { plan, planPath };
}

function exactJobCandidates(candidates, expectedJobs, plan)
{
    for (const candidate of candidates)
    {
        for (const authorityJob of expectedJobs)
        {
            if (candidate.artifactName.startsWith(`${authorityJob}-`))
            {
                const exactOtherOwner = plan.selectedJobIds.some((job) => job !== authorityJob
                    && (candidate.artifactName === job || candidate.artifactName.startsWith(`${job}-`)));
                assert(exactOtherOwner,
                    `job summary artifact uses an unbound prefix alias: ${candidate.artifactName}`);
            }
        }
        assert(expectedJobs.has(candidate.artifactName),
            `job summary artifact is outside exact plan authority: ${candidate.artifactName}`);
    }
    return candidates;
}

function collectionCandidates({ collection, documents, downloadRoot, label })
{
    return documents.map((document, index) =>
    {
        const source = collection.sources[index];
        const file = path.join(downloadRoot, source.artifactName, source.path);
        assertPlainFile(file, downloadRoot, `${label} source`);
        assert(digestFile(file) === source.inputDigest,
            `${label} source input digest mismatch: ${source.artifactName}/${source.path}`);
        assert(collectionDocumentDigest(document) === source.documentDigest,
            `${label} member document digest mismatch: ${source.artifactName}/${source.path}`);
        const sourceDocument = readJson({ artifactName: source.artifactName,
            relative: source.path, file }, `${label} source`);
        assert(collectionDocumentDigest(sourceDocument) === source.documentDigest,
            `${label} source/member semantic digest mismatch: ${source.artifactName}/${source.path}`);
        return { artifactName: source.artifactName, relative: source.path, file,
            inputDigest: source.inputDigest, document };
    });
}

export function validateQualityGateEvidenceCollectionMembers({
    repositoryRoot = defaultRepositoryRoot,
    environment = process.env,
    context = qualityGateTransportContext(environment),
    jobCollection,
    flakyCollection
})
{
    const canonicalJobs = createJobSummaryCollection(jobCollection?.summaries, jobCollection?.sources);
    const canonicalFlaky = createFlakyEvidenceCollection(flakyCollection?.evidence, flakyCollection?.sources);
    assert(JSON.stringify(canonicalJobs) === JSON.stringify(jobCollection),
        'job summary collection canonical shape mismatch');
    assert(JSON.stringify(canonicalFlaky) === JSON.stringify(flakyCollection),
        'flaky evidence collection canonical shape mismatch');
    const { plan } = qualityGatePlan(repositoryRoot, environment, context);
    const expectedTiers = expectedJobTiers(repositoryRoot, plan);
    const expectedJobs = new Set(selectedAuthorityJobs(plan)
        .filter((job) => !directAuthorityWithoutJobSummary.has(job)));
    const downloadRoot = path.resolve(repositoryRoot, requiredEnvironment(environment,
        'FSUSBLOG_QUALITY_GATE_ARTIFACT_DOWNLOAD_ROOT'));
    const jobCandidates = exactJobCandidates(collectionCandidates({ collection: canonicalJobs,
        documents: canonicalJobs.summaries, downloadRoot, label: 'job collection' }), expectedJobs, plan);
    const flakyCandidates = collectionCandidates({ collection: canonicalFlaky,
        documents: canonicalFlaky.evidence, downloadRoot, label: 'flaky collection' });
    for (const candidate of flakyCandidates)
    {
        assert(expectedJobs.has(candidate.artifactName),
            `flaky evidence artifact is outside exact plan authority: ${candidate.artifactName}`);
    }
    const buildReceipt = productionReceipt(downloadRoot, context);
    const jobs = collectJobDocuments({ candidates: jobCandidates, plan, context, expectedTiers, buildReceipt });
    const flaky = collectFlakyDocuments({ candidates: flakyCandidates, plan, jobs });
    assert(jobs.length === canonicalJobs.summaries.length,
        'job collection member cardinality mismatch after validation');
    assert(flaky.length === canonicalFlaky.evidence.length,
        'flaky collection member cardinality mismatch after validation');
    return { jobs, flaky };
}

export function buildQualityGateEvidenceTransport({
    repositoryRoot = defaultRepositoryRoot,
    environment = process.env
} = {})
{
    const context = qualityGateTransportContext(environment);
    const outputRoot = path.join(repositoryRoot, 'artifacts/current-run');
    assert(!fs.existsSync(outputRoot), 'quality-gate evidence transport output root already exists');
    fs.mkdirSync(outputRoot, { recursive: true });

    const { plan } = qualityGatePlan(repositoryRoot, environment, context);
    validateNeedsProjection(environment, plan);

    const downloadRoot = path.resolve(repositoryRoot, requiredEnvironment(environment,
        'FSUSBLOG_QUALITY_GATE_ARTIFACT_DOWNLOAD_ROOT'));
    const releaseDirectory = requiredEnvironment(environment, 'FSUSBLOG_RELEASE_EVIDENCE_DIR');
    const expectedTiers = expectedJobTiers(repositoryRoot, plan);
    const expectedJobs = new Set(selectedAuthorityJobs(plan)
        .filter((job) => !directAuthorityWithoutJobSummary.has(job)));
    const allJobCandidates = [
        ...walkJsonFiles(downloadRoot, 'jobs'),
        ...localJobFiles(repositoryRoot, releaseDirectory)
    ];
    const jobCandidates = exactJobCandidates(allJobCandidates, expectedJobs, plan);
    const flakyCandidates = classifyFlakyArtifactCandidates(walkJsonFiles(downloadRoot, 'flaky'), expectedJobs);
    const buildReceipt = productionReceipt(downloadRoot, context);
    const jobs = collectJobDocuments({ candidates: jobCandidates, plan, context, expectedTiers, buildReceipt });
    const flaky = collectFlakyDocuments({ candidates: flakyCandidates, plan, jobs });
    const jobCollection = createJobSummaryCollection(jobs.map(({ document }) => document),
        jobs.map(collectionSource));
    const flakyCollection = createFlakyEvidenceCollection(flaky.map(({ document }) => document),
        flaky.map(collectionSource));

    const registry = JSON.parse(fs.readFileSync(path.join(repositoryRoot,
        'config/testing/evidence-locator-registry.json'), 'utf8'));
    validateEvidenceLocatorRegistry(registry);
    const entry = (authorityId) =>
    {
        const value = registry.entries.find((candidate) => candidate.authorityId === authorityId);
        assert(value, `evidence locator authority is missing: ${authorityId}`);
        assert(value.receiptSchema === 'fsusblog.current-run-evidence-reference.v1',
            `evidence locator receipt schema mismatch: ${authorityId}`);
        return value;
    };
    const jobPayloadPath = 'artifacts/current-run/job-summaries.payload.json';
    const jobReferencePath = 'artifacts/current-run/job-summaries.reference.json';
    const flakyPayloadPath = 'artifacts/current-run/flaky-evidence.payload.json';
    const flakyReferencePath = 'artifacts/current-run/flaky-evidence.reference.json';
    const jobReceipt = publishCollection({ repositoryRoot, context, registryEntry: entry(jobAuthority),
        payloadPath: jobPayloadPath, referencePath: jobReferencePath,
        payloadSchema: JOB_SUMMARY_COLLECTION_SCHEMA, payload: jobCollection });
    const flakyReceipt = publishCollection({ repositoryRoot, context, registryEntry: entry(flakyAuthority),
        payloadPath: flakyPayloadPath, referencePath: flakyReferencePath,
        payloadSchema: FLAKY_EVIDENCE_COLLECTION_SCHEMA, payload: flakyCollection });

    const object = (registryEntry, receipt, referencePath, payloadPath) => ({
        authorityId: registryEntry.authorityId,
        producerId: registryEntry.producerId,
        receiptSchema: registryEntry.receiptSchema,
        originalRef: {
            path: referencePath,
            contentDigest: receipt.contentDigest,
            producerReceiptDigest: receipt.producerReceiptDigest
        },
        files: [{ path: referencePath, role: 'reference-receipt' },
            { path: payloadPath, role: 'payload' }]
    });
    const result = packCurrentRunEvidenceTransport({
        context,
        objects: [
            object(entry(jobAuthority), jobReceipt, jobReferencePath, jobPayloadPath),
            object(entry(flakyAuthority), flakyReceipt, flakyReferencePath, flakyPayloadPath)
        ],
        repositoryRoot,
        archivePath: 'artifacts/current-run/transport-archive.json',
        manifestPath: 'artifacts/current-run/transport-manifest.json',
        transportRunId: `quality-gate-${context.schedulerRunId}-${context.attemptId}`,
        downloadRunId: `production-summary-${context.schedulerRunId}-${context.attemptId}`
    });
    return { context, jobs: jobs.length, flaky: flaky.length, ...result };
}

function main()
{
    const result = buildQualityGateEvidenceTransport();
    if (process.env.GITHUB_OUTPUT)
    {
        fs.appendFileSync(process.env.GITHUB_OUTPUT,
            `manifest_digest=${result.manifest.contentDigest}\n`, { flag: 'a' });
    }
    process.stdout.write(`${JSON.stringify({ manifestDigest: result.manifest.contentDigest,
        archiveDigest: result.manifest.archive.digest, jobs: result.jobs, flaky: result.flaky })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main();
    }
    catch (error)
    {
        process.stderr.write(`[quality-gate-evidence-transport] ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
