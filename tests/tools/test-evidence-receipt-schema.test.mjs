import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/* eslint-disable import-x/no-relative-parent-imports */
import { createProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs';
import {
    browserDiagnosticsReceiptSchema,
    browserlessCorrectnessReceiptSchema,
    createBrowserlessCorrectnessReceipt,
    createReleaseFinalTestEvidenceBinding,
    sealBrowserContractReceipt,
    sealBrowserDiagnosticsReceipt,
    validateBrowserContractReceipt,
    validateBrowserDiagnosticsReceipt,
    validateBrowserlessCorrectnessReceipt,
    validatePublicPreviewEvidenceBinding,
    validateReleaseFinalTestEvidenceBinding
} from '../../tools/release/test-evidence-receipts.mjs';
import {
    createRequiredEvidenceCatalogBinding
} from '../../tools/test-matrix/required-evidence-catalog.mjs';

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sealDocument(document)
{
    const sealed = { ...document, contentDigest: null };
    const content = { ...sealed };
    delete content.contentDigest;
    sealed.contentDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex')}`;
    return sealed;
}

function buildFixture(context)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-1151-receipt-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const repositoryRoot = path.join(directory, 'repo');
    const artifactRoot = path.join(directory, 'build');
    fs.mkdirSync(path.join(repositoryRoot, 'inputs'), { recursive: true });
    fs.mkdirSync(path.join(artifactRoot, 'frontend-dist'), { recursive: true });
    fs.writeFileSync(path.join(repositoryRoot, 'inputs', 'lock.json'), '{}\n');
    fs.writeFileSync(path.join(artifactRoot, 'frontend-dist', 'index.html'), '<!doctype html>\n');
    const sourceState = {
        commit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64)
    };
    const receipt = createProductionBuildReceipt({
        root: repositoryRoot,
        artifactRoot,
        sourceState,
        producer: { workflow: 'fixture', runId: '1151', runAttempt: 1, job: 'production-build-artifacts' },
        toolchain: {
            node: 'v24.0.0', npm: '11.0.0', dotnet: '10.0.100', vite: '7.0.0',
            vitest: '3.0.0', playwright: '1.55.0', emsdk: '4.0.0'
        },
        inputPaths: ['inputs'],
        domains: [{ name: 'frontend-dist', path: 'frontend-dist' }],
        now: () => new Date('2026-07-18T00:00:00.000Z')
    });
    return { directory, repositoryRoot, artifactRoot, sourceState, receipt, receiptFile: path.join(artifactRoot, 'receipt.json') };
}

function correctnessFixture(build)
{
    return createBrowserlessCorrectnessReceipt({
        matrix: {
            tiers: [
                { id: 'unit', dependsOn: [], requiresPlaywright: 'none' },
                { id: 'production-correctness', dependsOn: ['unit'], requiresPlaywright: 'none' }
            ]
        },
        buildReceipt: build.receipt,
        buildReceiptPath: 'build/receipt.json',
        jobSummaries: [{
            schema: 'fsusblog.ci.job-result.v1',
            jobId: 'fast-unit',
            status: 'success',
            evidenceClass: 'correctness',
            affectsCorrectness: true,
            commit: build.sourceState.commit,
            tierIds: ['unit', 'production-correctness'],
            testIds: ['node:unit.test.mjs#works'],
            schedulerRunId: 'run-1151'
        }],
        authority: { kind: 'scheduler-checkpoint', status: 'success', runId: 'run-1151', authoritative: true },
        now: () => new Date('2026-07-18T00:01:00.000Z')
    });
}

function browserContractFixture(build)
{
    const browserPlan = sealDocument({
        schema: 'fsusblog.playwright-browser-identity.v1',
        executionClass: 'correctness', evidenceClass: 'browser-contract',
        qualificationEligible: true, managedExecutable: true,
        browserName: 'chromium', browserVersion: '140.0.0', revision: '123456',
        executablePath: '/managed/chromium-123456/chrome',
        executableSha256: `sha256:${'f'.repeat(64)}`,
        playwright: { package: '@playwright/test', version: '1.59.1' },
        launchOptions: { headless: true, executablePath: '/managed/chromium-123456/chrome', args: [] },
        rendering: {
            fontSetDigest: `sha256:${'1'.repeat(64)}`,
            localeDataDigest: `sha256:${'2'.repeat(64)}`,
            locale: 'zh-CN', deviceScaleFactor: 1, renderingMode: 'headless',
            colorScheme: 'light', gpuMode: 'software'
        }
    });
    const browserActual = sealDocument({
        ...structuredClone(browserPlan),
        schema: 'fsusblog.playwright-browser-actual.v1',
        planDigest: browserPlan.contentDigest,
        renderingObservation: {
            locale: 'zh-CN', deviceScaleFactor: 1, colorScheme: 'light',
            renderer: 'SwiftShader fixture renderer'
        }
    });
    const publicPreview = {
        schema: 'fsusblog.public-preview-screenshot-verification.v1',
        status: 'ok',
        sourceCommit: build.sourceState.commit,
        releaseId: `20260718000000-${build.sourceState.commit.slice(0, 12)}`,
        manifestSchema: 'fsusblog.public-preview-screenshot-manifest.v1',
        visualInputDigest: 'c'.repeat(64),
        runtimeAudit: true,
        layoutAudit: true,
        sanitizationCheck: true,
        images: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`screenshot-${index + 1}`, `${index + 1}`.repeat(64)])),
        differences: [],
        commandVersion: 'd'.repeat(64),
        captureContextCount: 9,
        evidencePath: '.tmp/release-evidence/public-preview-screenshots.json',
        evidenceFileDigest: `sha256:${'e'.repeat(64)}`
    };
    return sealBrowserContractReceipt({
        schema: 'fsusblog.browser-contract-receipt.v2',
        status: 'success',
        classification: 'clean',
        sourceState: build.sourceState,
        build: {
            receipt: 'build/receipt.json',
            receiptContentDigest: build.receipt.contentDigest,
            sourceState: build.sourceState,
            profile: build.receipt.build.profile
        },
        fixture: { namespace: 'browser-contract-run-1151' },
        playwright: {
            chromiumRevision: '123456', chromiumVersion: '140.0.0',
            browserIdentity: { plan: browserPlan, actual: browserActual }
        },
        topology: {
            runner: 'playwright-library', browserType: 'chromium', managedBrowser: true,
            workerPool: false, shard: null, retries: 0, browserLaunchCount: 1,
            maxConcurrentBrowserRoots: 1, contextCount: 2
        },
        scenarios: [
            {
                id: 'public-route', status: 'success', classification: 'clean',
                issues: [{ kind: 'response', detail: 'expected 429', expected: true }], artifacts: []
            },
            {
                id: 'admin-route', status: 'success', classification: 'clean',
                issues: [], artifacts: ['.tmp/browser-contract/runs/private/admin.png']
            }
        ],
        publicPreview,
        startedAt: '2026-07-18T00:00:00.000Z',
        finishedAt: '2026-07-18T00:00:02.000Z',
        wallClockMs: 2_000,
        error: null
    });
}

function releaseReliabilityBinding(build)
{
    const scenarioIds = [
        'release-data-scale-m',
        'release-load-burst',
        'release-load-peak',
        'release-memory-leak-budget',
        'release-mutation-critical-slice',
        'release-open-handle-budget',
        'release-soak-min'
    ];
    return {
        authorityId: 'release-reliability-fresh',
        receiptPath:
            '.tmp/release-reliability/release-fixture/qualified-receipt.json',
        contentDigest: `sha256:${'1'.repeat(64)}`,
        sourceIdentity: {
            invocationId: 'release-fixture',
            runId: 'release-run',
            commit: build.sourceState.commit,
            worktreeFingerprint: build.sourceState.worktreeFingerprint,
            dirtyPathCount: 0,
            hashedPathCount: 1
        },
        buildIdentity: {
            terminalReceiptFileDigest: `sha256:${'2'.repeat(64)}`,
            candidate: {
                path:
                    '.tmp/release-reliability/release-fixture/candidate-receipt.json',
                fileDigest: `sha256:${'b'.repeat(64)}`,
                contentDigest: `sha256:${'c'.repeat(64)}`
            },
            attestation: {
                path:
                    '.tmp/release-reliability/release-fixture/verified-attestation.json',
                fileDigest: `sha256:${'d'.repeat(64)}`,
                contentDigest: `sha256:${'e'.repeat(64)}`
            },
            identity: {
                path: '.tmp/release-reliability/release-fixture/identity.json',
                fileDigest: `sha256:${'f'.repeat(64)}`,
                contentDigest: `sha256:${'1'.repeat(64)}`
            },
            build: {
                path: 'build/receipt.json',
                fileDigest: `sha256:${'3'.repeat(64)}`,
                contentDigest: build.receipt.contentDigest,
                imageDigest: `sha256:${'4'.repeat(64)}`
            },
            image: {
                imageDigest: `sha256:${'4'.repeat(64)}`,
                revision: build.sourceState.commit
            },
            imageAuthority: {
                imageDigest: `sha256:${'4'.repeat(64)}`,
                revision: build.sourceState.commit
            },
            fixture: {
                config: {
                    path: 'fixture/config.env',
                    fileDigest: `sha256:${'2'.repeat(64)}`
                },
                schema: {
                    path: 'fixture/schema.sql',
                    fileDigest: `sha256:${'3'.repeat(64)}`
                },
                seed: {
                    path: 'fixture/seed.json',
                    fileDigest: `sha256:${'4'.repeat(64)}`
                },
                auditRetentionPolicy: {
                    path: 'fixture/AuditRetentionCatalog.cs',
                    fileDigest: `sha256:${'5'.repeat(64)}`
                },
                topology: {
                    path: 'fixture/topology.json',
                    fileDigest: `sha256:${'5'.repeat(64)}`,
                    content: {
                        contentDigest: `sha256:${'6'.repeat(64)}`
                    }
                }
            },
            machine: {
                schedulerPolicy: {
                    path: 'config/testing/scheduler-resource-policy.json',
                    fileDigest: `sha256:${'6'.repeat(64)}`
                }
            },
            topology: {
                path: 'fixture/topology.json',
                fileDigest: `sha256:${'5'.repeat(64)}`,
                content: { contentDigest: `sha256:${'6'.repeat(64)}` }
            },
            policy: {
                ...Object.fromEntries([
                    ['catalog', '7'],
                    ['threshold', '8'],
                    ['mutationSubset', '9'],
                    ['releaseResource', 'a']
                ].map(([field, digestCharacter]) => [
                    field,
                    {
                        path: `config/testing/${field}.json`,
                        fileDigest: `sha256:${digestCharacter.repeat(64)}`
                    }
                ])),
                childEnvironment: {
                    contentDigest: `sha256:${'b'.repeat(64)}`
                }
            },
            tools: [{ id: 'node', version: process.version }],
            evidence: scenarioIds.map((scenarioId, index) => ({
                scenarioId,
                resultPath:
                    `.tmp/release-reliability/release-fixture/${scenarioId}.json`,
                resultContentDigest:
                    `sha256:${String((index % 8) + 1).repeat(64)}`,
                evidencePath:
                    `.tmp/release-reliability/release-fixture/evidence/${scenarioId}.json`,
                evidenceDigest:
                    `sha256:${String(((index + 1) % 8) + 1).repeat(64)}`
            }))
        },
        scenarioIds,
        verificationStatus: 'verified'
    };
}

test('browserless correctness receipt binds exact tiers and IDs while proving a zero-browser boundary', (context) =>
{
    const build = buildFixture(context);
    const receipt = correctnessFixture(build);

    assert.equal(receipt.schema, browserlessCorrectnessReceiptSchema);
    assert.deepEqual(receipt.aggregate.tierIds, ['production-correctness', 'unit']);
    assert.deepEqual(receipt.aggregate.policyTierIds, ['production-correctness', 'unit']);
    assert.deepEqual(receipt.aggregate.executedTierIds, ['production-correctness', 'unit']);
    assert.deepEqual(receipt.aggregate.policySkippedTierIds, []);
    assert.deepEqual(receipt.aggregate.jobIds, ['fast-unit']);
    assert.deepEqual(receipt.aggregate.testIds, [
        'node:unit.test.mjs#works',
        'tier:production-correctness',
        'tier:unit'
    ]);
    assert.deepEqual(receipt.browserBoundary, {
        browserLaunchCount: 0,
        peakBrowserProcessCount: 0,
        playwrightBrowserInstallation: false,
        browserFixtureSchemaCount: 0,
        browserFixtureSchemas: []
    });
    assert.deepEqual(validateBrowserlessCorrectnessReceipt(receipt, {
        expectedCommit: build.sourceState.commit,
        expectedFingerprint: build.sourceState.worktreeFingerprint,
        expectedBuildReceiptDigest: build.receipt.contentDigest
    }), []);

    const tampered = structuredClone(receipt);
    tampered.browserBoundary.browserLaunchCount = 1;
    assert.ok(validateBrowserlessCorrectnessReceipt(tampered).some((error) => error.includes('browserLaunchCount must be 0')));

    const unboundSummaryFile = structuredClone(receipt);
    unboundSummaryFile.aggregate.jobSummaries[0].file = '.tmp/release-evidence/jobs/fast-unit.json';
    unboundSummaryFile.aggregate.jobSummaries[0].fileDigest = null;
    assert.ok(validateBrowserlessCorrectnessReceipt(unboundSummaryFile).some((error) => error.includes('file digest is invalid')));
});

test('PR plan authority separates executed and policy-skipped tiers without claiming skipped success', (context) =>
{
    const build = buildFixture(context);
    const plan = sealDocument({
        schema: 'fsusblog.pr-smart-gate.v1',
        sourceState: build.sourceState,
        runId: '42',
        runAttempt: '1',
        selectedTierIds: ['pr-unit', 'production-correctness'],
        skippedTierIds: ['full-only'],
        selectedJobIds: ['pr-selected'],
        skippedJobIds: ['full-only-job']
    });
    const receipt = createBrowserlessCorrectnessReceipt({
        matrix: {
            tiers: [
                { id: 'full-only', dependsOn: [], requiresPlaywright: 'none' },
                { id: 'pr-unit', dependsOn: [], requiresPlaywright: 'none' },
                { id: 'production-correctness', dependsOn: ['full-only', 'pr-unit'], requiresPlaywright: 'none' }
            ]
        },
        buildReceipt: build.receipt,
        buildReceiptPath: 'build/receipt.json',
        jobSummaries: [{
            schema: 'fsusblog.ci.job-result.v1',
            jobId: 'pr-selected',
            status: 'success',
            evidenceClass: 'correctness',
            affectsCorrectness: true,
            commit: build.sourceState.commit,
            runId: '42',
            attempt: '1',
            tierIds: ['pr-unit', 'production-correctness'],
            testIds: ['node:pr-unit.test.mjs#selected']
        }],
        authority: {
            kind: 'github-needs',
            status: 'success',
            authoritative: true,
            buildReceiptDigest: build.receipt.contentDigest,
            plan
        }
    });

    assert.deepEqual(receipt.aggregate.policyTierIds, ['full-only', 'pr-unit', 'production-correctness']);
    assert.deepEqual(receipt.aggregate.executedTierIds, ['pr-unit', 'production-correctness']);
    assert.deepEqual(receipt.aggregate.policySkippedTierIds, ['full-only']);
    assert.ok(receipt.aggregate.testIds.includes('tier:pr-unit'));
    assert.ok(!receipt.aggregate.testIds.includes('tier:full-only'));
    assert.deepEqual(validateBrowserlessCorrectnessReceipt(receipt), []);

    const createWithPlan = (candidatePlan, authorityBuildReceiptDigest = build.receipt.contentDigest) => createBrowserlessCorrectnessReceipt({
        matrix: {
            tiers: [
                { id: 'full-only', dependsOn: [], requiresPlaywright: 'none' },
                { id: 'pr-unit', dependsOn: [], requiresPlaywright: 'none' },
                { id: 'production-correctness', dependsOn: ['full-only', 'pr-unit'], requiresPlaywright: 'none' }
            ]
        },
        buildReceipt: build.receipt,
        buildReceiptPath: 'build/receipt.json',
        jobSummaries: [{
            schema: 'fsusblog.ci.job-result.v1',
            jobId: 'pr-selected',
            status: 'success',
            evidenceClass: 'correctness',
            affectsCorrectness: true,
            commit: build.sourceState.commit,
            runId: '42',
            attempt: '1',
            tierIds: ['pr-unit', 'production-correctness'],
            testIds: ['node:pr-unit.test.mjs#selected']
        }],
        authority: {
            kind: 'github-needs', status: 'success', authoritative: true,
            buildReceiptDigest: authorityBuildReceiptDigest,
            plan: candidatePlan
        }
    });
    assert.throws(
        () => createWithPlan(sealDocument({ ...receipt.authority.plan, sourceState: { ...build.sourceState, commit: 'f'.repeat(40) } })),
        /plan source\/build identity mismatch/u
    );
    assert.throws(
        () => createWithPlan(receipt.authority.plan, `sha256:${'0'.repeat(64)}`),
        /authority build receipt digest mismatch/u
    );
    assert.throws(
        () => createWithPlan(sealDocument({ ...receipt.authority.plan, skippedTierIds: [] })),
        /does not authorize skipped tiers: full-only/u
    );
});

test('Browser Contract receipt seals #1078 identity, Chromium topology, diagnostics and artifacts', (context) =>
{
    const build = buildFixture(context);
    const receipt = browserContractFixture(build);

    assert.equal(receipt.evidenceClass, 'browser-contract');
    assert.equal(receipt.buildBinding.receiptContentDigest, build.receipt.contentDigest);
    assert.equal(receipt.fixtureNamespace, 'browser-contract-run-1151');
    assert.deepEqual(receipt.scenarioIds, ['public-route', 'admin-route']);
    assert.equal(receipt.diagnostics.responseErrorCount, 1);
    assert.deepEqual(receipt.artifacts, ['.tmp/browser-contract/runs/private/admin.png']);
    assert.deepEqual(validateBrowserContractReceipt(receipt, {
        expectedCommit: build.sourceState.commit,
        expectedFingerprint: build.sourceState.worktreeFingerprint,
        expectedBuildReceiptDigest: build.receipt.contentDigest
    }), []);

    const binaryDrift = structuredClone(receipt);
    binaryDrift.playwright.browserIdentity.actual.executableSha256 = `sha256:${'0'.repeat(64)}`;
    assert.ok(validateBrowserContractReceipt(sealBrowserContractReceipt(binaryDrift))
        .some((error) => error.includes('executableSha256 mismatch')));

    const diagnosticUpgrade = structuredClone(receipt);
    diagnosticUpgrade.playwright.browserIdentity.actual.executionClass = 'diagnostic';
    diagnosticUpgrade.playwright.browserIdentity.actual.qualificationEligible = false;
    assert.ok(validateBrowserContractReceipt(sealBrowserContractReceipt(diagnosticUpgrade))
        .some((error) => error.includes('actual browser identity is missing or non-qualifying')));
});

test('public-preview evidence binding rejects missing, stale, and tampered local evidence', (context) =>
{
    const build = buildFixture(context);
    const receipt = browserContractFixture(build);
    const evidenceFileDigest = receipt.publicPreview.evidenceFileDigest;
    const evidence = { ...receipt.publicPreview };
    delete evidence.evidencePath;
    delete evidence.evidenceFileDigest;
    assert.deepEqual(validatePublicPreviewEvidenceBinding(receipt.publicPreview, evidence, {
        expectedCommit: build.sourceState.commit,
        evidenceFileDigest
    }), []);
    assert.match(
        validatePublicPreviewEvidenceBinding(null, evidence, { expectedCommit: build.sourceState.commit }).join('; '),
        /evidence is required/u
    );
    assert.match(
        validatePublicPreviewEvidenceBinding(receipt.publicPreview, { ...evidence, visualInputDigest: '0'.repeat(64) }, {
            expectedCommit: build.sourceState.commit,
            evidenceFileDigest
        }).join('; '),
        /visualInputDigest does not match/u
    );
    assert.match(
        validatePublicPreviewEvidenceBinding(receipt.publicPreview, evidence, {
            expectedCommit: build.sourceState.commit,
            evidenceFileDigest: `sha256:${'0'.repeat(64)}`
        }).join('; '),
        /file digest does not match/u
    );
});

test('diagnostics receipt carries cadence, dimensions, counts, retry and typed artifacts without affecting correctness', (context) =>
{
    const build = buildFixture(context);
    const receipt = sealBrowserDiagnosticsReceipt({
        status: 'success',
        mode: 'nightly',
        runId: 'diagnostic-1151',
        sourceState: build.sourceState,
        build: {
            schema: build.receipt.schema,
            receiptFile: 'build/receipt.json',
            contentDigest: build.receipt.contentDigest,
            receiptContentDigest: build.receipt.contentDigest,
            sourceState: build.sourceState
        },
        trigger: { kind: 'schedule', runId: '44' },
        dimensions: {
            browsers: ['chromium'], viewports: ['1280x800'], themes: ['dark'], lanes: ['visual/public']
        },
        plannedProbeCount: 1,
        executedProbeCount: 1,
        skippedProbeCount: 0,
        incompleteReason: null,
        categories: [{
            id: 'visual', browsers: ['chromium'], status: 'success',
            plannedProbeIds: ['public'],
            plannedDimensions: { viewports: ['1280x800'], themes: ['dark'] },
            plannedProbeCount: 1, executedProbeCount: 1, skippedProbeCount: 0,
            probes: [{
                id: 'public', status: 'success', failureClass: null, crashRetryCount: 0,
                plannedDimensions: { viewports: ['1280x800'], themes: ['dark'] },
                attempts: [{
                    attempt: 1,
                    status: 'success',
                    testIds: ['visual/public'],
                    failureClass: null,
                    failureKind: null,
                    artifacts: ['.tmp/browser-diagnostics/diagnostic-1151/attempt-1.json']
                }],
                copiedArtifacts: ['.tmp/visual/public/home.png', '.tmp/perf/browser-performance.json'],
                stdout: '.tmp/browser-diagnostics/diagnostic-1151/stdout.log',
                stderr: '.tmp/browser-diagnostics/diagnostic-1151/stderr.log'
            }]
        }],
        createdAt: '2026-07-18T00:03:00.000Z'
    });

    assert.equal(receipt.schema, browserDiagnosticsReceiptSchema);
    assert.equal(receipt.cadence, 'nightly');
    assert.deepEqual(receipt.counts, { planned: 1, executed: 1, skipped: 0 });
    assert.equal(receipt.crashRetryCount, 0);
    assert.deepEqual(receipt.artifacts.screenshots, ['.tmp/visual/public/home.png']);
    assert.deepEqual(receipt.artifacts.performance, ['.tmp/perf/browser-performance.json']);
    assert.deepEqual(validateBrowserDiagnosticsReceipt(receipt, {
        expectedCommit: build.sourceState.commit,
        expectedFingerprint: build.sourceState.worktreeFingerprint,
        expectedBuildReceiptDigest: build.receipt.contentDigest
    }), []);

    const nestedFailureUnderSuccess = structuredClone(receipt);
    nestedFailureUnderSuccess.status = 'success';
    nestedFailureUnderSuccess.categories[0].status = 'failure';
    nestedFailureUnderSuccess.categories[0].probes[0].status = 'failure';
    nestedFailureUnderSuccess.categories[0].probes[0].failureClass = 'diagnostic';
    nestedFailureUnderSuccess.categories[0].probes[0].attempts[0].status = 'failure';
    nestedFailureUnderSuccess.categories[0].probes[0].attempts[0].failureClass = 'diagnostic';
    nestedFailureUnderSuccess.categories[0].probes[0].attempts[0].failureKind = 'assertion-mismatch';
    const invalidSuccess = sealBrowserDiagnosticsReceipt(nestedFailureUnderSuccess);
    assert.ok(validateBrowserDiagnosticsReceipt(invalidSuccess).some((error) => error.includes('success requires every category/probe/attempt')));

    const topFailureWithoutNestedFailure = sealBrowserDiagnosticsReceipt({ ...receipt, status: 'failure' });
    assert.ok(validateBrowserDiagnosticsReceipt(topFailureWithoutNestedFailure).some((error) => error.includes('failure requires a failed category and probe')));
});

test('Browser Contract rejects a clean success with failed scenarios while preserving mixed failure classes', (context) =>
{
    const build = buildFixture(context);
    const clean = browserContractFixture(build);
    const inconsistent = structuredClone(clean);
    inconsistent.scenarios[0].status = 'failure';
    inconsistent.scenarios[0].classification = 'product';
    inconsistent.scenarios[0].error = { failureClass: 'product', message: 'assertion mismatch' };
    const invalid = sealBrowserContractReceipt(inconsistent);
    assert.ok(validateBrowserContractReceipt(invalid).some((error) => error.includes('success requires every scenario')));

    const mixed = structuredClone(clean);
    mixed.status = 'failure';
    mixed.classification = 'infra';
    mixed.error = { failureClass: 'infra', message: 'browser disconnected after a product mismatch' };
    mixed.scenarios[0].status = 'failure';
    mixed.scenarios[0].classification = 'product';
    mixed.scenarios[0].error = { failureClass: 'product', message: 'product mismatch' };
    mixed.scenarios[1].status = 'failure';
    mixed.scenarios[1].classification = 'infra';
    mixed.scenarios[1].error = { failureClass: 'infra', message: 'browser disconnected' };
    const mixedReceipt = sealBrowserContractReceipt(mixed);
    assert.deepEqual(validateBrowserContractReceipt(mixedReceipt, { requireSuccess: false }), []);

    const malformedFailure = structuredClone(mixed);
    malformedFailure.error.failureClass = 'product';
    const malformedReceipt = sealBrowserContractReceipt(malformedFailure);
    assert.ok(validateBrowserContractReceipt(malformedReceipt, { requireSuccess: false })
        .some((error) => error.includes('top-level error failureClass must match receipt failureClass')));

    const runner = fs.readFileSync(path.resolve(import.meta.dirname, '../browser-contract/run.mjs'), 'utf8');
    const validation = runner.indexOf('validateBrowserContractReceipt(sealed, { requireSuccess: false })');
    const write = runner.indexOf('await writeBrowserContractReceipt(receiptFile, receipt)');
    assert.ok(validation >= 0 && validation < write, 'Browser Contract receipt writer must validate failures before atomic write');
});

test('browserless correctness rejects stale scheduler summaries even when the commit still matches', (context) =>
{
    const build = buildFixture(context);
    const staleSummary = {
        schema: 'fsusblog.ci.job-result.v1',
        jobId: 'fast-unit',
        status: 'success',
        evidenceClass: 'correctness',
        affectsCorrectness: true,
        commit: build.sourceState.commit,
        tierIds: ['unit', 'production-correctness'],
        testIds: ['node:unit.test.mjs#stale'],
        schedulerRunId: 'old-run'
    };
    assert.throws(() => createBrowserlessCorrectnessReceipt({
        matrix: {
            tiers: [
                { id: 'unit', dependsOn: [], requiresPlaywright: 'none' },
                { id: 'production-correctness', dependsOn: ['unit'], requiresPlaywright: 'none' }
            ]
        },
        buildReceipt: build.receipt,
        buildReceiptPath: 'build/receipt.json',
        jobSummaries: [staleSummary],
        authority: { kind: 'scheduler-checkpoint', status: 'success', runId: 'current-run', authoritative: true }
    }), /do not match scheduler authority run current-run: fast-unit/u);

    const valid = correctnessFixture(build);
    const tampered = structuredClone(valid);
    tampered.aggregate.jobSummaries[0].schedulerRunId = 'old-run';
    assert.ok(validateBrowserlessCorrectnessReceipt(tampered)
        .some((error) => error.includes('scheduler run identity mismatch')));
});

test('release-final binding seals raw receipt digests and rejects cross-build identity', (context) =>
{
    const build = buildFixture(context);
    const correctness = correctnessFixture(build);
    const browserContract = browserContractFixture(build);
    const releaseReliabilityQualifiedReceipt =
        releaseReliabilityBinding(build);
    const correctnessFile = path.join(build.directory, 'correctness.json');
    const browserContractFile = path.join(build.directory, 'browser-contract.json');
    const preRuntime = sealDocument({
        schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.v1',
        scope: 'pre-runtime',
        runIdentity: 'run-1151',
        sourceIdentity: build.sourceState,
        status: 'ok',
        behaviorIds: [],
        buildIdentities: {},
        registryDigest: `sha256:${'a'.repeat(64)}`,
        runtimeCandidateSpawnCountBeforeReceipt: 0,
        failureReasons: []
    });
    const preRuntimeFile = path.join(build.directory, 'behavior-pre-runtime.json');
    const postRuntime = sealDocument({
        schema: 'fsusblog.behavior-evidence-post-runtime-receipt.v1',
        scope: 'post-runtime',
        runIdentity: 'run-1151',
        sourceIdentity: build.sourceState,
        preRuntimeReceiptDigest: preRuntime.contentDigest,
        status: 'ok'
    });
    const postRuntimeFile = path.join(build.directory, 'behavior-post-runtime.json');
    const consistencyFinal = sealDocument({
        schema: 'fsusblog.behavior-document-consistency-final-report.v1',
        status: 'ok'
    });
    const consistencyFinalFile = path.join(build.directory, 'behavior-consistency-final.json');
    fs.writeFileSync(correctnessFile, `${JSON.stringify(correctness, null, 2)}\n`);
    fs.writeFileSync(browserContractFile, `${JSON.stringify(browserContract, null, 2)}\n`);
    fs.writeFileSync(preRuntimeFile, `${JSON.stringify(preRuntime, null, 2)}\n`);
    fs.writeFileSync(postRuntimeFile, `${JSON.stringify(postRuntime, null, 2)}\n`);
    fs.writeFileSync(consistencyFinalFile, `${JSON.stringify(consistencyFinal, null, 2)}\n`);
    const releaseDomainProjectionReceipts = [
        'release-admin-console',
        'release-aot-generation',
        'release-auth-flow',
        'release-authoring-flow',
        'release-error-boundary',
        'release-private-preview',
        'release-static-asset-digest-coherence'
    ].map((tierId, index) => ({
        tierId,
        path: `.tmp/release-evidence/projections/${tierId}.json`,
        fileDigest: `sha256:${String(index + 1).repeat(64)}`,
        contentDigest: `sha256:${String(index + 2).repeat(64)}`,
        buildIdentity: `sha256:${'a'.repeat(64)}`,
        policyIdentity: `sha256:${'b'.repeat(64)}`
    }));

    const binding = createReleaseFinalTestEvidenceBinding({
        commitSha: build.sourceState.commit,
        buildReceipt: build.receipt,
        buildReceiptPath: build.receiptFile,
        correctnessReceipt: correctness,
        correctnessReceiptPath: correctnessFile,
        browserContractReceipt: browserContract,
        browserContractReceiptPath: browserContractFile,
        preRuntimeReceipt: preRuntime,
        preRuntimeReceiptPath: preRuntimeFile,
        postRuntimeReceipt: postRuntime,
        postRuntimeReceiptPath: postRuntimeFile,
        consistencyFinalReport: consistencyFinal,
        consistencyFinalReportPath: consistencyFinalFile,
        releaseDomainProjectionReceipts,
        releaseReliabilityQualifiedReceipt,
        requiredEvidenceCatalogBinding: createRequiredEvidenceCatalogBinding(),
        now: () => new Date('2026-07-18T00:04:00.000Z')
    });
    assert.deepEqual(validateReleaseFinalTestEvidenceBinding(binding), []);
    assert.match(binding.receipts.correctness.fileDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.match(binding.receipts.browserContract.fileDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.match(binding.receipts.behaviorPreRuntime.fileDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(binding.requiredEvidenceCatalog, createRequiredEvidenceCatalogBinding());
    assert.deepEqual(
        binding.receipts.releaseDomains.map((receipt) => receipt.tierId),
        releaseDomainProjectionReceipts.map((receipt) => receipt.tierId)
    );
    const tamperedReliabilityAttestation = structuredClone(binding);
    tamperedReliabilityAttestation.receipts.releaseReliability
        .buildIdentity.attestation.fileDigest = 'sha256:invalid';
    tamperedReliabilityAttestation.contentDigest =
        sealDocument(tamperedReliabilityAttestation).contentDigest;
    assert.ok(validateReleaseFinalTestEvidenceBinding(
        tamperedReliabilityAttestation
    ).some((error) => error.includes('attestation')));
    const duplicateReleaseDomain = structuredClone(binding);
    duplicateReleaseDomain.receipts.releaseDomains[1].tierId =
        duplicateReleaseDomain.receipts.releaseDomains[0].tierId;
    assert.ok(validateReleaseFinalTestEvidenceBinding(duplicateReleaseDomain)
        .some((error) => error.includes('canonical release-domain set')));
    const missingReleaseDomain = structuredClone(binding);
    missingReleaseDomain.receipts.releaseDomains.splice(0, 1);
    missingReleaseDomain.contentDigest = sealDocument(missingReleaseDomain).contentDigest;
    assert.ok(validateReleaseFinalTestEvidenceBinding(missingReleaseDomain)
        .some((error) => error.includes('canonical release-domain set')));
    const extraReleaseDomain = structuredClone(binding);
    extraReleaseDomain.receipts.releaseDomains.push({
        ...extraReleaseDomain.receipts.releaseDomains.at(-1),
        tierId: 'release-rbac-negative',
        path: '.tmp/release-evidence/projections/release-rbac-negative.json'
    });
    extraReleaseDomain.contentDigest = sealDocument(extraReleaseDomain).contentDigest;
    assert.ok(validateReleaseFinalTestEvidenceBinding(extraReleaseDomain)
        .some((error) => error.includes('canonical release-domain set')));
    const replacedReleaseDomain = structuredClone(binding);
    replacedReleaseDomain.receipts.releaseDomains[0] = {
        ...replacedReleaseDomain.receipts.releaseDomains[0],
        tierId: 'release-rbac-negative',
        path: '.tmp/release-evidence/projections/release-rbac-negative.json'
    };
    replacedReleaseDomain.contentDigest = sealDocument(replacedReleaseDomain).contentDigest;
    assert.ok(validateReleaseFinalTestEvidenceBinding(replacedReleaseDomain)
        .some((error) => error.includes('canonical release-domain set')));
    const wrongReleaseDomainPath = structuredClone(binding);
    wrongReleaseDomainPath.receipts.releaseDomains[0].path =
        '.tmp/release-evidence/projections/forged.json';
    wrongReleaseDomainPath.contentDigest = sealDocument(wrongReleaseDomainPath).contentDigest;
    assert.ok(validateReleaseFinalTestEvidenceBinding(wrongReleaseDomainPath)
        .some((error) => error.includes('.path must be')));
    const tamperedRequiredAuthority = structuredClone(binding);
    tamperedRequiredAuthority.requiredEvidenceCatalog.authorityIds[0] =
        'behavior-document-consistency-forged';
    tamperedRequiredAuthority.contentDigest =
        sealDocument(tamperedRequiredAuthority).contentDigest;
    assert.ok(validateReleaseFinalTestEvidenceBinding(tamperedRequiredAuthority)
        .some((error) => error.includes('authorityIds mismatch')));

    const requiredAuthorityMutations = [
        ['missing', undefined, /binding is missing/u],
        ['stale catalog digest', {
            ...createRequiredEvidenceCatalogBinding(),
            contentDigest: `sha256:${'0'.repeat(64)}`
        }, /contentDigest mismatch/u],
        ['tampered authority', {
            ...createRequiredEvidenceCatalogBinding(),
            authorityIds: [
                'forged-authority',
                ...createRequiredEvidenceCatalogBinding().authorityIds.slice(1)
            ]
        }, /authorityIds mismatch/u],
        ['tampered file digest', {
            ...createRequiredEvidenceCatalogBinding(),
            fileDigest: `sha256:${'1'.repeat(64)}`
        }, /fileDigest mismatch/u]
    ];
    for (const [name, requiredEvidenceCatalogBinding, errorPattern]
        of requiredAuthorityMutations)
    {
        assert.throws(() => createReleaseFinalTestEvidenceBinding({
            commitSha: build.sourceState.commit,
            buildReceipt: build.receipt,
            buildReceiptPath: build.receiptFile,
            correctnessReceipt: correctness,
            correctnessReceiptPath: correctnessFile,
            browserContractReceipt: browserContract,
            browserContractReceiptPath: browserContractFile,
            preRuntimeReceipt: preRuntime,
            preRuntimeReceiptPath: preRuntimeFile,
            postRuntimeReceipt: postRuntime,
            postRuntimeReceiptPath: postRuntimeFile,
            consistencyFinalReport: consistencyFinal,
            consistencyFinalReportPath: consistencyFinalFile,
            releaseDomainProjectionReceipts,
            releaseReliabilityQualifiedReceipt,
            requiredEvidenceCatalogBinding
        }), errorPattern, name);
    }

    const preRuntimeMutations = [
        ...[
            ['other run', { runIdentity: 'other-run' }],
            ['other source', { sourceIdentity: { ...build.sourceState, commit: 'f'.repeat(40) } }],
            ['other worktree', { sourceIdentity: { ...build.sourceState, worktreeFingerprint: `sha256:${'f'.repeat(64)}` } }]
        ].map(([name, mutation]) => [name, sealDocument({ ...preRuntime, ...mutation }), /identity mismatch/u]),
        ['missing', undefined, /receipt must be an object/u],
        ['stale digest', {
            ...preRuntime,
            contentDigest: `sha256:${'0'.repeat(64)}`
        }, /contentDigest mismatch/u],
        ['tampered schema', sealDocument({
            ...preRuntime,
            schema: 'fsusblog.behavior-evidence-pre-runtime-receipt.forged',
            contentDigest: null
        }), /unexpected schema/u]
    ];
    for (const [name, preRuntimeReceipt, errorPattern] of preRuntimeMutations)
    {
        const boundPostRuntime = sealDocument({
            ...postRuntime,
            preRuntimeReceiptDigest: preRuntimeReceipt?.contentDigest
        });
        assert.throws(() => createReleaseFinalTestEvidenceBinding({
            commitSha: build.sourceState.commit,
            buildReceipt: build.receipt,
            buildReceiptPath: build.receiptFile,
            correctnessReceipt: correctness,
            correctnessReceiptPath: correctnessFile,
            browserContractReceipt: browserContract,
            browserContractReceiptPath: browserContractFile,
            preRuntimeReceipt,
            preRuntimeReceiptPath: preRuntimeFile,
            postRuntimeReceipt: boundPostRuntime,
            postRuntimeReceiptPath: postRuntimeFile,
            consistencyFinalReport: consistencyFinal,
            consistencyFinalReportPath: consistencyFinalFile,
            releaseDomainProjectionReceipts,
            releaseReliabilityQualifiedReceipt,
            requiredEvidenceCatalogBinding: createRequiredEvidenceCatalogBinding()
        }), errorPattern, name);
    }

    const wrongBuild = structuredClone(browserContract);
    wrongBuild.build.receiptContentDigest = `sha256:${'0'.repeat(64)}`;
    wrongBuild.buildBinding.receiptContentDigest = wrongBuild.build.receiptContentDigest;
    assert.throws(() => createReleaseFinalTestEvidenceBinding({
        commitSha: build.sourceState.commit,
        buildReceipt: build.receipt,
        buildReceiptPath: build.receiptFile,
        correctnessReceipt: correctness,
        correctnessReceiptPath: correctnessFile,
        browserContractReceipt: wrongBuild,
        browserContractReceiptPath: browserContractFile,
        preRuntimeReceipt: preRuntime,
        preRuntimeReceiptPath: preRuntimeFile,
        postRuntimeReceipt: postRuntime,
        postRuntimeReceiptPath: postRuntimeFile,
        consistencyFinalReport: consistencyFinal,
        consistencyFinalReportPath: consistencyFinalFile,
        releaseDomainProjectionReceipts,
        releaseReliabilityQualifiedReceipt,
        requiredEvidenceCatalogBinding: createRequiredEvidenceCatalogBinding()
    }), /build receipt digest mismatch|content digest mismatch/u);

    const nonAuthoritative = structuredClone(correctness);
    nonAuthoritative.authority.authoritative = false;
    assert.throws(() => createReleaseFinalTestEvidenceBinding({
        commitSha: build.sourceState.commit,
        buildReceipt: build.receipt,
        buildReceiptPath: build.receiptFile,
        correctnessReceipt: nonAuthoritative,
        correctnessReceiptPath: correctnessFile,
        browserContractReceipt: browserContract,
        browserContractReceiptPath: browserContractFile,
        preRuntimeReceipt: preRuntime,
        preRuntimeReceiptPath: preRuntimeFile,
        postRuntimeReceipt: postRuntime,
        postRuntimeReceiptPath: postRuntimeFile,
        consistencyFinalReport: consistencyFinal,
        consistencyFinalReportPath: consistencyFinalFile,
        releaseDomainProjectionReceipts,
        releaseReliabilityQualifiedReceipt,
        requiredEvidenceCatalogBinding: createRequiredEvidenceCatalogBinding()
    }), /authoritative scheduler correctness checkpoint/u);
});
