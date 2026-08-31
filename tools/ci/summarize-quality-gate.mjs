#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseWorkflowJobNeeds } from '../yaml/workflow-structure.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const workflowPath = path.join(root, '.github/workflows/quality-gate.yml');

// Explicit run-bound locator context for every production summary consumer.
// Consumers must never discover files by scanning; the root and each named
// input come from the environment or the workflow invocation.
function explicitEvidenceRoot()
{
    const configured = process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR;
    if (!configured)
    {
        throw new Error('production summary requires an explicit release-evidence locator root: FSUSBLOG_RELEASE_EVIDENCE_DIR');
    }
    return path.resolve(root, configured);
}

// Flat, non-recursive read of an explicitly bound JSON directory. No cross-run
// discovery, no first-match selection, no downloaded-artifact fallback.
function readExplicitDirectoryJson(directory)
{
    if (!fs.existsSync(directory))
    {
        return [];
    }
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
    {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json'))
        {
            continue;
        }
        const file = path.join(directory, entry.name);
        try
        {
            files.push({ file, text: fs.readFileSync(file, 'utf8'), value: JSON.parse(fs.readFileSync(file, 'utf8')) });
        }
        catch
        {
            // Ignore unrelated or malformed JSON inside the explicitly bound directory.
        }
    }
    return files;
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

function contentDigest(value)
{
    const { contentDigest: _ignored, ...content } = value;
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex')}`;
}

function normalizeFingerprint(value)
{
    return String(value ?? '').trim().replace(/^sha256:/u, '');
}

function loadPrSmartGatePlan()
{
    const configured = process.env.FSUSBLOG_CI_PR_SMART_GATE_PLAN;
    if (!configured)
    {
        throw new Error('PR smart gate plan locator is required: FSUSBLOG_CI_PR_SMART_GATE_PLAN must name the explicit plan file');
    }
    const file = path.resolve(root, configured);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    {
        throw new Error(`PR smart gate plan file is missing: ${configured}`);
    }
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (plan.schema !== 'fsusblog.pr-smart-gate.v1')
    {
        throw new Error(`PR smart gate plan schema mismatch: ${plan.schema ?? 'missing'}`);
    }
    if (plan.contentDigest !== contentDigest(plan))
    {
        throw new Error('PR smart gate plan content digest mismatch');
    }
    for (const field of ['selectedTierIds', 'skippedTierIds', 'selectedJobIds', 'skippedJobIds', 'summaryAuthorityJobIds'])
    {
        const values = plan[field];
        const normalized = [...new Set((values ?? []).map(String))].sort();
        if (!Array.isArray(values) || JSON.stringify(values) !== JSON.stringify(normalized))
        {
            throw new Error(`PR smart gate plan ${field} must be sorted and unique`);
        }
    }
    const expectedCommit = String(process.env.GITHUB_SHA ?? '').trim();
    const expectedFingerprint = String(process.env.FSUSBLOG_CI_PRODUCTION_SOURCE_FINGERPRINT ?? '').trim();
    const expectedRunId = String(process.env.GITHUB_RUN_ID ?? '').trim();
    const expectedAttempt = String(process.env.GITHUB_RUN_ATTEMPT ?? '').trim();
    if (!expectedCommit || !expectedFingerprint || !expectedRunId || !expectedAttempt)
    {
        throw new Error('quality gate summary requires current plan source and run identity');
    }
    if (plan.sourceState?.commit !== expectedCommit
    || normalizeFingerprint(plan.sourceState?.worktreeFingerprint) !== normalizeFingerprint(expectedFingerprint))
    {
        throw new Error('PR smart gate plan source identity is stale');
    }
    if (String(plan.runId) !== expectedRunId || String(plan.runAttempt) !== expectedAttempt)
    {
        throw new Error('PR smart gate plan run identity is stale');
    }
    const expectedDigest = String(process.env.FSUSBLOG_CI_PR_PLAN_DIGEST ?? '').trim();
    if (expectedDigest && plan.contentDigest !== expectedDigest)
    {
        throw new Error('PR smart gate plan digest does not match producer output');
    }
    return { file, plan };
}

function classifyNeedsByPlan(needs, plan)
{
    const needsJobIds = Object.keys(needs).sort();
    if (JSON.stringify(needsJobIds) !== JSON.stringify(plan.summaryAuthorityJobIds))
    {
        throw new Error('quality gate needs do not exactly match the production-summary authority job projection');
    }
    const selected = new Set(plan.selectedJobIds);
    const skipped = new Set(plan.skippedJobIds);
    const nonSuccess = [];
    const policyErrors = [];
    for (const [name, value] of Object.entries(needs))
    {
        if (selected.has(name))
        {
            if (value?.result !== 'success')
            {
                nonSuccess.push([name, value]);
            }
            continue;
        }
        if (skipped.has(name))
        {
            if (value?.result !== 'skipped')
            {
                policyErrors.push(`policy-skipped job ${name} unexpectedly ran with ${value?.result ?? 'missing'}`);
            }
            continue;
        }
        policyErrors.push(`job ${name} is not declared by the PR smart gate plan`);
    }
    if (policyErrors.length > 0)
    {
        throw new Error(`quality gate needs do not match the PR smart gate plan: ${policyErrors.join('; ')}`);
    }
    return nonSuccess.sort(([left], [right]) => left.localeCompare(right));
}

function readTransportOrDirectoryJson(directory, authorityId)
{
    const transport = String(process.env.FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST ?? '').trim();
    if (transport)
    {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(root, transport), 'utf8'));
        const mapped = (manifest.objects ?? []).filter((object) => object.authorityId === authorityId);
        const files = mapped.flatMap((object) => object.archiveEntries ?? [])
            .map((entry) => path.resolve(root, entry.extractedPath));
        return files.flatMap((file) =>
        {
            try
            {
                return [{ file, text: fs.readFileSync(file, 'utf8'), value: JSON.parse(fs.readFileSync(file, 'utf8')) }];
            }
            catch
            {
                return [];
            }
        });
    }
    return readExplicitDirectoryJson(directory);
}

function loadJobSummaries()
{
    const jobsDir = path.join(explicitEvidenceRoot(), 'jobs');
    const summaries = new Map();
    for (const { file, text, value: summary } of readTransportOrDirectoryJson(jobsDir,
        'evidence-consumer.ci.check-job-summaries.current-run'))
    {
        if (summary.schema !== 'fsusblog.ci.job-result.v1')
        {
            continue;
        }
        const digest = `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
        for (const key of [summary.jobId, summary.ciJob])
        {
            if (!key)
            {
                continue;
            }
            const existing = summaries.get(key);
            if (existing)
            {
                if (existing.digest !== digest)
                {
                    throw new Error(`conflicting ${key} job summaries inside the bound release-evidence root: ${existing.file} and ${file}`);
                }
                continue;
            }
            summaries.set(key, { summary, file, digest });
        }
    }
    return summaries;
}

function loadFlakyEvidence()
{
    const flakyDir = path.join(explicitEvidenceRoot(), 'flaky');
    const evidence = [];
    for (const { file, value: item } of readTransportOrDirectoryJson(flakyDir,
        'evidence-consumer.ci.check-flaky-evidence.current-run'))
    {
    {
        if (item.schema !== 'fsusblog.ci.flaky.v1')
        {
            continue;
        }
        evidence.push({ item, file });
    }
    return evidence.sort((left, right) => `${left.item.suite}:${left.item.test}`.localeCompare(`${right.item.suite}:${right.item.test}`));
}

function isCorrectnessFlakyEvidence(item)
{
    if (item?.affectsCorrectness === false)
    {
        return false;
    }
    if (item?.evidenceClass === 'diagnostic' || item?.evidenceClass === 'browser-contract')
    {
        return false;
    }
    if (item?.evidenceClass === 'infra-failure')
    {
        return item?.sourceEvidenceClass === 'correctness';
    }
    return item?.evidenceClass === undefined || item?.evidenceClass === 'correctness';
}

function explicitReleaseManifest()
{
    const configured = process.env.FSUSBLOG_RELEASE_EVIDENCE_MANIFEST;
    if (!configured)
    {
        throw new Error('release manifest locator is required: FSUSBLOG_RELEASE_EVIDENCE_MANIFEST must name the explicit manifest file');
    }
    const file = path.resolve(root, configured);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    {
        throw new Error(`release manifest file is missing: ${configured}`);
    }
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!manifest.status || !manifest.evidenceSummary)
    {
        throw new Error(`release manifest is not a release-evidence manifest: ${configured}`);
    }
    return { file, manifest };
}

function evidenceBlockers(manifest)
{
    const blockers = [];
    if (manifest.status !== 'collected-ok')
    {
        blockers.push(`manifest.status=${manifest.status}`);
    }
    for (const item of manifest.evidenceSummary?.externalExposure?.blockers ?? [])
    {
        blockers.push(typeof item === 'string' ? item : JSON.stringify(item));
    }
    for (const source of manifest.evidenceSummary?.externalExposure?.request?.blockerSources ?? [])
    {
        blockers.push(`externalExposure:${source}`);
    }
    for (const [area, summary] of Object.entries(manifest.evidenceSummary ?? {}))
    {
        if (!summary || typeof summary !== 'object')
        {
            continue;
        }
        for (const [key, value] of Object.entries(summary))
        {
            if (typeof value === 'string' && !['ok', 'present'].includes(value))
            {
                blockers.push(`${area}.${key}=${value}`);
            }
            else if (value && typeof value === 'object' && typeof value.status === 'string' && !['ok', 'present'].includes(value.status))
            {
                blockers.push(`${area}.${key}.status=${value.status}`);
            }
        }
    }
    return [...new Set(blockers)].sort();
}

function inspectReleaseManifest({ requireOk })
{
    let candidate;
    try
    {
        candidate = explicitReleaseManifest();
    }
    catch (error)
    {
        return {
            ok: false,
            file: null,
            status: 'missing',
            blockers: ['release manifest missing'],
            errors: [`release manifest missing: ${error.message}`]
        };
    }

    const args = ['tools/operations/check-release-evidence-manifest.mjs'];
    if (requireOk)
    {
        args.push('--require-ok');
    }
    args.push(candidate.file);
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
    const errors = (result.stderr || result.stdout || '')
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);

    return {
        ok: result.status === 0,
        file: path.relative(root, candidate.file).replaceAll(path.sep, '/'),
        status: candidate.manifest.status,
        blockers: evidenceBlockers(candidate.manifest),
        errors
    };
}

function dependencyDepth(job, workflowNeeds, seen = new Set())
{
    if (seen.has(job))
    {
        return 0;
    }
    seen.add(job);
    const needs = workflowNeeds.get(job) ?? new Set();
    if (needs.size === 0)
    {
        return 0;
    }
    return 1 + Math.max(...[...needs].map((need) => dependencyDepth(need, workflowNeeds, new Set(seen))));
}

function formatJob(name, value)
{
    return `${name}: ${value.result}`;
}

function rootFailureLines(item, jobSummaries)
{
    const lines = [`- ${formatJob(item.name, item.value)}`];
    const match = jobSummaries.get(item.name);
    if (!match)
    {
        return lines;
    }
    const rel = path.relative(root, match.file).replaceAll(path.sep, '/');
    if (match.summary.groupDurationsMs && typeof match.summary.groupDurationsMs === 'object')
    {
        const groups = Object.entries(match.summary.groupDurationsMs)
            .map(([group, duration]) => `${group}=${duration}ms`)
            .join(', ');
        if (groups)
        {
            lines.push(`  groups: ${groups}`);
        }
    }
    if (match.summary.failureStage)
    {
        lines.push(`  failureStage: ${match.summary.failureStage}`);
    }
    if (match.summary.rootCause)
    {
        lines.push(`  rootCause: ${match.summary.rootCause}`);
    }
    if (match.summary.localReproduction)
    {
        lines.push(`  reproduce: ${match.summary.localReproduction}`);
    }
    lines.push(`  artifact: ${rel}`);
    return lines;
}

function writeStepSummary(lines)
{
    if (!process.env.GITHUB_STEP_SUMMARY)
    {
        return;
    }
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

function writeBrowserlessCorrectnessReceipt(planFile)
{
    const generator = path.join(root, 'tools/release/test-evidence-receipts-cli.mjs');
    if (!fs.existsSync(generator))
    {
        throw new Error('browserless correctness receipt generator is missing');
    }
    const result = spawnSync(process.execPath, [generator, 'create-correctness'], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_CORRECTNESS_SUMMARY_AUTHORITY: 'passed',
            FSUSBLOG_CI_PR_SMART_GATE_PLAN: planFile
        }
    });
    if (result.status !== 0)
    {
        throw new Error((result.stderr || result.stdout || 'browserless correctness receipt generation failed').trim());
    }
    return '.tmp/release-evidence/browserless-correctness-receipt.json';
}

function writeProductionSummary(status, rootFailures = [], rootCause = null, flakyEvidence = [], releaseEvidence = null)
{
    const outFile = path.join(root, '.tmp/release-evidence/jobs/production-summary.json');
    fs.rmSync(path.join(root, '.tmp/release-evidence/browserless-correctness-receipt.json'), { force: true });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const stageDurationsMs = {
        setup: 0,
        restore: 0,
        install: 0,
        bootstrap: 0,
        test: 0,
        artifact: 0,
        summary: 0
    };
    const summary = {
        schema: 'fsusblog.ci.job-result.v1',
        jobId: 'production-summary',
        ciJob: 'production-summary',
        tierIds: ['production-correctness'],
        evidenceClass: 'correctness',
        affectsCorrectness: true,
        status,
        failureStage: status === 'success' ? null : 'summary',
        rootCause: status === 'success' ? null : (rootCause ?? rootFailures.map((item) => `${item.name}:${item.value.result}`).join(', ')),
        durationMs: 0,
        stageDurationsMs,
        flaky: {
            passedAfterRetry: flakyEvidence
                .filter(({ item }) => item.finalStatus === 'passed-after-retry')
                .map(({ item }) => ({
                    suite: item.suite,
                    test: item.test,
                    classification: item.classification,
                    retryCount: item.retryCount,
                    issue: item.issue
                }))
        },
        releaseEvidence,
        artifacts: [
            '.tmp/release-evidence/jobs/production-summary.json',
            ...(status === 'success' ? ['.tmp/release-evidence/browserless-correctness-receipt.json'] : [])
        ],
        localReproduction: './tools/test.sh production-correctness --plan-only',
        commit: process.env.GITHUB_SHA ?? 'unknown',
        sourceState: {
            commit: process.env.GITHUB_SHA ?? 'unknown',
            worktreeFingerprint: process.env.FSUSBLOG_CI_PRODUCTION_SOURCE_FINGERPRINT ?? null
        },
        buildReceiptDigest: process.env.FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST ?? null,
        prSmartGatePlanDigest: process.env.FSUSBLOG_CI_PR_PLAN_DIGEST ?? null,
        runId: process.env.GITHUB_RUN_ID ?? 'local',
        attempt: process.env.GITHUB_RUN_ATTEMPT ?? '0',
        generatedAt: new Date().toISOString(),
        contentDigest: null
    };
    summary.contentDigest = contentDigest(summary);
    fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
}

function main()
{
    const rawNeeds = process.env.QUALITY_GATE_NEEDS_JSON;
    if (!rawNeeds)
    {
        throw new Error('missing QUALITY_GATE_NEEDS_JSON; pass GitHub Actions needs JSON to the summary step');
    }

    const needs = JSON.parse(rawNeeds);
    const { file: planFile, plan } = loadPrSmartGatePlan();
    const workflowNeeds = parseWorkflowJobNeeds(fs.readFileSync(workflowPath, 'utf8'), {
        source: '.github/workflows/quality-gate.yml'
    });
    const jobSummaries = loadJobSummaries();
    const flakyEvidence = loadFlakyEvidence()
        .filter(({ item }) => isCorrectnessFlakyEvidence(item));
    const releaseMode = process.env.FSUSBLOG_PRODUCTION_SUMMARY_REQUIRE_RELEASE_OK === '1';
    const releaseEvidence = inspectReleaseManifest({ requireOk: releaseMode });
    const passedAfterRetry = flakyEvidence.filter(({ item }) => item.finalStatus === 'passed-after-retry');
    const nonSuccess = classifyNeedsByPlan(needs, plan);

    if (nonSuccess.length === 0 && releaseEvidence.ok)
    {
        writeProductionSummary('success', [], null, flakyEvidence, releaseEvidence);
        writeBrowserlessCorrectnessReceipt(planFile);
        console.log('production summary ok');
        const lines = ['## Quality Gate', '', 'All required jobs completed successfully.'];
        lines.push('', '### Release Evidence', `- manifest: ${releaseEvidence.status}`, `- artifact: ${releaseEvidence.file}`);
        if (releaseEvidence.blockers.length > 0)
        {
            lines.push('- blockers:');
            for (const blocker of releaseEvidence.blockers.slice(0, 20))
            {
                lines.push(`  - ${blocker}`);
            }
        }
        if (passedAfterRetry.length > 0)
        {
            lines.push('', '### Passed After Retry');
            for (const { item } of passedAfterRetry)
            {
                lines.push(`- ${item.suite}: ${item.test ?? 'suite'} (${item.classification}, retries=${item.retryCount})`);
            }
        }
        writeStepSummary(lines);
        return;
    }

    if (nonSuccess.length === 0 && !releaseEvidence.ok)
    {
        const lines = [
            '## Quality Gate',
            '',
            '### Release Evidence Failure',
            `- manifest: ${releaseEvidence.status}`,
            `- artifact: ${releaseEvidence.file ?? 'missing'}`
        ];
        for (const error of releaseEvidence.errors.slice(0, 20))
        {
            lines.push(`- ${error}`);
        }
        if (releaseEvidence.blockers.length > 0)
        {
            lines.push('', '### Evidence Blockers');
            for (const blocker of releaseEvidence.blockers.slice(0, 20))
            {
                lines.push(`- ${blocker}`);
            }
        }
        for (const line of lines.filter(Boolean))
        {
            console.error(line.replace(/^### /, '').replace(/^## /, ''));
        }
        writeStepSummary(lines);
        writeProductionSummary('failure', [], releaseEvidence.errors.join('; ') || 'release evidence failed', flakyEvidence, releaseEvidence);
        process.exit(1);
    }

    const rootFailures = [];
    const downstreamFanout = [];
    for (const [name, value] of nonSuccess)
    {
        const upstreamFailures = [...(workflowNeeds.get(name) ?? new Set())]
            .filter((need) => needs[need]?.result && needs[need].result !== 'success')
            .sort();

        if (upstreamFailures.length === 0)
        {
            rootFailures.push({ name, value, depth: dependencyDepth(name, workflowNeeds) });
        }
        else
        {
            downstreamFanout.push({ name, value, upstreamFailures });
        }
    }

    rootFailures.sort((left, right) => left.depth - right.depth || left.name.localeCompare(right.name));
    downstreamFanout.sort((left, right) => left.name.localeCompare(right.name));

    const lines = ['## Quality Gate', ''];
    if (rootFailures.length > 0)
    {
        lines.push('### Earliest root non-success jobs');
        for (const item of rootFailures)
        {
            lines.push(...rootFailureLines(item, jobSummaries));
        }
        lines.push('');
    }
    if (passedAfterRetry.length > 0)
    {
        lines.push('### Passed After Retry');
        for (const { item } of passedAfterRetry)
        {
            lines.push(`- ${item.suite}: ${item.test ?? 'suite'} (${item.classification}, retries=${item.retryCount})`);
        }
        lines.push('');
    }
    if (downstreamFanout.length > 0)
    {
        lines.push('### Downstream fan-out');
        for (const item of downstreamFanout)
        {
            const upstream = item.upstreamFailures.map((name) => `${name}:${needs[name].result}`).join(', ');
            lines.push(`- ${formatJob(item.name, item.value)} (upstream: ${upstream})`);
        }
        lines.push('');
    }

    for (const line of lines.filter(Boolean))
    {
        console.error(line.replace(/^### /, '').replace(/^## /, ''));
    }
    writeStepSummary(lines);
    writeProductionSummary('failure', rootFailures, null, flakyEvidence, releaseEvidence);
    process.exit(1);
}

try
{
    main();
}
catch (error)
{
    writeProductionSummary('failure', [], error.message, []);
    console.error(`[quality-gate-summary] ${error.message}`);
    process.exit(1);
}
