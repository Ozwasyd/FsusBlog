import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

import { staticAtomicCanonicalFixture } from './support/static-atomic-canonical-fixture.mjs';

const { digestCanonical } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { bindStaticAtomicCompilation, executeStaticAtomicCompilation, verifyStaticAtomicCompilation } = await import(new URL('../../tools/test/static-atomic/compiler-bridge.mjs', import.meta.url));

test('all thirteen original commands bind once to the canonical matrix and compiler', t =>
{
    const fixture = staticAtomicCanonicalFixture(t);
    const { compiled, binding } = verifyStaticAtomicCompilation(fixture.compilation, fixture.options);
    assert.equal(compiled.matrixDigest, digestCanonical(fixture.options.matrix));
    assert.equal(binding.producerBindings.length, 13);
    assert.equal(binding.qualificationEligible, false);
    for (const producer of fixture.declarations.producers)
    {
        const step = compiled.steps.find(entry => entry.id === producer.id);
        assert.deepEqual(step.command, producer.command);
        assert.deepEqual(step.dependsOn, []);
    }
    assert.equal(compiled.steps.find(entry => entry.id === 'security-matrices').owner, 'frontend-static-governance');
});

test('canonical source or membership tampering cannot bypass exact compilation', t =>
{
    const fixture = staticAtomicCanonicalFixture(t);
    const changed = structuredClone(fixture.compilation);
    changed.compiled.steps[0].command = ['node', '-e', 'process.exit(0)'];
    assert.throws(() => verifyStaticAtomicCompilation(changed, fixture.options), /compiled|compilation/u);
    const missing = { ...fixture.options, memberships: { ...fixture.memberships } };
    delete missing.memberships['security-sbom'];
    assert.throws(() => bindStaticAtomicCompilation(missing), /membership roster/u);
    const invalid = { ...fixture.options, prerequisiteBindings: structuredClone(fixture.options.prerequisiteBindings) };
    invalid.prerequisiteBindings['security-sbom']['dependency-locks'] = { kind: 'hard-prerequisite', producerId: 'missing-restore' };
    assert.throws(() => bindStaticAtomicCompilation(invalid), /missing hard prerequisite/u);
});

test('a matrices child retained under a frontend parent cannot be silently duplicated or reassigned for security projection', t =>
{
    const fixture = staticAtomicCanonicalFixture(t);
    const matrix = structuredClone(fixture.options.matrix);
    const authorities = structuredClone(fixture.options.authorities);
    matrix.atomicProducerDeclarations.nodes.find(entry => entry.producerId === 'security-matrices').logicalParentId = 'frontend-static-governance';
    authorities.physicalOwnership.find(entry => entry.producerId === 'security-matrices').logicalParentId = 'frontend-static-governance';
    matrix.tiers.push({ id: 'frontend-static-governance', executionMode: 'projection', commandKind: 'projection',
        executionOwner: 'synthetic-projection-owner', projectFrom: ['security-matrices'] });
    matrix.atomicProducerDeclarations.nodes.push({ kind: 'logical-projection', producerId: 'frontend-static-summary',
        logicalParentId: 'frontend-static-governance', owner: 'synthetic-projection-owner', projectionOwner: 'synthetic-projection-owner',
        dependsOn: [], settledDependsOn: ['security-matrices'] });
    authorities.matrixDigest = digestCanonical(matrix);
    assert.throws(() => bindStaticAtomicCompilation({ ...fixture.options, matrix, authorities }), /exact-one projection/u);
    assert.equal(matrix.atomicProducerDeclarations.nodes.filter(entry => entry.producerId === 'security-matrices').length, 1);
});

test('actual canonical execution settles independent siblings and never spawns the blocked supply-chain command', async t =>
{
    const fixture = staticAtomicCanonicalFixture(t, { failures: ['cross-stack-distribution-coherence', 'security-network-baseline'], blockedSupplyChain: true });
    const vector = await fixture.execute();
    assert.equal(vector.status, 'failed');
    const states = Object.fromEntries(vector.receipts.map(entry => [entry.producerId, entry.terminalState]));
    assert.equal(states['cross-stack-distribution-coherence'], 'failed');
    assert.equal(states['cross-stack-performance-coherence'], 'success');
    assert.equal(states['security-network-baseline'], 'failed');
    assert.equal(states['security-sbom'], 'success');
    assert.equal(states['security-supply-chain-audit'], 'blocked');
    assert.equal(states['cross-stack-static-summary'], 'failed');
    assert.equal(states['security-static-summary'], 'failed');
    const blocked = vector.receipts.find(entry => entry.producerId === 'security-supply-chain-audit');
    assert.deepEqual(blocked.blockedBy, ['synthetic-restore']);
    assert.equal(blocked.attemptRef, null);
    assert.equal(fs.existsSync(path.join(fixture.evidenceRoot, fixture.identity.schedulerRunId, blocked.producerId)), false);
});

test('unchanged exit-zero commands without result sidecars preserve the shared runner refusal', async t =>
{
    const fixture = staticAtomicCanonicalFixture(t, { resultSidecars: false });
    const vector = await fixture.execute();
    const child = vector.receipts.find(entry => entry.producerId === 'cross-stack-performance-coherence');
    assert.equal(child.terminalState, 'failed');
    const attempt = JSON.parse(fs.readFileSync(child.attemptRef.path, 'utf8'));
    assert.equal(attempt.exitCode, 0);
    assert.equal(attempt.failureKind, 'invalid-success-result-sidecar');
    assert.equal(vector.qualificationEligible, false);
});

test('domain execution refuses network skip and environment substitution before launch', async t =>
{
    const fixture = staticAtomicCanonicalFixture(t);
    const options = { ...fixture.options, producerContexts: { ...fixture.options.producerContexts } };
    options.producerContexts['security-network-baseline'] = { ...options.producerContexts['security-network-baseline'],
        env: { ...fixture.env, FSUSBLOG_SKIP_PRODUCTION_EXPOSURE_TOOL_TEST: '1' } };
    await assert.rejects(executeStaticAtomicCompilation(fixture.compilation, options), /cannot skip/u);
    options.producerContexts['security-network-baseline'].env = { ...fixture.env, ALTERED_ENVIRONMENT: 'yes' };
    await assert.rejects(executeStaticAtomicCompilation(fixture.compilation, options), /environment/u);
    assert.equal(fs.existsSync(fixture.evidenceRoot), false);
});

test('required input admission passes through once before the original single attempt', async t =>
{
    const fixture = staticAtomicCanonicalFixture(t);
    const id = 'security-sbom';
    const target = fixture.compilation.compiled.steps.find(entry => entry.id === id);
    const required = path.join(fixture.root, 'ordinary-required-sbom-input.json');
    fs.writeFileSync(required, '{"required":true}');
    let checks = 0;
    fixture.options.producerContexts[id].requiredInputAdmission = {
        inputClosureRef: target.inputClosureRef,
        validate: async ready =>
        {
            checks += 1;
            assert.ok(Object.isFrozen(ready));
            assert.deepEqual(ready.inputClosureRef, target.inputClosureRef);
            assert.deepEqual(ready.command, target.command);
            assert.equal(fs.existsSync(path.join(fixture.evidenceRoot, fixture.identity.schedulerRunId, id)), false);
            await fs.promises.access(required, fs.constants.R_OK);
            return { command: ['node', '-e', 'process.exit(0)'], retryPolicyId: 'diagnostic' };
        }
    };
    const vector = await executeStaticAtomicCompilation(fixture.compilation, fixture.options);
    assert.equal(checks, 1);
    const child = vector.receipts.find(entry => entry.producerId === id);
    const receipt = JSON.parse(fs.readFileSync(child.attemptRef.path, 'utf8'));
    assert.equal(child.terminalState, 'success');
    assert.deepEqual(receipt.command, target.command);
    assert.equal(receipt.attemptNumber, 1);
    assert.equal(receipt.maxAttempts, 1);
    assert.equal(receipt.retryPolicyId, 'correctness-first-attempt');
});

test('first-cause framework errors cross the domain bridge unchanged when terminal publication also fails', async t =>
{
    const fixture = staticAtomicCanonicalFixture(t);
    const id = 'security-sbom';
    const target = fixture.compilation.compiled.steps.find(entry => entry.id === id);
    const original = new Error('ordinary required SBOM input refused');
    fixture.options.producerContexts[id].requiredInputAdmission = { inputClosureRef: target.inputClosureRef,
        validate: () =>
        {
            throw original;
        } };
    const publication = new Error('ordinary terminal vector output write failed');
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (file, ...args) =>
    {
        if (typeof file === 'string' && path.basename(file) === 'terminal-vector.json')
        {
            throw publication;
        }
        return write(file, ...args);
    });
    const caught = await executeStaticAtomicCompilation(fixture.compilation, fixture.options).then(() => null, error => error);
    assert.equal(caught.name, 'AtomicProducerExecutionError');
    assert.equal(caught.cause.cause, original);
    assert.equal(caught.publicationError, publication);
    assert.equal(caught.terminalVector.status, 'failed');
    assert.equal(caught.terminalVector.receipts.find(entry => entry.producerId === id).attemptRef, null);
    assert.equal(caught.terminalVector.receipts.find(entry => entry.producerId === 'security-pow-parity').terminalState, 'success');
});
