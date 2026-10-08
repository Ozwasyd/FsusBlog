#!/usr/bin/env node
/* eslint-disable import-x/no-relative-parent-imports */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readEvidenceDocument } from '../test-matrix/content-addressed-evidence-store.mjs';
import { parseMatrix } from '../test-matrix/parse-matrix.mjs';
import { readCurrentSchedulerCorrectness } from '../test-matrix/scheduler-correctness-finalizer.mjs';
import { readCanonicalSchedulerCheckpoint } from '../test-matrix/scheduler.mjs';

import { requireCleanAttemptConsumerAdmission } from './browser-release-clean-attempt-consumers.mjs';
import { createCorrectnessProvisionalReceipt } from './correctness-provisional-receipt.mjs';
import { correctnessAggregateAuthorityLevel } from './correctness-scheduler-authority.mjs';
import {
    browserlessCorrectnessReceiptSchema,
    createBrowserlessCorrectnessReceipt,
    productionCorrectnessTierClosure,
    validateBrowserContractReceipt,
    validateBrowserDiagnosticsReceipt,
    validateBrowserlessCorrectnessReceipt,
    writeJsonAtomic
} from './test-evidence-receipts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultOutput = path.join(root, '.tmp/release-evidence/browserless-correctness-receipt.json');

function parseArguments(argv)
{
    const options = { command: argv[0] ?? '', file: null, output: defaultOutput, buildReceipt: null, prPlan: null };
    for (let index = 1; index < argv.length; index += 1)
    {
        const value = argv[index];
        if (value === '--out')
        {
            options.output = path.resolve(root, argv[++index]);
        }
        else if (value === '--build-receipt')
        {
            options.buildReceipt = path.resolve(root, argv[++index]);
        }
        else if (value === '--pr-plan')
        {
            options.prPlan = path.resolve(root, argv[++index]);
        }
        else if (!value.startsWith('--') && !options.file)
        {
            options.file = path.resolve(root, value);
        }
        else
        {
            throw new Error(`unknown test evidence receipt argument: ${value}`);
        }
    }
    return options;
}

function walkJsonFiles(directory, results = [])
{
    if (!fs.existsSync(directory))
    {
        return results;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
    {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            walkJsonFiles(file, results);
        }
        else if (entry.isFile() && entry.name.endsWith('.json'))
        {
            results.push(file);
        }
    }
    return results;
}

function transportedJsonFiles()
{
    const configured = String(process.env.FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST ?? '').trim();
    if (!configured)
    {
        return [];
    }
    const manifest = readJson(path.resolve(root, configured));
    return (manifest.objects ?? [])
        .flatMap((object) => object.archiveEntries ?? [])
        .map((entry) => path.resolve(root, entry.extractedPath));
}

function readJson(file)
{
    return readEvidenceDocument(file);
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

function digestValue(value)
{
    const { contentDigest: _ignored, ...content } = value;
    void _ignored;
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex')}`;
}

function normalizeFingerprint(value)
{
    return String(value ?? '').trim().replace(/^sha256:/u, '');
}

function sortedUnique(values)
{
    return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))].sort();
}

function validateSortedUnique(values, label)
{
    if (!Array.isArray(values))
    {
        throw new Error(`${label} must be an array`);
    }
    if (JSON.stringify(values) !== JSON.stringify(sortedUnique(values)))
    {
        throw new Error(`${label} must be sorted and unique`);
    }
}

function sameSourceState(left, right)
{
    return left?.commit === right?.commit
    && normalizeFingerprint(left?.worktreeFingerprint) === normalizeFingerprint(right?.worktreeFingerprint);
}

void sameSourceState;

export function validatePrSmartGatePlan(plan, env = process.env, buildReceiptDigest = null)
{
    if (plan?.schema !== 'fsusblog.pr-smart-gate.v1')
    {
        throw new Error(`unexpected PR smart gate plan schema: ${plan?.schema ?? 'missing'}`);
    }
    if (plan.contentDigest !== digestValue(plan))
    {
        throw new Error('PR smart gate plan content digest mismatch');
    }
    if (!/^[a-f0-9]{40}$/u.test(String(plan.sourceState?.commit ?? '')))
    {
        throw new Error('PR smart gate plan source commit is invalid');
    }
    if (!/^[a-f0-9]{64}$/u.test(normalizeFingerprint(plan.sourceState?.worktreeFingerprint)))
    {
        throw new Error('PR smart gate plan source fingerprint is invalid');
    }
    for (const field of ['selectedTierIds', 'skippedTierIds', 'selectedJobIds', 'skippedJobIds', 'summaryAuthorityJobIds'])
    {
        validateSortedUnique(plan[field], `PR smart gate plan ${field}`);
    }
    const tierOverlap = plan.selectedTierIds.filter((id) => plan.skippedTierIds.includes(id));
    if (tierOverlap.length > 0)
    {
        throw new Error(`PR smart gate plan selected/skipped tiers overlap: ${tierOverlap.join(', ')}`);
    }
    const jobOverlap = plan.selectedJobIds.filter((id) => plan.skippedJobIds.includes(id));
    if (jobOverlap.length > 0)
    {
        throw new Error(`PR smart gate plan selected/skipped jobs overlap: ${jobOverlap.join(', ')}`);
    }
    if (!plan.selectedTierIds.includes('production-correctness'))
    {
        throw new Error('PR smart gate plan must select production-correctness');
    }
    if (plan.selectedJobs && JSON.stringify(plan.selectedJobs) !== JSON.stringify(plan.selectedJobIds))
    {
        throw new Error('PR smart gate plan selectedJobs alias mismatch');
    }
    if (plan.skippedJobs && JSON.stringify(plan.skippedJobs) !== JSON.stringify(plan.skippedJobIds))
    {
        throw new Error('PR smart gate plan skippedJobs alias mismatch');
    }

    const expectedCommit = String(env.GITHUB_SHA ?? env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim();
    const expectedFingerprint = String(env.FSUSBLOG_CI_PRODUCTION_SOURCE_FINGERPRINT ?? env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim();
    const expectedRunId = String(env.GITHUB_RUN_ID ?? '').trim();
    const expectedRunAttempt = String(env.GITHUB_RUN_ATTEMPT ?? '').trim();
    if (!expectedCommit || !expectedFingerprint || !expectedRunId || !expectedRunAttempt)
    {
        throw new Error('PR smart gate authority requires current commit, source fingerprint, run ID, and run attempt');
    }
    if (plan.sourceState.commit !== expectedCommit)
    {
        throw new Error('PR smart gate plan commit is stale');
    }
    if (normalizeFingerprint(plan.sourceState.worktreeFingerprint) !== normalizeFingerprint(expectedFingerprint))
    {
        throw new Error('PR smart gate plan source fingerprint is stale');
    }
    if (String(plan.runId) !== expectedRunId || String(plan.runAttempt) !== expectedRunAttempt)
    {
        throw new Error('PR smart gate plan run identity is stale');
    }
    const expectedPlanDigest = String(env.FSUSBLOG_CI_PR_PLAN_DIGEST ?? '').trim();
    if (expectedPlanDigest && plan.contentDigest !== expectedPlanDigest)
    {
        throw new Error('PR smart gate plan digest does not match producer output');
    }
    const expectedBuildDigest = String(env.FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST ?? '').trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(String(buildReceiptDigest ?? '')))
    {
        throw new Error('PR smart gate authority requires an immutable production build digest');
    }
    if (expectedBuildDigest && buildReceiptDigest !== expectedBuildDigest)
    {
        throw new Error('PR smart gate authority build digest does not match producer output');
    }
    // Preserve the producer-sealed plan document byte-for-byte at the value
    // level. Build binding and the production-summary needs projection belong to
    // the authority envelope; adding either here would invalidate contentDigest.
    return structuredClone(plan);
}

function findPrSmartGatePlan(explicitFile, env, buildReceiptDigest)
{
    const configured = explicitFile ?? env.FSUSBLOG_CI_PR_SMART_GATE_PLAN ?? null;
    const candidates = configured
        ? [path.resolve(configured)]
        : [
        path.join(root, '.tmp/pr-plan.json'),
        path.join(root, '.tmp/release-evidence/pr-smart-gate-summary.json'),
        ...transportedJsonFiles()
      ];
    const matches = [];
    for (const file of [...new Set(candidates)])
    {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        {
            continue;
        }
        let isPlan = false;
        try
        {
            const plan = readJson(file);
            if (plan.schema !== 'fsusblog.pr-smart-gate.v1')
            {
                continue;
            }
            isPlan = true;
            const authorityPlan = validatePrSmartGatePlan(plan, env, buildReceiptDigest);
            matches.push({ file, plan, authorityPlan });
        }
        catch (error)
        {
            if (configured || isPlan)
            {
                throw error;
            }
        }
    }
    if (matches.length === 0)
    {
        throw new Error('current PR smart gate plan is required for GitHub correctness authority');
    }
    const digests = new Set(matches.map(({ plan }) => plan.contentDigest));
    if (digests.size !== 1)
    {
        throw new Error('multiple conflicting PR smart gate plans were discovered');
    }
    return matches[0];
}

function findProductionBuildReceipt(explicitFile = null)
{
    const candidates = [
        explicitFile,
        process.env.FSUSBLOG_PRODUCTION_BUILD_RECEIPT,
        path.join(root, '.tmp/ci-production-build/receipt.json'),
        ...transportedJsonFiles()
    ].filter(Boolean).map((file) => path.resolve(file));
    const expectedCommit = String(process.env.GITHUB_SHA ?? '').trim();
    const expectedFingerprint = String(process.env.FSUSBLOG_CI_PRODUCTION_SOURCE_FINGERPRINT ?? '').trim();
    const expectedDigest = String(process.env.FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST ?? '').trim();
    for (const file of [...new Set(candidates)])
    {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        {
            continue;
        }
        try
        {
            const receipt = readJson(file);
            if (receipt.schema !== 'fsusblog.ci-production-build-receipt.v1')
            {
                continue;
            }
            if (expectedCommit && receipt.sourceState?.commit !== expectedCommit)
            {
                continue;
            }
            if (expectedFingerprint && normalizeFingerprint(receipt.sourceState?.worktreeFingerprint) !== normalizeFingerprint(expectedFingerprint))
            {
                continue;
            }
            if (expectedDigest && receipt.contentDigest !== expectedDigest)
            {
                continue;
            }
            return { file, receipt };
        }
        catch
        {
            // Ignore unrelated/corrupt JSON while discovering the explicit schema.
        }
    }
    throw new Error('immutable production build receipt is required for browserless correctness evidence');
}

function collectJobSummaries(expectedCommit, env = process.env, { schedulerRunId = null } = {})
{
    const files = [
        ...walkJsonFiles(path.join(root, '.tmp/release-evidence/jobs')),
        ...transportedJsonFiles()
    ];
    const summaries = [];
    const seen = new Map();
    const expectedRunId = String(env.GITHUB_RUN_ID ?? '').trim();
    const expectedAttempt = String(env.GITHUB_RUN_ATTEMPT ?? '').trim();
    for (const file of [...new Set(files)])
    {
        let summary;
        try
        {
            summary = readJson(file);
        }
        catch
        {
            // Ignore unrelated JSON artifacts.
            continue;
        }
        if (summary.schema !== 'fsusblog.ci.job-result.v1')
        {
            continue;
        }
        if (summary.evidenceClass === 'diagnostic' || summary.evidenceClass === 'browser-contract' || summary.affectsCorrectness === false)
        {
            continue;
        }
        if (summary.commit !== expectedCommit)
        {
            continue;
        }
        if (expectedRunId && String(summary.runId) !== expectedRunId)
        {
            continue;
        }
        if (expectedAttempt && String(summary.attempt) !== expectedAttempt)
        {
            continue;
        }
        if (schedulerRunId && String(summary.schedulerRunId ?? '') !== schedulerRunId)
        {
            continue;
        }
        if (summary.contentDigest !== digestValue(summary))
        {
            throw new Error(`correctness job summary content digest mismatch: ${summary.jobId ?? summary.ciJob ?? file}`);
        }
        const jobId = String(summary.jobId ?? summary.ciJob ?? '').trim();
        const previousDigest = seen.get(jobId);
        if (previousDigest && previousDigest !== summary.contentDigest)
        {
            throw new Error(`conflicting current correctness job summaries: ${jobId}`);
        }
        seen.set(jobId, summary.contentDigest);
        summaries.push({ summary, file: path.relative(root, file).replaceAll(path.sep, '/') });
    }
    return summaries;
}

export function schedulerAuthority(runId, tierIds, sourceState, { repositoryRoot = root } = {})
{
    const checkpointFile = path.join(repositoryRoot, '.tmp/test-runs', runId, 'checkpoint.json');
    const canonical = readCanonicalSchedulerCheckpoint(checkpointFile);
    if (!canonical)
    {
        throw new Error(`scheduler checkpoint is missing: ${path.relative(root, checkpointFile)}`);
    }
    const checkpoint = canonical.checkpoint;
    if (checkpoint.runId !== runId)
    {
        throw new Error('scheduler checkpoint run identity mismatch');
    }
    if (checkpoint.sourceState?.commit !== sourceState.commit
    || String(checkpoint.sourceState?.worktreeFingerprint ?? '').replace(/^sha256:/u, '') !== String(sourceState.worktreeFingerprint).replace(/^sha256:/u, ''))
    {
        throw new Error('scheduler checkpoint source/build identity mismatch');
    }
    const dependencyTierIds = tierIds.filter((tierId) => tierId !== 'production-correctness');
    const missing = dependencyTierIds.filter((tierId) => checkpoint.tiers?.[tierId]?.status !== 'success');
    if (missing.length > 0)
    {
        throw new Error(`scheduler checkpoint has incomplete correctness tiers: ${missing.join(', ')}`);
    }
    const aggregateStatus = checkpoint.tiers?.['production-correctness']?.status ?? null;
    const authorityLevel = correctnessAggregateAuthorityLevel(aggregateStatus);
    if (authorityLevel === 'terminal-success')
    {
        // The aggregate CLI cannot mint final authority from mutable compatibility JSON.
        // Only the scheduler finalizer may bind the canonical terminal commit after CAS and postflight.
        throw new Error('contract.missing-terminal-checkpoint-attestation: scheduler terminal finalizer is required');
    }
    const browserProcesses = dependencyTierIds.reduce((sum, tierId) => (
        sum + Math.max(0, Number(checkpoint.tiers?.[tierId]?.resourceUtilization?.peakBrowserProcessCount ?? 0))
    ), 0);
    if (browserProcesses !== 0)
    {
        throw new Error(`scheduler checkpoint observed ${browserProcesses} browser processes in correctness tiers`);
    }
    return {
        kind: 'scheduler-checkpoint',
        status: 'provisional',
        authorityLevel: 'provisional',
        qualificationEligible: false,
        runId,
        schedulerRunIds: [runId],
        checkpoint: path.relative(repositoryRoot, checkpointFile).replaceAll(path.sep, '/'),
        canonicalCheckpointRef: canonical.compactStateRef,
        canonicalCheckpointDigest: canonical.checkpointDigest,
        aggregateStatus,
        authoritative: false
    };
}

export function githubNeedsAuthority(env = process.env, { plan = null, buildReceiptDigest = null } = {})
{
    const raw = env.QUALITY_GATE_NEEDS_JSON;
    if (!raw)
    {
        return null;
    }
    const needs = JSON.parse(raw);
    const admittedBySummary = env.FSUSBLOG_CORRECTNESS_SUMMARY_AUTHORITY === 'passed';
    if (!admittedBySummary)
    {
        throw new Error('GitHub correctness authority requires a passed production summary');
    }
    const fullPlan = validatePrSmartGatePlan(plan, env, buildReceiptDigest);
    const needsJobIds = Object.keys(needs).sort();
    if (JSON.stringify(needsJobIds) !== JSON.stringify(fullPlan.summaryAuthorityJobIds))
    {
        throw new Error('GitHub needs do not exactly match the production-summary authority job projection');
    }
    const selected = new Set(fullPlan.selectedJobIds);
    const skipped = new Set(fullPlan.skippedJobIds);
    const errors = [];
    for (const [name, value] of Object.entries(needs))
    {
        if (selected.has(name))
        {
            if (value?.result !== 'success')
            {
                errors.push(`selected job ${name} is ${value?.result ?? 'missing'}`);
            }
        }
        else if (skipped.has(name))
        {
            if (value?.result !== 'skipped')
            {
                errors.push(`policy-skipped job ${name} unexpectedly ran with ${value?.result ?? 'missing'}`);
            }
        }
        else
        {
            errors.push(`job ${name} is not declared by the PR smart gate plan`);
        }
    }
    if (errors.length > 0)
    {
        throw new Error(`GitHub needs do not match the PR smart gate plan: ${errors.join('; ')}`);
    }
    // production-summary does not directly depend on every planned job (for
    // example Browser Contract and collector fan-out). The authority envelope
    // records that exact needs projection while retaining the complete sealed
    // plan so its content digest remains independently verifiable.
    return {
        kind: 'github-needs',
        status: 'success',
        authoritative: true,
        runId: env.GITHUB_RUN_ID ?? null,
        runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
        jobIds: needsJobIds,
        skippedJobIds: Object.entries(needs).filter(([, value]) => value?.result === 'skipped').map(([name]) => name).sort(),
        buildReceiptDigest,
        admittedByProductionSummary: admittedBySummary,
        schedulerRunIds: [],
        plan: fullPlan
    };
}

function physicalTestIds(runId, correctnessTierIds)
{
    if (!runId)
    {
        return [];
    }
    const summaryFile = path.join(root, '.tmp/physical-executions', runId, 'summary.json');
    if (!fs.existsSync(summaryFile))
    {
        return [];
    }
    const summary = readJson(summaryFile);
    const tierSet = new Set(correctnessTierIds);
    const receiptFiles = [...new Set((summary.consumers ?? [])
        .filter((consumer) => tierSet.has(consumer.consumerId))
        .map((consumer) => consumer.physicalExecutionReceipt)
        .filter(Boolean))];
    const ids = [];
    for (const relativeFile of receiptFiles)
    {
        const file = path.resolve(root, relativeFile);
        if (!fs.existsSync(file))
        {
            continue;
        }
        const receipt = readJson(file);
        if (receipt.schedulerRunId !== runId || receipt.status !== 'success')
        {
            continue;
        }
        ids.push(...(receipt.testIds ?? []));
    }
    return ids;
}

function rejectPolicySkippedSummaryClaims(summaries, policyTierIds, plan)
{
    if (!plan)
    {
        return;
    }
    const policy = new Set(policyTierIds);
    const skipped = new Set(plan.skippedTierIds ?? []);
    const violations = [];
    for (const { summary } of summaries)
    {
        const claimed = (summary.tierIds ?? []).filter((tierId) => policy.has(tierId) && skipped.has(tierId));
        if (claimed.length > 0)
        {
            violations.push(`${summary.jobId ?? summary.ciJob}:${sortedUnique(claimed).join(',')}`);
        }
    }
    if (violations.length > 0)
    {
        throw new Error(`current correctness job summaries claim policy-skipped tiers: ${violations.sort().join('; ')}`);
    }
}

/** Aggregate producers can publish only this attempt's provisional packet. The scheduler seals success later. */
export function publishCorrectnessProvisional(contextFile, { repositoryRoot = root, env = process.env } = {})
{
    const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    const attemptId = String(env.FSUSBLOG_CORRECTNESS_TARGET_ATTEMPT_ID ?? '').trim();
    if (!runId || !attemptId || !contextFile)
    {
        throw new Error('contract.missing-correctness-provisional-context: explicit run/attempt/context required');
    }
    const canonical = readCanonicalSchedulerCheckpoint(path.join(repositoryRoot, '.tmp/test-runs', runId, 'checkpoint.json'));
    const checkpoint = canonical?.checkpoint;
    const attempt = checkpoint?.correctnessAttempt;
    if (checkpoint?.status !== 'running' || attempt?.status !== 'running' || attempt.targetAttemptId !== attemptId
        || path.resolve(String(env.FSUSBLOG_CORRECTNESS_PROVISIONAL_PACKET ?? '')) !== attempt.provisionalPacketFile)
    {
        throw new Error('contract.correctness-provisional-attempt-mismatch');
    }
    const stat = fs.lstatSync(contextFile);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error('correctness provisional context must be an explicit regular file');
    }
    const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
    if (context.runId !== runId || context.targetAttemptId !== attemptId
        || context.aggregateStatus !== attempt.status
        || context.createdFromCheckpointRevision !== attempt.createdFromCheckpointRevision
        || JSON.stringify(canonicalize(context.sourceState)) !== JSON.stringify(canonicalize(checkpoint.sourceState)))
    {
        throw new Error('contract.correctness-provisional-context-mismatch');
    }
    const provisional = createCorrectnessProvisionalReceipt(context);
    const packet = { context, provisional };
    const bytes = `${JSON.stringify(packet, null, 2)}\n`;
    const file = attempt.provisionalPacketFile;
    if (path.dirname(file) !== attempt.root || fs.realpathSync(attempt.root) !== attempt.root)
    {
        throw new Error('correctness provisional packet escaped its owned attempt root');
    }
    if (fs.existsSync(file))
    {
        const existing = fs.lstatSync(file);
        if (!existing.isFile() || existing.isSymbolicLink() || fs.readFileSync(file, 'utf8') !== bytes)
        {
            throw new Error('correctness provisional packet cannot overwrite attempt history');
        }
    }
    else
    {
        const descriptor = fs.openSync(file, 'wx', 0o600);
        try
        {
            fs.writeFileSync(descriptor, bytes);
            fs.fsyncSync(descriptor);
        }
        finally
        {
            fs.closeSync(descriptor);
        }
    }
    console.log(`[test-evidence] correctness provisional attempt=${attemptId} digest=${provisional.contentDigest} file=${file}`);
    return packet;
}

function createCorrectness(options)
{
    const build = findProductionBuildReceipt(options.buildReceipt);
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const tierIds = productionCorrectnessTierClosure(matrix).map((tier) => tier.id);
    const explicitSchedulerRunId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    const schedulerRunId = explicitSchedulerRunId;
    if (!process.env.QUALITY_GATE_NEEDS_JSON && !schedulerRunId)
    {
        throw new Error('local correctness authority requires explicit FSUSBLOG_TEST_RUN_ID');
    }
    const summaries = collectJobSummaries(build.receipt.sourceState.commit, process.env, { schedulerRunId: schedulerRunId || null });
    if (schedulerRunId && summaries.length === 0)
    {
        throw new Error('browserless correctness receipt found no correctness job summaries');
    }
    let authority;
    if (schedulerRunId)
    {
        authority = schedulerAuthority(schedulerRunId, tierIds, build.receipt.sourceState);
    }
    else if (process.env.QUALITY_GATE_NEEDS_JSON)
    {
        const discoveredPlan = findPrSmartGatePlan(options.prPlan, process.env, build.receipt.contentDigest);
        rejectPolicySkippedSummaryClaims(summaries, tierIds, discoveredPlan.plan);
        authority = githubNeedsAuthority(process.env, {
            plan: discoveredPlan.plan,
            buildReceiptDigest: build.receipt.contentDigest
        });
    }
    else
    {
        authority = null;
    }
    if (!authority)
    {
        throw new Error('browserless correctness generator has no current scheduler or GitHub needs authority');
    }
    if (schedulerRunId && process.env.FSUSBLOG_CORRECTNESS_TARGET_ATTEMPT_ID)
    {
        const contextFile = String(process.env.FSUSBLOG_CORRECTNESS_PROVISIONAL_CONTEXT ?? '').trim();
        if (!contextFile)
        {
            throw new Error('contract.missing-correctness-provisional-context: terminal dependencies require owner-produced context');
        }
        const packet = publishCorrectnessProvisional(path.resolve(root, contextFile));
        if (packet.context.buildReceiptDigest !== build.receipt.contentDigest)
        {
            throw new Error('contract.correctness-provisional-build-mismatch');
        }
        return;
    }
    const receipt = createBrowserlessCorrectnessReceipt({
        matrix,
        buildReceipt: build.receipt,
        buildReceiptPath: path.relative(root, build.file),
        jobSummaries: summaries,
        authority,
        physicalTestIds: physicalTestIds(schedulerRunId, tierIds)
    });
    requireCleanAttemptConsumerAdmission({
        consumerId: 'production-correctness',
        repositoryRoot: root,
        candidateBinding: { sourceCommit: build.receipt.sourceState.commit,
            worktreeFingerprint: `sha256:${build.receipt.sourceState.worktreeFingerprint.replace(/^sha256:/u, '')}`,
            schedulerRunId: authority.runId ?? authority.plan?.runId ?? process.env.GITHUB_RUN_ID,
            buildIdentity: build.receipt.contentDigest }
    });
    const errors = validateBrowserlessCorrectnessReceipt(receipt);
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    writeJsonAtomic(options.output, receipt);
    console.log(`[test-evidence] correctness ok tiers=${receipt.aggregate.tierIds.length} ids=${receipt.aggregate.testIds.length} browserLaunches=0 file=${path.relative(root, options.output)}`);
}

function validateFile(options, validator, label)
{
    if (!options.file)
    {
        throw new Error(`${label} receipt path is required`);
    }
    const errors = validator(readJson(options.file), {
        expectedCommit: String(process.env.GITHUB_SHA ?? '').trim() || null,
        expectedFingerprint: String(process.env.FSUSBLOG_CI_PRODUCTION_SOURCE_FINGERPRINT ?? '').trim() || null,
        expectedBuildReceiptDigest: String(process.env.FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST ?? '').trim() || null
    });
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    console.log(`[test-evidence] ${label} ok file=${path.relative(root, options.file)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const options = parseArguments(process.argv.slice(2));
    try
    {
        if (options.command === 'create-correctness')
        {
            createCorrectness(options);
        }
        else if (options.command === 'create-provisional')
        {
            publishCorrectnessProvisional(options.file);
        }
        else if (options.command === 'validate-correctness')
        {
            const runId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
            if (!runId)
            {
                throw new Error('contract.missing-correctness-consumer-run: explicit canonical run required');
            }
            const checkpointFile = path.join(root, '.tmp/test-runs', runId, 'checkpoint.json');
            const result = readCurrentSchedulerCorrectness({ checkpointFile, readCanonical: readCanonicalSchedulerCheckpoint });
            if (options.file && readJson(options.file).contentDigest !== result.receipt.contentDigest)
            {
                throw new Error('contract.correctness-consumer-file-not-current: legacy/orphan receipt is diagnostic only');
            }
            console.log(`[test-evidence] correctness terminal verified run=${runId} digest=${result.receipt.contentDigest}`);
        }
        else if (options.command === 'validate-browser-contract')
        {
            validateFile(options, validateBrowserContractReceipt, 'browser-contract');
        }
        else if (options.command === 'validate-diagnostics')
        {
            validateFile(options, validateBrowserDiagnosticsReceipt, 'diagnostics');
        }
        else
        {
            throw new Error(`usage: ${path.basename(process.argv[1])} create-correctness|create-provisional|validate-correctness|validate-browser-contract|validate-diagnostics [file]`);
        }
    }
    catch (error)
    {
        console.error(`[test-evidence] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

export { browserlessCorrectnessReceiptSchema };
