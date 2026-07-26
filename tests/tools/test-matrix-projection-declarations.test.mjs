import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { parseMatrix } = await import(pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href);
const { validateEvidenceExecutionDeclaration, evidenceExecutionModes } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/projection-declaration.mjs')).href
);
const { buildAggregatePlan } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/aggregate-plan.mjs')).href
);

function aggregateFixture(overrides = {})
{
    const summary = {
        id: 'fixture-summary-tier',
        ciJob: 'fixture-summary',
        executionMode: 'summary',
        commandKind: 'aggregate',
        summaryAuthority: 'fixture-summary',
        summaryInputs: ['fsusblog.ci.job-result.v1'],
        outputReceiptSchema: 'fsusblog.ci.job-result.v1',
        command: 'node tools/run-test-matrix.mjs aggregate fixture-summary',
        executionDependsOn: [],
        requiresEvidenceFrom: ['fixture-producer'],
        localOnly: false,
        nightlyOnly: false,
        manualOnly: false
    };
    return {
        aggregateAuthorities: {
            'fixture-summary': {
                id: 'fixture-summary',
                commandKind: 'aggregate',
                ciJob: 'fixture-summary',
                summaryTierIds: ['fixture-summary-tier'],
                inputReceiptSchemas: ['fsusblog.ci.job-result.v1'],
                outputReceiptSchema: 'fsusblog.ci.job-result.v1'
            }
        },
        tiers: [
            {
                id: 'fixture-producer',
                ciJob: 'fixture-producer',
                executionMode: 'execute',
                commandKind: 'producer',
                outputReceiptSchema: 'fsusblog.ci.job-result.v1',
                artifacts: ['.tmp/fixture/receipt.json'],
                evidence: ['.tmp/fixture/receipt.json']
            },
            { ...summary, ...(overrides.summary ?? {}) }
        ],
        ...overrides.matrix
    };
}

test('matrix validates every execution mode while allowing only separately owned declaration migrations', async () => {
    const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const errors = [];

    for (const tier of matrix.tiers) {
        const mode = tier.executionMode ?? 'execute';
        if (!evidenceExecutionModes.includes(mode)) {
            errors.push(`${tier.id} executionMode is invalid: ${tier.executionMode}`);
        }

        errors.push(...validateEvidenceExecutionDeclaration(tier, matrix));

        const command = String(tier.command ?? '');
        if (command.includes('noop.sh')) {
            errors.push(`${tier.id} must not use noop.sh physical process scheduling; found ${command}`);
        }
    }

    const migrationOwnedTierIds = new Set([
        'browser-diagnostics',
        'production',
        'release-admin-console',
        'release-aot-consumption',
        'release-aot-generation',
        'release-auth-flow',
        'release-authoring-flow',
        'release-error-boundary',
        'release-final',
        'release-private-preview',
        'release-rbac-negative',
        'release-static-asset-digest-coherence'
    ]);
    const unownedErrors = errors.filter((error) =>
        ![...migrationOwnedTierIds].some((tierId) => error.startsWith(`${tierId}.`) || error.startsWith(`${tierId} `))
    );
    assert.deepEqual(unownedErrors, []);
});

test('real JSON Schema validation rejects missing required fields and retired tier dependsOn', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-matrix-schema-'));
    const source = readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    const run = (name, matrixSource) => {
        const matrixFile = path.join(directory, `${name}.yml`);
        writeFileSync(matrixFile, matrixSource);
        return spawnSync(process.execPath, ['tools/run-test-matrix.mjs', 'validate'], {
            cwd: root,
            env: { ...process.env, FSUSBLOG_MATRIX_FILE: matrixFile },
            encoding: 'utf8'
        });
    };
    try {
        const missingRequired = source.replace(
            /(    - id: validate-matrix[\s\S]*?)      executionDependsOn: \[\]\n/u,
            '$1'
        );
        assert.notEqual(missingRequired, source);
        const missing = run('missing-required', missingRequired);
        assert.notEqual(missing.status, 0);
        assert.match(
            missing.stderr,
            /schema \/tiers\/0 must have required property 'executionDependsOn'/u
        );

        const retiredDependsOn = source.replace(
            /(    - id: validate-matrix[\s\S]*?      executionDependsOn: \[\]\n)/u,
            '$1      dependsOn: []\n'
        );
        assert.notEqual(retiredDependsOn, source);
        const retired = run('retired-depends-on', retiredDependsOn);
        assert.notEqual(retired.status, 0);
        assert.match(
            retired.stderr,
            /schema \/tiers\/0\/dependsOn must NOT have additional properties/u
        );
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('canonical producer topologies define valid projectFrom dependencies and clear execution owners', async () => {
    const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const projectionTiers = matrix.tiers.filter((tier) => tier.executionMode === 'projection');

    assert.ok(projectionTiers.length > 0, 'matrix must define projection tiers');
    for (const tier of projectionTiers) {
        assert.ok(tier.executionOwner, `${tier.id} must declare executionOwner`);
        assert.ok(tier.projectFrom, `${tier.id} must declare projectFrom`);
        assert.ok(tier.projectionCatalog, `${tier.id} must declare projectionCatalog`);
    }
});

test('shared aggregate planner gives deterministic pass/fail for authority and receipt declarations', () => {
    const valid = buildAggregatePlan(aggregateFixture(), 'fixture-summary');
    assert.deepEqual(valid.errors, []);
    assert.equal(valid.executesTestCommands, false);
    assert.deepEqual(valid.dependencyJobs, ['fixture-producer']);

    const unknown = buildAggregatePlan(aggregateFixture(), 'missing-summary');
    assert.deepEqual(unknown.errors, ['unknown aggregate authority: missing-summary']);

    const keyMismatch = aggregateFixture({ matrix: {
        aggregateAuthorities: {
            'fixture-summary': {
                id: 'wrong-id', commandKind: 'aggregate', ciJob: 'fixture-summary',
                summaryTierIds: ['fixture-summary-tier'], inputReceiptSchemas: ['fsusblog.ci.job-result.v1'],
                outputReceiptSchema: 'fsusblog.ci.job-result.v1'
            }
        }
    }});
    assert.ok(buildAggregatePlan(keyMismatch, 'fixture-summary').errors.some((error) => error.includes('.id must equal')));

    const cases = [
        ['commandKind', { commandKind: 'receipt' }],
        ['local-only', { localOnly: true }],
        ['nightly-only', { nightlyOnly: true }],
        ['manual-only', { manualOnly: true }],
        ['input-mismatch', { summaryInputs: ['fsusblog.other-receipt.v1'] }],
        ['output-mismatch', { outputReceiptSchema: 'fsusblog.other-receipt.v1' }]
    ];
    for (const [name, summary] of cases) {
        assert.notDeepEqual(buildAggregatePlan(aggregateFixture({ summary }), 'fixture-summary').errors, [], name);
    }
});

test('release aggregate tier IDs remain explicit invalid fixtures until backed by authorities', () => {
    for (const tierId of ['release-admin-console', 'release-aot-generation']) {
        const matrix = aggregateFixture({
            summary: {
                id: tierId,
                summaryAuthority: tierId,
                command: `node tools/run-test-matrix.mjs aggregate ${tierId}`
            }
        });
        const tier = matrix.tiers[1];
        const errors = validateEvidenceExecutionDeclaration(tier, matrix);
        assert.ok(errors.some((error) => error.includes(`unknown aggregate authority: ${tierId}`)));
    }
});

test('local validate deterministically rejects an injected invalid aggregate without relying on main matrix failures', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-invalid-summary-'));
    try {
        const source = readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
        const invalid = source.replace(
            'command: node tools/run-test-matrix.mjs aggregate fast-summary',
            'command: node tools/run-test-matrix.mjs aggregate fixture-unknown-authority'
        );
        assert.notEqual(invalid, source);
        const matrixFile = path.join(directory, 'matrix.yml');
        writeFileSync(matrixFile, invalid);
        const runValidate = () => spawnSync(process.execPath, ['tools/run-test-matrix.mjs', 'validate'], {
            cwd: root,
            env: { ...process.env, FSUSBLOG_MATRIX_FILE: matrixFile },
            encoding: 'utf8'
        });
        const first = runValidate();
        const second = runValidate();
        assert.notEqual(first.status, 0);
        assert.notEqual(second.status, 0);
        const diagnostic = 'unknown aggregate authority: fixture-unknown-authority';
        assert.ok(first.stderr.includes(diagnostic));
        assert.ok(second.stderr.includes(diagnostic));
        assert.equal(first.stderr, second.stderr, 'the injected local validation failure must be stable without CI state');

        const orphanAuthority = source.replace(
            'commandGroups:\n',
            [
                '    orphan-authority:',
                '        id: orphan-authority',
                '        commandKind: aggregate',
                '        ciJob: fast-summary',
                '        summaryTierIds: [fast]',
                '        inputReceiptSchemas: [fsusblog.ci.job-result.v1, fsusblog.evidence-projection-receipt.v1]',
                '        outputReceiptSchema: fsusblog.ci.job-result.v1',
                'commandGroups:',
                ''
            ].join('\n')
        );
        assert.notEqual(orphanAuthority, source);
        const orphanMatrixFile = path.join(directory, 'orphan-authority.yml');
        writeFileSync(orphanMatrixFile, orphanAuthority);
        const orphan = spawnSync(process.execPath, ['tools/run-test-matrix.mjs', 'validate'], {
            cwd: root,
            env: { ...process.env, FSUSBLOG_MATRIX_FILE: orphanMatrixFile },
            encoding: 'utf8'
        });
        assert.notEqual(orphan.status, 0);
        assert.match(orphan.stderr, /aggregateAuthorities\.orphan-authority:/u);
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
