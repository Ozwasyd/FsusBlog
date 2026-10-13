import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
const {MEDIA_ASPECT_IDS, MEDIA_CONSUMER_CLASSES, MEDIA_FORMAT_IDS, MEDIA_NEGATIVE_SHAPE_IDS, MEDIA_POSITIVE_SHAPE_IDS, loadMediaShapeCatalog, scanMediaShapeCatalogAuthority, sealMediaDocument, validateMediaShapeCatalog} = await import(new URL('../../tools/test-fixtures/media-shape-catalog.mjs', import.meta.url));
function mutate(change)
{
    const catalog = loadMediaShapeCatalog();
    change(catalog);
    catalog.shapes = catalog.shapes.map((shape) => sealMediaDocument(shape));
    return sealMediaDocument(catalog);
}

test('nested schema rejects resealed extra fields, wrong primitive types, and malformed registries', () =>
{
    for (const change of [
        (catalog) => { catalog.unapprovedAuthority = true; },
        (catalog) => { catalog.shapes[0].unapprovedAuthority = true; },
        (catalog) => { catalog.formats[0].unapprovedAuthority = true; },
        (catalog) => { catalog.aspects[0].unapprovedAuthority = true; },
        (catalog) => { catalog.shapes[0].width = '12'; },
        (catalog) => { catalog.shapes[0].alpha = 'false'; },
        (catalog) => { catalog.formats[0].supportsAlpha = 'false'; }
    ])
    {
        assert.match(validateMediaShapeCatalog(mutate(change)).join('\n'), /media shape catalog schema:/);
    }
    assert.doesNotThrow(() => validateMediaShapeCatalog({ shapes: [null], formats: null, aspects: null }));
    assert.equal(validateMediaShapeCatalog({ shapes: [null], formats: null, aspects: null }).length > 0, true);
});

test('oriented aspect, crop, bounded dimensions, and digest references cannot be relabeled', () =>
{
    for (const change of [
        (catalog) => { catalog.shapes[0].width += 1; },
        (catalog) => { catalog.aspects[1].width = 4; },
        (catalog) => { catalog.shapes[1].orientation = 1; },
        (catalog) => { catalog.shapes[1].expectedCrop = 'center-safe'; },
        (catalog) => { catalog.shapes[0].width = 9000; catalog.shapes[0].height = 6000; },
        (catalog) => { catalog.shapes[0].byteDigestRef += '-unrelated'; }
    ])
    {
        assert.match(validateMediaShapeCatalog(mutate(change)).join('\n'), /geometry|bounded dimensions|generator refs/);
    }
});

test('negative shapes preserve all source facts outside their single declared fault', () =>
{
    for (const change of [
        (catalog) => { catalog.shapes.find((item) => item.id === 'negative-corrupt-header').orientation = 6; },
        (catalog) => { catalog.shapes.find((item) => item.id === 'negative-mime-extension-mismatch').extension = '.jpg'; },
        (catalog) => { catalog.shapes.find((item) => item.id === 'negative-missing-404').sourceShapeId = 'no-cover'; },
        (catalog) => { catalog.shapes.find((item) => item.id === 'negative-oversized-dimensions').width = 16; }
    ])
    {
        assert.match(validateMediaShapeCatalog(mutate(change)).join('\n'), /single-fault source facts/);
    }
});

test('MediaShapeCatalog is closed, complete, content-addressed, and uniquely owned', () =>
{
    const catalog = loadMediaShapeCatalog();
    assert.deepEqual(validateMediaShapeCatalog(catalog), []);
    assert.deepEqual(scanMediaShapeCatalogAuthority(), []);
    assert.deepEqual(catalog.formats.map((item) => item.id), MEDIA_FORMAT_IDS);
    assert.deepEqual(catalog.aspects.map((item) => item.id), MEDIA_ASPECT_IDS);
    assert.deepEqual(catalog.consumerClasses, MEDIA_CONSUMER_CLASSES);
    assert.deepEqual(
        catalog.shapes.filter((item) => item.validityClass === 'canonical-positive').map((item) => item.id),
        MEDIA_POSITIVE_SHAPE_IDS
    );
    assert.deepEqual(
        catalog.shapes.filter((item) => item.validityClass === 'negative-invalid').map((item) => item.id),
        MEDIA_NEGATIVE_SHAPE_IDS
    );
});

test('positive matrix covers real formats, aspects, orientation, alpha, bounded sizes, and explicit no-cover', () =>
{
    const positives = loadMediaShapeCatalog().shapes.filter((item) => item.validityClass === 'canonical-positive');
    assert.deepEqual(new Set(positives.map((item) => item.format).filter(Boolean)), new Set(MEDIA_FORMAT_IDS));
    assert.equal(positives.some((item) => item.format === 'jpeg' && item.orientation === 6), true);
    assert.equal(positives.some((item) => item.format === 'png' && item.alpha === true), true);
    assert.equal(positives.some((item) => item.format === 'png' && item.alpha === false), true);
    assert.equal(positives.some((item) => item.id === 'webp-landscape'), true);
    assert.equal(positives.some((item) => item.id === 'webp-square'), true);
    assert.equal(positives.some((item) => item.id === 'raster-small'), true);
    assert.equal(positives.some((item) => item.id === 'raster-large-bounded' && item.width * item.height <= 1_080_000), true);
    const noCover = positives.find((item) => item.id === 'no-cover');
    assert.equal(noCover.assetIdentityRequired, false);
    assert.equal(noCover.byteDigestRef, null);
    assert.equal(noCover.expectedFallback, 'explicit-no-cover');
});

test('negative matrix is exact single-fault evidence with unique stable reasons', () =>
{
    const negatives = loadMediaShapeCatalog().shapes.filter((item) => item.validityClass === 'negative-invalid');
    assert.equal(new Set(negatives.map((item) => item.faultCondition)).size, 8);
    assert.equal(new Set(negatives.map((item) => item.expectedFallback)).size, 8);
    assert.equal(negatives.every((item) => item.assetIdentityRequired === false), true);
    assert.equal(negatives.every((item) => item.consumerClasses.join() === 'fallback'), true);
});

test('validator rejects duplicate, unknown, ambiguous, and whole-matrix drift', () =>
{
    assert.match(validateMediaShapeCatalog(mutate((catalog) =>
    {
        catalog.shapes[1].id = catalog.shapes[0].id;
    })).join('\n'), /incomplete or reordered|unique/);
    assert.match(validateMediaShapeCatalog(mutate((catalog) =>
    {
        catalog.shapes[0].format = 'fake-webp';
    })).join('\n'), /unknown format/);
    assert.match(validateMediaShapeCatalog(mutate((catalog) =>
    {
        catalog.shapes[0].validityClass = 'canonical-positive|negative-invalid';
    })).join('\n'), /validity class is invalid/);
    assert.match(validateMediaShapeCatalog(mutate((catalog) =>
    {
        catalog.shapes.pop();
    })).join('\n'), /matrix is incomplete/);
});

test('validator distinguishes format, MIME, extension, magic owner, aspect, and consumer facts', () =>
{
    assert.match(validateMediaShapeCatalog(mutate((catalog) =>
    {
        catalog.shapes.find((item) => item.id === 'webp-square').mime = 'image/png';
    })).join('\n'), /MIME does not match/);
    assert.match(validateMediaShapeCatalog(mutate((catalog) =>
    {
        catalog.shapes.find((item) => item.id === 'webp-square').extension = '.svg';
    })).join('\n'), /extension does not match/);
    assert.match(validateMediaShapeCatalog(mutate((catalog) =>
    {
        catalog.formats.find((item) => item.id === 'webp').factOwner = 'browser-screenshot';
    })).join('\n'), /lacks the independent fact owner/);
    assert.match(validateMediaShapeCatalog(mutate((catalog) =>
    {
        catalog.shapes[0].aspectClass = 'from-file-name';
    })).join('\n'), /unknown aspect/);
    assert.match(validateMediaShapeCatalog(mutate((catalog) =>
    {
        catalog.consumerClasses.pop();
    })).join('\n'), /consumer applicability registry is incomplete/);
});

test('validator rejects paths, URLs, default-cover authority, fake digest refs, and negative pollution', () =>
{
    assert.match(validateMediaShapeCatalog(mutate((catalog) =>
    {
        catalog.shapes[0].storagePath = '/tmp/media.jpg';
    })).join('\n'), /stores a path or public URL/);
    assert.match(validateMediaShapeCatalog(mutate((catalog) =>
    {
        catalog.shapes[0].byteDigestRef = 'https://images.example/media.jpg';
    })).join('\n'), /path or public URL|generator refs/);
    assert.match(validateMediaShapeCatalog(mutate((catalog) =>
    {
        const noCover = catalog.shapes.find((item) => item.id === 'no-cover');
        noCover.assetIdentityRequired = true;
        noCover.byteDigestRef = 'generated:default-cover:bytes';
    })).join('\n'), /no-cover/);
    assert.match(validateMediaShapeCatalog(mutate((catalog) =>
    {
        const negative = catalog.shapes.find((item) => item.validityClass === 'negative-invalid');
        negative.consumerClasses = ['fallback', 'scale'];
    })).join('\n'), /contaminate positive consumers/);
});

test('catalog and per-shape tamper fail even when semantic fields still look valid', () =>
{
    const catalogTamper = loadMediaShapeCatalog();
    catalogTamper.owner = 'media-shape-catalog-tampered';
    assert.match(validateMediaShapeCatalog(catalogTamper).join('\n'), /identity or owner|content digest/);

    const shapeTamper = loadMediaShapeCatalog();
    shapeTamper.shapes[0].width += 1;
    assert.match(validateMediaShapeCatalog(shapeTamper).join('\n'), /content digest is invalid/);
});

test('static authority scan rejects a second media catalog', () =>
{
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'fsusblog-media-catalog-authority-'));
    try
    {
        const config = path.join(directory, 'config/testing');
        fs.mkdirSync(config, { recursive: true });
        fs.writeFileSync(path.join(config, 'media-shape-catalog.json'), JSON.stringify({ owner: 'media-shape-catalog' }));
        fs.writeFileSync(path.join(config, 'second-media-list.json'), JSON.stringify({ owner: 'media-shape-catalog' }));
        assert.match(scanMediaShapeCatalogAuthority({ repositoryRoot: directory }).join('\n'), /must have one authority/);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
