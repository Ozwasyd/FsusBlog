import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const verifier = path.join(root, 'tools/test/verify-release-reliability-receipt.mjs');
const matrixRunner = path.join(root, 'tools/run-test-matrix.mjs');
const matrixSource = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
const scenarioIds = [
    'release-soak-min',
    'release-load-peak',
    'release-load-burst',
    'release-data-scale-m',
    'release-mutation-critical-slice',
    'release-memory-leak-budget',
    'release-open-handle-budget'
];
const {
    locateReleaseReliabilityQualifiedReceipt
} = await import(pathToFileURL(path.join(
    root,
    'tools/release/release-reliability-qualified-receipt.mjs'
)).href);
const {
    executeScenarios
} = await import(pathToFileURL(path.join(
    root,
    'tools/test/run-release-reliability-scenarios.mjs'
)).href);
const {
    parseMatrix
} = await import(pathToFileURL(path.join(
    root,
    'tools/test-matrix/parse-matrix.mjs'
)).href);

function replaceTierField(source, tierId, field, value)
{
    const lines = source.split('\n');
    const tierStart = lines.findIndex((line) => line === `    - id: ${tierId}`);
    assert.notEqual(tierStart, -1, `fixture matrix is missing tier ${tierId}`);
    const tierEndOffset = lines.slice(tierStart + 1)
        .findIndex((line) => line.startsWith('    - id: '));
    const tierEnd = tierEndOffset === -1
        ? lines.length
        : tierStart + 1 + tierEndOffset;
    const fieldOffset = lines.slice(tierStart, tierEnd)
        .findIndex((line) => line.startsWith(`      ${field}:`));
    assert.notEqual(fieldOffset, -1, `${tierId} is missing field ${field}`);
    const fieldIndex = tierStart + fieldOffset;
    let nextFieldIndex = fieldIndex + 1;
    while (nextFieldIndex < tierEnd
        && !/^ {6}[A-Za-z][A-Za-z0-9]*:/u.test(lines[nextFieldIndex]))
    {
        nextFieldIndex += 1;
    }
    lines.splice(fieldIndex, nextFieldIndex - fieldIndex, `      ${field}: ${value}`);
    return lines.join('\n');
}

function validateMutatedMatrix(context, mutate)
{
    const fixture = fs.mkdtempSync(
        path.join(os.tmpdir(), 'fsusblog-release-reliability-matrix-')
    );
    context.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const matrixFile = path.join(fixture, 'matrix.yml');
    fs.writeFileSync(matrixFile, mutate(matrixSource));
    return spawnSync(process.execPath, [matrixRunner, 'validate'], {
        cwd: root,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_MATRIX_FILE: matrixFile
        }
    });
}

function writeDiagnosticResults(repositoryRoot, count)
{
    for (let index = 0; index < count; index += 1)
    {
        const invocationId = `diagnostic-${index + 1}`;
        const resultDirectory = path.join(
            repositoryRoot,
            '.tmp/release-reliability',
            invocationId,
            'scenario-results'
        );
        fs.mkdirSync(resultDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(resultDirectory, `${scenarioIds[index]}.json`),
            `${JSON.stringify({
                schema: 'fsusblog.release-reliability-scenario-result.v2',
                invocationId,
                runId: 'diagnostic-run',
                scenarioId: scenarioIds[index],
                status: 'passed',
                evidenceClass: 'diagnostic',
                qualificationEligible: false
            }, null, 2)}\n`
        );
    }
}

test('single-scenario execution requires explicit diagnostic ineligibility', async () =>
{
    const catalog = {
        scenarios: [{ id: scenarioIds[0] }]
    };
    await assert.rejects(
        executeScenarios({
            catalog,
            scenarioId: scenarioIds[0],
            evidenceClass: 'correctness',
            qualificationEligible: true
        }),
        /single-scenario execution must be classified as diagnostic/u
    );
    await assert.rejects(
        executeScenarios({
            catalog,
            scenarioId: null,
            evidenceClass: 'diagnostic',
            qualificationEligible: false
        }),
        /complete scenario execution must be classified as correctness/u
    );
});

test('matrix declares exactly seven diagnostic-only scenario tiers and one qualified authority', () =>
{
    const matrix = parseMatrix(matrixSource);
    const scenarioTiers = matrix.tiers.filter((tier) => (
        String(tier.command ?? '').includes(
            'tools/test/run-release-reliability-scenarios.mjs --scenario'
        )
    ));
    assert.deepEqual(
        scenarioTiers.map((tier) => tier.id),
        scenarioIds
    );
    for (const tier of scenarioTiers)
    {
        assert.equal(tier.evidenceClass, 'diagnostic', tier.id);
        assert.equal(tier.qualificationEligible, false, tier.id);
        assert.equal(tier.requiredFor, 'none', tier.id);
        assert.equal(tier.manualOnly, true, tier.id);
    }
    const fullAuthorities = matrix.tiers.filter((tier) => (
        tier.command === 'tools/test/run-release-reliability-qualified-local.sh'
    ));
    assert.deepEqual(fullAuthorities.map((tier) => tier.id), [
        'release-reliability-fresh'
    ]);
    assert.equal(fullAuthorities[0].evidenceClass, 'correctness');
    assert.equal(fullAuthorities[0].qualificationEligible, true);
    assert.equal(fullAuthorities[0].requiredFor, 'release-final');
});

test('passed diagnostic result files cannot substitute for a qualified receipt', async (context) =>
{
    for (const count of [1, 7])
    {
        await context.test(`${count} diagnostic result file(s)`, (subtest) =>
        {
            const repositoryRoot = fs.mkdtempSync(
                path.join(os.tmpdir(), 'fsusblog-release-reliability-diagnostics-')
            );
            subtest.after(() => fs.rmSync(repositoryRoot, {
                recursive: true,
                force: true
            }));
            writeDiagnosticResults(repositoryRoot, count);
            let verifierCalls = 0;
            assert.throws(
                () => locateReleaseReliabilityQualifiedReceipt({
                    repositoryRoot,
                    verifyQualifiedReceipt()
                    {
                        verifierCalls += 1;
                        throw new Error('verifier must not run without a qualified receipt');
                    }
                }),
                /qualified receipt is missing.*release-reliability-fresh/su
            );
            assert.equal(verifierCalls, 0);
        });
    }
});

test('runtime-admission receipts are ignored by the locator and rejected by the qualified verifier', (context) =>
{
    const repositoryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'fsusblog-runtime-admission-control-flow-')
    );
    context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    const invocationId = 'runtime-admission-only';
    const relative =
        `.tmp/release-reliability/${invocationId}/runtime-admission-receipt.json`;
    const receiptFile = path.join(repositoryRoot, relative);
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    fs.writeFileSync(receiptFile, `${JSON.stringify({
        schema: 'fsusblog.release-reliability.runtime-admission.v1',
        artifactKind: 'receipt',
        status: 'passed',
        qualificationEligible: false,
        invocationId
    })}\n`);

    let verifierCalls = 0;
    assert.throws(
        () => locateReleaseReliabilityQualifiedReceipt({
            repositoryRoot,
            verifyQualifiedReceipt()
            {
                verifierCalls += 1;
            }
        }),
        /qualified receipt is missing.*release-reliability-fresh/su
    );
    assert.equal(verifierCalls, 0);

    const result = spawnSync(process.execPath, [
        verifier,
        '--root',
        repositoryRoot,
        '--receipt',
        relative
    ], {
        cwd: root,
        encoding: 'utf8'
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /qualified receipt fields are not exact/u);
});

test('matrix governance rejects release correctness classification for --scenario commands', async (context) =>
{
    const cases = [
        {
            name: 'correctness evidence class',
            mutate(source)
            {
                return replaceTierField(
                    source,
                    scenarioIds[0],
                    'evidenceClass',
                    'correctness'
                );
            },
            expected: /must use evidenceClass=diagnostic/u
        },
        {
            name: 'release-final requirement',
            mutate(source)
            {
                return replaceTierField(
                    source,
                    scenarioIds[0],
                    'requiredFor',
                    'release-final'
                );
            },
            expected: /must use requiredFor=none/u
        },
        {
            name: 'quoted scenario option remains diagnostic',
            mutate(source)
            {
                let mutated = replaceTierField(
                    source,
                    scenarioIds[0],
                    'command',
                    "node tools/test/run-release-reliability-scenarios.mjs '--scenario' release-soak-min"
                );
                mutated = replaceTierField(
                    mutated,
                    scenarioIds[0],
                    'evidenceClass',
                    'correctness'
                );
                return mutated;
            },
            expected: /must use evidenceClass=diagnostic/u
        },
        {
            name: 'single-scenario qualification eligibility',
            mutate(source)
            {
                return replaceTierField(
                    source,
                    scenarioIds[0],
                    'qualificationEligible',
                    'true'
                );
            },
            expected: /must use qualificationEligible=false/u
        },
        {
            name: 'single-scenario manual admission',
            mutate(source)
            {
                return replaceTierField(
                    source,
                    scenarioIds[0],
                    'manualOnly',
                    'false'
                );
            },
            expected: /must use manualOnly=true/u
        },
        {
            name: 'complete authority qualification eligibility',
            mutate(source)
            {
                return replaceTierField(
                    source,
                    'release-reliability-fresh',
                    'qualificationEligible',
                    'false'
                );
            },
            expected: /complete release reliability authority must use/u
        },
        {
            name: 'raw driver cannot replace the verified full authority',
            mutate(source)
            {
                return replaceTierField(
                    source,
                    'release-reliability-fresh',
                    'command',
                    'node tools/test/run-release-reliability-scenarios.mjs'
                );
            },
            expected: /raw release reliability scenario driver cannot be a complete authority/u
        },
        {
            name: 'second release-final reliability authority',
            mutate(source)
            {
                return source.replace(
                    '              release-reliability-fresh,\n',
                    '              release-reliability-fresh,\n'
                        + '              release-soak-min,\n'
                );
            },
            expected: /consume only release-reliability-fresh/u
        },
        {
            name: 'second raw complete authority',
            mutate(source)
            {
                let mutated = replaceTierField(
                    source,
                    scenarioIds[0],
                    'command',
                    'node tools/test/run-release-reliability-scenarios.mjs'
                );
                mutated = replaceTierField(
                    mutated,
                    scenarioIds[0],
                    'evidenceClass',
                    'correctness'
                );
                mutated = replaceTierField(
                    mutated,
                    scenarioIds[0],
                    'qualificationEligible',
                    'true'
                );
                mutated = replaceTierField(
                    mutated,
                    scenarioIds[0],
                    'requiredFor',
                    'release-final'
                );
                return mutated.replace(
                    '              release-reliability-fresh,\n',
                    '              release-reliability-fresh,\n'
                        + '              release-soak-min,\n'
                );
            },
            expected: /consume only release-reliability-fresh/u
        },
        {
            name: 'second qualified-local authority',
            mutate(source)
            {
                let mutated = replaceTierField(
                    source,
                    scenarioIds[0],
                    'command',
                    'tools/test/run-release-reliability-qualified-local.sh'
                );
                mutated = replaceTierField(
                    mutated,
                    scenarioIds[0],
                    'evidenceClass',
                    'correctness'
                );
                mutated = replaceTierField(
                    mutated,
                    scenarioIds[0],
                    'qualificationEligible',
                    'true'
                );
                mutated = replaceTierField(
                    mutated,
                    scenarioIds[0],
                    'requiredFor',
                    'release-final'
                );
                return mutated.replace(
                    '              release-reliability-fresh,\n',
                    '              release-reliability-fresh,\n'
                        + '              release-soak-min,\n'
                );
            },
            expected: /consume only release-reliability-fresh/u
        },
        {
            name: 'unreferenced second qualified-local authority',
            mutate(source)
            {
                let mutated = replaceTierField(
                    source,
                    scenarioIds[0],
                    'command',
                    'tools/test/run-release-reliability-qualified-local.sh'
                );
                mutated = replaceTierField(
                    mutated,
                    scenarioIds[0],
                    'evidenceClass',
                    'correctness'
                );
                mutated = replaceTierField(
                    mutated,
                    scenarioIds[0],
                    'qualificationEligible',
                    'true'
                );
                return replaceTierField(
                    mutated,
                    scenarioIds[0],
                    'requiredFor',
                    'release-final'
                );
            },
            expected: /exactly one qualified release reliability wrapper authority/u
        }
    ];
    for (const entry of cases)
    {
        await context.test(entry.name, (subtest) =>
        {
            const result = validateMutatedMatrix(subtest, entry.mutate);
            const output = `${result.stdout}\n${result.stderr}`;
            assert.notEqual(result.status, 0, output);
            assert.match(output, entry.expected);
        });
    }
});

test('release-final plan exposes only the full reliability authority', () =>
{
    const result = spawnSync('./tools/test.sh', ['release-final', '--plan-only'], {
        cwd: root,
        encoding: 'utf8'
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    const inputs = output.match(/\bevidenceInputs=([^\s]+)/u)?.[1]?.split(',') ?? [];
    assert.equal(inputs.includes('release-reliability-fresh'), true);
    for (const scenarioId of scenarioIds)
    {
        assert.equal(inputs.includes(scenarioId), false, scenarioId);
    }
});

test('independent verifier rejects a handwritten qualified status without bindings', (context) =>
{
    const repositoryRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'fsusblog-release-reliability-manual-receipt-')
    );
    context.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    const receipt = '.tmp/release-reliability/manual/qualified-receipt.json';
    const receiptFile = path.join(repositoryRoot, receipt);
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    fs.writeFileSync(receiptFile, '{"status":"qualified"}\n');
    const result = spawnSync(process.execPath, [
        verifier,
        '--root',
        repositoryRoot,
        '--receipt',
        receipt
    ], {
        cwd: root,
        encoding: 'utf8'
    });
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /qualified receipt fields are not exact/u);
});
