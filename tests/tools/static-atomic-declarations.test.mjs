import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { staticAtomicDeclarations, staticAtomicProducer } = await import(new URL('../../tools/test/static-atomic/declarations.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');

test('static declarations preserve all thirteen commands and existing assertion identities', () =>
{
    const declarations = staticAtomicDeclarations(root);
    assert.equal(declarations.producers.length, 13);
    assert.equal(declarations.summaries[0].settledDependsOn.length, 6);
    assert.equal(declarations.summaries[1].settledDependsOn.length, 7);
    const source = fs.readFileSync(path.join(root, 'tools/test/lanes/_suite-support.sh'), 'utf8');
    for (const producer of declarations.producers)
    {
        assert.equal(producer.allowedRetries, 0);
        assert.equal(producer.retryPolicyId, 'correctness-first-attempt');
        assert.equal(producer.phase, 'static');
        if (producer.packageScript)
        {
            assert.ok(source.includes(producer.packageScript), producer.id);
        }
        else
        {
            assert.ok(source.includes(path.posix.basename(producer.command.at(-1))), producer.id);
        }
    }
    const registry = JSON.parse(fs.readFileSync(path.join(root,
        'tests/fixtures/evidence-projection/cross-stack-assertion-ownership.json'), 'utf8'));
    const expected = registry.assertions.filter(entry => ['cross-stack-static', 'security-static'].includes(entry.canonicalOwner));
    const actual = declarations.producers.flatMap(entry => entry.assertionBindings);
    assert.deepEqual(actual.map(entry => entry.id).sort(), expected.map(entry => entry.id).sort());
    for (const entry of actual)
    {
        assert.deepEqual(entry, expected.find(candidate => candidate.id === entry.id));
    }
    assert.equal(declarations.membershipStatus, 'owner-confirmation-required');
});

test('auth static command stays separate from runtime auth-zero-probe and combined package script', () =>
{
    const declarations = staticAtomicDeclarations(root);
    const auth = staticAtomicProducer(declarations, 'cross-stack-auth-state-coherence');
    assert.deepEqual(auth.command, ['node', '../../tests/frontend/checks/runtime/auth-state-coherence.mjs']);
    assert.equal(auth.assertionBindings.some(entry => entry.id === 'auth-zero-probe'), false);
    assert.throws(() => staticAtomicProducer(declarations, 'cross-stack-runtime'), /unknown static/);
    const changed = structuredClone(declarations);
    changed.producers[0].command = ['true'];
    assert.throws(() => staticAtomicProducer(changed, changed.producers[0].id), /digest mismatch/);
});

test('network, resource and true prerequisite contracts do not inherit frontend install/build', () =>
{
    const declarations = staticAtomicDeclarations(root);
    for (const producer of declarations.producers)
    {
        assert.equal(producer.prerequisites.includes('frontend-install'), false);
        assert.equal(producer.prerequisites.includes('backend-build'), false);
        assert.ok(producer.resources.minCpuUnits > 0);
        assert.equal(producer.network, producer.id === 'security-supply-chain-audit' ? 'policy-bound' : 'denied');
    }
    const sbom = staticAtomicProducer(declarations, 'security-sbom');
    assert.equal(sbom.prerequisites.includes('nuget-restore'), false);
    assert.ok(sbom.prerequisites.includes('dependency-locks'));
    const audit = staticAtomicProducer(declarations, 'security-supply-chain-audit');
    assert.ok(audit.prerequisites.includes('nuget-restore'));
    assert.ok(audit.prerequisites.includes('supply-chain-network-policy'));
    assert.equal(staticAtomicProducer(declarations, 'security-matrices').canonicalExecutionOwner,
        'frontend-static-governance/security-matrices');
    for (const summary of declarations.summaries)
    {
        assert.equal(summary.command, null);
        assert.deepEqual(summary.dependsOn, []);
    }
    assert.equal(staticAtomicDeclarations(root).contentDigest, declarations.contentDigest);
});
