import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { buildPublicRuntimeDeclarations, verifyPublicRuntimeCommandParity, verifyPublicRuntimeDeclarations } = await import(new URL('../../tools/test/public-runtime-producers/declarations.mjs', import.meta.url));

const shell = fs.readFileSync(new URL('../../tools/test/lanes/_suite-support.sh', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../../src/frontend/package.json', import.meta.url), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(new URL('../../config/testing/runtime-scenario-catalog.json', import.meta.url), 'utf8'));

function functionSource(name)
{
    return shell.slice(shell.indexOf(`${name}() {`)).split('\n}\n')[0];
}

test('release declarations preserve all nine original commands, environment targets and unique write barrier', () =>
{
    const plan = buildPublicRuntimeDeclarations('release-public');
    const children = plan.nodes.filter((node) => node.kind === 'correctness');
    assert.equal(children.length, 9);
    const source = functionSource('RunReleaseOnly').replaceAll(/\\\n\s*/gu, ' ');
    for (const node of children)
    {
        assert.ok(source.includes(node.execution.command.join(' ')), node.id);
        assert.deepEqual(node.dependsOn, ['release-public-hydration']);
        assert.equal(node.stateAccessRef, null);
        assert.deepEqual(node.attemptPolicy, { policyId: 'correctness-first-attempt', attemptNumber: 1, allowedRetries: 0 });
    }
    assert.equal(children[0].execution.target, 'preview');
    assert.ok(children.slice(1).every((node) => node.execution.target === 'backend'));
    assert.equal(children[7].execution.environment.FSUSBLOG_REQUIRE_PUBLIC_HYDRATION_ARTIFACTS, '1');
    assert.ok(manifest.scripts['check:public-seo-smoke']);
    assert.ok(!children.some((node) => /browser-contract|diagnostics|playwright/u.test(node.id)));
    assert.equal(plan.nodes.at(-1).execution, null);
    assert.deepEqual(plan.nodes.at(-1).settledDependsOn, children.map((node) => node.id));
});

test('resilience derives six executable scenarios including live notification from the sole catalog', () =>
{
    const plan = buildPublicRuntimeDeclarations('resilience');
    const children = plan.nodes.filter((node) => node.kind === 'correctness');
    const executable = catalog.scenarios.filter((scenario) => scenario.phase === 'resilience' && scenario.executor !== 'fixture-only');
    assert.equal(children.length, 6);
    assert.deepEqual(children.map((node) => node.execution.scenario), executable);
    assert.ok(children.some((node) => node.execution.scenario.id === 'resilience.post-notification-live'));
    assert.ok(!children.some((node) => /reset-pollution|fault-injection/u.test(node.id)));
    for (const node of children)
    {
        assert.ok(node.requiredAuthorities.includes(`reset:${node.execution.scenario.resetBarrier}`));
        assert.ok(node.requiredAuthorities.includes('host-health-state-postflight'));
        assert.equal(node.stateAccessRef, null);
    }
});

test('load declarations retain measurement authority, commands and noise paths with a settled reset', () =>
{
    const plan = buildPublicRuntimeDeclarations('load');
    const [first, reset, second, summary] = plan.nodes;
    const source = functionSource('RunLoadOnly');
    for (const node of [first, second])
    {
        assert.equal(node.execution.owner, 'RunInClientMeasurement');
        assert.equal(node.execution.measurementWindowId, node.id);
        assert.ok(source.includes(node.execution.command.join(' ')));
        assert.ok(source.includes(node.execution.noiseEvidencePath));
        assert.ok(manifest.scripts[node.execution.command[2]]);
        assert.ok(node.requiredAuthorities.includes('quiescence-lease'));
    }
    assert.deepEqual(reset.settledDependsOn, [first.id]);
    assert.ok(!reset.dependsOn.includes(first.id));
    assert.deepEqual(second.dependsOn, [reset.id]);
    assert.deepEqual(summary.settledDependsOn, [first.id, reset.id, second.id]);
});

test('local and CI consumers get byte-identical DATA_ONLY declarations without ambient target overrides', () =>
{
    const original = process.env.FSUSBLOG_BASE_URL;
    try
    {
        const first = buildPublicRuntimeDeclarations('load');
        process.env.FSUSBLOG_BASE_URL = 'http://other-candidate.invalid';
        const second = buildPublicRuntimeDeclarations('load');
        assert.deepEqual(first, second);
        assert.equal(first.authority, 'DATA_ONLY');
        assert.equal(first.qualificationEligible, false);
        assert.equal(verifyPublicRuntimeDeclarations(first).contentDigest, first.contentDigest);
    }
    finally
    {
        if (original === undefined)
        {
            delete process.env.FSUSBLOG_BASE_URL;
        }
        else
        {
            process.env.FSUSBLOG_BASE_URL = original;
        }
    }
});

test('resealed command, dependency, policy, mutating-as-reader and Browser Contract drift are rejected', () =>
{
    const original = buildPublicRuntimeDeclarations('release-public');
    for (const mutate of [
        (plan) =>
        {
            plan.nodes[0].execution.command.push('--skip');
        },
        (plan) =>
        {
            plan.nodes[0].dependsOn = [];
        },
        (plan) =>
        {
            plan.nodes[0].attemptPolicy.allowedRetries = 1;
        },
        (plan) =>
        {
            plan.nodes[0].stateAccessRef = 'read-only';
        },
        (plan) =>
        {
            plan.nodes.push({ id: 'browser-contract' });
        },
        (plan) =>
        {
            plan.sources[0].digest = `sha256:${'0'.repeat(64)}`;
        }
    ])
    {
        const changed = structuredClone(original);
        mutate(changed);
        assert.throws(() => verifyPublicRuntimeDeclarations(sealContentDigest(changed)), /mismatch/u);
    }
    assert.throws(() => buildPublicRuntimeDeclarations('fault-injection'), /unsupported/u);
});

test('extra legacy child commands and changed measurement thresholds fail source parity closed', () =>
{
    const release = buildPublicRuntimeDeclarations('release-public');
    assert.throws(() => verifyPublicRuntimeCommandParity('release-public', shell.replace(
        'RunInClient node ../../tests/frontend/checks/public/aot-regression.mjs',
        'RunInClient node ../../tests/frontend/checks/public/aot-regression.mjs\n    RunInClient npm run check:extra-reader'
    ), release.nodes), /command membership/u);
    const load = buildPublicRuntimeDeclarations('load');
    assert.throws(() => verifyPublicRuntimeCommandParity('load', shell.replace(
        'npm run check:load:public-api', 'npm run check:load:public-api -- --rounds=1'
    ), load.nodes), /command membership/u);
});
