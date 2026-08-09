import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
const buildReceiptDigest = `sha256:${'c'.repeat(64)}`;

function write(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

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

function writePlan(root, { selectedJobIds = ['required'], skippedJobIds = [] } = {})
{
    const plan = {
        schema: 'fsusblog.pr-smart-gate.v1',
        generatedAt: '2026-07-18T00:00:00.000Z',
        sourceState,
        runId: '42',
        runAttempt: '1',
        selectedTierIds: ['production-correctness'],
        skippedTierIds: [],
        selectedJobIds: [...selectedJobIds].sort(),
        skippedJobIds: [...skippedJobIds].sort(),
        summaryAuthorityJobIds: [...selectedJobIds, ...skippedJobIds].sort(),
        contentDigest: null
    };
    const content = { ...plan };
    delete content.contentDigest;
    plan.contentDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex')}`;
    const file = path.join(root, '.tmp/pr-plan.json');
    write(file, plan);
    return { file, plan };
}

function writeReceiptGenerator(root)
{
    write(path.join(root, 'tools/release/test-evidence-receipts-cli.mjs'), `
import fs from 'node:fs'
import path from 'node:path'
const output = path.resolve('.tmp/release-evidence/browserless-correctness-receipt.json')
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, JSON.stringify({ schema: 'fixture.correctness', status: 'success' }) + '\\n')
`);
}

function copySummaryDependencies(root)
{
    const relative = 'tools/yaml/workflow-structure.mjs';
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, relative), target);
}

function summaryEnvironment(plan, needs, root)
{
    return {
        ...process.env,
        QUALITY_GATE_NEEDS_JSON: JSON.stringify(needs),
        GITHUB_STEP_SUMMARY: '',
        GITHUB_SHA: sourceState.commit,
        GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '1',
        FSUSBLOG_CI_PR_PLAN_DIGEST: plan.contentDigest,
        FSUSBLOG_CI_PR_SMART_GATE_PLAN: path.join(root, '.tmp/pr-plan.json'),
        FSUSBLOG_RELEASE_EVIDENCE_DIR: path.join(root, '.tmp/release-evidence'),
        FSUSBLOG_RELEASE_EVIDENCE_MANIFEST: path.join(root, '.tmp/release-evidence/manifest.json'),
        FSUSBLOG_CI_PRODUCTION_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
        FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: buildReceiptDigest
    };
}

test('production summary excludes diagnostics retry evidence from its correctness aggregate', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-1151-summary-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const script = path.join(root, 'tools/ci/summarize-quality-gate.mjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, 'tools/ci/summarize-quality-gate.mjs'), script);
    copySummaryDependencies(root);
    write(path.join(root, '.github/workflows/quality-gate.yml'), 'jobs:\n  required:\n    runs-on: ubuntu-latest\n');
    write(path.join(root, 'tools/operations/check-release-evidence-manifest.mjs'), 'process.exit(0)\n');
    writeReceiptGenerator(root);
    const { plan } = writePlan(root);
    write(path.join(root, '.tmp/release-evidence/manifest.json'), {
        status: 'collected-ok',
        evidenceSummary: { externalExposure: { blockers: [], request: { blockerSources: [] } } }
    });
    write(path.join(root, '.tmp/release-evidence/flaky/diagnostic.json'), {
        schema: 'fsusblog.ci.flaky.v1',
        suite: 'browser-diagnostics',
        test: 'visual/public',
        evidenceClass: 'infra-failure',
        sourceEvidenceClass: 'diagnostic',
        affectsCorrectness: true,
        finalStatus: 'passed-after-retry',
        classification: 'infra',
        retryCount: 1
    });
    write(path.join(root, '.tmp/release-evidence/flaky/correctness.json'), {
        schema: 'fsusblog.ci.flaky.v1',
        suite: 'backend-unit',
        test: 'lease-isolation',
        evidenceClass: 'correctness',
        affectsCorrectness: true,
        finalStatus: 'passed-after-retry',
        classification: 'infra',
        retryCount: 1
    });

    const stepSummary = path.join(root, '.tmp/step-summary.md');
    const result = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...process.env,
            ...summaryEnvironment(plan, { required: { result: 'success' } }, root),
            GITHUB_STEP_SUMMARY: stepSummary
        }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(fs.readFileSync(path.join(root, '.tmp/release-evidence/jobs/production-summary.json'), 'utf8'));
    assert.deepEqual(summary.flaky.passedAfterRetry.map((entry) => entry.suite), ['backend-unit']);
    assert.match(summary.contentDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.doesNotMatch(fs.readFileSync(stepSummary, 'utf8'), /browser-diagnostics|visual\/public/u);
});

test('production summary admits only policy-skipped needs and rejects a skipped selected job', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-1151-summary-plan-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const script = path.join(root, 'tools/ci/summarize-quality-gate.mjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, 'tools/ci/summarize-quality-gate.mjs'), script);
    copySummaryDependencies(root);
    write(path.join(root, '.github/workflows/quality-gate.yml'), 'jobs:\n  required:\n    runs-on: ubuntu-latest\n  conditional:\n    runs-on: ubuntu-latest\n');
    write(path.join(root, 'tools/operations/check-release-evidence-manifest.mjs'), 'process.exit(0)\n');
    writeReceiptGenerator(root);
    write(path.join(root, '.tmp/release-evidence/manifest.json'), {
        status: 'collected-ok',
        evidenceSummary: { externalExposure: { blockers: [], request: { blockerSources: [] } } }
    });
    const { plan } = writePlan(root, { selectedJobIds: ['required'], skippedJobIds: ['conditional'] });

    const admitted = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
        env: summaryEnvironment(plan, { required: { result: 'success' }, conditional: { result: 'skipped' } }, root)
    });
    assert.equal(admitted.status, 0, admitted.stderr || admitted.stdout);

    const rejected = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
        env: summaryEnvironment(plan, { required: { result: 'skipped' }, conditional: { result: 'skipped' } }, root)
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /required: skipped/u);

    const missingNeed = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
        env: summaryEnvironment(plan, { conditional: { result: 'skipped' } }, root)
    });
    assert.equal(missingNeed.status, 1);
    assert.match(missingNeed.stderr, /needs do not exactly match the production-summary authority job projection/u);

    const extraNeed = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
        env: summaryEnvironment(plan, {
            required: { result: 'success' },
            conditional: { result: 'skipped' },
            extra: { result: 'success' }
        }, root)
    });
    assert.equal(extraNeed.status, 1);
    assert.match(extraNeed.stderr, /needs do not exactly match the production-summary authority job projection/u);
});

test('production summary fails closed when the correctness receipt generator is absent', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-1151-summary-generator-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const script = path.join(root, 'tools/ci/summarize-quality-gate.mjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, 'tools/ci/summarize-quality-gate.mjs'), script);
    copySummaryDependencies(root);
    write(path.join(root, '.github/workflows/quality-gate.yml'), 'jobs:\n  required:\n    runs-on: ubuntu-latest\n');
    write(path.join(root, 'tools/operations/check-release-evidence-manifest.mjs'), 'process.exit(0)\n');
    write(path.join(root, '.tmp/release-evidence/manifest.json'), {
        status: 'collected-ok',
        evidenceSummary: { externalExposure: { blockers: [], request: { blockerSources: [] } } }
    });
    const { plan } = writePlan(root);
    const result = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
        env: summaryEnvironment(plan, { required: { result: 'success' } }, root)
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /browserless correctness receipt generator is missing/u);
});

test('release-final checker fails closed and seals exact projection-only domain bindings', () =>
{
    const checker = fs.readFileSync(
        path.join(repositoryRoot, 'tools/release/check-release-final.mjs'),
        'utf8'
    );
    const domainBinding = fs.readFileSync(
        path.join(repositoryRoot, 'tools/release/release-final-domain-evidence.mjs'),
        'utf8'
    );
    const reliabilityBinding = fs.readFileSync(
        path.join(
            repositoryRoot,
            'tools/release/release-reliability-qualified-receipt.mjs'
        ),
        'utf8'
    );
    const source = `${checker}\n${domainBinding}\n${reliabilityBinding}`;
    assert.match(source, /Browser Contract receipt is required; release-final fails closed without it/u);
    assert.match(source, /collectReleaseFinalDomainProjectionReceipts\(\{/u);
    assert.match(source, /expectedTierIds: releaseFinalDomainProjectionTierIds/u);
    assert.match(source, /createReleaseFinalTestEvidenceBinding\(\{/u);
    assert.match(source, /releaseDomainProjectionReceipts/u);
    assert.match(source, /locateReleaseReliabilityQualifiedReceipt\(\{/u);
    assert.match(source, /releaseReliabilityQualifiedReceipt/u);
    assert.match(
        reliabilityBinding,
        /verify-release-reliability-receipt\.mjs/u
    );
    assert.doesNotMatch(checker, /validateReleaseResourceSummary/u);
    assert.doesNotMatch(source, /evidence-producers|release-domain-assertions/u);
    assert.match(checker, /release-final-test-evidence-binding\.json/u);
});
