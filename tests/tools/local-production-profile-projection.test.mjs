import assert from 'node:assert/strict';
import 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await import( pathToFileURL(path.join(root, 'tools/test/run-mixed-performance-window.mjs')).href );
await import( pathToFileURL(path.join(root, 'tools/test-matrix/fresh-production.mjs')).href );
const {
    artifactSubstitutionBindingDigest,
    buildLocalProfileProjection,
    collectLogicalTierIds,
    performanceMixedWindowFloorMs,
    matrixGeneratedRuntimePaths,
    resolveArtifactSubstitutions,
    validateLocalProfileCheckpointDuration
} = await import(pathToFileURL(path.join(root, 'tools/test-matrix/local-profile.mjs')).href);
const { parseMatrix } = await import(pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href);
await import(pathToFileURL(path.join(root, 'tools/run-test-matrix.mjs')).href);
await import( pathToFileURL(path.join(root, 'tools/test-matrix/behavior-doc-static-admission-contract.mjs')).href );
await import( pathToFileURL(path.join(root, 'tools/testing/fixture-catalog.mjs')).href );
await import( pathToFileURL(path.join(root, 'tools/test-matrix/production-fresh-exclusive-lease.mjs')).href );
await import( pathToFileURL(path.join(root, 'tools/test-matrix/production-capacity-reservation.mjs')).href );



test('production checkpoint projection binds every logical tier to one fresh run and source state', () =>
{
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const production = matrix.localProfiles.production;
    const expectedLogicalTierCount = collectLogicalTierIds(matrix.tiers, 'production').length;
    const matrixById = new Map(matrix.tiers.map((entry) => [entry.id, entry]));
    const runId = 'production-fresh-projection';
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
    const bundleSummaries = Object.fromEntries(production.bundles.map((bundle, bundleIndex) => [bundle.id, {
        schema: 'fsusblog.local-production.bundle.v1',
        physicalBundleId: bundle.id,
        executionSource: 'fresh',
        status: 'success',
        schedulerRunId: runId,
        members: Object.fromEntries(bundle.members.map((tierId, memberIndex) =>
        {
            const runtimePaths = matrixGeneratedRuntimePaths(matrixById.get(tierId));
            const substitutions = resolveArtifactSubstitutions(bundle, matrix.tiers)[tierId] ?? {};
            const artifactDigests = {
                [`.tmp/local-production/${bundle.id}/steps/${tierId}.log`]: `sha256:${'c'.repeat(64)}`
            };
            const artifactSubstitutionProofs = {};
            for (const runtimePath of runtimePaths)
            {
                const actualPaths = substitutions[runtimePath];
                if (!actualPaths)
                {
                    artifactDigests[runtimePath] = `sha256:${'c'.repeat(64)}`;
                    continue;
                }
                const actualDigests = Object.fromEntries(actualPaths.map((actualPath) => [
                    actualPath,
                    `sha256:${'c'.repeat(64)}`
                ]));
                const canonicalDigest = artifactSubstitutionBindingDigest(runtimePath, actualDigests);
                artifactDigests[runtimePath] = canonicalDigest;
                Object.assign(artifactDigests, actualDigests);
                artifactSubstitutionProofs[runtimePath] = {
                    canonicalPath: runtimePath,
                    canonicalDigest,
                    actualPaths,
                    actualDigests
                };
            }
            return [tierId, {
                status: 'success',
                durationMs: (bundleIndex + 1) * 1_000 + memberIndex,
                testIds: [`test:${tierId}`],
                artifactProofMode: runtimePaths.length === 0
                    ? 'command-log-and-test-ids'
                    : (Object.keys(substitutions).length > 0
              ? 'matrix-runtime-artifacts-with-substitutions'
              : 'matrix-runtime-artifacts'),
                matrixRuntimePaths: runtimePaths,
                artifactSubstitutionProofs,
                artifactDigests
            }];
        }))
    }]));
    bundleSummaries['performance-evidence'].deadlineEvidence = {
        schema: 'fsusblog.performance-deadline-evidence.v2',
        status: 'sufficient',
        schedulerRunId: runId,
        sourceState,
        candidateBudgetMs: 90_000,
        bundleDurationMs: 80_000,
        coordinationWaitMs: 0,
        preparationWorkMs: 20_000,
        postMeasurementWorkMs: 0,
        measurementIsolation: { status: 'isolated', noiseOverlaps: [] },
        mixedWindow: {
            stepId: 'mixed-performance-window',
            minimumDurationMs: performanceMixedWindowFloorMs,
            measuredDurationMs: 60_000
        },
        measuredOtherSerialMs: 20_000,
        requiredBudgetMs: 80_000,
        steps: [
            { id: 'coverage-merge', evidencePhase: 'preparation', status: 'success', durationMs: 20_000, startedAtMs: 0, finishedAtMs: 20_000 },
            { id: 'mixed-performance-window', evidencePhase: 'measurement', status: 'success', durationMs: 60_000, startedAtMs: 20_000, finishedAtMs: 80_000 },
            { id: 'backend-perf', evidencePhase: 'measurement', status: 'success', durationMs: 20_000, startedAtMs: 80_000, finishedAtMs: 100_000 },
            { id: 'privacy-zk-benchmark', evidencePhase: 'measurement', status: 'success', durationMs: 0, startedAtMs: 100_000, finishedAtMs: 100_000 },
            { id: 'aeds-frame-cost', evidencePhase: 'measurement', status: 'success', durationMs: 0, startedAtMs: 100_000, finishedAtMs: 100_000 },
            { id: 'aeds-compression', evidencePhase: 'measurement', status: 'success', durationMs: 0, startedAtMs: 100_000, finishedAtMs: 100_000 }
        ]
    };
    const checkpoint = {
        schema: 'fsusblog.test-matrix.checkpoint.v1',
        runId,
        targetTierId: 'production',
        mode: 'fresh',
        status: 'success',
        budgetMs: null,
        startedAt: '2026-07-12T00:00:00.000Z',
        finishedAt: '2026-07-12T00:04:59.999Z',
        sourceState,
        tiers: Object.fromEntries(production.bundles.map((bundle) => [`local-production-${bundle.id}`, {
            status: 'success',
            reused: false,
            outputs: { [`.tmp/local-production/${bundle.id}/summary.json`]: `file:33188:1:${'d'.repeat(64)}` }
        }]))
    };
    const summaryOnlyEvidence = {};

    const projection = buildLocalProfileProjection({
        profileId: 'production',
        profile: production,
        tiers: matrix.tiers,
        checkpoint,
        bundleSummaries,
        summaryOnlyEvidence
    });

    assert.equal(projection.schema, 'fsusblog.local-profile-projection.v1');
    assert.equal(projection.runId, runId);
    assert.deepEqual(projection.sourceState, sourceState);
    assert.equal(projection.logicalTierCount, expectedLogicalTierCount);
    assert.equal(projection.executedTierCount, expectedLogicalTierCount);
    assert.equal(projection.summaryOnlyTierCount, 0);
    assert.equal(projection.status, 'complete-success');
    assert.equal(projection.qualificationEligible, true);
    assert.equal(Object.keys(projection.entries).length, expectedLogicalTierCount);
    assert.equal(projection.entries['production-build-artifacts'].physicalBundleId, 'build-static');
    assert.equal(projection.entries.integration.physicalBundleId, 'runtime-browser');
    assert.equal(projection.entries.integration.executionSource, 'fresh');
    assert.equal(projection.entries.integration.artifactProofMode, 'matrix-runtime-artifacts-with-substitutions');
    assert.ok(projection.entries.integration.matrixRuntimePaths.includes('.tmp/runtime/integration.json'));
    assert.ok(projection.entries['release-evidence'].matrixRuntimePaths.includes('.tmp/release-evidence/*/manifest.json'));
    assert.ok(projection.entries.production.matrixRuntimePaths.includes('.tmp/perf'));
    assert.equal(projection.entries['security-authenticated-dast'].evidenceKind, 'executed');
    assert.equal(projection.entries['security-authenticated-dast'].physicalBundleId, 'runtime-browser');
    assert.equal(projection.entries['security-authenticated-dast'].executionSource, 'fresh');
    assert.deepEqual(validateLocalProfileCheckpointDuration(checkpoint, production), []);
    assert.doesNotThrow(() => buildLocalProfileProjection({
        profileId: 'production',
        profile: production,
        tiers: matrix.tiers,
        checkpoint: { ...checkpoint, finishedAt: '2026-07-12T00:05:00.001Z' },
        bundleSummaries,
        summaryOnlyEvidence
    }));
    assert.equal(projection.entries['security-authenticated-dast'].status, 'success');

    const substitutedProduction = structuredClone(production);
    const substitutedRuntimeBundle = substitutedProduction.bundles
        .find((entry) => entry.members.includes('integration'));
    const canonicalPath = '.tmp/runtime/integration.json';
    const actualPaths = [
        '.tmp/coverage/merged/Summary.json',
        '.tmp/test-results/backend/production/summary.json'
    ];
    substitutedRuntimeBundle.artifactSubstitutions = [
        ...substitutedRuntimeBundle.artifactSubstitutions,
        `integration::${canonicalPath}=>${actualPaths.join('|')}`
    ];
    const substitutedBundleSummaries = structuredClone(bundleSummaries);
    const substitutedEvidence = substitutedBundleSummaries[substitutedRuntimeBundle.id].members.integration;
    const actualDigests = Object.fromEntries(actualPaths.map((actualPath) => [
        actualPath,
        `sha256:${'f'.repeat(64)}`
    ]));
    const canonicalDigest = artifactSubstitutionBindingDigest(canonicalPath, actualDigests);
    substitutedEvidence.artifactProofMode = 'matrix-runtime-artifacts-with-substitutions';
    substitutedEvidence.artifactDigests[canonicalPath] = canonicalDigest;
    Object.assign(substitutedEvidence.artifactDigests, actualDigests);
    substitutedEvidence.artifactSubstitutionProofs = {
        ...substitutedEvidence.artifactSubstitutionProofs,
        [canonicalPath]: {
            canonicalPath,
            canonicalDigest,
            actualPaths,
            actualDigests
        }
    };
    const substitutedProjection = buildLocalProfileProjection({
        profileId: 'production',
        profile: substitutedProduction,
        tiers: matrix.tiers,
        checkpoint,
        bundleSummaries: substitutedBundleSummaries,
        summaryOnlyEvidence
    });
    assert.equal(
        substitutedProjection.entries.integration.artifactProofMode,
        'matrix-runtime-artifacts-with-substitutions'
    );
    assert.deepEqual(
        substitutedProjection.entries.integration.artifactSubstitutionProofs[canonicalPath],
        { canonicalPath, canonicalDigest, actualPaths, actualDigests }
    );

    const tamperedSubstitution = structuredClone(substitutedBundleSummaries);
    tamperedSubstitution[substitutedRuntimeBundle.id].members.integration
        .artifactSubstitutionProofs[canonicalPath].actualDigests[actualPaths[0]] = `sha256:${'0'.repeat(64)}`;
    assert.throws(() => buildLocalProfileProjection({
        profileId: 'production',
        profile: substitutedProduction,
        tiers: matrix.tiers,
        checkpoint,
        bundleSummaries: tamperedSubstitution,
        summaryOnlyEvidence
    }), /artifact substitution actual digest must match artifactDigests/u);

    assert.throws(() => buildLocalProfileProjection({
        profileId: 'production',
        profile: production,
        tiers: matrix.tiers,
        checkpoint,
        bundleSummaries: {
            ...bundleSummaries,
            'runtime-browser': {
                ...bundleSummaries['runtime-browser'],
                schedulerRunId: 'stale-run'
            }
        },
        summaryOnlyEvidence
    }), /runtime-browser bundle evidence invalid: schedulerRunId must be production-fresh-projection/u);

    const releaseBundle = production.bundles.find((bundle) => bundle.members.includes('release-evidence'));
    const missingRuntimeDigest = structuredClone(bundleSummaries);
    delete missingRuntimeDigest[releaseBundle.id].members['release-evidence']
        .artifactDigests['.tmp/release-evidence/*/manifest.json'];
    assert.throws(() => buildLocalProfileProjection({
        profileId: 'production',
        profile: production,
        tiers: matrix.tiers,
        checkpoint,
        bundleSummaries: missingRuntimeDigest,
        summaryOnlyEvidence
    }), /release-evidence is missing the matrix runtime artifact digest: \.tmp\/release-evidence\/\*\/manifest\.json/u);

    assert.throws(() => buildLocalProfileProjection({
        profileId: 'production',
        profile: production,
        tiers: matrix.tiers.filter((entry) => entry.id !== 'integration'),
        checkpoint,
        bundleSummaries,
        summaryOnlyEvidence
    }), /integration is missing from matrix tiers/u);
});
