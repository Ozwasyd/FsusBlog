import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    compositionDigest,
    createCompositionIdentity,
    loadCompositionInputs
} from '@fsusblog/layout-governance/composition-contracts';
import { governanceContentDigest } from '@fsusblog/layout-governance/evidence-location-contract';
import {
    verifyVisualAdjudication,
    verifyVisualModeParity,
    visualArtifactDigest,
    visualReceiptDigest,
    visualRubricFields,
    visualVerifierIdentity
} from '@fsusblog/layout-governance/visual-adjudication';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const digest = 'b'.repeat(64);

// These fixtures validate receipt contracts only. Their bytes, source identity,
// reviewers and producer observations are synthetic and never page evidence.
function fixture(mode = 'local')
{
    const inputs = loadCompositionInputs({ repositoryRoot });
    const baseline = {
        schema: 'fsusblog-design-conformance.fsusui-baseline-identity.v1',
        sourceKind: mode === 'local' ? 'local-source' : 'package-pin',
        repository: 'Ozwasyd/FsusUI',
        absolutePath: mode === 'local' ? '/synthetic/fsusui' : null,
        gitHead: mode === 'local' ? 'c'.repeat(40) : null,
        packageVersion: 'synthetic-test-package',
        dirty: false,
        dirtyFingerprint: digest,
        skillDigest: digest,
        contractDigests: { stagePolicy: digest, classification: digest, adjudication: digest, uxAcceptance: digest }
    };
    baseline.baselineDigest = compositionDigest(baseline);
    const currentSource = { sourceCommit: 'a'.repeat(40), fsusUIBaselineIdentity: baseline };
    const identity = createCompositionIdentity(inputs, currentSource);
    const entry = inputs.matrix.archetypes.find(({ surface, kind }) => surface === 'admin' && kind === 'settings');
    const scene = {
        archetype: 'admin/settings', routePattern: entry.path, routeFixtureDigest: digest,
        theme: 'light', viewport: { width: 1440, height: 900, zoom: 1 }, state: 'synthetic-loaded', media: 'default'
    };
    const binding = {
        scene, compositionIdentityDigest: identity.identityDigest, worktreeFingerprint: digest,
        runId: 'synthetic-run', attemptId: 'synthetic-attempt'
    };
    const artifacts = {};
    const evidence = ['screenshot', 'static', 'dom', 'geometry'].map((kind) =>
    {
        const id = `synthetic-${kind}`;
        const bytes = Buffer.from(`synthetic ${kind} artifact`);
        const opaqueProducerBytes = Buffer.from(JSON.stringify({ fixtureClass: 'synthetic', kind, outcome: 'pass', binding }));
        artifacts[id] = { bytes, opaqueProducerBytes };
        return { id, kind, contentDigest: visualArtifactDigest(bytes), opaqueProducerDigest: visualArtifactDigest(opaqueProducerBytes), binding: structuredClone(binding) };
    });
    const receipt = {
        schema: 'fsusblog.layout-visual-adjudication.v1', ...visualVerifierIdentity(),
        evidenceClass: 'synthetic', status: 'verified', compositionIdentity: identity, binding,
        adjudicator: { id: 'synthetic-adjudicator', independentReviewerId: 'synthetic-independent-reviewer', runId: binding.runId, method: 'independent-rendered-field-review' },
        evidence,
        rubric: Object.fromEntries(visualRubricFields.map((field) => [field, {
            status: 'pass', evidenceIds: evidence.map(({ id }) => id), binding: structuredClone(binding), reason: null, blockingIssue: null
        }])),
        baselineMovement: null, warnings: []
    };
    const context = {
        inputs, currentSource, expectedScene: structuredClone(scene), worktreeFingerprint: digest,
        runId: binding.runId, attemptId: binding.attemptId, artifacts,
        baseline: { kind: 'existing', bytes: artifacts['synthetic-screenshot'].bytes },
        purpose: 'synthetic-contract-test'
    };
    seal(receipt);
    return { receipt, context };
}

function seal(receipt)
{
    receipt.contentDigest = visualReceiptDigest(receipt);
}

function reject(change, code)
{
    const { receipt, context } = fixture();
    change(receipt, context);
    seal(receipt);
    assert.throws(() => verifyVisualAdjudication(receipt, context), code ? { code: `layout-visual-${code}` } : undefined);
}

function move(receipt, context, creation = false)
{
    const entry = context.inputs.ledger.entries.find((item) => item.issue === 1899);
    const old = Buffer.from('synthetic old screenshot');
    context.baseline = creation ? { kind: 'missing' } : { kind: 'existing', bytes: old };
    if (!creation)
    {
        context.artifacts.oldScreenshot = { bytes: old };
    }
    receipt.baselineMovement = {
        kind: creation ? 'creation' : 'movement',
        ledgerPath: 'tests/frontend/fixtures/layout-visual-change-ledger.json',
        ledgerDigest: compositionDigest(context.inputs.ledger), entryDigest: compositionDigest(entry),
        issue: entry.issue, classification: entry.classification,
        oldScreenshotDigest: creation ? null : visualArtifactDigest(old),
        newScreenshotDigest: receipt.evidence[0].contentDigest,
        sourceCommit: receipt.compositionIdentity.sourceCommit,
        fsusUIBaselineIdentityDigest: receipt.compositionIdentity.fsusUIBaselineIdentityDigest,
        compositionContractDigest: receipt.compositionIdentity.compositionContractDigest,
        reason: 'synthetic movement binding test only', owner: 'synthetic-owner'
    };
}

test('synthetic exact ten-field validation cannot qualify a real page', () =>
{
    const { receipt, context } = fixture();
    assert.equal(visualRubricFields.length, 10);
    const result = verifyVisualAdjudication(receipt, context);
    assert.equal(result.status, 'synthetic-contract-verified');
    assert.equal(result.qualificationEligible, false);
    assert.deepEqual(result.counts, { pass: 10, fail: 0, 'not-observed': 0 });
    assert.deepEqual(result.missingProductionCapabilities, [2098, 2099]);
});

test('production evidence fails closed until canonical opaque producer adapters exist', () =>
{
    reject((receipt) =>
    {
        receipt.evidenceClass = 'rendered';
    }, 'producer-adapter-unavailable');
    reject((receipt, context) =>
    {
        context.purpose = 'formal-acceptance';
    }, 'synthetic-not-admitted');
});


test('rendered path consumes canonical origin admission and refuses caller callback authority', () =>
{
    const { receipt, context } = fixture();
    receipt.evidenceClass = 'rendered';
    context.purpose = 'formal-acceptance';
    const originContext = {
        schema: 'fsusblog.current-run-evidence-context.v1',
        schedulerRunId: receipt.binding.runId, attemptId: receipt.binding.attemptId,
        sourceCommit: receipt.compositionIdentity.sourceCommit,
        worktreeFingerprint: `sha256:${receipt.binding.worktreeFingerprint}`,
        candidateIdentity: { id: 'synthetic-candidate', digest: `sha256:${digest}` },
        buildIdentity: { id: 'synthetic-build', digest: `sha256:${digest}` },
        ownedRoots: ['artifacts/current-run']
    };
    originContext.contentDigest = governanceContentDigest(originContext);
    let callbackUsed = false;
    context.producerAdmission = {
        context: originContext,
        visualOrigin: { consumerId: 'synthetic-unregistered-consumer', explicitInputs: ['synthetic.json'] },
        verifyProducer: () =>
        {
            callbackUsed = true;
            return { verified: true };
        }
    };
    seal(receipt);
    assert.throws(() => verifyVisualAdjudication(receipt, context), { code: 'visual-admission-consumer-unregistered' });
    assert.equal(callbackUsed, false);
});

test('pass needs screenshot, static, DOM and geometry for every individual rubric field', () =>
{
    for (const kind of ['screenshot', 'static', 'dom', 'geometry'])
    {
        reject((receipt) =>
        {
            receipt.rubric.primaryFocus.evidenceIds = receipt.evidence.filter((entry) => entry.kind !== kind).map(({ id }) => id);
        }, 'evidence-incomplete');
    }
    reject((receipt) =>
    {
        receipt.rubric.primaryFocus.evidenceIds = ['unknown'];
    }, 'evidence-missing');
});

test('zero diff and static-only cannot replace rendered field evidence', () =>
{
    reject((receipt) =>
    {
        receipt.pixelDiff = 0;
    }, 'schema-invalid');
    reject((receipt) =>
    {
        receipt.rubric.primaryFocus.evidenceIds = ['synthetic-static'];
    }, 'evidence-incomplete');
});

test('machine static/DOM/geometry failure cannot be overridden by a visual pass', () =>
{
    for (const kind of ['static', 'dom', 'geometry'])
    {
        reject((receipt, context) =>
        {
            const ref = receipt.evidence.find((item) => item.kind === kind);
            const artifact = context.artifacts[ref.id];
            const observation = JSON.parse(artifact.opaqueProducerBytes);
            observation.outcome = 'fail';
            artifact.opaqueProducerBytes = Buffer.from(JSON.stringify(observation));
            ref.opaqueProducerDigest = visualArtifactDigest(artifact.opaqueProducerBytes);
        }, 'machine-failure');
    }
});

test('not-observed stays incomplete and cannot be signed verified or ignored', () =>
{
    const { receipt, context } = fixture();
    receipt.rubric.primaryFocus.status = 'not-observed';
    receipt.rubric.primaryFocus.reason = { code: 'missing-observation', rubricField: 'primaryFocus', contractField: 'primaryVisualAnchor', explanation: 'synthetic missing observation' };
    seal(receipt);
    assert.throws(() => verifyVisualAdjudication(receipt, context), { code: 'layout-visual-status-inconsistent' });
    receipt.status = 'incomplete';
    seal(receipt);
    assert.equal(verifyVisualAdjudication(receipt, context).qualificationEligible, false);
    reject((value) =>
    {
        value.rubric.primaryFocus.status = 'ignored';
    }, 'schema-invalid');
});

test('fail requires canonical reason, exact rubric field and blocking atomic issue', () =>
{
    reject((receipt) =>
    {
        receipt.status = 'failed';
        receipt.rubric.primaryFocus.status = 'fail';
    }, 'failure-unbound');
    const { receipt, context } = fixture();
    const field = receipt.rubric.primaryFocus;
    field.status = 'fail';
    field.reason = { code: 'composition-contract-failure', rubricField: 'primaryFocus', contractField: 'primaryVisualAnchor', explanation: 'synthetic failure' };
    field.blockingIssue = { url: 'https://github.com/Ozwasyd/FsusBlog/issues/1899', classification: 'production-atomic', contentDigest: digest };
    receipt.status = 'failed';
    seal(receipt);
    assert.equal(verifyVisualAdjudication(receipt, context).status, 'synthetic-contract-failed');
    field.reason.rubricField = 'actionPriority';
    seal(receipt);
    assert.throws(() => verifyVisualAdjudication(receipt, context), { code: 'layout-visual-failure-unbound' });
    field.reason.rubricField = 'primaryFocus';
    field.reason.contractField = 'synthetic-unknown-contract-field';
    seal(receipt);
    assert.throws(() => verifyVisualAdjudication(receipt, context), { code: 'layout-visual-failure-unbound' });
});

test('current source, baseline and identity seal cannot drift', () =>
{
    for (const key of ['sourceCommit', 'fsusUIBaselineIdentityDigest', 'compositionContractDigest', 'fixtureSourceDigest'])
    {
        reject((receipt) =>
        {
            receipt.compositionIdentity[key] = key === 'sourceCommit' ? 'd'.repeat(40) : 'd'.repeat(64);
        });
    }
    reject((receipt) =>
    {
        receipt.binding.worktreeFingerprint = 'd'.repeat(64);
    }, 'binding-mismatch');
    reject((receipt) =>
    {
        receipt.binding.runId = 'synthetic-stale-run';
    }, 'binding-mismatch');
});

test('evidence cannot cross archetype, theme, viewport, state or route fixture', () =>
{
    for (const [key, value] of [['archetype', 'public/feed'], ['theme', 'dark'], ['state', 'synthetic-error'], ['routeFixtureDigest', 'd'.repeat(64)]])
    {
        reject((receipt) =>
        {
            receipt.evidence[1].binding.scene[key] = value;
        }, 'binding-mismatch');
    }
    reject((receipt) =>
    {
        receipt.rubric.primaryFocus.binding.scene.viewport.width = 375;
    }, 'binding-mismatch');
    reject((receipt, context) =>
    {
        receipt.binding.scene.routePattern = context.expectedScene.routePattern = '/synthetic-special-layout';
    }, 'scene-unregistered');
});

test('baseline creation and movement need sole ledger exact entry and both screenshot bindings', () =>
{
    for (const creation of [false, true])
    {
        const { receipt, context } = fixture();
        move(receipt, context, creation);
        seal(receipt);
        assert.equal(verifyVisualAdjudication(receipt, context).qualificationEligible, false);
    }
    reject((receipt, context) =>
    {
        context.baseline = { kind: 'missing' };
    }, 'ledger-mismatch');
    reject((receipt, context) =>
    {
        context.baseline.bytes = Buffer.from('synthetic changed baseline');
    }, 'ledger-mismatch');
    reject((receipt, context) =>
    {
        move(receipt, context);
        receipt.baselineMovement.entryDigest = 'd'.repeat(64);
    }, 'ledger-entry-mismatch');
    reject((receipt, context) =>
    {
        move(receipt, context);
        receipt.baselineMovement.ledgerPath = 'synthetic-second-ledger.json';
    }, 'schema-invalid');
    reject((receipt, context) =>
    {
        move(receipt, context);
        receipt.baselineMovement.newScreenshotDigest = 'd'.repeat(64);
    }, 'ledger-mismatch');
    reject((receipt, context) =>
    {
        move(receipt, context);
        context.artifacts.oldScreenshot.bytes = Buffer.from('synthetic tamper');
    }, 'ledger-mismatch');
});

test('receipt, screenshot, DOM, geometry and opaque producer tamper is rejected', () =>
{
    for (const kind of ['screenshot', 'static', 'dom', 'geometry'])
    {
        reject((receipt, context) =>
        {
            context.artifacts[`synthetic-${kind}`].bytes = Buffer.from('synthetic tamper');
        }, 'artifact-tampered');
    }
    reject((receipt, context) =>
    {
        context.artifacts['synthetic-geometry'].opaqueProducerBytes = Buffer.from('synthetic tamper');
    }, 'artifact-tampered');
    const { receipt, context } = fixture();
    receipt.adjudicator.id = 'synthetic-changed';
    assert.throws(() => verifyVisualAdjudication(receipt, context), { code: 'layout-visual-receipt-tampered' });
});

test('unknown score, permanent exception, route criteria and warning fields fail schema', () =>
{
    for (const key of ['totalScore', 'weightedHarmonyScore', 'aiAestheticScore', 'permanentException', 'routeCriteria', 'snapshotAccepted'])
    {
        reject((receipt) =>
        {
            receipt[key] = true;
        }, 'schema-invalid');
    }
    reject((receipt) =>
    {
        receipt.warnings = ['synthetic warning'];
    }, 'schema-invalid');
    reject((receipt) =>
    {
        receipt.rubric.primaryFocus.score = 10;
    }, 'schema-invalid');
});

test('versions, verifier bytes, rubric and independent reviewer binding cannot drift', () =>
{
    for (const key of ['schemaDigest', 'verifierDigest', 'rubricDigest', 'producerAdmissionDigest'])
    {
        reject((receipt) =>
        {
            receipt[key] = 'd'.repeat(64);
        }, 'version-drift');
    }
    reject((receipt) =>
    {
        receipt.rubricVersion = 'synthetic-old-rubric';
    }, 'schema-invalid');
    reject((receipt) =>
    {
        receipt.adjudicator.independentReviewerId = receipt.adjudicator.id;
    }, 'independence-invalid');
});

test('local/published comparison preserves one rubric/contract/fixture and never qualifies', () =>
{
    const left = fixture('local').receipt;
    const right = fixture('published').receipt;
    assert.equal(verifyVisualModeParity(left, right).qualificationEligible, false);
    right.rubricDigest = 'd'.repeat(64);
    assert.throws(() => verifyVisualModeParity(left, right), { code: 'layout-visual-mode-mismatch' });
    right.rubricDigest = left.rubricDigest;
    right.binding.scene.state = 'synthetic-other-state';
    assert.throws(() => verifyVisualModeParity(left, right), { code: 'layout-visual-binding-mismatch' });
    right.binding.scene.state = left.binding.scene.state;
    right.compositionIdentity.fsusUIMode = 'local';
    assert.throws(() => verifyVisualModeParity(left, right), { code: 'layout-visual-mode-mismatch' });
});

test('schema and verifier are independently bound regular source bytes', () =>
{
    const identity = visualVerifierIdentity();
    assert.equal(identity.schemaDigest, visualArtifactDigest(readFileSync(new URL('../../config/schemas/layout-visual-adjudication.schema.json', import.meta.url))));
    assert.equal(identity.verifierDigest, visualArtifactDigest(readFileSync(new URL('../frontend/support/layout/visualAdjudication.mjs', import.meta.url))));
});

test('missing, surplus and duplicated artifacts cannot be promoted by matching digests', () =>
{
    reject((receipt, context) =>
    {
        delete context.artifacts['synthetic-geometry'];
    }, 'evidence-cardinality');
    reject((receipt, context) =>
    {
        context.artifacts['synthetic-surplus'] = context.artifacts['synthetic-static'];
    }, 'evidence-cardinality');
    reject((receipt) =>
    {
        receipt.evidence[1].id = receipt.evidence[0].id;
    }, 'evidence-duplicate');
});

test('mode parity checks current verifier and receipt seals, not only matching strings', () =>
{
    const left = fixture('local').receipt;
    const right = fixture('published').receipt;
    left.verifierDigest = right.verifierDigest = 'd'.repeat(64);
    seal(left);
    seal(right);
    assert.throws(() => verifyVisualModeParity(left, right), { code: 'layout-visual-version-drift' });
    const original = fixture('local').receipt;
    const changed = fixture('published').receipt;
    changed.adjudicator.id = 'synthetic-replaced-reviewer';
    assert.throws(() => verifyVisualModeParity(original, changed), { code: 'layout-visual-receipt-tampered' });
});

test('loaded synthetic verifier refuses actual later schema or source byte changes', async () =>
{
    const directory = mkdtempSync(join(tmpdir(), 'synthetic-visual-verifier-'));
    try
    {
        const source = readFileSync(new URL('../frontend/support/layout/visualAdjudication.mjs', import.meta.url), 'utf8');
        const schemaFile = join(directory, 'synthetic-schema.json');
        const moduleFile = join(directory, 'synthetic-verifier.mjs');
        const schemaUrl = pathToFileURL(schemaFile).href;
        const require = createRequire(import.meta.url);
        const validatorUrl = pathToFileURL(require.resolve('@fsusblog/layout-governance/schema-validator')).href;
        const contractsUrl = pathToFileURL(require.resolve('@fsusblog/layout-governance/composition-contracts')).href;
        const admissionUrl = pathToFileURL(require.resolve('@fsusblog/layout-governance/visual-producer-admission')).href;
        const relocated = source
            .replace("'@fsusblog/layout-governance/schema-validator'", JSON.stringify(validatorUrl))
            .replace("'./compositionContracts.mjs'", JSON.stringify(contractsUrl))
            .replace("'./visualProducerAdmission.mjs'", JSON.stringify(admissionUrl))
            .replace("new URL('../../../../config/schemas/layout-visual-adjudication.schema.json', import.meta.url)", `new URL(${JSON.stringify(schemaUrl)})`);
        assert.notEqual(relocated, source);
        writeFileSync(schemaFile, readFileSync(new URL('../../config/schemas/layout-visual-adjudication.schema.json', import.meta.url)));
        writeFileSync(moduleFile, relocated);
        const loaded = await import(pathToFileURL(moduleFile).href);
        loaded.visualVerifierIdentity();
        writeFileSync(moduleFile, `${relocated}\n// synthetic source drift\n`);
        assert.throws(() => loaded.visualVerifierIdentity(), { code: 'layout-visual-version-drift' });
        writeFileSync(moduleFile, relocated);
        writeFileSync(schemaFile, `${readFileSync(schemaFile, 'utf8')}\n`);
        assert.throws(() => loaded.visualVerifierIdentity(), { code: 'layout-visual-version-drift' });
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});
