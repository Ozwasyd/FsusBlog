import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    compositionDigest,
    createCompositionIdentity,
    loadCompositionInputs,
    requireCompositionRuntimeBindings,
    validateCompositionContracts,
    verifyCompositionIdentity
} from '@fsusblog/layout-governance/composition-contracts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const current = loadCompositionInputs({ repositoryRoot });
const copy = () => structuredClone(current);
const contract = (inputs, kind = 'settings') => inputs.matrix.archetypes.find((entry) => entry.kind === kind).compositionContract;

function reject(mutate, expected = /layout-composition-contract/u)
{
    const inputs = copy();
    mutate(inputs);
    assert.throws(() => validateCompositionContracts(inputs), expected);
}

// These identities are synthetic verifier inputs, never published runtime receipts.
function syntheticBaseline(sourceKind = 'local-source')
{
    const baseline = {
        schema: 'fsusblog-design-conformance.fsusui-baseline-identity.v1',
        sourceKind,
        repository: 'Ozwasyd/FsusUI',
        absolutePath: sourceKind === 'local-source' ? '/synthetic/fsusui' : null,
        gitHead: sourceKind === 'local-source' ? 'a'.repeat(40) : null,
        packageVersion: 'synthetic-self-test',
        dirty: false,
        dirtyFingerprint: compositionDigest('synthetic-clean'),
        skillDigest: compositionDigest('synthetic-skill'),
        contractDigests: Object.fromEntries(['stagePolicy', 'classification', 'adjudication', 'uxAcceptance']
            .map((name) => [name, compositionDigest(`synthetic-${name}`)]))
    };
    return { ...baseline, baselineDigest: compositionDigest(baseline) };
}

const identity = (inputs = current, baseline = syntheticBaseline()) => createCompositionIdentity(inputs, {
    sourceCommit: 'b'.repeat(40),
    fsusUIBaselineIdentity: baseline
});

test('sole current matrix defines all twelve contracts and reports unresolved capability/state bindings', () =>
{
    const result = validateCompositionContracts(current);
    assert.equal(result.status, 'contract-defined');
    assert.equal(result.archetypes, 12);
    assert.deepEqual(result.pendingCapabilities.map(({ issue }) => issue), [1814, 1895]);
    assert.equal(result.runtimeFixtureBinding.ownerIssue, 2099);
    assert.ok(result.pendingStateBindings.length >= 12 * 6);
    assert.throws(() => requireCompositionRuntimeBindings(current), /source contract is not acceptance/u);
    assert.equal(Object.hasOwn(result, 'verified'), false);
});

test('missing archetype fails rather than quietly reducing coverage', () =>
{
    reject(({ matrix }) => matrix.archetypes.pop(), /fewer than 12/u);
});

test('duplicate archetype is rejected even with a different route or contract', () =>
{
    reject(({ matrix }) =>
    {
        matrix.archetypes[11] = structuredClone(matrix.archetypes[10]);
        matrix.archetypes[11].path = '/synthetic-duplicate-archetype';
    }, /duplicate archetype/u);
});

test('missing composition contract fails closed', () =>
{
    reject((inputs) =>
    {
        delete inputs.matrix.archetypes[0].compositionContract;
    }, /compositionContract/u);
});

test('unknown archetype and wrong surface/kind pairing fail', () =>
{
    reject(({ matrix }) =>
    {
        matrix.archetypes[0].kind = 'new-unknown-kind';
    });
    reject(({ matrix }) =>
    {
        matrix.archetypes[0].surface = 'admin';
    });
});

for (const field of ['routeOverride', 'cssSelector', 'className', 'sourceFile', 'currentImplementationDerived', 'snapshotBaseline'])
{
    test(`implementation-derived field ${field} is not a contract authority`, () =>
    {
        reject((inputs) =>
        {
            contract(inputs)[field] = 'current-implementation';
        }, /additional properties/u);
    });
}

test('semantic IDs cannot be selectors, paths, wildcards or numeric token copies', () =>
{
    for (const id of ['.settings-card', '#primary', 'src/views/admin/Settings.vue', '*', 'main > header', '16px'])
    {
        reject((inputs) =>
        {
            contract(inputs).primaryRegion.id = id;
        });
    }
});

test('second matrix, second ledger and harmony allowlist fail closed', () =>
{
    reject(({ matrix }) =>
    {
        matrix.secondMatrix = [];
    }, /additional properties/u);
    reject(({ matrix }) =>
    {
        matrix.compositionGovernance.matrixRef = 'tests/frontend/fixtures/second-matrix.json';
    });
    reject(({ matrix }) =>
    {
        matrix.compositionGovernance.ledgerRef = 'tests/frontend/fixtures/second-ledger.json';
    });
    reject(({ matrix }) =>
    {
        matrix.harmonyAllowlist = ['settings'];
    }, /additional properties/u);
});

test('multiple primary owners without state mutual exclusion fail', () =>
{
    reject((inputs) =>
    {
        contract(inputs).actionPriority.primaryOwnerId = ['settings-task-owner', 'settings-risk-owner'];
    });
    reject((inputs) =>
    {
        contract(inputs).actionPriority.primaryOwnerIds = ['settings-task-owner', 'settings-risk-owner'];
    });
});

test('same owner cannot simultaneously be primary and secondary', () =>
{
    reject((inputs) =>
    {
        contract(inputs, 'form').actionPriority.secondaryOwnerIds.push('document-content-owner');
    }, /same-priority/u);
});

test('exclusive primary actions use all and only one declared semantic state dimension', () =>
{
    const inputs = copy();
    const form = contract(inputs, 'form');
    const states = form.requiredStateFixtures.filter(({ dimensionId }) => dimensionId === 'content-state');
    form.actionPriority = {
        kind: 'exclusive-states',
        stateDimensionId: 'content-state',
        cases: states.map(({ id }) => ({ stateId: id, primaryCardinality: 1, primaryOwnerId: form.primaryRegion.ownerId, primaryActionId: 'commit-current-document', secondaryActions: [] }))
    };
    assert.equal(validateCompositionContracts(inputs).status, 'contract-defined');
    form.actionPriority.cases[1].stateId = form.actionPriority.cases[0].stateId;
    assert.throws(() => validateCompositionContracts(inputs), /exclusive action state|duplicate items/u);
    form.actionPriority.cases.pop();
    assert.throws(() => validateCompositionContracts(inputs));
});

test('settings tabs retain one submit authority with explicit passive media state', () =>
{
    const settings = contract(current);
    assert.equal(settings.actionPriority.kind, 'exclusive-states');
    assert.deepEqual(settings.actionPriority.cases.map(({ stateId, primaryActionId }) => [stateId, primaryActionId]), [
        ['tab-site', 'save-site-settings'],
        ['tab-compliance', 'save-compliance-settings'],
        ['tab-pages', 'publish-page'],
        ['tab-media', null]
    ]);
    assert.deepEqual([...new Set(settings.actionPriority.cases.filter(({ primaryCardinality }) => primaryCardinality === 1)
        .map(({ primaryOwnerId }) => primaryOwnerId))], ['task-heading-owner']);
    const media = settings.actionPriority.cases.find(({ stateId }) => stateId === 'tab-media');
    assert.equal(media.primaryCardinality, 0);
    assert.deepEqual(media.secondaryActions, [{ ownerId: 'upload-options-owner', actionId: 'reset-upload-options' }]);
    reject((inputs) =>
    {
        contract(inputs).actionPriority.cases.pop();
    }, /every referenced state/u);
});

test('settings data, status and risk regions retain explicit permitted roles and necessary nesting', () =>
{
    const settings = contract(current);
    for (const regionId of ['upload-preview', 'search-preview', 'footer-preview'])
    {
        assert.equal(settings.surfaceRoles.find((surface) => surface.regionId === regionId).role, 'data-region');
        assert.ok(settings.allowedSurfaceNesting.pairs.some((pair) => pair.parentRegionId === 'settings-task' && pair.childRegionId === regionId));
    }
    assert.equal(settings.surfaceRoles.find(({ regionId }) => regionId === 'settings-status').role, 'status');
    assert.equal(settings.surfaceRoles.find(({ regionId }) => regionId === 'settings-risk').role, 'risk');
});

test('unrelated inline-empty fixture does not claim settings loading or save coverage', () =>
{
    reject((inputs) =>
    {
        const source = 'tests/frontend/fixtures/admin-inline-empty-state-contract.json';
        inputs.fixtureDocuments[source] = JSON.parse(readFileSync(resolve(repositoryRoot, source), 'utf8'));
        contract(inputs).requiredStateFixtures.find(({ id }) => id === 'initial-loading').fixtureRef = {
            source, pointer: '/visualDiagnostics/states'
        };
    }, /unrelated fixture/u);
    const settings = contract(current);
    assert.equal(settings.requiredStateFixtures.find(({ id }) => id === 'icon-generation-partial').fixtureRef, null);
    assert.ok(settings.requiredStateFixtures.every(({ bindingStatus }) => bindingStatus === 'pending-current-run'));
});

test('free-text or incompletely enumerated action exceptions cannot replace mutually exclusive states', () =>
{
    reject((inputs) =>
    {
        contract(inputs).actionPriority.kind = 'as-needed';
    });
    reject((inputs) =>
    {
        contract(inputs, 'form').actionPriority = {
            kind: 'exclusive-states',
            stateDimensionId: 'content-state',
            cases: ['empty', 'loading'].map((stateId) => ({ stateId, primaryCardinality: 1, primaryOwnerId: 'document-content-owner', primaryActionId: 'commit-current-document', secondaryActions: [] }))
        };
    }, /every referenced state/u);
});

test('unknown or unowned surface roles fail', () =>
{
    reject((inputs) =>
    {
        contract(inputs).surfaceRoles[0].role = 'private-card';
    });
    reject((inputs) =>
    {
        contract(inputs).surfaceRoles[0].regionId = 'unowned-region';
    }, /unowned region/u);
    reject((inputs) =>
    {
        contract(inputs).surfaceRoles.pop();
    }, /missing surface role/u);
});

test('copied token constants and token drift cannot establish a new geometry authority', () =>
{
    for (const value of [16, 17, 'var(--fsus-space-4)', '16px'])
    {
        reject((inputs) =>
        {
            contract(inputs).spacingTokenCopy = value;
        }, /additional properties/u);
        reject((inputs) =>
        {
            contract(inputs).allowedSurfaceNesting.maximumPadding = value;
        }, /additional properties/u);
    }
});

test('local/published cannot select different composition contracts', () =>
{
    reject((inputs) =>
    {
        contract(inputs).modeOverrides = { local: {}, published: {} };
    }, /additional properties/u);
    reject(({ matrix }) =>
    {
        matrix.compositionGovernance.publishedContracts = [];
    }, /additional properties/u);
    const local = identity(current, syntheticBaseline('local-source'));
    const published = identity(current, syntheticBaseline('package-pin'));
    assert.equal(local.compositionContractDigest, published.compositionContractDigest);
    assert.equal(local.contractSchemaDigest, published.contractSchemaDigest);
    assert.equal(local.designSourceDigest, published.designSourceDigest);
    assert.notEqual(local.fsusUIBaselineIdentityDigest, published.fsusUIBaselineIdentityDigest);
});

test('missing required state, viewport, theme and evidence are rejected', () =>
{
    reject((inputs) =>
    {
        contract(inputs).requiredStateFixtures = [];
    });
    reject((inputs) =>
    {
        contract(inputs).requiredStateFixtures[0].fixtureRef = {
            source: 'tests/frontend/fixtures/article-editor-production-contract.json', pointer: '/missing-state-enumeration'
        };
    }, /missing required fixture/u);
    reject((inputs) =>
    {
        contract(inputs).requiredViewportThemeMatrix = [];
    });
    reject((inputs) =>
    {
        delete contract(inputs).requiredViewportThemeMatrix[0].themesRef;
    });
    reject(({ matrix }) =>
    {
        matrix.coverage.themes = ['light'];
    });
    reject(({ matrix }) =>
    {
        matrix.coverage.viewports = ['mobile'];
    });
    reject(({ matrix }) =>
    {
        matrix.coverage.media = ['reduced-motion'];
    });
    reject((inputs) =>
    {
        contract(inputs).requiredEvidenceIds.splice(3, 1);
    });
});

test('required baseline matrix cannot be replaced by a parallel scene reference', () =>
{
    reject((inputs) =>
    {
        contract(inputs).requiredViewportThemeMatrix.shift();
    }, /canonical archetype matrix coverage/u);
});

test('settings card wall, repeated item cards and section/card/card nesting are prohibited', () =>
{
    reject((inputs) =>
    {
        contract(inputs).allowedSurfaceNesting.ordinaryFields = 'card';
    });
    reject((inputs) =>
    {
        contract(inputs).allowedSurfaceNesting.repeatedItems = 'card';
    });
    reject((inputs) =>
    {
        contract(inputs).allowedSurfaceNesting.pairs.push({ parentRegionId: 'settings-task', childRegionId: 'task-sections' });
    }, /card wall/u);
});

test('reading decorative shells cannot become lawful by declaring a FsusUI role', () =>
{
    reject((inputs) =>
    {
        contract(inputs, 'reading').allowedSurfaceNesting.decorativeShells = 'allowed';
    });
    reject((inputs) =>
    {
        contract(inputs, 'reading').surfaceRoles[0].material = 'boundary';
    }, /decorative/u);
    reject((inputs) =>
    {
        contract(inputs, 'reading').surfaceRoles[0].role = 'data-region';
        contract(inputs, 'reading').surfaceRoles[0].material = 'boundary';
    }, /flat document/u);
});

test('missing main focus/content-order/flat-material intent cannot bless a bad baseline', () =>
{
    for (const predicate of ['single-primary-focus', 'content-order-preserved', 'border-first-material', 'non-decorative-restraint'])
    {
        reject((inputs) =>
        {
            contract(inputs).firstFoldInvariants = contract(inputs).firstFoldInvariants.filter((invariant) => invariant.predicate !== predicate);
        });
    }
    reject((inputs) =>
    {
        contract(inputs).currentBadBaselineApproved = true;
    }, /additional properties/u);
});

test('unowned actions/headings, incomplete order and competing anchors fail', () =>
{
    reject((inputs) =>
    {
        contract(inputs, 'form').actionPriority.primaryOwnerId = 'unknown-owner';
    }, /unowned action/u);
    reject((inputs) =>
    {
        contract(inputs).pageHeadingOwner.id = 'unknown-owner';
    }, /unowned action/u);
    reject((inputs) =>
    {
        contract(inputs).contentOrder.pop();
    }, /content order/u);
    reject((inputs) =>
    {
        contract(inputs).primaryVisualAnchor.regionId = 'settings-risk';
    }, /competing primary/u);
});

test('duplicate fixed chrome responsibilities and nesting cycles fail closed', () =>
{
    reject((inputs) =>
    {
        const c = contract(inputs);
        c.fixedChromeOwners.push({ ...c.fixedChromeOwners[0], id: 'settings-task-owner' });
    }, /fixed chrome responsibility/u);
    reject((inputs) =>
    {
        contract(inputs).allowedSurfaceNesting.pairs.push({ parentRegionId: 'settings-task', childRegionId: 'settings-task' });
    }, /cyclic nesting/u);
});

test('authority source and capability owner cannot be relabeled or filled with a guessed sibling commit', () =>
{
    reject(({ matrix }) =>
    {
        matrix.compositionGovernance.designSources[0].repository = 'FsusBlog';
    });
    reject(({ authorityDocuments }) =>
    {
        delete authorityDocuments['fsusui-design'];
    }, /design source/u);
    reject(({ matrix }) =>
    {
        matrix.compositionGovernance.capabilityBindings[0].sourceCommit = 'f'.repeat(40);
    });
    reject(({ matrix }) =>
    {
        matrix.compositionGovernance.capabilityBindings[0].capability = 'fsusui-control-origin';
    }, /capability owner/u);
});

test('fresh contract identity verifies without declaring runtime acceptance', () =>
{
    const fresh = identity();
    assert.equal(verifyCompositionIdentity(fresh, fresh), true);
    assert.equal(Object.hasOwn(fresh, 'verified'), false);
    assert.equal(Object.hasOwn(fresh, 'staticResults'), false);
});

test('design document byte drift invalidates old evidence', () =>
{
    const before = identity();
    const inputs = copy();
    inputs.authorityDocuments['fsusui-design'].content += '\nSynthetic changed design authority.\n';
    const after = identity(inputs);
    assert.notEqual(before.designSourceDigest, after.designSourceDigest);
    assert.throws(() => verifyCompositionIdentity(before, after), /stale designSourceDigest/u);
});

test('semantic contract and schema drift invalidate old evidence', () =>
{
    const before = identity();
    const inputs = copy();
    contract(inputs).primaryVisualAnchor.id = 'settings-task-new-anchor';
    assert.throws(() => verifyCompositionIdentity(before, identity(inputs)), /stale/u);
    const schemaInputs = copy();
    schemaInputs.schema.title += ' (changed schema)';
    assert.throws(() => verifyCompositionIdentity(before, identity(schemaInputs)), /stale contractSchemaDigest/u);
    const validatorInputs = copy();
    validatorInputs.validatorSource += '\n// synthetic validator drift\n';
    assert.throws(() => verifyCompositionIdentity(before, identity(validatorInputs)), /stale validatorDigest/u);
});

test('fixture, representative-route and visual-ledger drift invalidate evidence without changing semantic contract', () =>
{
    const before = identity();
    const fixtures = copy();
    fixtures.fixtureDocuments['tests/frontend/e2e/visual/console-visual.spec.ts'] += '\n// synthetic fixture drift\n';
    assert.throws(() => verifyCompositionIdentity(before, identity(fixtures)), /stale fixtureSourceDigest/u);
    const routes = copy();
    routes.matrix.archetypes.find(({ kind }) => kind === 'settings').path = '/synthetic-other-settings';
    const after = identity(routes);
    assert.equal(before.compositionContractDigest, after.compositionContractDigest);
    assert.throws(() => verifyCompositionIdentity(before, after), /stale archetypeMatrixDigest/u);
    const ledger = copy();
    ledger.ledger.entries[0].rationale += ' Synthetic drift.';
    assert.throws(() => verifyCompositionIdentity(before, identity(ledger)), /stale visualLedgerDigest/u);
});

test('stale source, FsusUI baseline, content tamper and unowned receipt fields are rejected', () =>
{
    const before = identity();
    const source = createCompositionIdentity(current, { sourceCommit: 'c'.repeat(40), fsusUIBaselineIdentity: syntheticBaseline() });
    assert.throws(() => verifyCompositionIdentity(before, source), /stale sourceCommit/u);
    assert.throws(() => verifyCompositionIdentity(before, identity(current, syntheticBaseline('package-pin'))), /stale/u);
    assert.throws(() => verifyCompositionIdentity({ ...before, compositionContractDigest: '0'.repeat(64) }, before), /tampered/u);
    assert.throws(() => verifyCompositionIdentity({ ...before, ignoredExceptions: [] }, before), /unowned/u);
    const baseline = syntheticBaseline();
    baseline.packageVersion = 'tampered-synthetic-package';
    assert.throws(() => identity(current, baseline), /baseline identity tampered/u);
});
