import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { buildMixedWindowPlan } = await import(
    pathToFileURL(path.join(root, 'tools/test/run-mixed-performance-window.mjs')).href
);
await import( pathToFileURL(path.join(root, 'tools/test-matrix/fresh-production.mjs')).href );
const {
    createLocalBundleTiers,
    collectLogicalTierIds,
    digestDeclaredOutputs,
    localProfileSystemResources,
    localProfileBudgetCriticalPath,
    resolveLocalProfileResources,
    resolveArtifactSubstitutions,
    resolveFrontendVitestAdmissionFloor,
    validateArtifactSubstitutions,
    validateLocalProfiles
} = await import(pathToFileURL(path.join(root, 'tools/test-matrix/local-profile.mjs')).href);
const { parseMatrix } = await import(pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href);
await import(pathToFileURL(path.join(root, 'tools/run-test-matrix.mjs')).href);
const { behaviorDocStaticAdmissionTierId } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/behavior-doc-static-admission-contract.mjs')).href
);
await import( pathToFileURL(path.join(root, 'tools/testing/fixture-catalog.mjs')).href );
await import( pathToFileURL(path.join(root, 'tools/test-matrix/production-fresh-exclusive-lease.mjs')).href );
await import( pathToFileURL(path.join(root, 'tools/test-matrix/production-capacity-reservation.mjs')).href );



function tier(id, dependsOn = [])
{
    return { id, executionDependsOn: dependsOn };
}

function profile(overrides = {})
{
    return {
        budgetMs: 3_600_000,
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

test('collectLogicalTierIds returns the complete dependency and summary authority closure', () =>
{
    const tiers = [
        tier('production', ['summary']),
        { ...tier('summary', ['a', 'b']), executionMode: 'summary', summaryAuthority: 'summary-authority' },
        { ...tier('summary-sibling'), executionMode: 'summary', summaryAuthority: 'summary-authority' },
        tier('a'),
        tier('b', ['c']),
        tier('c'),
        tier('unrelated')
    ];

    assert.deepEqual(
        collectLogicalTierIds(tiers, 'production'),
        ['a', 'b', 'c', 'production', 'summary', 'summary-sibling']
    );
});

test('production profile requires exact fresh logical-tier coverage', () =>
{
    const tiers = [tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')];
    assert.deepEqual(validateLocalProfiles({ production: profile() }, tiers), []);

    const duplicate = profile({
        bundles: profile().bundles.map((bundle) => bundle.id === 'backend-tests'
            ? { ...bundle, members: ['a', 'b'] }
            : bundle)
    });
    assert.ok(validateLocalProfiles({ production: duplicate }, tiers).some((error) => error.includes('mapped more than once: a')));

    const missing = profile({
        bundles: profile().bundles.map((bundle) => bundle.id === 'runtime-browser'
            ? { ...bundle, members: [] }
            : bundle)
    });
    assert.ok(validateLocalProfiles({ production: missing }, tiers).some((error) => error.includes('missing logical tier: d')));
});

test('production profile rejects the retired five-minute fixture budget', () =>
{
    const tiers = [tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')];
    assert.deepEqual(validateLocalProfiles({ production: profile({ budgetMs: 300_000 }) }, tiers), [
        'localProfiles.production.budgetMs must be 3600000'
    ]);
});

test('production profile rejects invalid resource declarations', () =>
{
    const errors = validateLocalProfiles({ production: profile({ budgetMs: 0 }) }, [
        tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')
    ]);
    assert.ok(errors.some((error) => error.includes('budgetMs must be positive')));

    const invalidPacking = profile({
        bundles: profile().bundles.map((bundle) => bundle.id === 'backend-tests'
            ? { ...bundle, cpuWeight: 0, minCpuUnits: 0 }
            : bundle)
    });
    const packingErrors = validateLocalProfiles({ production: invalidPacking }, [
        tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')
    ]);
    assert.ok(packingErrors.includes('localProfiles.production.backend-tests.cpuWeight must be positive'));
    assert.ok(packingErrors.includes('localProfiles.production.backend-tests.minCpuUnits must be positive'));

    const wrongRuntimeResources = profile({
        bundles: profile().bundles.map((bundle) => bundle.id === 'runtime-browser'
            ? { ...bundle, deadlineWeight: 0, memoryWeight: 0 }
            : bundle)
    });
    const runtimeResourceErrors = validateLocalProfiles({ production: wrongRuntimeResources }, [
        tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')
    ]);
    assert.ok(runtimeResourceErrors.includes('localProfiles.production.runtime-browser.deadlineWeight must be positive'));
    assert.ok(runtimeResourceErrors.includes('localProfiles.production.runtime-browser.memoryWeight must be positive'));

    const undersizedFloor = profile({
        minimumSupportedCpuUnits: 3,
        bundles: profile().bundles.map((bundle) => ({ ...bundle, startupMinCpuUnits: 4, minCpuUnits: 4 }))
    });
    assert.ok(validateLocalProfiles({ production: undersizedFloor }, [
        tier('production', ['a', 'b', 'c', 'd']), tier('a'), tier('b'), tier('c'), tier('d')
    ]).includes('localProfiles.production smallest startup CPU minimum 4 exceeds supported machine floor 3'));
});

test('physical bundle creation rejects malformed resolved startup policy', () =>
{
    const resolved = resolveLocalProfileResources(profile(), {
        availableCpuUnits: 5,
        availableMemoryGiB: 10
    });
    for (const [label, mutate] of [
        ['zero startup memory weight', (bundle) => ({ ...bundle, startupMemoryWeight: 0 })],
        ['startup CPU above steady minimum', (bundle) => ({
            ...bundle,
            startupMinCpuUnits: bundle.minCpuUnits + 1
        })],
        ['negative startup priority', (bundle) => ({ ...bundle, startupPriority: -1 })]
    ])
    {
        const malformed = {
            ...resolved,
            bundles: resolved.bundles.map((bundle, index) => index === 0 ? mutate(bundle) : bundle)
        };
        assert.throws(
            () => createLocalBundleTiers('production', malformed),
            /local bundle resource policy must be resolved/u,
            label
        );
    }
});

test('local production derives full CPU, safe memory and launch parallelism from the machine', () =>
{
    assert.deepEqual(
        localProfileSystemResources(profile(), { cpuCount: 8, availableMemoryGiB: 11, load1: 3.5 }),
        {
            cpuCount: 8,
            availableCpuUnits: 8,
            availableMemoryGiB: 10.45,
            load1: 3.5,
            launchParallelism: 8,
            memoryReserveGiB: 0.55
        }
    );
    assert.deepEqual(
        localProfileSystemResources(profile(), { cpuCount: 8, availableMemoryGiB: 16, load1: 0 }),
        {
            cpuCount: 8,
            availableCpuUnits: 8,
            availableMemoryGiB: 15.2,
            load1: 0,
            launchParallelism: 8,
            memoryReserveGiB: 0.8
        }
    );
    const busy = localProfileSystemResources(profile(), { cpuCount: 8, availableMemoryGiB: 16, load1: 12 });
    assert.equal(busy.availableCpuUnits, 8);
    assert.equal(busy.load1, 12);
    assert.equal(busy.launchParallelism, 8);
    assert.equal(localProfileSystemResources(profile(), { cpuCount: 7, availableMemoryGiB: 9, load1: 0 }).availableCpuUnits, 7);
    assert.equal(localProfileSystemResources(profile(), { cpuCount: 4, availableMemoryGiB: 9, load1: 0 }).availableCpuUnits, 4);
    assert.throws(() => localProfileSystemResources(profile(), { cpuCount: 3, availableMemoryGiB: 9, load1: 0 }), /at least 4/u);
    assert.throws(() => localProfileSystemResources(profile(), { cpuCount: 8, availableMemoryGiB: 0, load1: 0 }), /positive available memory/u);
    assert.throws(() => localProfileSystemResources(profile(), { cpuCount: 8, availableMemoryGiB: 9, load1: -1 }), /non-negative/u);
});

test('production bundle resources resolve from each machine and fill its usable capacity', () =>
{
    for (const availableCpuUnits of [4, 5, 6, 8, 16])
    {
        const resolved = resolveLocalProfileResources(profile(), {
            availableCpuUnits,
            availableMemoryGiB: 18
        });
        assert.deepEqual(resolved.bundles.map((bundle) => bundle.stepMaxParallel), resolved.bundles.map((bundle) => bundle.cpuUnits));
        assert.equal(resolved.bundles.slice(0, 4).reduce((total, bundle) => total + bundle.cpuUnits, 0), availableCpuUnits);
        const criticalPathBudgetMs = localProfileBudgetCriticalPath(resolved);
        assert.ok(criticalPathBudgetMs <= resolved.budgetMs);
        assert.ok(criticalPathBudgetMs >= resolved.budgetMs - resolved.bundles.length);
        const performance = resolved.bundles.find((bundle) => bundle.id === 'performance-evidence');
        assert.ok(performance.budgetMs >= resolved.budgetMs * performance.minimumDeadlineShare);
        assert.ok(performance.budgetMs >= buildMixedWindowPlan().durationMs);
    }

    const fiveCoreDeadlines = resolveLocalProfileResources(profile(), { availableCpuUnits: 5, availableMemoryGiB: 18 });
    const eightCoreDeadlines = resolveLocalProfileResources(profile(), { availableCpuUnits: 8, availableMemoryGiB: 18 });
    assert.notDeepEqual(
        fiveCoreDeadlines.bundles.map((bundle) => bundle.budgetMs),
        eightCoreDeadlines.bundles.map((bundle) => bundle.budgetMs)
    );
    assert.ok(eightCoreDeadlines.bundles.every((bundle) => bundle.budgetMs > 0));

    for (const usableMemoryGiB of [9, 18, 31.5])
    {
        const resolved = resolveLocalProfileResources(profile(), { availableCpuUnits: 8, availableMemoryGiB: usableMemoryGiB });
        const memory = resolved.bundles.map((bundle) => bundle.memoryGiB);
        assert.ok(Math.abs(memory.slice(0, 4).reduce((total, value) => total + value, 0) - usableMemoryGiB) < 1e-10);
        assert.ok(Math.abs(memory[0] - usableMemoryGiB * 3 / 14) < 1e-10);
        assert.ok(Math.abs(memory[1] - usableMemoryGiB * 4 / 14) < 1e-10);
        assert.ok(Math.abs(memory[2] - usableMemoryGiB * 2 / 14) < 1e-10);
        assert.ok(Math.abs(memory[3] - usableMemoryGiB * 5 / 14) < 1e-10);
        assert.equal(memory[4], usableMemoryGiB);
    }

    assert.throws(
        () => resolveLocalProfileResources(profile(), { availableCpuUnits: 3, availableMemoryGiB: 9 }),
        /at least 4/u
    );
    const impossibleMinimum = profile({
        bundles: profile().bundles.map((bundle) => bundle.id === 'backend-tests'
            ? { ...bundle, minCpuUnits: 3 }
            : bundle)
    });
    assert.throws(
        () => resolveLocalProfileResources(impossibleMinimum, { availableCpuUnits: 3, availableMemoryGiB: 9 }),
        /requires at least 4 available CPU units from declared minima/u
    );
});

test('frontend steady admission floor follows machine capacity and cannot deadlock its worker host', () =>
{
    assert.equal(resolveFrontendVitestAdmissionFloor({ cpuCount: 4, eventualFrontendCapacity: 1 }), 1);
    assert.equal(resolveFrontendVitestAdmissionFloor({ cpuCount: 8, eventualFrontendCapacity: 5 }), 3);
    assert.equal(resolveFrontendVitestAdmissionFloor({ cpuCount: 16, eventualFrontendCapacity: 13 }), 4);

    const resolved = resolveLocalProfileResources(profile(), {
        availableCpuUnits: 8,
        availableMemoryGiB: 18
    });
    assert.equal(resolved.bundles.find((bundle) => bundle.id === 'frontend-tests').minCpuUnits, 3);
});

test('declared output digests fail closed for missing direct and wildcard artifacts', () =>
{
    const temp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-local-artifacts-'));
    fs.mkdirSync(path.join(temp, '.tmp/evidence/nested'), { recursive: true });
    fs.writeFileSync(path.join(temp, '.tmp/evidence/result.json'), '{"status":"success"}\n');
    fs.writeFileSync(path.join(temp, '.tmp/evidence/nested/screenshot.png'), 'fixture');

    const digests = digestDeclaredOutputs(temp, [
        '.tmp/evidence/result.json',
        '.tmp/evidence/**/*.png',
        '.tmp/evidence'
    ]);
    assert.deepEqual(Object.keys(digests), [
        '.tmp/evidence',
        '.tmp/evidence/**/*.png',
        '.tmp/evidence/result.json'
    ]);
    assert.ok(Object.values(digests).every((digest) => /^sha256:[a-f0-9]{64}$/u.test(digest)));
    assert.throws(
        () => digestDeclaredOutputs(temp, ['.tmp/evidence/missing.json']),
        /declared artifact is missing: \.tmp\/evidence\/missing\.json/u
    );
    assert.throws(
        () => digestDeclaredOutputs(temp, ['.tmp/evidence/**/missing.png']),
        /declared artifact is missing: \.tmp\/evidence\/\*\*\/missing\.png/u
    );
});

test('artifact substitutions use a parser-compatible flat contract and reject ambiguous mappings', () =>
{
    const canonicalPath = '.tmp/backend-unit';
    const actualSummary = '.tmp/test-results/backend/production/summary.json';
    const actualCoverage = '.tmp/coverage/backend-merged/Summary.json';
    const encoded = `backend-unit::${canonicalPath}=>${actualSummary}|${actualCoverage}`;
    const parsed = parseMatrix([
        'localProfiles:',
        '  fixture:',
        '    bundles:',
        '      - id: backend',
        `        artifactSubstitutions: [${encoded}]`,
        'tiers:'
    ].join('\n'));
    assert.deepEqual(parsed.localProfiles.fixture.bundles[0].artifactSubstitutions, [encoded]);

    const matrixTiers = [{
        id: 'backend-unit',
        artifacts: [canonicalPath],
        evidence: [`${canonicalPath}/summary.json`]
    }];
    const bundle = {
        id: 'backend',
        members: ['backend-unit'],
        artifactSubstitutions: [encoded]
    };
    assert.deepEqual(validateArtifactSubstitutions(bundle, matrixTiers), []);
    assert.deepEqual(resolveArtifactSubstitutions(bundle, matrixTiers), {
        'backend-unit': {
            [canonicalPath]: [actualCoverage, actualSummary],
            [`${canonicalPath}/summary.json`]: [actualCoverage, actualSummary]
        }
    });

    const invalidContracts = [
        { value: [], error: /must be a non-empty flat array/u },
        { value: ['malformed'], error: /entry is malformed/u },
        { value: [`unknown::${canonicalPath}=>${actualSummary}`], error: /unknown bundle tier/u },
        { value: [`backend-unit::.tmp/unknown=>${actualSummary}`], error: /unknown canonical path/u },
        { value: [`backend-unit::${canonicalPath}=>../outside/Summary.json`], error: /invalid actual proof path/u },
        { value: [`backend-unit::${canonicalPath}=>tests/backend/Summary.json`], error: /must be generated runtime paths/u },
        { value: [`backend-unit::${canonicalPath}=>.tmp/local-production/backend/steps/tests.log`], error: /cannot use command logs/u },
        { value: [`backend-unit::${canonicalPath}=>.tmp/runtime/result.json`], error: /must include a TRX, coverage, or summary proof/u },
        { value: [`backend-unit::${canonicalPath}=>${actualSummary}|${actualSummary}`], error: /duplicate actual proof paths/u },
        { value: [`backend-unit::${canonicalPath}=>${actualSummary}`, `backend-unit::./${canonicalPath}=>${actualCoverage}`], error: /duplicate canonical path/u },
        { value: [`backend-unit::${canonicalPath}=>${canonicalPath}`], error: /cannot substitute itself/u }
    ];
    for (const fixture of invalidContracts)
    {
        const errors = validateArtifactSubstitutions({
            id: 'backend',
            members: ['backend-unit'],
            artifactSubstitutions: fixture.value
        }, matrixTiers);
        assert.ok(errors.some((error) => fixture.error.test(error)), `${fixture.value}: ${errors.join('; ')}`);
    }
});

test('repository production profile maps every logical tier exactly once', (context) =>
{
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const declaration = matrix.tiers.find((tier) => tier.id === 'validate-declarations');
    const governance = matrix.tiers.find((tier) => tier.id === 'validate-matrix');
    const bundleSource = fs.readFileSync(path.join(root, 'tools/test/bundles/run-bundle.mjs'), 'utf8');
    assert.ok(bundleSource.includes(`commandStep('${governance.id}', '${declaration.command} && ${governance.command}', ['${declaration.id}', '${governance.id}'])`));
    const actual = spawnSync(process.execPath, ['tools/run-test-matrix.mjs', 'validate-declarations'], {
        cwd: root, encoding: 'utf8'
    });
    assert.equal(actual.status, 0, actual.stderr);
    assert.match(actual.stdout, /global declarations ok \(\d+ tiers\); no execution qualification/u);
    context.diagnostic(`actual declaration CLI exit=${actual.status}: ${actual.stdout.trim()}`);
    const logicalTierIds = collectLogicalTierIds(matrix.tiers, 'production');
    const mappedTierIds = matrix.localProfiles.production.bundles.flatMap((bundle) => bundle.members);

    assert.deepEqual(mappedTierIds.toSorted(), logicalTierIds.toSorted());
    assert.equal(new Set(mappedTierIds).size, mappedTierIds.length);
    assert.equal(Object.hasOwn(matrix.localProfiles.production, 'maxParallel'), false);
    assert.equal(Object.hasOwn(matrix.localProfiles.production, 'cpuUnits'), false);
    assert.equal(Object.hasOwn(matrix.localProfiles.production, 'memoryGiB'), false);
    assert.equal(Object.hasOwn(matrix.localProfiles.production, 'maxInitialLoad1'), false);
    assert.ok(matrix.localProfiles.production.bundles.every((bundle) => bundle.deadlineWeight > 0));
    assert.ok(matrix.localProfiles.production.bundles.every((bundle) => bundle.cpuWeight > 0));
    assert.ok(matrix.localProfiles.production.bundles.every((bundle) => bundle.memoryWeight > 0));
    assert.ok(matrix.localProfiles.production.bundles.every((bundle) => bundle.minCpuUnits > 0));
    assert.ok(matrix.localProfiles.production.bundles.every((bundle) => !Object.hasOwn(bundle, 'budgetMs')));
    assert.ok(matrix.localProfiles.production.bundles.every((bundle) => !Object.hasOwn(bundle, 'cpuUnits')));
    assert.ok(matrix.localProfiles.production.bundles.every((bundle) => !Object.hasOwn(bundle, 'memoryGiB')));
    assert.ok(matrix.localProfiles.production.bundles.every((bundle) => !Object.hasOwn(bundle, 'stepMaxParallel')));
    const performanceBundle = matrix.localProfiles.production.bundles.find((bundle) => bundle.id === 'performance-evidence');
    assert.deepEqual(performanceBundle.dependsOn, ['build-static', 'backend-tests', 'frontend-tests', 'runtime-browser']);
    const frontendBundle = matrix.localProfiles.production.bundles.find((bundle) => bundle.id === 'frontend-tests');
    const frontendSubstitutions = resolveArtifactSubstitutions(frontendBundle, matrix.tiers)['frontend-property-model-perf'];
    for (const canonical of [
        '.tmp/test-results/vitest/property',
        '.tmp/test-results/vitest/model'
    ])
    {
        assert.ok(frontendSubstitutions[canonical].includes('.tmp/test-results/vitest/production-rolling'));
        assert.equal(frontendSubstitutions[canonical].some((entry) => /\/(?:property|model)-coverage$/u.test(entry)), false);
    }
    assert.ok(frontendSubstitutions['.tmp/test-results/vitest/perf'].includes('.tmp/test-results/vitest/production'));
    const runtimeBundle = matrix.localProfiles.production.bundles.find((bundle) => bundle.id === 'runtime-browser');
    const runtimeSubstitutions = resolveArtifactSubstitutions(runtimeBundle, matrix.tiers);
    assert.deepEqual(runtimeSubstitutions.security['.tmp/security'], [
        '.tmp/local-production/runtime-browser/member-summaries/security/summary.json'
    ]);
    assert.equal(
        runtimeSubstitutions['cross-browser-smoke'],
        undefined,
        'cross-browser diagnostics must not project into local production correctness evidence'
    );
    assert.deepEqual(validateLocalProfiles(matrix.localProfiles, matrix.tiers), []);
});

test('repository production t0 grants scale by weights without exceeding each machine', () =>
{
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const initialIds = ['build-static', 'backend-tests', 'frontend-tests', 'runtime-browser'];
    const grantsByCpu = new Map();

    for (const availableCpuUnits of [4, 5, 6, 8, 16])
    {
        const resolved = resolveLocalProfileResources(matrix.localProfiles.production, {
            availableCpuUnits,
            availableMemoryGiB: availableCpuUnits * 2
        });
        const grants = initialIds.map((id) => resolved.bundles.find((bundle) => bundle.id === id).cpuUnits);
        grantsByCpu.set(availableCpuUnits, grants);
        assert.equal(grants.reduce((total, value) => total + value, 0), availableCpuUnits);
        assert.ok(grants.every((value) => Number.isInteger(value) && value > 0));
        assert.ok(grants.every((value) => value >= 1), 't0 bundles must retain startup minima');
    }

    assert.deepEqual(grantsByCpu.get(4), [1, 1, 1, 1]);
    assert.deepEqual(grantsByCpu.get(5), [1, 2, 1, 1]);
    assert.ok(grantsByCpu.get(16)[0] > grantsByCpu.get(8)[0], 'build-static must scale on a larger machine');
});
