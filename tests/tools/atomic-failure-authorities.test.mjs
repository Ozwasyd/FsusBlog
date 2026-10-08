import assert from 'node:assert/strict';
import test from 'node:test';

const { analyzeExecutableAuthorityMaterial, inspectPackageScriptMaterial,
    inspectWorkflowCommandMaterial } = await import(new URL('../../tools/test-matrix/atomic-failure/executable-authorities.mjs', import.meta.url));
import { atomicFixture, hostLimits } from './support/atomic-failure-fixture.mjs';

test('launch ownership catches shell, Node loop and wrapper hidden authorities with precise migration location', () =>
{
    const fixture = atomicFixture();
    const input = { graph: fixture.graph, launches: fixture.launches };
    assert.equal(analyzeExecutableAuthorityMaterial(input, hostLimits).accepted, true);
    input.launches.push({ ...structuredClone(input.launches[0]), childId: 'second-check',
        location: { path: 'tools/wrapper.ts', line: 14, column: 5 } });
    const analysis = analyzeExecutableAuthorityMaterial(input, hostLimits);
    assert.equal(analysis.accepted, false);
    const finding = analysis.findings.find((entry) => entry.location.path === 'tools/wrapper.ts');
    assert.equal(finding.code, 'hidden-executable-authorities');
    assert.deepEqual(finding.hiddenChildIds, ['failure-a-command', 'second-check']);
    assert.equal(finding.owner, 'fixture-owner');
    assert.equal(finding.migrationEntry, 'fixture-entry');
});

for (const mutation of ['continue-on-error', 'ignore-exit', 'catch-and-continue', 'reset-attempt', 'dynamic', 'summary', 'wrong-owner'])
{
    test(`launch analysis refuses ${mutation}`, () =>
    {
        const fixture = atomicFixture();
        const launch = fixture.launches[0];
        if (mutation === 'dynamic')
        {
            launch.dynamic = true;
        }
        else if (mutation === 'summary')
        {
            launch.parentId = launch.producerId = 'settled-summary';
        }
        else if (mutation === 'wrong-owner')
        {
            launch.producerId = 'failure-b';
        }
        else
        {
            launch.failureMode = mutation;
        }
        assert.equal(analyzeExecutableAuthorityMaterial({ graph: fixture.graph, launches: fixture.launches }, hostLimits).accepted, false);
    });
}

test('tool descendants need exact owner/output proof and no independent test/evidence IDs', () =>
{
    const fixture = atomicFixture();
    const launch = { ...structuredClone(fixture.launches[0]), role: 'tool-descendant', childId: 'testhost',
        location: { path: 'tools/compiler.ts', line: 10, column: 5 }, descendantProof: {
            ownerCommandDigest: `sha256:${'a'.repeat(64)}`, childCommandDigest: `sha256:${'b'.repeat(64)}`,
            purpose: 'framework-owned-testhost', outputOwner: 'failure-a', testIds: [], evidenceIds: [], proofTestId: 'owned-descendant-proof' } };
    const input = { graph: fixture.graph, launches: [...fixture.launches, launch] };
    assert.equal(analyzeExecutableAuthorityMaterial(input, hostLimits).accepted, true);
    launch.descendantProof.evidenceIds = ['independent-check'];
    assert.equal(analyzeExecutableAuthorityMaterial(input, hostLimits).accepted, false);
    launch.descendantProof = null;
    assert.equal(analyzeExecutableAuthorityMaterial(input, hostLimits).accepted, false);
});

test('package analysis expands quoted literal nested scripts and exposes independent fan-out', () =>
{
    const result = inspectPackageScriptMaterial({ scripts: { all: 'npm run a && npm run b',
        a: 'node "tools/check a.mjs"', b: 'node tools/check-b.mjs' }, description: 'docs mention check-a; check-b' }, hostLimits);
    assert.deepEqual(result.scripts.find((entry) => entry.scriptId === 'all').commands,
        [['node', 'tools/check a.mjs'], ['node', 'tools/check-b.mjs']]);
    assert.equal(result.scripts.length, 3);
});

for (const source of ['node a.mjs || true; node b.mjs', 'set +e; node a.mjs; node b.mjs',
    'run-p a b', 'npm-run-all a b', 'node "$COMMAND"', 'npm run missing', 'npm run a'])
{
    test(`finite package source analysis refuses unsupported/swallowed source: ${source}`, () =>
    {
        assert.throws(() => inspectPackageScriptMaterial({ scripts: { a: source } }, hostLimits));
    });
}

test('actual YAML extraction exposes multiple run steps, fail-fast default and continue-on-error', () =>
{
    const source = 'jobs:\n    checks:\n        strategy:\n            matrix:\n                shard: [a, b]\n        steps:\n            - run: node tools/check-a.mjs\n            - run: node tools/check-b.mjs\n              continue-on-error: true\n';
    const result = inspectWorkflowCommandMaterial(source, '.github/workflows/example.yml', hostLimits);
    assert.equal(result.jobs[0].commands.length, 2);
    assert.equal(result.jobs[0].failureSwallowed, true);
    assert.equal(result.jobs[0].failFast, true);
});
