import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { buildAggregatePlan, buildReceiptPlan } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/aggregate-plan.mjs')).href
);
const { parseAggregateCommand } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/aggregate-plan.mjs')).href
);
const { validateEvidenceExecutionDeclaration } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/projection-declaration.mjs')).href
);
const {
    canonicalReceiptCommandSources,
    validateCanonicalReceiptCommandSource
} = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/receipt-command-sources.mjs')).href
);
const { parseMatrix } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href
);
const {
    renderTestingDocs,
    resolveCiJobExecution
} = await import(
    pathToFileURL(path.join(root, 'tools/docs/generate-testing-docs.mjs')).href
);

function fixtureMatrix({ excludedFlag = null, producerCiJob = 'canonical-producer' } = {})
{
    return {
        aggregateAuthorities: {
            'release-summary': {
                id: 'release-summary',
                commandKind: 'aggregate',
                ciJob: 'release-summary',
                summaryTierIds: ['release-summary-tier'],
                inputReceiptSchemas: ['fsusblog.ci.job-result.v1'],
                outputReceiptSchema: 'fsusblog.ci.job-result.v1'
            }
        },
        tiers: [
            {
                id: 'canonical-producer',
                ciJob: producerCiJob,
                executionMode: 'execute',
                commandKind: 'producer',
                outputReceiptSchema: 'fsusblog.ci.job-result.v1',
                artifacts: ['.tmp/canonical/receipt.json'],
                evidence: ['.tmp/canonical/receipt.json']
            },
            {
                id: 'release-summary-tier',
                ciJob: 'release-summary',
                executionMode: 'summary',
                commandKind: 'aggregate',
                summaryAuthority: 'release-summary',
                summaryInputs: ['fsusblog.ci.job-result.v1'],
                outputReceiptSchema: 'fsusblog.ci.job-result.v1',
                command: 'node tools/run-test-matrix.mjs aggregate release-summary',
                executionDependsOn: [],
                requiresEvidenceFrom: ['canonical-producer'],
                localOnly: excludedFlag === 'localOnly',
                nightlyOnly: excludedFlag === 'nightlyOnly',
                manualOnly: excludedFlag === 'manualOnly'
            }
        ]
    };
}

function replaceAggregateCliTierField(source, tierId, field, value)
{
    const lines = source.split('\n');
    const starts = lines.flatMap((line, index) => line === `    - id: ${tierId}` ? [index] : []);
    assert.equal(starts.length, 1, `fixture must contain exactly one tier ${tierId}`);
    const start = starts[0];
    const nextTier = lines.findIndex((line, index) => index > start && line.startsWith('    - id: '));
    const end = nextTier === -1 ? lines.length : nextTier;
    const prefix = `      ${field}:`;
    const fields = lines.flatMap((line, index) =>
        index > start && index < end && line.startsWith(prefix) ? [index] : []
    );
    assert.ok(fields.length <= 1, `fixture contains duplicate ${tierId}.${field}`);
    if (fields.length === 1)
    {
        const expected = field === 'ciJob' ? 'integration-runtime' : 'false';
        assert.equal(lines[fields[0]], `${prefix} ${expected}`);
        lines[fields[0]] = `${prefix} ${value}`;
    }
    else
    {
        assert.equal(tierId, 'ci');
        assert.equal(field, 'manualOnly');
        const anchors = lines.flatMap((line, index) =>
            index > start && index < end && line === '      requiresBootstrap: none' ? [index] : []
        );
        assert.equal(anchors.length, 1, 'ci.manualOnly insertion requires one exact tier-local anchor');
        lines.splice(anchors[0] + 1, 0, `${prefix} ${value}`);
    }
    const mutated = lines.join('\n');
    const expectedMatrix = parseMatrix(source);
    const tier = expectedMatrix.tiers.find((entry) => entry.id === tierId);
    tier[field] = value === 'true' ? true : value;
    assert.deepEqual(parseMatrix(mutated), expectedMatrix, 'CLI fixture must change only its selected field');
    return mutated;
}

function aggregateCliFixture({ excludedFlag = null, sameJobProducer = false } = {})
{
    assert.ok(excludedFlag === null || ['localOnly', 'nightlyOnly', 'manualOnly'].includes(excludedFlag));
    assert.equal(typeof sameJobProducer, 'boolean');
    assert.ok(excludedFlag === null || !sameJobProducer, 'CLI fixture must not combine refusal mutations');
    const source = readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    if (excludedFlag !== null)
    {
        return replaceAggregateCliTierField(source, 'ci', excludedFlag, 'true');
    }
    if (sameJobProducer)
    {
        return replaceAggregateCliTierField(source, 'integration', 'ciJob', 'ci-summary');
    }
    return source;
}

function recordAggregateCliTerminal(context, caseId, result)
{
    context.diagnostic(`[aggregate-cli-case] ${JSON.stringify({
        caseId,
        status: result.status,
        signal: result.signal,
        error: result.error ? { name: result.error.name, code: result.error.code, message: result.error.message } : null,
        stdout: result.stdout,
        stderr: result.stderr
    })}`);
}

function runAggregateCli(matrixSource)
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-aggregate-filter-'));
    try
    {
        const matrixFile = path.join(directory, 'matrix.yml');
        writeFileSync(matrixFile, matrixSource);
        return spawnSync(process.execPath, [
            'tools/run-test-matrix.mjs',
            'aggregate',
            'ci-summary',
            '--dry-run'
        ], {
            cwd: root,
            env: { ...process.env, FSUSBLOG_MATRIX_FILE: matrixFile },
            encoding: 'utf8'
        });
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
}

test('aggregate planner resolves a declared artifact-only authority without spawning producers', () =>
{
    const plan = buildAggregatePlan(fixtureMatrix(), 'release-summary');
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.selectedTierIds, ['release-summary-tier']);
    assert.deepEqual(plan.dependencyJobs, ['canonical-producer']);
    assert.deepEqual(plan.requiredReceiptInputs, ['.tmp/canonical/receipt.json']);
    assert.equal(plan.executesTestCommands, false);
});

test('aggregate planner and real CLI reject unknown and every filter-empty target', (context) =>
{
    assert.deepEqual(buildAggregatePlan(fixtureMatrix(), 'release-admin-console').errors, [
        'unknown aggregate authority: release-admin-console'
    ]);
    const neutralSource = aggregateCliFixture();
    assert.equal(neutralSource, readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const positiveCli = runAggregateCli(neutralSource);
    recordAggregateCliTerminal(context, 'positive-control', positiveCli);
    assert.equal(positiveCli.error, undefined);
    assert.equal(positiveCli.signal, null);
    assert.equal(positiveCli.status, 0, positiveCli.stderr);
    const positivePlan = JSON.parse(positiveCli.stdout);
    assert.equal(positivePlan.target, 'ci-summary');
    assert.equal(positivePlan.authorityId, 'ci-summary');
    assert.deepEqual(positivePlan.selectedTierIds, ['ci']);
    assert.deepEqual(positivePlan.dependencyJobs, ['fast-summary', 'integration-runtime']);
    assert.deepEqual(positivePlan.resolvedInputReceiptSchemas, ['fsusblog.ci.job-result.v1']);
    assert.equal(positivePlan.outputReceiptSchema, 'fsusblog.ci.job-result.v1');
    assert.equal(positivePlan.artifactOnly, true);
    assert.equal(positivePlan.executesTestCommands, false);
    assert.deepEqual(positivePlan.errors, []);
    for (const excludedFlag of ['localOnly', 'nightlyOnly', 'manualOnly'])
    {
        assert.deepEqual(
            buildAggregatePlan(fixtureMatrix({ excludedFlag }), 'release-summary').errors,
            ['release-summary selects a tier excluded from aggregation'],
            excludedFlag
        );
        const cli = runAggregateCli(aggregateCliFixture({ excludedFlag }));
        recordAggregateCliTerminal(context, excludedFlag, cli);
        assert.equal(cli.error, undefined, excludedFlag);
        assert.equal(cli.signal, null, excludedFlag);
        assert.notEqual(cli.status, 0, excludedFlag);
        assert.match(
            cli.stderr,
            /\[matrix\] ci-summary selects a tier excluded from aggregation/u,
            excludedFlag
        );
    }
});

test('aggregate declarations reject shell suffixes instead of inferring a command kind from a prefix', () =>
{
    assert.deepEqual(parseAggregateCommand('node tools/run-test-matrix.mjs aggregate release-summary'), {
        kind: 'aggregate', target: 'release-summary'
    });
    assert.equal(parseAggregateCommand('node tools/run-test-matrix.mjs aggregate release-summary && producer'), null);
});

test('aggregate planner rejects a declared tier with mismatched command, input, or receipt output contract', (context) =>
{
    const matrix = fixtureMatrix();
    matrix.tiers[1] = {
        ...matrix.tiers[1],
        command: 'node tools/run-test-matrix.mjs aggregate another-summary',
        summaryAuthority: 'another-summary',
        summaryInputs: ['fsusblog.other-receipt.v1'],
        outputReceiptSchema: 'fsusblog.other-receipt.v1'
    };
    const errors = buildAggregatePlan(matrix, 'release-summary').errors;
    assert.ok(errors.some((error) => error.includes('summaryAuthority')));
    assert.ok(errors.some((error) => error.includes('summaryInputs')));
    assert.ok(errors.some((error) => error.includes('outputReceiptSchema')));
    assert.ok(errors.some((error) => error.includes('command must invoke aggregate')));

    const dependencySchemaMismatch = fixtureMatrix();
    dependencySchemaMismatch.tiers[0].outputReceiptSchema = 'fsusblog.actual-producer.v1';
    assert.ok(buildAggregatePlan(dependencySchemaMismatch, 'release-summary').errors
        .some((error) => error.includes('selected dependency outputs')));

    const selfConsumption = fixtureMatrix();
    selfConsumption.tiers[1].requiresEvidenceFrom = ['release-summary-tier'];
    assert.ok(buildAggregatePlan(selfConsumption, 'release-summary').errors
        .some((error) => error.includes('selected by the same aggregate authority')));

    const sameJobProducer = fixtureMatrix({ producerCiJob: 'release-summary' });
    const sameJobErrors = buildAggregatePlan(sameJobProducer, 'release-summary').errors;
    assert.ok(sameJobErrors.some((error) => error.includes('same aggregate CI job')));
    assert.ok(sameJobErrors.some((error) => error.includes('external dependency job')));
    const sameJobCli = runAggregateCli(aggregateCliFixture({ sameJobProducer: true }));
    recordAggregateCliTerminal(context, 'same-job-producer', sameJobCli);
    assert.equal(sameJobCli.error, undefined);
    assert.equal(sameJobCli.signal, null);
    assert.notEqual(sameJobCli.status, 0);
    assert.match(sameJobCli.stderr, /same aggregate CI job/u);
    assert.match(
        sameJobCli.stderr,
        /\[matrix\] ci\.requiresEvidenceFrom must not consume integration from the same aggregate CI job/u
    );
});

test('matrix schema makes aggregate authorities and summary receipt declarations machine-readable', () =>
{
    const schema = JSON.parse(readFileSync(path.join(root, 'tests/matrix.schema.json'), 'utf8'));
    assert.ok(schema.required.includes('aggregateAuthorities'));
    assert.ok(schema.required.includes('finalizerAuthorities'));
    const properties = schema.properties.tiers.items.properties;
    assert.ok(schema.properties.tiers.items.required.includes('executionDependsOn'));
    assert.equal('dependsOn' in properties, false);
    assert.deepEqual(
        properties.commandKind.enum,
        ['aggregate', 'finalizer', 'producer', 'projection', 'receipt']
    );
    assert.equal(properties.summaryInputs.minItems, 1);
    assert.equal(properties.outputReceiptSchema.minLength, 1);
});

test('generated CI commands come from validated aggregate authorities instead of command heuristics', () =>
{
    const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    assert.equal(
        matrix.tiers.find((tier) => tier.id === 'data-scale-evidence-summary')?.command,
        canonicalReceiptCommandSources['data-scale-evidence-summary'].command
    );
    const byJob = (id) => ({
        id,
        tiers: matrix.tiers.filter((tier) => tier.ciJob === id)
    });
    assert.deepEqual(resolveCiJobExecution(matrix, byJob('fast-summary')), {
        mode: 'aggregate',
        authorityId: 'fast-summary',
        command: 'node tools/run-test-matrix.mjs aggregate fast-summary'
    });
    assert.deepEqual(resolveCiJobExecution(matrix, byJob('coverage-summary')), {
        mode: 'aggregate',
        authorityId: 'coverage-merge-threshold',
        command: 'node tools/run-test-matrix.mjs aggregate coverage-merge-threshold'
    });
    assert.deepEqual(resolveCiJobExecution(matrix, byJob('coverage-merge-threshold')), {
        mode: 'test',
        authorityId: null,
        command: './tools/test.sh ci-job coverage-merge-threshold'
    });
    assert.deepEqual(resolveCiJobExecution(matrix, byJob('ci-summary')), {
        mode: 'aggregate',
        authorityId: 'ci-summary',
        command: 'node tools/run-test-matrix.mjs aggregate ci-summary'
    });
    assert.deepEqual(resolveCiJobExecution(matrix, byJob('fast-backend')), {
        mode: 'test',
        authorityId: null,
        command: './tools/test.sh ci-job fast-backend'
    });

    const rendered = renderTestingDocs(matrix);
    assert.match(
        rendered,
        /\| `fast-summary` \| `aggregate` \| `node tools\/run-test-matrix\.mjs aggregate fast-summary` \|/u
    );
    assert.match(
        rendered,
        /\| `coverage-summary` \| `aggregate` \| `node tools\/run-test-matrix\.mjs aggregate coverage-merge-threshold` \|/u
    );
    assert.match(
        rendered,
        /\| `ci-summary` \| `aggregate` \| `node tools\/run-test-matrix\.mjs aggregate ci-summary` \|/u
    );
});

test('ci-fast plans the matrix-derived producer workflow before the artifact-only aggregate', () =>
{
    const result = spawnSync(
        process.execPath,
        ['tools/run-test-matrix.mjs', 'ci-fast', '--plan-only'],
        { cwd: root, encoding: 'utf8' }
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /^Local CI workflow "fast-summary" \(matrix-derived\):/mu);
    for (const jobId of [
        'validate-matrix',
        'test-inventory',
        'behavior-doc-static-admission',
        'fast-backend',
        'fast-frontend-unit',
        'fast-static-governance',
        'frontend-build',
        'frontend-runtime-contracts',
        'frontend-static-governance'
    ])
    {
        assert.match(output, new RegExp(`^\\d+\\. ${jobId}\\b`, 'mu'), jobId);
    }
    assert.match(
        output,
        /^\d+\. fast-summary \[aggregate\]: node tools\/run-test-matrix\.mjs aggregate fast-summary$/mu
    );
    assert.ok(
        output.indexOf('frontend-build [producer]')
        < output.indexOf('frontend-static-governance [producer]'),
        output
    );
    assert.ok(
        output.indexOf('frontend-static-governance [producer]')
        < output.indexOf('fast-summary [aggregate]'),
        output
    );
});

test('static governance owns its declared evidence without a CI-only fallback', () =>
{
    const lane = readFileSync(path.join(root, 'tools/test/lanes/static-governance.sh'), 'utf8');
    const workflow = readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
    const matrix = readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    for (const producer of [
        'tools/docs/check-integrity-proof-docs.mjs',
        'tools/check-doc-implementation-drift.mjs',
        'tools/test/run-test-asset-audit.mjs'
    ])
    {
        assert.match(lane, new RegExp(producer.replaceAll('.', '\\.'), 'u'), producer);
    }
    assert.match(lane, /run-test-asset-audit\.mjs" --phase discovery --audit-input "\$retentionAudit"/u);
    assert.doesNotMatch(workflow, /run-test-asset-audit\.mjs/u);
    assert.doesNotMatch(matrix, /tools\/dev\/seed-demo-data\.sh/u);
    for (const authority of [
        'config/testing/fixture-producer-registry.json',
        'tests/tools/demo-public-producer.test.mjs',
        'src/backend/Services/Fixtures/DemoFixtureSeeder.cs',
        'docs/development/demo-data.md'
    ])
    {
        assert.match(matrix, new RegExp(authority.replaceAll('.', '\\.'), 'u'), authority);
    }
});

test('all four generic summaries consume typed producer receipts without execution dependencies', () =>
{
    const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const expectedSelections = new Map([
        ['fast-summary', ['fast', 'frontend-fast-summary']],
        ['coverage-merge-threshold', ['coverage-gate']],
        ['ci-summary', ['ci']]
    ]);
    for (const [authorityId, selectedTierIds] of expectedSelections)
    {
        const plan = buildAggregatePlan(matrix, authorityId);
        assert.deepEqual(plan.errors, [], authorityId);
        assert.deepEqual(plan.selectedTierIds, selectedTierIds);
        assert.ok(plan.dependencyJobs.length > 0, authorityId);
        assert.ok(plan.dependencyReceipts.length > 0, authorityId);
        assert.ok(plan.dependencyReceipts.every((receipt) => receipt.jobId !== plan.ciJob), authorityId);
        for (const tierId of selectedTierIds)
        {
            const tier = matrix.tiers.find((entry) => entry.id === tierId);
            assert.deepEqual(tier.executionDependsOn, [], tierId);
            assert.ok(tier.requiresEvidenceFrom.length > 0, tierId);
        }
    }
    assert.equal([...expectedSelections.values()].flat().length, 4);
});

test('workflow runs coverage and CI aggregates only after external producer jobs', () =>
{
    const workflow = readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8');
    const coverageProducerStart = workflow.indexOf('    coverage-merge-threshold:\n');
    const coverageSummaryStart = workflow.indexOf('    coverage-summary:\n');
    const fastBackendStart = workflow.indexOf('    fast-backend:\n');
    assert.ok(coverageProducerStart >= 0 && coverageSummaryStart > coverageProducerStart);
    assert.ok(fastBackendStart > coverageSummaryStart);
    const coverageProducer = workflow.slice(coverageProducerStart, coverageSummaryStart);
    const coverageSummary = workflow.slice(coverageSummaryStart, fastBackendStart);
    assert.match(coverageProducer, /\.\/tools\/test\.sh coverage-threshold --no-deps/u);
    assert.doesNotMatch(coverageProducer, /aggregate coverage-merge-threshold/u);
    assert.match(
        coverageSummary,
        /needs: \[behavior-doc-static-admission, coverage-merge-threshold, plan-pr-risk\]/u
    );
    assert.match(coverageSummary, /aggregate coverage-merge-threshold/u);

    const integrationStart = workflow.indexOf('    integration-runtime:\n');
    const ciSummaryStart = workflow.indexOf('    ci-summary:\n');
    const endpointStart = workflow.indexOf('    endpoint-depth-runtime:\n');
    assert.ok(integrationStart >= 0 && ciSummaryStart > integrationStart);
    assert.ok(endpointStart > ciSummaryStart);
    const ciSummary = workflow.slice(ciSummaryStart, endpointStart);
    assert.match(
        ciSummary,
        /needs: \[behavior-doc-static-admission, fast-summary, integration-runtime, plan-pr-risk\]/u
    );
    assert.match(ciSummary, /aggregate ci-summary/u);
});

test('workflow checker fails closed when an aggregate external dependency job is not ordered first', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-aggregate-workflow-'));
    try
    {
        const workflowSource = readFileSync(
            path.join(root, '.github/workflows/quality-gate.yml'),
            'utf8'
        );
        const invalidWorkflow = workflowSource.replace(
            '        needs: [behavior-doc-static-admission, fast-summary, integration-runtime, plan-pr-risk]\n',
            '        needs: [behavior-doc-static-admission, fast-summary, plan-pr-risk]\n'
        );
        assert.notEqual(invalidWorkflow, workflowSource);
        const workflowFile = path.join(directory, 'quality-gate.yml');
        const planFile = path.join(directory, 'ci-plan.json');
        writeFileSync(workflowFile, invalidWorkflow);
        const generatePlan = spawnSync(process.execPath, [
            'tools/run-test-matrix.mjs',
            'ci-plan',
            '--out',
            planFile
        ], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.equal(generatePlan.status, 0, generatePlan.stderr);
        const check = spawnSync(process.execPath, [
            'tools/check-workflow-matrix-sync.mjs',
            planFile,
            workflowFile
        ], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.notEqual(check.status, 0);
        assert.match(
            check.stderr,
            /workflow job ci-summary is missing aggregate dependency job: integration-runtime/u
        );
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('receipt summary planner accepts allowlisted finalization and rejects producer commands', () =>
{
    const commandSource = canonicalReceiptCommandSources['data-scale-evidence-summary'];
    const command = commandSource.command;
    const sourceFixtureRoot = path.join(
        root,
        'tests/tools/fixtures/receipt-command-sources'
    );
    const receiptMatrix = {
        receiptAuthorities: {
            'receipt-summary': {
                id: 'receipt-summary',
                commandKind: 'receipt',
                commandSourceId: 'data-scale-evidence-summary',
                command,
                summaryTierIds: ['receipt-summary-tier'],
                inputTierIds: ['structured-producer'],
                inputReceiptSchemas: ['fsusblog.structured-producer.v1'],
                outputReceiptSchema: 'fsusblog.structured-summary.v1'
            }
        },
        tiers: [
            {
                id: 'structured-producer',
                ciJob: 'structured-producer',
                executionMode: 'execute',
                commandKind: 'producer',
                outputReceiptSchema: 'fsusblog.structured-producer.v1'
            },
            {
                id: 'receipt-summary-tier',
                ciJob: 'receipt-summary-job',
                executionMode: 'summary',
                commandKind: 'receipt',
                summaryAuthority: 'receipt-summary',
                summaryInputs: ['fsusblog.structured-producer.v1'],
                outputReceiptSchema: 'fsusblog.structured-summary.v1',
                command,
                executionDependsOn: [],
                requiresEvidenceFrom: ['structured-producer'],
                services: [],
                requiresBootstrap: 'none',
                requiresNode: true,
                requiresDotnet: false,
                requiresPlaywright: 'none'
            }
        ]
    };
    const valid = buildReceiptPlan(receiptMatrix, 'receipt-summary');
    assert.deepEqual(valid.errors, []);
    assert.equal(valid.executesTestCommands, false);
    assert.deepEqual(valid.commandArgv, commandSource.argv);
    assert.deepEqual(valid.permissionBoundary, {
        fsRead: [
            '.tmp/scale/*',
            '.tmp/downloaded-artifacts/*',
            '.tmp/release-evidence/*'
        ],
        fsWrite: ['.tmp/release-evidence/*'],
        childProcess: false,
        worker: false
    });
    assert.deepEqual(validateEvidenceExecutionDeclaration(receiptMatrix.tiers[1], receiptMatrix), []);
    assert.deepEqual(resolveCiJobExecution(receiptMatrix, {
        id: 'receipt-summary-job',
        tiers: [receiptMatrix.tiers[1]]
    }), {
        mode: 'receipt',
        authorityId: 'receipt-summary',
        command
    });

    const selfConsumption = structuredClone(receiptMatrix);
    selfConsumption.receiptAuthorities['receipt-summary'].inputTierIds = ['receipt-summary-tier'];
    selfConsumption.receiptAuthorities['receipt-summary'].inputReceiptSchemas = [
        'fsusblog.structured-summary.v1'
    ];
    selfConsumption.tiers[1].summaryInputs = ['fsusblog.structured-summary.v1'];
    selfConsumption.tiers[1].requiresEvidenceFrom = ['receipt-summary-tier'];
    assert.ok(buildReceiptPlan(selfConsumption, 'receipt-summary').errors.some((error) =>
        error.includes('selected by the same receipt authority')
    ));

    for (const argument of commandSource.argv.filter((entry) =>
        entry === '--permission' || entry.startsWith('--allow-fs-')))
    {
        const commandToken = argument.includes('*') ? ` '${argument}'` : ` ${argument}`;
        const missingPermission = structuredClone(receiptMatrix);
        missingPermission.receiptAuthorities['receipt-summary'].command =
            command.replace(commandToken, '');
        missingPermission.tiers[1].command =
            missingPermission.receiptAuthorities['receipt-summary'].command;
        assert.ok(buildReceiptPlan(missingPermission, 'receipt-summary').errors.some((error) =>
            error.includes('command must exactly match its canonical receipt command source')
        ), argument);
    }

    const safeTransitive = buildReceiptPlan(receiptMatrix, 'receipt-summary', {
        root: path.join(sourceFixtureRoot, 'safe')
    });
    assert.deepEqual(safeTransitive.errors, []);
    assert.deepEqual(safeTransitive.commandSourceFiles, [
        'tools/test/aggregate-data-scale-evidence.mjs',
        'tools/test/lib/receipt-reader.mjs'
    ]);

    const unsafeTransitive = buildReceiptPlan(receiptMatrix, 'receipt-summary', {
        root: path.join(sourceFixtureRoot, 'unsafe')
    });
    assert.ok(unsafeTransitive.errors.some((error) =>
        error.includes('producer-wrapper.mjs contains a producer-spawn capability')
    ));
    assert.ok(unsafeTransitive.errors.some((error) =>
        error.includes('producer-wrapper.mjs imports forbidden builtin or bare package: node:child_process')
    ));
});

test('Node permission boundary denies computed process execve even when static closure scanning accepts it', () =>
{
    const fixtureRoot = path.join(
        root,
        'tests/tools/fixtures/receipt-command-sources/permission-bypass'
    );
    const source = validateCanonicalReceiptCommandSource('data-scale-evidence-summary', {
        root: fixtureRoot
    });
    assert.deepEqual(source.errors, [], 'the fixture must bypass source-keyword detection');
    assert.equal(source.contract.argv.includes('--allow-child-process'), false);
    assert.equal(source.contract.argv.includes('--allow-worker'), false);

    const result = spawnSync(source.contract.argv[0], source.contract.argv.slice(1), {
        cwd: fixtureRoot,
        encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /code: 'ERR_ACCESS_DENIED'/u);
    assert.match(result.stderr, /permission: 'ChildProcess'/u);
});

test('canonical permission argv grants only the receipt inputs and atomic summary output it needs', () =>
{
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-receipt-permission-'));
    const commandSource = canonicalReceiptCommandSources['data-scale-evidence-summary'];
    try
    {
        const script = path.join(fixtureRoot, commandSource.source);
        mkdirSync(path.dirname(script), { recursive: true });
        writeFileSync(
            script,
            readFileSync(path.join(root, commandSource.source), 'utf8')
        );
        const inputDirectory = path.join(fixtureRoot, '.tmp/scale/release-summaries');
        mkdirSync(inputDirectory, { recursive: true });
        for (const tier of ['scale-xs', 'scale-s'])
        {
            writeFileSync(
                path.join(inputDirectory, `${tier}.json`),
                `${JSON.stringify({ tier, status: 'ok' })}\n`
            );
        }

        const result = spawnSync(commandSource.argv[0], commandSource.argv.slice(1), {
            cwd: fixtureRoot,
            encoding: 'utf8'
        });
        assert.equal(result.status, 0, result.stderr);
        const summary = JSON.parse(readFileSync(
            path.join(fixtureRoot, '.tmp/release-evidence/data-scale-summary.json'),
            'utf8'
        ));
        assert.equal(summary.status, 'ok');
        assert.deepEqual(summary.requiredTiers, ['scale-xs', 'scale-s']);
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test('canonical receipt closure is cycle-safe and fails closed for unsafe or unresolved imports', () =>
{
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-receipt-closure-'));
    const entry = path.join(fixtureRoot, 'tools/test/aggregate-data-scale-evidence.mjs');
    const dependencyDirectory = path.join(fixtureRoot, 'tools/test/lib');
    mkdirSync(dependencyDirectory, { recursive: true });
    const validate = () => validateCanonicalReceiptCommandSource('data-scale-evidence-summary', {
        root: fixtureRoot
    });
    try
    {
        writeFileSync(entry, "import './lib/first.mjs';\n");
        writeFileSync(path.join(dependencyDirectory, 'first.mjs'), "import './second.mjs';\n");
        writeFileSync(path.join(dependencyDirectory, 'second.mjs'), "import './first.mjs';\n");
        assert.deepEqual(validate().errors, []);

        writeFileSync(entry, "import 'unsafe-package';\n");
        assert.ok(validate().errors.some((error) => error.includes('forbidden builtin or bare package')));

        writeFileSync(entry, "await import('./lib/first.mjs');\n");
        assert.ok(validate().errors.some((error) => error.includes('dynamic import or require')));

        writeFileSync(entry, "require('./lib/first.mjs');\n");
        assert.ok(validate().errors.some((error) => error.includes('dynamic import or require')));

        writeFileSync(entry, "import './missing.mjs';\n");
        assert.ok(validate().errors.some((error) => error.includes('cannot be resolved')));

        writeFileSync(entry, "import '../../../../outside.mjs';\n");
        assert.ok(validate().errors.some((error) => error.includes('import escapes root')));
    }
    finally
    {
        rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test('execute mode rejects summary and projection contract fields or non-producer command kinds', () =>
{
    const execute = {
        id: 'physical-producer',
        executionMode: 'execute',
        commandKind: 'receipt',
        summaryAuthority: 'fake-summary',
        summaryInputs: ['fsusblog.fake.v1'],
        projectionCatalog: 'tests/fixtures/fake.json'
    };
    const errors = validateEvidenceExecutionDeclaration(execute, fixtureMatrix());
    assert.ok(errors.some((error) => error.includes('commandKind must be producer')));
    assert.ok(errors.some((error) => error.includes('summaryAuthority')));
    assert.ok(errors.some((error) => error.includes('summaryInputs')));
    assert.ok(errors.some((error) => error.includes('projectionCatalog')));
});

test('summary declarations reject missing inputs, producer modes, invalid targets, and output mismatches', () =>
{
    const matrix = fixtureMatrix();
    const valid = matrix.tiers[1];
    assert.deepEqual(validateEvidenceExecutionDeclaration(valid, matrix), []);

    const missingInputs = { ...valid, summaryInputs: [] };
    assert.ok(validateEvidenceExecutionDeclaration(missingInputs, matrix).some((error) => error.includes('summaryInputs')));

    const producerKind = { ...valid, commandKind: 'producer' };
    assert.ok(validateEvidenceExecutionDeclaration(producerKind, matrix).some((error) => error.includes('commandKind')));

    const invalidTarget = {
        ...valid,
        summaryAuthority: 'release-admin-console',
        command: 'node tools/run-test-matrix.mjs aggregate release-admin-console'
    };
    assert.ok(validateEvidenceExecutionDeclaration(invalidTarget, matrix).some((error) => error.includes('unknown aggregate authority')));

    const wrongSchema = { ...valid, outputReceiptSchema: 'fsusblog.other-receipt.v1' };
    assert.ok(validateEvidenceExecutionDeclaration(wrongSchema, matrix).some((error) => error.includes('outputReceiptSchema')));

    const unsortedInputs = { ...valid, summaryInputs: ['z.receipt.v1', 'a.receipt.v1'] };
    assert.ok(validateEvidenceExecutionDeclaration(unsortedInputs, matrix).some((error) => error.includes('sorted unique')));

    const projectionEscape = { ...valid, projectionCatalog: 'tests/fixtures/catalog.json' };
    assert.ok(validateEvidenceExecutionDeclaration(projectionEscape, matrix)
        .some((error) => error.includes('reserved for projection tiers')));
});

test('projection declarations require a catalog, exact IDs, artifact declarations, and projection command kind', () =>
{
    const invalidProjection = {
        id: 'release-projection',
        executionMode: 'projection',
        commandKind: 'aggregate',
        outputReceiptSchema: 'fsusblog.evidence-projection-receipt.v1',
        command: 'node tools/run-test-matrix.mjs aggregate release-summary',
        executionDependsOn: [],
        services: [],
        exclusiveResources: [],
        requiresBootstrap: 'none',
        requiresDotnet: false,
        requiresNode: true,
        requiresPlaywright: 'none',
        cacheProfile: 'none',
        resourceClass: 'io',
        cost: 'low'
    };
    const errors = validateEvidenceExecutionDeclaration(invalidProjection, fixtureMatrix());
    assert.ok(errors.some((error) => error.includes('projectionCatalog')));
    assert.ok(errors.some((error) => error.includes('requiredTestIds')));
    assert.ok(errors.some((error) => error.includes('commandKind')));

    const summaryEscape = {
        ...invalidProjection,
        summaryAuthority: 'fake-summary',
        summaryInputs: ['fsusblog.fake.v1']
    };
    assert.ok(validateEvidenceExecutionDeclaration(summaryEscape, fixtureMatrix())
        .some((error) => error.includes('reserved for summary tiers')));
});
