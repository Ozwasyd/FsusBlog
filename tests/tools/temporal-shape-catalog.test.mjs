import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const {validateJsonSchema} = await import(new URL('../../tools/test-matrix/schema-validator/validate.mjs', import.meta.url));
const {verifyTemporalShapeGovernance} = await import(new URL('../../tools/test/check-temporal-shape-governance.mjs', import.meta.url));
const {readTemporalShapeCatalog, temporalShapeDigest, validateTemporalShapeCatalog, verifyAuthSessionPolicyRoles} = await import(new URL('../../tools/test/temporal-shape-catalog.mjs', import.meta.url));
const {readTemporalDomainProducerInventory} = await import(new URL('../../tools/test/temporal-role-resolver.mjs', import.meta.url));
const repositoryRoot = path.resolve(import.meta.dirname, '../..');

function clone(value)
{
    return structuredClone(value);
}

function resign(shape)
{
    shape.contentDigest = temporalShapeDigest(shape);
    return shape;
}

test('temporal shape catalog is the closed versioned schema and fixed matrix authority', () =>
{
    const state = readTemporalShapeCatalog();
    const schema = JSON.parse(readFile('config/testing/temporal-shape-catalog.schema.json'));
    assert.deepEqual(validateJsonSchema(state.catalog, schema), []);
    assert.equal(state.roleIds.size, 64);
    assert.equal(state.shapeIds.size, 15);
    assert.deepEqual(
        new Set(state.catalog.requiredBoundaryTags),
        new Set(state.catalog.shapes.flatMap((shape) => shape.boundaryTags))
    );
    assert.equal(JSON.stringify(state.catalog).match(/\d{4}-\d{2}-\d{2}T/gu), null);
    assert.ok(state.catalog.roleRegistry.some((role) =>
        role.id === 'metadata.generated-at'
        && role.clockKind === 'artifact-metadata'
        && role.semanticEffect === 'excluded'));
});

test('semantic role registry covers content session security audit messaging preference and scale owners', () =>
{
    const { catalog } = readTemporalShapeCatalog();
    const roles = new Set(catalog.roleRegistry.map((role) => role.id));
    for (const roleId of [
        'article.created',
        'article.published',
        'article.metadata-updated',
        'article.revision',
        'article.publication',
        'comment.created',
        'comment.edited',
        'comment.moderated',
        'session.authenticated',
        'session.last-seen',
        'session.idle-expiry',
        'session.absolute-expiry',
        'session.persistent-idle-expiry',
        'session.persistent-absolute-expiry',
        'security.risk-occurred',
        'security.risk-expiry',
        'audit.occurred',
        'message.created',
        'notification.event',
        'preference.revision',
        'scale.row-created'
    ])
    {
        assert.equal(roles.has(roleId), true, roleId);
    }
});

test('auth session roles match production standard and remember-me policies', () =>
{
    const state = readTemporalShapeCatalog();
    assert.deepEqual(verifyAuthSessionPolicyRoles(state), {
        shapeId: 'auth-security-messaging-account-lifecycle',
        standardIdleMilliseconds: 7 * 86_400_000,
        standardAbsoluteMilliseconds: 30 * 86_400_000,
        rememberMeIdleMilliseconds: 30 * 86_400_000,
        rememberMeAbsoluteMilliseconds: 90 * 86_400_000
    });
    const shape = state.catalog.shapes
        .find((candidate) => candidate.id === 'auth-security-messaging-account-lifecycle');
    const offsets = new Map(shape.timestampRoles.map((role) => [role.roleId, role.offsetMilliseconds]));
    assert.equal(offsets.get('session.idle-expiry'), 7 * 86_400_000);
    assert.equal(offsets.get('session.absolute-expiry'), 30 * 86_400_000);
    assert.equal(offsets.get('session.persistent-idle-expiry'), 30 * 86_400_000);
    assert.equal(offsets.get('session.persistent-absolute-expiry'), 90 * 86_400_000);
});

test('auth session policy drift fails closed before producers resolve roles', () =>
{
    const state = readTemporalShapeCatalog();
    const staleCatalog = clone(state.catalog);
    const shape = staleCatalog.shapes
        .find((candidate) => candidate.id === 'auth-security-messaging-account-lifecycle');
    shape.timestampRoles.find((role) => role.roleId === 'session.idle-expiry').offsetMilliseconds = 2 * 3_600_000;
    resign(shape);
    const staleState = validateTemporalShapeCatalog(staleCatalog);
    assert.throws(
        () => verifyAuthSessionPolicyRoles(staleState),
        (error) => error.reasonCode === 'temporal.session-policy-drift'
    );

    const missingPolicy = readFile('src/backend/Services/UserLoginWorkflowService.cs')
        .replace('s_rememberMeSessionAbsoluteTtl = TimeSpan.FromDays(90)',
            's_rememberMeSessionAbsoluteTtl = TimeSpan.FromHours(1)');
    assert.throws(
        () => verifyAuthSessionPolicyRoles(state, { loginSource: missingPolicy }),
        (error) => error.reasonCode === 'temporal.session-policy-drift'
    );
});

test('catalog rejects tamper duplicate and unknown role ownership', () =>
{
    const original = readTemporalShapeCatalog().catalog;
    const tampered = clone(original);
    tampered.shapes[0].timestampRoles[0].offsetMilliseconds -= 1;
    assert.throws(
        () => validateTemporalShapeCatalog(tampered),
        (error) => error.reasonCode === 'temporal.catalog-tamper'
    );

    const duplicateRole = clone(original);
    duplicateRole.roleRegistry.push(clone(duplicateRole.roleRegistry[0]));
    assert.throws(
        () => validateTemporalShapeCatalog(duplicateRole),
        /duplicate roleRegistry ID/u
    );

    const unknownRole = clone(original);
    unknownRole.shapes[0].timestampRoles[0].roleId = 'fixture.unknown';
    resign(unknownRole.shapes[0]);
    assert.throws(
        () => validateTemporalShapeCatalog(unknownRole),
        /unknown or duplicate role/u
    );
});

test('catalog rejects invalid ordering expiry and same-timestamp offset evasions', () =>
{
    const original = readTemporalShapeCatalog().catalog;
    const invalidOrdering = clone(original);
    invalidOrdering.shapes[0].timestampRoles[0].offsetMilliseconds = 1;
    resign(invalidOrdering.shapes[0]);
    assert.throws(
        () => validateTemporalShapeCatalog(invalidOrdering),
        (error) => error.reasonCode === 'temporal.ordering-invalid'
    );

    const invalidExpiry = clone(original);
    const expiry = invalidExpiry.shapes.find((shape) => shape.id === 'expiry-before');
    expiry.expiryBoundaries[0].relation = 'after';
    resign(expiry);
    assert.throws(
        () => validateTemporalShapeCatalog(invalidExpiry),
        (error) => error.reasonCode === 'temporal.expiry-invalid'
    );

    const randomizedTie = clone(original);
    const tie = randomizedTie.shapes.find((shape) => shape.id === 'same-timestamp-tie');
    tie.timestampRoles[1].offsetMilliseconds = 1;
    resign(tie);
    assert.throws(
        () => validateTemporalShapeCatalog(randomizedTie),
        (error) => error.reasonCode === 'temporal.randomized-tie-break'
    );
});

test('catalog rejects absolute dates incomplete matrix and metadata/business clock mixing', () =>
{
    const original = readTemporalShapeCatalog().catalog;
    const absolute = clone(original);
    absolute.roleOwners[0].source = '2024-01-01T00:00:00Z';
    assert.throws(
        () => validateTemporalShapeCatalog(absolute),
        (error) => error.reasonCode === 'temporal.absolute-date-authority'
    );

    const incomplete = clone(original);
    incomplete.shapes.find((shape) => shape.id === 'dst-forward').boundaryTags = [];
    resign(incomplete.shapes.find((shape) => shape.id === 'dst-forward'));
    assert.throws(
        () => validateTemporalShapeCatalog(incomplete),
        (error) => error.reasonCode === 'temporal.matrix-incomplete'
    );

    const metadataMix = clone(original);
    metadataMix.roleRegistry.find((role) => role.id === 'metadata.generated-at').semanticEffect = 'included';
    assert.throws(
        () => validateTemporalShapeCatalog(metadataMix),
        (error) => error.reasonCode === 'temporal.metadata-semantic-mix'
    );
});

test('static governance rejects a second scenario table private offsets and all-fields-same-time', () =>
{
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-temporal-governance-'));
    try
    {
        const second = path.join(temporary, 'second-temporal-scenarios.json');
        writeFileSync(second, JSON.stringify({
            schema: 'fsusblog.temporal-shape-catalog.v1',
            roleRegistry: [],
            shapes: []
        }));
        assert.throws(
            () => verifyTemporalShapeGovernance({
                configFiles: [
                    path.join(repositoryRoot, 'config/testing/temporal-shape-catalog.json'),
                    second
                ]
            }),
            /exactly one temporal scenario\/role authority/u
        );

        const inventory = readTemporalDomainProducerInventory();
        const source = inventory.producerBindings[0].implementations[0];
        assert.throws(
            () => verifyTemporalShapeGovernance({
                sourceOverrides: new Map([[
                    source,
                    'const privateEpoch = Date.now(); const timestamp = base.AddMinutes(1);'
                ]])
            }),
            /host Date\.now.*private offset arithmetic/u
        );

        const authProducerPath = 'tests/frontend/support/session-fixtures.mjs';
        const authProducer = readFile(authProducerPath).replace(
            "rememberMe ? 'session.persistent-absolute-expiry' : 'session.absolute-expiry'",
            "'session.absolute-expiry'"
        );
        assert.throws(
            () => verifyTemporalShapeGovernance({
                sourceOverrides: new Map([[authProducerPath, authProducer]])
            }),
            /lacks exact remember-me absolute expiry role selection/u
        );

        const authEndpointPath = 'src/backend/Modules/Endpoints/LocalAuthFixtureEndpoints.cs';
        const authEndpoint = readFile(authEndpointPath).replace(
            'RequireInstant("session.persistent-idle-expiry")',
            'RequireInstant("session.absolute-expiry")'
        );
        assert.throws(
            () => verifyTemporalShapeGovernance({
                sourceOverrides: new Map([[authEndpointPath, authEndpoint]])
            }),
            /remember-me cookie to persistent idle expiry/u
        );

        const catalogState = readTemporalShapeCatalog();
        const collapsed = clone(catalogState.catalog);
        const lifecycle = collapsed.shapes.at(-1);
        lifecycle.timestampRoles.forEach((role) =>
        {
            role.offsetMilliseconds = 0;
        });
        resign(lifecycle);
        assert.throws(
            () => verifyTemporalShapeGovernance({
                catalogState: { ...catalogState, catalog: collapsed }
            }),
            /collapses every business field/u
        );
    }
    finally
    {
        rmSync(temporary, { recursive: true, force: true });
    }
});

test('current temporal domain producers have zero private clock residue', () =>
{
    const result = verifyTemporalShapeGovernance();
    assert.deepEqual(result, {
        catalogDigest: result.catalogDigest,
        producerCount: 6,
        roleCount: 64,
        shapeCount: 15,
        secondAuthorityCount: 0,
        residualPrivateClockCount: 0
    });
});

test('readiness delay classification is exact and never permits business sleeps', () =>
{
    const sourcePath = 'src/backend/Services/Fixtures/MessagingFixtureSeeder.cs';
    const source = readFile(sourcePath);
    const ledger = JSON.parse(readFile('config/testing/temporal-callsite-dispositions.json'));
    const index = ledger.entries.findIndex((entry) => entry.callSiteId === 'backend.messaging-outbox-readiness');
    assert.ok(index >= 0);
    const anchor = ledger.entries[index].sourceAnchor;
    for (const altered of [
        `${source}\nawait Task.Delay(60_000);`,
        `${source}\nThread.Sleep(60_000);`,
        source.replace(anchor, 'await Task.Delay(TimeSpan.FromSeconds(60), cancellationToken);'),
        `${source}\n${anchor}`
    ])
    {
        assert.throws(() => verifyTemporalShapeGovernance({ sourceOverrides: new Map([[sourcePath, altered]]) }),
            /retains real sleep/u);
    }
    for (const [field, value] of [
        ['clockKind', 'business-wall'],
        ['disposition', 'unknown'],
        ['authorityKind', 'canonical-business-epoch'],
        ['ingress', 'canonical-injected'],
        ['semanticEffect', 'included']
    ])
    {
        const alteredLedger = clone(ledger);
        alteredLedger.entries[index][field] = value;
        assert.throws(() => verifyTemporalShapeGovernance({ temporalLedger: alteredLedger }), /retains real sleep/u);
    }
});

function readFile(relative)
{
    return readFileSync(path.join(repositoryRoot, relative), 'utf8');
}

test('entity temporal shape keeps nullable lifecycle closure separate from the original scalar matrix', () =>
{
    const state = readTemporalShapeCatalog();
    assert.equal(state.shapeIds.size, 15);
    assert.equal(state.entityShapeIds.size, 1);
    const shape = state.catalog.entityShapes[0];
    assert.equal(shape.schema, 'fsusblog.temporal-entity-shape.v1');
    const comment = shape.entityKinds.find((kind) => kind.kind === 'comment');
    assert.deepEqual(comment.roles.map((role) => role.roleId), ['comment.created', 'comment.edited', 'comment.moderated']);
    const incomplete = clone(state.catalog);
    incomplete.entityShapes[0].entityKinds.find((kind) => kind.kind === 'comment').roles.splice(1, 1);
    resign(incomplete.entityShapes[0]);
    assert.throws(() => validateTemporalShapeCatalog(incomplete), /complete invariant role closure/u);
});
