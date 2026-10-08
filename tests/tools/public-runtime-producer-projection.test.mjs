import assert from 'node:assert/strict';
import test from 'node:test';

const { digestCanonical, sha256 } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { buildPublicRuntimeDeclarations } = await import(new URL('../../tools/test/public-runtime-producers/declarations.mjs', import.meta.url));
const { projectPublicRuntimeOutcomes, verifyPublicRuntimeProjection } = await import(new URL('../../tools/test/public-runtime-producers/projection.mjs', import.meta.url));

// Synthetic held DATA_ONLY inputs exercise consistency, never runtime authority.
function fixture(tier)
{
    const declarations = buildPublicRuntimeDeclarations(tier);
    const identity = {
        runId: 'unit-current', sourceCommit: 'a'.repeat(40), sourceFingerprint: sha256('source'),
        candidateDigest: sha256('candidate'), buildDigest: sha256('build'), manifestDigest: sha256('manifest'),
        runtimeIdentityDigest: sha256('runtime'), backendUrl: 'http://127.0.0.1:7568', previewUrl: 'http://127.0.0.1:8080'
    };
    const reference = (id, name) => ({ ref: `runs/${identity.runId}/${id}/${name}.json`, contentDigest: sha256(`${id}:${name}`) });
    const inputs = declarations.nodes.filter((node) => node.kind !== 'settled-projection').map((node) =>
    {
        const document = {
            schema: 'fsusblog.public-runtime-terminal-material.v1', authority: 'DATA_ONLY', producerId: node.id,
            declarationDigest: declarations.contentDigest, identity: structuredClone(identity),
            schedulerReceipt: { schema: 'fsusblog.scheduler.terminal-receipt.v1', stepId: node.id,
                terminalState: 'success', reasonCode: 'unit-success', primaryFailureRefs: [] },
            attemptRef: node.kind === 'correctness' ? reference(node.id, 'attempt') : null,
            fixtureRef: reference(node.id, 'fixture'), stateAccessRef: reference(node.id, 'state-access'),
            replayRef: reference(node.id, 'replay'), artifactRefs: [reference(node.id, 'artifact')],
            evidenceRefs: [reference(node.id, 'evidence')], failureKind: 'none',
            postconditionRef: node.kind === 'verified-postcondition-barrier' ? reference(node.id, 'postcondition') : null,
            measurement: null
        };
        if (node.execution?.measurementWindowId)
        {
            const isFirst = node.id === 'load-public-api';
            document.measurement = {
                windowId: node.id, runtimeIdentityDigest: identity.runtimeIdentityDigest, fixtureRef: document.fixtureRef,
                admissionRef: reference(node.id, 'admission'), noiseRef: reference(node.id, 'noise'),
                quiescenceRef: reference(node.id, 'quiescence'), startedNs: isFirst ? '100' : '300', finishedNs: isFirst ? '200' : '400'
            };
        }
        return { ...reference(node.id, 'terminal'), contentDigest: digestCanonical(document), document };
    });
    return { declarations, identity, inputs };
}

function edit(held, producerId, mutation)
{
    const input = held.inputs.find((item) => item.document.producerId === producerId);
    mutation(input.document);
    input.contentDigest = digestCanonical(input.document);
}

function failure(document, kind = 'product', terminalState = 'failed')
{
    document.schedulerReceipt.terminalState = terminalState;
    document.schedulerReceipt.reasonCode = `unit-${kind}`;
    document.schedulerReceipt.primaryFailureRefs = [document.producerId];
    document.failureKind = kind;
    document.postconditionRef = null;
    if (terminalState === 'blocked')
    {
        document.attemptRef = null;
        document.measurement = null;
    }
}

test('settled release projection retains AOT and simultaneous matrix failures with successful SEO', () =>
{
    const held = fixture('release-public');
    for (const id of ['public-aot-regression', 'public-clock-hydration-matrix', 'public-browser-env-hydration-matrix'])
    {
        edit(held, id, failure);
    }
    const result = projectPublicRuntimeOutcomes(held);
    assert.equal(result.terminalState, 'failed');
    assert.equal(result.outcomes.length, 9);
    assert.equal(result.outcomes.find((item) => item.producerId === 'public-seo-smoke').terminalState, 'success');
    assert.equal(result.primaryFailureRefs.length, 3);
    assert.equal(result.authority, 'DATA_ONLY');
    assert.equal(result.qualificationEligible, false);
    assert.deepEqual(verifyPublicRuntimeProjection(result, held), result);
});

test('resilience projection preserves upload and live notification failures plus explicit blocked siblings', () =>
{
    const held = fixture('resilience');
    edit(held, 'resilience-upload-mutation', failure);
    edit(held, 'resilience-post-notification-live', failure);
    edit(held, 'resilience-post-binary-smoke', (document) => failure(document, 'state-corruption', 'blocked'));
    const result = projectPublicRuntimeOutcomes(held);
    assert.equal(result.outcomes.length, 6);
    assert.equal(result.outcomes.filter((item) => item.classification === 'product-failure').length, 2);
    assert.equal(result.outcomes.filter((item) => item.classification === 'blocked').length, 1);
    assert.equal(result.terminalState, 'failed');
});

test('first load failure, timeout or cancellation survives successful reset and second window', () =>
{
    for (const state of ['failed', 'timed-out', 'cancelled'])
    {
        const held = fixture('load');
        edit(held, 'load-public-api', (document) => failure(document, state === 'failed' ? 'product' : 'infrastructure', state));
        const result = projectPublicRuntimeOutcomes(held);
        assert.equal(result.outcomes[0].terminalState, state);
        assert.equal(result.outcomes[1].terminalState, 'success');
        assert.equal(result.outcomes[2].terminalState, 'success');
        assert.equal(result.terminalState, state === 'cancelled' ? 'cancelled' : 'failed');
    }
});

test('reset failure is distinct from product failure and requires a blocked second window', () =>
{
    const held = fixture('load');
    edit(held, 'reset-pre-notification-stream', (document) => failure(document, 'infrastructure'));
    assert.throws(() => projectPublicRuntimeOutcomes(held), /without successful reset/u);
    edit(held, 'load-notification-stream-pressure', (document) => failure(document, 'infrastructure', 'blocked'));
    const result = projectPublicRuntimeOutcomes(held);
    assert.equal(result.outcomes[1].classification, 'reset-failure');
    assert.equal(result.outcomes[2].terminalState, 'blocked');
    assert.equal(result.terminalState, 'failed');
});

test('exit-zero reset without postcondition material cannot project success', () =>
{
    const held = fixture('load');
    edit(held, 'reset-pre-notification-stream', (document) =>
    {
        document.postconditionRef = null;
    });
    assert.throws(() => projectPublicRuntimeOutcomes(held), /postconditionRef/u);
});

test('cross-run, candidate, build, manifest, preview and runtime drift are rejected even when resealed', () =>
{
    for (const [field, value] of [
        ['runId', 'unit-other'], ['sourceCommit', 'b'.repeat(40)], ['sourceFingerprint', sha256('other-source')],
        ['candidateDigest', sha256('other-candidate')], ['buildDigest', sha256('other-build')],
        ['manifestDigest', sha256('other-manifest')], ['previewUrl', 'http://127.0.0.1:8081'],
        ['runtimeIdentityDigest', sha256('other-runtime')]
    ])
    {
        const held = fixture('load');
        edit(held, 'load-public-api', (document) =>
        {
            document.identity[field] = value;
        });
        assert.throws(() => projectPublicRuntimeOutcomes(held), /identity drift/u);
    }
});

test('historical/latest refs, missing membership, duplicate producers and duplicate attempts are rejected', () =>
{
    const held = fixture('release-public');
    const history = structuredClone(held);
    history.inputs[0].ref = 'runs/unit-old/public-aot-regression/terminal.json';
    assert.throws(() => projectPublicRuntimeOutcomes(history), /current-run/u);
    const latest = structuredClone(held);
    latest.inputs[0].ref = 'runs/unit-current/latest/terminal.json';
    assert.throws(() => projectPublicRuntimeOutcomes(latest), /current-run/u);
    const missing = structuredClone(held);
    missing.inputs.pop();
    assert.throws(() => projectPublicRuntimeOutcomes(missing), /membership/u);
    const duplicate = structuredClone(held);
    duplicate.inputs[1] = duplicate.inputs[0];
    assert.throws(() => projectPublicRuntimeOutcomes(duplicate), /duplicate/u);
    const attempts = structuredClone(held);
    edit(attempts, 'public-hydration-identity', (document) =>
    {
        document.attemptRef = attempts.inputs[0].document.attemptRef;
    });
    assert.throws(() => projectPublicRuntimeOutcomes(attempts), /attempt reused/u);
});

test('measurement overlap, per-window admission/noise reuse and runtime/fixture drift are rejected', () =>
{
    for (const mutate of [
        (document) =>
        {
            document.measurement.startedNs = '150';
        },
        (document, first) =>
        {
            document.measurement.admissionRef = first.measurement.admissionRef;
        },
        (document, first) =>
        {
            document.measurement.noiseRef = first.measurement.noiseRef;
        },
        (document) =>
        {
            document.measurement.runtimeIdentityDigest = sha256('other-runtime');
        },
        (document) =>
        {
            document.measurement.fixtureRef = { ...document.fixtureRef, contentDigest: sha256('other-fixture') };
        }
    ])
    {
        const held = fixture('load');
        const first = structuredClone(held.inputs[0].document);
        edit(held, 'load-notification-stream-pressure', (document) => mutate(document, first));
        assert.throws(() => projectPublicRuntimeOutcomes(held), /overlap|reused|identity drift/u);
    }
});

test('terminal and summary tamper cannot pass held-input verification', () =>
{
    const held = fixture('load');
    const result = projectPublicRuntimeOutcomes(held);
    const terminal = structuredClone(held);
    terminal.inputs[0].document.schedulerReceipt.terminalState = 'failed';
    assert.throws(() => projectPublicRuntimeOutcomes(terminal), /digest mismatch/u);
    const changed = structuredClone(result);
    changed.outcomes[0].artifactRefs = [];
    assert.throws(() => verifyPublicRuntimeProjection(changed, held), /tamper/u);
});

test('pre-measurement infrastructure failure and cancellation retain absent measurement evidence', () =>
{
    for (const state of ['failed', 'timed-out', 'cancelled', 'internal-error'])
    {
        const held = fixture('load');
        edit(held, 'load-public-api', (document) =>
        {
            failure(document, 'infrastructure', state);
            document.measurement = null;
        });
        const projection = projectPublicRuntimeOutcomes(held);
        assert.equal(projection.outcomes[0].measurement, null);
        assert.equal(projection.outcomes[0].terminalState, state);
        assert.notEqual(projection.terminalState, 'success');
    }
    const success = fixture('load');
    edit(success, 'load-public-api', (document) =>
    {
        document.measurement = null;
    });
    assert.throws(() => projectPublicRuntimeOutcomes(success), /missing.*measurement/u);
});

test('projection snapshots held materials and rejects non-string runtime identity fields', () =>
{
    const held = fixture('load');
    const projection = projectPublicRuntimeOutcomes(held);
    assert.equal(projection.terminalState, 'success');
    const original = structuredClone(projection);
    held.inputs[0].document.artifactRefs[0].ref = 'runs/unit-current/changed.json';
    assert.deepEqual(projection, original);
    const invalid = fixture('load');
    invalid.identity.runId = undefined;
    assert.throws(() => projectPublicRuntimeOutcomes(invalid), /must be strings/u);
});
