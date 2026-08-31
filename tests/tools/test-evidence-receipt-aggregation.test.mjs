import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { governanceContentDigest } from '../../tools/test/evidence-location-contract.mjs';
import { packCurrentRunEvidenceTransport } from '../../tools/test/current-run-evidence-transport.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
const buildReceiptDigest = `sha256:${'c'.repeat(64)}`;
const digest = (value) => `sha256:${value.repeat(64)}`;
const stageDurationsMs = Object.freeze({
    setup: 0,
    restore: 0,
    install: 0,
    bootstrap: 0,
    test: 1,
    artifact: 0,
    summary: 0
});

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
    for (const relative of [
        'tools/ci/check-flaky-evidence.mjs',
        'tools/ci/check-job-summaries.mjs',
        'tools/test/current-run-evidence-locator.mjs',
        'tools/test/current-run-evidence-transport.mjs',
        'tools/test/evidence-location-contract.mjs',
        'tools/yaml/workflow-structure.mjs'
    ])
    {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, relative), target);
    }
}

function jobSummary(overrides = {})
{
    return {
        schema: 'fsusblog.ci.job-result.v1',
        jobId: 'required',
        ciJob: 'required',
        status: 'failure',
        tierIds: ['production-correctness'],
        localReproduction: './tools/test.sh production-correctness --plan-only',
        commit: sourceState.commit,
        runId: '42',
        attempt: '1',
        artifacts: ['job.json'],
        durationMs: 1,
        failureStage: 'test',
        rootCause: 'transported-root-cause',
        stageDurationsMs,
        ...overrides
    };
}

function flakyEvidence(overrides = {})
{
    return {
        schema: 'fsusblog.ci.flaky.v1',
        policyVersion: 'fsusblog-flaky-execution-v2',
        suite: 'transported-suite',
        test: 'transported-test',
        testIds: ['transported-test'],
        declaredTestIds: ['transported-test'],
        classification: 'known-flaky',
        evidenceClass: 'correctness',
        sourceEvidenceClass: 'correctness',
        affectsCorrectness: true,
        failureClass: null,
        failureKind: null,
        issue: 3106,
        retryPolicy: { allowedRetries: 0, retryOn: 'never' },
        retryCount: 0,
        finalStatus: 'success',
        attempts: [{
            attempt: 1,
            status: 'success',
            testIds: ['transported-test'],
            failureClass: null,
            failureKind: null,
            artifacts: ['attempt-1/result.json'],
            exitCode: 0,
            signal: null,
            durationMs: 1
        }],
        generatedAt: '2026-08-30T00:00:00.000Z',
        ...overrides
    };
}

function createTransportFixture(root, { job = jobSummary(), flaky = flakyEvidence() } = {})
{
    const jobPath = '.tmp/downloaded-artifacts/quality-gate/job.json';
    const flakyPath = '.tmp/downloaded-artifacts/quality-gate/flaky.json';
    write(path.join(root, jobPath), job);
    write(path.join(root, flakyPath), flaky);
    const contextBody = {
        schema: 'fsusblog.current-run-evidence-context.v1',
        schedulerRunId: 'run-42',
        attemptId: 'attempt-1',
        sourceCommit: sourceState.commit,
        worktreeFingerprint: digest('b'),
        candidateIdentity: { id: 'candidate', digest: digest('d') },
        buildIdentity: { id: 'build', digest: digest('e') },
        ownedRoots: ['.tmp/downloaded-artifacts']
    };
    const context = { ...contextBody, contentDigest: governanceContentDigest(contextBody) };
    const archivePath = '.tmp/downloaded-artifacts/quality-gate/transport-archive.json';
    const manifestPath = '.tmp/downloaded-artifacts/quality-gate/transport-manifest.json';
    packCurrentRunEvidenceTransport({
        context,
        repositoryRoot: root,
        archivePath,
        manifestPath,
        transportRunId: 'transport-42',
        downloadRunId: 'download-42',
        objects: [{
            authorityId: 'evidence-consumer.ci.check-job-summaries.current-run',
            producerId: 'evidence-consumer.ci.check-job-summaries.producer',
            receiptSchema: 'fsusblog.current-run-evidence-reference.v1',
            originalRef: {
                path: jobPath,
                contentDigest: digest('f'),
                producerReceiptDigest: digest('1')
            },
            files: [{ path: jobPath }]
        }, {
            authorityId: 'evidence-consumer.ci.check-flaky-evidence.current-run',
            producerId: 'evidence-consumer.ci.check-flaky-evidence.producer',
            receiptSchema: 'fsusblog.current-run-evidence-reference.v1',
            originalRef: {
                path: flakyPath,
                contentDigest: digest('2'),
                producerReceiptDigest: digest('3')
            },
            files: [{ path: flakyPath }]
        }]
    });
    return { archivePath, flakyPath, jobPath, manifestPath };
}

function rewriteManifest(root, manifestPath, mutate, { reseal = true } = {})
{
    const file = path.join(root, manifestPath);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(manifest);
    if (reseal)
    {
        delete manifest.contentDigest;
        manifest.contentDigest = governanceContentDigest(manifest);
    }
    write(file, manifest);
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
        FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: buildReceiptDigest,
        FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST: ''
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
    write(path.join(root, '.tmp/release-evidence/flaky/diagnostic.json'), flakyEvidence({
        suite: 'browser-diagnostics',
        test: 'visual/public',
        testIds: ['visual/public'],
        declaredTestIds: ['visual/public'],
        classification: 'infra-transient',
        evidenceClass: 'diagnostic',
        sourceEvidenceClass: 'diagnostic',
        affectsCorrectness: false,
        failureClass: 'infra',
        failureKind: 'browser-process-crash',
        retryPolicy: { allowedRetries: 1, retryOn: 'browser-process-crash' },
        retryCount: 1,
        finalStatus: 'diagnostic-passed-after-infra-retry',
        attempts: [{
            attempt: 1,
            status: 'failure',
            testIds: ['visual/public'],
            failureClass: 'infra',
            failureKind: 'browser-process-crash',
            artifacts: ['attempt-1/stderr.log'],
            exitCode: 1,
            signal: null,
            durationMs: 1
        }, {
            attempt: 2,
            status: 'success',
            testIds: ['visual/public'],
            failureClass: null,
            failureKind: null,
            artifacts: ['attempt-2/result.json'],
            exitCode: 0,
            signal: null,
            durationMs: 1
        }]
    }));
    write(path.join(root, '.tmp/release-evidence/flaky/correctness.json'), flakyEvidence({
        suite: 'backend-unit',
        test: 'lease-isolation',
        testIds: ['lease-isolation'],
        declaredTestIds: ['lease-isolation'],
        attempts: [{
            attempt: 1,
            status: 'success',
            testIds: ['lease-isolation'],
            failureClass: null,
            failureKind: null,
            artifacts: ['attempt-1/result.json'],
            exitCode: 0,
            signal: null,
            durationMs: 1
        }]
    }));

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
    assert.deepEqual(summary.flaky.passedAfterRetry, []);
    assert.match(summary.contentDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.doesNotMatch(fs.readFileSync(stepSummary, 'utf8'), /browser-diagnostics|visual\/public/u);
});

test('production summary reads job and flaky evidence from the bound transport manifest', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-3106-summary-transport-'));
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
    write(path.join(root, '.tmp/release-evidence/jobs/directory-only.json'), {
        schema: 'fsusblog.ci.job-result.v1',
        jobId: 'required',
        rootCause: 'directory-only-root-cause'
    });
    write(path.join(root, '.tmp/release-evidence/flaky/directory-only.json'), {
        schema: 'fsusblog.ci.flaky.v1',
        suite: 'directory-only',
        test: 'must-not-be-consumed',
        evidenceClass: 'correctness',
        finalStatus: 'passed-after-retry',
        classification: 'infra',
        retryCount: 1
    });

    const transport = createTransportFixture(root);
    const { plan } = writePlan(root);
    const stepSummary = path.join(root, '.tmp/step-summary.md');
    const result = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...summaryEnvironment(plan, { required: { result: 'failure' } }, root),
            FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST: path.join(root, transport.manifestPath),
            GITHUB_STEP_SUMMARY: stepSummary
        }
    });

    assert.equal(result.status, 1);
    const rendered = fs.readFileSync(stepSummary, 'utf8');
    assert.match(rendered, /transported-root-cause/u);
    assert.doesNotMatch(rendered, /directory-only-root-cause/u);
    const summary = JSON.parse(fs.readFileSync(path.join(root, '.tmp/release-evidence/jobs/production-summary.json'), 'utf8'));
    assert.deepEqual(summary.flaky.passedAfterRetry, []);
});

test('production summary rejects unsealed ambiguous or partial transport evidence', async (context) =>
{
    const partialJob = jobSummary();
    delete partialJob.tierIds;
    const partialFlaky = flakyEvidence();
    delete partialFlaky.attempts;
    const cases = [{
        name: 'malformed manifest JSON',
        mutate(root, transport)
        {
            write(path.join(root, transport.manifestPath), '{not-json');
        },
        expected: /JSON|Unexpected token/u
    }, {
        name: 'manifest schema mismatch',
        mutate(root, transport)
        {
            rewriteManifest(root, transport.manifestPath, (manifest) =>
            {
                manifest.schema = 'wrong.transport.v1';
            });
        },
        expected: /transport manifest schema mismatch/u
    }, {
        name: 'manifest content digest mismatch',
        mutate(root, transport)
        {
            rewriteManifest(root, transport.manifestPath, (manifest) =>
            {
                manifest.transportRunId = 'tampered-run';
            }, { reseal: false });
        },
        expected: /transport manifest contentDigest mismatch/u
    }, {
        name: 'archive digest mismatch',
        mutate(root, transport)
        {
            fs.appendFileSync(path.join(root, transport.archivePath), 'tampered');
        },
        expected: /transport archive digest mismatch/u
    }, {
        name: 'archive content digest mismatch with a resealed manifest',
        mutate(root, transport)
        {
            const archiveFile = path.join(root, transport.archivePath);
            const archive = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
            archive.tampered = true;
            const bytes = Buffer.from(`${JSON.stringify(archive, null, 2)}\n`);
            fs.writeFileSync(archiveFile, bytes);
            rewriteManifest(root, transport.manifestPath, (manifest) =>
            {
                manifest.archive.digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
            });
        },
        expected: /transport archive contentDigest mismatch/u
    }, {
        name: 'archive schema mismatch with a resealed outer digest',
        mutate(root, transport)
        {
            const archiveFile = path.join(root, transport.archivePath);
            const archive = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
            archive.schema = 'wrong.archive.v1';
            delete archive.contentDigest;
            archive.contentDigest = governanceContentDigest(archive);
            const bytes = Buffer.from(`${JSON.stringify(archive, null, 2)}\n`);
            fs.writeFileSync(archiveFile, bytes);
            rewriteManifest(root, transport.manifestPath, (manifest) =>
            {
                manifest.archive.digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
            });
        },
        expected: /transport archive schema mismatch/u
    }, {
        name: 'archive traversal path',
        mutate(root, transport)
        {
            rewriteManifest(root, transport.manifestPath, (manifest) =>
            {
                manifest.archive.path = '../transport-archive.json';
            });
        },
        expected: /archive\.path is not a safe repository-relative path/u
    }, {
        name: 'missing authority mapping',
        mutate(root, transport)
        {
            rewriteManifest(root, transport.manifestPath, (manifest) =>
            {
                manifest.objects = manifest.objects.filter((object) =>
                    object.authorityId !== 'evidence-consumer.ci.check-flaky-evidence.current-run');
            });
        },
        expected: /transport archive entries must have exact object mappings/u
    }, {
        name: 'duplicate authority mapping',
        mutate(root, transport)
        {
            rewriteManifest(root, transport.manifestPath, (manifest) =>
            {
                manifest.objects.push({ ...manifest.objects[0] });
            });
        },
        expected: /duplicate transport mapping/u
    }, {
        name: 'mapped entry digest mismatch',
        mutate(root, transport)
        {
            rewriteManifest(root, transport.manifestPath, (manifest) =>
            {
                manifest.objects[0].archiveEntries[0].digest = digest('9');
            });
        },
        expected: /object archive entry digest mismatch/u
    }, {
        name: 'object content digest binding mismatch',
        mutate(root, transport)
        {
            rewriteManifest(root, transport.manifestPath, (manifest) =>
            {
                manifest.objects[0].contentDigest = digest('4');
            });
        },
        expected: /transport object contentDigest binding mismatch/u
    }, {
        name: 'original ref input digest binding mismatch',
        mutate(root, transport)
        {
            rewriteManifest(root, transport.manifestPath, (manifest) =>
            {
                manifest.objects[0].originalRef.inputDigest = digest('5');
            });
        },
        expected: /transport original ref digest binding mismatch/u
    }, {
        name: 'traversal extracted path',
        mutate(root, transport)
        {
            rewriteManifest(root, transport.manifestPath, (manifest) =>
            {
                manifest.objects[0].archiveEntries[0].extractedPath = '../escape.json';
            });
        },
        expected: /not a safe repository-relative path/u
    }, {
        name: 'absolute extracted path',
        mutate(root, transport)
        {
            rewriteManifest(root, transport.manifestPath, (manifest) =>
            {
                manifest.objects[0].archiveEntries[0].extractedPath = path.join(root, transport.jobPath);
            });
        },
        expected: /not a safe repository-relative path/u
    }, {
        name: 'Windows absolute extracted path',
        mutate(root, transport)
        {
            rewriteManifest(root, transport.manifestPath, (manifest) =>
            {
                manifest.objects[0].archiveEntries[0].extractedPath = 'C:\\escape.json';
            });
        },
        expected: /not a safe repository-relative path/u
    }, {
        name: 'symlinked transported payload',
        mutate(root, transport)
        {
            const file = path.join(root, transport.jobPath);
            const target = `${file}.target`;
            fs.renameSync(file, target);
            fs.symlinkSync(target, file);
        },
        expected: /must not traverse a symlink/u
    }, {
        name: 'symlinked transport manifest',
        mutate(root, transport)
        {
            const file = path.join(root, transport.manifestPath);
            const target = `${file}.target`;
            fs.renameSync(file, target);
            fs.symlinkSync(target, file);
        },
        expected: /transport manifest must not traverse a symlink/u
    }, {
        name: 'tampered transported payload',
        mutate(root, transport)
        {
            fs.appendFileSync(path.join(root, transport.jobPath), 'tampered');
        },
        expected: /transported evidence digest mismatch/u
    }, {
        name: 'partial job summary payload',
        fixture: { job: partialJob },
        expected: /job summary payload is invalid:.*tierIds/u
    }, {
        name: 'partial flaky evidence payload',
        fixture: { flaky: partialFlaky },
        expected: /flaky evidence payload is invalid:.*attempts/u
    }, {
        name: 'unsupported transported job schema',
        fixture: { job: { schema: 'wrong.job.v1' } },
        expected: /job evidence payload is invalid:.*unsupported evidence schema/u
    }, {
        name: 'unsupported transported flaky schema',
        fixture: { flaky: { schema: 'wrong.flaky.v1' } },
        expected: /flaky evidence payload is invalid:.*schema must be fsusblog\.ci\.flaky\.v1/u
    }, {
        name: 'malformed transported job payload',
        fixture: { job: '{not-json' },
        expected: /JSON|Unexpected token/u
    }];

    for (const scenario of cases)
    {
        await context.test(scenario.name, (subtest) =>
        {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-3106-summary-negative-'));
            subtest.after(() => fs.rmSync(root, { recursive: true, force: true }));
            const script = path.join(root, 'tools/ci/summarize-quality-gate.mjs');
            fs.mkdirSync(path.dirname(script), { recursive: true });
            fs.copyFileSync(path.join(repositoryRoot, 'tools/ci/summarize-quality-gate.mjs'), script);
            copySummaryDependencies(root);
            write(path.join(root, '.github/workflows/quality-gate.yml'),
                'jobs:\n  required:\n    runs-on: ubuntu-latest\n');
            write(path.join(root, 'tools/operations/check-release-evidence-manifest.mjs'),
                'process.exit(0)\n');
            write(path.join(root, '.tmp/release-evidence/manifest.json'), {
                status: 'collected-ok',
                evidenceSummary: { externalExposure: { blockers: [], request: { blockerSources: [] } } }
            });
            const { plan } = writePlan(root);
            const transport = createTransportFixture(root, scenario.fixture);
            scenario.mutate?.(root, transport);
            const result = spawnSync(process.execPath, [script], {
                cwd: root,
                encoding: 'utf8',
                env: {
                    ...summaryEnvironment(plan, { required: { result: 'failure' } }, root),
                    FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST: path.join(root, transport.manifestPath)
                }
            });
            assert.equal(result.status, 1);
            assert.match(result.stderr, scenario.expected);
        });
    }
});

test('production summary rejects downloaded artifacts without a transport manifest', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-3106-summary-unbound-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const script = path.join(root, 'tools/ci/summarize-quality-gate.mjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, 'tools/ci/summarize-quality-gate.mjs'), script);
    copySummaryDependencies(root);
    write(path.join(root, '.github/workflows/quality-gate.yml'),
        'jobs:\n  required:\n    runs-on: ubuntu-latest\n');
    write(path.join(root, '.tmp/downloaded-artifacts/unbound/job.json'), jobSummary());
    const { plan } = writePlan(root);
    const result = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
        env: summaryEnvironment(plan, { required: { result: 'failure' } }, root)
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /downloaded artifacts exist without a transport manifest/u);
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
