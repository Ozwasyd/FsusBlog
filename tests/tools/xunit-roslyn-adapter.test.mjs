import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { exerciseXunitConfigurationFixture } from './support/xunit-configuration-fixture.mjs';
import { exerciseXunitProjectGraphFixture } from './support/xunit-project-graph-fixture.mjs';

const repositoryRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const { buildOracleFacts } = await import(pathToFileURL(
    path.join(repositoryRoot, 'tools/test-quality/oracle-facts.mjs')
).href);
const fixtureProject = path.join(
    repositoryRoot,
    'tools/test-inventory/xunit-roslyn-adapter/fixtures/AdapterFixtureTests/AdapterFixtureTests.csproj'
);
const adapterProjectDir = path.join(repositoryRoot, 'tools/test-inventory/xunit-roslyn-adapter');
const adapterProject = path.join(adapterProjectDir, 'FsusBlog.XunitRoslynAdapter.csproj');
const migrationProject = path.join(repositoryRoot, 'tests/migration/FsusBlog.Migration.Tests.csproj');
const productionBuildRoot = mkdtempSync(path.join(os.tmpdir(), 'fsus-xunit-adapter-build-'));
const adapterEnvironment = {
    ...process.env,
    FSUSBLOG_PRODUCTION_BUILD_ROOT: productionBuildRoot
};
const relocatedAdapterExecutable = path.join(
    productionBuildRoot,
    'dotnet/FsusBlog.XunitRoslynAdapter/bin/Debug/net10.0/FsusBlog.XunitRoslynAdapter'
);
const relocatedAdapterAssembly = `${relocatedAdapterExecutable}.dll`;

function buildAdapter()
{
    execFileSync('dotnet', ['build', adapterProject, '-v:q'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: adapterEnvironment,
        stdio: 'pipe'
    });
    execFileSync('dotnet', ['build', fixtureProject, '-v:q'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: adapterEnvironment,
        stdio: 'pipe'
    });
    assert.equal(existsSync(relocatedAdapterExecutable), true, 'adapter build must honor the isolated output root');
}

function runAdapter(project = fixtureProject)
{
    const stdout = execFileSync('dotnet', [
        'run',
        '--project',
        adapterProject,
        '--no-build',
        '--no-launch-profile',
        '--',
        repositoryRoot,
        project
    ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: adapterEnvironment,
        maxBuffer: 128 * 1024 * 1024
    });
    return JSON.parse(stdout);
}

function casesForMethod(report, methodName)
{
    return report.testCases.filter((testCase) => testCase.methodName === methodName);
}

function factsOf(report, methodName)
{
    return report.testCases.find((testCase) => testCase.methodName === methodName)?.methodFacts ?? {};
}

buildAdapter();
let projectGraphEvidence;
function getProjectGraphEvidence()
{
    return projectGraphEvidence ??= exerciseXunitProjectGraphFixture({
        repositoryRoot,
        adapterAssembly: relocatedAdapterAssembly,
        buildRoot: productionBuildRoot
    });
}
test.after(() => rmSync(productionBuildRoot, { recursive: true, force: true }));

test('xunit configuration binds references, constants, generated sources and exact build outputs', async () =>
{
    const evidence = await exerciseXunitConfigurationFixture({
        repositoryRoot,
        adapterAssembly: relocatedAdapterAssembly
    });
    for (const [name, expectedMethods] of [
        ['debug', ['DebugCase', 'DebugIncludedCase', 'GeneratedCase', 'LinkedCase', 'SharedCase']],
        ...['release', 'releaseIgnoresDebugGenerated', 'restoredRelease',
            'releaseIgnoresUnownedGenerated', 'restoredLinkedSource'].map((name) =>
            [name, ['GeneratedCase', 'LinkedCase', 'ReleaseCase', 'ReleaseIncludedCase', 'SharedCase']])
    ])
    {
        assert.equal(evidence[name].status, 0, JSON.stringify(evidence[name]));
        assert.deepEqual(evidence[name].report.diagnostics, []);
        assert.deepEqual(evidence[name].report.testCases.map((entry) => entry.methodName).sort(), expectedMethods);
        assert.equal(evidence[name].report.testCases.some((entry) =>
            ['ExcludedCase', 'ForeignDependencyCase'].includes(entry.methodName)), false);
        assert.equal(casesForMethod(evidence[name].report, 'LinkedCase')[0].ownerFile, 'linked/LinkedCases.cs');
    }
    assert.deepEqual(evidence.defaultConfiguration.report, evidence.debug.report);
    assert.equal(
        casesForMethod(evidence.debug.report, 'SharedCase')[0].id,
        casesForMethod(evidence.release.report, 'SharedCase')[0].id
    );
    for (const result of evidence.invalidArguments)
    {
        assert.equal(result.status, 2, JSON.stringify(result));
        assert.equal(result.report, null);
        assert.match(result.stderr, /usage:/u);
    }
    assert.equal(evidence.debugRejectsInvalidGenerated.status, 1);
    assert.deepEqual(evidence.debugRejectsInvalidGenerated.report.testCases, []);
    assert.match(evidence.debugRejectsInvalidGenerated.report.diagnostics[0].message, /wrong configuration source/u);
    for (const name of ['missingReleaseAssembly', 'missingReleaseIntermediate'])
    {
        assert.equal(evidence[name].status, 1, JSON.stringify(evidence[name]));
        assert.deepEqual(evidence[name].report.testCases, []);
        assert.equal(evidence[name].report.diagnostics[0].code, 'xunit-compile-context-unavailable');
        assert.match(evidence[name].report.diagnostics[0].message, /Release build output or intermediate context is missing/u);
    }
    assert.equal(evidence.missingLinkedSource.status, 1);
    assert.deepEqual(evidence.missingLinkedSource.report.testCases, []);
    assert.equal(evidence.missingLinkedSource.report.diagnostics[0].code, 'xunit-compile-context-unavailable');
    assert.match(evidence.missingLinkedSource.report.diagnostics[0].message, /LinkedCases\.cs/u);
});

test('xunit Roslyn adapter extracts Fact, InlineData Theory, MemberData, ClassData and nested/partial/generic owners', () =>
{
    const report = runAdapter();
    assert.equal(report.schema, 'fsusblog.test-inventory.xunit-roslyn.v1');
    assert.equal(report.adapterVersion, 'xunit.v2');
    assert.equal(report.diagnostics.filter((entry) => entry.severity === 'error').length, 0);

    const facts = casesForMethod(report, 'PlainFact_ReturnsExpectedValue');
    assert.equal(facts.length, 1);
    assert.equal(facts[0].kind, 'fact');
    assert.equal(facts[0].identity, 'static');

    const inline = casesForMethod(report, 'SumTheory_IsCommutative');
    assert.equal(inline.length, 2);
    assert.ok(inline.every((testCase) => testCase.kind === 'theory-inline' && testCase.identity === 'static'));
    assert.match(inline[0].displayName, /case 0/);
    assert.notEqual(inline[0].id, inline[1].id);

    const member = casesForMethod(report, 'MemberDataTheory_IsDynamic');
    assert.equal(member.length, 1);
    assert.equal(member[0].identity, 'dynamic');
    assert.equal(member[0].kind, 'theory-member-data');
    assert.match(member[0].dynamicCaseInfo.generationLocation, /member-data:Rows/);

    const classData = casesForMethod(report, 'ClassDataTheory_IsDynamic');
    assert.equal(classData.length, 1);
    assert.equal(classData[0].identity, 'dynamic');
    assert.match(classData[0].dynamicCaseInfo.generationLocation, /class-data:FsusBlog\.AdapterFixture\.CustomData/);
    assert.ok(classData[0].dynamicCaseInfo.inventoryObligation.includes('runtime inventory'));

    const nested = casesForMethod(report, 'NestedFact_IsOwnedByNestedClass');
    assert.equal(nested.length, 1);
    assert.match(nested[0].ownerSuite, /StructureTests\.NestedTests/);
    assert.equal(nested[0].ownerClass, 'NestedTests');

    const partial = casesForMethod(report, 'OuterPartialFact_IsExtracted');
    assert.equal(partial.length, 1);
    assert.match(partial[0].ownerSuite, /StructureTests/);
    assert.equal(casesForMethod(report, 'SecondPartialFact_IsExtracted').length, 1);
    assert.equal(casesForMethod(report, 'GenericFact_IsExtracted').length, 1);

    assert.equal(report.testCases.filter((testCase) => testCase.identity === 'dynamic').length, 2);
    assert.equal(report.testCases.filter((testCase) => testCase.identity === 'static').length, 21);
});

function migrationCompileContext()
{
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', [
        "import { xunitTestProjects } from './tools/test-inventory/adapters.mjs';",
        "import { readXunitProjectContext } from './tools/test-inventory/discovery.mjs';",
        "console.log(JSON.stringify(readXunitProjectContext(process.cwd(), xunitTestProjects.find(p => p.directory === 'tests/migration'))));"
    ].join('\n')], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: adapterEnvironment
    }));
}

function buildMigration()
{
    execFileSync('dotnet', ['build', migrationProject, '--configuration', 'Debug', '--nologo', '--verbosity', 'quiet'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: adapterEnvironment,
        stdio: 'pipe'
    });
    return migrationCompileContext();
}

test('xunit migration discovery binds its independent real compile context and all 22 DDL cases', () =>
{
    const context = buildMigration();
    assert.ok(context.output.startsWith(`${productionBuildRoot}${path.sep}`));
    assert.ok(context.sources.includes('tests/migration/SchemaMigrationDdlPrimitivesTests.cs'));
    assert.ok(context.sources.every((source) => source.startsWith('tests/migration/')));
    const report = runAdapter(migrationProject);
    assert.equal(report.diagnostics.filter((entry) => entry.severity === 'error').length, 0);
    const cases = report.testCases.filter((entry) => entry.ownerFile === 'tests/migration/SchemaMigrationDdlPrimitivesTests.cs');
    assert.equal(cases.length, 22);
    assert.ok(cases.every((entry) => entry.ownerSuite === 'FsusBlog.Migration.Tests.SchemaMigrationDdlPrimitivesTests'));
    assert.equal(new Set(cases.map((entry) => entry.id)).size, 22);
    assert.equal(report.testCases.some((entry) => entry.ownerFile.startsWith('tests/backend/')), false);
});

test('xunit migration compile context rejects a missing actual build output without a fallback', () =>
{
    const { output } = buildMigration();
    const heldOutput = `${output}.task-held`;
    renameSync(output, heldOutput);
    try
    {
        assert.throws(() => migrationCompileContext(), /xunit project build output is missing for tests\/migration/u);
    }
    finally
    {
        renameSync(heldOutput, output);
    }
});

test('xunit migration Roslyn adapter rejects a missing real project reference and emits no cases', () =>
{
    buildMigration();
    const references = JSON.parse(execFileSync('dotnet', [
        'msbuild', migrationProject, '-target:ResolveReferences', '-getItem:ReferencePath',
        '-verbosity:quiet', '/p:BuildProjectReferences=false'
    ], { cwd: repositoryRoot, encoding: 'utf8', env: adapterEnvironment }));
    const reference = references.Items.ReferencePath.find((item) => path.basename(item.FullPath) === 'FsusBlog.Migration.dll')?.FullPath;
    assert.ok(reference?.startsWith(`${productionBuildRoot}${path.sep}`), 'only the task-owned actual migration compile reference may be withheld');
    const heldReference = `${reference}.task-held`;
    renameSync(reference, heldReference);
    try
    {
        const result = spawnSync('dotnet', [relocatedAdapterAssembly, repositoryRoot, migrationProject], {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: adapterEnvironment,
            maxBuffer: 64 * 1024 * 1024
        });
        assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
        const report = JSON.parse(result.stdout);
        assert.deepEqual(report.testCases, []);
        assert.ok(report.diagnostics.some((entry) => entry.severity === 'error' && /reference|semantic|ResolveReferences/iu.test(entry.message)));
    }
    finally
    {
        renameSync(heldReference, reference);
    }
});

test('traits merge with method-level override and skip/platform/fixture metadata is captured', () =>
{
    const report = runAdapter();

    const override = casesForMethod(report, 'TraitMerge_MethodWins')[0];
    const traits = Object.fromEntries(override.traits.map((trait) => [trait.name, trait.value]));
    assert.equal(traits.Category, 'Override');
    assert.equal(traits.Layer, 'method-level');
    assert.equal(traits.Platform, 'linux');
    assert.equal(override.category, 'Override');
    assert.equal(override.platform, 'linux');

    const skipped = casesForMethod(report, 'SkippedFact_CarriesReason')[0];
    assert.equal(skipped.skipReason, 'not ready');

    const fixtureCase = casesForMethod(report, 'FixtureFact_CarriesFixture')[0];
    assert.match(fixtureCase.fixture, /SharedFixture/);
});

test('raw strings, lambdas and local functions do not create false xUnit cases and helpers are not tests', () =>
{
    const report = runAdapter();
    assert.equal(casesForMethod(report, 'RawString_AttributeText_IsNotATest').length, 1);
    assert.equal(casesForMethod(report, 'Lambda_And_LocalFunction_DoNotCreateCases').length, 1);
    assert.equal(casesForMethod(report, 'NotATest_HelperMethod').length, 0);
    assert.equal(report.testCases.some((testCase) => testCase.methodName === 'FakeMethod' || testCase.methodName === 'FakeTheory'), false);
});

test('test-to-test symbol calls are resolved and assembly kinds classify test vs framework vs bcl', () =>
{
    const report = runAdapter();
    const caller = casesForMethod(report, 'CallsOtherTest_CarriesSymbolRelation')[0];
    const invocation = caller.methodFacts.invocations.find((entry) => entry.methodName === 'PlainFactTarget');
    assert.ok(invocation, 'test-to-test invocation must be recorded');
    assert.equal(invocation.callsTestMethod, true);
    assert.match(invocation.calledTestMethodId, /PlainFactTarget/);
    assert.equal(invocation.assemblyKind, 'test');

    const facts = factsOf(report, 'PlainFact_ReturnsExpectedValue');
    assert.ok(facts.assertionCandidates.some((entry) => entry.methodName === 'Equal' && entry.assemblyKind === 'test-framework'));
    assert.ok(report.testCases.every((testCase) => testCase.methodFacts.invocations.every((entry) => entry.assemblyKind !== '')));
});

test('real xunit adapter spans preserve source operands through the oracle consumer', () =>
{
    const report = runAdapter();
    assert.equal(report.diagnostics.filter((entry) => entry.severity === 'error').length, 0);
    const sourceFiles = [...new Set(report.testCases.map((item) => item.ownerFile))].map((file) => ({
        path: file,
        kind: 'discoverable-test',
        sourceDigest: 'sha256:' + createHash('sha256')
            .update(readFileSync(path.join(repositoryRoot, file))).digest('hex')
    }));
    const facts = buildOracleFacts({
        adapterVersion: report.adapterVersion,
        inventoryDigest: 'sha256:' + createHash('sha256').update(JSON.stringify(report)).digest('hex'),
        sourceFiles,
        testCases: report.testCases,
        diagnostics: report.diagnostics
    }, { root: repositoryRoot });
    const actual = [
        'PlainFact_ReturnsExpectedValue',
        'ExpressionBodiedFact_RetainsAssertion'
    ].map((methodName) =>
    {
        const testCase = casesForMethod(report, methodName)[0];
        assert.ok(testCase, methodName);
        const oracle = facts.cases.find((item) => item.testId === testCase.id);
        const equality = oracle.assertions.find((item) => item.apiId === 'xunit:Equal');
        assert.ok(equality, methodName);
        return {
            methodName,
            actual: equality.actual?.text,
            expected: equality.expected?.text,
            operator: equality.operator
        };
    });
    assert.deepEqual(actual, [
        { methodName: 'PlainFact_ReturnsExpectedValue', actual: 'Add(2, 2)', expected: '4', operator: 'equality' },
        { methodName: 'ExpressionBodiedFact_RetainsAssertion', actual: 'Add(2, 2)', expected: '4', operator: 'equality' }
    ]);
});

test('expression-bodied assertions and test forwarders retain executable oracle ownership', () =>
{
    const report = runAdapter();
    const direct = factsOf(report, 'ExpressionBodiedFact_RetainsAssertion');
    assert.ok(direct.assertionCandidates.some((entry) => entry.methodName === 'Equal'));
    assert.deepEqual(direct.returnStatements, ['Assert.Equal(4, Add(2, 2))']);

    const forwarder = factsOf(report, 'ExpressionBodiedForwarder_CarriesAssertionRelation');
    assert.equal(forwarder.assertionCandidates.length, 0);
    assert.ok(forwarder.invocations.some((entry) => (
        entry.methodName === 'PlainFactTarget' && entry.callsTestMethod === true
    )));

    const helperCaller = factsOf(report, 'AssertionHelperCaller_CarriesTransitiveOracle');
    assert.ok(helperCaller.assertionCandidates.some((entry) => entry.methodName === 'AssertExpectedValue'));
});

test('compile or semantic model failure fails closed instead of falling back to regex', () =>
{
    const root = path.join(repositoryRoot, 'tools/test-inventory/xunit-roslyn-adapter/fixtures');
    assert.throws(() => execFileSync('dotnet', [
        'run',
        '--project',
        adapterProject,
        '--no-build',
        '--no-launch-profile',
        '--',
        root,
        '/does/not/exist.csproj'
    ], {
        cwd: root,
        encoding: 'utf8',
        env: adapterEnvironment,
        stdio: 'pipe'
    }), /test project not found|fail closed/u);
});

test('real xunit project graph rejects a stale lock then regenerates, builds and inventories current sources', () =>
{
    getProjectGraphEvidence();
    assert.notEqual(projectGraphEvidence.staleLockedRestore.status, 0);
    assert.match(projectGraphEvidence.staleLockedRestore.output, /NU1004|lock file is inconsistent/iu);
    assert.equal(projectGraphEvidence.regeneratedRestoreStatus, 0);
    assert.equal(projectGraphEvidence.currentLockedRestoreStatus, 0);
    assert.equal(projectGraphEvidence.buildStatus, 0);
    assert.equal(
        projectGraphEvidence.currentInventory.status,
        0,
        JSON.stringify(projectGraphEvidence.currentInventory.errorDiagnostics)
    );
    assert.ok(projectGraphEvidence.currentInventory.testCaseCount > 0);
    assert.deepEqual(projectGraphEvidence.currentInventory.errorDiagnostics, []);
    const currentBackend = runAdapter(path.join(repositoryRoot, 'tests/backend/FsusBlog.Server.Tests.csproj'));
    assert.deepEqual(currentBackend.diagnostics.filter((entry) => entry.severity === 'error'), []);
    assert.equal(currentBackend.testCases.filter((entry) => (
        entry.ownerFile === 'tests/backend/Unit/CurrentSchemaRuntimeRollupTablesTests.cs'
        && entry.methodName === 'RuntimeRollupCatalog_MatchesPostCodeFirstMigrationDdl'
    )).length, 1, 'the actual current backend report must retain the runtime-rollup DDL regression');
});

test('xunit Roslyn adapter fails closed on stale static member CS0117 after the last build', () =>
{
    getProjectGraphEvidence();
    assert.equal(projectGraphEvidence.cs0117.status, 1);
    assert.equal(projectGraphEvidence.cs0117.report.testCases.length, 0);
    const diagnostic = projectGraphEvidence.cs0117.report.diagnostics.find((entry) => (
        entry.code === 'xunit-semantic-model-incomplete'
    ));
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /CS0117/u);
});

test('xunit Roslyn adapter fails closed on stale instance member CS1061 after the last build', () =>
{
    getProjectGraphEvidence();
    assert.equal(projectGraphEvidence.cs1061.status, 1);
    assert.equal(projectGraphEvidence.cs1061.report.testCases.length, 0);
    const diagnostic = projectGraphEvidence.cs1061.report.diagnostics.find((entry) => (
        entry.code === 'xunit-semantic-model-incomplete'
    ));
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /CS1061/u);
});

test('custom GeneratedRegexAttribute cannot suppress a missing partial implementation', () =>
{
    getProjectGraphEvidence();
    assert.equal(projectGraphEvidence.shadowGeneratedRegex.status, 1);
    assert.equal(projectGraphEvidence.shadowGeneratedRegex.report.testCases.length, 0);
    const diagnostic = projectGraphEvidence.shadowGeneratedRegex.report.diagnostics.find((entry) => (
        entry.code === 'xunit-semantic-model-incomplete'
    ));
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /CS8795/u);
});

test('framework GeneratedRegexAttribute with an invalid method signature fails closed', () =>
{
    getProjectGraphEvidence();
    assert.equal(projectGraphEvidence.invalidGeneratedRegexSignature.status, 1);
    assert.equal(projectGraphEvidence.invalidGeneratedRegexSignature.report.testCases.length, 0);
    const diagnostic = projectGraphEvidence.invalidGeneratedRegexSignature.report.diagnostics.find((entry) => (
        entry.code === 'xunit-semantic-model-incomplete'
    ));
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /CS8795/u);
});

test('valid GeneratedRegex declaration cannot suppress an accompanying compiler error', () =>
{
    getProjectGraphEvidence();
    assert.equal(projectGraphEvidence.generatedRegexWithOtherError.status, 1);
    assert.equal(projectGraphEvidence.generatedRegexWithOtherError.report.testCases.length, 0);
    const diagnostic = projectGraphEvidence.generatedRegexWithOtherError.report.diagnostics.find((entry) => (
        entry.code === 'xunit-semantic-model-incomplete'
    ));
    assert.ok(diagnostic);
    assert.doesNotMatch(diagnostic.message, /CS8795/u);
    assert.match(diagnostic.message, /CS0117/u);
});

test('GeneratedRegex method with a ref return fails closed', () =>
{
    getProjectGraphEvidence();
    assert.equal(projectGraphEvidence.refGeneratedRegex.status, 1);
    assert.equal(projectGraphEvidence.refGeneratedRegex.report.testCases.length, 0);
    const diagnostic = projectGraphEvidence.refGeneratedRegex.report.diagnostics.find((entry) => (
        entry.code === 'xunit-semantic-model-incomplete'
    ));
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /CS8818/u);
});

test('GeneratedRegex method with a ref readonly return fails closed', () =>
{
    getProjectGraphEvidence();
    assert.equal(projectGraphEvidence.refReadonlyGeneratedRegex.status, 1);
    assert.equal(projectGraphEvidence.refReadonlyGeneratedRegex.report.testCases.length, 0);
    const diagnostic = projectGraphEvidence.refReadonlyGeneratedRegex.report.diagnostics.find((entry) => (
        entry.code === 'xunit-semantic-model-incomplete'
    ));
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /CS8818/u);
});

test('invalid GeneratedRegex pattern fails closed through the real framework generator', () =>
{
    getProjectGraphEvidence();
    assert.equal(projectGraphEvidence.invalidGeneratedRegexPattern.status, 1);
    assert.equal(projectGraphEvidence.invalidGeneratedRegexPattern.report.testCases.length, 0);
    const diagnostic = projectGraphEvidence.invalidGeneratedRegexPattern.report.diagnostics.find((entry) => (
        entry.code === 'xunit-semantic-model-incomplete'
    ));
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /SYSLIB1042/u);
});

test('invalid GeneratedRegex timeout fails closed through the real framework generator', () =>
{
    getProjectGraphEvidence();
    assert.equal(projectGraphEvidence.invalidGeneratedRegexTimeout.status, 1);
    assert.equal(projectGraphEvidence.invalidGeneratedRegexTimeout.report.testCases.length, 0);
    const diagnostic = projectGraphEvidence.invalidGeneratedRegexTimeout.report.diagnostics.find((entry) => (
        entry.code === 'xunit-semantic-model-incomplete'
    ));
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /SYSLIB1042/u);
});

test('test output cannot shadow a target reference-pack assembly by simple name', () =>
{
    getProjectGraphEvidence();
    assert.equal(projectGraphEvidence.sameNameMetadataShadow.status, 1);
    assert.equal(projectGraphEvidence.sameNameMetadataShadow.report.testCases.length, 0);
    const diagnostic = projectGraphEvidence.sameNameMetadataShadow.report.diagnostics.find((entry) => (
        entry.code === 'xunit-compile-context-unavailable'
    ));
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /shadows MSBuild target reference-pack identity System\.Text\.RegularExpressions/u);
});

test('same-strong-name assembly copied from an old-pack path cannot shadow the evaluated reference', () =>
{
    getProjectGraphEvidence();
    assert.equal(projectGraphEvidence.sameStrongNameOldPackShadow.status, 1);
    assert.equal(projectGraphEvidence.sameStrongNameOldPackShadow.report.testCases.length, 0);
    const diagnostic = projectGraphEvidence.sameStrongNameOldPackShadow.report.diagnostics.find((entry) => (
        entry.code === 'xunit-compile-context-unavailable'
    ));
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /shadows MSBuild target reference-pack identity System\.Text\.RegularExpressions/u);
});

test('multi-pack wrong DOTNET_ROOT cannot replace the MSBuild-evaluated targeting pack', () =>
{
    getProjectGraphEvidence();
    assert.equal(
        projectGraphEvidence.wrongDotnetRootInventory.status,
        0,
        JSON.stringify(projectGraphEvidence.wrongDotnetRootInventory.report.diagnostics)
    );
    assert.equal(projectGraphEvidence.wrongDotnetRootInventory.report.testCases.length > 0, true);
    assert.deepEqual(projectGraphEvidence.wrongDotnetRootInventory.report.diagnostics, []);
});

test('runtime xUnit discovery matches static inventory on statically expandable cases', () =>
{
    const listed = execFileSync(
        'dotnet',
        ['test', fixtureProject, '--list-tests', '--no-build', '-v:q'],
        {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: adapterEnvironment,
            maxBuffer: 16 * 1024 * 1024
        }
    );
    const runtimeTests = listed.split(/\r?\n/u).filter((line) => /^\s{2,}[A-Za-z_].*$/u.test(line)).length;
    const report = runAdapter();
    const staticallyExpandable = report.testCases.filter((testCase) => (
        testCase.identity === 'static'
    || testCase.kind === 'theory-inline'
    ));
    assert.ok(runtimeTests >= staticallyExpandable.length, `runtime=${runtimeTests} static=${staticallyExpandable.length}`);
});

test('same fixture input produces byte-stable adapter reports', () =>
{
    const first = runAdapter();
    const second = runAdapter();
    assert.equal(JSON.stringify(first), JSON.stringify(second));
});
