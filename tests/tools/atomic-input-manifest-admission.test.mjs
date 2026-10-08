import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

import { atomicExecutionOptions, atomicFixture, atomicReference, rebindAtomicFixture } from './support/atomic-producer-fixture.mjs';

const { digestCanonical, sealContentDigest, sha256 } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { sealReplayPlan } = await import(new URL('../../tools/test/execution-replay-contract.mjs', import.meta.url));
const { createCorrectnessInputManifest } = await import(new URL('../../tools/test-matrix/correctness-input-manifest.mjs', import.meta.url));
const { compileAtomicProducerDag } = await import(new URL('../../tools/test-matrix/atomic-producers/compiler.mjs', import.meta.url));
const { AtomicProducerExecutionError, executeCompiledAtomicProducerDag } = await import(new URL('../../tools/test-matrix/atomic-producers/execution.mjs', import.meta.url));
const { createAtomicCorrectnessInputAdmission } = await import(new URL('../../tools/test-matrix/atomic-producers/input-admission.mjs', import.meta.url));

function fixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-input-manifest-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'tools'));
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'tools/entry.mjs'), "import './helper.mjs';\n");
    fs.writeFileSync(path.join(root, 'tools/helper.mjs'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(root, 'config/settings.json'), '{"mode":"ordinary"}\n');
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
    const command = ['node', 'tools/entry.mjs'];
    const manifest = createCorrectnessInputManifest({ root,
        entryCommand: command.join(' '), entryPath: command[1], configurationInputs: ['config/settings.json'] });
    const inputClosure = structuredClone(sealContentDigest({ id: 'ordinary-inputs', commandSourceId: 'ordinary-command',
        commandDigest: digestCanonical(command), unresolvedDynamicReads: [], inputManifestDigest: manifest.closureDigest }));
    const ready = { inputClosureRef: { id: inputClosure.id, contentDigest: inputClosure.contentDigest },
        commandSourceRef: { id: inputClosure.commandSourceId }, command };
    return { root, manifest, inputClosure, ready };
}

test('bounded atomic admission rechecks original transitive helper contents at readiness', (t) =>
{
    const current = fixture(t);
    const admission = createAtomicCorrectnessInputAdmission(current);
    assert.equal(admission.validate(current.ready), undefined);
    fs.writeFileSync(path.join(current.root, 'tools/helper.mjs'), 'export const value = 2;\n');
    assert.throws(() => admission.validate(current.ready), /content-drift: tools\/helper/u);
});

test('bounded atomic admission defers required file reads and retains an immutable manifest snapshot', (t) =>
{
    const current = fixture(t);
    const file = path.join(current.root, 'config/settings.json');
    const contents = fs.readFileSync(file);
    fs.unlinkSync(file);
    const admission = createAtomicCorrectnessInputAdmission(current);
    current.manifest.configurationInputs.length = 0;
    current.inputClosure.commandSourceId = 'replacement-command';
    assert.ok(Object.isFrozen(admission));
    assert.ok(Object.isFrozen(admission.inputClosureRef));
    assert.throws(() => admission.validate(current.ready), { code: 'ENOENT' });
    fs.writeFileSync(file, contents);
    assert.equal(admission.validate(current.ready), undefined);
});

test('bounded atomic admission binds the compiled closure, command source and unchanged argv', (t) =>
{
    const current = fixture(t);
    const admission = createAtomicCorrectnessInputAdmission(current);
    for (const override of [
        { inputClosureRef: { ...current.ready.inputClosureRef, id: 'other-inputs' } },
        { commandSourceRef: { id: 'other-command' } },
        { command: ['node', 'tools/helper.mjs'] }
    ])
    {
        assert.throws(() => admission.validate({ ...current.ready, ...override }), /differs from the compiled/u);
    }
});

test('bounded atomic admission refuses unbound manifests and unreconciled command representations', (t) =>
{
    const current = fixture(t);
    const { contentDigest, ...body } = current.inputClosure;
    assert.equal(typeof contentDigest, 'string');
    assert.throws(() => createAtomicCorrectnessInputAdmission({ ...current,
        inputClosure: sealContentDigest({ ...body, inputManifestDigest: 'sha256:unbound' }) }), /bind the original/u);
    assert.throws(() => createAtomicCorrectnessInputAdmission({ ...current,
        inputClosure: { ...current.inputClosure, commandSourceId: 'unsealed' } }), /content digest mismatch/u);
    const command = ['node', 'tools/helper.mjs'];
    const changed = sealContentDigest({ ...body, commandDigest: digestCanonical(command) });
    const admission = createAtomicCorrectnessInputAdmission({ ...current, inputClosure: changed });
    assert.throws(() => admission.validate({ ...current.ready, command,
        inputClosureRef: admission.inputClosureRef }), /manifest-invalid/u);
    const quoted = ['node', 'tools/entry.mjs', 'argument with spaces'];
    const quotedClosure = sealContentDigest({ ...body, commandDigest: digestCanonical(quoted) });
    const bounded = createAtomicCorrectnessInputAdmission({ ...current, inputClosure: quotedClosure });
    assert.throws(() => bounded.validate({ ...current.ready, command: quoted,
        inputClosureRef: bounded.inputClosureRef }), /unquoted bounded argv/u);
});

function executionFixture(t)
{
    const current = fixture(t);
    const controlled = atomicFixture();
    const target = controlled.matrix.atomicProducerDeclarations.nodes.find((node) => node.producerId === 'alpha-check');
    const replay = controlled.authorities.replayPlans.find((material) => material.plan.producer.id === target.producerId);
    // Ordinary fixture assertions produce their own result; this is never native qualification.
    fs.writeFileSync(path.join(current.root, 'tools/entry.mjs'), [
        "import assert from 'node:assert/strict';",
        "import fs from 'node:fs';",
        "import { value } from './helper.mjs';",
        'assert.equal(value, 1);',
        "assert.equal(JSON.parse(fs.readFileSync('config/settings.json', 'utf8')).mode, 'ordinary');",
        'fs.writeFileSync(process.env.FSUSBLOG_ATTEMPT_RESULT_PATH, JSON.stringify({',
        "schema: 'fsusblog.test-attempt-result.v1', failureClass: null, failureKind: null,",
        `executedTestIds: ${JSON.stringify(replay.plan.testEnumerationOrder)}, failedTestIds: [], artifactPaths: [] }));`
    ].join('\n'));
    const command = [process.execPath, 'tools/entry.mjs'];
    const manifest = createCorrectnessInputManifest({ root: current.root,
        entryCommand: command.join(' '), entryPath: command[1], configurationInputs: ['config/settings.json'] });
    const originalSource = controlled.authorities.commandSources.find((material) => material.id === target.commandSourceRef.id);
    const inputClosure = sealContentDigest({ id: originalSource.inputClosureRef.id, commandSourceId: originalSource.id,
        commandDigest: digestCanonical(command), unresolvedDynamicReads: [], inputManifestDigest: manifest.closureDigest });
    const { contentDigest, ...source } = originalSource;
    assert.equal(typeof contentDigest, 'string');
    const commandSource = sealContentDigest({ ...source, command, inputClosureRef: atomicReference(inputClosure) });
    controlled.authorities.commandSources = controlled.authorities.commandSources.map((item) => item.id === source.id ? commandSource : item);
    controlled.authorities.inputClosures = controlled.authorities.inputClosures.map((item) => item.id === inputClosure.id ? inputClosure : item);
    target.commandSourceRef = atomicReference(commandSource);
    controlled.authorities.physicalOwnership.find((item) => item.producerId === target.producerId).commandSourceRef = target.commandSourceRef;
    const { planDigest, ...unsigned } = replay.plan;
    assert.equal(typeof planDigest, 'string');
    replay.plan = sealReplayPlan({ ...unsigned,
        command: { ...replay.plan.command, executable: command[0], args: command.slice(1) } });
    replay.bytes = `${JSON.stringify(replay.plan, null, 4)}\n`;
    target.replayPlanRef = { id: replay.id, contentDigest: sha256(replay.bytes), planDigest: replay.plan.planDigest };
    rebindAtomicFixture(controlled);
    let cleanupCount = 0;
    const options = atomicExecutionOptions(controlled, path.join(current.root, 'evidence'), {
        onCleanup: () =>
        {
            cleanupCount += 1;
        }
    });
    options.producerContexts[target.producerId].cwd = current.root;
    options.producerContexts[target.producerId].requiredInputAdmission = createAtomicCorrectnessInputAdmission({
        root: current.root, inputClosure, manifest
    });
    return { ...current, options, compiled: compileAtomicProducerDag(controlled.matrix, controlled.authorities),
        cleanupCount: () => cleanupCount };
}

test('bounded manifest admission with a missing configuration refuses the real DAG before attempt allocation', async (t) =>
{
    const current = executionFixture(t);
    fs.unlinkSync(path.join(current.root, 'config/settings.json'));
    let failure;
    await assert.rejects(executeCompiledAtomicProducerDag(current.compiled, current.options), (error) =>
    {
        assert.ok(error instanceof AtomicProducerExecutionError);
        failure = error;
        return true;
    });
    const receipts = Object.fromEntries(failure.terminalVector.receipts.map((receipt) => [receipt.producerId, receipt]));
    assert.equal(failure.cause.cause.code, 'ENOENT');
    assert.equal(receipts['alpha-check'].reasonCode, 'required-input-admission-failed');
    assert.equal(receipts['alpha-check'].attemptRef, null);
    const evidence = JSON.parse(fs.readFileSync(receipts['alpha-check'].evidenceRefs[0].path, 'utf8'));
    assert.equal(evidence.attemptAllocationCount, 0);
    assert.equal(evidence.physicalSpawnCount, 0);
    assert.equal(receipts['dependent-check'].terminalState, 'blocked');
    assert.equal(receipts['beta-check'].terminalState, 'success');
    assert.equal(current.cleanupCount(), 1);
    assert.equal(fs.existsSync(path.join(current.options.context.evidenceRoot,
        current.options.context.schedulerRunId, 'alpha-check')), false);
});

test('bounded manifest admission with actual inputs retains exactly one unchanged real attempt', async (t) =>
{
    const current = executionFixture(t);
    const vector = await executeCompiledAtomicProducerDag(current.compiled, current.options);
    const terminal = vector.receipts.find((receipt) => receipt.producerId === 'alpha-check');
    const receipt = JSON.parse(fs.readFileSync(terminal.attemptRef.path, 'utf8'));
    assert.equal(vector.status, 'success');
    assert.equal(vector.qualificationEligible, false);
    assert.equal(receipt.attemptNumber, 1);
    assert.equal(receipt.maxAttempts, 1);
    assert.equal(receipt.status, 'clean-success');
    assert.deepEqual(receipt.command, [process.execPath, 'tools/entry.mjs']);
    assert.equal(current.cleanupCount(), 1);
});
