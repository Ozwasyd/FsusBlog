#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildAggregatePlan } from './test-matrix/aggregate-plan.mjs';
import { parseMatrix, tierExecutionDependencies } from './test-matrix/parse-matrix.mjs';
import { parseYamlDocument } from './yaml/parse-document.mjs';

const directFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.join(path.dirname(directFile), '..'));
const defaultPlanPath = path.join(root, '.tmp/ci-plan.json');
const defaultWorkflowPath = path.join(root, '.github/workflows/quality-gate.yml');
const matrixPath = process.env.FSUSBLOG_MATRIX_FILE
    ? path.resolve(root, process.env.FSUSBLOG_MATRIX_FILE)
    : path.join(root, 'tests/matrix.yml');
const requiredActorDimensionPrefixes = ['anonymous-account-', 'admin-principal-'];
const requiredIdentityKindDimensions = ['identity-kind-anonymous-account', 'identity-kind-admin-principal'];

function loadPlan(planPath)
{
    if (fs.existsSync(planPath))
    {
        return JSON.parse(fs.readFileSync(planPath, 'utf8'));
    }

    const result = spawnSync('node', ['tools/run-test-matrix.mjs', 'ci-plan', '--format', 'github-actions'], {
        cwd: root,
        encoding: 'utf8'
    });
    if (result.stderr)
    {
        process.stderr.write(result.stderr);
    }
    if (result.status !== 0)
    {
        throw new Error(`failed to generate CI plan: node tools/run-test-matrix.mjs ci-plan exited ${result.status}`);
    }
    return JSON.parse(result.stdout);
}

function parseInlineList(value)
{
    const trimmed = value.trim();
    if (!trimmed)
    {
        return [];
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']'))
    {
        const inner = trimmed.slice(1, -1).trim();
        if (!inner)
        {
            return [];
        }
        return inner.split(',').map((item) => item.trim()).filter(Boolean);
    }
    return [trimmed];
}

function normalizeYamlScalar(value)
{
    return String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function combineCacheProfile(left, right)
{
    const frontend = left === 'frontend' || left === 'full' || right === 'frontend' || right === 'full';
    const backend = left === 'backend' || left === 'full' || right === 'backend' || right === 'full';
    return frontend && backend ? 'full' : frontend ? 'frontend' : backend ? 'backend' : 'none';
}

function combinePlaywrightRequirement(left, right)
{
    if (left === 'all' || right === 'all')
    {
        return 'all';
    }
    if (left === 'chromium' || right === 'chromium')
    {
        return 'chromium';
    }
    return 'none';
}

function usesAction(text, action, majorVersion)
{
    const escapedAction = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedVersion = majorVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`uses:\\s*${escapedAction}@(?:${escapedVersion}|[a-f0-9]{40}\\s*#\\s*${escapedVersion})(?:\\s|$)`, 'u').test(text);
}

function parseActionSteps(lines)
{
    const steps = [];
    for (let index = 0; index < lines.length; index += 1)
    {
        const stepMatch = lines[index].match(/^(\s*)-\s+uses:\s*([^\s#]+)(?:\s+#.*)?$/u);
        if (!stepMatch)
        {
            continue;
        }

        const stepIndent = stepMatch[1].length;
        const step = { uses: stepMatch[2], inputs: [] };
        for (let nestedIndex = index + 1; nestedIndex < lines.length; nestedIndex += 1)
        {
            const line = lines[nestedIndex];
            if (line.trim() === '')
            {
                continue;
            }
            const indent = line.match(/^(\s*)/u)?.[1].length ?? 0;
            if (indent <= stepIndent)
            {
                break;
            }

            const withMatch = line.match(/^(\s*)with:\s*$/u);
            if (!withMatch)
            {
                continue;
            }
            const withIndent = withMatch[1].length;
            let inputIndent = null;
            for (let inputIndex = nestedIndex + 1; inputIndex < lines.length; inputIndex += 1)
            {
                const inputLine = lines[inputIndex];
                if (inputLine.trim() === '')
                {
                    continue;
                }
                const currentIndent = inputLine.match(/^(\s*)/u)?.[1].length ?? 0;
                if (currentIndent <= withIndent)
                {
                    break;
                }
                const inputMatch = inputLine.match(/^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/u);
                if (!inputMatch)
                {
                    continue;
                }
                if (inputIndent == null)
                {
                    inputIndent = currentIndent;
                }
                if (currentIndent !== inputIndent)
                {
                    continue;
                }
                step.inputs.push({
                    key: inputMatch[1],
                    value: normalizeYamlScalar(inputMatch[2])
                });
            }
            break;
        }
        steps.push(step);
    }
    return steps;
}

function annotateWorkflowJob(job)
{
    const text = job.lines.join('\n');
    const actionSteps = parseActionSteps(job.lines);
    const setupNodeSteps = actionSteps.filter((step) => step.uses.startsWith('actions/setup-node@'));
    job.uploadArtifactCount = [...text.matchAll(/uses:\s*actions\/upload-artifact@/g)].length;
    job.hiddenUploadArtifactCount = [...text.matchAll(/include-hidden-files:\s*true/g)].length;
    job.hasSetupNode = setupNodeSteps.length > 0;
    job.hasSetupDotnet = /uses:\s*actions\/setup-dotnet@/.test(text);
    job.nodeCacheDependencyPaths = new Set(setupNodeSteps.flatMap((step) =>
        step.inputs
            .filter((input) => input.key === 'cache-dependency-path')
            .map((input) => input.value)));
    job.hasNpmLockCache = setupNodeSteps.some((step) =>
    {
        const inputs = new Map(step.inputs.map((input) => [input.key, input.value]));
        return inputs.get('cache') === 'npm'
      && inputs.get('cache-dependency-path') === 'src/frontend/package-lock.json';
    });
    job.hasNugetCache = usesAction(text, 'actions/cache', 'v4')
    && /path:\s*~\/\.nuget\/packages/.test(text)
    && /key:\s*nuget-\$\{\{\s*runner\.os\s*\}\}-\$\{\{\s*hashFiles\(/.test(text)
    && text.includes('**/*.csproj')
    && text.includes('**/*.props')
    && text.includes('**/*.targets')
    && text.includes('global.json')
    && text.includes('NuGet.config');
    job.hasPlaywrightCache = usesAction(text, 'actions/cache', 'v4')
    && /path:\s*~\/\.cache\/ms-playwright/.test(text)
    && /key:\s*playwright-[^\n]*\$\{\{\s*runner\.os\s*\}\}-[^\n]*\$\{\{\s*hashFiles\('src\/frontend\/package-lock\.json'\)/.test(text);
    job.hasPlaywrightCachePath = /path:\s*~\/\.cache\/ms-playwright/.test(text);
    job.npmCiCommands = job.runs.filter((command) => /(?:^|\s)npm\s+--prefix\s+src\/frontend\s+ci(?:\s|$)/.test(command));
    job.playwrightInstallCommands = job.runs.filter((command) => /playwright\s+install/.test(command));
    job.flakyGovernedCommands = job.runs.filter((command) => /tools\/ci\/run-flaky-governed\.mjs/.test(command));
    job.usesMatrixTierCommand = /(?:^|\s)(?:\.\/)?tools\/test\.sh\s+ci-tier\s+\$\{\{\s*matrix\.tier\s*\}\}\s+--no-deps(?:\s|$)/.test(text);
    job.scheduledCiJobs = new Set([...text.matchAll(/(?:^|\s)(?:\.\/)?tools\/test\.sh\s+ci-job\s+([A-Za-z0-9_-]+)([^\n]*)/g)]
        .filter((match) => /(?:^|\s)--fresh(?:\s|$)/.test(match[2]))
        .map((match) => match[1]));
    job.usesGeneratedFastBackendMatrix = /matrix:\s*\$\{\{\s*fromJson\(needs\.validate-matrix\.outputs\.fast_backend_matrix\)\s*\}\}/.test(text);
    job.usesGeneratedFastBackendMaxParallel = /max-parallel:\s*\$\{\{\s*fromJson\(needs\.validate-matrix\.outputs\.fast_backend_max_parallel\)\s*\}\}/.test(text);
    job.generatesFastBackendMatrix = /node tools\/run-test-matrix\.mjs ci-job-matrix fast-backend --github-output "\$GITHUB_OUTPUT"/.test(text);
    job.aggregateTargets = new Set(
        [...text.matchAll(/node tools\/run-test-matrix\.mjs aggregate ([a-z0-9][a-z0-9-]*)(?:\s|$)/gu)]
            .map((match) => match[1])
    );
    job.usesFastSummaryAggregate = job.aggregateTargets.has('fast-summary');
    job.usesMatrixPlaywrightWorkers = /FSUSBLOG_PLAYWRIGHT_WORKERS:\s*\$\{\{\s*matrix\.playwright_workers\s*\}\}/.test(text);
    job.playwrightWorkerEnvValues = new Set([...text.matchAll(/FSUSBLOG_PLAYWRIGHT_WORKERS:\s*['"]?(\d+)['"]?/g)].map((match) => Number(match[1])));
    job.downloadsFastBackendArtifacts = /uses:\s*actions\/download-artifact@/.test(text) && /(?:name:\s*fast-backend|pattern:\s*fast-backend-\*)/.test(text);
    job.downloadsFrontendBuildArtifacts = /uses:\s*actions\/download-artifact@/.test(text) && /name:\s*frontend-build/.test(text);
    job.downloadsFastFrontendArtifacts = /uses:\s*actions\/download-artifact@/.test(text) && /(?:name:\s*fast-frontend-unit|pattern:\s*fast-frontend-unit-\*)/.test(text);
    job.downloadsFrontendRuntimeContractsArtifacts = /uses:\s*actions\/download-artifact@/.test(text) && /name:\s*frontend-runtime-contracts/.test(text);
    job.downloadsFrontendStaticGovernanceArtifacts = /uses:\s*actions\/download-artifact@/.test(text) && /name:\s*frontend-static-governance/.test(text);
    job.downloadsFastStaticArtifacts = /uses:\s*actions\/download-artifact@/.test(text) && /name:\s*fast-static-governance/.test(text);
    job.usesProductionBuildConsumer = /uses:\s*\.\/\.github\/actions\/consume-production-build(?:\s|$)/.test(text);
    job.runsProductionBuildProducer = /(?:^|\s)(?:\.\/)?tools\/test\.sh\s+ci-tier\s+production-build-artifacts\s+--no-deps(?:\s|$)/.test(text);
    job.uploadsProductionBuildArtifacts = /name:\s*production-build-artifacts/.test(text)
    && [...job.uploadPaths].some(value => normalizeArtifactPath(value).startsWith('.tmp/ci-production-build'));
    job.exportsProductionReceiptIdentity = /source_fingerprint:[\s\S]*receipt_digest:/u.test(text);
    job.referencesValidateMatrixOutputs = /needs\.validate-matrix\.outputs\./.test(text);
    job.behaviorDocAdmissionConsumerSteps = actionSteps.filter((step) =>
        step.uses === './.github/actions/consume-behavior-doc-admission');
    const behaviorDocConsumer = job.behaviorDocAdmissionConsumerSteps[0];
    const behaviorDocConsumerInputs = behaviorDocConsumer?.inputs ?? [];
    const behaviorDocConsumerInputMap = new Map(
        behaviorDocConsumerInputs.map((input) => [input.key, input.value])
    );
    job.behaviorDocAdmissionConsumerInputKeys = behaviorDocConsumerInputs.map((input) => input.key);
    job.consumesBehaviorDocAdmission =
        job.behaviorDocAdmissionConsumerSteps.length === 1
    && behaviorDocConsumerInputs.length === 2
    && behaviorDocConsumerInputMap.get('source-fingerprint')
      === '${{ needs.behavior-doc-static-admission.outputs.source_fingerprint }}'
    && behaviorDocConsumerInputMap.get('receipt-digest')
      === '${{ needs.behavior-doc-static-admission.outputs.receipt_digest }}';
    return job;
}

function workflowHasGlobalPlaywrightWorkers(text)
{
    const jobsIndex = text.search(/^jobs:\s*$/m);
    const header = jobsIndex >= 0 ? text.slice(0, jobsIndex) : text;
    return /^env:\s*$[\s\S]*?^\s+FSUSBLOG_PLAYWRIGHT_WORKERS:/m.test(header);
}

function validateMatrixCoverageDimensions(tiers, errors)
{
    const coverageIds = new Set(tiers.flatMap((tier) => Array.isArray(tier.coverage) ? tier.coverage : []));

    for (const prefix of requiredActorDimensionPrefixes)
    {
        if (![...coverageIds].some((id) => id.startsWith(prefix)))
        {
            errors.push(`matrix coverage dimensions missing required actor prefix: ${prefix}*`);
        }
    }

    for (const dimension of requiredIdentityKindDimensions)
    {
        if (!coverageIds.has(dimension))
        {
            errors.push(`matrix coverage dimensions missing required identity kind: ${dimension}`);
        }
    }

    for (const id of coverageIds)
    {
        if (id.startsWith('endpoint-role-protocol-') && !id.includes('deprecated'))
        {
            errors.push(`matrix coverage dimension ${id} uses legacy endpoint-role-protocol naming without deprecated marker`);
        }
    }
}

export function parseWorkflow(text)
{
    const document = parseYamlDocument(text, { source: 'quality gate workflow' });
    const jobs = new Map();
    let inJobs = false;
    let jobsIndent = null;
    let jobIndent = null;
    let jobFieldIndent = null;
    let currentJob = null;
    let collectingNeeds = null;
    let collectingPath = null;
    let collectingRun = null;

    for (const rawLine of text.split(/\r?\n/))
    {
        const indent = rawLine.match(/^(\s*)/u)?.[1].length ?? 0;
        if (/^jobs:\s*$/u.test(rawLine))
        {
            inJobs = true;
            jobsIndent = indent;
            continue;
        }
        if (!inJobs)
        {
            continue;
        }

        const mappingMatch = rawLine.match(/^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/u);
        if (jobIndent == null && mappingMatch && indent > jobsIndent)
        {
            jobIndent = indent;
        }
        if (mappingMatch && indent === jobIndent && mappingMatch[2] === '')
        {
            currentJob = mappingMatch[1];
            jobFieldIndent = null;
            collectingNeeds = null;
            collectingPath = null;
            collectingRun = null;
            jobs.set(currentJob, { needs: new Set(), runs: [], timeoutMinutes: null, maxParallel: null, maxParallelOutput: null, uploadPaths: new Set(), lines: [] });
            continue;
        }
        if (!currentJob)
        {
            continue;
        }
        jobs.get(currentJob).lines.push(rawLine);
        if (jobFieldIndent == null && mappingMatch && indent > jobIndent && !rawLine.trimStart().startsWith('-'))
        {
            jobFieldIndent = indent;
        }

        const pathMatch = rawLine.match(/^(\s*)path:\s*(.*?)\s*$/);
        if (pathMatch)
        {
            const [, indent, value] = pathMatch;
            collectingPath = value === '|' ? { job: currentJob, indent: indent.length } : null;
            if (value && value !== '|')
            {
                jobs.get(currentJob).uploadPaths.add(value.trim());
            }
            continue;
        }

        if (collectingPath?.job === currentJob)
        {
            if (rawLine.trim() === '')
            {
                continue;
            }
            if (indent > collectingPath.indent)
            {
                jobs.get(currentJob).uploadPaths.add(rawLine.trim());
                continue;
            }
            collectingPath = null;
        }

        if (collectingRun?.job === currentJob)
        {
            if (rawLine.trim() === '')
            {
                continue;
            }
            if (indent > collectingRun.indent)
            {
                continue;
            }
            collectingRun = null;
        }

        const timeoutMatch = rawLine.match(/^\s*timeout-minutes:\s*(\d+)\s*$/u);
        if (timeoutMatch && indent === jobFieldIndent)
        {
            jobs.get(currentJob).timeoutMinutes = Number(timeoutMatch[1]);
            continue;
        }

        const maxParallelMatch = rawLine.match(/^\s+max-parallel:\s*(\d+)\s*$/);
        if (maxParallelMatch)
        {
            jobs.get(currentJob).maxParallel = Number(maxParallelMatch[1]);
            continue;
        }
        const maxParallelOutputMatch = rawLine.match(/^\s+max-parallel:\s*\$\{\{\s*fromJson\(needs\.(?:validate-matrix|plan-pr-risk)\.outputs\.([A-Za-z0-9_]+_max_parallel)\)\s*\}\}\s*$/);
        if (maxParallelOutputMatch)
        {
            jobs.get(currentJob).maxParallelOutput = maxParallelOutputMatch[1];
            continue;
        }

        const needsMatch = rawLine.match(/^\s*needs:\s*(.*?)\s*$/u);
        if (needsMatch && indent === jobFieldIndent)
        {
            const value = needsMatch[1];
            collectingNeeds = value === '' ? { job: currentJob, indent, flow: false } : null;
            for (const need of parseInlineList(value))
            {
                jobs.get(currentJob).needs.add(need);
            }
            continue;
        }

        if (collectingNeeds?.job === currentJob)
        {
            if (rawLine.trim() === '')
            {
                continue;
            }
            if (indent <= collectingNeeds.indent)
            {
                collectingNeeds = null;
            }
            else if (rawLine.trim() === '[')
            {
                collectingNeeds.flow = true;
                continue;
            }
            else if (collectingNeeds.flow && rawLine.trim() === ']')
            {
                collectingNeeds = null;
                continue;
            }
            else if (collectingNeeds.flow)
            {
                for (const need of rawLine.trim().replace(/,$/u, '').split(',').map((item) => item.trim()).filter(Boolean))
                {
                    jobs.get(currentJob).needs.add(need);
                }
                continue;
            }
            const itemMatch = rawLine.match(/^\s*-\s+([A-Za-z0-9_-]+)\s*$/u);
            if (itemMatch && indent > collectingNeeds.indent)
            {
                jobs.get(currentJob).needs.add(itemMatch[1]);
                continue;
            }
            if (collectingNeeds && !/^\s*$/u.test(rawLine))
            {
                collectingNeeds = null;
            }
        }

        const runMatch = rawLine.match(/^(\s*)-\s+run:\s*(.*?)\s*$/) ?? rawLine.match(/^(\s*)run:\s*(.*?)\s*$/);
        if (runMatch)
        {
            const [, indent, value] = runMatch;
            if (/^[|>][-+]?$/u.test(value))
            {
                collectingRun = { job: currentJob, indent: indent.length };
            }
        }
    }

    for (const [jobId, job] of jobs)
    {
        const steps = document.jobs?.[jobId]?.steps ?? [];
        if (!Array.isArray(steps))
        {
            throw new Error(`workflow job ${jobId} steps must be a YAML sequence`);
        }
        for (const step of steps)
        {
            if (step?.run == null)
            {
                continue;
            }
            if (typeof step.run !== 'string')
            {
                throw new Error(`workflow job ${jobId} run must be a YAML string`);
            }
            job.runs.push(...step.run.split(/\r?\n/u).map((command) => command.trim()).filter(Boolean));
        }
        annotateWorkflowJob(job);
    }
    return jobs;
}

function normalizeArtifactPath(value)
{
    return String(value ?? '')
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .replace(/\/+$/g, '');
}

function baseBeforeGlob(value)
{
    const normalized = normalizeArtifactPath(value);
    const globIndex = normalized.search(/[*{]/);
    if (globIndex < 0)
    {
        return normalized;
    }
    return normalized.slice(0, globIndex).replace(/\/+$/g, '');
}

function pathPatternCovers(uploadPattern, expectedPath)
{
    const upload = normalizeArtifactPath(uploadPattern);
    const expected = normalizeArtifactPath(expectedPath);
    if (!upload || !expected)
    {
        return false;
    }
    if (upload === expected)
    {
        return true;
    }

    const uploadBase = baseBeforeGlob(upload);
    const expectedBase = baseBeforeGlob(expected);
    if (upload.includes('*') || upload.includes('{'))
    {
        return expected === uploadBase || expected.startsWith(`${uploadBase}/`) || expectedBase === uploadBase || expectedBase.startsWith(`${uploadBase}/`);
    }
    if (expected.includes('*') || expected.includes('{'))
    {
        return upload === expectedBase || upload.startsWith(`${expectedBase}/`);
    }
    return false;
}

function requiresUpload(pathValue)
{
    const value = normalizeArtifactPath(pathValue);
    return value.startsWith('.tmp/')
    || value.startsWith('src/frontend/test-results/')
    || value.startsWith('src/frontend/playwright-report')
    || value.startsWith('BenchmarkDotNet.Artifacts/');
}

function planTierClosure(tiersById, targetId, noDeps)
{
    if (noDeps)
    {
        return new Set([targetId]);
    }
    const covered = new Set();
    function visit(id)
    {
        if (covered.has(id))
        {
            return;
        }
        const tier = tiersById.get(id);
        if (!tier)
        {
            return;
        }
        for (const dep of tierExecutionDependencies(tier))
        {
            visit(dep);
        }
        covered.add(id);
    }
    visit(targetId);
    return covered;
}

function coveredTiersForWorkflowJob(job, tiersById, plannedTierIds = [])
{
    const covered = new Set();
    if (job.usesMatrixTierCommand)
    {
        for (const tierId of plannedTierIds)
        {
            covered.add(tierId);
        }
    }
    if (job.usesFastSummaryAggregate)
    {
        for (const tierId of plannedTierIds)
        {
            covered.add(tierId);
        }
    }
    if (job.aggregateTargets.size > 0)
    {
        for (const tierId of plannedTierIds)
        {
            covered.add(tierId);
        }
    }
    for (const command of job.runs)
    {
        if (/(?:^|\s)(?:\.\/)?tools\/test\/run-matrix-governance-once\.sh\s+validate-matrix(?:\s|$)/u.test(command))
        {
            covered.add('validate-matrix');
            continue;
        }
        if (command === 'node tools/run-test-matrix.mjs validate-declarations')
        {
            covered.add('validate-declarations');
            continue;
        }
        if (command === 'node tools/test-matrix/source-governance.mjs')
        {
            covered.add('source-governance');
            continue;
        }
        if (command === 'node tools/run-test-matrix.mjs validate' || command === 'node tools/run-test-matrix.mjs preflight')
        {
            covered.add('validate-matrix');
            continue;
        }
        if (/node\s+tools\/run-test-matrix\.mjs\s+ci-pr-plan(?:\s|$)/.test(command))
        {
            covered.add('pr-smart-gate-plan');
            continue;
        }

        const ciJobMatch = command.match(/(?:^|\s)(?:\.\/)?tools\/test\.sh\s+ci-job\s+([A-Za-z0-9_-]+)/);
        if (ciJobMatch)
        {
            if (job.scheduledCiJobs.has(ciJobMatch[1]))
            {
                for (const tierId of plannedTierIds)
                {
                    covered.add(tierId);
                }
            }
            continue;
        }

        const testMatch = command.match(/(?:^|\s)(?:\.\/)?tools\/test\.sh\s+(?:ci-tier\s+)?([A-Za-z0-9_-]+)/);
        if (!testMatch)
        {
            continue;
        }
        if (/\$\{\{\s*matrix\.tier\s*\}\}/.test(command))
        {
            continue;
        }

        const tierId = testMatch[1];
        const noDeps = /(?:^|\s)--no-deps(?:\s|$)/.test(command);
        for (const coveredTier of planTierClosure(tiersById, tierId, noDeps))
        {
            covered.add(coveredTier);
        }
    }

    return covered;
}

function validateScheduledFastDag(workflowJob, planJob, errors)
{
    if (!new Set(['fast-backend', 'fast-frontend-unit']).has(planJob.id))
    {
        return;
    }
    if ((planJob.tiers?.length ?? 0) <= 1)
    {
        return;
    }
    if (!workflowJob.scheduledCiJobs.has(planJob.id))
    {
        errors.push(`workflow job ${planJob.id} must run the resource-aware ci-job DAG with explicit --fresh`);
    }
    if (workflowJob.usesMatrixTierCommand)
    {
        errors.push(`workflow job ${planJob.id} must not expand superseded tiers into a GitHub matrix`);
    }
}

function validateFastSummaryAggregate(workflowJob, planJob, errors)
{
    if (planJob.id !== 'fast-summary')
    {
        return;
    }

    const testRuns = workflowJob.runs.filter((command) => /(?:^|\s)(?:\.\/)?tools\/test\.sh(?:\s|$)/.test(command));
    if (testRuns.length > 0)
    {
        errors.push(`workflow job fast-summary must be artifact-only, but runs test commands: ${testRuns.join('; ')}`);
    }
    if (!workflowJob.usesFastSummaryAggregate)
    {
        errors.push('workflow job fast-summary must aggregate artifacts with tools/run-test-matrix.mjs aggregate fast-summary');
    }
    if (!workflowJob.downloadsFastBackendArtifacts)
    {
        errors.push('workflow job fast-summary must download fast-backend artifacts before aggregating');
    }
    if (!workflowJob.downloadsFrontendBuildArtifacts)
    {
        errors.push('workflow job fast-summary must download frontend-build artifacts before aggregating');
    }
    if (!workflowJob.downloadsFastFrontendArtifacts)
    {
        errors.push('workflow job fast-summary must download fast-frontend-unit artifacts before aggregating');
    }
    if (!workflowJob.downloadsFrontendRuntimeContractsArtifacts)
    {
        errors.push('workflow job fast-summary must download frontend-runtime-contracts artifacts before aggregating');
    }
    if (!workflowJob.downloadsFrontendStaticGovernanceArtifacts)
    {
        errors.push('workflow job fast-summary must download frontend-static-governance artifacts before aggregating');
    }
    if (!workflowJob.downloadsFastStaticArtifacts)
    {
        errors.push('workflow job fast-summary must download fast-static-governance artifacts before aggregating');
    }
}

function validateAggregateWorkflowJob(matrix, workflowJob, planJob, errors)
{
    const authority = Object.values(matrix.aggregateAuthorities ?? {})
        .find((candidate) => candidate?.ciJob === planJob.id);
    if (!authority)
    {
        return false;
    }

    const plan = buildAggregatePlan(matrix, authority.id);
    if (plan.errors.length > 0)
    {
        errors.push(`workflow job ${planJob.id} has invalid aggregate authority ${authority.id}: ${plan.errors.join('; ')}`);
        return true;
    }
    const testRuns = workflowJob.runs.filter((command) =>
        /(?:^|\s)(?:\.\/)?tools\/test\.sh(?:\s|$)/u.test(command)
    );
    if (testRuns.length > 0)
    {
        errors.push(`workflow job ${planJob.id} must be artifact-only, but runs test commands: ${testRuns.join('; ')}`);
    }
    if (!workflowJob.aggregateTargets.has(authority.id))
    {
        errors.push(`workflow job ${planJob.id} must invoke aggregate authority ${authority.id}`);
    }
    for (const dependencyJob of plan.dependencyJobs)
    {
        if (!workflowJob.needs.has(dependencyJob))
        {
            errors.push(`workflow job ${planJob.id} is missing aggregate dependency job: ${dependencyJob}`);
        }
    }
    return true;
}

function setupRequirementsForTiers(tierIds, tiersById)
{
    const requirements = {
        requiresNode: false,
        requiresDotnet: false,
        requiresPlaywright: 'none',
        cacheProfile: 'none',
        requiresBootstrap: 'none',
        playwrightWorkerValues: new Set(),
        missingPlaywrightWorkerTiers: []
    };
    for (const tierId of tierIds)
    {
        const tier = tiersById.get(tierId);
        if (!tier)
        {
            continue;
        }
        requirements.requiresNode = requirements.requiresNode || tier.requiresNode === true;
        requirements.requiresDotnet = requirements.requiresDotnet || tier.requiresDotnet === true;
        requirements.requiresPlaywright = combinePlaywrightRequirement(requirements.requiresPlaywright, tier.requiresPlaywright);
        if (tier.requiresPlaywright !== 'none')
        {
            if (tier.id === 'browser-contract')
            {
                requirements.playwrightWorkerValues.add(1);
            }
            else if (Number.isInteger(tier.playwrightWorkers) && tier.playwrightWorkers >= 1)
            {
                requirements.playwrightWorkerValues.add(Number(tier.playwrightWorkers));
            }
            else
            {
                requirements.missingPlaywrightWorkerTiers.push(tier.id);
            }
        }
        requirements.cacheProfile = combineCacheProfile(requirements.cacheProfile, tier.cacheProfile);
        requirements.requiresBootstrap = combineCacheProfile(requirements.requiresBootstrap, tier.requiresBootstrap);
    }
    return requirements;
}

function bootstrapExecutionsForWorkflowJob(job, tiersById)
{
    let count = 0;
    for (const command of job.runs)
    {
        const testMatch = command.match(/(?:^|\s)(?:\.\/)?tools\/test\.sh\s+(?:ci-tier\s+)?([A-Za-z0-9_-]+)/);
        if (!testMatch)
        {
            continue;
        }

        const tierId = testMatch[1];
        const noDeps = /(?:^|\s)--no-deps(?:\s|$)/.test(command);
        if (noDeps)
        {
            if (tierId === 'bootstrap')
            {
                count += 1;
            }
            continue;
        }
        if (planTierClosure(tiersById, tierId, false).has('bootstrap'))
        {
            count += 1;
        }
    }
    return count;
}

function manualBootstrapExecutionsForWorkflowJob(job)
{
    return job.runs.filter((command) =>
        /(?:^|\s)(?:\.\/)?tools\/test\.sh\s+(?:ci-tier\s+)?bootstrap\s+--no-deps(?:\s|$)/.test(command)
    ).length;
}

function planJobCoversBootstrap(planJob, tiersById)
{
    return (planJob?.tiers ?? []).some((tierId) => planTierClosure(tiersById, tierId, false).has('bootstrap'));
}

function workflowJobHasBootstrapSource(workflowJob, actualNeeds, planJobsById, tiersById)
{
    if (manualBootstrapExecutionsForWorkflowJob(workflowJob) > 0)
    {
        return true;
    }
    for (const need of actualNeeds)
    {
        if (planJobCoversBootstrap(planJobsById.get(need), tiersById))
        {
            return true;
        }
    }
    return false;
}

function validateWorkflowBootstrapMetadata(jobId, workflowJob, actualNeeds, planJobsById, tiersById, coveredTiers, errors)
{
    const manualBootstrapCount = manualBootstrapExecutionsForWorkflowJob(workflowJob);
    if (manualBootstrapCount > 0)
    {
        for (const tierId of coveredTiers)
        {
            if (tierId === 'bootstrap')
            {
                continue;
            }
            const tier = tiersById.get(tierId);
            if (tier?.requiresBootstrap !== 'none' && tier?.workflowBootstraps !== true)
            {
                errors.push(`workflow job ${jobId} manually runs bootstrap but tier ${tierId} does not declare workflowBootstraps=true`);
            }
        }
    }

    const hasBootstrapSource = workflowJobHasBootstrapSource(workflowJob, actualNeeds, planJobsById, tiersById);
    for (const tierId of coveredTiers)
    {
        const tier = tiersById.get(tierId);
        if (tier?.workflowBootstraps === true && !hasBootstrapSource)
        {
            errors.push(`workflow job ${jobId} covers workflowBootstraps tier ${tierId} but has no manual bootstrap step or bootstrap-producing need`);
        }
    }
}

function validateWorkflowSetup(jobId, workflowJob, requirements, errors)
{
    const needsFrontendCache = requirements.cacheProfile === 'frontend' || requirements.cacheProfile === 'full';
    const needsBackendCache = requirements.cacheProfile === 'backend' || requirements.cacheProfile === 'full';

    if (requirements.requiresNode && !workflowJob.hasSetupNode)
    {
        errors.push(`workflow job ${jobId} requires Node but has no actions/setup-node step`);
    }
    if (workflowJob.npmCiCommands.length > 0 && !workflowJob.hasNpmLockCache)
    {
        errors.push(`workflow job ${jobId} runs npm ci without setup-node npm cache keyed by src/frontend/package-lock.json`);
    }
    for (const command of [...workflowJob.npmCiCommands, ...workflowJob.playwrightInstallCommands])
    {
        if (!/node\s+tools\/ci\/run-stage\.mjs\s+--stage\s+install\s+--/.test(command))
        {
            errors.push(`workflow job ${jobId} install command is not timed through tools/ci/run-stage.mjs: ${command}`);
        }
    }
    if (needsFrontendCache && workflowJob.npmCiCommands.length === 0)
    {
        errors.push(`workflow job ${jobId} declares frontend cacheProfile but does not run npm --prefix src/frontend ci`);
    }
    if (requirements.requiresDotnet && !workflowJob.hasSetupDotnet)
    {
        errors.push(`workflow job ${jobId} requires .NET but has no actions/setup-dotnet step`);
    }
    if (needsBackendCache && !workflowJob.hasNugetCache)
    {
        errors.push(`workflow job ${jobId} declares backend cacheProfile but does not use deterministic NuGet cache`);
    }
    if (requirements.requiresPlaywright !== 'none')
    {
        const expectedWorkerValues = [...requirements.playwrightWorkerValues].sort((left, right) => left - right);
        if (workflowJob.usesMatrixTierCommand)
        {
            if (!workflowJob.usesMatrixPlaywrightWorkers)
            {
                errors.push(`workflow job ${jobId} must pass FSUSBLOG_PLAYWRIGHT_WORKERS from matrix.playwright_workers`);
            }
        }
        else if (expectedWorkerValues.length === 1)
        {
            const expected = expectedWorkerValues[0];
            if (!workflowJob.playwrightWorkerEnvValues.has(expected) && !workflowJob.usesMatrixPlaywrightWorkers)
            {
                errors.push(`workflow job ${jobId} must set FSUSBLOG_PLAYWRIGHT_WORKERS=${expected} from matrix tier policy`);
            }
        }
        else if (expectedWorkerValues.length > 1 && !workflowJob.usesMatrixPlaywrightWorkers)
        {
            errors.push(`workflow job ${jobId} covers multiple Playwright worker policies (${expectedWorkerValues.join(', ')}); use matrix.playwright_workers`);
        }
        if (!workflowJob.hasPlaywrightCache)
        {
            errors.push(`workflow job ${jobId} requires Playwright but does not cache ~/.cache/ms-playwright with src/frontend/package-lock.json`);
        }
        if (workflowJob.playwrightInstallCommands.length === 0)
        {
            errors.push(`workflow job ${jobId} requires Playwright but has no playwright install step`);
        }
        const installCommand = workflowJob.playwrightInstallCommands.join(' && ');
        if (requirements.requiresPlaywright === 'chromium' && !/playwright\s+install\s+--with-deps\s+chromium(?:\s|$)/.test(installCommand))
        {
            errors.push(`workflow job ${jobId} must install only chromium for requiresPlaywright=chromium`);
        }
        const installsMatrixBrowser = /\$\{\{\s*matrix\.browser\s*\}\}/.test(installCommand);
        const installsAllBrowsers = /playwright\s+install\s+--with-deps\s+chromium\s+firefox\s+webkit(?:\s|$)/.test(installCommand);
        if (requirements.requiresPlaywright === 'all' && !installsMatrixBrowser && !installsAllBrowsers)
        {
            errors.push(`workflow job ${jobId} must install the matrix browser or all governed browsers for requiresPlaywright=all`);
        }
        if (jobId === 'browser-contract')
        {
            if (workflowJob.flakyGovernedCommands.length > 0)
            {
                errors.push('workflow job browser-contract must run once without flaky retry governance');
            }
        }
        else if (workflowJob.flakyGovernedCommands.length === 0)
        {
            errors.push(`workflow job ${jobId} requires Playwright but does not run through tools/ci/run-flaky-governed.mjs`);
        }
    }
    else
    {
        if (workflowJob.playwrightInstallCommands.length > 0)
        {
            errors.push(`browserless workflow job ${jobId} must not install Playwright browsers`);
        }
        if (workflowJob.hasPlaywrightCachePath)
        {
            errors.push(`browserless workflow job ${jobId} must not cache Playwright browsers`);
        }
        if (workflowJob.flakyGovernedCommands.length > 0)
        {
            errors.push(`workflow job ${jobId} uses flaky retry governance without requiresPlaywright metadata`);
        }
    }
}

function validateProductionBuildFanout(workflowText, workflowJobs, errors)
{
    const producer = workflowJobs.get('production-build-artifacts');
    if (!producer)
    {
        errors.push('workflow is missing production-build-artifacts producer job');
        return;
    }
    if (!producer.runsProductionBuildProducer)
    {
        errors.push('production-build-artifacts job must run the declared production-build-artifacts tier');
    }
    if (!producer.uploadsProductionBuildArtifacts)
    {
        errors.push('production-build-artifacts job must upload the minimal receipted artifact root');
    }
    if (!producer.exportsProductionReceiptIdentity)
    {
        errors.push('production-build-artifacts job must export source_fingerprint and receipt_digest outputs');
    }
    if (!/needs\.plan-pr-risk\.outputs\.production_build_artifacts\s*==\s*'true'/u.test(producer.lines.join('\n')))
    {
        errors.push('production-build-artifacts ordinary PR execution must be selected by the smart gate');
    }
    const producerUploadSource = producer.lines.join('\n').slice(producer.lines.join('\n').lastIndexOf('uses: actions/upload-artifact@'));
    if (/node_modules|\.nuget\/packages/u.test(producerUploadSource))
    {
        errors.push('production-build-artifacts must not upload dependency caches or node_modules');
    }

    const consumerAction = fs.readFileSync(path.join(root, '.github/actions/consume-production-build/action.yml'), 'utf8');
    for (const required of [
        'actions/download-artifact@',
        'production-build-artifacts',
        'snapshotGitWorktree',
        'production-build-artifacts-cli.mjs verify',
        '--expected-commit',
        '--expected-fingerprint',
        '--expected-run-id',
        '--expected-job production-build-artifacts',
        '--expected-receipt-digest',
        '--transfer-started-at-ms',
        'FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT=',
        'FSUSBLOG_RUNTIME_NO_BUILD=1'
    ])
    {
        if (!consumerAction.includes(required))
        {
            errors.push(`production build consumer action is missing fail-closed contract: ${required}`);
        }
    }

    const requiredConsumers = new Set([
        'integration-runtime',
        'endpoint-depth-runtime',
        'release-public',
        'security-runtime',
        'browser-contract',
        'resilience-runtime',
        'load-smoke',
        'backend-qps-collectors',
        'perf-regression'
    ]);
    for (const jobId of requiredConsumers)
    {
        const job = workflowJobs.get(jobId);
        if (!job)
        {
            continue;
        }
        if (!job.needs.has('production-build-artifacts'))
        {
            errors.push(`workflow job ${jobId} must depend on production-build-artifacts`);
        }
        if (!job.usesProductionBuildConsumer)
        {
            errors.push(`workflow job ${jobId} must verify the immutable production build before testing`);
        }
    }
    for (const [jobId, job] of workflowJobs)
    {
        if (job.usesProductionBuildConsumer && !job.needs.has('production-build-artifacts'))
        {
            errors.push(`workflow job ${jobId} verifies production artifacts without declaring the producer need`);
        }
    }

    if (!workflowText.includes('production_build_artifacts: ${{ steps.smart.outputs.production_build_artifacts }}'))
    {
        errors.push('plan-pr-risk must export production_build_artifacts smart-gate selection');
    }
    if (!workflowText.includes('production_build_domains: ${{ steps.smart.outputs.production_build_domains }}')
    || !producer.lines.join('\n').includes('FSUSBLOG_CI_PRODUCTION_BUILD_DOMAINS: ${{ needs.plan-pr-risk.outputs.production_build_domains }}'))
    {
        errors.push('production-build-artifacts must receive the smart-gate domain union instead of always building every domain');
    }
    const bootstrapSource = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8');
    for (const required of [
        'MaterializeCiProductionBuild',
        'production-build-artifacts-cli.mjs',
        'materializeArgs',
        'FSUSBLOG_RUNTIME_NO_BUILD=1',
        'CiProductionHasDomain frontend-dist',
        'vite preview'
    ])
    {
        if (!bootstrapSource.includes(required))
        {
            errors.push(`CI no-build bootstrap is missing immutable artifact contract: ${required}`);
        }
    }
}

function validateBrowserWorkflowTopology(workflowJobs, errors)
{
    const contract = workflowJobs.get('browser-contract');
    if (!contract)
    {
        errors.push('workflow is missing the single browser-contract job');
        return;
    }
    if (!contract.needs.has('production-build-artifacts'))
    {
        errors.push('browser-contract must consume production-build-artifacts');
    }
    if (!/needs\.plan-pr-risk\.outputs\.browser_contract\s*==\s*'true'/u.test(contract.lines.join('\n')))
    {
        errors.push('browser-contract PR execution must be selected by the browser-boundary smart gate');
    }
    for (const aggregateId of ['release-evidence', 'production-summary'])
    {
        if (workflowJobs.get(aggregateId)?.needs.has('browser-contract'))
        {
            errors.push(`${aggregateId} must remain browserless and must not wait for browser-contract`);
        }
    }
}

export function validateBehaviorDocStaticAdmissionTopology(workflowJobs, errors)
{
    const declarations = workflowJobs.get('validate-declarations');
    const plan = workflowJobs.get('plan-pr-risk');
    const source = workflowJobs.get('source-governance');
    if (!declarations || !plan || !source)
    {
        errors.push('workflow must declare global declarations, source-bound plan and source-governance stages');
    }
    else
    {
        if (declarations.needs.size !== 0 || plan.needs.size !== 1 || !plan.needs.has('validate-declarations'))
        {
            errors.push('PR planning must depend only on pure global declarations');
        }
        if (source.needs.size !== 2 || !source.needs.has('validate-declarations') || !source.needs.has('plan-pr-risk'))
        {
            errors.push('source governance must consume declarations and source-bound plan only');
        }
        for (const [id, job] of [['validate-declarations', declarations], ['plan-pr-risk', plan], ['source-governance', source]])
        {
            if (job.hasSetupDotnet || job.runs.some(command => /(?:\bdotnet\b|\bdocker\b|\bpodman\b|playwright\s+install|test-inventory\/produce)/u.test(command)))
            {
                errors.push(`pure source stage ${id} must not build or start candidate runtime`);
            }
        }
    }
    for (const [jobId, job] of workflowJobs)
    {
        if (['validate-declarations', 'plan-pr-risk', 'ci-summary'].includes(jobId))
        {
            continue;
        }
        const output = jobId.replaceAll('-', '_');
        if (!new RegExp(`needs\\.plan-pr-risk\\.outputs\\.${output}\\s*==\\s*'true'`, 'u').test(job.lines.join('\n')))
        {
            errors.push(`workflow job ${jobId} must be selected by its source-bound PR plan output`);
        }
    }
    const admissionId = 'behavior-doc-static-admission';
    const admission = workflowJobs.get(admissionId);
    if (!admission)
    {
        errors.push('workflow is missing the candidate behavior-doc-static-admission job');
        return;
    }
    if (admission.needs.size !== 2 || !admission.needs.has('validate-declarations') || !admission.needs.has('plan-pr-risk'))
    {
        errors.push('behavior-doc-static-admission must depend on pure declarations and source-bound plan');
    }
    const admissionCommand = admission.runs.filter((command) =>
        /(?:^|\s)(?:\.\/)?tools\/test\.sh\s+ci-tier\s+behavior-doc-static-admission\s+--no-deps(?:\s|$)/u
            .test(command));
    if (admissionCommand.length !== 1)
    {
        errors.push('behavior-doc-static-admission must execute its unique matrix tier exactly once');
    }
    if (![...admission.uploadPaths].some((uploadPath) =>
        pathPatternCovers(uploadPath, '.tmp/behavior-doc-static-admission/receipt.json')))
    {
        errors.push('behavior-doc-static-admission must upload its sealed receipt');
    }
    const forbiddenAdmissionOperations = admission.runs.filter((command) =>
        /(?:docker|podman|playwright\s+install|npm\s+--prefix\s+src\/frontend\s+ci|bootstrap-acceptance-env|tools\/test\/bundles\/)/u
            .test(command));
    if (forbiddenAdmissionOperations.length > 0)
    {
        errors.push(
            `behavior-doc-static-admission must remain static and fixture-free: ${forbiddenAdmissionOperations.join('; ')}`
        );
    }

    const nonCandidates = new Set(['validate-declarations', 'source-governance', 'plan-pr-risk', admissionId]);
    for (const [jobId, job] of workflowJobs)
    {
        if (nonCandidates.has(jobId))
        {
            continue;
        }
        const source = job.lines.join('\n');
        if (!job.needs.has(admissionId))
        {
            errors.push(`workflow candidate job ${jobId} must depend on ${admissionId}`);
        }
        if (!job.consumesBehaviorDocAdmission)
        {
            errors.push(`workflow candidate job ${jobId} must verify the sealed ${admissionId} receipt`);
        }
        const consumerInputKeys = [...job.behaviorDocAdmissionConsumerInputKeys].sort();
        if (job.behaviorDocAdmissionConsumerSteps.length === 1
      && (consumerInputKeys.length !== 2
        || consumerInputKeys[0] !== 'receipt-digest'
        || consumerInputKeys[1] !== 'source-fingerprint'))
        {
            errors.push(
                `workflow candidate job ${jobId} BehaviorDoc consumer must pass exactly`
        + ` receipt-digest and source-fingerprint; found ${consumerInputKeys.join(', ') || 'none'}`
            );
        }
        if (job.npmCiCommands.length > 0 && !job.hasNpmLockCache)
        {
            errors.push(
                `workflow candidate job ${jobId} must keep the frontend npm cache inputs`
        + ' on its actions/setup-node step'
            );
        }
        if (/^ {8}if:\s*always\(\)/mu.test(source)
      && !/needs\.behavior-doc-static-admission\.result\s*==\s*'success'/u.test(source))
        {
            errors.push(
                `workflow candidate job ${jobId} uses always() without requiring`
        + ' behavior-doc-static-admission result success'
            );
        }
    }
}

function main()
{
    const planPath = path.resolve(root, process.argv[2] ?? defaultPlanPath);
    const workflowPath = path.resolve(root, process.argv[3] ?? defaultWorkflowPath);
    const plan = loadPlan(planPath);
    const matrix = parseMatrix(fs.readFileSync(matrixPath, 'utf8'));
    const tiersById = new Map(matrix.tiers.map((tier) => [tier.id, tier]));
    const workflowText = fs.readFileSync(workflowPath, 'utf8');
    const workflowJobs = parseWorkflow(workflowText);
    const errors = [];

    if (workflowHasGlobalPlaywrightWorkers(workflowText))
    {
        errors.push('workflow must not set FSUSBLOG_PLAYWRIGHT_WORKERS globally; use matrix tier playwrightWorkers policy');
    }
    validateProductionBuildFanout(workflowText, workflowJobs, errors);
    validateBrowserWorkflowTopology(workflowJobs, errors);
    validateBehaviorDocStaticAdmissionTopology(workflowJobs, errors);
    validateMatrixCoverageDimensions(matrix.tiers, errors);

    const isWorkflowRequiredTier = (tierId) =>
    {
        const tier = tiersById.get(tierId);
        if (!tier)
        {
            errors.push(`CI plan references missing matrix tier: ${tierId}`);
            return false;
        }
        return tier.localOnly !== true && tier.nightlyOnly !== true && tier.manualOnly !== true;
    };

    const requiredPlanJobs = plan.jobs.filter((job) => job.tiers.some(isWorkflowRequiredTier));
    const planJobsById = new Map(plan.jobs.map((job) => [job.id, job]));
    const requiredJobIds = new Set(requiredPlanJobs.map((job) => job.id));

    for (const [jobId, workflowJob] of workflowJobs.entries())
    {
        for (const need of workflowJob.needs)
        {
            if (!workflowJobs.has(need))
            {
                errors.push(`workflow job ${jobId} needs undefined workflow job: ${need}`);
            }
        }
        if (
            [...workflowJob.uploadPaths].some((uploadPath) => normalizeArtifactPath(uploadPath).startsWith('.tmp/'))
      && workflowJob.hiddenUploadArtifactCount !== workflowJob.uploadArtifactCount
        )
        {
            errors.push(`workflow job ${jobId} uploads .tmp evidence but not every upload-artifact step sets include-hidden-files: true`);
        }
    }

    for (const jobId of workflowJobs.keys())
    {
        if (!requiredJobIds.has(jobId))
        {
            errors.push(`workflow job ${jobId} is not declared by required matrix ciJob metadata`);
        }
    }

    for (const job of requiredPlanJobs)
    {
        if (!workflowJobs.has(job.id))
        {
            errors.push(`workflow is missing matrix ciJob: ${job.id} (tiers: ${job.tiers.join(', ')})`);
            continue;
        }

        const actualNeeds = workflowJobs.get(job.id).needs;
        const workflowJob = workflowJobs.get(job.id);
        if (workflowJob.referencesValidateMatrixOutputs && !actualNeeds.has('validate-matrix'))
        {
            errors.push(`workflow job ${job.id} reads needs.validate-matrix.outputs but does not declare validate-matrix in needs`);
        }
        const actualTimeout = workflowJobs.get(job.id).timeoutMinutes;
        const actualMaxParallel = workflowJobs.get(job.id).maxParallel;
        if (actualTimeout !== Number(job.timeoutMinutes))
        {
            errors.push(`workflow job ${job.id} timeout-minutes ${actualTimeout ?? 'missing'} does not match ci-plan ${job.timeoutMinutes}`);
        }
        const jobHasShards = job.tiers.some((tierId) => tiersById.get(tierId)?.shardable === true);
        const expectedMaxParallelOutput = `${job.id.replaceAll('-', '_')}_max_parallel`;
        const usesExpectedMaxParallelOutput = workflowJob.maxParallelOutput === expectedMaxParallelOutput;
        const usesScheduledCiJob = workflowJob.scheduledCiJobs.has(job.id);
        if (jobHasShards && !usesScheduledCiJob && actualMaxParallel !== Number(job.maxParallel) && !usesExpectedMaxParallelOutput)
        {
            errors.push(`workflow job ${job.id} max-parallel ${actualMaxParallel ?? 'missing'} does not match ci-plan ${job.maxParallel}`);
        }

        for (const need of job.needs.filter((id) => requiredJobIds.has(id)))
        {
            if (!actualNeeds.has(need))
            {
                errors.push(`workflow job ${job.id} is missing ci-plan dependency: ${need}`);
            }
        }

        if (job.id !== 'production-summary')
        {
            const aggregateJob = validateAggregateWorkflowJob(matrix, workflowJob, job, errors);
            validateScheduledFastDag(workflowJob, job, errors);
            validateFastSummaryAggregate(workflowJob, job, errors);
            const coveredTiers = coveredTiersForWorkflowJob(workflowJob, tiersById, job.tiers);
            validateWorkflowBootstrapMetadata(job.id, workflowJob, actualNeeds, planJobsById, tiersById, coveredTiers, errors);
            validateWorkflowSetup(job.id, workflowJob, setupRequirementsForTiers(coveredTiers, tiersById), errors);
            const bootstrapCount = bootstrapExecutionsForWorkflowJob(workflowJob, tiersById);
            if (bootstrapCount > 1)
            {
                errors.push(`workflow job ${job.id} runs bootstrap ${bootstrapCount} times; bootstrap must run at most once per job`);
            }
            for (const tier of job.tiers.filter(isWorkflowRequiredTier))
            {
                if (!coveredTiers.has(tier))
                {
                    errors.push(`workflow job ${job.id} does not run matrix tier: ${tier}`);
                }
            }

            const uploadPaths = workflowJobs.get(job.id).uploadPaths;
            if (aggregateJob)
            {
                if (![...uploadPaths].some((uploadPath) =>
                    pathPatternCovers(uploadPath, '.tmp/release-evidence/jobs/**')))
                {
                    errors.push(`workflow job ${job.id} does not upload its aggregate job-result receipt`);
                }
            }
            else
            {
                for (const artifact of job.artifacts)
                {
                    if (![...uploadPaths].some((uploadPath) => pathPatternCovers(uploadPath, artifact)))
                    {
                        errors.push(`workflow job ${job.id} does not upload matrix artifact: ${artifact}`);
                    }
                }
                for (const evidence of job.evidence.filter(requiresUpload))
                {
                    if (![...uploadPaths].some((uploadPath) => pathPatternCovers(uploadPath, evidence)))
                    {
                        errors.push(`workflow job ${job.id} does not upload generated matrix evidence: ${evidence}`);
                    }
                }
            }
        }
    }

    for (const [jobId, workflowJob] of workflowJobs.entries())
    {
        const plannedTierIds = plan.jobs.find((job) => job.id === jobId)?.tiers ?? [];
        for (const tierId of coveredTiersForWorkflowJob(workflowJob, tiersById, plannedTierIds))
        {
            const tier = tiersById.get(tierId);
            if (tier?.localOnly === true)
            {
                errors.push(`workflow job ${jobId} runs local-only matrix tier: ${tierId}`);
            }
            if (tier?.nightlyOnly === true)
            {
                errors.push(`workflow job ${jobId} runs nightly-only matrix tier: ${tierId}`);
            }
            if (tier?.manualOnly === true)
            {
                errors.push(`workflow job ${jobId} runs manual-only matrix tier: ${tierId}`);
            }
        }
    }

    const productionTier = tiersById.get('production');
    for (const dep of tierExecutionDependencies(productionTier))
    {
        const depTier = tiersById.get(dep);
        if (!depTier || !isWorkflowRequiredTier(dep))
        {
            continue;
        }
        if (!workflowJobs.has(depTier.ciJob))
        {
            errors.push(`production dependency ${dep} maps to missing workflow job: ${depTier.ciJob}`);
        }
    }

    if (errors.length > 0)
    {
        for (const error of errors)
        {
            console.error(`[workflow-matrix-sync] ${error}`);
        }
        process.exit(1);
    }

    console.log(`[workflow-matrix-sync] ok (${requiredPlanJobs.length} required jobs)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === directFile)
{
    try
    {
        main();
    }
    catch (error)
    {
        console.error(`[workflow-matrix-sync] ${error.message}`);
        process.exit(1);
    }
}
