import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createProductionBuildReceipt } = await import(new URL('../../tools/ci/production-build-artifacts.mjs', import.meta.url));
const {
    githubNeedsAuthority,
    schedulerAuthority
} = await import(new URL('../../tools/release/test-evidence-receipts-cli.mjs', import.meta.url));
const {
    productionCorrectnessTierClosure,
    validateBrowserlessCorrectnessReceipt
} = await import(new URL('../../tools/release/test-evidence-receipts.mjs', import.meta.url));
const { parseMatrix } = await import(new URL('../../tools/test-matrix/parse-matrix.mjs', import.meta.url));
const { writeCanonicalSchedulerFixture } = await import(new URL('./support/canonical-scheduler-fixture.mjs', import.meta.url));

const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
const buildReceiptDigest = `sha256:${'c'.repeat(64)}`;

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

function sealPlan(overrides = {})
{
    const plan = {
        schema: 'fsusblog.pr-smart-gate.v1',
        generatedAt: '2026-07-18T00:00:00.000Z',
        sourceState,
        runId: '42',
        runAttempt: '3',
        selectedTierIds: ['production-correctness', 'unit'],
        skippedTierIds: ['conditional-tier'],
        selectedJobIds: ['required'],
        skippedJobIds: ['conditional'],
        summaryAuthorityJobIds: ['conditional', 'required'],
        ...overrides,
        contentDigest: null
    };
    const content = { ...plan };
    delete content.contentDigest;
    plan.contentDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex')}`;
    return plan;
}

function sealDocument(document)
{
    const sealed = { ...document, contentDigest: null };
    const content = { ...sealed };
    delete content.contentDigest;
    sealed.contentDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex')}`;
    return sealed;
}

function authorityEnv(overrides = {})
{
    return {
        QUALITY_GATE_NEEDS_JSON: JSON.stringify({ required: { result: 'success' }, conditional: { result: 'skipped' } }),
        FSUSBLOG_CORRECTNESS_SUMMARY_AUTHORITY: 'passed',
        FSUSBLOG_CI_PRODUCTION_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
        FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: buildReceiptDigest,
        GITHUB_SHA: sourceState.commit,
        GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '3',
        ...overrides
    };
}

test('scheduler authority keeps dependency success provisional while the aggregate is still running', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-1151-authority-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runId = 'production-correctness-1151';
    const checkpointFile = path.join(root, '.tmp/test-runs', runId, 'checkpoint.json');
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
    writeCanonicalSchedulerFixture(checkpointFile, {
        runId,
        sourceState,
        authoritative: true,
        tiers: {
            unit: { status: 'success', resourceUtilization: { peakBrowserProcessCount: 0 } },
            'production-correctness': { status: 'running' }
        }
    });

    const authority = schedulerAuthority(runId, ['unit', 'production-correctness'], sourceState, { repositoryRoot: root });
    assert.equal(authority.status, 'provisional');
    assert.equal(authority.authorityLevel, 'provisional');
    assert.equal(authority.qualificationEligible, false);
    assert.equal(authority.authoritative, false);
    assert.equal(authority.aggregateStatus, 'running');

    const failed = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
    failed.tiers.unit.status = 'failure';
    fs.writeFileSync(checkpointFile, `${JSON.stringify(failed)}\n`);
    assert.equal(schedulerAuthority(runId, ['unit', 'production-correctness'], sourceState, { repositoryRoot: root }).status,
        'provisional', 'mutable JSON cannot replace canonical dependency state');
    writeCanonicalSchedulerFixture(checkpointFile, failed);
    assert.throws(
        () => schedulerAuthority(runId, ['unit', 'production-correctness'], sourceState, { repositoryRoot: root }),
        /incomplete correctness tiers: unit/u
    );
});

test('scheduler receipt generation rejects stale summaries and cannot seal a running aggregate', (context) =>
{
    const repositoryRoot = path.resolve(import.meta.dirname, '../..');
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-1151-scheduler-summary-'));
    context.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    // Snapshot the current tooling sources and declared schemas, rather than an
    // obsolete hand-picked import list that fails before exercising authority.
    fs.cpSync(path.join(repositoryRoot, 'tools'), path.join(fixture, 'tools'), {
        recursive: true,
        filter: (file) => !file.split(path.sep).includes('node_modules')
    });
    fs.cpSync(path.join(repositoryRoot, 'config'), path.join(fixture, 'config'), { recursive: true });
    fs.cpSync(path.join(repositoryRoot, 'tests/browser-contract'), path.join(fixture, 'tests/browser-contract'), { recursive: true });
    fs.cpSync(path.join(repositoryRoot, 'tools/test-matrix/schema-validator/node_modules'),
        path.join(fixture, 'tools/test-matrix/schema-validator/node_modules'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'tests/matrix.yml'), `version: 1\ntiers:\n  - id: unit\n    executionDependsOn: []\n    requiresPlaywright: none\n  - id: production-correctness\n    executionDependsOn: [unit]\n    requiresPlaywright: none\n`);

    const artifactRoot = path.join(fixture, 'build');
    fs.mkdirSync(path.join(fixture, 'inputs'), { recursive: true });
    fs.mkdirSync(path.join(artifactRoot, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'inputs/lock.json'), '{}\n');
    fs.writeFileSync(path.join(artifactRoot, 'backend/server.dll'), 'fixture\n');
    createProductionBuildReceipt({
        root: fixture,
        artifactRoot,
        sourceState,
        producer: { workflow: 'local', runId: 'current-run', runAttempt: 1, job: 'production-build-artifacts' },
        toolchain: { node: 'v24', npm: '11', dotnet: '10', vite: '7', vitest: '3', playwright: '1', emsdk: '4' },
        inputPaths: ['inputs'],
        domains: [{ name: 'backend', path: 'backend' }]
    });
    const buildFile = path.join(artifactRoot, 'receipt.json');

    const checkpointFile = path.join(fixture, '.tmp/test-runs/current-run/checkpoint.json');
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
    writeCanonicalSchedulerFixture(checkpointFile, {
        runId: 'current-run', sourceState, authoritative: true,
        tiers: {
            unit: { status: 'success', resourceUtilization: { peakBrowserProcessCount: 0 } },
            'production-correctness': { status: 'running' }
        }
    });
    const summaryFile = path.join(fixture, '.tmp/release-evidence/jobs/unit.json');
    fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
    const stale = sealDocument({
        schema: 'fsusblog.ci.job-result.v1', jobId: 'unit', ciJob: 'unit',
        tierIds: ['production-correctness', 'unit'], status: 'success', evidenceClass: 'correctness',
        affectsCorrectness: true, commit: sourceState.commit, runId: 'local', attempt: '0',
        schedulerRunId: 'stale-run', testIds: ['node:stale#must-not-bind']
    });
    fs.writeFileSync(summaryFile, `${JSON.stringify(stale, null, 2)}\n`);
    const output = path.join(fixture, '.tmp/release-evidence/correctness.json');
    const command = [
        path.join(fixture, 'tools/release/test-evidence-receipts-cli.mjs'),
        'create-correctness', '--build-receipt', buildFile, '--out', output
    ];
    const env = {
        ...process.env,
        QUALITY_GATE_NEEDS_JSON: '', GITHUB_SHA: '', GITHUB_RUN_ID: '', GITHUB_RUN_ATTEMPT: '',
        FSUSBLOG_CI_PRODUCTION_SOURCE_FINGERPRINT: '', FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: '',
        FSUSBLOG_TEST_RUN_ID: 'current-run'
    };
    const rejected = spawnSync(process.execPath, command, { cwd: fixture, encoding: 'utf8', env });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /job summaries are missing tiers: unit|found no correctness job summaries/u);

    const current = sealDocument({ ...stale, schedulerRunId: 'current-run', testIds: ['node:current#bound'] });
    fs.writeFileSync(summaryFile, `${JSON.stringify(current, null, 2)}\n`);
    const provisional = spawnSync(process.execPath, command, { cwd: fixture, encoding: 'utf8', env });
    assert.equal(provisional.status, 1);
    assert.match(provisional.stderr, /authority is not successful: provisional/u);
    assert.equal(fs.existsSync(output), false);
});

test('GitHub authority admits only plan-authorized skipped needs after production summary has passed', () =>
{
    const plan = sealPlan({ selectedJobIds: ['not-a-direct-summary-need', 'required'] });
    assert.throws(
        () => githubNeedsAuthority(authorityEnv({ FSUSBLOG_CORRECTNESS_SUMMARY_AUTHORITY: '' }), { plan, buildReceiptDigest }),
        /requires a passed production summary/u
    );

    const authority = githubNeedsAuthority(authorityEnv(), { plan, buildReceiptDigest });
    assert.equal(authority.status, 'success');
    assert.equal(authority.authoritative, true);
    assert.deepEqual(authority.skippedJobIds, ['conditional']);
    assert.equal(authority.admittedByProductionSummary, true);
    assert.equal(authority.buildReceiptDigest, buildReceiptDigest);
    assert.equal(authority.plan.contentDigest, plan.contentDigest);
    assert.deepEqual(authority.plan, plan);
    assert.deepEqual(authority.jobIds, ['conditional', 'required']);
    assert.deepEqual(authority.plan.selectedJobIds, ['not-a-direct-summary-need', 'required']);
    assert.deepEqual(authority.plan.skippedJobIds, ['conditional']);

    assert.throws(
        () => githubNeedsAuthority(authorityEnv({
            QUALITY_GATE_NEEDS_JSON: JSON.stringify({ required: { result: 'success' } })
        }), { plan, buildReceiptDigest }),
        /needs do not exactly match the production-summary authority job projection/u
    );
    assert.throws(
        () => githubNeedsAuthority(authorityEnv({
            QUALITY_GATE_NEEDS_JSON: JSON.stringify({
                required: { result: 'success' }, conditional: { result: 'skipped' }, extra: { result: 'success' }
            })
        }), { plan, buildReceiptDigest }),
        /needs do not exactly match the production-summary authority job projection/u
    );

    assert.throws(
        () => githubNeedsAuthority(authorityEnv({
            QUALITY_GATE_NEEDS_JSON: JSON.stringify({ required: { result: 'skipped' }, conditional: { result: 'skipped' } })
        }), { plan, buildReceiptDigest }),
        /selected job required is skipped/u
    );
    assert.throws(
        () => githubNeedsAuthority(authorityEnv({ GITHUB_RUN_ATTEMPT: '4' }), { plan, buildReceiptDigest }),
        /plan run identity is stale/u
    );
    assert.throws(
        () => githubNeedsAuthority(authorityEnv(), { plan: sealPlan({ sourceState: { ...sourceState, commit: 'd'.repeat(40) } }), buildReceiptDigest }),
        /plan commit is stale/u
    );
});

test('ci-pr-plan seals source/run identity and exact selected/skipped sets', (context) =>
{
    const repositoryRoot = path.resolve(import.meta.dirname, '../..');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-1151-pr-plan-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const changedFiles = path.join(directory, 'changed.txt');
    const output = path.join(directory, 'plan.json');
    const githubOutput = path.join(directory, 'github-output.txt');
    fs.writeFileSync(changedFiles, 'docs/notes/unrelated-smart-gate-example.md\n');
    const result = spawnSync(process.execPath, [
        path.join(repositoryRoot, 'tools/run-test-matrix.mjs'),
        'ci-pr-plan', '--changed-files', changedFiles, '--event-name', 'pull_request',
        '--out', output, '--github-output', githubOutput
    ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
            GITHUB_RUN_ID: '42',
            GITHUB_RUN_ATTEMPT: '3'
        }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const plan = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(plan.sourceState.commit, sourceState.commit);
    assert.equal(plan.sourceState.worktreeFingerprint, sourceState.worktreeFingerprint);
    assert.equal(plan.runId, '42');
    assert.equal(plan.runAttempt, '3');
    assert.deepEqual(plan.selectedJobIds, plan.selectedJobs);
    assert.deepEqual(plan.skippedJobIds, plan.skippedJobs);
    assert.ok(plan.summaryAuthorityJobIds.includes('plan-pr-risk'));
    assert.ok(plan.summaryAuthorityJobIds.includes('release-evidence'));
    assert.ok(plan.summaryAuthorityJobIds.includes('perf-regression'));
    assert.ok(plan.selectedJobIds.includes('production-summary'));
    assert.ok(plan.selectedJobIds.includes('production-build-artifacts'));
    assert.ok(plan.selectedTierIds.includes('production-build-artifacts'));
    for (const tierId of ['data-scale-evidence-summary', 'performance-evidence-summary', 'release-evidence'])
    {
        assert.ok(plan.selectedTierIds.includes(tierId), `${tierId} must reflect release-evidence if:always execution`);
    }
    for (const conditionalJob of ['cross-stack-contract', 'security-static-fuzz', 'perf-regression'])
    {
        assert.ok(plan.skippedJobIds.includes(conditionalJob), `${conditionalJob} should stay skipped for unrelated docs`);
    }
    assert.equal(sealPlan({ ...plan, contentDigest: undefined }).contentDigest, plan.contentDigest);
    assert.match(fs.readFileSync(githubOutput, 'utf8'), new RegExp(`plan_content_digest=${plan.contentDigest}`, 'u'));
    const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/quality-gate.yml'), 'utf8');
    for (const output of ['cross_stack_contract', 'security_static_fuzz', 'perf_regression'])
    {
        assert.match(workflow, new RegExp(`${output}: \\$\\{\\{ steps\\.smart\\.outputs\\.${output} \\}\\}`, 'u'));
        assert.match(workflow, new RegExp(`needs\\.plan-pr-risk\\.outputs\\.${output} == 'true'`, 'u'));
    }
    const partialExecutionJobs = new Set([
        'backend-mutation',
        'backend-qps-collectors',
        'release-evidence',
        'production-summary',
        'browser-diagnostics'
    ]);
    assert.deepEqual(
        plan.skippedTiers
            .filter((tier) => plan.selectedJobIds.includes(tier.ciJob) && !partialExecutionJobs.has(tier.ciJob))
            .map((tier) => `${tier.id}->${tier.ciJob}`),
        []
    );

    fs.writeFileSync(changedFiles, 'src/shared/Contracts/IntegrationTriggerFixture.cs\n');
    const integrationOutput = path.join(directory, 'integration-plan.json');
    const integrationResult = spawnSync(process.execPath, [
        path.join(repositoryRoot, 'tools/run-test-matrix.mjs'),
        'ci-pr-plan', '--changed-files', changedFiles, '--event-name', 'pull_request',
        '--out', integrationOutput
    ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
            GITHUB_RUN_ID: '42',
            GITHUB_RUN_ATTEMPT: '3'
        }
    });
    assert.equal(integrationResult.status, 0, integrationResult.stderr || integrationResult.stdout);
    const integrationPlan = JSON.parse(fs.readFileSync(integrationOutput, 'utf8'));
    for (const tierId of ['bootstrap', 'integration', 'rights-v3-test-matrix', 'data-scale-xs', 'data-scale-s'])
    {
        assert.ok(integrationPlan.selectedTierIds.includes(tierId), `${tierId} must match fixed integration-runtime execution`);
    }
    assert.ok(integrationPlan.skippedJobIds.includes('endpoint-depth-runtime'));
    assert.match(workflow, /endpoint_depth_runtime: \$\{\{ steps\.smart\.outputs\.endpoint_depth_runtime \}\}/u);
    assert.match(workflow, /needs\.plan-pr-risk\.outputs\.endpoint_depth_runtime == 'true'/u);
});

test('matrix validator rejects browser diagnostics mislabeled as correctness', (context) =>
{
    const repositoryRoot = path.resolve(import.meta.dirname, '../..');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-1151-matrix-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const source = fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8');
    const start = source.indexOf('  - id: visual\n');
    assert.ok(start >= 0, 'visual tier fixture is missing');
    const end = source.indexOf('\n  - id:', start + 1);
    const block = source.slice(start, end);
    assert.match(block, /evidenceClass: diagnostic/u);
    const mutated = `${source.slice(0, start)}${block.replace('evidenceClass: diagnostic', 'evidenceClass: correctness')}${source.slice(end)}`;
    const matrix = path.join(directory, 'matrix.yml');
    fs.writeFileSync(matrix, mutated);
    const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'tools/run-test-matrix.mjs'), 'validate'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, FSUSBLOG_MATRIX_FILE: matrix }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /visual\.ciJob=browser-diagnostics requires explicit evidenceClass=diagnostic/u);
});

test('receipt CLI passes the ordinary PR plan to core without claiming policy-skipped tiers', (context) =>
{
    const repositoryRoot = path.resolve(import.meta.dirname, '../..');
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-1151-cli-authority-'));
    context.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    for (const relativeFile of [
        'tools/release/test-evidence-receipts-cli.mjs',
        'tools/release/test-evidence-receipts.mjs',
        'tools/release/release-domain-final-binding.mjs',
        'tools/release/release-reliability-qualified-receipt.mjs',
        'tools/test-matrix/content-addressed-evidence-store.mjs',
        'tools/test-matrix/parse-matrix.mjs',
        'tools/yaml/parse-document.mjs',
        'tests/matrix.yml'
    ])
    {
        const target = path.join(fixture, relativeFile);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, relativeFile), target);
    }

    const artifactRoot = path.join(fixture, 'build');
    fs.mkdirSync(path.join(fixture, 'inputs'), { recursive: true });
    fs.mkdirSync(path.join(artifactRoot, 'frontend-dist'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'inputs/lock.json'), '{}\n');
    fs.writeFileSync(path.join(artifactRoot, 'frontend-dist/index.html'), '<!doctype html>\n');
    const buildReceipt = createProductionBuildReceipt({
        root: fixture,
        artifactRoot,
        sourceState,
        producer: { workflow: 'Quality Gate', runId: '42', runAttempt: 3, job: 'production-build-artifacts' },
        toolchain: {
            node: 'v24', npm: '11', dotnet: '10', vite: '7', vitest: '3', playwright: '1', emsdk: '4'
        },
        inputPaths: ['inputs'],
        domains: [{ name: 'frontend-dist', path: 'frontend-dist' }]
    });
    const buildFile = path.join(artifactRoot, 'receipt.json');

    const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
    const correctnessTierIds = productionCorrectnessTierClosure(matrix).map((tier) => tier.id);
    const plan = sealPlan({
        selectedTierIds: ['production-correctness'],
        skippedTierIds: correctnessTierIds.filter((id) => id !== 'production-correctness'),
        selectedJobIds: ['required'],
        skippedJobIds: ['conditional']
    });
    const planFile = path.join(fixture, '.tmp/pr-plan.json');
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);

    const jobSummary = sealDocument({
        schema: 'fsusblog.ci.job-result.v1',
        jobId: 'production-summary',
        ciJob: 'production-summary',
        tierIds: ['production-correctness'],
        status: 'success',
        evidenceClass: 'correctness',
        affectsCorrectness: true,
        commit: sourceState.commit,
        runId: '42',
        attempt: '3',
        testIds: ['node:fixture#ordinary-pr']
    });
    const summaryFile = path.join(fixture, '.tmp/release-evidence/jobs/production-summary.json');
    fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
    fs.writeFileSync(summaryFile, `${JSON.stringify(jobSummary, null, 2)}\n`);

    const output = path.join(fixture, '.tmp/release-evidence/correctness.json');
    const result = spawnSync(process.execPath, [
        path.join(fixture, 'tools/release/test-evidence-receipts-cli.mjs'),
        'create-correctness', '--build-receipt', buildFile, '--pr-plan', planFile, '--out', output
    ], {
        cwd: fixture,
        encoding: 'utf8',
        env: authorityEnv({
            FSUSBLOG_CORRECTNESS_SUMMARY_AUTHORITY: 'passed',
            FSUSBLOG_CI_PR_PLAN_DIGEST: plan.contentDigest,
            FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: buildReceipt.contentDigest
        })
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.deepEqual(receipt.aggregate.executedTierIds, ['production-correctness']);
    assert.deepEqual(receipt.aggregate.policySkippedTierIds, correctnessTierIds.filter((id) => id !== 'production-correctness').sort());
    assert.deepEqual(receipt.aggregate.testIds.filter((id) => id.startsWith('tier:')), ['tier:production-correctness']);
    assert.equal(receipt.authority.authoritative, true);
    assert.equal(receipt.authority.buildReceiptDigest, buildReceipt.contentDigest);
    assert.deepEqual(receipt.authority.plan, plan);

    const embeddedPlanTamper = structuredClone(receipt);
    embeddedPlanTamper.authority.plan.selectedJobIds = ['forged-job'];
    const resealedTamper = sealDocument(embeddedPlanTamper);
    assert.ok(validateBrowserlessCorrectnessReceipt(resealedTamper).some((error) => (
        error.includes('plan content digest mismatch')
    )));

    const tampered = { ...jobSummary, testIds: [...jobSummary.testIds, 'node:fixture#tampered'] };
    fs.writeFileSync(summaryFile, `${JSON.stringify(tampered, null, 2)}\n`);
    const tamperedResult = spawnSync(process.execPath, [
        path.join(fixture, 'tools/release/test-evidence-receipts-cli.mjs'),
        'create-correctness', '--build-receipt', buildFile, '--pr-plan', planFile, '--out', output
    ], {
        cwd: fixture,
        encoding: 'utf8',
        env: authorityEnv({
            FSUSBLOG_CORRECTNESS_SUMMARY_AUTHORITY: 'passed',
            FSUSBLOG_CI_PR_PLAN_DIGEST: plan.contentDigest,
            FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: buildReceipt.contentDigest
        })
    });
    assert.equal(tamperedResult.status, 1);
    assert.match(tamperedResult.stderr, /correctness job summary content digest mismatch/u);

    fs.writeFileSync(summaryFile, `${JSON.stringify(jobSummary, null, 2)}\n`);
    const conflicting = sealDocument({ ...jobSummary, testIds: [...jobSummary.testIds, 'node:fixture#conflict'] });
    fs.writeFileSync(path.join(path.dirname(summaryFile), 'conflicting-production-summary.json'), `${JSON.stringify(conflicting, null, 2)}\n`);
    const conflictResult = spawnSync(process.execPath, [
        path.join(fixture, 'tools/release/test-evidence-receipts-cli.mjs'),
        'create-correctness', '--build-receipt', buildFile, '--pr-plan', planFile, '--out', output
    ], {
        cwd: fixture,
        encoding: 'utf8',
        env: authorityEnv({
            FSUSBLOG_CORRECTNESS_SUMMARY_AUTHORITY: 'passed',
            FSUSBLOG_CI_PR_PLAN_DIGEST: plan.contentDigest,
            FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: buildReceipt.contentDigest
        })
    });
    assert.equal(conflictResult.status, 1);
    assert.match(conflictResult.stderr, /conflicting current correctness job summaries: production-summary/u);

    fs.rmSync(path.join(path.dirname(summaryFile), 'conflicting-production-summary.json'));
    const skippedClaim = sealDocument({
        ...jobSummary,
        tierIds: ['production-correctness', plan.skippedTierIds[0]]
    });
    fs.writeFileSync(summaryFile, `${JSON.stringify(skippedClaim, null, 2)}\n`);
    const skippedClaimResult = spawnSync(process.execPath, [
        path.join(fixture, 'tools/release/test-evidence-receipts-cli.mjs'),
        'create-correctness', '--build-receipt', buildFile, '--pr-plan', planFile, '--out', output
    ], {
        cwd: fixture,
        encoding: 'utf8',
        env: authorityEnv({
            FSUSBLOG_CORRECTNESS_SUMMARY_AUTHORITY: 'passed',
            FSUSBLOG_CI_PR_PLAN_DIGEST: plan.contentDigest,
            FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: buildReceipt.contentDigest
        })
    });
    assert.equal(skippedClaimResult.status, 1);
    assert.match(skippedClaimResult.stderr, /current correctness job summaries claim policy-skipped tiers/u);
});

test('Browser Contract and diagnostics CLI validation bind current source and immutable build by default', (context) =>
{
    const repositoryRoot = path.resolve(import.meta.dirname, '../..');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-1151-cli-defaults-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const browserContract = path.join(directory, 'browser-contract.json');
    const diagnostics = path.join(directory, 'diagnostics.json');
    fs.writeFileSync(browserContract, `${JSON.stringify({
        schema: 'fsusblog.browser-contract-receipt.v2',
        status: 'success', evidenceClass: 'browser-contract', affectsCorrectness: true,
        sourceState,
        build: { receiptContentDigest: buildReceiptDigest },
        buildBinding: { sourceState, receiptContentDigest: buildReceiptDigest }
    })}\n`);
    fs.writeFileSync(diagnostics, `${JSON.stringify({
        schema: 'fsusblog.browser-diagnostics-receipt.v2',
        status: 'success', evidenceClass: 'diagnostic', affectsCorrectness: false,
        sourceState,
        buildBinding: { sourceState, receiptContentDigest: buildReceiptDigest }
    })}\n`);
    const env = {
        ...process.env,
        GITHUB_SHA: 'd'.repeat(40),
        FSUSBLOG_CI_PRODUCTION_SOURCE_FINGERPRINT: 'e'.repeat(64),
        FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: `sha256:${'f'.repeat(64)}`
    };
    const cases = [
        ['validate-browser-contract', browserContract, [
            /Browser Contract commit does not match release commit/u,
            /Browser Contract source fingerprint mismatch/u,
            /Browser Contract build receipt digest mismatch/u
        ]],
        ['validate-diagnostics', diagnostics, [
            /diagnostics commit mismatch/u,
            /diagnostics source fingerprint mismatch/u,
            /diagnostics build receipt digest mismatch/u
        ]]
    ];
    for (const [command, file, patterns] of cases)
    {
        const result = spawnSync(process.execPath, [
            path.join(repositoryRoot, 'tools/release/test-evidence-receipts-cli.mjs'), command, file
        ], { cwd: repositoryRoot, encoding: 'utf8', env });
        assert.equal(result.status, 1);
        for (const pattern of patterns)
        {
            assert.match(result.stderr, pattern);
        }
    }
});
