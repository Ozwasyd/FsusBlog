import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const { readCorrectnessProducerTemporalAuthority } = await import(new URL('../test/temporal-producer-bindings.mjs', import.meta.url));

const {
    validatePostRuntimeReceipt
} = await import(new URL('../test-matrix/behavior-evidence-post-runtime.mjs', import.meta.url));
const {
    assertPreRuntimeQualified
} = await import(new URL('../test-matrix/behavior-evidence-pre-runtime.mjs', import.meta.url));
const {
    validateRequiredEvidenceCatalogBinding
} = await import(new URL('../test-matrix/required-evidence-catalog.mjs', import.meta.url));

import {
    productionBuildReceiptSchema,
    productionBuildBinding,
    canonicalize,
    digestValue,
    sortedUnique,
    normalizeFingerprint,
    isDigest,
    sourceStateErrors,
    sameSourceState,
    sortedUniqueErrors,
    validateBrowserContractReceipt as validateBrowserContractReceiptContract
} from './browser-contract-receipt-contract.mjs';
import { requireCleanAttemptConsumerAdmission } from './browser-release-clean-attempt-consumers.mjs';
import {
    createReleaseDomainProjectionBindings,
    validateReleaseDomainProjectionBindings
} from './release-domain-final-binding.mjs';
import {
    validateReleaseReliabilityQualifiedBinding
} from './release-reliability-qualified-receipt.mjs';

export const browserlessCorrectnessReceiptSchema = 'fsusblog.browserless-correctness-receipt.v1';
export const browserDiagnosticsReceiptSchema = 'fsusblog.browser-diagnostics-receipt.v2';
export const releaseFinalTestEvidenceBindingSchema = 'fsusblog.release-final-test-evidence-binding.v1';

export { productionBuildBinding, validatePublicPreviewEvidenceBinding } from './browser-contract-receipt-contract.mjs';

export function validateBrowserContractReceipt(receipt, options = {})
{
    return validateBrowserContractReceiptContract(receipt, {
        ...options,
        temporalAuthority: readCorrectnessProducerTemporalAuthority()
    });
}


function tierExecutionDependencies(tier)
{
    return tier?.executionDependsOn ?? tier?.dependsOn ?? [];
}

function seal(value)
{
    const sealed = { ...value, contentDigest: null };
    sealed.contentDigest = digestValue(sealed);
    return sealed;
}

export function sha256File(file)
{
    return sha256Bytes(fs.readFileSync(file));
}

function sha256Bytes(bytes)
{
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readBoundBehaviorReceipt(file, receipt, validator)
{
    const bytes = fs.readFileSync(file);
    const parsed = JSON.parse(bytes.toString('utf8'));
    validator(parsed);
    if (JSON.stringify(canonicalize(parsed)) !== JSON.stringify(canonicalize(receipt)))
    {
        throw new Error('release-final behavior receipt object/file mismatch');
    }
    return { receipt: parsed, fileDigest: sha256Bytes(bytes) };
}

export function productionCorrectnessTierClosure(matrix)
{
    const byId = new Map((matrix?.tiers ?? []).map((tier) => [tier.id, tier]));
    const visited = new Set();
    const visit = (id) =>
    {
        if (visited.has(id))
        {
            return;
        }
        const tier = byId.get(id);
        if (!tier)
        {
            throw new Error(`browserless correctness matrix is missing tier ${id}`);
        }
        for (const dependency of tierExecutionDependencies(tier))
        {
            visit(dependency);
        }
        visited.add(id);
    };
    visit('production-correctness');
    const tiers = [...visited].map((id) => byId.get(id));
    const browserTiers = tiers.filter((tier) => tier.requiresPlaywright !== 'none');
    if (browserTiers.length > 0)
    {
        throw new Error(`browserless correctness closure contains browser tiers: ${browserTiers.map((tier) => tier.id).sort().join(', ')}`);
    }
    return tiers.sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeJobSummaryEntries(jobSummaries)
{
    return (jobSummaries ?? []).map((entry) => entry?.summary ? entry : { summary: entry, file: null });
}

export function createBrowserlessCorrectnessReceipt({
    matrix,
    buildReceipt,
    buildReceiptPath,
    jobSummaries = [],
    authority,
    physicalTestIds = [],
    attemptEvidence = null,
    expectedCandidate = null,
    now = () => new Date()
})
{
    const tiers = productionCorrectnessTierClosure(matrix);
    const policyTierIds = tiers.map((tier) => tier.id);
    const policyTierIdSet = new Set(policyTierIds);
    const plan = authority?.plan && typeof authority.plan === 'object' ? authority.plan : null;
    const planSelectedTierIds = plan
        ? sortedUnique(plan.selectedTierIds ?? plan.executedTierIds ?? []).filter((tierId) => policyTierIdSet.has(tierId))
        : policyTierIds;
    const executedTierIds = planSelectedTierIds;
    const executedTierIdSet = new Set(executedTierIds);
    const policySkippedTierIds = policyTierIds.filter((tierId) => !executedTierIdSet.has(tierId));
    if (!executedTierIdSet.has('production-correctness'))
    {
        throw new Error('browserless correctness plan did not select production-correctness');
    }
    if (plan)
    {
        const declaredSkipped = new Set(sortedUnique(plan.skippedTierIds ?? plan.policySkippedTierIds ?? []));
        const missingPlanDecisions = policySkippedTierIds.filter((tierId) => !declaredSkipped.has(tierId));
        if (missingPlanDecisions.length > 0)
        {
            throw new Error(`browserless correctness plan does not authorize skipped tiers: ${missingPlanDecisions.join(', ')}`);
        }
        const overlapping = executedTierIds.filter((tierId) => declaredSkipped.has(tierId));
        if (overlapping.length > 0)
        {
            throw new Error(`browserless correctness plan selected and skipped the same tiers: ${overlapping.join(', ')}`);
        }
    }
    const entries = normalizeJobSummaryEntries(jobSummaries)
        .filter(({ summary }) => summary?.schema === 'fsusblog.ci.job-result.v1')
        .filter(({ summary }) => summary.evidenceClass !== 'diagnostic' && summary.affectsCorrectness !== false)
        .map(({ summary, file }) => ({
            jobId: String(summary.jobId ?? summary.ciJob ?? '').trim(),
            status: summary.status,
            commit: String(summary.commit ?? '').trim(),
            summaryDigest: digestValue(summary),
            fileDigest: file && fs.existsSync(file) ? sha256File(file) : null,
            tierIds: sortedUnique((summary.tierIds ?? []).filter((id) => executedTierIdSet.has(id))),
            testIds: sortedUnique(summary.testIds ?? []),
            playwrightWorkers: summary.playwrightWorkers ?? null,
            runId: String(summary.runId ?? '').trim() || null,
            runAttempt: String(summary.attempt ?? summary.runAttempt ?? '').trim() || null,
            schedulerRunId: String(summary.schedulerRunId ?? '').trim() || null,
            file: file ? String(file).replaceAll(path.sep, '/') : null
        }))
        .filter((entry) => entry.jobId && entry.tierIds.length > 0)
        .sort((left, right) => left.jobId.localeCompare(right.jobId) || String(left.file).localeCompare(String(right.file)));

    const failedJobs = entries.filter((entry) => entry.status !== 'success');
    if (failedJobs.length > 0)
    {
        throw new Error(`browserless correctness job summaries are not successful: ${failedJobs.map((entry) => entry.jobId).join(', ')}`);
    }
    const browserJobs = entries.filter((entry) => Number(entry.playwrightWorkers ?? 0) > 0);
    if (browserJobs.length > 0)
    {
        throw new Error(`browserless correctness job summaries declared Playwright workers: ${browserJobs.map((entry) => entry.jobId).join(', ')}`);
    }
    if (!authority || !['github-needs', 'scheduler-checkpoint'].includes(authority.kind))
    {
        throw new Error('browserless correctness receipt requires github-needs or scheduler-checkpoint authority');
    }
    if (authority.status !== 'success')
    {
        throw new Error(`browserless correctness authority is not successful: ${authority.status}`);
    }
    if (authority.kind === 'github-needs' && !plan)
    {
        throw new Error('browserless correctness GitHub authority requires a bound PR smart-gate plan');
    }
    const authorityRunId = String(authority.runId ?? plan?.runId ?? '').trim();
    const authorityRunAttempt = String(authority.runAttempt ?? plan?.runAttempt ?? '').trim();
    if (authority.kind === 'scheduler-checkpoint')
    {
        if (!authorityRunId)
        {
            throw new Error('browserless correctness scheduler authority run identity is missing');
        }
        const staleEntries = entries.filter((entry) => entry.schedulerRunId !== authorityRunId);
        if (staleEntries.length > 0)
        {
            throw new Error(`browserless correctness job summaries do not match scheduler authority run ${authorityRunId}: ${staleEntries.map((entry) => entry.jobId).join(', ')}`);
        }
    }
    else
    {
        if (!authorityRunId || !authorityRunAttempt)
        {
            throw new Error('browserless correctness GitHub authority run identity is incomplete');
        }
        const staleEntries = entries.filter((entry) => entry.runId !== authorityRunId || entry.runAttempt !== authorityRunAttempt);
        if (staleEntries.length > 0)
        {
            throw new Error(`browserless correctness job summaries do not match GitHub authority run ${authorityRunId}/${authorityRunAttempt}: ${staleEntries.map((entry) => entry.jobId).join(', ')}`);
        }
    }
    const build = productionBuildBinding(buildReceipt, buildReceiptPath);
    const unboundEntries = entries.filter((entry) => entry.commit !== build.sourceState.commit || !isDigest(entry.summaryDigest));
    if (unboundEntries.length > 0)
    {
        throw new Error(`browserless correctness job summaries are not bound to the build source: ${unboundEntries.map((entry) => entry.jobId).join(', ')}`);
    }
    if (plan)
    {
        if (!isDigest(plan.contentDigest) || plan.contentDigest !== digestValue(plan))
        {
            throw new Error('browserless correctness plan content digest mismatch');
        }
        if (!sameSourceState(plan.sourceState, build.sourceState))
        {
            throw new Error('browserless correctness plan source/build identity mismatch');
        }
        if (authority.buildReceiptDigest !== build.receiptContentDigest)
        {
            throw new Error('browserless correctness authority build receipt digest mismatch');
        }
    }
    const observedTierIds = new Set(entries.flatMap((entry) => entry.tierIds));
    const missingDependencyTierIds = executedTierIds
        .filter((tierId) => tierId !== 'production-correctness')
        .filter((tierId) => !observedTierIds.has(tierId));
    if (missingDependencyTierIds.length > 0)
    {
        throw new Error(`browserless correctness job summaries are missing tiers: ${missingDependencyTierIds.join(', ')}`);
    }

    const summaryTestIds = entries.flatMap((entry) => entry.testIds);
    const exactEvidenceIds = sortedUnique([
        ...physicalTestIds,
        ...summaryTestIds,
        ...executedTierIds.map((tierId) => `tier:${tierId}`)
    ]);
    const jobIds = sortedUnique(entries.map((entry) => entry.jobId));
    if (jobIds.length === 0)
    {
        throw new Error('browserless correctness receipt found no correctness job summaries');
    }

    requireCleanAttemptConsumerAdmission({
        consumerId: 'production-correctness',
        attemptEvidence,
        expectedCandidate,
        candidateBinding: {
            sourceCommit: build.sourceState.commit,
            worktreeFingerprint: `sha256:${normalizeFingerprint(build.sourceState.worktreeFingerprint)}`,
            schedulerRunId: authority.runId ?? authority.plan?.runId,
            buildIdentity: build.receiptContentDigest,
            membership: { selectedTierIds: executedTierIds, testVectors: sortedUnique(summaryTestIds) }
        }
    });

    return seal({
        schema: browserlessCorrectnessReceiptSchema,
        status: 'success',
        evidenceClass: 'correctness',
        affectsCorrectness: true,
        sourceState: build.sourceState,
        build,
        aggregate: {
            tierId: 'production-correctness',
            tierIds: executedTierIds,
            policyTierIds,
            executedTierIds,
            policySkippedTierIds,
            jobIds,
            testIds: exactEvidenceIds,
            jobSummaries: entries
        },
        browserBoundary: {
            browserLaunchCount: 0,
            peakBrowserProcessCount: 0,
            playwrightBrowserInstallation: false,
            browserFixtureSchemaCount: 0,
            browserFixtureSchemas: []
        },
        authority: {
            ...authority,
            schedulerRunIds: sortedUnique(authority.schedulerRunIds ?? entries.map((entry) => entry.schedulerRunId))
        },
        generatedAt: now().toISOString()
    });
}

export function validateBrowserlessCorrectnessReceipt(receipt, {
    expectedCommit = null,
    expectedFingerprint = null,
    expectedBuildReceiptDigest = null
} = {})
{
    const errors = [];
    if (receipt?.schema !== browserlessCorrectnessReceiptSchema)
    {
        errors.push(`unexpected correctness receipt schema: ${receipt?.schema ?? 'missing'}`);
    }
    if (receipt?.status !== 'success')
    {
        errors.push(`correctness receipt status must be success, got ${receipt?.status}`);
    }
    if (receipt?.evidenceClass !== 'correctness' || receipt?.affectsCorrectness !== true)
    {
        errors.push('correctness receipt classification is invalid');
    }
    errors.push(...sourceStateErrors(receipt?.sourceState, 'correctness receipt sourceState'));
    if (receipt?.contentDigest !== digestValue(receipt ?? {}))
    {
        errors.push('correctness receipt content digest mismatch');
    }
    if (receipt?.aggregate?.tierId !== 'production-correctness')
    {
        errors.push('correctness receipt aggregate tier must be production-correctness');
    }
    errors.push(...sortedUniqueErrors(receipt?.aggregate?.tierIds, 'correctness receipt tierIds'));
    errors.push(...sortedUniqueErrors(receipt?.aggregate?.policyTierIds, 'correctness receipt policyTierIds'));
    errors.push(...sortedUniqueErrors(receipt?.aggregate?.executedTierIds, 'correctness receipt executedTierIds'));
    errors.push(...sortedUniqueErrors(receipt?.aggregate?.policySkippedTierIds, 'correctness receipt policySkippedTierIds', { allowEmpty: true }));
    errors.push(...sortedUniqueErrors(receipt?.aggregate?.jobIds, 'correctness receipt jobIds'));
    errors.push(...sortedUniqueErrors(receipt?.aggregate?.testIds, 'correctness receipt testIds'));
    if (!receipt?.aggregate?.tierIds?.includes('production-correctness'))
    {
        errors.push('correctness receipt tierIds must include production-correctness');
    }
    if (JSON.stringify(receipt?.aggregate?.tierIds) !== JSON.stringify(receipt?.aggregate?.executedTierIds))
    {
        errors.push('correctness receipt tierIds must equal executedTierIds');
    }
    const policyTierIds = receipt?.aggregate?.policyTierIds ?? [];
    const executedTierIds = receipt?.aggregate?.executedTierIds ?? [];
    const policySkippedTierIds = receipt?.aggregate?.policySkippedTierIds ?? [];
    const overlap = executedTierIds.filter((tierId) => policySkippedTierIds.includes(tierId));
    if (overlap.length > 0)
    {
        errors.push(`correctness receipt executed/skipped tiers overlap: ${overlap.join(', ')}`);
    }
    if (JSON.stringify(sortedUnique([...executedTierIds, ...policySkippedTierIds])) !== JSON.stringify(policyTierIds))
    {
        errors.push('correctness receipt executed/skipped tiers must partition policyTierIds');
    }
    const claimedTierIds = sortedUnique((receipt?.aggregate?.testIds ?? [])
        .filter((testId) => testId.startsWith('tier:'))
        .map((testId) => testId.slice('tier:'.length)));
    if (JSON.stringify(claimedTierIds) !== JSON.stringify(executedTierIds))
    {
        errors.push('correctness receipt tier test IDs must claim only executed tiers');
    }
    const authorityRunId = String(receipt?.authority?.runId ?? receipt?.authority?.plan?.runId ?? '').trim();
    const authorityRunAttempt = String(receipt?.authority?.runAttempt ?? receipt?.authority?.plan?.runAttempt ?? '').trim();
    for (const [index, summary] of (receipt?.aggregate?.jobSummaries ?? []).entries())
    {
        if (summary?.status !== 'success')
        {
            errors.push(`correctness receipt jobSummaries[${index}] must be success`);
        }
        if (summary?.commit !== receipt?.sourceState?.commit)
        {
            errors.push(`correctness receipt jobSummaries[${index}] commit mismatch`);
        }
        if (!isDigest(summary?.summaryDigest))
        {
            errors.push(`correctness receipt jobSummaries[${index}] summary digest is invalid`);
        }
        if (summary?.file !== null && !isDigest(summary?.fileDigest))
        {
            errors.push(`correctness receipt jobSummaries[${index}] file digest is invalid`);
        }
        if (summary?.file === null && summary?.fileDigest !== null)
        {
            errors.push(`correctness receipt jobSummaries[${index}] file digest requires a file path`);
        }
        if ((summary?.tierIds ?? []).some((tierId) => !executedTierIds.includes(tierId)))
        {
            errors.push(`correctness receipt jobSummaries[${index}] claims a non-executed tier`);
        }
        if (receipt?.authority?.kind === 'scheduler-checkpoint' && summary?.schedulerRunId !== authorityRunId)
        {
            errors.push(`correctness receipt jobSummaries[${index}] scheduler run identity mismatch`);
        }
        if (receipt?.authority?.kind === 'github-needs'
      && (summary?.runId !== authorityRunId || summary?.runAttempt !== authorityRunAttempt))
        {
            errors.push(`correctness receipt jobSummaries[${index}] GitHub run identity mismatch`);
        }
    }
    if (receipt?.browserBoundary?.browserLaunchCount !== 0)
    {
        errors.push('correctness receipt browserLaunchCount must be 0');
    }
    if (receipt?.browserBoundary?.peakBrowserProcessCount !== 0)
    {
        errors.push('correctness receipt peakBrowserProcessCount must be 0');
    }
    if (receipt?.browserBoundary?.playwrightBrowserInstallation !== false)
    {
        errors.push('correctness receipt Playwright browser installation must be false');
    }
    if (receipt?.browserBoundary?.browserFixtureSchemaCount !== 0)
    {
        errors.push('correctness receipt browser fixture schema count must be 0');
    }
    if (!Array.isArray(receipt?.browserBoundary?.browserFixtureSchemas) || receipt.browserBoundary.browserFixtureSchemas.length !== 0)
    {
        errors.push('correctness receipt browser fixture schemas must be empty');
    }
    if (!sameSourceState(receipt?.sourceState, receipt?.build?.sourceState))
    {
        errors.push('correctness receipt source/build identity mismatch');
    }
    if (!isDigest(receipt?.build?.receiptContentDigest))
    {
        errors.push('correctness receipt build digest is invalid');
    }
    if (!['github-needs', 'scheduler-checkpoint'].includes(receipt?.authority?.kind) || receipt?.authority?.status !== 'success')
    {
        errors.push('correctness receipt authority is invalid');
    }
    if (!authorityRunId || (receipt?.authority?.kind === 'github-needs' && !authorityRunAttempt))
    {
        errors.push('correctness receipt authority run identity is incomplete');
    }
    if (receipt?.authority?.kind === 'github-needs' && !receipt?.authority?.plan)
    {
        errors.push('correctness receipt GitHub authority requires a bound PR smart-gate plan');
    }
    if (receipt?.authority?.plan)
    {
        if (!isDigest(receipt.authority.plan.contentDigest))
        {
            errors.push('correctness receipt plan digest is invalid');
        }
        else if (receipt.authority.plan.contentDigest !== digestValue(receipt.authority.plan))
        {
            errors.push('correctness receipt plan content digest mismatch');
        }
        if (!sameSourceState(receipt.authority.plan.sourceState, receipt?.sourceState))
        {
            errors.push('correctness receipt plan source identity mismatch');
        }
        if (receipt.authority.buildReceiptDigest !== receipt?.build?.receiptContentDigest)
        {
            errors.push('correctness receipt authority build digest mismatch');
        }
        const selectedByPlan = sortedUnique(receipt.authority.plan.selectedTierIds ?? receipt.authority.plan.executedTierIds ?? [])
            .filter((tierId) => policyTierIds.includes(tierId));
        if (JSON.stringify(selectedByPlan) !== JSON.stringify(executedTierIds))
        {
            errors.push('correctness receipt plan selected tiers do not match executedTierIds');
        }
        const skippedByPlan = new Set(sortedUnique(receipt.authority.plan.skippedTierIds ?? receipt.authority.plan.policySkippedTierIds ?? []));
        if (policySkippedTierIds.some((tierId) => !skippedByPlan.has(tierId)))
        {
            errors.push('correctness receipt plan does not authorize every policy-skipped tier');
        }
        if (executedTierIds.some((tierId) => skippedByPlan.has(tierId)))
        {
            errors.push('correctness receipt plan selected/skipped tiers overlap');
        }
    }
    if (expectedCommit && receipt?.sourceState?.commit !== expectedCommit)
    {
        errors.push('correctness receipt commit does not match release commit');
    }
    if (expectedFingerprint && normalizeFingerprint(receipt?.sourceState?.worktreeFingerprint) !== normalizeFingerprint(expectedFingerprint))
    {
        errors.push('correctness receipt source fingerprint mismatch');
    }
    if (expectedBuildReceiptDigest && receipt?.build?.receiptContentDigest !== expectedBuildReceiptDigest)
    {
        errors.push('correctness receipt build receipt digest mismatch');
    }
    return errors;
}

function issueDiagnostics(scenarios)
{
    const issues = scenarios.flatMap((scenario) => Array.isArray(scenario?.issues) ? scenario.issues : []);
    const count = (predicate) => issues.filter(predicate).length;
    return {
        totalIssueCount: issues.length,
        expectedIssueCount: count((issue) => issue?.expected === true),
        unexpectedIssueCount: count((issue) => issue?.expected !== true),
        consoleIssueCount: count((issue) => String(issue?.kind ?? '').startsWith('console-')),
        pageErrorCount: count((issue) => issue?.kind === 'page-error'),
        requestFailureCount: count((issue) => issue?.kind === 'request-failed'),
        responseErrorCount: count((issue) => issue?.kind === 'response')
    };
}

export function sealBrowserContractReceipt(receipt)
{
    const scenarios = Array.isArray(receipt?.scenarios) ? receipt.scenarios : [];
    const artifacts = sortedUnique(scenarios.flatMap((scenario) => scenario?.artifacts ?? []));
    return seal({
        ...receipt,
        evidenceClass: 'browser-contract',
        affectsCorrectness: true,
        buildBinding: receipt?.build ? {
      schema: productionBuildReceiptSchema,
      receipt: receipt.build.receipt ?? null,
      receiptContentDigest: receipt.build.receiptContentDigest ?? null,
      sourceState: receipt.build.sourceState ?? null,
      profile: receipt.build.profile ?? null
    } : null,
        fixtureNamespace: receipt?.fixture?.namespace ?? receipt?.runIdentity?.namespace ?? null,
        scenarioIds: scenarios.map((scenario) => scenario.id),
        diagnostics: issueDiagnostics(scenarios),
        failureClass: receipt?.classification ?? null,
        artifacts
    });
}

function classifyArtifactPaths(paths)
{
    const normalized = sortedUnique(paths);
    return {
        screenshots: normalized.filter((value) => /(?:screenshot|visual|\.png$|\.jpe?g$)/iu.test(value)),
        traces: normalized.filter((value) => /(?:trace|\.zip$)/iu.test(value)),
        performance: normalized.filter((value) => /(?:perf|performance|render-pressure|aeds-wasm-browser)/iu.test(value)),
        all: normalized
    };
}

function canonicalDiagnosticFailureClass(value)
{
    if (value === null || value === undefined || String(value).trim() === '')
    {
        return null;
    }
    const normalized = String(value).trim();
    if (normalized === 'infra' || normalized === 'infra-failure')
    {
        return 'infra-failure';
    }
    if (normalized === 'unstable-topology')
    {
        return 'unstable-topology';
    }
    return 'diagnostic';
}

function normalizeDiagnosticClassificationTree(value, key = null)
{
    if (Array.isArray(value))
    {
        if (key === 'failureClasses')
        {
            return sortedUnique(value.map(canonicalDiagnosticFailureClass).filter(Boolean));
        }
        return value.map((item) => normalizeDiagnosticClassificationTree(item));
    }
    if (!value || typeof value !== 'object')
    {
        return key === 'failureClass' ? canonicalDiagnosticFailureClass(value) : value;
    }
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        normalizeDiagnosticClassificationTree(childValue, childKey)
    ]));
}

function normalizeDiagnosticAttempt(attempt, index)
{
    return {
        ...attempt,
        attempt: Number(attempt?.attempt ?? index + 1),
        testIds: sortedUnique(attempt?.testIds ?? []),
        artifacts: sortedUnique(attempt?.artifacts ?? []),
        failureClass: canonicalDiagnosticFailureClass(attempt?.failureClass),
        failureKind: attempt?.failureKind === null || attempt?.failureKind === undefined
            ? null
            : String(attempt.failureKind).trim() || null
    };
}

function differentFailedAttemptTestIds(attempts)
{
    const failed = attempts.filter((attempt) => attempt?.status === 'failure');
    if (failed.length < 2)
    {
        return false;
    }
    const first = JSON.stringify(failed[0].testIds ?? []);
    return failed.slice(1).some((attempt) => JSON.stringify(attempt.testIds ?? []) !== first);
}

function isRecoveredDiagnosticProbe(probe)
{
    const attempts = Array.isArray(probe?.attempts) ? probe.attempts : [];
    return attempts.length === 2
    && probe?.crashRetryCount === 1
    && attempts[0]?.status === 'failure'
    && attempts[0]?.failureClass === 'infra-failure'
    && attempts[0]?.failureKind === 'browser-process-crash'
    && attempts[1]?.status === 'success'
    && probe?.status === 'success'
    && probe?.finalStatus === 'diagnostic-passed-after-infra-retry';
}

function normalizeDiagnosticProbe(probe)
{
    const attempts = (Array.isArray(probe?.attempts) ? probe.attempts : [])
        .map((attempt, index) => normalizeDiagnosticAttempt(attempt, index));
    const unstableTopology = differentFailedAttemptTestIds(attempts);
    const attemptFailureClasses = attempts.map((attempt) => attempt.failureClass).filter(Boolean);
    const failureClass = unstableTopology
        ? 'unstable-topology'
        : canonicalDiagnosticFailureClass(probe?.failureClass)
      ?? (attemptFailureClasses.includes('infra-failure') ? 'infra-failure' : attemptFailureClasses[0] ?? null);
    return {
        ...probe,
        failureClass,
        failureKind: probe?.failureKind === null || probe?.failureKind === undefined
            ? null
            : String(probe.failureKind).trim() || null,
        testIds: sortedUnique(probe?.testIds ?? attempts.flatMap((attempt) => attempt.testIds)),
        attempts,
        crashRetryCount: Math.max(0, Number(probe?.crashRetryCount ?? 0))
    };
}

function normalizeDiagnosticCategory(category)
{
    const probes = (Array.isArray(category?.probes) ? category.probes : []).map(normalizeDiagnosticProbe);
    const failureClasses = sortedUnique([
        ...(category?.failureClasses ?? []).map(canonicalDiagnosticFailureClass),
        canonicalDiagnosticFailureClass(category?.failureClass),
        ...probes.map((probe) => probe.failureClass)
    ].filter(Boolean));
    return {
        ...category,
        failureClass: failureClasses.includes('unstable-topology')
            ? 'unstable-topology'
            : failureClasses.includes('infra-failure')
        ? 'infra-failure'
        : failureClasses[0] ?? null,
        failureClasses,
        probes
    };
}

export function sealBrowserDiagnosticsReceipt(receipt)
{
    receipt = normalizeDiagnosticClassificationTree(receipt);
    const categories = (Array.isArray(receipt?.categories) ? receipt.categories : []).map(normalizeDiagnosticCategory);
    const probes = categories.flatMap((category) => Array.isArray(category?.probes) ? category.probes : []);
    const artifactPaths = probes.flatMap((probe) => [
        ...(probe?.copiedArtifacts ?? []),
        ...(probe?.artifacts ?? []),
        ...(probe?.attempts ?? []).flatMap((attempt) => attempt?.artifacts ?? []),
        probe?.stdout,
        probe?.stderr
    ].filter(Boolean));
    const crashRetryCount = probes.reduce((sum, probe) => sum + Math.max(0, Number(probe?.crashRetryCount ?? 0)), 0);
    const recoveredProbeCount = probes.filter(isRecoveredDiagnosticProbe).length;
    const failureClasses = sortedUnique([
        ...(receipt?.failureClasses ?? []).map(canonicalDiagnosticFailureClass),
        ...categories.flatMap((category) => category.failureClasses ?? []),
        ...probes.map((probe) => probe?.failureClass)
    ].filter(Boolean));
    return seal({
        ...receipt,
        schema: browserDiagnosticsReceiptSchema,
        evidenceClass: 'diagnostic',
        affectsCorrectness: false,
        cadence: receipt?.cadence ?? (receipt?.mode === 'nightly' ? 'nightly' : 'manual'),
        trigger: receipt?.trigger ?? { kind: receipt?.mode === 'nightly' ? 'schedule' : 'manual' },
        buildBinding: receipt?.build ? {
      schema: receipt.build.schema ?? productionBuildReceiptSchema,
      receipt: receipt.build.receiptFile ?? receipt.build.receipt ?? null,
      receiptContentDigest: receipt.build.receiptContentDigest ?? receipt.build.contentDigest ?? null,
      sourceState: receipt.build.sourceState ?? null
    } : null,
        dimensions: receipt?.dimensions ?? {
            browsers: sortedUnique(categories.flatMap((category) => category?.browsers ?? [])),
            viewports: ['1280x800'],
            themes: ['light'],
            lanes: sortedUnique(categories.flatMap((category) => (category?.probes ?? []).map((probe) => `${category.id}/${probe.id}`)))
        },
        counts: {
            planned: Number(receipt?.plannedProbeCount ?? 0),
            executed: Number(receipt?.executedProbeCount ?? probes.length),
            skipped: Number(receipt?.skippedProbeCount ?? 0)
        },
        incompleteReason: receipt?.incompleteReason ?? null,
        crashRetryCount,
        finalStatus: recoveredProbeCount > 0 ? 'diagnostic-passed-after-infra-retry' : (receipt?.finalStatus ?? receipt?.status),
        failureClasses,
        failureClass: receipt?.status === 'success' && recoveredProbeCount === 0
            ? null
            : (failureClasses.includes('infra-failure') ? 'infra-failure' : failureClasses[0] ?? null),
        artifacts: classifyArtifactPaths(artifactPaths),
        categories
    });
}

export function validateBrowserDiagnosticsReceipt(receipt, {
    expectedCommit = null,
    expectedFingerprint = null,
    expectedBuildReceiptDigest = null
} = {})
{
    const errors = [];
    const initializationFailure = receipt?.initializationFailure;
    const hasInitializationFailure = initializationFailure && typeof initializationFailure === 'object';
    const initializationReceipt = ['incomplete', 'skipped'].includes(receipt?.status) && hasInitializationFailure;
    if (receipt?.schema !== browserDiagnosticsReceiptSchema)
    {
        errors.push(`unexpected diagnostics receipt schema: ${receipt?.schema ?? 'missing'}`);
    }
    if (!['success', 'failure', 'incomplete', 'skipped'].includes(receipt?.status))
    {
        errors.push(`diagnostics receipt status is invalid: ${receipt?.status}`);
    }
    if (receipt?.evidenceClass !== 'diagnostic' || receipt?.affectsCorrectness !== false)
    {
        errors.push('diagnostics receipt must be non-blocking diagnostic evidence');
    }
    if (!initializationReceipt || receipt?.sourceState)
    {
        errors.push(...sourceStateErrors(receipt?.sourceState, 'diagnostics sourceState'));
    }
    if (receipt?.contentDigest !== digestValue(receipt ?? {}))
    {
        errors.push('diagnostics receipt content digest mismatch');
    }
    if (!initializationReceipt || receipt?.buildBinding)
    {
        if (!sameSourceState(receipt?.sourceState, receipt?.buildBinding?.sourceState))
        {
            errors.push('diagnostics source/build identity mismatch');
        }
        if (!isDigest(receipt?.buildBinding?.receiptContentDigest))
        {
            errors.push('diagnostics build receipt digest is invalid');
        }
    }
    if (hasInitializationFailure)
    {
        if (!['source', 'build', 'fsusui'].includes(initializationFailure.stage))
        {
            errors.push('diagnostics initializationFailure.stage is invalid');
        }
        if (canonicalDiagnosticFailureClass(initializationFailure.failureClass) !== 'infra-failure')
        {
            errors.push('diagnostics initialization failure must be infra-failure');
        }
        if (typeof initializationFailure.failureKind !== 'string' || !initializationFailure.failureKind.trim())
        {
            errors.push('diagnostics initialization failureKind is missing');
        }
        if (typeof initializationFailure.message !== 'string' || !initializationFailure.message.trim())
        {
            errors.push('diagnostics initialization failure message is missing');
        }
    }
    else if (['incomplete', 'skipped'].includes(receipt?.status) && String(receipt?.incompleteReason ?? '').startsWith('initialization:'))
    {
        errors.push('diagnostics initialization receipt requires initializationFailure');
    }
    if (!['nightly', 'manual'].includes(receipt?.cadence))
    {
        errors.push('diagnostics cadence must be nightly or manual');
    }
    if (typeof receipt?.trigger?.kind !== 'string' || !receipt.trigger.kind.trim())
    {
        errors.push('diagnostics trigger is missing');
    }
    for (const key of ['browsers', 'viewports', 'themes', 'lanes'])
    {
        errors.push(...sortedUniqueErrors(receipt?.dimensions?.[key], `diagnostics dimensions.${key}`));
    }
    for (const key of ['planned', 'executed', 'skipped'])
    {
        if (!Number.isInteger(receipt?.counts?.[key]) || receipt.counts[key] < 0)
        {
            errors.push(`diagnostics counts.${key} is invalid`);
        }
    }
    if (Number.isInteger(receipt?.counts?.planned)
    && Number.isInteger(receipt?.counts?.executed)
    && Number.isInteger(receipt?.counts?.skipped)
    && receipt.counts.executed + receipt.counts.skipped !== receipt.counts.planned)
    {
        errors.push('diagnostics executed + skipped counts must equal planned');
    }
    if (['incomplete', 'skipped'].includes(receipt?.status) && !String(receipt?.incompleteReason ?? '').trim())
    {
        errors.push('incomplete diagnostics receipt requires incompleteReason');
    }
    if (!Number.isInteger(receipt?.crashRetryCount) || receipt.crashRetryCount < 0)
    {
        errors.push('diagnostics crashRetryCount is invalid');
    }
    errors.push(...sortedUniqueErrors(receipt?.failureClasses, 'diagnostics failureClasses', { allowEmpty: receipt?.status === 'success' }));
    if ((receipt?.failureClasses ?? []).some((value) => !['diagnostic', 'infra-failure', 'unstable-topology'].includes(value)))
    {
        errors.push('diagnostics failureClasses contains a non-canonical classification');
    }
    if (receipt?.failureClass !== null && !['diagnostic', 'infra-failure', 'unstable-topology'].includes(receipt?.failureClass))
    {
        errors.push('diagnostics failureClass is non-canonical');
    }
    const categories = Array.isArray(receipt?.categories) ? receipt.categories : [];
    if (categories.length === 0)
    {
        errors.push('diagnostics categories must be a non-empty array');
    }
    let observedCrashRetryCount = 0;
    let observedExecutedProbeCount = 0;
    let observedSkippedProbeCount = 0;
    let observedPlannedProbeCount = 0;
    let observedFailedProbeCount = 0;
    let observedRecoveredProbeCount = 0;
    const observedFailureClasses = [];
    const plannedBrowsers = [];
    const plannedViewports = [];
    const plannedThemes = [];
    const plannedLanes = [];
    for (const [categoryIndex, category] of categories.entries())
    {
        const categoryLabel = `diagnostics categories[${categoryIndex}]`;
        if (typeof category?.id !== 'string' || !category.id.trim())
        {
            errors.push(`${categoryLabel}.id is missing`);
        }
        errors.push(...sortedUniqueErrors(category?.browsers, `${categoryLabel}.browsers`));
        errors.push(...sortedUniqueErrors(category?.plannedProbeIds, `${categoryLabel}.plannedProbeIds`));
        errors.push(...sortedUniqueErrors(category?.plannedDimensions?.viewports, `${categoryLabel}.plannedDimensions.viewports`));
        errors.push(...sortedUniqueErrors(category?.plannedDimensions?.themes, `${categoryLabel}.plannedDimensions.themes`));
        plannedBrowsers.push(...(category?.browsers ?? []));
        plannedViewports.push(...(category?.plannedDimensions?.viewports ?? []));
        plannedThemes.push(...(category?.plannedDimensions?.themes ?? []));
        plannedLanes.push(...(category?.plannedProbeIds ?? []).map((probeId) => `${category.id}/${probeId}`));
        errors.push(...sortedUniqueErrors(category?.failureClasses, `${categoryLabel}.failureClasses`, { allowEmpty: ['success', 'skipped'].includes(category?.status) }));
        if ((category?.failureClasses ?? []).some((value) => !['diagnostic', 'infra-failure', 'unstable-topology'].includes(value)))
        {
            errors.push(`${categoryLabel}.failureClasses contains a non-canonical classification`);
        }
        observedFailureClasses.push(...(category?.failureClasses ?? []));
        const probes = Array.isArray(category?.probes) ? category.probes : [];
        if (probes.length === 0 && !['skipped', 'incomplete'].includes(category?.status))
        {
            errors.push(`${categoryLabel}.probes must be non-empty unless skipped/incomplete`);
        }
        if (!['success', 'failure', 'incomplete', 'skipped'].includes(category?.status))
        {
            errors.push(`${categoryLabel}.status is invalid`);
        }
        if (!Number.isInteger(category?.plannedProbeCount) || category.plannedProbeCount < 0)
        {
            errors.push(`${categoryLabel}.plannedProbeCount is invalid`);
        }
        if (!Number.isInteger(category?.executedProbeCount) || category.executedProbeCount !== probes.length)
        {
            errors.push(`${categoryLabel}.executedProbeCount must match probes`);
        }
        if (!Number.isInteger(category?.skippedProbeCount) || category.skippedProbeCount < 0)
        {
            errors.push(`${categoryLabel}.skippedProbeCount is invalid`);
        }
        if (Number.isInteger(category?.plannedProbeCount) && Number.isInteger(category?.skippedProbeCount)
      && probes.length + category.skippedProbeCount !== category.plannedProbeCount)
        {
            errors.push(`${categoryLabel} executed + skipped probes must equal plannedProbeCount`);
        }
        observedExecutedProbeCount += probes.length;
        observedSkippedProbeCount += Math.max(0, Number(category?.skippedProbeCount ?? 0));
        observedPlannedProbeCount += Math.max(0, Number(category?.plannedProbeCount ?? 0));
        let categoryFailedProbeCount = 0;
        for (const [probeIndex, probe] of probes.entries())
        {
            const probeLabel = `${categoryLabel}.probes[${probeIndex}]`;
            if (typeof probe?.id !== 'string' || !probe.id.trim())
            {
                errors.push(`${probeLabel}.id is missing`);
            }
            if (!(category?.plannedProbeIds ?? []).includes(probe?.id))
            {
                errors.push(`${probeLabel}.id is absent from plannedProbeIds`);
            }
            errors.push(...sortedUniqueErrors(probe?.plannedDimensions?.viewports, `${probeLabel}.plannedDimensions.viewports`));
            errors.push(...sortedUniqueErrors(probe?.plannedDimensions?.themes, `${probeLabel}.plannedDimensions.themes`));
            if ((probe?.plannedDimensions?.viewports ?? []).some((value) => !(category?.plannedDimensions?.viewports ?? []).includes(value)))
            {
                errors.push(`${probeLabel} planned viewports exceed the category plan`);
            }
            if ((probe?.plannedDimensions?.themes ?? []).some((value) => !(category?.plannedDimensions?.themes ?? []).includes(value)))
            {
                errors.push(`${probeLabel} planned themes exceed the category plan`);
            }
            const attempts = Array.isArray(probe?.attempts) ? probe.attempts : [];
            if (![1, 2].includes(attempts.length))
            {
                errors.push(`${probeLabel}.attempts must contain exactly one or two attempts`);
            }
            if (!['success', 'failure'].includes(probe?.status))
            {
                errors.push(`${probeLabel}.status is invalid`);
            }
            const failedAttempts = attempts.filter((attempt) => attempt?.status === 'failure');
            const recoveredProbe = isRecoveredDiagnosticProbe(probe);
            if (recoveredProbe)
            {
                observedRecoveredProbeCount += 1;
            }
            if (probe?.status === 'success' && failedAttempts.length > 0 && !recoveredProbe)
            {
                errors.push(`${probeLabel} success cannot contain a non-recovered failed attempt`);
            }
            if (probe?.status === 'success' && probe?.failureClass !== null && !recoveredProbe)
            {
                errors.push(`${probeLabel} success failureClass must be null unless crash-recovered`);
            }
            if (recoveredProbe && probe?.failureClass !== 'infra-failure')
            {
                errors.push(`${probeLabel} recovered probe failureClass must remain infra-failure`);
            }
            if (probe?.status === 'failure' && failedAttempts.length === 0)
            {
                errors.push(`${probeLabel} failure requires a failed attempt`);
            }
            if (probe?.status === 'failure' && !['diagnostic', 'infra-failure', 'unstable-topology'].includes(probe?.failureClass))
            {
                errors.push(`${probeLabel} failureClass is invalid`);
            }
            if (probe?.status === 'failure')
            {
                categoryFailedProbeCount += 1;
                observedFailedProbeCount += 1;
            }
            const crashRetryCount = Number(probe?.crashRetryCount);
            if (!Number.isInteger(crashRetryCount) || ![0, 1].includes(crashRetryCount))
            {
                errors.push(`${probeLabel}.crashRetryCount must be 0 or 1`);
            }
            else
            {
                observedCrashRetryCount += crashRetryCount;
            }
            for (const [attemptIndex, attempt] of attempts.entries())
            {
                const attemptLabel = `${probeLabel}.attempts[${attemptIndex}]`;
                if (attempt?.attempt !== attemptIndex + 1)
                {
                    errors.push(`${attemptLabel}.attempt must be ${attemptIndex + 1}`);
                }
                if (!['success', 'failure'].includes(attempt?.status))
                {
                    errors.push(`${attemptLabel}.status is invalid`);
                }
                errors.push(...sortedUniqueErrors(attempt?.testIds, `${attemptLabel}.testIds`));
                errors.push(...sortedUniqueErrors(attempt?.artifacts, `${attemptLabel}.artifacts`));
                if (attempt?.status === 'success')
                {
                    if (attempt?.failureClass !== null)
                    {
                        errors.push(`${attemptLabel} successful attempt failureClass must be null`);
                    }
                    if (attempt?.failureKind !== null)
                    {
                        errors.push(`${attemptLabel} successful attempt failureKind must be null`);
                    }
                }
                else
                {
                    if (!['diagnostic', 'infra-failure', 'unstable-topology'].includes(attempt?.failureClass))
                    {
                        errors.push(`${attemptLabel} failed attempt failureClass is invalid`);
                    }
                    if (typeof attempt?.failureKind !== 'string' || !attempt.failureKind.trim())
                    {
                        errors.push(`${attemptLabel} failed attempt failureKind is missing`);
                    }
                }
            }
            const firstAttempt = attempts[0];
            if (attempts.length === 2 || crashRetryCount === 1)
            {
                if (attempts.length !== 2 || crashRetryCount !== 1)
                {
                    errors.push(`${probeLabel} retry attempts/crashRetryCount mismatch`);
                }
                if (firstAttempt?.status !== 'failure'
          || firstAttempt?.failureClass !== 'infra-failure'
          || firstAttempt?.failureKind !== 'browser-process-crash')
                {
                    errors.push(`${probeLabel} retry is allowed only after an explicit browser-process-crash`);
                }
                if (attempts.at(-1)?.status === 'success' && probe?.finalStatus !== 'diagnostic-passed-after-infra-retry')
                {
                    errors.push(`${probeLabel} recovered crash retry requires diagnostic-passed-after-infra-retry finalStatus`);
                }
            }
            const unstableTopology = differentFailedAttemptTestIds(attempts);
            if (unstableTopology && probe?.failureClass !== 'unstable-topology')
            {
                errors.push(`${probeLabel} different failed test IDs must be unstable-topology`);
            }
            if (!unstableTopology && probe?.failureClass === 'unstable-topology')
            {
                errors.push(`${probeLabel} unstable-topology requires different failed test IDs`);
            }
        }
        const categoryRecoveredOnly = probes.some(isRecoveredDiagnosticProbe)
      && probes.every((probe) => probe?.status === 'success')
      && (category?.failureClasses ?? []).every((failureClass) => failureClass === 'infra-failure');
        if (category?.status === 'success'
      && (categoryFailedProbeCount > 0 || (category?.failureClasses ?? []).length > 0)
      && !categoryRecoveredOnly)
        {
            errors.push(`${categoryLabel} success cannot contain failed probes or failureClasses unless crash-recovered`);
        }
        if (category?.status === 'failure' && (categoryFailedProbeCount === 0 || (category?.failureClasses ?? []).length === 0))
        {
            errors.push(`${categoryLabel} failure requires a failed probe and failureClasses`);
        }
        if (category?.status === 'skipped' && probes.length > 0)
        {
            errors.push(`${categoryLabel} skipped category cannot contain executed probes`);
        }
        if (probes.length === (category?.plannedProbeIds ?? []).length)
        {
            const probeViewportUnion = sortedUnique(probes.flatMap((probe) => probe?.plannedDimensions?.viewports ?? []));
            const probeThemeUnion = sortedUnique(probes.flatMap((probe) => probe?.plannedDimensions?.themes ?? []));
            if (JSON.stringify(probeViewportUnion) !== JSON.stringify(category?.plannedDimensions?.viewports ?? []))
            {
                errors.push(`${categoryLabel}.plannedDimensions.viewports must equal its probe union`);
            }
            if (JSON.stringify(probeThemeUnion) !== JSON.stringify(category?.plannedDimensions?.themes ?? []))
            {
                errors.push(`${categoryLabel}.plannedDimensions.themes must equal its probe union`);
            }
        }
    }
    if (Number.isInteger(receipt?.crashRetryCount) && receipt.crashRetryCount !== observedCrashRetryCount)
    {
        errors.push('diagnostics crashRetryCount does not match probe attempts');
    }
    if (receipt?.counts?.planned !== observedPlannedProbeCount)
    {
        errors.push('diagnostics planned count does not match categories');
    }
    if (receipt?.counts?.executed !== observedExecutedProbeCount)
    {
        errors.push('diagnostics executed count does not match categories');
    }
    if (receipt?.counts?.skipped !== observedSkippedProbeCount)
    {
        errors.push('diagnostics skipped count does not match categories');
    }
    const expectedDimensions = {
        browsers: sortedUnique(plannedBrowsers),
        viewports: sortedUnique(plannedViewports),
        themes: sortedUnique(plannedThemes),
        lanes: sortedUnique(plannedLanes)
    };
    for (const key of ['browsers', 'viewports', 'themes', 'lanes'])
    {
        if (JSON.stringify(receipt?.dimensions?.[key] ?? []) !== JSON.stringify(expectedDimensions[key]))
        {
            errors.push(`diagnostics dimensions.${key} does not match planned category/probe dimensions`);
        }
    }
    const canonicalObservedFailureClasses = sortedUnique(observedFailureClasses);
    if (JSON.stringify(receipt?.failureClasses ?? []) !== JSON.stringify(canonicalObservedFailureClasses))
    {
        errors.push('diagnostics top-level failureClasses do not match category evidence');
    }
    const expectedFailureClass = canonicalObservedFailureClasses.includes('infra-failure')
        ? 'infra-failure'
        : canonicalObservedFailureClasses[0] ?? null;
    if (receipt?.status === 'success')
    {
        if (categories.some((category) => category?.status !== 'success') || observedFailedProbeCount > 0)
        {
            errors.push('diagnostics success requires every category/probe/attempt to succeed');
        }
        if (observedRecoveredProbeCount > 0)
        {
            if (receipt?.finalStatus !== 'diagnostic-passed-after-infra-retry')
            {
                errors.push('diagnostics recovered success requires diagnostic-passed-after-infra-retry finalStatus');
            }
            if (receipt?.failureClass !== 'infra-failure' || canonicalObservedFailureClasses.some((value) => value !== 'infra-failure'))
            {
                errors.push('diagnostics recovered success must preserve only infra-failure classification');
            }
        }
        else if (canonicalObservedFailureClasses.length > 0 || receipt?.failureClass !== null)
        {
            errors.push('diagnostics clean success cannot contain failure classifications');
        }
        if (receipt?.counts?.skipped !== 0)
        {
            errors.push('diagnostics success cannot skip probes');
        }
    }
    else if (receipt?.status === 'failure')
    {
        if (observedFailedProbeCount === 0 || !categories.some((category) => category?.status === 'failure'))
        {
            errors.push('diagnostics failure requires a failed category and probe');
        }
        if (receipt?.counts?.skipped !== 0)
        {
            errors.push('diagnostics failure with skipped probes must be incomplete');
        }
        if (receipt?.failureClass !== expectedFailureClass)
        {
            errors.push('diagnostics failureClass does not match nested evidence');
        }
    }
    else if (receipt?.status === 'incomplete')
    {
        if (receipt?.counts?.skipped === 0 && !hasInitializationFailure)
        {
            errors.push('incomplete diagnostics receipt must skip probes or record initializationFailure');
        }
    }
    else if (receipt?.status === 'skipped')
    {
        if (receipt?.counts?.executed !== 0 || receipt?.counts?.skipped !== receipt?.counts?.planned)
        {
            errors.push('skipped diagnostics receipt must skip every planned probe');
        }
    }
    for (const key of ['screenshots', 'traces', 'performance', 'all'])
    {
        errors.push(...sortedUniqueErrors(receipt?.artifacts?.[key], `diagnostics artifacts.${key}`, { allowEmpty: true }));
    }
    if (expectedCommit && receipt?.sourceState?.commit !== expectedCommit)
    {
        errors.push('diagnostics commit mismatch');
    }
    if (expectedFingerprint && normalizeFingerprint(receipt?.sourceState?.worktreeFingerprint) !== normalizeFingerprint(expectedFingerprint))
    {
        errors.push('diagnostics source fingerprint mismatch');
    }
    if (expectedBuildReceiptDigest && receipt?.buildBinding?.receiptContentDigest !== expectedBuildReceiptDigest)
    {
        errors.push('diagnostics build receipt digest mismatch');
    }
    return errors;
}

export function assertReleaseFinalBehaviorIdentity({
    preRuntimeReceipt: pre,
    postRuntimeReceipt: post,
    releaseCommit,
    expectedWorktreeFingerprint = null
})
{
    if (!pre?.runIdentity || !pre?.sourceIdentity?.worktreeFingerprint
        || post?.sourceIdentity?.commit !== releaseCommit)
    {
        throw new Error('post-runtime behavior evidence source commit mismatch or missing identity');
    }
    if (post.preRuntimeReceiptDigest !== pre.contentDigest)
    {
        throw new Error('post-runtime behavior evidence pre-runtime receipt mismatch');
    }
    if (post.runIdentity !== pre.runIdentity
        || post.sourceIdentity.commit !== pre.sourceIdentity?.commit
        || post.sourceIdentity.worktreeFingerprint !== pre.sourceIdentity.worktreeFingerprint
        || (expectedWorktreeFingerprint !== null
            && normalizeFingerprint(pre.sourceIdentity.worktreeFingerprint)
                !== normalizeFingerprint(expectedWorktreeFingerprint)))
    {
        throw new Error('pre/post-runtime behavior evidence identity mismatch');
    }
}

export function createReleaseFinalTestEvidenceBinding({
    commitSha,
    buildReceipt,
    buildReceiptPath,
    correctnessReceipt,
    correctnessReceiptPath,
    browserContractReceipt,
    browserContractReceiptPath,
    preRuntimeReceipt,
    preRuntimeReceiptPath,
    postRuntimeReceipt,
    postRuntimeReceiptPath,
    consistencyFinalReport,
    consistencyFinalReportPath,
    releaseDomainProjectionReceipts,
    releaseReliabilityQualifiedReceipt,
    requiredEvidenceCatalogBinding,
    locatorEvidence = null,
    now = () => new Date()
})
{
    const build = productionBuildBinding(buildReceipt, buildReceiptPath);
    const correctnessErrors = validateBrowserlessCorrectnessReceipt(correctnessReceipt, {
        expectedCommit: commitSha,
        expectedFingerprint: build.sourceState.worktreeFingerprint,
        expectedBuildReceiptDigest: build.receiptContentDigest
    });
    const contractErrors = validateBrowserContractReceipt(browserContractReceipt, {
        expectedCommit: commitSha,
        expectedFingerprint: build.sourceState.worktreeFingerprint,
        expectedBuildReceiptDigest: build.receiptContentDigest,
        requireSuccess: true
    });
    if (correctnessReceipt?.authority?.kind === 'scheduler-checkpoint'
    && correctnessReceipt.authority.authoritative !== true)
    {
        correctnessErrors.push('release-final requires an authoritative scheduler correctness checkpoint');
    }
    if (correctnessErrors.length > 0 || contractErrors.length > 0)
    {
        throw new Error([...correctnessErrors, ...contractErrors].join('; '));
    }
    assertPreRuntimeQualified(preRuntimeReceipt);
    const qualifiedPostRuntime = validatePostRuntimeReceipt(postRuntimeReceipt);
    if (qualifiedPostRuntime.status !== 'ok')
    {
        throw new Error(`post-runtime behavior evidence is not qualified: ${qualifiedPostRuntime.failureReasons.join('; ')}`);
    }
    assertReleaseFinalBehaviorIdentity({
        preRuntimeReceipt,
        postRuntimeReceipt,
        releaseCommit: commitSha,
        expectedWorktreeFingerprint: build.sourceState.worktreeFingerprint
    });
    const preRuntimeInput = readBoundBehaviorReceipt(
        preRuntimeReceiptPath, preRuntimeReceipt, assertPreRuntimeQualified
    );
    const postRuntimeInput = readBoundBehaviorReceipt(
        postRuntimeReceiptPath, postRuntimeReceipt, validatePostRuntimeReceipt
    );
    const releaseDomains = createReleaseDomainProjectionBindings(
        releaseDomainProjectionReceipts
    );
    const reliabilityErrors = validateReleaseReliabilityQualifiedBinding(
        releaseReliabilityQualifiedReceipt,
        {
            expectedCommit: commitSha,
            expectedWorktreeFingerprint: build.sourceState.worktreeFingerprint,
            expectedBuildReceiptContentDigest: build.receiptContentDigest
        }
    );
    if (reliabilityErrors.length > 0)
    {
        throw new Error(reliabilityErrors.join('; '));
    }
    const requiredEvidenceCatalogErrors =
        validateRequiredEvidenceCatalogBinding(requiredEvidenceCatalogBinding);
    if (requiredEvidenceCatalogErrors.length > 0)
    {
        throw new Error(requiredEvidenceCatalogErrors.join('; '));
    }
    return seal({
        schema: releaseFinalTestEvidenceBindingSchema,
        status: 'ok',
        releaseCommit: commitSha,
        sourceState: build.sourceState,
        build,
        receipts: {
            correctness: {
                schema: correctnessReceipt.schema,
                path: String(correctnessReceiptPath).replaceAll(path.sep, '/'),
                fileDigest: sha256File(correctnessReceiptPath),
                contentDigest: correctnessReceipt.contentDigest
            },
            browserContract: {
                schema: browserContractReceipt.schema,
                path: String(browserContractReceiptPath).replaceAll(path.sep, '/'),
                fileDigest: sha256File(browserContractReceiptPath),
                contentDigest: browserContractReceipt.contentDigest
            },
            behaviorPostRuntime: {
                schema: postRuntimeReceipt.schema,
                path: String(postRuntimeReceiptPath).replaceAll(path.sep, '/'),
                fileDigest: postRuntimeInput.fileDigest,
                contentDigest: postRuntimeInput.receipt.contentDigest
            },
            behaviorPreRuntime: {
                schema: preRuntimeReceipt.schema,
                path: String(preRuntimeReceiptPath).replaceAll(path.sep, '/'),
                fileDigest: preRuntimeInput.fileDigest,
                contentDigest: preRuntimeInput.receipt.contentDigest
            },
            behaviorConsistencyFinal: {
                schema: consistencyFinalReport.schema,
                path: String(consistencyFinalReportPath).replaceAll(path.sep, '/'),
                fileDigest: sha256File(consistencyFinalReportPath),
                contentDigest: consistencyFinalReport.contentDigest
            },
            releaseReliability: structuredClone(
                releaseReliabilityQualifiedReceipt
            ),
            releaseDomains
        },
        requiredEvidenceCatalog: structuredClone(requiredEvidenceCatalogBinding),
        locatorEvidence: locatorEvidence ? structuredClone(locatorEvidence) : null,
        generatedAt: now().toISOString()
    });
}

export function validateReleaseFinalTestEvidenceBinding(binding)
{
    const errors = [];
    if (binding?.schema !== releaseFinalTestEvidenceBindingSchema)
    {
        errors.push(`unexpected release-final test evidence binding schema: ${binding?.schema ?? 'missing'}`);
    }
    if (binding?.status !== 'ok')
    {
        errors.push(`release-final test evidence binding status must be ok, got ${binding?.status}`);
    }
    errors.push(...sourceStateErrors(binding?.sourceState, 'release-final binding sourceState'));
    if (binding?.contentDigest !== digestValue(binding ?? {}))
    {
        errors.push('release-final test evidence binding digest mismatch');
    }
    if (binding?.releaseCommit !== binding?.sourceState?.commit)
    {
        errors.push('release-final binding release/source commit mismatch');
    }
    if (!sameSourceState(binding?.sourceState, binding?.build?.sourceState))
    {
        errors.push('release-final binding source/build identity mismatch');
    }
    for (const key of [
        'correctness',
        'browserContract',
        'behaviorPreRuntime',
        'behaviorPostRuntime',
        'behaviorConsistencyFinal'
    ])
    {
        if (!isDigest(binding?.receipts?.[key]?.fileDigest))
        {
            errors.push(`release-final binding ${key} file digest is invalid`);
        }
        if (!isDigest(binding?.receipts?.[key]?.contentDigest))
        {
            errors.push(`release-final binding ${key} content digest is invalid`);
        }
    }
    if (binding?.receipts?.behaviorPostRuntime?.schema
        !== 'fsusblog.behavior-evidence-post-runtime-receipt.v1')
    {
        errors.push('release-final binding behaviorPostRuntime schema is invalid');
    }
    if (binding?.receipts?.behaviorPreRuntime?.schema
        !== 'fsusblog.behavior-evidence-pre-runtime-receipt.v1')
    {
        errors.push('release-final binding behaviorPreRuntime schema is invalid');
    }
    if (binding?.receipts?.behaviorConsistencyFinal?.schema
        !== 'fsusblog.behavior-document-consistency-final-report.v1')
    {
        errors.push('release-final binding behaviorConsistencyFinal schema is invalid');
    }
    errors.push(...validateReleaseReliabilityQualifiedBinding(
        binding?.receipts?.releaseReliability,
        {
            expectedCommit: binding?.releaseCommit,
            expectedWorktreeFingerprint:
                binding?.sourceState?.worktreeFingerprint,
            expectedBuildReceiptContentDigest:
                binding?.build?.receiptContentDigest
        }
    ));
    errors.push(...validateReleaseDomainProjectionBindings(
        binding?.receipts?.releaseDomains
    ));
    errors.push(...validateRequiredEvidenceCatalogBinding(
        binding?.requiredEvidenceCatalog
    ));
    if (binding?.locatorEvidence !== null)
    {
        if (!isDigest(binding?.locatorEvidence?.manifestInputDigest)
            || !isDigest(binding?.locatorEvidence?.manifestBindingReceipt?.bindingDigest)
            || !isDigest(binding?.locatorEvidence?.directParentBindingReceipt?.bindingDigest))
        {
            errors.push('release-final locator evidence digests are invalid');
        }
        const directDigests = binding?.locatorEvidence?.directInputDigests;
        if (!directDigests || Object.keys(directDigests).length !== 7
            || Object.values(directDigests).some((digest) => !isDigest(digest)))
        {
            errors.push('release-final locator direct input digests are incomplete');
        }
    }
    return errors;
}

export function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}


export const releaseFinalVerifiedAuthorityBindingSchema = 'fsusblog.release-final-test-evidence-binding.v2';

export class ReleaseFinalAuthorityBindingError extends Error
{
    constructor(reasonCode, message, localProducerCommands = [])
    {
        super(message);
        this.name = 'ReleaseFinalAuthorityBindingError';
        this.reasonCode = reasonCode;
        this.localProducerCommands = localProducerCommands;
    }
}

// The existing final-binding owner now has a source-stage consumer for #2060
// bindings. This does not publish a manifest or replace the scheduler's CAS.
// A caller must supply the independently expected plan/run and original input
// refs; no producer discovery or callback can qualify a forged binding.
export async function createReleaseFinalVerifiedAuthorityBinding(options)
{
    const { governanceContentDigest, validateCurrentRunEvidenceContext } = await import(new URL('../test/evidence-location-contract.mjs', import.meta.url));
    const { validateRequiredEvidenceTestPlan } = await import(new URL('../test-matrix/required-evidence-dependencies.mjs', import.meta.url));
    const { locateCurrentRunEvidence, verifyCurrentRunEvidenceBinding } = await import(new URL('../test/current-run-evidence-locator.mjs', import.meta.url));
    const { resolveEvidenceReferencePayload } = await import(new URL('../test/current-run-evidence-publication.mjs', import.meta.url));
    const { requiredEvidenceBindingSchema, verifyRequiredEvidenceBinding } = await import('./required-evidence-binding.mjs');
    const allowed = ['bindingInputs', 'catalog', 'context', 'expectedPlanIdentity', 'locatorRegistry',
        'repositoryRoot', 'testPlan', 'verifierRegistry'];
    if (!options || Object.keys(options).some((key) => !allowed.includes(key)))
    {
        throw new ReleaseFinalAuthorityBindingError('UNSUPPORTED_INPUT', 'final binding accepts only explicit authority inputs');
    }
    const { bindingInputs, catalog, context, expectedPlanIdentity, locatorRegistry,
        repositoryRoot, testPlan, verifierRegistry } = options;
    const commands = catalog?.entries?.map((entry) => entry.localProducerCommand) ?? [];
    const requireCheck = (condition, code, message, localCommands = commands) =>
    {
        if (!condition)
        {
            throw new ReleaseFinalAuthorityBindingError(code, message, localCommands);
        }
    };
    validateCurrentRunEvidenceContext(context);
    requireCheck(expectedPlanIdentity?.mode === 'current-run'
        && expectedPlanIdentity.sourceCommit === context.sourceCommit
        && expectedPlanIdentity.worktreeFingerprint === context.worktreeFingerprint
        && expectedPlanIdentity.runId === context.schedulerRunId
        && expectedPlanIdentity.attempt === context.attemptId
        && JSON.stringify(canonicalize(expectedPlanIdentity.candidateIdentity))
            === JSON.stringify(canonicalize(context.candidateIdentity)),
    'PLAN_IDENTITY_MISMATCH', 'final binding requires independently supplied current-run plan identity');
    const errors = validateRequiredEvidenceTestPlan(testPlan, expectedPlanIdentity, catalog);
    requireCheck(errors.length === 0, 'PLAN_REJECTED', errors.join('; '));
    requireCheck(Array.isArray(bindingInputs), 'MISSING_BINDINGS', 'explicit authority binding inputs are required');
    const projection = testPlan.requiredEvidenceDependencies;
    const expected = projection.dependencies;
    const actualIds = bindingInputs.map((input) => input?.authorityId);
    requireCheck(new Set(actualIds).size === actualIds.length, 'DUPLICATE_AUTHORITY', 'duplicate authority binding inputs');
    requireCheck(actualIds.every((id) => expected.some((entry) => entry.authorityId === id)),
        'UNDECLARED_AUTHORITY', 'undeclared correctness input cannot enter the final binding');
    const missing = expected.filter((entry) => !actualIds.includes(entry.authorityId));
    requireCheck(missing.length === 0, 'MISSING_BINDINGS',
        `missing authority bindings: ${missing.map((entry) => entry.authorityId).join(', ')}`,
        missing.map((entry) => entry.localProducerCommand));
    const authorities = [];
    for (const dependency of expected)
    {
        const matches = bindingInputs.filter((input) => input.authorityId === dependency.authorityId);
        const [input] = matches;
        const localCommands = [dependency.localProducerCommand];
        requireCheck(matches.length === 1 && input.outputBindingKey === dependency.outputBindingKey
            && Object.keys(input).every((key) => ['authorityId', 'outputBindingKey', 'explicitInputs',
                'reference', 'verification'].includes(key)),
        'OUTPUT_BINDING_MISMATCH', `${dependency.authorityId}: exact projected binding slot is required`, localCommands);
        requireCheck(input.verification && Object.keys(input.verification).every((key) =>
            ['domainInputs', 'expectedIdentity', 'explicitInputs', 'reference'].includes(key)),
        'UNSUPPORTED_VERIFICATION_INPUT', `${dependency.authorityId}: explicit original producer inputs are required`, localCommands);
        if (dependency.requiredIdentityFields.includes('namespace'))
        {
            requireCheck(input.verification.expectedIdentity?.namespace === expectedPlanIdentity.namespace,
                'PLAN_NAMESPACE_MISMATCH', `${dependency.authorityId}: expected namespace differs from the plan`, localCommands);
        }
        const locators = locatorRegistry.entries.filter((entry) => entry.authorityId === dependency.locatorBindingKey);
        requireCheck(locators.length === 1 && locators[0].producerId === dependency.canonicalOwner,
            'LOCATOR_OWNER_MISMATCH', `${dependency.authorityId}: exact canonical locator is required`, localCommands);
        try
        {
            const [registryEntry] = locators;
            const located = locateCurrentRunEvidence({ context, registry: locatorRegistry, registryEntry,
                repositoryRoot, ...(input.explicitInputs === undefined ? {} : { explicitInputs: input.explicitInputs }),
                ...(input.reference === undefined ? {} : { reference: input.reference }) });
            verifyCurrentRunEvidenceBinding(located.bindingReceipt,
                { context, registry: locatorRegistry, registryEntry, repositoryRoot });
            const resolved = resolveEvidenceReferencePayload(located.receipt,
                { repositoryRoot, ownedRoots: context.ownedRoots });
            const binding = resolved.payload;
            requireCheck(binding?.schema === requiredEvidenceBindingSchema
                && binding.authorityId === dependency.authorityId && binding.status === 'success'
                && binding.qualificationEligible === true && binding.reasonCodes?.length === 0,
            'BINDING_NOT_SUCCESS', `${dependency.authorityId}: required binding is not successful`, localCommands);
            await verifyRequiredEvidenceBinding(binding, { ...input.verification,
                authorityId: dependency.authorityId, catalog, context, locatorRegistry,
                repositoryRoot, verifierRegistry });
            authorities.push({ authorityId: dependency.authorityId,
                producerId: dependency.canonicalOwner, outputBindingKey: dependency.outputBindingKey,
                bindingReference: { path: path.relative(repositoryRoot, resolved.file).replaceAll(path.sep, '/'),
                    schema: binding.schema, fileDigest: located.receipt.payload.digest, contentDigest: binding.contentDigest },
                bindingLocator: located.bindingReceipt, verifiedBinding: structuredClone(binding) });
        }
        catch (error)
        {
            if (error instanceof ReleaseFinalAuthorityBindingError)
            {
                throw error;
            }
            throw new ReleaseFinalAuthorityBindingError(error.reasonCode ?? 'BINDING_REJECTED',
                `${dependency.authorityId}: ${error.message}`, localCommands);
        }
    }
    const body = { schema: releaseFinalVerifiedAuthorityBindingSchema,
        status: 'verified-bindings-unpublished', qualificationEligible: false,
        catalog: structuredClone(projection.catalog), catalogVersion: projection.catalogVersion,
        testPlanDigest: testPlan.contentDigest, projectionDigest: projection.contentDigest,
        context: structuredClone(context), planIdentity: structuredClone(expectedPlanIdentity),
        authorities, reasonCodes: [], publicationRequired: 'canonical-scheduler-CAS',
        failurePath: 'fail-closed-without-fallback' };
    const result = { ...body, contentDigest: governanceContentDigest(body) };
    const freeze = (value) =>
    {
        if (value && typeof value === 'object')
        {
            Object.values(value).forEach(freeze);
            Object.freeze(value);
        }
        return value;
    };
    return freeze(result);
}

export async function verifyReleaseFinalVerifiedAuthorityBinding(binding, options)
{
    const { governanceContentDigest } = await import(new URL('../test/evidence-location-contract.mjs', import.meta.url));
    if (binding?.schema !== releaseFinalVerifiedAuthorityBindingSchema
        || binding.contentDigest !== governanceContentDigest(binding))
    {
        throw new ReleaseFinalAuthorityBindingError('FINAL_BINDING_TAMPER', 'final binding schema/digest mismatch');
    }
    const replayed = await createReleaseFinalVerifiedAuthorityBinding(options);
    if (JSON.stringify(canonicalize(replayed)) !== JSON.stringify(canonicalize(binding)))
    {
        throw new ReleaseFinalAuthorityBindingError('FINAL_BINDING_REPLAY_MISMATCH', 'final binding differs from fresh authority verification');
    }
    return replayed;
}

// Read-only prerequisite assessment, not a receipt or a new manifest authority.
// Publication pointers prove publication state, not scheduler journal/CAS commit.
export async function assessReleaseFinalTerminalPrerequisites(options)
{
    const requireInput = (condition, message) =>
    {
        if (!condition)
        {
            throw new ReleaseFinalAuthorityBindingError('UNSUPPORTED_INPUT', message);
        }
    };
    requireInput(options && typeof options === 'object' && !Array.isArray(options)
        && Object.keys(options).every((key) => ['bindings', 'finalOutput', 'durableCommit'].includes(key)),
    'terminal intake accepts only explicit bindings, finalOutput and durableCommit inputs');
    const { bindings, finalOutput, durableCommit } = options;
    if (finalOutput !== undefined)
    {
        requireInput(finalOutput && typeof finalOutput === 'object' && !Array.isArray(finalOutput)
            && Object.keys(finalOutput).every((key) => ['explicitInputs', 'reference'].includes(key)),
        'finalOutput accepts only canonical locator inputs');
        requireInput((finalOutput.explicitInputs === undefined || (Array.isArray(finalOutput.explicitInputs)
            && finalOutput.explicitInputs.every((input) => typeof input === 'string')))
            && (finalOutput.reference === undefined || (finalOutput.reference
                && typeof finalOutput.reference === 'object' && !Array.isArray(finalOutput.reference)
                && Object.keys(finalOutput.reference).every((key) => ['path', 'objectDigest'].includes(key)))),
        'finalOutput accepts only typed explicit paths or content-addressed references');
    }
    if (durableCommit !== undefined)
    {
        requireInput(durableCommit && typeof durableCommit === 'object' && !Array.isArray(durableCommit)
            && Object.keys(durableCommit).every((key) => ['reference', 'expectedRevision'].includes(key))
            && Number.isSafeInteger(durableCommit.expectedRevision) && durableCommit.expectedRevision > 0
            && durableCommit.reference && typeof durableCommit.reference === 'object'
            && !Array.isArray(durableCommit.reference)
            && Object.keys(durableCommit.reference).every((key) => ['path', 'digest'].includes(key)),
        'durableCommit requires an explicit owned reference and independently expected revision');
    }
    const assessment = { status: 'blocked', qualificationEligible: false,
        reasonCodes: [], localProducerCommands: [], missingContracts: [], observations: {} };
    const refuse = (error, fallbackCode) =>
    {
        const missing = ['MISSING_BINDINGS', 'MISSING_EVIDENCE'].includes(error.reasonCode) || error.code === 'ENOENT'
            || error.message === 'exact-one evidence input is missing';
        assessment.status = missing ? 'blocked' : 'rejected';
        assessment.reasonCodes.push(error.reasonCode ?? fallbackCode);
        assessment.localProducerCommands = [...(error.localProducerCommands ?? [])];
        assessment.failure = error.message;
    };
    const freeze = (value) =>
    {
        if (value && typeof value === 'object')
        {
            Object.values(value).forEach(freeze);
            Object.freeze(value);
        }
        return value;
    };
    let verified;
    try
    {
        verified = await createReleaseFinalVerifiedAuthorityBinding(bindings);
        await verifyReleaseFinalVerifiedAuthorityBinding(verified, bindings);
    }
    catch (error)
    {
        refuse(error, 'BINDING_REJECTED');
        return freeze(assessment);
    }
    assessment.observations.bindingDigest = verified.contentDigest;
    if (finalOutput !== undefined)
    {
        try
        {
            const requirePublication = (condition, message) =>
            {
                if (!condition)
                {
                    throw new ReleaseFinalAuthorityBindingError('FINAL_OUTPUT_REJECTED', message);
                }
            };
            const { locateCurrentRunEvidence, verifyCurrentRunEvidenceBinding } = await import(new URL('../test/current-run-evidence-locator.mjs', import.meta.url));
            const { readCurrentRunEvidencePublication, resolveEvidenceReferencePayload } = await import(new URL('../test/current-run-evidence-publication.mjs', import.meta.url));
            const entries = bindings.locatorRegistry.entries.filter((entry) =>
                entry.consumerId === 'evidence-consumer.release.check-release-final');
            requirePublication(entries.length === 1, 'existing finalizer input locator must be exact-one');
            const [registryEntry] = entries;
            const located = locateCurrentRunEvidence({ ...finalOutput, context: bindings.context,
                registry: bindings.locatorRegistry, registryEntry, repositoryRoot: bindings.repositoryRoot });
            verifyCurrentRunEvidenceBinding(located.bindingReceipt, { context: bindings.context,
                registry: bindings.locatorRegistry, registryEntry, repositoryRoot: bindings.repositoryRoot });
            const resolved = resolveEvidenceReferencePayload(located.receipt,
                { repositoryRoot: bindings.repositoryRoot, ownedRoots: bindings.context.ownedRoots });
            const publication = readCurrentRunEvidencePublication({
                outputPath: located.bindingReceipt.input.path, repositoryRoot: bindings.repositoryRoot });
            requirePublication(publication.state.state === 'finalized', 'finalizer input publication is not finalized');
            for (const field of ['authorityId', 'producerId', 'schedulerRunId', 'attemptId',
                'sourceCommit', 'worktreeFingerprint', 'candidateIdentity', 'buildIdentity'])
            {
                requirePublication(JSON.stringify(canonicalize(publication.state[field]))
                    === JSON.stringify(canonicalize(located.receipt[field])),
                `finalizer input publication ${field} mismatch`);
            }
            const outputPath = path.relative(bindings.repositoryRoot,
                path.resolve(bindings.repositoryRoot, located.bindingReceipt.input.path)).replaceAll(path.sep, '/');
            requirePublication(publication.state.outputPath === outputPath
                && publication.state.payloadPath === located.receipt.payload.path
                && publication.state.reference?.inputDigest === located.bindingReceipt.inputDigest
                && publication.state.reference?.contentDigest === located.receipt.contentDigest
                && publication.state.reference?.producerReceiptDigest === located.receipt.producerReceiptDigest,
            'finalizer input publication reference mismatch');
            assessment.observations.finalizerInput = { authorityId: registryEntry.authorityId,
                producerId: registryEntry.producerId, producerExecutable: registryEntry.producerExecutable,
                outputBindingKey: registryEntry.outputBindingKey, locator: located.bindingReceipt,
                payloadSchema: resolved.payload.schema, publicationDigest: publication.state.contentDigest };
        }
        catch (error)
        {
            refuse(error, 'FINAL_OUTPUT_REJECTED');
            return freeze(assessment);
        }
    }
    if (durableCommit !== undefined)
    {
        try
        {
            const { readOwnerEvidenceReference } = await import('./required-evidence-owner-input.mjs');
            const inspected = readOwnerEvidenceReference(durableCommit.reference,
                { repositoryRoot: bindings.repositoryRoot, context: bindings.context });
            assessment.observations.durableCommitInput = { reference: structuredClone(durableCommit.reference),
                inputDigest: inspected.digest, expectedRevision: durableCommit.expectedRevision };
        }
        catch (error)
        {
            refuse(error, 'PERSISTENCE_INPUT_REJECTED');
            return freeze(assessment);
        }
    }
    // The registered finalizer authority currently denotes collector INPUT.
    // Do not relabel it as final output, trust raw checkpoint success/revision,
    // accept a supplied callback, or invent a producer/receipt for either gap.
    assessment.reasonCodes.push('CANONICAL_FINAL_OUTPUT_UNAVAILABLE', 'DURABLE_COMMIT_READBACK_UNAVAILABLE');
    assessment.missingContracts.push({ owner: 'tools/test/generate-evidence-location-governance.mjs',
        fields: ['finalOutput.authorityId', 'finalOutput.producerId', 'finalOutput.producerExecutable',
            'finalOutput.outputBindingKey', 'finalOutput.payloadSchema'],
        existingInputProducer: 'tools/operations/collect-release-evidence.sh' },
    { owner: 'tools/test-matrix/scheduler.mjs',
        fields: ['durableCommit.readbackVerifier', 'durableCommit.committedRevision',
            'durableCommit.finalOutputRef', 'durableCommit.finalOutputDigest'],
        existingWriteApi: 'attachCheckpointCurrentRunEvidence', privateReadApi: 'readCheckpoint' });
    return freeze(assessment);
}

export const requiredEvidenceVerifier = Object.freeze({
    version: 1,
    successStatuses: Object.freeze(['success']),
    describe: async (receipt) => (await import('./required-evidence-owner-contract.mjs')).describeOwnerReceipt(receipt, {
        identity: { namespace: 'namespace', runId: 'authority.runId',
            sourceCommit: 'sourceState.commit', worktreeFingerprint: 'sourceState.worktreeFingerprint' },
        status: 'status', contentDigest: 'contentDigest'
    }),
    async verify({ receipt, context, domainInputs })
    {
        const { verifiedOwnerResult, requireOwnerChecks } = await import('./required-evidence-owner-contract.mjs');
        if (!domainInputs?.buildReceiptDigest)
        {
            throw new Error('explicit build receipt digest is required');
        }
        requireOwnerChecks(validateBrowserlessCorrectnessReceipt(receipt, {
            expectedCommit: context.sourceCommit, expectedFingerprint: context.worktreeFingerprint,
            expectedBuildReceiptDigest: domainInputs.buildReceiptDigest
        }));
        return verifiedOwnerResult({ schema: receipt.schema, contentDigest: receipt.contentDigest });
    }
});
