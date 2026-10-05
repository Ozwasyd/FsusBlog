import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { reconcileMigrationTestCases, reconcileMigrationTrx } from '../../tools/test/migration-execution-evidence.mjs';

// Original #3524 pure discovery/TRX cases only. These fixtures are not runtime,
// build, service, source/run receipt or qualification evidence.
function fixture()
{
    const ownerFile = 'tests/migration/ExampleTests.cs';
    const ownerSuite = 'Example.Migration.ExampleTests';
    const assemblyFile = path.resolve('fixture-build/FsusBlog.Migration.Tests.dll');
    const specifications = [
        { methodName: 'Fact', ordinal: 0, displayName: `${ownerSuite}.Fact` },
        { methodName: 'Theory', ordinal: 0, displayName: `${ownerSuite}.Theory(value: 1)` },
        { methodName: 'Theory', ordinal: 1, displayName: `${ownerSuite}.Theory(value: 2)` }
    ];
    const inventoryCases = specifications.map(({ methodName, ordinal }) => ({
        adapter: 'xunit',
        identity: 'static',
        ownerFile,
        ownerClass: 'ExampleTests',
        ownerSuite,
        methodName,
        id: `xunit:${ownerFile}#${ownerSuite}.${methodName}#case-${String(ordinal).padStart(4, '0')}`
    }));
    const discoveredCases = specifications.map(({ methodName, displayName }, index) => ({
        id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
        fullyQualifiedName: `${ownerSuite}.${methodName}`,
        displayName,
        source: assemblyFile,
        traits: {}
    }));
    return {
        assemblyFile,
        sourceFiles: [{ path: ownerFile, adapter: 'xunit' }],
        inventoryCases,
        discoveredCases,
        executedCases: discoveredCases.map((entry) => ({
            testId: entry.id,
            testName: entry.displayName,
            outcome: 'Passed'
        }))
    };
}

function boundTrx(input)
{
    const attribute = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const records = input.discoveredCases.map((record, index) => ({
        ...record,
        executionId: `11111111-1111-1111-1111-${String(index + 1).padStart(12, '0')}`
    }));
    const results = records.map((record) => `<UnitTestResult testId="${record.id}" executionId="${record.executionId}" testName="${attribute(record.displayName)}" outcome="Passed" />`);
    const definitions = records.map((record) => `<UnitTest id="${record.id}" name="${attribute(record.displayName)}" storage="${attribute(record.source.toLowerCase())}">
<Execution id="${record.executionId}" />
<TestMethod codeBase="${attribute(record.source)}" adapterTypeName="executor://xunit/VsTestRunner3/netcore/" className="${record.fullyQualifiedName.slice(0, record.fullyQualifiedName.lastIndexOf('.'))}" name="${record.fullyQualifiedName.slice(record.fullyQualifiedName.lastIndexOf('.') + 1)}" />
</UnitTest>`);
    const entries = records.map((record) => `<TestEntry testId="${record.id}" executionId="${record.executionId}" />`);
    return `<TestRun id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa">
<Results>${results.join('\n')}</Results>
<TestDefinitions>${definitions.join('\n')}</TestDefinitions>
<TestEntries>${entries.join('\n')}</TestEntries>
<ResultSummary outcome="Completed"><Counters total="3" executed="3" passed="3" failed="0" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0" /></ResultSummary>
</TestRun>`;
}

test('Migration TRX joins exact assembly, method, adapter and execution identities using the shared reader', () =>
{
    const input = fixture();
    const result = reconcileMigrationTrx({ ...input, trx: boundTrx(input) });
    assert.equal(result.trxRunId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    assert.equal(result.executionIds.length, 3);
    assert.equal(new Set(result.executionIds).size, 3);
    assert.deepEqual(result.sourceCaseIds, input.inventoryCases.map((entry) => entry.id).sort());
    assert.equal(Object.hasOwn(result, 'qualificationEligible'), false);
});

test('Migration TRX rejects foreign assemblies, methods, adapters and inconsistent execution bindings', () =>
{
    const input = fixture();
    const trx = boundTrx(input);
    const mutations = [
        (value) => value.replace('<TestRun id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"', '<TestRun id="unknown"'),
        (value) => value.replace(/<TestDefinitions>[\s\S]*?<\/TestDefinitions>/u, ''),
        (value) => value.replace(/<TestEntries>[\s\S]*?<\/TestEntries>/u, ''),
        (value) => value.replace('</TestDefinitions>', '</TestDefinitions><TestDefinitions></TestDefinitions>'),
        (value) => value.replace(/<UnitTest\b[\s\S]*?<\/UnitTest>/u, ''),
        (value) => value.replace(/(<UnitTest\b[\s\S]*?<\/UnitTest>)/u, '$1$1'),
        (value) => value.replace(/<TestEntry\b[^>]*\/>/u, ''),
        (value) => value.replace(/(<TestEntry\b[^>]*\/>)/u, '$1$1'),
        (value) => value.replace(/<Execution\b[^>]*\/>/u, ''),
        (value) => value.replace(/(<Execution\b[^>]*\/>)/u, '$1$1'),
        (value) => value.replace(/<TestMethod\b[^>]*\/>/u, ''),
        (value) => value.replace(/(<TestMethod\b[^>]*\/>)/u, '$1$1'),
        (value) => value.replace(/codeBase="[^"]*"/u, 'codeBase="/foreign/FsusBlog.Server.Tests.dll"'),
        (value) => value.replace(/storage="[^"]*"/u, 'storage="/foreign/fsusblog.server.tests.dll"'),
        (value) => value.replace(/adapterTypeName="[^"]*"/u, 'adapterTypeName="foreign-adapter"'),
        (value) => value.replace(/className="[^"]*"/u, 'className="Foreign.Project.Tests"'),
        (value) => value.replace(/(<TestMethod\b[^>]* name=)"[^"]*"/u, '$1"ForeignMethod"'),
        (value) => value.replace(/executionId="[^"]*"/u, 'executionId="22222222-2222-2222-2222-222222222222"'),
        (value) => value.replace(/(<Execution id=)"[^"]*"/u, '$1"22222222-2222-2222-2222-222222222222"'),
        (value) => value.replace(/(<TestEntry\b[^>]* executionId=)"[^"]*"/u, '$1"22222222-2222-2222-2222-222222222222"'),
        (value) => value.replaceAll('11111111-1111-1111-1111-000000000002', '11111111-1111-1111-1111-000000000001'),
        (value) => value.replace(/(<UnitTest id=)"[^"]*"/u, '$1"33333333-3333-3333-3333-333333333333"'),
        (value) => value.replace(/(<UnitTest\b[^>]* name=)"[^"]*"/u, '$1"Wrong display name"'),
        (value) => value.replace('outcome="Passed"', 'outcome="NotExecuted"'),
        (value) => value.replace('failed="0"', 'failed="1"')
    ];
    for (const [index, mutate] of mutations.entries())
    {
        const corrupted = mutate(trx);
        assert.notEqual(corrupted, trx, `mutation ${index} must change the fixture`);
        assert.throws(() => reconcileMigrationTrx({ ...input, trx: corrupted }),
            /TRX|migration execution/iu, `mutation ${index} must fail closed`);
    }
});

test('Migration evidence reconciles independent assembly, fully-qualified methods and every theory row', () =>
{
    const input = fixture();
    const before = structuredClone(input);
    const result = reconcileMigrationTestCases(input);
    assert.equal(result.project, 'tests/migration/FsusBlog.Migration.Tests.csproj');
    assert.equal(result.assembly, input.assemblyFile);
    assert.deepEqual(result.sourceCaseIds, input.inventoryCases.map((entry) => entry.id).sort());
    assert.deepEqual(result.executedCaseIds, input.discoveredCases.map((entry) => entry.id).sort());
    assert.deepEqual(result.methods.map((entry) => [
        entry.method, entry.sourceCaseIds.length, entry.runtimeCaseIds.length
    ]), [
        ['Example.Migration.ExampleTests.Fact', 1, 1],
        ['Example.Migration.ExampleTests.Theory', 2, 2]
    ]);
    assert.equal(Object.hasOwn(result, 'qualificationEligible'), false);
    assert.deepEqual(input, before);
});

test('Migration evidence rejects missing inputs, wrong assembly and unknown source ownership', () =>
{
    const mutations = [
        (input) =>
        {
            input.assemblyFile = path.resolve('fixture-build/FsusBlog.Server.Tests.dll');
        },
        (input) =>
        {
            input.assemblyFile = 'FsusBlog.Migration.Tests.dll';
        },
        (input) =>
        {
            input.inventoryCases = [];
        },
        (input) =>
        {
            input.discoveredCases = [];
        },
        (input) =>
        {
            input.executedCases = [];
        },
        (input) =>
        {
            input.sourceFiles = null;
        },
        (input) =>
        {
            input.sourceFiles = [];
        },
        (input) =>
        {
            input.sourceFiles[0].adapter = 'xunit-support';
        },
        (input) =>
        {
            input.inventoryCases[0].ownerFile = 'tests/backend/ExampleTests.cs';
        },
        (input) =>
        {
            input.inventoryCases[0].ownerFile = 'tests/migration/MySqlDdlFixture.cs';
        },
        (input) =>
        {
            input.inventoryCases[0].ownerSuite = 'Another.Namespace.ExampleTests';
        },
        (input) =>
        {
            input.inventoryCases[0].id = 'foreign-id';
        },
        (input) =>
        {
            input.inventoryCases[0].adapter = 'node-test';
        },
        (input) =>
        {
            input.inventoryCases[0].identity = 'dynamic';
        },
        (input) =>
        {
            input.inventoryCases.push(input.inventoryCases[0]);
        }
    ];
    for (const mutate of mutations)
    {
        const input = fixture();
        mutate(input);
        assert.throws(() => reconcileMigrationTestCases(input), /migration execution/u);
    }
});

test('Migration evidence rejects discovery omissions, duplicates, foreign methods and source drift', () =>
{
    const mutations = [
        (input) =>
        {
            input.discoveredCases.pop();
        },
        (input) =>
        {
            input.discoveredCases.shift();
        },
        (input) =>
        {
            input.discoveredCases[0].id = 'not-a-runtime-id';
        },
        (input) =>
        {
            input.discoveredCases[0].id = input.discoveredCases[1].id;
        },
        (input) =>
        {
            input.discoveredCases[0].source = path.resolve('other-run/FsusBlog.Migration.Tests.dll');
        },
        (input) =>
        {
            input.discoveredCases[0].source = 'FsusBlog.Migration.Tests.dll';
        },
        (input) =>
        {
            input.discoveredCases[0].fullyQualifiedName = 'Example.Server.ExampleTests.Fact';
        },
        (input) =>
        {
            input.discoveredCases[0].displayName = '';
        },
        (input) =>
        {
            input.discoveredCases.push({ ...input.discoveredCases[1], id: '00000000-0000-0000-0000-000000000004' });
        }
    ];
    for (const mutate of mutations)
    {
        const input = fixture();
        mutate(input);
        assert.throws(() => reconcileMigrationTestCases(input), /migration execution/u);
    }
});

test('Migration evidence rejects missing, repeated, unplanned, renamed and non-passing TRX rows', () =>
{
    const mutations = [
        (input) =>
        {
            input.executedCases.pop();
        },
        (input) =>
        {
            input.executedCases.push(input.executedCases[0]);
        },
        (input) =>
        {
            input.executedCases[0].testId = '00000000-0000-0000-0000-000000000099';
        },
        (input) =>
        {
            input.executedCases[0].testName = input.discoveredCases[1].displayName;
        },
        (input) =>
        {
            input.executedCases[0].outcome = 'Failed';
        },
        (input) =>
        {
            input.executedCases[0].outcome = 'NotExecuted';
        },
        (input) =>
        {
            input.executedCases[0].outcome = 'Skipped';
        },
        (input) =>
        {
            input.executedCases[0].outcome = null;
        }
    ];
    for (const mutate of mutations)
    {
        const input = fixture();
        mutate(input);
        assert.throws(() => reconcileMigrationTestCases(input), /migration execution/u);
    }
});
