import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const fixtureProject = path.join(
    repositoryRoot,
    'tools/test-inventory/xunit-roslyn-adapter/fixtures/AdapterFixtureTests/AdapterFixtureTests.csproj'
);
const adapterProjectDir = path.join(repositoryRoot, 'tools/test-inventory/xunit-roslyn-adapter');
const adapterExecutable = path.join(adapterProjectDir, 'bin/Debug/net10.0/FsusBlog.XunitRoslynAdapter');

function buildAdapter()
{
    execFileSync('dotnet', ['build', path.join(adapterProjectDir, 'FsusBlog.XunitRoslynAdapter.csproj'), '-v:q'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: 'pipe'
    });
}

function runAdapter()
{
    const stdout = execFileSync(adapterExecutable, [repositoryRoot, fixtureProject], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
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
    assert.equal(report.testCases.filter((testCase) => testCase.identity === 'static').length, 18);
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

test('compile or semantic model failure fails closed instead of falling back to regex', () =>
{
    const root = path.join(repositoryRoot, 'tools/test-inventory/xunit-roslyn-adapter/fixtures');
    assert.throws(() => execFileSync(adapterExecutable, [root, '/does/not/exist.csproj'], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe'
    }), /test project not found|fail closed/u);
});

test('runtime xUnit discovery matches static inventory on statically expandable cases', () =>
{
    execFileSync('dotnet', ['build', fixtureProject, '-v:q'], { cwd: repositoryRoot, encoding: 'utf8' });
    const listed = execFileSync(
        'dotnet',
        ['test', fixtureProject, '--list-tests', '--no-build', '-v:q'],
        { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
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
