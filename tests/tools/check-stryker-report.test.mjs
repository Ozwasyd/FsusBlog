import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import test from 'node:test';

import {
    createStrykerAuthority,
    validateInventoryCollections,
    validateStrykerAuthority,
    validateStrykerReport
} from '../../tools/test/check-stryker-report.mjs';

const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
};
const defaultRawTestId = '00000000-0000-0000-0000-000000000001';
const defaultTestName = 'FsusBlog.Server.Tests.Unit.AedsEncoderTests.Encode';
const defaultReportPath = '.tmp/mutation/backend-critical/reports/backend-mutation-critical.json';
const config = {
    'stryker-config': {
        'test-case-filter': 'FullyQualifiedName~FsusBlog.Server.Tests.Unit.AedsEncoderTests',
        mutate: ['Algorithms/AedsEncoder.cs'],
        thresholds: { high: 85, low: 70, break: 70 }
    }
};

function shortDigest(value)
{
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function mutant({
    id,
    status = 'Killed',
    source = 'return value + 1;',
    replacement = 'return value - 1;',
    line = 1,
    coveredBy,
    killedBy
} = {})
{
    const covered = coveredBy ?? (
        ['CompileError', 'Ignored', 'NoCoverage'].includes(status)
            ? []
            : [defaultRawTestId]
    );
    return {
        id: id ?? `raw-${shortDigest(`${line}|${replacement}|${status}`)}`,
        status,
        mutatorName: 'Arithmetic mutation',
        replacement,
        location: {
            start: { line, column: 1 },
            end: { line, column: source.length + 1 }
        },
        coveredBy: covered,
        killedBy: killedBy ?? (status === 'Killed' ? covered : [])
    };
}

function report(mutants = [mutant()])
{
    const source = 'return value + 1;\nreturn value + 2;\nreturn value + 3;';
    return {
        schemaVersion: '2',
        thresholds: { high: 85, low: 70 },
        files: {
            'Algorithms/AedsEncoder.cs': {
                language: 'cs',
                source,
                mutants
            }
        },
        testFiles: {
            'tests/backend/Unit/AedsEncoderTests.cs': {
                tests: [{
                    id: defaultRawTestId,
                    name: defaultTestName
                }]
            }
        }
    };
}

function mutationScore(inputReport)
{
    const mutants = Object.values(inputReport.files).flatMap(({ mutants: values }) => values);
    const killed = mutants.filter(({ status }) => status === 'Killed').length;
    const scoreable = mutants.filter(({ status }) =>
        ['Killed', 'NoCoverage', 'Survived', 'Timeout'].includes(status)
    ).length;
    return Number(((killed / scoreable) * 100).toFixed(2));
}

function traceFor(inputReport, inputConfig = config, {
    batches,
    reportPath = resolve('/repo', defaultReportPath),
    terminalOutcome,
    reverseTimestamps = false
} = {})
{
    const mutants = Object.values(inputReport.files)
        .flatMap(({ mutants: values }) => values);
    const byId = new Map(mutants.map((value) => [String(value.id), value]));
    const executedIds = mutants
        .filter(({ status }) => ['Killed', 'Survived', 'Timeout'].includes(status))
        .map(({ id }) => String(id));
    const selectedBatches = batches ?? executedIds.map((rawMutantId) => [rawMutantId]);
    const reportName = basename(reportPath, extname(reportPath));
    const lines = [
        '2026-07-11T00:59:59.0000000Z  [DBG] '
        + 'Stryker starting, version: "4.16.0" (f9109e24)',
        '2026-07-11T01:00:00.0000000Z  [DBG] Stryker started with options: '
        + `StrykerOptions { ReportPath: "${dirname(reportPath)}", `
        + `ReportFileName: "${reportName}", `
        + `TestCaseFilter: "${inputConfig['stryker-config']['test-case-filter']}" } (fac41b16)`
    ];
    selectedBatches.forEach((rawMutantIds, index) =>
    {
        const startMs = Date.parse('2026-07-11T01:00:01.000Z') + index * 100;
        const endMs = reverseTimestamps ? startMs - 25 : startMs + 25;
        const startedAt = new Date(startMs).toISOString().replace('.000Z', '.0000000Z');
        const completedAt = new Date(endMs).toISOString().replace('.025Z', '.0250000Z');
        const descriptions = rawMutantIds
            .map((rawMutantId) => `${rawMutantId}: mutation`)
            .join(',');
        const statuses = [...new Set(rawMutantIds.map((rawMutantId) => byId.get(rawMutantId)?.status))];
        const outcome = terminalOutcome ?? (
            statuses[0] === 'Killed'
                ? 'failed'
                : statuses[0] === 'Timeout'
                    ? 'timeout'
                    : 'passed'
        );
        lines.push(
            `${startedAt}  [DBG] "Runner 0": Testing ${JSON.stringify([descriptions])} (445b8f48)`
        );
        lines.push(
            `${completedAt}  [DBG] Test run for "${descriptions.replaceAll(',', ', ')}" `
            + `is "${outcome}" (26093294)`
        );
    });
    lines.push(
        `2026-07-11T01:00:10.0000000Z  [INF] The final mutation score is `
        + `${mutationScore(inputReport).toFixed(2)} % (2ef58de4)`
    );
    return Buffer.from(`${lines.join('\n')}\n`);
}

function authorityInputs(inputReport = report(), inputConfig = config, options = {})
{
    const rawReport = Buffer.from(JSON.stringify(inputReport));
    const rawConfig = Buffer.from(JSON.stringify(inputConfig));
    const rawTrace = options.rawTrace ?? traceFor(inputReport, inputConfig, options.traceOptions);
    return {
        report: inputReport,
        rawReport,
        reportPath: defaultReportPath,
        reportAbsolutePath: resolve('/repo', defaultReportPath),
        rawTrace,
        tracePath: '.tmp/mutation/backend-critical/logs/log-20260711.txt',
        config: inputConfig,
        rawConfig,
        configPath: 'config/testing/mutation/critical.json',
        tierId: 'release-mutation-critical-slice',
        runId: 'current-run',
        sourceState,
        generatedAt: '2026-07-11T01:02:03.000Z',
        repositoryRoot: '/repo',
        sourceRoot: 'src/core'
    };
}

function authority(inputReport = report(), inputConfig = config, options = {})
{
    return createStrykerAuthority(authorityInputs(inputReport, inputConfig, options));
}

test('mutation producer authority preserves the current release reliability binding', () =>
{
    const releaseReliability = {
        invocationId: 'fixture-invocation',
        runId: 'fixture-run',
        scenarioId: 'release-mutation-critical-slice',
        identityContentDigest: `sha256:${'d'.repeat(64)}`,
        sourceState,
        buildContentDigest: `sha256:${'e'.repeat(64)}`
    };
    const inputs = {
        ...authorityInputs(),
        releaseReliability
    };
    const value = createStrykerAuthority(inputs);
    assert.deepEqual(value.releaseReliability, releaseReliability);
    assert.equal(validateStrykerAuthority({ authority: value, ...inputs }), value);

    const tampered = structuredClone(value);
    tampered.releaseReliability.invocationId = 'other-invocation';
    assert.throws(
        () => validateStrykerAuthority({ authority: tampered, ...inputs }),
        /authority content mismatch/u
    );
});

test('mutation authority binds stable inventory, real test identities, terminal sets, and trace batches', () =>
{
    const input = report([
        mutant({ status: 'Killed', line: 1 }),
        mutant({ status: 'Killed', line: 2, replacement: 'return value - 2;' }),
        mutant({ status: 'Killed', line: 3, replacement: 'return value - 3;' }),
        mutant({ status: 'Killed', line: 2, replacement: 'return value * 2;' }),
        mutant({ status: 'Killed', line: 3, replacement: 'return value / 2;' }),
        mutant({ status: 'Survived', line: 3, replacement: 'return value * 3;' }),
        mutant({ status: 'NoCoverage', line: 1, replacement: 'return value / 3;' })
    ]);
    const killedIds = input.files['Algorithms/AedsEncoder.cs'].mutants
        .filter(({ status }) => status === 'Killed')
        .map(({ id }) => id);
    const rawTrace = traceFor(input, config, {
        batches: [[killedIds[0], killedIds[1]], ...killedIds.slice(2).map((id) => [id]),
            [input.files['Algorithms/AedsEncoder.cs'].mutants[5].id]]
    });
    const value = authority(input, config, { rawTrace });

    assert.equal(value.inventory.length, 7);
    assert.ok(value.inventory.every(
        (entry) => entry.sourceFile === 'src/core/Algorithms/AedsEncoder.cs'
    ));
    assert.deepEqual(
        value.executedMutantIds,
        [...value.killedMutantIds, ...value.survivedMutantIds].sort()
    );
    assert.equal(value.noCoverageMutantIds.length, 1);
    assert.deepEqual(value.executedTestIds, [defaultTestName]);
    assert.deepEqual(value.testIdentities, [{
        rawTestId: defaultRawTestId,
        fullyQualifiedName: defaultTestName
    }]);
    assert.equal(value.traceExecution.batches[0].rawMutantIds.length, 2);
    assert.equal(value.traceExecution.strykerVersion, '4.16.0');
    const firstBatchMembers = value.inventory.filter(
        ({ traceBatchId }) => traceBatchId === value.traceExecution.batches[0].batchId
    );
    assert.equal(firstBatchMembers.length, 2);
    assert.equal(firstBatchMembers[0].durationMs, firstBatchMembers[1].durationMs);
    assert.match(value.inventoryDigest, /^[0-9a-f]{64}$/u);
    assert.match(value.executionMatrixDigest, /^[0-9a-f]{64}$/u);
    assert.match(value.rawTrace.sha256, /^[0-9a-f]{64}$/u);
});

test('different inventory with equal counts and score changes its digest, while report order is immaterial', () =>
{
    const firstMutants = [
        mutant({ line: 1 }),
        mutant({ line: 2, replacement: 'return value - 2;' }),
        mutant({ line: 3, replacement: 'return value - 3;' }),
        mutant({ status: 'Survived', line: 2, replacement: 'return value * 2;' })
    ];
    const firstReport = report(firstMutants);
    const sharedTrace = traceFor(firstReport);
    const first = authority(firstReport, config, { rawTrace: sharedTrace });
    const different = authority(report([
        ...firstMutants.slice(0, 3),
        mutant({ status: 'Survived', line: 2, replacement: 'return value / 2;' })
    ]));
    const reordered = authority(
        report([...firstMutants].reverse()),
        config,
        { rawTrace: sharedTrace }
    );

    assert.equal(first.score, different.score);
    assert.notEqual(first.inventoryDigest, different.inventoryDigest);
    assert.equal(first.inventoryDigest, reordered.inventoryDigest);
    assert.equal(first.executionMatrixDigest, reordered.executionMatrixDigest);
});

test('source content is part of canonical identity while raw mutant ID is only a producer join key', () =>
{
    const before = authority();
    const changed = report();
    changed.files['Algorithms/AedsEncoder.cs'].source =
        'return other + 1;\nreturn value + 2;\nreturn value + 3;';
    const after = authority(changed);

    assert.notEqual(before.inventory[0].mutantId, after.inventory[0].mutantId);
    assert.equal(before.inventory[0].rawMutantId, after.inventory[0].rawMutantId);
});

test('source line endings and outer whitespace are exact canonical identity inputs', () =>
{
    const baselineReport = report();
    const whitespaceReport = structuredClone(baselineReport);
    const sourceRecord = whitespaceReport.files['Algorithms/AedsEncoder.cs'];
    sourceRecord.source = ` ${sourceRecord.source} `;

    const baseline = authority(baselineReport);
    const whitespace = authority(whitespaceReport);
    assert.notEqual(
        baseline.inventory[0].sourceFileDigest,
        whitespace.inventory[0].sourceFileDigest
    );
    assert.notEqual(baseline.inventoryDigest, whitespace.inventoryDigest);

    const lfReport = report([mutant({ id: 'cross-line-source-range' })]);
    const lfMutant = lfReport.files['Algorithms/AedsEncoder.cs'].mutants[0];
    lfMutant.location = {
        start: { line: 1, column: 1 },
        end: { line: 2, column: 1 }
    };
    const crlfReport = structuredClone(lfReport);
    crlfReport.files['Algorithms/AedsEncoder.cs'].source =
        crlfReport.files['Algorithms/AedsEncoder.cs'].source.replaceAll('\n', '\r\n');

    const lf = authority(lfReport);
    const crlf = authority(crlfReport);
    const expectedLfOriginal = 'return value + 1;\n';
    const expectedCrlfOriginal = 'return value + 1;\r\n';
    assert.equal(
        lf.inventory[0].originalDigest,
        createHash('sha256').update(expectedLfOriginal).digest('hex')
    );
    assert.equal(
        crlf.inventory[0].originalDigest,
        createHash('sha256').update(expectedCrlfOriginal).digest('hex')
    );
    assert.notEqual(lf.inventory[0].originalDigest, crlf.inventory[0].originalDigest);
});

test('replacement identity preserves leading whitespace and legal empty strings', () =>
{
    const replacementAuthority = (replacement) => authority(report([
        mutant({ id: 'stable-raw-id', replacement })
    ]));
    const braces = replacementAuthority('{}');
    const leadingWhitespace = replacementAuthority(' {}');
    const empty = replacementAuthority('');

    assert.equal(braces.score, leadingWhitespace.score);
    assert.equal(braces.mutantCount, leadingWhitespace.mutantCount);
    assert.notEqual(braces.inventoryDigest, leadingWhitespace.inventoryDigest);
    assert.notEqual(braces.executionMatrixDigest, leadingWhitespace.executionMatrixDigest);
    assert.notEqual(empty.inventoryDigest, leadingWhitespace.inventoryDigest);
    assert.equal(
        leadingWhitespace.inventory[0].replacementDigest,
        createHash('sha256').update(' {}').digest('hex')
    );
    assert.equal(
        empty.inventory[0].replacementDigest,
        createHash('sha256').update('').digest('hex')
    );
});

test('operator identity uses the reviewed Stryker.NET 4.16.0 allowlist', () =>
{
    const knownOperators = [
        'Arithmetic mutation',
        'AddAssignmentExpression to SubtractAssignmentExpression mutation',
        'LogicalNotExpression to un-LogicalNotExpression mutation',
        'Linq method mutation (Any() to All())',
        'Math method mutation (Acos() to Asin())',
        'String Method Mutation (Replace EndsWith() with StartsWith())',
        'Regex anchor removal mutation'
    ];
    for (const operator of knownOperators)
    {
        const input = report();
        input.files['Algorithms/AedsEncoder.cs'].mutants[0].mutatorName = operator;
        assert.equal(authority(input).inventory[0].operator, operator);
    }

    const unknown = report();
    unknown.files['Algorithms/AedsEncoder.cs'].mutants[0].mutatorName =
        'TotallyUnknownMutationOperator';
    assert.throws(
        () => authority(unknown),
        /not in the Stryker\.NET 4\.16\.0 allowlist/u
    );
});

test('non-executed statuses use honest null duration states and never synthetic zero', () =>
{
    const input = report([
        mutant({ status: 'Killed', line: 1 }),
        mutant({ status: 'Killed', line: 2, replacement: 'return value - 2;' }),
        mutant({ status: 'Killed', line: 3, replacement: 'return value - 3;' }),
        mutant({ status: 'Ignored', line: 1, replacement: 'return value * 2;' }),
        mutant({ status: 'CompileError', line: 2, replacement: 'return value * 3;' }),
        mutant({ status: 'NoCoverage', line: 3, replacement: 'return value * 4;' })
    ]);
    const inputs = authorityInputs(input);
    const value = createStrykerAuthority(inputs);
    const ignored = value.inventory.find(({ status }) => status === 'Ignored');
    const compileError = value.inventory.find(({ status }) => status === 'CompileError');
    const noCoverage = value.inventory.find(({ status }) => status === 'NoCoverage');

    assert.deepEqual(
        [ignored.durationMs, ignored.durationState, ignored.traceBatchId],
        [null, 'not-executed', null]
    );
    assert.deepEqual(
        [noCoverage.durationMs, noCoverage.durationState, noCoverage.traceBatchId],
        [null, 'not-executed', null]
    );
    assert.deepEqual(
        [compileError.durationMs, compileError.durationState, compileError.traceBatchId],
        [null, 'not-reported-for-compile-error', null]
    );

    const invalid = structuredClone(value);
    invalid.inventory.find(({ status }) => status === 'Killed').durationMs = null;
    assert.throws(
        () => validateStrykerAuthority({
            authority: invalid,
            ...inputs
        }),
        /invalid trace duration contract/u
    );

    const syntheticZero = structuredClone(value);
    syntheticZero.inventory.find(({ status }) => status === 'Ignored').durationMs = 0;
    assert.throws(
        () => validateStrykerAuthority({ authority: syntheticZero, ...inputs }),
        /invalid duration state/u
    );

    const missingState = structuredClone(value);
    delete missingState.inventory.find(({ status }) => status === 'CompileError').durationState;
    assert.throws(
        () => validateStrykerAuthority({ authority: missingState, ...inputs }),
        /invalid duration state/u
    );
});

test('mutation authority fails closed for duplicate or incomplete mutant facts', () =>
{
    const duplicateCanonical = report([
        mutant({ id: 'raw-one', line: 1 }),
        mutant({ id: 'raw-two', line: 1 })
    ]);
    assert.throws(() => authority(duplicateCanonical), /duplicate canonical mutant ID/u);

    const duplicateRaw = report([
        mutant({ id: 'raw-same', line: 1 }),
        mutant({ id: 'raw-same', line: 2, replacement: 'return value - 2;' })
    ]);
    assert.throws(() => authority(duplicateRaw), /duplicate raw mutant ID/u);

    const noLocation = report([mutant({ line: 1 })]);
    delete noLocation.files['Algorithms/AedsEncoder.cs'].mutants[0].location;
    assert.throws(() => authority(noLocation), /startLine is required/u);

    const noSource = report();
    delete noSource.files['Algorithms/AedsEncoder.cs'].source;
    assert.throws(() => authority(noSource), /source content is required/u);

    const emptySource = report();
    emptySource.files['Algorithms/AedsEncoder.cs'].source = '';
    assert.throws(() => authority(emptySource), /source content must not be empty/u);

    const nonStringSource = report();
    nonStringSource.files['Algorithms/AedsEncoder.cs'].source = null;
    assert.throws(() => authority(nonStringSource), /source content must be a string/u);

    const noReplacement = report();
    delete noReplacement.files['Algorithms/AedsEncoder.cs'].mutants[0].replacement;
    assert.throws(() => authority(noReplacement), /replacement is required/u);

    const nonStringReplacement = report();
    nonStringReplacement.files['Algorithms/AedsEncoder.cs'].mutants[0].replacement = null;
    assert.throws(() => authority(nonStringReplacement), /replacement must be a string/u);

    const unknownStatus = report([mutant({ status: 'Unknown' })]);
    assert.throws(() => authority(unknownStatus), /unknown mutant status/u);

    const missingKillingTest = report([mutant({ killedBy: [] })]);
    assert.throws(() => authority(missingKillingTest), /killing test ID/u);

    const noCoverageExecuted = report([
        mutant({ status: 'Killed', line: 1 }),
        mutant({
            status: 'NoCoverage',
            line: 2,
            replacement: 'return value - 2;',
            coveredBy: [defaultRawTestId]
        })
    ]);
    assert.throws(() => authority(noCoverageExecuted), /NoCoverage mutant cannot have test IDs/u);
});

test('raw test GUIDs resolve uniquely to report FQNs and configuration checks actual names', () =>
{
    const unknownTest = report();
    unknownTest.testFiles['tests/backend/Unit/AedsEncoderTests.cs'].tests = [];
    assert.throws(() => authority(unknownTest), /unknown raw test ID/u);

    const duplicateTest = report();
    duplicateTest.testFiles['tests/backend/Unit/AedsEncoderTests.cs'].tests.push({
        id: defaultRawTestId,
        name: `${defaultTestName}.Duplicate`
    });
    assert.throws(() => authority(duplicateTest), /duplicate raw test ID/u);

    const wrongFqn = report();
    wrongFqn.testFiles['tests/backend/Unit/AedsEncoderTests.cs'].tests[0].name =
        'FsusBlog.Server.Tests.Unit.OtherTests.Run';
    assert.throws(
        () => authority(wrongFqn),
        /does not match configured test-case-filter/u
    );

    const noTests = report([mutant({ status: 'Survived', coveredBy: [] })]);
    assert.throws(() => authority(noTests), /executed mutant must have covered test IDs/u);
});

test('trace binding rejects missing, duplicate, extra, reversed, mismatched, or inconsistent batches', () =>
{
    const input = report();
    const rawId = input.files['Algorithms/AedsEncoder.cs'].mutants[0].id;

    assert.throws(
        () => authority(input, config, {
            rawTrace: traceFor(input).toString('utf8')
                .replace(/^.*Stryker starting, version:.*\n/mu, '')
        }),
        /exactly one producer version record/u
    );
    assert.throws(
        () => authority(input, config, {
            rawTrace: traceFor(input).toString('utf8').replace('4.16.0', '4.16.1')
        }),
        /unsupported Stryker\.NET producer version 4\.16\.1/u
    );
    assert.throws(
        () => authority(input, config, {
            rawTrace: traceFor(input).toString('utf8')
                .replace(/^.*Test run for.*\n/mu, '')
        }),
        /unterminated mutant batches/u
    );
    assert.throws(
        () => authority(input, config, {
            rawTrace: traceFor(input, config, { batches: [[rawId, rawId]] })
        }),
        /duplicate raw mutant IDs/u
    );
    assert.throws(
        () => authority(input, config, {
            rawTrace: traceFor(input, config, { batches: [['unknown-mutant']] })
        }),
        /unknown raw mutant ID/u
    );
    assert.throws(
        () => authority(input, config, {
            rawTrace: traceFor(input, config, { reverseTimestamps: true })
        }),
        /reversed or zero-length/u
    );
    assert.throws(
        () => authority(input, config, {
            rawTrace: traceFor(input).toString('utf8')
                .replace('/repo/.tmp/mutation/backend-critical/reports', '/wrong/reports')
        }),
        /bound to a different report/u
    );
    assert.throws(
        () => authority(input, config, {
            rawTrace: traceFor(input).toString('utf8')
                .replace(
                    config['stryker-config']['test-case-filter'],
                    'FullyQualifiedName~FsusBlog.Server.Tests.Unit.OtherTests'
                )
        }),
        /trace test-case-filter does not match/u
    );
    assert.throws(
        () => authority(input, config, {
            rawTrace: traceFor(input).toString('utf8')
                .replace('100.00 %', '0.00 %')
        }),
        /final score does not match the raw report/u
    );
    assert.throws(
        () => authority(input, config, {
            rawTrace: traceFor(input, config, { terminalOutcome: 'passed' })
        }),
        /not terminal-consistent/u
    );
    assert.throws(
        () => authority(input, config, {
            rawTrace: traceFor(input, config, { batches: [] })
        }),
        /does not cover the report's executed mutant set/u
    );
});

test('terminal collections reject omitted planned mutants and overlapping status membership', () =>
{
    const value = authority(report([
        mutant({ line: 1 }),
        mutant({ line: 2, replacement: 'return value - 2;' }),
        mutant({ line: 3, replacement: 'return value - 3;' }),
        mutant({ status: 'Survived', line: 2, replacement: 'return value * 2;' })
    ]));
    const collections = Object.fromEntries([
        'plannedMutantIds',
        'executedMutantIds',
        'compileErrorMutantIds',
        'ignoredMutantIds',
        'noCoverageMutantIds',
        'killedMutantIds',
        'survivedMutantIds',
        'timeoutMutantIds',
        'executedTestIds'
    ].map((name) => [name, [...value[name]]]));

    collections.killedMutantIds.pop();
    assert.throws(
        () => validateInventoryCollections(value.inventory, collections),
        /killedMutantIds/u
    );

    collections.killedMutantIds = [...value.killedMutantIds];
    collections.survivedMutantIds.push(value.killedMutantIds[0]);
    assert.throws(
        () => validateInventoryCollections(value.inventory, collections),
        /survivedMutantIds/u
    );
});

test('actual mutated source must match configuration', () =>
{
    const wrongFile = report();
    wrongFile.files['Other.cs'] = wrongFile.files['Algorithms/AedsEncoder.cs'];
    delete wrongFile.files['Algorithms/AedsEncoder.cs'];
    assert.throws(() => authority(wrongFile), /outside configured mutate scope/u);
});

test('actual mutants must remain inside configured end-exclusive line regions', () =>
{
    const regionalConfig = structuredClone(config);
    regionalConfig['stryker-config'].mutate = ['Algorithms/AedsEncoder.cs{1..3}'];
    assert.doesNotThrow(() => authority(report([
        mutant({ line: 1 }),
        mutant({ line: 2, replacement: 'return value - 2;' })
    ]), regionalConfig));
    assert.throws(
        () => authority(report([mutant({ line: 3 })]), regionalConfig),
        /outside configured mutate scope/u
    );
});

test('report validation retains the executed-mutant gate', () =>
{
    assert.throws(
        () => validateStrykerReport(report([
            mutant({ status: 'Ignored', line: 1 }),
            mutant({ status: 'CompileError', line: 2 })
        ])),
        /must execute at least one mutant/u
    );
});

test('critical mutation lane enables trace logging and passes trace plus source root to authority generation', () =>
{
    const legacy = readFileSync(
        new URL('../../tools/test/lanes/_suite-support.sh', import.meta.url),
        'utf8'
    );
    const matrix = readFileSync(new URL('../matrix.yml', import.meta.url), 'utf8');
    const tier = matrix.match(
        /^\s+- id: release-mutation-critical-slice\n(?<body>[\s\S]*?)(?=^\s+- id:)/mu
    )?.groups?.body ?? '';

    assert.match(legacy, /--log-to-file/u);
    assert.match(legacy, /--verbosity/u);
    assert.match(legacy, /--trace-log/u);
    assert.match(legacy, /--source-root/u);
    assert.match(legacy, /src\/core/u);
    assert.match(tier, /\.tmp\/mutation\/backend-critical\/authority\.json/u);
});
