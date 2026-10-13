import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    compositionDigest, createCompositionIdentity, loadCompositionInputs
} from '@fsusblog/layout-governance/composition-contracts';
import {
    createLayoutAggregationPlan, inspectLayoutAggregation, inspectLayoutReceiptCoverage,
    layoutAggregationCounterNames, layoutAggregationMutationIds, layoutReceiptArtifactDigest,
    requireFullLayoutAggregate
} from '@fsusblog/layout-governance/layout-aggregation';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const inputs = loadCompositionInputs({ repositoryRoot });
const plan = createLayoutAggregationPlan(inputs);
const hash = 'b'.repeat(64);
const binding = { sourceCommit: 'a'.repeat(40), worktreeFingerprint: hash, runId: 'synthetic-run', attemptId: 'synthetic-attempt' };

function currentSource(mode)
{
    const baseline = {
        schema: 'fsusblog-design-conformance.fsusui-baseline-identity.v1',
        sourceKind: mode === 'local' ? 'local-source' : 'package-pin', repository: 'Ozwasyd/FsusUI',
        absolutePath: mode === 'local' ? '/synthetic/fsusui' : null,
        gitHead: mode === 'local' ? 'c'.repeat(40) : null,
        packageVersion: 'synthetic-test-package', dirty: false, dirtyFingerprint: hash,
        skillDigest: hash, contractDigests: { stagePolicy: hash, classification: hash, adjudication: hash, uxAcceptance: hash }
    };
    baseline.baselineDigest = compositionDigest(baseline);
    return { sourceCommit: binding.sourceCommit, fsusUIBaselineIdentity: baseline };
}
const currentSources = { local: currentSource('local'), published: currentSource('published') };
const identities = Object.fromEntries(Object.entries(currentSources).map(([mode, source]) => [mode, createCompositionIdentity(inputs, source)]));

function fixture()
{
    // Synthetic identity and opaque receipt bytes exercise admission only. They
    // never describe a product mutation, browser execution or killed regression.
    return {
        request: {
            schema: 'fsusblog.layout-aggregation-request.v1', lane: 'full',
            matrixRef: plan.matrixRef, ledgerRef: plan.ledgerRef, command: plan.command,
            execution: 'completed', ...binding, planDigest: plan.planDigest,
            compositionIdentities: structuredClone(identities), receipts: [],
            mutationResults: layoutAggregationMutationIds.map((id) => ({ id, status: 'not-executed', evidenceDigests: [] }))
        },
        context: { inputs, currentBinding: { ...binding }, currentSources: structuredClone(currentSources), artifacts: {} }
    };
}

function reject(change, code)
{
    const { request, context } = fixture();
    change(request, context);
    assert.throws(() => inspectLayoutAggregation(request, context), { code: `layout-aggregate-${code}` });
}

function addReference(request, context)
{
    const bytes = Buffer.from('synthetic opaque producer receipt; not runtime evidence');
    const contentDigest = layoutReceiptArtifactDigest(bytes);
    context.artifacts[contentDigest] = bytes;
    request.receipts.push({ requirementDigest: plan.requirements[0].requirementDigest, kind: 'static', contentDigest });
}

test('plan derives all representatives, states and literal dimension demands from canonical inputs', () =>
{
    assert.equal(new Set(plan.requirements.map((entry) => entry.archetype)).size, inputs.matrix.archetypes.length);
    for (const entry of inputs.matrix.archetypes)
    {
        const requirements = plan.requirements.filter((item) => item.archetype === `${entry.surface}/${entry.kind}`);
        assert.deepEqual(new Set(requirements.map((item) => item.stateId)), new Set(entry.compositionContract.requiredStateFixtures.map((state) => state.id)));
        assert.deepEqual(new Set(requirements.map((item) => item.mode)), new Set(['local', 'published']));
        assert.ok(requirements.every((item) => item.critical === entry.critical && item.routePattern === entry.path));
    }
    assert.ok(plan.requirements.some((item) => item.viewport === 'mobile'));
    assert.ok(plan.requirements.some((item) => item.media === 'high-contrast'));
    assert.ok(plan.requirements.some((item) => item.media === 'zoom-200'));
    assert.ok(plan.requirements.some((item) => item.viewport.width === 320));
    assert.equal(plan.runtimeSceneAdmission, 'pending-canonical-producer');
    assert.equal(plan.qualificationEligible, false);
});

test('exact reference cardinality is independent of producer qualification', () =>
{
    const references = plan.requirements.flatMap((entry) => plan.receiptKinds.map((kind) => ({ requirementDigest: entry.requirementDigest, kind, contentDigest: hash })));
    const coverage = inspectLayoutReceiptCoverage(plan, references);
    assert.equal(coverage.missing.length, 0);
    assert.equal(coverage.qualificationEligible, false);
    assert.throws(() => inspectLayoutReceiptCoverage(plan, [...references, references[0]]), { code: 'layout-aggregate-receipt-cardinality' });
    assert.equal(inspectLayoutReceiptCoverage(plan, references.slice(1)).missing.length, 1);
});

test('diagnostic retains exactly ten counters; unexecuted counters are unknown, never zero', () =>
{
    const { request, context } = fixture();
    const result = inspectLayoutAggregation(request, context);
    assert.deepEqual(Object.keys(result.counters), [...layoutAggregationCounterNames]);
    assert.equal(layoutAggregationCounterNames.length, 10);
    assert.equal(result.status, 'not-executed');
    assert.equal(result.qualificationEligible, false);
    assert.equal(result.counters.uncoveredArchetypes, null);
    assert.equal(result.referenceCoverage.archetypesWithMissingReferences, 12);
    assert.equal(result.counters.invalidCompositionContracts, 0);
    assert.equal(result.counters.staleMissingEvidence, null);
    assert.equal(result.referenceCoverage.missingReferences, plan.requirements.length * plan.receiptKinds.length);
    for (const key of layoutAggregationCounterNames.filter((name) => name !== 'invalidCompositionContracts'))
    {
        assert.equal(result.counters[key], null);
    }
    assert.equal(result.pendingStateBindings.length, 91);
    assert.equal(result.unverifiedMutationResults.length, layoutAggregationMutationIds.length);
});

test('missing or duplicate mutation observations do not become qualified kills', () =>
{
    const { request, context } = fixture();
    request.mutationResults.pop();
    assert.equal(inspectLayoutAggregation(request, context).missingMutationResults.length, 1);
    reject((candidate) => candidate.mutationResults.push(candidate.mutationResults[0]), 'mutation-cardinality');
    reject((candidate) =>
    {
        candidate.mutationResults[0].status = 'killed';
    }, 'mutation-evidence-missing');
    reject((candidate) =>
    {
        candidate.mutationResults[0].evidenceDigests = [hash];
    }, 'mutation-evidence-missing');
});

test('opaque byte digest match is only reference admission; it cannot attest machine pass', () =>
{
    const { request, context } = fixture();
    addReference(request, context);
    assert.equal(inspectLayoutAggregation(request, context).qualificationEligible, false);
    reject((candidate, current) =>
    {
        addReference(candidate, current);
        current.artifacts = {};
    }, 'artifact-missing');
    reject((candidate, current) =>
    {
        addReference(candidate, current);
        current.artifacts[candidate.receipts[0].contentDigest] = Buffer.from('tampered');
    }, 'artifact-missing');
    reject((candidate, current) =>
    {
        current.artifacts[hash] = Buffer.from('unconsumed');
    }, 'artifact-cardinality');
});

for (const field of ['sourceCommit', 'worktreeFingerprint', 'runId', 'attemptId'])
{
    test(`stale or cross-run ${field} is rejected`, () =>
    {
        reject((request) =>
        {
            request[field] = field === 'sourceCommit' ? 'd'.repeat(40) : field === 'worktreeFingerprint' ? 'd'.repeat(64) : 'old-run';
        }, 'binding-drift');
    });
}

test('changed source mode and published fallback local are rejected', () =>
{
    reject((request) =>
    {
        request.compositionIdentities.published = structuredClone(request.compositionIdentities.local);
    }, 'identity-drift');
});

test('unavailable published identity cannot fall back to local', () =>
{
    reject((request, context) =>
    {
        delete context.currentSources.published;
    }, 'mode-unavailable');
    reject((request, context) =>
    {
        context.currentSources.published = context.currentSources.local;
    }, 'mode-unavailable');
});

test('plan identity binds matrix, ledger, fixture content and aggregation source bytes', () =>
{
    reject((request) =>
    {
        request.planDigest = hash;
    }, 'plan-drift');
    const changed = structuredClone(inputs);
    changed.ledger.entries[0].rationale += ' synthetic drift';
    assert.notEqual(createLayoutAggregationPlan(changed).planDigest, plan.planDigest);
    const dimensions = plan.requirements[0].dimensions;
    assert.ok(dimensions.viewportsRef.source && dimensions.themesRef.pointer && dimensions.mediaRef.pointer);
});

for (const [mutation, field, value] of [
    ['second-matrix', 'matrixRef', 'synthetic/second-matrix.json'],
    ['second-ledger', 'ledgerRef', 'synthetic/second-ledger.json'],
    ['second-runner', 'command', 'synthetic:alternative-harmony-runner'],
    ['not-observed-verified', 'status', 'verified'],
    ['pixel-exact-only', 'pixelDiffOnly', true],
    ['job-success-only', 'jobStatus', 'success'],
    ['aesthetic-score-authority', 'harmonyScore', 100],
    ['permanent-bad-baseline-exception', 'exceptions', ['current-baseline']],
    ['route-specific-representative-layout', 'routeLayoutOverride', '/synthetic/prettified-route']
])
{
    test(`aggregation request rejects downgrade ${mutation}`, () =>
    {
        assert.ok(layoutAggregationMutationIds.includes(mutation));
        reject((request) =>
        {
            request[field] = value;
        }, 'request-invalid');
    });
}


test('fresh plan cannot pair changed ledger with old independently sealed composition identities', () =>
{
    reject((request, context) =>
    {
        context.inputs = structuredClone(inputs);
        context.inputs.ledger.entries[0].rationale += ' synthetic current authority drift';
        request.planDigest = createLayoutAggregationPlan(context.inputs).planDigest;
    }, 'identity-drift');
});

test('unknown, stale and duplicate receipt references are refused', () =>
{
    reject((request, context) =>
    {
        addReference(request, context);
        request.receipts[0].requirementDigest = hash;
    }, 'unregistered-receipt');
    reject((request, context) =>
    {
        addReference(request, context);
        request.receipts.push(request.receipts[0]);
    }, 'receipt-cardinality');
    reject((request, context) =>
    {
        addReference(request, context);
        request.receipts[0].status = 'pass';
    }, 'request-invalid');
});

for (const lane of ['focused', 'static-only', 'not-executed'])
{
    test(`${lane} cannot qualify a full aggregate`, () =>
    {
        const { request, context } = fixture();
        request.lane = lane;
        assert.throws(() => requireFullLayoutAggregate(request, context), { code: 'layout-aggregate-lane-downgrade' });
    });
}

test('CI without renderer remains not-executed and cannot qualify full', () =>
{
    const { request, context } = fixture();
    request.execution = 'not-executed';
    assert.equal(inspectLayoutAggregation(request, context).status, 'not-executed');
    assert.throws(() => requireFullLayoutAggregate(request, context), { code: 'layout-aggregate-lane-downgrade' });
});

test('complete references and claimed mutation kills cannot manufacture producer authority', () =>
{
    const { request, context } = fixture();
    const bytes = Buffer.from('synthetic opaque bytes reused to test authority refusal only');
    const contentDigest = layoutReceiptArtifactDigest(bytes);
    context.artifacts[contentDigest] = bytes;
    request.receipts = plan.requirements.flatMap((entry) => plan.receiptKinds.map((kind) => ({ requirementDigest: entry.requirementDigest, kind, contentDigest })));
    request.mutationResults = layoutAggregationMutationIds.map((id) => ({ id, status: 'killed', evidenceDigests: [contentDigest] }));
    let callbackUsed = false;
    context.verifyProducer = () =>
    {
        callbackUsed = true;
        return { verified: true };
    };
    const diagnostic = inspectLayoutAggregation(request, context);
    assert.equal(diagnostic.referenceCoverage.missingReferences, 0);
    assert.equal(diagnostic.counters.staleMissingEvidence, null);
    assert.equal(diagnostic.counters.uncoveredArchetypes, null);
    assert.equal(diagnostic.counters.failedStaticCompositionChecks, null);
    assert.equal(diagnostic.unverifiedMutationResults.length, 25);
    assert.equal(diagnostic.qualificationEligible, false);
    assert.throws(() => requireFullLayoutAggregate(request, context), { code: 'layout-aggregate-producer-adapter-unavailable' });
    assert.equal(callbackUsed, false);
});

test('mutation interface lists all required controls but reports no product execution', () =>
{
    assert.equal(layoutAggregationMutationIds.length, 25);
    const { request, context } = fixture();
    const result = inspectLayoutAggregation(request, context);
    assert.ok(result.unverifiedMutationResults.every((entry) => entry.status === 'not-executed'));
    assert.equal(result.qualificationEligible, false);
});

test('only existing views-constraints dependency exposes the blocked preflight', () =>
{
    const script = 'tests/frontend/checks/static/check-views-constraints.mjs';
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../../${script}`, import.meta.url))], {
        cwd: fileURLToPath(new URL('../../src/frontend', import.meta.url)),
        env: { ...process.env, FSUSBLOG_LAYOUT_AGGREGATION_PREFLIGHT: '1' }, encoding: 'utf8'
    });
    assert.equal(result.status, 1, result.stderr);
    const diagnostic = result.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).find((entry) => entry.schema === 'fsusblog.layout-aggregation-preflight.v1');
    assert.ok(diagnostic, result.stdout + result.stderr);
    assert.equal(diagnostic.status, 'not-executed');
    assert.equal(diagnostic.qualificationEligible, false);
    assert.equal(diagnostic.requiredArchetypes, 12);
    assert.equal(diagnostic.criticalArchetypes, 8);
    assert.equal(diagnostic.unresolvedStateBindings, 91);
    const packageScripts = JSON.parse(readFileSync(new URL('../../src/frontend/package.json', import.meta.url))).scripts;
    assert.ok(packageScripts['check:views-constraints'].startsWith(`node ../../${script}`));
    assert.ok(!Object.keys(packageScripts).some((key) => /layout.*aggregate|harmony.*runner/.test(key)));
});
