#!/usr/bin/env node
/* eslint-disable import-x/no-relative-parent-imports */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { validateReleaseRuntimeMatrix } from '../runtime-profiles/release-runtime-matrix.mjs';
import {
    locateCurrentRunEvidence,
    verifyCurrentRunEvidenceBinding
} from '../test/current-run-evidence-locator.mjs';
import {
    releaseFinalDirectConsumerIds,
    resolveEvidenceReferencePayload
} from '../test/current-run-evidence-publication.mjs';
import { validateEvidenceLocatorRegistry } from '../test/evidence-location-contract.mjs';
import {
    readEvidenceDocument as readJson
} from '../test-matrix/content-addressed-evidence-store.mjs';
import { validateLocalProfileCheckpointEvidence } from '../test-matrix/scheduler.mjs';

import { validateFontLicenseEvidence } from './font-license-evidence.mjs';
import {
    failReleaseFinal as fail,
    isNonBlockingDiagnosticEvidence,
    isNonBlockingDiagnosticVisualGateSkip
} from './release-final-diagnostics.mjs';
import { createReleaseFinalDomainEvidence } from './release-final-domain-evidence.mjs';
import { validateReleaseManifest } from './release-manifest.mjs';
import { writeJsonAtomic } from './test-evidence-receipts.mjs';
import { validateThemeCssSafetyEvidence } from './theme-css-safety-evidence.mjs';
const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));

function artifactPath(manifestFile, artifact)
{
    if (!artifact || artifact === 'null')
    {
        return null;
    }
    return path.resolve(path.dirname(manifestFile), artifact);
}

function listJsonFiles(dir)
{
    if (!dir || !fs.existsSync(dir))
    {
        return [];
    }
    const files = [];
    const stack = [dir];
    while (stack.length > 0)
    {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true }))
        {
            const file = path.join(current, entry.name);
            if (entry.isDirectory())
            {
                stack.push(file);
            }
            else if (entry.name.endsWith('.json'))
            {
                files.push(file);
            }
        }
    }
    return files.sort();
}

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

function validateManifest(manifest, manifestFile)
{
    const errors = [];
    if (manifest.status !== 'collected-ok')
    {
        errors.push(`release-final requires collected-ok, got ${manifest.status}`);
    }
    if (!/^[0-9a-f]{40}$/i.test(String(manifest.commitSha ?? '')))
    {
        errors.push('commitSha must be a full 40-character SHA');
    }
    if (!/^sha256:[A-Za-z0-9._~:+/-]+$/u.test(String(manifest.imageDigest ?? '')))
    {
        errors.push('imageDigest must be a concrete sha256 digest');
    }
    const noVisualGateSkip = manifest.artifacts?.visualGateSkip === null
    && manifest.evidenceSummary?.gates?.visualGateSkip === null;
    if (!noVisualGateSkip && !isNonBlockingDiagnosticVisualGateSkip(manifest, manifestFile))
    {
        if (manifest.artifacts?.visualGateSkip !== null)
        {
            errors.push('correctness visual skip evidence cannot produce a release-final pass');
        }
        if (manifest.evidenceSummary?.gates?.visualGateSkip !== null)
        {
            errors.push('correctness visualGateSkip summary must be null for release-final');
        }
    }
    if (manifest.evidenceSummary?.externalExposure?.liveExposure !== 'ok')
    {
        errors.push('live production exposure evidence is required');
    }
    if (manifest.evidenceSummary?.externalExposure?.status !== 'ok')
    {
        errors.push('production exposure status must be ok');
    }
    if (manifest.evidenceSummary?.externalExposure?.firewallPolicy !== 'present')
    {
        errors.push('firewall policy evidence is required');
    }
    if (manifest.evidenceSummary?.coverage?.status !== 'ok')
    {
        errors.push('coverage evidence must be ok');
    }

    const identity = manifest.releaseIdentity;
    if (!identity || typeof identity !== 'object' || Array.isArray(identity))
    {
        errors.push('releaseIdentity is required');
    }
    else
    {
        const { releaseSlot, ...releaseManifest } = identity;
        if (!/^[a-z][a-z0-9-]{0,31}$/u.test(String(releaseSlot ?? '')))
        {
            errors.push('releaseIdentity.releaseSlot is invalid');
        }
        errors.push(...validateReleaseManifest(releaseManifest, {
            requireRegistryDigest: true,
            requireConcreteRuntimeProfile: true,
            expectedCommitSha: manifest.commitSha,
            expectedImageDigest: manifest.imageDigest
        }).map((error) => `releaseIdentity: ${error}`));
    }
    errors.push(...validateReleaseRuntimeMatrix(manifest, manifestFile));

    for (const [key, digest] of Object.entries(manifest.artifactDigests ?? {}))
    {
        if (!digest || digest.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/i.test(String(digest.value ?? '')))
        {
            errors.push(`artifactDigests.${key} must include a sha256 digest`);
        }
    }

    const jobSummaryDir = artifactPath(manifestFile, manifest.artifacts?.jobSummaries);
    const jobSummaries = listJsonFiles(jobSummaryDir);
    if (jobSummaries.length === 0)
    {
        errors.push('job summary artifact is missing or empty');
    }
    let correctnessJobSummaryCount = 0;
    for (const file of jobSummaries)
    {
        const summary = readJson(file);
        if (summary.schema !== 'fsusblog.ci.job-result.v1')
        {
            continue;
        }
        if (isNonBlockingDiagnosticEvidence(summary))
        {
            continue;
        }
        correctnessJobSummaryCount += 1;
        if (summary.status !== 'success')
        {
            errors.push(`${path.relative(root, file)} must be success, got ${summary.status}`);
        }
        if (summary.commit !== manifest.commitSha)
        {
            errors.push(`${path.relative(root, file)} commit ${summary.commit} does not match manifest ${manifest.commitSha}`);
        }
    }
    if (jobSummaries.length > 0 && correctnessJobSummaryCount === 0)
    {
        errors.push('job summary artifact must include at least one correctness result');
    }

    const themeCssSafetyFile = artifactPath(
        manifestFile,
        manifest.artifacts?.themeCssSafetySummary);
    if (!themeCssSafetyFile || !fs.existsSync(themeCssSafetyFile))
    {
        errors.push('themeCssSafetySummary release evidence artifact is required');
    }
    else
    {
        errors.push(
            ...validateThemeCssSafetyEvidence(readJson(themeCssSafetyFile))
                .map(error => `themeCssSafetySummary: ${error}`));
    }

    const fontLicenseFile = artifactPath(
        manifestFile,
        manifest.artifacts?.fontLicenseSummary);
    if (!fontLicenseFile || !fs.existsSync(fontLicenseFile))
    {
        errors.push('fontLicenseSummary release evidence artifact is required');
    }
    else
    {
        errors.push(
            ...validateFontLicenseEvidence(readJson(fontLicenseFile))
                .map(error => `fontLicenseSummary: ${error}`));
    }

    return errors;
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

async function runSelfTest()
{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-release-final-'));
    const jobs = path.join(tmp, 'job-summaries');
    fs.mkdirSync(jobs, { recursive: true });
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const releaseId = '20260715010101-0123456789ab';
    const imageDigest = `sha256:${'a'.repeat(64)}`;
    const profileManifestDigest = `sha256:${'6'.repeat(64)}`;
    const profileDigest = `sha256:${'7'.repeat(64)}`;
    fs.writeFileSync(path.join(jobs, 'fast.json'), JSON.stringify({
        schema: 'fsusblog.ci.job-result.v1',
        jobId: 'fast',
        status: 'success',
        commit
    }));
    fs.writeFileSync(path.join(jobs, 'browser-diagnostics.json'), JSON.stringify({
        schema: 'fsusblog.ci.job-result.v1',
        jobId: 'browser-diagnostics',
        status: 'failure',
        commit: 'f'.repeat(40),
        evidenceClass: 'diagnostic',
        affectsCorrectness: false
    }));
    const validResourceSummary = {
        status: 'ok',
        mode: 'memory-leak',
        metrics: [{
            name: 'backend_rss_bytes',
            startValue: 100,
            endValue: 104,
            maxValue: 104,
            delta: 4,
            threshold: 64,
            thresholdOperator: '<=',
            thresholdField: 'delta',
            status: 'ok'
        }],
        unavailableMetrics: []
    };
    fs.writeFileSync(path.join(tmp, 'memory-leak-summary.json'), JSON.stringify(validResourceSummary));
    fs.writeFileSync(path.join(tmp, 'open-handle-summary.json'), JSON.stringify({
        ...validResourceSummary,
        mode: 'open-handle',
        metrics: [{
            ...validResourceSummary.metrics[0],
            name: 'backend_open_file_descriptors',
            threshold: 16
        }]
    }));
    fs.writeFileSync(path.join(tmp, 'theme-css-safety-summary.json'), JSON.stringify({
        schema: 'fsusblog.theme.css-safety.v1',
        themeId: 'fsusblog.theme.minimal-ink',
        status: 'ok',
        cssBytes: 42112,
        assetBytes: 210944,
        previewBytes: 120000,
        selectorCount: 312,
        maxSelectorDepth: 3,
        importantCount: 2,
        maxMotionDurationMs: 180,
        violations: [],
        warnings: []
    }));
    fs.writeFileSync(path.join(tmp, 'font-license-summary.json'), JSON.stringify({
        schema: 'fsusblog.font.license.v1',
        status: 'ok',
        fonts: [{
            id: 'fsusblog.font.fixture',
            license: 'OFL-1.1',
            source: '@fontsource/fixture@1.0.0',
            hashVerified: true
        }],
        violations: []
    }));
    const manifestFile = path.join(tmp, 'manifest.json');
    const { createReleaseRuntimeMatrixFixture } = await import('../../tests/tools/fixtures/release-runtime-matrix.mjs');
    const matrixEvidence = createReleaseRuntimeMatrixFixture({ commitSha: commit, profileManifestDigest, profileDigest });
    const matrixFile = path.join(tmp, 'runtime-publish-matrix.json');
    fs.writeFileSync(matrixFile, `${JSON.stringify(matrixEvidence)}\n`);
    const manifest = {
        status: 'collected-ok',
        commitSha: commit,
        imageDigest,
        releaseIdentity: {
            schema: 'fsusblog.release-manifest.v3',
            releaseId,
            commitSha: commit,
            imageRepository: 'ghcr.io/fsusblog/app',
            imageTag: `ghcr.io/fsusblog/app:${releaseId}`,
            imageDigest,
            imageRef: `ghcr.io/fsusblog/app@${imageDigest}`,
            registryDigestVerified: true,
            createdAtUtc: '2026-07-15T01:01:01.000Z',
            frontendManifestHash: `sha256:${'b'.repeat(64)}`,
            wasmArtifactHash: `sha256:${'c'.repeat(64)}`,
            // Reference metadata for the validator self-test only; no receipt
            // is issued and no native database admission is implied.
            currentSchema: {
                receipt: { reference: 'receipts/current-schema.json', sha256: '1'.repeat(64) },
                target: {
                    modelVersion: 'current-model.v1',
                    extractorVersion: 'extractor.v1',
                    generatorVersion: 'generator.v1',
                    sourceDigest: '2'.repeat(64),
                    contentDigest: '3'.repeat(64)
                },
                database: { provider: 0, instanceId: 'fixture-instance', databaseId: 'fixture-database' },
                actualSchemaDigest: '4'.repeat(64)
            },
            toolchain: {
                dotnetVersion: '10.0.100',
                nodeVersion: 'v24.16.0',
                dockerVersion: '28.0.0',
                dockerfileDigest: `sha256:${'d'.repeat(64)}`
            },
            runtimeProfile: {
                id: 'throughput-musl',
                manifestDigest: profileManifestDigest,
                profileDigest,
                baseImageFamily: 'musl',
                targetRuntime: 'linux-musl-x64',
                singleFile: true,
                readyToRun: false,
                tieredPgo: true,
                quickJitForLoops: true,
                serverGc: true,
                nativeAot: false,
                threadPoolMode: 'runtime-default',
                topologyMode: 'smt-visible'
            },
            build: { dockerfile: 'ops/docker/FsusBlog.Server.Dockerfile', target: 'final' },
            releaseSlot: 'green'
        },
        artifacts: {
            jobSummaries: 'job-summaries',
            memoryLeakSummary: 'memory-leak-summary.json',
            openHandleSummary: 'open-handle-summary.json',
            themeCssSafetySummary: 'theme-css-safety-summary.json',
            fontLicenseSummary: 'font-license-summary.json',
            runtimePublishMatrix: 'runtime-publish-matrix.json',
            visualGateSkip: null
        },
        artifactDigests: {
            productionExposureLive: { algorithm: 'sha256', value: 'a'.repeat(64) },
            runtimePublishMatrix: { algorithm: 'sha256', value: sha256Hex(matrixFile) }
        },
        evidenceSummary: {
            coverage: { status: 'ok' },
            gates: { visualGateSkip: null },
            externalExposure: { status: 'ok', firewallPolicy: 'present', liveExposure: 'ok' },
            operations: {
                runtimeTuning: {
                    profile: { id: 'throughput-musl', manifestDigest: profileManifestDigest, profileDigest },
                    runtimeMatrixEvidence: 'runtime-publish-matrix.json',
                    runtimeMatrixStatus: 'ok'
                }
            }
        }
    };
    const errors = validateManifest(manifest, manifestFile);
    if (errors.length > 0)
    {
        fail([`self-test expected pass: ${errors.join('; ')}`]);
    }

    for (const schema of ['fsusblog.release-manifest.v1', 'fsusblog.release-manifest.v2'])
    {
        const retired = structuredClone(manifest);
        retired.releaseIdentity.schema = schema;
        delete retired.releaseIdentity.currentSchema;
        retired.releaseIdentity.schemaCompatibility = { minimumCoordinate: releaseId, maximumCoordinate: releaseId };
        if (!validateManifest(retired, manifestFile).some(error => error.includes('schema must be fsusblog.release-manifest.v3')))
        {
            fail([`self-test expected release-final to reject retired ${schema}`]);
        }
    }
    const legacyWindow = structuredClone(manifest);
    legacyWindow.releaseIdentity.schemaCompatibility = { minimumCoordinate: releaseId, maximumCoordinate: releaseId };
    if (!validateManifest(legacyWindow, manifestFile).some(error => error.includes('schemaCompatibility is not allowed')))
    {
        fail(['self-test expected release-final to reject a compatibility window on a current-only manifest']);
    }
    const missingCurrentSchema = structuredClone(manifest);
    delete missingCurrentSchema.releaseIdentity.currentSchema;
    if (!validateManifest(missingCurrentSchema, manifestFile).some(error => error.includes('currentSchema is required')))
    {
        fail(['self-test expected release-final to reject missing current schema receipt references']);
    }

    const fontLicenseFile = path.join(tmp, 'font-license-summary.json');
    const fontLicenseFixture = fs.readFileSync(fontLicenseFile);
    fs.rmSync(fontLicenseFile);
    if (!validateManifest(manifest, manifestFile)
        .some((error) => error.includes('fontLicenseSummary release evidence artifact is required')))
    {
        fail(['self-test expected release-final to reject missing font license evidence']);
    }
    fs.writeFileSync(fontLicenseFile, fontLicenseFixture);

    const visualGateSkipFile = path.join(tmp, 'visual-gate-skip.json');
    const diagnosticVisualGateSkip = {
        schema: 'fsusblog.visual-gate-skip.v1',
        status: 'visual-gate-skipped',
        evidenceClass: 'diagnostic',
        affectsCorrectness: false,
        executionBoundary: 'real-browser-screenshot-diagnostics',
        generatedAt: '2025-01-01T00:00:00.000Z',
        reason: 'stale diagnostics fixture',
        approver: 'fixture',
        impact: 'diagnostics only',
        rerunUrl: 'https://example.invalid/diagnostics'
    };
    fs.writeFileSync(visualGateSkipFile, `${JSON.stringify(diagnosticVisualGateSkip)}\n`);
    const diagnosticVisualManifest = structuredClone(manifest);
    diagnosticVisualManifest.artifacts.visualGateSkip = 'visual-gate-skip.json';
    diagnosticVisualManifest.evidenceSummary.gates.visualGateSkip = 'visual-gate-skip.json';
    const diagnosticVisualErrors = validateManifest(diagnosticVisualManifest, manifestFile);
    if (diagnosticVisualErrors.length > 0)
    {
        fail([`self-test expected stale diagnostic visual skip not to block correctness: ${diagnosticVisualErrors.join('; ')}`]);
    }

    fs.writeFileSync(visualGateSkipFile, `${JSON.stringify({
        ...diagnosticVisualGateSkip,
        evidenceClass: 'correctness',
        affectsCorrectness: true,
        executionBoundary: 'release-correctness-gate'
    })}\n`);
    const correctnessVisualErrors = validateManifest(diagnosticVisualManifest, manifestFile);
    if (!correctnessVisualErrors.some((error) => error.includes('correctness visual')))
    {
        fail(['self-test expected a correctness visual skip to block release-final']);
    }
    fs.rmSync(visualGateSkipFile);

    const fastJobFile = path.join(jobs, 'fast.json');
    const heldFastJobFile = path.join(jobs, 'fast.json.hold');
    fs.renameSync(fastJobFile, heldFastJobFile);
    const diagnosticOnlyErrors = validateManifest(manifest, manifestFile);
    fs.renameSync(heldFastJobFile, fastJobFile);
    if (!diagnosticOnlyErrors.some((error) => error.includes('at least one correctness result')))
    {
        fail(['self-test expected diagnostics-only job summaries not to satisfy correctness evidence']);
    }

    const correctnessFailureFile = path.join(jobs, 'correctness-failure.json');
    fs.writeFileSync(correctnessFailureFile, JSON.stringify({
        schema: 'fsusblog.ci.job-result.v1',
        jobId: 'correctness-failure',
        status: 'failure',
        commit,
        evidenceClass: 'correctness',
        affectsCorrectness: true
    }));
    const correctnessFailureErrors = validateManifest(manifest, manifestFile);
    fs.rmSync(correctnessFailureFile);
    if (!correctnessFailureErrors.some((error) => error.includes('must be success')))
    {
        fail(['self-test expected a failed correctness job summary to block release-final']);
    }

    const missingMatrix = structuredClone(manifest);
    missingMatrix.artifacts.runtimePublishMatrix = null;
    if (!validateManifest(missingMatrix, manifestFile).some((error) => error.includes('runtimePublishMatrix')))
    {
        fail(['self-test expected release-final to reject a missing runtime matrix']);
    }
    const unselected = structuredClone(matrixEvidence);
    unselected.selection = null;
    fs.writeFileSync(matrixFile, `${JSON.stringify(unselected)}\n`);
    const unselectedManifest = structuredClone(manifest);
    unselectedManifest.artifactDigests.runtimePublishMatrix.value = sha256Hex(matrixFile);
    if (!validateManifest(unselectedManifest, manifestFile).some((error) => error.includes('sealed production selection')))
    {
        fail(['self-test expected release-final to reject an unselected runtime matrix']);
    }

    const wrongCommit = structuredClone(matrixEvidence);
    wrongCommit.identity.commitSha = 'f'.repeat(40);
    fs.writeFileSync(matrixFile, `${JSON.stringify(wrongCommit)}\n`);
    const wrongCommitManifest = structuredClone(manifest);
    wrongCommitManifest.artifactDigests.runtimePublishMatrix.value = sha256Hex(matrixFile);
    if (!validateManifest(wrongCommitManifest, manifestFile).some((error) => error.includes('release commit')))
    {
        fail(['self-test expected release-final to reject a runtime matrix from the wrong commit']);
    }
    fs.writeFileSync(matrixFile, `${JSON.stringify(matrixEvidence)}\n`);

    const wrongProfileDigest = structuredClone(manifest);
    wrongProfileDigest.releaseIdentity.runtimeProfile.profileDigest = `sha256:${'8'.repeat(64)}`;
    wrongProfileDigest.evidenceSummary.operations.runtimeTuning.profile.profileDigest = wrongProfileDigest.releaseIdentity.runtimeProfile.profileDigest;
    if (!validateManifest(wrongProfileDigest, manifestFile).some((error) => error.includes('release profile')))
    {
        fail(['self-test expected release-final to reject a runtime matrix selected for another profile digest']);
    }

    const zeroDigest = structuredClone(manifest);
    zeroDigest.releaseIdentity.runtimeProfile.profileDigest = `sha256:${'0'.repeat(64)}`;
    zeroDigest.evidenceSummary.operations.runtimeTuning.profile.profileDigest = zeroDigest.releaseIdentity.runtimeProfile.profileDigest;
    if (!validateManifest(zeroDigest, manifestFile).some((error) => error.includes('zero digest')))
    {
        fail(['self-test expected release-final to reject a zero runtime profile digest']);
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('[release-final] self-test ok');
}

function sha256Hex(file)
{
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const args = process.argv.slice(2);
    if (args.includes('--self-test'))
    {
        await runSelfTest();
        process.exit(0);
    }

    const checkpointOption = args.indexOf('--local-profile-checkpoint');
    const localProfileCheckpoint = checkpointOption >= 0 ? path.resolve(args[checkpointOption + 1] ?? '') : null;
    if (checkpointOption >= 0 && !args[checkpointOption + 1])
    {
        fail(['--local-profile-checkpoint requires a path']);
    }
    const contextOption = args.indexOf('--current-run-context');
    const bindingOption = args.indexOf('--manifest-binding');
    const domainBindingOption = args.indexOf('--domain-binding');
    if (contextOption < 0 || !args[contextOption + 1]
        || bindingOption < 0 || !args[bindingOption + 1]
        || domainBindingOption < 0 || !args[domainBindingOption + 1])
    {
        fail(['--current-run-context, --manifest-binding, and --domain-binding are required']);
    }
    const context = readJson(path.resolve(args[contextOption + 1]));
    const registry = readJson(path.join(root, 'config/testing/evidence-locator-registry.json'));
    validateEvidenceLocatorRegistry(registry);
    const registryEntry = registry.entries.find((entry) =>
        entry.consumerId === 'evidence-consumer.release.check-release-final');
    let locatedManifest;
    try
    {
        locatedManifest = locateCurrentRunEvidence({ context, registry, registryEntry, repositoryRoot: root,
            explicitInputs: [args[bindingOption + 1]] });
        verifyCurrentRunEvidenceBinding(locatedManifest.bindingReceipt,
            { context, registry, registryEntry, repositoryRoot: root });
    }
    catch (error)
    {
        fail([`manifest locator: ${error instanceof Error ? error.message : String(error)}`]);
    }
    const resolvedManifest = resolveEvidenceReferencePayload(locatedManifest.receipt,
        { repositoryRoot: root, ownedRoots: context.ownedRoots });
    const manifestFile = resolvedManifest.file;
    let locatedDomain;
    try
    {
        locatedDomain = locateReleaseFinalDirectEvidence({ context,
            parentPath: args[domainBindingOption + 1], registry });
    }
    catch (error)
    {
        fail([`direct evidence locator: ${error instanceof Error ? error.message : String(error)}`]);
    }

    const bindingFile = path.join(root, '.tmp/release-evidence/release-final-test-evidence-binding.json');
    const terminalAcceptanceFile = path.join(
        root,
        '.tmp/release-evidence/release-final-terminal-acceptance.json'
    );
    fs.rmSync(bindingFile, { force: true });
    fs.rmSync(terminalAcceptanceFile, { force: true });
    const manifest = resolvedManifest.payload;
    const errors = validateManifest(manifest, manifestFile);
    if (localProfileCheckpoint)
    {
        errors.push(...validateQualifiedLocalProfile(localProfileCheckpoint, manifest));
    }
    let testEvidenceBinding = null;
    let terminalAcceptance = null;
    let publicPreviewEvidence = null;
    try
    {
        const testEvidence = createReleaseFinalDomainEvidence({
            directEvidence: locatedDomain.directEvidence,
            currentRunContext: context,
            locatorEvidence: {
                manifestBindingReceipt: locatedManifest.bindingReceipt,
                manifestInputDigest: locatedManifest.receipt.payload.digest,
                directParentBindingReceipt: locatedDomain.parentBindingReceipt,
                directInputDigests: Object.fromEntries(Object.entries(locatedDomain.directEvidence)
                    .map(([key, value]) => [key, value.payloadDigest]))
            },
            manifest,
            repositoryRoot: root,
            sha256Hex
        });
        testEvidenceBinding = testEvidence.binding;
        terminalAcceptance = testEvidence.terminalAcceptance;
        publicPreviewEvidence = testEvidence.publicPreview;
    }
    catch (error)
    {
        errors.push(`test evidence: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (errors.length > 0)
    {
        fail(errors);
    }
    writeJsonAtomic(bindingFile, testEvidenceBinding);
    writeJsonAtomic(terminalAcceptanceFile, terminalAcceptance);
    const publicPreviewImages = Object.entries(publicPreviewEvidence.images)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, hash]) => `${id}:${hash}`)
        .join(',');
    console.log(`[release-final] public-preview commit=${publicPreviewEvidence.sourceCommit} releaseId=${publicPreviewEvidence.releaseId} images=${publicPreviewImages}`);
    console.log(`[release-final] ok file=${path.relative(root, manifestFile)}`);
}
