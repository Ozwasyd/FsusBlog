import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs';
import { verifyTemporalShapeGovernance } from '../../tools/test/check-temporal-shape-governance.mjs';
import {
    readTemporalShapeCatalog,
    temporalShapeDigest,
    validateTemporalShapeCatalog
} from '../../tools/test/temporal-shape-catalog.mjs';
import { readTemporalDomainProducerInventory } from '../../tools/test/temporal-role-resolver.mjs';

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
    assert.equal(state.roleIds.size, 63);
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
        producerCount: 3,
        roleCount: 63,
        shapeCount: 15,
        secondAuthorityCount: 0,
        residualPrivateClockCount: 0
    });
});

function readFile(relative)
{
    return readFileSync(path.join(repositoryRoot, relative), 'utf8');
}
