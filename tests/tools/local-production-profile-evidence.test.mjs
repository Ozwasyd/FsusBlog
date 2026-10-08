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
    createLocalBundleTiers,
    localProfileBudgetCriticalPath,
    performanceMixedWindowFloorMs,
    projectLocalBootstrapFixtureProfile,
    projectLocalNonResidentServiceRequirements,
    resolveLocalProfileResources,
    validateLocalBundleSummary,
    validatePerformanceDeadlineEvidence
} = await import(pathToFileURL(path.join(root, 'tools/test-matrix/local-profile.mjs')).href);
const { parseMatrix } = await import(pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href);
const {
    productionFreshEnvironmentForPhysicalTier
} = await import(pathToFileURL(path.join(root, 'tools/run-test-matrix.mjs')).href);
const { behaviorDocStaticAdmissionTierId } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/behavior-doc-static-admission-contract.mjs')).href
);
const { expandFixtureProfile } = await import(
    pathToFileURL(path.join(root, 'tools/testing/fixture-catalog.mjs')).href
);
await import( pathToFileURL(path.join(root, 'tools/test-matrix/production-fresh-exclusive-lease.mjs')).href );
await import( pathToFileURL(path.join(root, 'tools/test-matrix/production-capacity-reservation.mjs')).href );



const localBundleRunner = fs.readFileSync(path.join(root, 'tools/test/bundles/run-bundle.mjs'), 'utf8');
function profile(overrides = {})
{
    return {
        budgetMs: 300_000,
        minimumSupportedCpuUnits: 4,
        memoryReserveShare: 0.05,
        bundles: [
            { id: 'build-static', command: 'build', deadlineWeight: 18, dependsOn: [behaviorDocStaticAdmissionTierId], members: ['a'], cpuWeight: 2, memoryWeight: 3, minCpuUnits: 1, startupMinCpuUnits: 1, startupMemoryWeight: 3, startupPriority: 3 },
            { id: 'backend-tests', command: 'backend', deadlineWeight: 44, dependsOn: [behaviorDocStaticAdmissionTierId], members: ['b'], cpuWeight: 3, memoryWeight: 4, minCpuUnits: 2, startupMinCpuUnits: 1, startupMemoryWeight: 4, startupPriority: 4 },
            { id: 'frontend-tests', command: 'frontend', deadlineWeight: 27, dependsOn: [behaviorDocStaticAdmissionTierId], members: ['c'], cpuWeight: 3, memoryWeight: 2, minCpuUnits: 1, startupMinCpuUnits: 1, startupMemoryWeight: 2, startupPriority: 3 },
            { id: 'runtime-browser', command: 'runtime', deadlineWeight: 24, dependsOn: [behaviorDocStaticAdmissionTierId], members: ['d'], cpuWeight: 5, memoryWeight: 5, minCpuUnits: 1, startupMinCpuUnits: 1, startupMemoryWeight: 5, startupPriority: 4 },
            { id: 'performance-evidence', command: 'performance', deadlineWeight: 36, minimumDeadlineShare: 0.25, dependsOn: ['build-static', 'backend-tests', 'frontend-tests', 'runtime-browser'], members: ['production'], cpuWeight: 8, memoryWeight: 10, minCpuUnits: 1, startupMinCpuUnits: 1, startupMemoryWeight: 10, startupPriority: 1 }
        ],
        summaryOnly: [],
        ...overrides
    };
}

test('physical bundle DAG preserves dependencies and derives deadlines from resolved machine resources', () =>
{
    const resolved = resolveLocalProfileResources(profile(), { availableCpuUnits: 8, availableMemoryGiB: 18 });
    const bundles = createLocalBundleTiers('production', resolved);
    const ids = new Set(bundles.map((bundle) => bundle.id));
    assert.equal(ids.size, bundles.length);
    for (const bundle of bundles)
    {
        assert.ok(bundle.id.startsWith('local-production-'));
        assert.ok(bundle.executionDependsOn.every((dependency) => ids.has(dependency)));
        assert.ok(bundle.cpuWeight > 0);
        assert.ok(bundle.minCpuUnits > 0);
        assert.ok(bundle.maxParallel > 0);
        assert.ok(bundle.artifacts.length > 0);
    }
    assert.ok(bundles.every((bundle) => Number.isInteger(bundle.budgetMs) && bundle.budgetMs > 0));
    assert.ok(localProfileBudgetCriticalPath({ budgetMs: 300_000, bundles }) <= 300_000);
});

test('logical bootstrap fixture identity is projected only onto runtime-browser', () =>
{
    const repositoryMatrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const resolved = resolveLocalProfileResources(
        repositoryMatrix.localProfiles.production,
        { availableCpuUnits: 8, availableMemoryGiB: 18 }
    );
    const bundles = createLocalBundleTiers('production', resolved);
    const logical = repositoryMatrix.tiers;
    projectLocalBootstrapFixtureProfile(bundles, logical);
    const runtime = bundles.find((bundle) => bundle.physicalBundleId === 'runtime-browser');
    const bootstrap = logical.find((tier) => tier.id === 'bootstrap');
    assert.equal(runtime.selfBootstraps, true);
    assert.equal(runtime.fixtureProfile, bootstrap.fixtureProfile);
    assert.deepEqual(runtime.fixtureCapabilities, expandFixtureProfile(bootstrap.fixtureProfile).capabilities);
    assert.equal(runtime.requiresBootstrap, bootstrap.requiresBootstrap);
    assert.equal(bundles.filter((bundle) => bundle.selfBootstraps === true).length, 1);
    assert.ok(bundles.filter((bundle) => bundle !== runtime)
        .every((bundle) => !Object.hasOwn(bundle, 'fixtureProfile')));
});

test('non-resident physical bundle inherits its exact logical MySQL service requirement', () =>
{
    const repositoryMatrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const resolved = resolveLocalProfileResources(repositoryMatrix.localProfiles.production,
        { availableCpuUnits: 8, availableMemoryGiB: 18 });
    const bundles = createLocalBundleTiers('production', resolved);
    projectLocalNonResidentServiceRequirements(bundles, repositoryMatrix.tiers);
    const backend = bundles.find((bundle) => bundle.physicalBundleId === 'backend-tests');
    assert.deepEqual(backend.services, ['mysql']);
    assert.ok(bundles.filter((bundle) => bundle !== backend)
        .every((bundle) => !bundle.services.includes('mysql')));
    const missing = createLocalBundleTiers('production', resolved);
    assert.throws(() => projectLocalNonResidentServiceRequirements(missing,
        repositoryMatrix.tiers.filter((tier) => tier.id !== 'backend-unit')), /exact logical member backend-unit/u);
    const foreign = createLocalBundleTiers('production', resolved);
    foreign.find((bundle) => bundle.physicalBundleId === 'backend-tests').services = ['redis'];
    assert.throws(() => projectLocalNonResidentServiceRequirements(foreign, repositoryMatrix.tiers),
        /service outside/u);
});

test('MySQL projection rejects duplicate logical identities and resident ownership without changing runtime bootstrap admission', () =>
{
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const resolved = resolveLocalProfileResources(matrix.localProfiles.production,
        { availableCpuUnits: 8, availableMemoryGiB: 18 });
    assert.throws(() => projectLocalNonResidentServiceRequirements(
        createLocalBundleTiers('production', resolved), [...matrix.tiers, matrix.tiers[0]]),
    /unique logical tier identities/u);
    const resident = createLocalBundleTiers('production', resolved);
    resident.find((bundle) => bundle.physicalBundleId === 'runtime-browser').logicalMembers = ['backend-unit'];
    assert.throws(() => projectLocalNonResidentServiceRequirements(resident, matrix.tiers),
        /MySQL cannot be projected onto a resident-service bundle/u);
    const runner = fs.readFileSync(path.join(root, 'tools/run-test-matrix.mjs'), 'utf8');
    assert.equal(runner.split('projectLocalNonResidentServiceRequirements(physicalTiers, matrix.tiers);').length - 1, 1);
    assert.equal(runner.split('projectLocalNonResidentServiceRequirements(physicalTiers, resolvedLogicalMatrix.tiers);').length - 1, 1);
});

test('bootstrap projection counts self-bootstrap tiers only inside runtime-browser', () =>
{
    const repositoryMatrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const resolved = resolveLocalProfileResources(
        repositoryMatrix.localProfiles.production,
        { availableCpuUnits: 8, availableMemoryGiB: 18 }
    );
    const logical = repositoryMatrix.tiers;
    assert.doesNotThrow(() => projectLocalBootstrapFixtureProfile(
        createLocalBundleTiers('production', resolved),
        logical
    ));

    const withoutRuntimeBootstrap = logical.map((tier) =>
        tier.id === 'bootstrap' ? { ...tier, selfBootstraps: false } : tier);
    assert.throws(
        () => projectLocalBootstrapFixtureProfile(
            createLocalBundleTiers('production', resolved),
            withoutRuntimeBootstrap
        ),
        /found 0/u
    );

    const runtimeMembers = new Set(resolved.bundles
        .find((bundle) => bundle.id === 'runtime-browser').members);
    const extraId = logical.find((tier) => runtimeMembers.has(tier.id) && tier.id !== 'bootstrap').id;
    const withSecondRuntimeBootstrap = logical.map((tier) =>
        tier.id === extraId ? { ...tier, selfBootstraps: true } : tier);
    assert.throws(
        () => projectLocalBootstrapFixtureProfile(
            createLocalBundleTiers('production', resolved),
            withSecondRuntimeBootstrap
        ),
        /found 2/u
    );
});

test('only physical build-static receives the attempt production artifact root', () =>
{
    const layout = {
        repositoryRoot: root,
        runId: 'run-1',
        runOutputRoot: path.join(root, '.tmp/test-runs/run-1/outputs'),
        outputRoot: path.join(root, '.tmp/test-runs/run-1/outputs/attempt-0001'),
        relativeOutputRoot: '.tmp/test-runs/run-1/outputs/attempt-0001',
        attemptId: 'attempt-0001'
    };
    const ambientConsumerAuthority = {
        FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT: '/ambient/must-not-leak',
        FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: 'ambient-must-not-leak',
        FSUSBLOG_CI_PRODUCTION_DOMAINS: 'ambient-must-not-leak'
    };
    const build = productionFreshEnvironmentForPhysicalTier(layout, {
        id: 'local-production-build-static',
        physicalBundleId: 'build-static'
    }, ambientConsumerAuthority);
    assert.match(build.FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT, /artifacts\/production-build$/u);
    assert.equal(build.FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST, '');
    assert.equal(build.FSUSBLOG_CI_PRODUCTION_DOMAINS, '');
    for (const physicalBundleId of [
        'backend-tests',
        'frontend-tests',
        'runtime-browser',
        'performance-evidence'
    ])
    {
        const environment = productionFreshEnvironmentForPhysicalTier(layout, {
            id: `local-production-${physicalBundleId}`,
            physicalBundleId
        }, ambientConsumerAuthority);
        assert.equal(environment.FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT, '');
        assert.equal(environment.FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST, '');
        assert.equal(environment.FSUSBLOG_CI_PRODUCTION_DOMAINS, '');
        assert.equal(environment.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID, 'attempt-0001');
    }
});

test('bundle evidence must prove every member with executed IDs and digests', () =>
{
    const valid = {
        schema: 'fsusblog.local-production.bundle.v1',
        physicalBundleId: 'backend',
        executionSource: 'fresh',
        status: 'success',
        members: {
            a: { status: 'success', durationMs: 10, testIds: ['backend:A'], artifactDigests: { trx: `sha256:${'a'.repeat(64)}` } },
            b: { status: 'success', durationMs: 20, testIds: ['backend:B'], artifactDigests: { trx: `sha256:${'b'.repeat(64)}` } }
        }
    };
    assert.deepEqual(validateLocalBundleSummary(valid, { id: 'backend', members: ['a', 'b'] }), []);
    assert.ok(validateLocalBundleSummary({ ...valid, members: { a: valid.members.a } }, {
        id: 'backend', members: ['a', 'b']
    }).some((error) => error.includes('missing member evidence: b')));
    assert.ok(validateLocalBundleSummary({
        ...valid,
        members: { ...valid.members, a: { ...valid.members.a, testIds: [] } }
    }, { id: 'backend', members: ['a', 'b'] }).some((error) => error.includes('a.testIds')));
    assert.ok(validateLocalBundleSummary({
        ...valid,
        schedulerRunId: 'stale'
    }, { id: 'backend', members: ['a', 'b'] }, { expectedRunId: 'fresh' })
        .some((error) => error.includes('schedulerRunId must be fresh')));
});

test('performance deadline evidence binds the mixed floor to same-run measured serial time', () =>
{
    const steps = [
        { id: 'coverage-merge', evidencePhase: 'preparation', status: 'success', durationMs: 4_000, startedAtMs: 1_000, finishedAtMs: 5_000 },
        { id: 'mixed-performance-window', evidencePhase: 'measurement', status: 'success', durationMs: 60_000, startedAtMs: 5_000, finishedAtMs: 65_000 },
        { id: 'backend-perf', evidencePhase: 'measurement', status: 'success', durationMs: 20_000, startedAtMs: 65_000, finishedAtMs: 85_000 },
        { id: 'privacy-zk-benchmark', evidencePhase: 'measurement', status: 'success', durationMs: 0, startedAtMs: 85_000, finishedAtMs: 85_000 },
        { id: 'aeds-frame-cost', evidencePhase: 'measurement', status: 'success', durationMs: 0, startedAtMs: 85_000, finishedAtMs: 85_000 },
        { id: 'aeds-compression', evidencePhase: 'measurement', status: 'success', durationMs: 0, startedAtMs: 85_000, finishedAtMs: 85_000 },
        { id: 'performance-summary', evidencePhase: 'post-measurement', status: 'success', durationMs: 1_000, startedAtMs: 85_000, finishedAtMs: 86_000 }
    ];
    const valid = {
        schema: 'fsusblog.performance-deadline-evidence.v2',
        status: 'sufficient',
        schedulerRunId: 'fresh-performance',
        sourceState: { commit: 'abc123', worktreeFingerprint: 'tree-1' },
        candidateBudgetMs: 81_000,
        bundleDurationMs: 80_000,
        coordinationWaitMs: 0,
        preparationWorkMs: 4_000,
        postMeasurementWorkMs: 1_000,
        measurementIsolation: { status: 'isolated', noiseOverlaps: [] },
        mixedWindow: {
            stepId: 'mixed-performance-window',
            minimumDurationMs: performanceMixedWindowFloorMs,
            measuredDurationMs: 60_000
        },
        measuredOtherSerialMs: 20_000,
        requiredBudgetMs: 80_000,
        steps
    };
    assert.deepEqual(validatePerformanceDeadlineEvidence(valid, { expectedRunId: 'fresh-performance' }), []);
    assert.ok(validatePerformanceDeadlineEvidence(valid, {
        expectedRunId: 'fresh-performance',
        expectedSourceState: { commit: 'abc123', worktreeFingerprint: 'tree-2' }
    }).some((error) => error.includes('match the checkpoint')));
    assert.ok(validatePerformanceDeadlineEvidence({ ...valid, candidateBudgetMs: 79_999 }, {
        expectedRunId: 'fresh-performance'
    }).some((error) => error.includes('below required 80000')));
    assert.ok(validatePerformanceDeadlineEvidence({
        ...valid,
        mixedWindow: { ...valid.mixedWindow, measuredDurationMs: 59_999 }
    }).some((error) => error.includes('at least 60000')));
    assert.ok(validatePerformanceDeadlineEvidence({ ...valid, measuredOtherSerialMs: 19_999 })
        .some((error) => error.includes('minus mixed duration')));
    assert.ok(validatePerformanceDeadlineEvidence({
        ...valid,
        steps: valid.steps.filter((step) => step.id !== 'privacy-zk-benchmark')
    }).some((error) => error.includes('measurement steps must be exactly')));
    assert.ok(validatePerformanceDeadlineEvidence({
        ...valid,
        steps: valid.steps.map((step) => step.id === 'performance-summary'
            ? { ...step, startedAtMs: 84_000, finishedAtMs: 85_000 }
            : step)
    }).some((error) => error.includes('measurement overlaps noise')));
});

test('bundle step timing derives duration and finish from one clock sample', () =>
{
    assert.match(localBundleRunner,
        /const finishedAtMs = Date\.now\(\);\s+const result = \{\s+\.\.\.finalizedExit,\s+durationMs: finishedAtMs - started,\s+startedAtMs: started,\s+finishedAtMs,/u);
    assert.doesNotMatch(localBundleRunner,
        /durationMs: Date\.now\(\) - started[\s\S]{0,120}finishedAtMs: Date\.now\(\)/u);
});

test('bundle evidence is bound to matrix runtime declarations or an explicit command-log fallback', () =>
{
    const runtimeTier = {
        id: 'runtime-tier',
        artifacts: ['.tmp/runtime/result.json'],
        evidence: ['tests/runtime.test.mjs', '.tmp/runtime/result.json']
    };
    const pureTier = {
        id: 'pure-tier',
        artifacts: [],
        evidence: ['tests/pure.test.mjs']
    };
    const valid = {
        schema: 'fsusblog.local-production.bundle.v1',
        physicalBundleId: 'fixture',
        executionSource: 'fresh',
        status: 'success',
        members: {
            'runtime-tier': {
                status: 'success',
                durationMs: 10,
                testIds: ['test:runtime'],
                artifactProofMode: 'matrix-runtime-artifacts',
                matrixRuntimePaths: ['.tmp/runtime/result.json'],
                artifactSubstitutionProofs: {},
                artifactDigests: {
                    '.tmp/local-production/fixture/steps/runtime.log': `sha256:${'a'.repeat(64)}`,
                    '.tmp/runtime/result.json': `sha256:${'b'.repeat(64)}`
                }
            },
            'pure-tier': {
                status: 'success',
                durationMs: 5,
                testIds: ['test:pure'],
                artifactProofMode: 'command-log-and-test-ids',
                matrixRuntimePaths: [],
                artifactSubstitutionProofs: {},
                artifactDigests: {
                    '.tmp/local-production/fixture/steps/pure.log': `sha256:${'c'.repeat(64)}`
                }
            }
        }
    };
    const options = { matrixTiers: [runtimeTier, pureTier], profileId: 'production' };
    assert.deepEqual(validateLocalBundleSummary(valid, {
        id: 'fixture', members: ['runtime-tier', 'pure-tier']
    }, options), []);

    const missingRuntimeDigest = structuredClone(valid);
    delete missingRuntimeDigest.members['runtime-tier'].artifactDigests['.tmp/runtime/result.json'];
    assert.ok(validateLocalBundleSummary(missingRuntimeDigest, {
        id: 'fixture', members: ['runtime-tier', 'pure-tier']
    }, options).some((error) => error.includes('missing the matrix runtime artifact digest')));

    const logOnlyRuntime = structuredClone(valid);
    logOnlyRuntime.members['runtime-tier'].artifactProofMode = 'command-log-and-test-ids';
    assert.ok(validateLocalBundleSummary(logOnlyRuntime, {
        id: 'fixture', members: ['runtime-tier', 'pure-tier']
    }, options).some((error) => error.includes('artifactProofMode must be matrix-runtime-artifacts')));

    const pureWithoutLog = structuredClone(valid);
    pureWithoutLog.members['pure-tier'].artifactDigests = { receipt: `sha256:${'d'.repeat(64)}` };
    assert.ok(validateLocalBundleSummary(pureWithoutLog, {
        id: 'fixture', members: ['runtime-tier', 'pure-tier']
    }, options).some((error) => error.includes('must provide a command log digest')));
});

test('local bundle runner never silently drops a declared artifact', () =>
{
    assert.match(localBundleRunner, /const artifacts = digestArtifacts\(declaredArtifacts, step\.id\)[\s\S]*?const artifactDigests = artifacts\.digests/u);
    assert.match(localBundleRunner, /const substitutionsByTier = resolveArtifactSubstitutions\(bundle, matrix\.tiers\)/u);
    assert.match(localBundleRunner, /const allRuntimeArtifacts = digestArtifacts\([\s\S]*?const allRuntimeDigests = allRuntimeArtifacts\.digests[\s\S]*?allRuntimeDigests\[canonicalPath\]/u);
    assert.match(localBundleRunner, /artifactSubstitutionBindingDigest\(canonicalPath, actualDigests\)[\s\S]*?artifactSubstitutionProofs\[canonicalPath\]/u);
    assert.match(localBundleRunner, /registerSubstitution\([\s\S]*?canonicalArtifactRef/u);
    assert.match(localBundleRunner, /bindMatrixRuntimeArtifacts\(\)[\s\S]*?const members =/u);
    assert.doesNotMatch(localBundleRunner, /artifactFiles\][\s\S]{0,120}filter\(\(file\) => fs\.existsSync\(file\)\)/u);
});
