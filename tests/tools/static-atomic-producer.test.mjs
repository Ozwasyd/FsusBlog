import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { runStaticAtomicProducer } = await import(new URL('../../tools/test/static-atomic/producer.mjs', import.meta.url));
const { staticAtomicFixture } = await import(new URL('./support/static-atomic-fixture.mjs', import.meta.url));

test('each leaf creates one actual attempt and rejects a second launch in the same run', async t =>
{
    const fixture = staticAtomicFixture(t, ['cross-stack-distribution-coherence']);
    const producer = fixture.declarations.producers[0];
    const child = await fixture.run(producer);
    const receipt = JSON.parse(fs.readFileSync(path.join(fixture.evidenceRoot, child.attemptPath), 'utf8'));
    assert.equal(receipt.attemptNumber, 1);
    assert.equal(receipt.maxAttempts, 1);
    assert.equal(receipt.status, 'failed-no-retry');
    assert.equal(receipt.exitCode, 17);
    assert.equal(receipt.firstFailure, true);
    assert.deepEqual(receipt.command, producer.command);
    assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(path.join(fixture.evidenceRoot, child.attemptPath))), 'attempt-2')), false);
    await assert.rejects(fixture.run(producer), /EEXIST/);
});

test('undeclared network, missing policy and mismatched input/environment bindings reject before spawn', async t =>
{
    for (const [producerId, override] of [
        ['security-supply-chain-audit', { network: 'denied' }],
        ['security-supply-chain-audit', { networkPolicyDigest: null }],
        ['security-sbom', { network: 'policy-bound' }],
        ['security-sbom', { networkEnforced: false }],
        ['cross-stack-auth-state-coherence', { inputClosureDigest: `sha256:${'9'.repeat(64)}` }],
        ['cross-stack-auth-state-coherence', { environmentDigest: `sha256:${'9'.repeat(64)}` }],
        ['security-domain-layout', { prerequisiteSetDigest: `sha256:${'9'.repeat(64)}` }]
    ])
    {
        const fixture = staticAtomicFixture(t);
        const producer = fixture.declarations.producers.find(entry => entry.id === producerId);
        await assert.rejects(fixture.run(producer, override), /execution envelope/);
        assert.equal(fs.existsSync(fixture.evidenceRoot), false);
    }
});

test('runner cannot accept caller command/retry overrides or skip the original network controls', async t =>
{
    const fixture = staticAtomicFixture(t);
    const producer = fixture.declarations.producers.find(entry => entry.id === 'security-domain-layout');
    fixture.admit(producer);
    const result = await runStaticAtomicProducer({
        repositoryRoot: fixture.root, producerId: producer.id, inputClosureDigest: fixture.inputClosureDigest,
        context: { ...fixture.identity, env: fixture.env, evidenceRoot: fixture.evidenceRoot,
            authorityReferences: fixture.references(producer.id), verifyAuthority: fixture.verifyAuthority,
            command: ['false'], retryPolicyId: 'diagnostic-infrastructure-retry' }
    });
    assert.deepEqual(result.attempts[0].command, producer.command);
    assert.equal(result.attempts[0].retryPolicyId, 'correctness-first-attempt');
    assert.equal(result.attempts[0].status, 'clean-success');
    const network = fixture.declarations.producers.find(entry => entry.id === 'security-network-baseline');
    await assert.rejects(runStaticAtomicProducer({
        repositoryRoot: fixture.root, producerId: network.id, inputClosureDigest: fixture.inputClosureDigest,
        context: { env: { ...fixture.env, FSUSBLOG_SKIP_PRODUCTION_EXPOSURE_TOOL_TEST: '1' } }
    }), /cannot skip/);
});

test('unchanged runner refuses an exit-zero checker without a result sidecar; adapter does not invent success', async t =>
{
    const fixture = staticAtomicFixture(t, [], { resultSidecars: false });
    const producer = fixture.declarations.producers.find(entry => entry.id === 'cross-stack-auth-state-coherence');
    const child = await fixture.run(producer);
    const receipt = JSON.parse(fs.readFileSync(path.join(fixture.evidenceRoot, child.attemptPath), 'utf8'));
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.status, 'failed-no-retry');
    assert.equal(receipt.failureKind, 'invalid-success-result-sidecar');
});
