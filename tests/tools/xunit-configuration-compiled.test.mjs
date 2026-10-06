import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { exerciseXunitConfigurationFixture } from './support/xunit-configuration-fixture.mjs';

const { productionDotnetArtifacts, resolveProductionBuildLayout } = await import(new URL('../../tools/test-matrix/production-build-layout.mjs', import.meta.url));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function casesForMethod(report, methodName)
{
    return report.testCases.filter((entry) => entry.methodName === methodName);
}

test('xunit configuration binds references, constants, generated sources and exact build outputs', async () =>
{
    const layout = resolveProductionBuildLayout({ root: repositoryRoot, runId: process.env.FSUSBLOG_TEST_RUN_ID });
    const evidence = await exerciseXunitConfigurationFixture({
        repositoryRoot,
        adapterAssembly: productionDotnetArtifacts(layout).xunitAdapterDll
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
