#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMatrix, tierExecutionDependencies } from './test-matrix/parse-matrix.mjs';
import { loadCanonicalReleaseFinalEvidenceInputs } from './test-matrix/release-final-evidence-contract.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const docsOutputRoot = path.resolve(process.env.FSUSBLOG_DOCS_EVIDENCE_DIR || path.join(root, '.tmp/docs'));
const docsEvidence = (name) => path.join(docsOutputRoot, name);
const matrixSourceText = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
const structuredMatrix = parseMatrix(matrixSourceText);
const structuredTiers = new Map(structuredMatrix.tiers.map((tier) => [tier.id, tier]));

function requireFileIncludes(file, expected, message)
{
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (!text.includes(expected))
    {
        console.error(`[test-matrix] ${message}`);
        process.exit(1);
    }
}

function requireFileExcludes(file, forbidden, message)
{
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (text.includes(forbidden))
    {
        console.error(`[test-matrix] ${message}`);
        process.exit(1);
    }
}

function requireCondition(condition, message)
{
    if (!condition)
    {
        console.error(`[test-matrix] ${message}`);
        process.exit(1);
    }
}

function readJsonFile(file)
{
    return JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'));
}

function validateStructuredToolWiring()
{
    const tiers = structuredTiers;
    const requireTierDependencies = (tierId, expected) =>
    {
        const tier = tiers.get(tierId);
        requireCondition(Boolean(tier), `structured matrix is missing tier ${tierId}`);
        requireCondition(
            JSON.stringify(tierExecutionDependencies(tier)) === JSON.stringify(expected),
            `${tierId}.executionDependsOn must equal ${expected.join(', ')}`
        );
    };
    requireTierDependencies('data-scale-evidence-summary', ['data-scale-xs', 'data-scale-s']);
    requireTierDependencies('performance-evidence-summary', [
        'load-baseline',
        'load-peak',
        'backend-benchmark-regression'
    ]);
    const releaseDependencies = new Set(tierExecutionDependencies(tiers.get('release-evidence')));
    for (const aggregate of ['data-scale-evidence-summary', 'performance-evidence-summary'])
    {
        requireCondition(releaseDependencies.has(aggregate), `release-evidence must depend on ${aggregate}`);
    }

    const scripts = readJsonFile('src/frontend/package.json').scripts ?? {};
    for (const mode of ['smoke', 'visual', 'boundaries'])
    {
        const name = `check:ux:viewport-${mode}`;
        const command = scripts[name];
        requireCondition(typeof command === 'string', `frontend package is missing ${name}`);
        const tokens = command.trim().split(/\s+/u);
        const runnerIndex = tokens.findIndex((token) => token.endsWith('run-ux-viewport-playwright.mjs'));
        requireCondition(runnerIndex >= 0, `${name} must invoke the summary-preserving viewport runner`);
        requireCondition(tokens[runnerIndex + 1] === mode, `${name} must pass mode ${mode} to the viewport runner`);
        requireCondition(!tokens.includes('write-ux-viewport-summary.mjs'), `${name} must not chain a second summary writer`);
    }
}

validateStructuredToolWiring();

const executionClassContract = spawnSync(process.execPath, ['tools/test/check-producer-execution-class-contract.mjs'], {
    cwd: root,
    encoding: 'utf8'
});
if (executionClassContract.stdout)
{
    process.stdout.write(executionClassContract.stdout);
}
if (executionClassContract.stderr)
{
    process.stderr.write(executionClassContract.stderr);
}
requireCondition(executionClassContract.status === 0, 'matrix producer execution-class contract must remain complete');

function run(args)
{
    const result = spawnSync('node', ['tools/run-test-matrix.mjs', ...args], {
        cwd: root,
        encoding: 'utf8'
    });
    if (result.stdout)
    {
        process.stdout.write(result.stdout);
    }
    if (result.stderr)
    {
        process.stderr.write(result.stderr);
    }
    if (result.status !== 0)
    {
        process.exit(result.status ?? 1);
    }
}

function output(args)
{
    const result = spawnSync('node', ['tools/run-test-matrix.mjs', ...args], {
        cwd: root,
        encoding: 'utf8'
    });
    if (result.stderr)
    {
        process.stderr.write(result.stderr);
    }
    if (result.status !== 0)
    {
        process.exit(result.status ?? 1);
    }
    return result.stdout;
}

function runTestSh(args)
{
    if (process.platform === 'win32')
    {
        const script = fs.readFileSync(path.join(root, 'tools/test.sh'), 'utf8');
        if (!script.includes('tools/run-test-matrix.mjs') || !script.includes('ci-plan --format github-actions'))
        {
            console.error('[test-matrix] tools/test.sh does not delegate ci-plan to run-test-matrix');
            process.exit(1);
        }
        if (args[0] === 'ci-plan')
        {
            run(['ci-plan', '--format', 'github-actions', ...args.slice(1)]);
            return;
        }
    }

    const script = 'tools/test.sh';
    const result = spawnSync('bash', [script, ...args], {
        cwd: root,
        encoding: 'utf8'
    });
    if (result.stdout)
    {
        process.stdout.write(result.stdout);
    }
    if (result.stderr)
    {
        process.stderr.write(result.stderr);
    }
    if (result.status !== 0)
    {
        process.exit(result.status ?? 1);
    }
}

function escapeRegExp(value)
{
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function locateTier(matrixText, tierId)
{
    const lines = matrixText.split('\n');
    const idPattern = new RegExp(`^(\\s*)-\\s+id:\\s+${escapeRegExp(tierId)}\\s*(?:#.*)?$`, 'u');
    const start = lines.findIndex((line) => idPattern.test(line));
    if (start < 0)
    {
        console.error(`[test-matrix] missing ${tierId} in matrix fixture`);
        process.exit(1);
    }
    const indent = lines[start].match(/^(\s*)/u)?.[1].length ?? 0;
    let end = start + 1;
    while (end < lines.length)
    {
        if (!lines[end].trim())
        {
            end += 1;
            continue;
        }
        const nextIndent = lines[end].match(/^(\s*)/u)?.[1].length ?? 0;
        if (nextIndent <= indent)
        {
            break;
        }
        end += 1;
    }
    return { lines, start, end, fieldIndent: indent + 2 };
}

function replaceTierField(matrixText, tierId, field, value)
{
    const tier = locateTier(matrixText, tierId);
    const fieldPattern = new RegExp(`^\\s{${tier.fieldIndent}}${escapeRegExp(field)}:\\s*.*$`, 'u');
    const fieldIndex = tier.lines.findIndex((line, index) => index > tier.start && index < tier.end && fieldPattern.test(line));
    if (fieldIndex < 0)
    {
        console.error(`[test-matrix] missing ${tierId}.${field} in matrix fixture`);
        process.exit(1);
    }
    let fieldEnd = fieldIndex + 1;
    while (fieldEnd < tier.end && tier.lines[fieldEnd].trim())
    {
        const indent = tier.lines[fieldEnd].match(/^(\s*)/u)?.[1].length ?? 0;
        if (indent <= tier.fieldIndent)
        {
            break;
        }
        fieldEnd += 1;
    }
    tier.lines.splice(
        fieldIndex,
        fieldEnd - fieldIndex,
        `${' '.repeat(tier.fieldIndent)}${field}: ${value}`
    );
    return tier.lines.join('\n');
}

function setTierBooleanField(matrixText, tierId, field, value)
{
    const tier = locateTier(matrixText, tierId);
    const fieldPattern = new RegExp(`^\\s{${tier.fieldIndent}}${escapeRegExp(field)}:\\s*.*$`, 'u');
    const fieldIndex = tier.lines.findIndex((line, index) => index > tier.start && index < tier.end && fieldPattern.test(line));
    if (fieldIndex >= 0)
    {
        tier.lines[fieldIndex] = `${' '.repeat(tier.fieldIndent)}${field}: ${value}`;
        return tier.lines.join('\n');
    }
    const anchorPattern = new RegExp(`^\\s{${tier.fieldIndent}}requiresBootstrap:\\s*.*$`, 'u');
    const anchorIndex = tier.lines.findIndex((line, index) => index > tier.start && index < tier.end && anchorPattern.test(line));
    if (anchorIndex < 0)
    {
        console.error(`[test-matrix] missing ${tierId}.requiresBootstrap insertion anchor in matrix fixture`);
        process.exit(1);
    }
    tier.lines.splice(anchorIndex + 1, 0, `${' '.repeat(tier.fieldIndent)}${field}: ${value}`);
    return tier.lines.join('\n');
}

function removeTier(matrixText, tierId)
{
    const tier = locateTier(matrixText, tierId);
    tier.lines.splice(tier.start, tier.end - tier.start);
    return tier.lines.join('\n');
}

function removeTierField(matrixText, tierId, field)
{
    const tier = locateTier(matrixText, tierId);
    const fieldPattern = new RegExp(`^\\s{${tier.fieldIndent}}${escapeRegExp(field)}:\\s*.*$`, 'u');
    const fieldIndex = tier.lines.findIndex((line, index) => index > tier.start && index < tier.end && fieldPattern.test(line));
    if (fieldIndex < 0)
    {
        console.error(`[test-matrix] missing ${tierId}.${field} in matrix fixture`);
        process.exit(1);
    }
    tier.lines.splice(fieldIndex, 1);
    return tier.lines.join('\n');
}

function locateWorkflowJob(workflowText, jobId)
{
    const lines = workflowText.split('\n');
    const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
    if (jobsIndex < 0)
    {
        throw new Error('workflow fixture is missing jobs');
    }
    const jobsIndent = lines[jobsIndex].match(/^(\s*)/u)?.[1].length ?? 0;
    const jobPattern = new RegExp(`^(\\s*)${escapeRegExp(jobId)}:\\s*$`, 'u');
    const start = lines.findIndex((line, index) => index > jobsIndex && jobPattern.test(line));
    if (start < 0)
    {
        throw new Error(`workflow fixture is missing job ${jobId}`);
    }
    const jobIndent = lines[start].match(/^(\s*)/u)?.[1].length ?? 0;
    if (jobIndent <= jobsIndent)
    {
        throw new Error(`workflow job ${jobId} is not nested under jobs`);
    }
    let end = start + 1;
    while (end < lines.length)
    {
        if (!lines[end].trim())
        {
            end += 1;
            continue;
        }
        const indent = lines[end].match(/^(\s*)/u)?.[1].length ?? 0;
        if (indent <= jobIndent)
        {
            break;
        }
        end += 1;
    }
    const directIndents = lines.slice(start + 1, end)
        .filter((line) => /^\s*[A-Za-z0-9_-]+:/u.test(line))
        .map((line) => line.match(/^(\s*)/u)?.[1].length ?? 0)
        .filter((indent) => indent > jobIndent);
    const fieldIndent = Math.min(...directIndents);
    if (!Number.isFinite(fieldIndent))
    {
        throw new Error(`workflow job ${jobId} has no fields`);
    }
    return { lines, start, end, jobIndent, fieldIndent };
}

function replaceWorkflowJobField(workflowText, jobId, field, value)
{
    const job = locateWorkflowJob(workflowText, jobId);
    const pattern = new RegExp(`^\\s{${job.fieldIndent}}${escapeRegExp(field)}:\\s*.*$`, 'u');
    const index = job.lines.findIndex((line, lineIndex) => lineIndex > job.start && lineIndex < job.end && pattern.test(line));
    if (index < 0)
    {
        throw new Error(`workflow job ${jobId} is missing ${field}`);
    }
    job.lines[index] = `${' '.repeat(job.fieldIndent)}${field}: ${value}`;
    return job.lines.join('\n');
}

function mutateWorkflowJob(workflowText, jobId, transform)
{
    const job = locateWorkflowJob(workflowText, jobId);
    const source = job.lines.slice(job.start, job.end).join('\n');
    const updated = transform(source, job);
    job.lines.splice(job.start, job.end - job.start, ...updated.split('\n'));
    return job.lines.join('\n');
}

function appendWorkflowNeed(workflowText, jobId, need)
{
    return mutateWorkflowJob(workflowText, jobId, (source, job) =>
    {
        const lines = source.split('\n');
        const pattern = new RegExp(`^\\s{${job.fieldIndent}}needs:\\s*(?:\\[([^\\]]*)\\])?\\s*$`, 'u');
        const index = lines.findIndex((line) => pattern.test(line));
        if (index < 0)
        {
            throw new Error(`workflow job ${jobId} does not use block needs`);
        }
        const inline = lines[index].match(pattern)?.[1];
        if (inline !== undefined)
        {
            const existing = inline.replace(/,\s*$/u, '');
            lines[index] = `${' '.repeat(job.fieldIndent)}needs: [${existing.trim() ? `${existing}, ` : ''}${need}]`;
            return lines.join('\n');
        }
        const childIndent = job.fieldIndent + (job.fieldIndent - job.jobIndent);
        lines.splice(index + 1, 0, `${' '.repeat(childIndent)}- ${need}`);
        return lines.join('\n');
    });
}

function writeTempMatrix(matrixText)
{
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-matrix-'));
    const tempMatrix = path.join(tempDir, 'matrix.yml');
    fs.writeFileSync(tempMatrix, matrixText);
    return { tempDir, tempMatrix };
}

function expectMatrixValidateFailure(matrixText, expected, message)
{
    const { tempDir, tempMatrix } = writeTempMatrix(matrixText);
    const result = spawnSync('node', ['tools/run-test-matrix.mjs', 'validate'], {
        cwd: root,
        env: { ...process.env, FSUSBLOG_MATRIX_FILE: tempMatrix },
        encoding: 'utf8'
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
    const outputText = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const expectedDiagnostics = Array.isArray(expected) ? expected : [expected];
    if (result.status === 0 || expectedDiagnostics.length === 0
        || expectedDiagnostics.some((diagnostic) => !outputText.includes(diagnostic)))
    {
        console.error(`[test-matrix] ${message}`);
        console.error(outputText);
        process.exit(1);
    }
}

function expectWorkflowSyncFailure(matrixText, expected, message)
{
    const { tempDir, tempMatrix } = writeTempMatrix(matrixText);
    const planPath = path.join(tempDir, 'ci-plan.json');
    const planResult = spawnSync('node', ['tools/run-test-matrix.mjs', 'ci-plan', '--format', 'github-actions', '--out', planPath], {
        cwd: root,
        env: { ...process.env, FSUSBLOG_MATRIX_FILE: tempMatrix },
        encoding: 'utf8'
    });
    if (planResult.status !== 0)
    {
        if (planResult.stdout)
        {
            process.stdout.write(planResult.stdout);
        }
        if (planResult.stderr)
        {
            process.stderr.write(planResult.stderr);
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
        process.exit(planResult.status ?? 1);
    }

    const result = spawnSync('node', ['tools/check-workflow-matrix-sync.mjs', planPath, '.github/workflows/quality-gate.yml'], {
        cwd: root,
        env: { ...process.env, FSUSBLOG_MATRIX_FILE: tempMatrix },
        encoding: 'utf8'
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
    const outputText = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status === 0 || !outputText.includes(expected))
    {
        console.error(`[test-matrix] ${message}`);
        console.error(outputText);
        process.exit(1);
    }
}

function expectWorkflowTextFailure(transform, expected, message)
{
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-workflow-'));
    const workflowFile = path.join(tempDir, 'quality-gate.yml');
    const planFile = path.join(tempDir, 'ci-plan.json');
    const workflowSource = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
    fs.writeFileSync(workflowFile, transform(workflowSource));
    const planResult = spawnSync('node', ['tools/run-test-matrix.mjs', 'ci-plan', '--format', 'github-actions', '--out', planFile], {
        cwd: root,
        encoding: 'utf8'
    });
    if (planResult.status !== 0)
    {
        fs.rmSync(tempDir, { recursive: true, force: true });
        process.exit(planResult.status ?? 1);
    }
    const result = spawnSync('node', ['tools/check-workflow-matrix-sync.mjs', planFile, workflowFile], {
        cwd: root,
        encoding: 'utf8'
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
    const outputText = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status === 0 || !outputText.includes(expected))
    {
        console.error(`[test-matrix] ${message}`);
        console.error(outputText);
        process.exit(1);
    }
}

expectMatrixValidateFailure(
    replaceTierField(matrixSourceText, 'coverage-backend', 'phase', '5'),
    'coverage-merge depends on coverage-backend with later phase 5 > 4',
    'validate must reject dependency phase inversion'
);

expectMatrixValidateFailure(
    replaceTierField(matrixSourceText, 'integration', 'executionDependsOn', '[]'),
    'integration.requiresBootstrap=full needs dependency path to bootstrap, selfBootstraps=true, or workflowBootstraps=true',
    'validate must reject runtime tiers without an explicit bootstrap source'
);

expectWorkflowSyncFailure(
    setTierBooleanField(matrixSourceText, 'runtime-cache-public-hot-read', 'workflowBootstraps', 'false'),
    'workflow job backend-qps-collectors manually runs bootstrap but tier runtime-cache-public-hot-read does not declare workflowBootstraps=true',
    'workflow manual bootstrap must be backed by matrix metadata'
);

expectWorkflowTextFailure(
    (workflow) => replaceWorkflowJobField(workflow, 'fast-backend', 'needs', '[validate-matrix, missing-workflow-job]'),
    'workflow job fast-backend needs undefined workflow job: missing-workflow-job',
    'workflow sync must reject undefined GitHub Actions needs before workflow load time'
);

expectWorkflowTextFailure(
    (workflow) => mutateWorkflowJob(workflow, 'fast-backend', (job) => job.replace(
        /^(\s*)- uses: actions\/checkout@[^\n]+$/mu,
        '$&\n$1- run: npm --prefix src/frontend exec -- playwright install chromium'
    )),
    'browserless workflow job fast-backend must not install Playwright browsers',
    'workflow sync must reject hidden browser installation in a browserless job'
);

expectWorkflowTextFailure(
    (workflow) => replaceWorkflowJobField(workflow, 'browser-contract', 'timeout-minutes', '11'),
    'workflow job browser-contract timeout-minutes 11 does not match ci-plan 20',
    'workflow sync must reject Browser Contract timeout drift'
);

expectWorkflowTextFailure(
    (workflow) => appendWorkflowNeed(workflow, 'production-summary', 'browser-contract'),
    'production-summary must remain browserless and must not wait for browser-contract',
    'workflow sync must reject Browser Contract as a production summary dependency'
);

expectWorkflowSyncFailure(
    matrixSourceText.replace('identity-kind-anonymous-account', 'identity-kind-legacy-user'),
    'matrix coverage dimensions missing required identity kind: identity-kind-anonymous-account',
    'workflow sync must reject matrices without anonymous account identity-kind coverage'
);

expectMatrixValidateFailure(
    removeTierField(matrixSourceText, 'validate-matrix', 'cadence'),
    'validate-matrix missing cadence',
    'validate must require explicit cadence metadata'
);

expectMatrixValidateFailure(
    setTierBooleanField(matrixSourceText, 'ux-viewport-visual', 'nightlyOnly', 'false'),
    'ux-viewport-visual.cadence=nightly requires nightlyOnly=true',
    'nightly diagnostics tiers must declare nightly-only cadence ownership'
);

expectMatrixValidateFailure(
    setTierBooleanField(matrixSourceText, 'release-final', 'requiredFor', 'production'),
    'release-final.manualOnly must not be requiredFor=production',
    'manual-only tiers must not count as ordinary production coverage'
);

expectMatrixValidateFailure(
    replaceTierField(matrixSourceText, 'production-correctness', 'executionDependsOn', '[fast, acceptance]'),
    'production-correctness dependency closure must be browserless: acceptance',
    'production correctness must reject any transitive Playwright tier'
);

expectMatrixValidateFailure(
    replaceTierField(matrixSourceText, 'production-correctness', 'evidenceClass', 'diagnostic'),
    'production-correctness must use requiresPlaywright=none, requiredFor=production, and evidenceClass=correctness',
    'production correctness evidence must stay authoritative and browserless'
);

expectMatrixValidateFailure(
    replaceTierField(matrixSourceText, 'acceptance', 'evidenceClass', 'correctness'),
    'acceptance.requiresPlaywright=chromium requires evidenceClass=diagnostic',
    'real browser diagnostics must not be relabeled as correctness'
);

expectMatrixValidateFailure(
    replaceTierField(matrixSourceText, 'browser-contract', 'resourceClass', 'network'),
    'browser-contract.requiresPlaywright=chromium requires resourceClass=browser',
    'every browser tier must declare the browser resource boundary'
);

expectMatrixValidateFailure(
    replaceTierField(matrixSourceText, 'release-final', 'executionDependsOn', '[production-correctness]'),
    'release-final.executionDependsOn must be empty; canonical producer tiers are evidence inputs only',
    'release-final must reject producer execution dependencies'
);

expectMatrixValidateFailure(
    replaceTierField(matrixSourceText, 'release-final', 'requiresEvidenceFrom', '[missing-evidence-producer]'),
    [
        'release-final.requiresEvidenceFrom must contain exactly 22 canonical evidence inputs; got 1',
        'release-final.requiresEvidenceFrom is missing canonical evidence inputs: '
            + loadCanonicalReleaseFinalEvidenceInputs().inputs.join(', '),
        'release-final.requiresEvidenceFrom contains unexpected evidence inputs: missing-evidence-producer'
    ],
    'release-final must reject missing evidence producers'
);

expectMatrixValidateFailure(
    removeTier(matrixSourceText, 'browser-contract'),
    'canonical release-final evidence inputs reference missing tiers: browser-contract',
    'release-final must reject missing evidence producers'
);

expectMatrixValidateFailure(
    replaceTierField(matrixSourceText, 'coverage-gate', 'requiresEvidenceFrom', '[missing-evidence-producer]'),
    'coverage-gate requires evidence from missing tier missing-evidence-producer',
    'validate must reject missing evidence producers outside the release-final parse boundary'
);

expectMatrixValidateFailure(
    removeTier(matrixSourceText, 'frontend-build'),
    'finite execution target tools/test/lanes/frontend-build.sh is missing',
    'validate must reject missing frontend-fast split tiers'
);

expectMatrixValidateFailure(
    replaceTierField(matrixSourceText, 'frontend-build', 'ciJob', 'fast-backend'),
    'frontend-build.ciJob must be frontend-build',
    'frontend fast split must reject a mismatched frontend-build CI job'
);

run(['preflight']);
run(['validate']);
run(['plan', 'production']);
{
    const fastBackendPlan = output(['ci-job', 'fast-backend', '--plan-only']);
    process.stdout.write(fastBackendPlan);
    if (!fastBackendPlan.includes('scheduler: parallel'))
    {
        console.error('[test-matrix] fast-backend ci-job plan must advertise parallel scheduler');
        process.exit(1);
    }
    if (!fastBackendPlan.includes('FSUSBLOG_CI_JOB_SERIAL=1'))
    {
        console.error('[test-matrix] ci-job plan must document serial debug fallback');
        process.exit(1);
    }

    const coveragePlan = output(['ci-job', 'coverage-merge-threshold', '--plan-only']);
    if (!coveragePlan.includes('scheduler: serial'))
    {
        console.error('[test-matrix] exclusive-resource ci-job plan must remain serial');
        process.exit(1);
    }
}
run(['ci-job-matrix', 'fast-backend', '--out', docsEvidence('fast-backend-matrix.json')]);
run(['ci-job-matrix', 'fast-frontend-unit', '--out', docsEvidence('fast-frontend-unit-matrix.json')]);
run(['ci-job-matrix', 'browser-contract', '--out', docsEvidence('browser-contract-matrix.json')]);
for (const tierId of [
    'frontend-build',
    'frontend-unit-shard',
    'frontend-property-model-perf',
    'frontend-runtime-contracts',
    'frontend-static-governance',
    'frontend-fast-summary'
])
{
    requireFileIncludes(
        'tests/matrix.yml',
        `id: ${tierId}\n`,
        `frontend fast split must declare ${tierId}`
    );
}
{
    const matrix = readJsonFile(docsEvidence('fast-frontend-unit-matrix.json')).matrix;
    const shardCount = matrix.resource_resolution.defaultShards;
    const tierIds = matrix.include.map((entry) => entry.tier).sort();
    const expectedTierIds = [
        'coverage-frontend',
        'frontend-property-model-perf',
        ...Array.from({ length: shardCount }, () => 'frontend-unit-shard'),
        'ux-viewport-plan-progress'
    ].sort();
    requireCondition(
        JSON.stringify(tierIds) === JSON.stringify(expectedTierIds),
        'fast-frontend-unit effective plan must retain ordinary unit, coverage, property/model/perf and viewport governance when cross-tier coverage prevents safe superseding'
    );
    requireCondition(
        matrix.include.every((entry) => entry.tier === 'frontend-unit-shard'
            ? shardCount > 1
        ? Array.from({ length: shardCount }, (_, index) => `${index + 1}/${shardCount}`).includes(entry.shard)
          && new RegExp(`^fast-frontend-unit-\\d-of-${shardCount}$`).test(entry.artifact_name)
        : entry.shard === '' && entry.artifact_name === 'fast-frontend-unit-frontend-unit-shard'
            : entry.shard === '' && entry.artifact_name === `fast-frontend-unit-${entry.tier}`),
        'fast-frontend-unit tiers must preserve machine-resolved unit shards and independently attributable non-unit artifacts'
    );
}
{
    const matrix = readJsonFile(docsEvidence('browser-contract-matrix.json')).matrix;
    requireCondition(
        matrix.include.length === 2
      && matrix.include.some((entry) => entry.tier === 'browser-contract'
        && entry.shard === ''
        && entry.playwright_workers === 1
        && entry.max_parallel === 1
        && entry.timeout_minutes === 10
        && entry.artifact_name === 'browser-contract-browser-contract')
      && matrix.include.some((entry) => entry.tier === 'production-xss-release'
        && entry.shard === ''
        && entry.max_parallel === 1
        && entry.timeout_minutes === 20
        && entry.artifact_name === 'browser-contract-production-xss-release'),
        'browser-contract CI matrix must contain the fixed general contract and cross-engine XSS authority'
    );
}
run(['aggregate', 'fast-summary', '--dry-run', '--out', docsEvidence('fast-summary-aggregate-plan.json')]);
{
    const aggregatePlan = readJsonFile(docsEvidence('fast-summary-aggregate-plan.json'));
    const frontendMatrix = readJsonFile(docsEvidence('fast-frontend-unit-matrix.json')).matrix;
    const shardCount = frontendMatrix.resource_resolution.defaultShards;
    for (const summaryId of [
        'frontend-build',
        ...(shardCount > 1
            ? Array.from({ length: shardCount }, (_, index) => `fast-frontend-unit-${index + 1}-of-${shardCount}`)
            : ['fast-frontend-unit-frontend-unit-shard']),
        'fast-frontend-unit-coverage-frontend',
        'fast-frontend-unit-frontend-property-model-perf',
        'fast-backend-coverage-backend',
        'frontend-runtime-contracts',
        'frontend-static-governance'
    ])
    {
        requireCondition(
            aggregatePlan.requiredJobSummaries.includes(summaryId),
            `fast-summary aggregate plan must require ${summaryId}`
        );
    }
    requireCondition(
        aggregatePlan.requiredArtifactPaths.includes('.tmp/frontend/frontend-unit-shard.json'),
        'fast-summary aggregate must require ordinary unit evidence when safe superseding is unavailable'
    );
    requireCondition(
        aggregatePlan.requiredArtifactPaths.includes('.tmp/coverage/frontend/Summary.json'),
        'fast-summary aggregate must require coverage replacement evidence'
    );
}
run(['ci-tier', 'backend-fast', '--plan-only']);
{
    const frontendPlan = output(['ci-job', 'fast-frontend-unit', '--plan-only']);
    process.stdout.write(frontendPlan);
    const shardCount = readJsonFile(docsEvidence('fast-frontend-unit-matrix.json')).matrix.resource_resolution.defaultShards;
    if (!frontendPlan.includes(`./tools/test.sh ci-tier frontend-unit-shard --no-deps --shard 1/${shardCount}`)
      || !frontendPlan.includes('./tools/test.sh ci-tier coverage-frontend --no-deps')
      || !frontendPlan.includes('./tools/test.sh ci-tier frontend-property-model-perf --no-deps'))
    {
        console.error('[test-matrix] fast-frontend-unit plan must retain ordinary unit, coverage and special suites');
        process.exit(1);
    }
}
run(['ci-fast', '--plan-only']);
run(['ci-production', '--plan-only']);
run(['ci-plan', '--format', 'github-actions', '--out', docsEvidence('run-test-matrix-ci-plan-compat.json')]);
runTestSh(['ci-plan', '--out', docsEvidence('test-sh-ci-plan-compat.json')]);

{
    const result = spawnSync('node', [
        'tools/check-workflow-matrix-sync.mjs',
        docsEvidence('run-test-matrix-ci-plan-compat.json'),
        '.github/workflows/quality-gate.yml'
    ], {
        cwd: root,
        encoding: 'utf8'
    });
    if (result.stdout)
    {
        process.stdout.write(result.stdout);
    }
    if (result.stderr)
    {
        process.stderr.write(result.stderr);
    }
    if (result.status !== 0)
    {
        process.exit(result.status ?? 1);
    }
}

{
    const workflowPath = docsEvidence('quality-gate-hidden-artifact-regression.yml');
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8')
        .replace(/\n\s+include-hidden-files: true/u, '');
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, workflow);
    const result = spawnSync('node', [
        'tools/check-workflow-matrix-sync.mjs',
        docsEvidence('run-test-matrix-ci-plan-compat.json'),
        workflowPath
    ], { cwd: root, encoding: 'utf8' });
    requireCondition(
        result.status !== 0 && /include-hidden-files: true/u.test(result.stderr),
        'workflow checker must reject .tmp artifact uploads that omit include-hidden-files: true'
    );
}

for (const script of [
    'tools/ci/check-flaky-registry.mjs',
    'tools/ci/check-flaky-evidence.mjs',
    'tools/docs/generate-testing-docs.mjs',
    'tools/docs/check-time-budget-sync.mjs',
    'tools/test/generate-evidence-location-governance.mjs',
    'tools/test/generate-current-run-evidence-location-acceptance.mjs'
])
{
    const args = script.endsWith('generate-testing-docs.mjs')
        || script.endsWith('generate-evidence-location-governance.mjs')
        || script.endsWith('generate-current-run-evidence-location-acceptance.mjs')
        ? [script, '--check']
        : [script];
    const result = spawnSync('node', args, {
        cwd: root,
        encoding: 'utf8'
    });
    if (result.stdout)
    {
        process.stdout.write(result.stdout);
    }
    if (result.stderr)
    {
        process.stderr.write(result.stderr);
    }
    if (result.status !== 0)
    {
        process.exit(result.status ?? 1);
    }
}

requireFileIncludes(
    '.github/workflows/quality-gate.yml',
    'FSUSBLOG_TEST_SELECTION: full',
    'coverage-backed fast-backend workflow must execute the complete ordinary unit selection exactly once'
);
requireFileIncludes(
    '.github/workflows/quality-gate.yml',
    'node tools/verify-matrix-identity-kinds.mjs',
    'security-runtime workflow must verify anonymous migration identity-kind dimensions'
);
requireFileIncludes(
    'tests/matrix.yml',
    'anonymous-account-endpoint-protocol-status-cache-error-frame',
    'endpoint-depth coverage must include anonymous-account actor dimensions'
);
requireFileIncludes(
    'tests/matrix.yml',
    'admin-principal-endpoint-protocol-status-cache-error-frame',
    'endpoint-depth coverage must include admin-principal actor dimensions'
);
requireFileIncludes(
    'tests/matrix.yml',
    'endpoint-role-protocol-status-cache-error-frame-deprecated',
    'legacy endpoint-role-protocol coverage must be explicitly deprecated'
);
requireFileIncludes(
    'tools/dotnet-affected-tests.sh',
    'auth-security-sensitive',
    'affected backend selection must conservatively escalate auth/security changes'
);
requireFileIncludes(
    'docs/testing.md',
    'Backend affected-test selection',
    'docs/testing.md must document backend affected-test changed-file rules'
);
requireFileIncludes(
    '.github/workflows/quality-gate.yml',
    "FSUSBLOG_DOTNET_BUILD_PARALLELISM: ${{ vars.FSUSBLOG_DOTNET_BUILD_PARALLELISM || 'safe' }}",
    'fast-backend workflow must expose env-controlled .NET build parallelism'
);
requireFileIncludes(
    'tools/test/lanes/_suite-support.sh',
    'FSUSBLOG_DOTNET_BUILD_PARALLELISM',
    'backend build parallelism must be configurable through FSUSBLOG_DOTNET_BUILD_PARALLELISM'
);
requireFileIncludes(
    'tools/test/lanes/_suite-support.sh',
    'dotnet-build parallelism=',
    'backend build logs must print the selected .NET build parallelism mode'
);
requireFileIncludes(
    'docs/testing.md',
    'Backend build parallelism',
    'docs/testing.md must document backend build parallelism policy and benchmark notes'
);
requireFileIncludes(
    '.github/workflows/quality-gate.yml',
    './tools/test.sh ci-job fast-frontend-unit --fresh',
    'fast-frontend-unit workflow must run the resource-aware DAG in fresh mode'
);
requireFileIncludes(
    '.github/workflows/quality-gate.yml',
    'frontend-build:',
    'quality gate must run frontend build as an independent job'
);
requireFileIncludes(
    '.github/workflows/quality-gate.yml',
    'frontend-runtime-contracts:',
    'quality gate must run frontend runtime contracts as an independent job'
);
requireFileIncludes(
    '.github/workflows/quality-gate.yml',
    'frontend-static-governance:',
    'quality gate must run frontend static governance as an independent job'
);
requireFileIncludes(
    '.github/workflows/quality-gate.yml',
    './tools/test.sh ci-job fast-backend --fresh',
    'fast-backend workflow must run the resource-aware DAG in fresh mode'
);
requireFileIncludes(
    'docs/testing.md',
    'Frontend fast split',
    'docs/testing.md must document frontend-fast split reproduction and artifacts'
);
requireFileIncludes(
    'tools/test/lanes/_suite-support.sh',
    'RunFrontendFastBuildLane',
    'frontend-fast split must expose a standalone build lane'
);
requireFileIncludes(
    'tools/test/lanes/_suite-support.sh',
    'RunFrontendUnitShardLane',
    'frontend-fast split must expose a standalone unit shard lane'
);
requireFileIncludes(
    'tools/test/lanes/_suite-support.sh',
    'RunFrontendRuntimeContractsLane',
    'frontend-fast split must expose a standalone runtime contracts lane'
);
requireFileIncludes(
    'tools/test/lanes/_suite-support.sh',
    'RunFrontendStaticGovernanceLane',
    'frontend-fast split must expose a standalone static governance lane'
);
requireFileIncludes(
    'tools/test/lanes/_suite-support.sh',
    'RunFrontendFastSummaryLane',
    'frontend-fast split must expose a standalone summary lane'
);
requireFileIncludes(
    'tools/run-test-matrix.mjs',
    'frontendFastSplitIds',
    'matrix validator must know the required frontend-fast split tiers'
);
requireFileIncludes(
    'tools/ci/summarize-quality-gate.mjs',
    'groups: ${groups}',
    'quality gate summary must render frontend-fast group durations for failed jobs'
);
requireFileIncludes(
    'docs/testing.md',
    '`fast-summary` downloads these artifacts',
    'docs/testing.md must document frontend-fast split aggregate evidence'
);
{
    const parsed = parseMatrix(matrixSourceText);
    const tiers = new Map(parsed.tiers.map((tier) => [tier.id, tier]));
    const production = tiers.get('production-correctness');
    const contract = tiers.get('browser-contract');
    const productionXssRelease = tiers.get('production-xss-release');
    const acceptance = tiers.get('acceptance');
    const releaseFinal = tiers.get('release-final');
    requireCondition(
        production?.requiresPlaywright === 'none'
      && production?.requiredFor === 'production'
      && production?.evidenceClass === 'correctness'
      && tierExecutionDependencies(production).includes('release-evidence')
      && !tierExecutionDependencies(production).includes('acceptance'),
        'production-correctness must be the browserless production aggregate'
    );
    requireCondition(
        contract?.ciJob === 'browser-contract'
      && contract?.resourceClass === 'browser'
      && contract?.requiresPlaywright === 'chromium'
      && contract?.evidenceClass === 'browser-contract'
      && contract?.parallelizable === false
      && contract?.timeoutMinutes === 10
      && contract?.selfBootstraps === true,
        'browser-contract must remain the fixed general release Chromium boundary'
    );
    requireCondition(
        productionXssRelease?.ciJob === 'browser-contract'
      && productionXssRelease?.resourceClass === 'browser'
      && productionXssRelease?.requiresPlaywright === 'all'
      && productionXssRelease?.evidenceClass === 'browser-contract'
      && productionXssRelease?.parallelizable === false
      && productionXssRelease?.requiredFor === 'release-final',
        'production-xss-release must remain the fixed cross-engine release security boundary'
    );
    requireCondition(
        acceptance?.ciJob === 'browser-diagnostics'
      && acceptance?.requiredFor === 'none'
      && acceptance?.evidenceClass === 'diagnostic'
      && acceptance?.nightlyOnly === true,
        'legacy acceptance must be diagnostics-only'
    );
    requireCondition(
        releaseFinal?.requiresPlaywright === 'none'
      && releaseFinal?.evidenceClass === 'correctness'
      && tierExecutionDependencies(releaseFinal).length === 0
      && releaseFinal?.requiresEvidenceFrom?.includes('production-correctness')
      && releaseFinal?.requiresEvidenceFrom?.includes('browser-contract')
      && releaseFinal?.requiresEvidenceFrom?.includes('production-xss-release'),
        'release-final must bind browserless correctness and both release browser authorities as evidence only'
    );
}
{
    const workflowText = fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
    const browserJob = locateWorkflowJob(workflowText, 'browser-contract');
    const browserJobText = browserJob.lines.slice(browserJob.start, browserJob.end).join('\n');
    requireCondition(
        /^\s*name:\s*Browser Contract\s*$/mu.test(browserJobText),
        'quality gate must expose one explicit Browser Contract job'
    );
}
requireFileExcludes(
    '.github/workflows/quality-gate.yml',
    'acceptance_playwright_matrix',
    'ordinary quality gate must not generate an acceptance Playwright shard matrix'
);
requireFileExcludes(
    '.github/workflows/quality-gate.yml',
    'acceptance_playwright_max_parallel',
    'ordinary quality gate must not consume acceptance Playwright shard concurrency'
);
requireCondition(
    structuredTiers.get('ux-viewport-smoke')?.owner === 'InteropGlueAgent'
    && structuredTiers.get('ux-viewport-smoke')?.command === 'tools/test/lanes/ux-viewport-smoke.sh',
    'ux-viewport-smoke tier must stay in the browser lane policy'
);
requireCondition(
    JSON.stringify(structuredTiers.get('ux-viewport-smoke')?.coverage) === JSON.stringify([
        'ux-viewport-boundary',
        'responsive-layout',
        'content-boundary'
    ]) && JSON.stringify(structuredTiers.get('ux-viewport-smoke')?.artifacts) === JSON.stringify([
        '.tmp/ux/viewport-smoke.json',
        '.tmp/release-evidence/ux-viewport-summary.json',
        'src/frontend/test-results/playwright/ux-viewport-smoke'
    ]),
    'ux-viewport-smoke artifacts must remain stable across shards'
);
requireFileExcludes(
    '.github/workflows/quality-gate.yml',
    'ux-viewport-smoke:',
    'ordinary quality gate must not define the UX viewport diagnostics job'
);
requireFileIncludes(
    'src/frontend/package.json',
    'run-ux-viewport-playwright.mjs smoke',
    'UX viewport smoke must use the summary-preserving runner'
);
requireFileIncludes(
    'src/frontend/package.json',
    'FSUSBLOG_UX_VIEWPORT_WORKERS=${FSUSBLOG_UX_VIEWPORT_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-`node ../../tools/test/resolve-playwright-workers.mjs ux-viewport-smoke`}} PLAYWRIGHT_OUTPUT_DIR=${PLAYWRIGHT_OUTPUT_DIR:-test-results/playwright/ux-viewport-smoke} node ../../tests/frontend/checks/ux/run-ux-viewport-playwright.mjs smoke',
    'UX viewport smoke must honor lane-computed Playwright workers'
);
requireFileIncludes(
    'tests/frontend/e2e/ux/viewport-boundaries.spec.ts',
    'for (const group of testGroups)',
    'UX viewport runner must execute the shared route-theme plan'
);
requireFileIncludes(
    'tools/test/resolve-playwright-workers.mjs',
    'FSUSBLOG_BUNDLE_CPU_UNITS',
    'Playwright browser lanes must prefer the scheduler CPU grant before host capacity'
);
requireFileIncludes(
    'tools/test/lanes/ux-viewport-smoke.sh',
    'resolve-playwright-workers.mjs" ux-viewport-smoke',
    'UX viewport smoke lane must compute workers from local CPU, memory, and load'
);
requireFileIncludes(
    'tools/test/lanes/ux-viewport-smoke.sh',
    'FSUSBLOG_PLAYWRIGHT_WORKERS="$FSUSBLOG_UX_VIEWPORT_WORKERS" PrepareSessionFixturesOnce',
    'UX viewport smoke must prepare exactly the worker-counted session fixtures once'
);
requireFileIncludes(
    'src/frontend/package.json',
    'check:visual:public:playwright": "env -u NO_COLOR NODE_PATH=./node_modules npx playwright test --config=${FSUSBLOG_PLAYWRIGHT_CONFIG:-playwright.config.ts} ${FSUSBLOG_PLAYWRIGHT_SHARD_ARG:-} --workers=${FSUSBLOG_VISUAL_PUBLIC_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-`node ../../tools/test/resolve-playwright-workers.mjs visual-public`}}',
    'visual public Playwright script must honor matrix or lane-computed workers'
);
requireFileIncludes(
    'tools/frontend/check-console-visual.sh',
    'workers="${FSUSBLOG_CONSOLE_VISUAL_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-$(node ../../tools/test/resolve-playwright-workers.mjs visual-console)}}"',
    'visual console grouped screenshot runner must honor matrix or lane-computed workers'
);
requireFileIncludes(
    'src/frontend/package.json',
    'check:spa:routes": "npm run verify:wasm && env -u NO_COLOR NODE_PATH=./node_modules npx playwright test ${FSUSBLOG_PLAYWRIGHT_SHARD_ARG:-} --workers=${FSUSBLOG_SPA_ROUTES_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-`node ../../tools/test/resolve-playwright-workers.mjs acceptance-spa-routes`}}',
    'SPA route audit must honor the acceptance lane worker cap'
);
requireFileIncludes(
    'src/frontend/package.json',
    'check:acceptance:public": "npm run verify:wasm && env -u NO_COLOR NODE_PATH=./node_modules npx playwright test ${FSUSBLOG_PLAYWRIGHT_SHARD_ARG:-} --workers=${FSUSBLOG_PUBLIC_ACCEPTANCE_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-`node ../../tools/test/resolve-playwright-workers.mjs acceptance-public-routes`}}',
    'public route audit must honor the isolated acceptance worker cap'
);
requireFileIncludes(
    'tools/test/lanes/ux-viewport-visual.sh',
    'ConfigurePlaywrightWorkers ux-viewport-visual FSUSBLOG_UX_VIEWPORT_WORKERS',
    'ux-viewport-visual must resolve a bounded worker cap from the current machine'
);
requireFileIncludes(
    'tools/test/lanes/ux-viewport-boundaries.sh',
    "profile='ux-viewport-boundaries'",
    'ux-viewport-boundaries must use its dedicated profile when screenshots are disabled'
);
requireFileIncludes(
    'tools/test/lanes/ux-viewport-boundaries.sh',
    "profile='ux-viewport-visual'",
    'ux-viewport-boundaries must fall back to the visual profile when screenshots are enabled'
);
requireFileIncludes(
    'tools/test/lanes/ux-viewport-boundaries.sh',
    'ConfigurePlaywrightWorkers "$profile" FSUSBLOG_UX_VIEWPORT_WORKERS',
    'ux-viewport-boundaries must apply its selected worker profile'
);
for (const file of [
    'tools/test/lanes/ux-viewport-smoke.sh',
    'tools/test/lanes/ux-viewport-visual.sh',
    'tools/test/lanes/ux-viewport-boundaries.sh'
])
{
    requireFileIncludes(
        file,
        'FSUSBLOG_PLAYWRIGHT_WORKERS="$FSUSBLOG_UX_VIEWPORT_WORKERS" PrepareSessionFixturesOnce',
        `${file} must prepare isolated session fixtures for its computed worker cap`
    );
    requireFileIncludes(
        file,
        'RequireReleasePreview',
        `${file} must exercise the release preview instead of the concurrent Vite development server`
    );
    requireFileIncludes(
        file,
        'PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"',
        `${file} must direct browser checks through the release preview proxy`
    );
}
requireFileIncludes(
    'tools/run-test-matrix.mjs',
    'env.FSUSBLOG_PLAYWRIGHT_SHARD_ARG = `--shard=${index}/${total}`',
    'matrix runner must pass Playwright shard arguments to direct browser lanes'
);
requireFileIncludes(
    'docs/testing.md',
    'Browser lane scaling policy',
    'docs/testing.md must document browser lane shard/worker scaling policy and evidence'
);
requireCondition(
    structuredTiers.get('visual-public')?.owner === 'InteropGlueAgent'
    && structuredTiers.get('visual-public')?.command === 'tools/test/lanes/visual-public-playwright.sh',
    'public screenshot checks must run as a separate matrix tier'
);
requireCondition(
    structuredTiers.get('visual-console')?.owner === 'InteropGlueAgent'
    && structuredTiers.get('visual-console')?.command === 'tools/test/lanes/visual-console-playwright.sh',
    'console screenshot checks must run as a separate matrix tier'
);
requireCondition(
    structuredTiers.get('visual')?.owner === 'InteropGlueAgent'
    && structuredTiers.get('visual')?.command === 'tools/test/lanes/visual-screenshots-aggregate.sh'
    && JSON.stringify(tierExecutionDependencies(structuredTiers.get('visual'))) === JSON.stringify(['visual-public', 'visual-console']),
    'visual screenshot checks must have a final aggregate tier'
);
requireCondition(
    JSON.stringify(structuredTiers.get('visual-public')?.artifacts) === JSON.stringify([
        '.tmp/visual/public',
        'src/frontend/test-results/playwright/visual-public'
    ]),
    'public screenshot artifacts must use isolated output paths'
);
requireCondition(
    JSON.stringify(structuredTiers.get('visual-console')?.artifacts) === JSON.stringify([
        '.tmp/visual/console',
        'src/frontend/test-results/playwright/visual-console'
    ]),
    'console screenshot artifacts must use isolated output paths'
);
for (const forbidden of [
    'acceptance-playwright:',
    'frontend-render-pressure:',
    'visual-public-playwright:',
    'visual-console-playwright:',
    'visual-playwright:',
    'cross-browser-smoke:'
])
{
    requireFileExcludes(
        '.github/workflows/quality-gate.yml',
        forbidden,
        `ordinary quality gate must not define diagnostics job ${forbidden}`
    );
}
requireFileIncludes(
    '.github/workflows/browser-diagnostics.yml',
    'playwright install --with-deps chromium firefox webkit',
    'scheduled/manual diagnostics must install every governed browser engine'
);
requireFileIncludes(
    '.github/workflows/quality-gate.yml',
    'playwright install --with-deps chromium firefox webkit',
    'release XSS authority must install every governed browser engine'
);
requireFileIncludes(
    'src/frontend/playwright.config.ts',
    "'acceptance/cross-browser-smoke.spec.ts'",
    'ordinary Playwright config must exclude cross-browser diagnostics'
);
requireFileIncludes(
    'src/frontend/playwright.config.ts',
    "'visual/**'",
    'ordinary Playwright config must exclude visual diagnostics'
);
requireFileIncludes(
    'tools/visual/aggregate-screenshot-evidence.mjs',
    'fsusblog.visual.screenshot-aggregate.v1',
    'visual screenshot aggregate script must emit a versioned evidence schema'
);
requireFileIncludes(
    'docs/testing.md',
    'Screenshot evidence tiers',
    'docs/testing.md must document visual screenshot tier split and aggregate evidence'
);
for (const testFile of [
    'tests/tools/test-matrix-resource-contract.test.mjs',
    'tests/tools/browserless-correctness-contract.test.mjs'
])
{
    const result = spawnSync(process.execPath, ['--test', testFile], { cwd: root, encoding: 'utf8' });
    if (result.stdout)
    {
        process.stdout.write(result.stdout);
    }
    if (result.stderr)
    {
        process.stderr.write(result.stderr);
    }
    requireCondition(result.status === 0, `${testFile} must pass the browser-boundary governance contract`);
}
console.log('[test-matrix] ok');

expectMatrixValidateFailure(
    removeTier(matrixSourceText, 'test-quality-lint'),
    'canonical release-final evidence inputs reference missing tiers: test-quality-lint',
    'release-final must reject missing canonical evidence producers'
);
