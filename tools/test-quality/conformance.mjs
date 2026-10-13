import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildOracleFacts } from './oracle-facts.mjs';
import { evaluateQuality, loadQualityPolicy } from './policy.mjs';
import { contentDigest } from './schema.mjs';

export const CONFORMANCE_SCHEMA = 'fsusblog.test-quality-conformance.v1';

const corpusRoot = 'tests/fixtures/test-quality-corpus';

function digest(value)
{
    return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function write(root, relative, source)
{
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
}

function runJson(command, args, cwd)
{
    const stdout = execFileSync(command, args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024
    });
    return JSON.parse(stdout);
}

function sourceFileRecord(file, adapter, source)
{
    return {
        path: file,
        adapter,
        adapterVersion: `${adapter}.conformance.v1`,
        kind: 'discoverable-test',
        sourceDigest: digest(source),
        declaredBy: ['directory'],
        caseIdentity: {
            mode: 'static',
            owner: `${adapter}-adapter`,
            extractionStatus: 'ready',
            inventoryObligation: 'conformance adapter must emit every fixture case'
        }
    };
}

function prepareFixtureRoot(repositoryRoot)
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsus-test-quality-corpus-'));
    const mappings = [
        ['sources/vitest.fixture.txt', 'tests/frontend/unit/quality.test.ts', 'vitest'],
        ['sources/security.fixture.txt', 'tests/frontend/unit/security-quality.test.ts', 'vitest'],
        ['sources/node.fixture.txt', 'tests/tools/quality.test.mjs', 'node-test'],
        ['sources/playwright.fixture.txt', 'tests/frontend/e2e/quality.spec.ts', 'playwright'],
        ['sources/shell-structured.fixture.txt', 'tools/test/shell-structured.sh', 'shell'],
        ['sources/shell-exit-only.fixture.txt', 'tools/test/shell-exit-only.sh', 'shell']
    ];
    const sourceFiles = [];
    const sourceByPath = new Map();
    for (const [sourceRelative, target, adapter] of mappings)
    {
        const source = readFileSync(path.join(repositoryRoot, corpusRoot, sourceRelative), 'utf8');
        write(root, target, source);
        sourceFiles.push(sourceFileRecord(target, adapter, source));
        sourceByPath.set(target, source);
    }
    write(root, 'src/subject.ts', 'export const load = () => 2\nexport const reject = () => { throw new Error("rejected") }\n');
    write(root, 'src/subject.mjs', 'export const load = () => 2\nexport const reject = () => { throw new Error("rejected") }\n');
    write(root, 'tools/test/child.mjs', 'process.exitCode = 0\n');
    const xunitSource = readFileSync(path.join(repositoryRoot, corpusRoot, 'sources/xunit.fixture.txt'), 'utf8');
    write(root, 'tests/xunit/QualityCorpusTests.cs', xunitSource);
    sourceFiles.push(sourceFileRecord('tests/xunit/QualityCorpusTests.cs', 'xunit', xunitSource));
    sourceByPath.set('tests/xunit/QualityCorpusTests.cs', xunitSource);
    write(root, 'tests/xunit/QualityCorpusTests.csproj', [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <PropertyGroup>',
        '    <TargetFramework>net10.0</TargetFramework>',
        '    <Nullable>enable</Nullable>',
        '    <IsTestProject>true</IsTestProject>',
        '    <EnableNETAnalyzers>false</EnableNETAnalyzers>',
        '  </PropertyGroup>',
        '  <ItemGroup>',
        '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.5.1" />',
        '    <PackageReference Include="xunit" Version="2.9.3" />',
        '    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.5" PrivateAssets="all" />',
        '    <PackageReference Include="FluentAssertions" Version="7.2.0" />',
        '  </ItemGroup>',
        '</Project>',
        ''
    ].join('\n'));
    return { root, sourceFiles, sourceByPath };
}

function adapterCases(repositoryRoot, fixture)
{
    const tsRequest = path.join(fixture.root, 'ts-request.json');
    writeFileSync(tsRequest, JSON.stringify({
        root: fixture.root,
        files: fixture.sourceFiles.filter((file) => ['vitest', 'node-test', 'playwright'].includes(file.adapter))
    }));
    const tsReport = runJson(
        process.execPath,
        ['tools/test-inventory/ts-ast-adapter/index.mjs', tsRequest],
        repositoryRoot
    );
    const nativeRequest = path.join(fixture.root, 'native-request.json');
    writeFileSync(nativeRequest, JSON.stringify({
        root: fixture.root,
        files: fixture.sourceFiles.filter((file) => file.adapter === 'shell'),
        matrixTiers: []
    }));
    const nativeReport = runJson(
        process.execPath,
        ['tools/test-inventory/native-entry-adapter/index.mjs', nativeRequest],
        repositoryRoot
    );

    const adapterProject = path.join(repositoryRoot, 'tools/test-inventory/xunit-roslyn-adapter/FsusBlog.XunitRoslynAdapter.csproj');
    const fixtureProject = path.join(fixture.root, 'tests/xunit/QualityCorpusTests.csproj');
    execFileSync('dotnet', ['build', fixtureProject, '--nologo', '--verbosity', 'quiet'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    execFileSync('dotnet', ['build', adapterProject, '--nologo', '--verbosity', 'quiet'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    const xunitReport = runJson('dotnet', [
        'run',
        '--project',
        adapterProject,
        '--no-build',
        '--no-launch-profile',
        '--',
        fixture.root,
        fixtureProject
    ], repositoryRoot);
    const selectedXunit = xunitReport.testCases.filter((testCase) => (
        [
            'XunitExactState',
            'FluentExactState',
            'CustomAssertionHelper',
            'EmptyMaskedBySibling',
            'TestToTestWrapper',
            'ForwarderTarget',
            'StaticParameterizedCases'
        ].includes(testCase.methodName)
    ));
    for (const testCase of selectedXunit)
    {
        if (!fixture.sourceByPath.has(testCase.ownerFile))
        {
            const source = readFileSync(path.join(repositoryRoot, testCase.ownerFile), 'utf8');
            fixture.sourceByPath.set(testCase.ownerFile, source);
            fixture.sourceFiles.push(sourceFileRecord(testCase.ownerFile, 'xunit', source));
        }
    }
    const diagnostics = [...(tsReport.diagnostics ?? []), ...(nativeReport.diagnostics ?? []), ...(xunitReport.diagnostics ?? [])]
        .filter((item) => item.severity === 'error');
    if (diagnostics.length > 0)
    {
        throw new Error(`conformance adapter failed closed: ${diagnostics.map((item) => `${item.code}: ${item.message}`).join('; ')}`);
    }
    return [...tsReport.testCases, ...nativeReport.testCases, ...selectedXunit];
}

function canonicalInventory(fixture, testCases)
{
    const sourceFiles = fixture.sourceFiles
        .filter((sourceFile, index, values) => values.findIndex((item) => item.path === sourceFile.path) === index)
        .sort((left, right) => left.path.localeCompare(right.path));
    const inventory = {
        schema: 'fsusblog.test-inventory.v1',
        adapterVersion: 'fsusblog.test-quality-conformance.adapters.v1',
        inventoryDigest: '',
        sourceState: { commit: '0'.repeat(40), worktreeFingerprint: '0'.repeat(64) },
        discoverySources: { directories: [corpusRoot], toolsDirectories: [], matrixTiers: [], coverageEntries: [], requirementProfiles: [] },
        sourceFiles,
        testCases: testCases.sort((left, right) => left.id.localeCompare(right.id)),
        suiteRecords: [],
        diagnostics: []
    };
    inventory.inventoryDigest = digest(JSON.stringify({ sourceFiles, testCases: inventory.testCases }));
    return inventory;
}

function selectExpectedCases(result, facts, manifest)
{
    const resultByName = new Map(result.cases.map((item) => [
        facts.cases.find((fact) => fact.testId === item.testId)?.displayName,
        item
    ]));
    const factsByName = new Map(facts.cases.map((item) => [item.displayName, item]));
    return manifest.fixtures.map((expected) =>
    {
        const actual = resultByName.get(expected.displayName);
        const fact = factsByName.get(expected.displayName);
        if (!actual || !fact)
        {
            throw new Error(`conformance fixture was not emitted by an adapter: ${expected.displayName}; available=${[...resultByName.entries()].map(([name, item]) => `${name}=${item.testId}`).join(',')}`);
        }
        return {
            displayName: expected.displayName,
            testId: actual.testId,
            expectedTestId: expected.testId ?? actual.testId,
            sourceSpan: fact.sourceSpan,
            expectedOutcome: expected.expectedOutcome,
            actualOutcome: actual.outcome,
            expectedRules: expected.expectedRules.toSorted(),
            actualRules: actual.violations.map((item) => item.ruleId).toSorted(),
            expectedLine: expected.expectedLine
        };
    });
}

function assertCorpusResults(cases)
{
    for (const item of cases)
    {
        if (item.actualOutcome !== item.expectedOutcome)
        {
            throw new Error(`${item.displayName} outcome ${item.actualOutcome} != ${item.expectedOutcome}; rules=${item.actualRules.join(',')}`);
        }
        if (JSON.stringify(item.actualRules) !== JSON.stringify(item.expectedRules))
        {
            throw new Error(`${item.displayName} rules ${item.actualRules.join(',')} != ${item.expectedRules.join(',')}`);
        }
        if (item.sourceSpan.start.line !== item.expectedLine)
        {
            throw new Error(`${item.displayName} source line ${item.sourceSpan.start.line} != ${item.expectedLine}`);
        }
        if (item.testId !== item.expectedTestId)
        {
            throw new Error(`${item.displayName} test ID ${item.testId} != ${item.expectedTestId}`);
        }
    }
}

function mutationSensitivity(cases, mutations)
{
    const kills = [];
    const expectFailure = (mutation, mutate) =>
    {
        const changed = structuredClone(cases);
        mutate(changed);
        try
        {
            assertCorpusResults(changed);
        }
        catch
        {
            kills.push(mutation);
            return;
        }
        throw new Error(`conformance mutation survived: ${mutation}`);
    };
    const byName = (items, name) => items.find((item) => item.displayName === name);
    const dropRule = (items, name, rule) =>
    {
        const item = byName(items, name);
        item.actualRules = item.actualRules.filter((candidate) => candidate !== rule);
    };
    expectFailure('drop-zero-outcome-rule', (items) =>
    {
        byName(items, 'vitest empty masked case').actualRules = [];
    });
    expectFailure('drop-constant-rule', (items) =>
    {
        byName(items, 'vitest constant self proof').actualRules = [];
    });
    expectFailure('drop-early-return-rule', (items) => dropRule(items, 'vitest early return', 'TQ-EARLY-RETURN'));
    expectFailure('drop-unreachable-rule', (items) => dropRule(items, 'vitest unreachable oracle', 'TQ-UNREACHABLE-ORACLE'));
    expectFailure('drop-test-to-test-rule', (items) => dropRule(items, 'QualityCorpusTests.TestToTestWrapper', 'TQ-TEST-TO-TEST'));
    expectFailure('drop-worker-rule', (items) => dropRule(items, 'node empty worker', 'TQ-DISCOVERABLE-WORKER'));
    expectFailure('drop-self-compare-rule', (items) => dropRule(items, 'vitest cache name mismatch', 'TQ-SELF-COMPARE'));
    expectFailure('drop-uninformative-rule', (items) => dropRule(items, 'vitest uninformative measurement', 'TQ-UNINFORMATIVE-ORACLE'));
    expectFailure('drop-actual-as-expected-rule', (items) => dropRule(items, 'vitest cache name mismatch', 'TQ-ACTUAL-AS-EXPECTED'));
    expectFailure('drop-contract-rule', (items) => dropRule(items, 'vitest cache name mismatch', 'TQ-CONTRACT-ORACLE'));
    expectFailure('drop-http-only-rule', (items) => dropRule(items, 'security http only', 'TQ-HTTP-200-ONLY-CRITICAL'));
    expectFailure('drop-snapshot-only-rule', (items) => dropRule(items, 'security snapshot only', 'TQ-SNAPSHOT-ONLY-CRITICAL'));
    expectFailure('drop-unresolved-rule', (items) => dropRule(items, 'vitest early return', 'TQ-UNRESOLVED-FACTS'));
    expectFailure('accept-file-level-mask', (items) =>
    {
        const item = byName(items, 'vitest empty masked case');
        item.actualOutcome = 'passed';
        item.actualRules = [];
    });
    expectFailure('treat-unresolved-as-passed', (items) =>
    {
        byName(items, 'vitest early return').actualOutcome = 'passed';
    });
    expectFailure('remove-symbol-resolution', (items) =>
    {
        const item = byName(items, 'node assert equal');
        item.actualOutcome = 'failed';
        item.actualRules = ['TQ-ZERO-OUTCOME'];
    });
    expectFailure('delete-violation', (items) =>
    {
        byName(items, 'vitest cache name mismatch').actualRules.pop();
    });
    expectFailure('change-case-id', (items) =>
    {
        byName(items, 'node assert match').testId += '-changed';
    });
    expectFailure('change-source-span', (items) =>
    {
        byName(items, 'playwright exact state').sourceSpan.start.line += 1;
    });
    const expected = mutations.toSorted();
    if (JSON.stringify(kills.toSorted()) !== JSON.stringify(expected))
    {
        throw new Error(`mutation table mismatch: killed ${kills.join(',')}; expected ${expected.join(',')}`);
    }
    return kills.sort();
}

export function runConformanceCorpus(repositoryRoot)
{
    const manifestPath = path.join(repositoryRoot, corpusRoot, 'manifest.json');
    const manifestSource = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestSource);
    if (manifest.schema !== 'fsusblog.test-quality-conformance-corpus.v1')
    {
        throw new Error('test-quality conformance manifest schema is invalid');
    }
    const fixture = prepareFixtureRoot(repositoryRoot);
    try
    {
        const testCases = adapterCases(repositoryRoot, fixture);
        const inventory = canonicalInventory(fixture, testCases);
        const structuredShell = testCases.find((testCase) => testCase.displayName === 'shell-structured.sh');
        const runtimeEvidenceByTestId = new Map(structuredShell ? [[structuredShell.id, {
            status: 'verified',
            receiptDigest: digest('structured-shell-receipt'),
            caseIds: [structuredShell.id]
        }]] : []);
        const facts = buildOracleFacts(inventory, {
            sourceReader: (file) => fixture.sourceByPath.get(file),
            runtimeEvidenceByTestId
        });
        const policy = loadQualityPolicy(repositoryRoot);
        const result = evaluateQuality({ inventory, oracleFacts: facts, policy });
        const cases = selectExpectedCases(result, facts, manifest);
        assertCorpusResults(cases);
        const killedMutations = mutationSensitivity(cases, manifest.mutations);
        const artifact = {
            schema: CONFORMANCE_SCHEMA,
            corpusVersion: manifest.version,
            adapterVersion: inventory.adapterVersion,
            analyzerVersion: facts.analyzerVersion,
            policyVersion: policy.version,
            manifestDigest: digest(manifestSource),
            inventoryDigest: inventory.inventoryDigest,
            oracleFactsDigest: facts.contentDigest,
            qualityDigest: result.contentDigest,
            cases,
            killedMutations,
            contentDigest: ''
        };
        artifact.contentDigest = contentDigest(artifact);
        return artifact;
    }
    finally
    {
        rmSync(fixture.root, { recursive: true, force: true });
    }
}

// Read-only replay of the conformance result's owner rules. Physical adapter
// execution belongs to the producer; release binding never reruns it.
export function verifyConformanceArtifact(repositoryRoot, artifact)
{
    const source = readFileSync(path.join(repositoryRoot, corpusRoot, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(source);
    if (artifact?.schema !== CONFORMANCE_SCHEMA || artifact.contentDigest !== contentDigest(artifact)
        || artifact.manifestDigest !== digest(source) || artifact.corpusVersion !== manifest.version)
    {
        throw new Error('conformance schema/digest/current corpus mismatch');
    }
    assertCorpusResults(artifact.cases);
    if (!Array.isArray(artifact.cases) || artifact.cases.length !== manifest.fixtures.length)
    {
        throw new Error('conformance case set mismatch');
    }
    for (const expected of manifest.fixtures)
    {
        const matches = artifact.cases.filter((item) => item.displayName === expected.displayName);
        if (matches.length !== 1)
        {
            throw new Error('missing/duplicate conformance fixture');
        }
        const actual = matches[0];
        if (actual.expectedOutcome !== expected.expectedOutcome
            || actual.expectedLine !== expected.expectedLine
            || (expected.testId && actual.expectedTestId !== expected.testId)
            || JSON.stringify(actual.expectedRules) !== JSON.stringify(expected.expectedRules.toSorted()))
        {
            throw new Error('conformance expectations differ from the canonical corpus');
        }
    }
    const mutations = mutationSensitivity(artifact.cases, manifest.mutations);
    if (JSON.stringify(mutations) !== JSON.stringify(artifact.killedMutations))
    {
        throw new Error('conformance mutation replay mismatch');
    }
    return artifact;
}
