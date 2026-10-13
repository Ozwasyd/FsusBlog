import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crc32 } from 'node:zlib';

const {CanonicalMediaAssetStore} = await import(new URL('../../tools/test-fixtures/canonical-media-asset-store.mjs', import.meta.url));
const {generatePositiveMediaBytes, inspectMediaBytes, materializePositiveMedia, scanPositiveMediaGeneratorGovernance, verifyPositiveMediaReceipts} = await import(new URL('../../tools/test-fixtures/media-positive-generator.mjs', import.meta.url));
const {MEDIA_POSITIVE_SHAPE_IDS, loadMediaShapeCatalog, mediaContentDigest} = await import(new URL('../../tools/test-fixtures/media-shape-catalog.mjs', import.meta.url));
function fixture(namespace = 'media-positive-test')
{
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'fsusblog-media-positive-'));
    const assetRoot = path.join(directory, 'assets');
    const store = new CanonicalMediaAssetStore({ root: assetRoot, runNamespace: namespace });
    return {
        directory,
        assetRoot,
        store,
        cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
    };
}

test('raster receipts bind real RGBA pixels and reject framed PNG with invalid compressed payload', () =>
{
    const catalog = loadMediaShapeCatalog();
    const shape = catalog.shapes.find((item) => item.id === 'png-alpha');
    const generated = generatePositiveMediaBytes(shape, catalog);
    assert.equal(generated.facts.codec.pillow, '12.3.0');
    assert.match(generated.facts.pixelDigest, /^sha256:[a-f0-9]{64}$/u);
    const bad = Buffer.from(generated.bytes);
    const idatLength = bad.readUInt32BE(33);
    bad[41] = 0;
    bad.writeUInt32BE(crc32(bad.subarray(37, 41 + idatLength)), 41 + idatLength);
    assert.throws(() => inspectMediaBytes(bad, shape), /decode refused|codec refusal/);
});

test('fresh codec processes fail closed for unavailable tooling and actual version drift', () =>
{
    const catalog = loadMediaShapeCatalog();
    const bytes = generatePositiveMediaBytes(catalog.shapes.find((item) => item.id === 'raster-small'), catalog).bytes;
    const verifier = new URL('../../tools/test-fixtures/media-codec-verifier.mjs', import.meta.url).href;
    const code = `import { verifyDecodedMediaBytes } from ${JSON.stringify(verifier)};
        try { verifyDecodedMediaBytes(Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64')); process.exitCode = 2; }
        catch (error) { console.log(error.message); }`;
    const unavailable = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 10_000
    });
    assert.equal(unavailable.status, 0);
    assert.match(unavailable.stdout, /codec unavailable.*ENOENT/);
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'fsusblog-media-codec-drift-'));
    try
    {
        fs.writeFileSync(path.join(directory, 'sitecustomize.py'), "import PIL\nPIL.__version__ = '0.0.0'\n");
        const drift = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
            env: { ...process.env, PYTHONPATH: directory }, encoding: 'utf8', timeout: 10_000
        });
        assert.equal(drift.status, 0);
        assert.match(drift.stdout, /media codec version drift/);
    }
    finally
    {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('generator rejects resealed-free shape overrides and receipts with stale catalog or pixel identities', () =>
{
    const catalog = loadMediaShapeCatalog();
    const shape = catalog.shapes.find((item) => item.id === 'png-alpha');
    assert.throws(() => generatePositiveMediaBytes({ ...shape, width: 32 }, catalog), /exact current catalog shape/);
    const sample = fixture('media-pixel-identity');
    try
    {
        const receipt = materializePositiveMedia({ store: sample.store, shapeIds: ['png-alpha'] }).receipts[0];
        for (const field of ['pixelDigest', 'orientedPixelDigest', 'catalogDigest', 'shapeDigest'])
        {
            const altered = structuredClone(receipt);
            altered[field] = `sha256:${'0'.repeat(64)}`;
            altered.contentDigest = mediaContentDigest(altered);
            assert.match(verifyPositiveMediaReceipts({ receipts: [altered], store: sample.store }).join('\n'), /pixel identity|identity is stale/);
        }
        const noCover = materializePositiveMedia({ store: sample.store, shapeIds: ['no-cover'] }).receipts[0];
        noCover.mediaContentDigest = `sha256:${'0'.repeat(64)}`;
        noCover.contentDigest = mediaContentDigest(noCover);
        assert.match(verifyPositiveMediaReceipts({ receipts: [noCover], store: sample.store }).join('\n'), /no-cover/);
    }
    finally
    {
        sample.cleanup();
    }
});

test('all positive catalog shapes materialize as independently verified real media or explicit no-cover', () =>
{
    const sample = fixture();
    try
    {
        const result = materializePositiveMedia({ store: sample.store });
        assert.deepEqual(result.receipts.map((item) => item.shapeId), MEDIA_POSITIVE_SHAPE_IDS);
        assert.deepEqual(verifyPositiveMediaReceipts({ receipts: result.receipts, store: sample.store }), []);
        const noCover = result.receipts.find((item) => item.shapeId === 'no-cover');
        assert.equal(noCover.assetId, null);
        assert.equal(noCover.storageRef, null);
        assert.equal(noCover.explicitNoCover, true);
        assert.equal(result.receipts.filter((item) => item.assetId !== null).length, 9);
        assert.deepEqual(new Set(result.receipts.filter((item) => item.assetId).map((item) => item.format)), new Set(['jpeg', 'png', 'svg', 'webp']));
        assert.equal(result.receipts.some((item) => item.orientation === 6), true);
        assert.equal(result.receipts.some((item) => item.format === 'png' && item.alpha === true), true);
        assert.equal(result.receipts.some((item) => item.format === 'png' && item.alpha === false), true);
        assert.doesNotMatch(JSON.stringify(result.receipts), new RegExp(sample.directory.replaceAll('\\', '\\\\'), 'u'));
    }
    finally
    {
        sample.cleanup();
    }
});

test('generation is byte deterministic while AssetId ownership remains run scoped', () =>
{
    const catalog = loadMediaShapeCatalog();
    const shape = catalog.shapes.find((item) => item.id === 'png-alpha');
    const firstBytes = generatePositiveMediaBytes(shape, catalog);
    const secondBytes = generatePositiveMediaBytes(shape, catalog);
    assert.deepEqual(secondBytes.bytes, firstBytes.bytes);
    assert.equal(secondBytes.facts.byteDigest, firstBytes.facts.byteDigest);
    assert.equal(secondBytes.facts.decodedDigest, firstBytes.facts.decodedDigest);

    const first = fixture('media-run-one');
    const second = fixture('media-run-two');
    try
    {
        const firstReceipt = materializePositiveMedia({ store: first.store, shapeIds: [shape.id] }).receipts[0];
        const secondReceipt = materializePositiveMedia({ store: second.store, shapeIds: [shape.id] }).receipts[0];
        assert.notEqual(secondReceipt.assetId, firstReceipt.assetId);
        assert.equal(secondReceipt.mediaContentDigest, firstReceipt.mediaContentDigest);
        assert.equal(secondReceipt.byteDigest, firstReceipt.byteDigest);
    }
    finally
    {
        first.cleanup();
        second.cleanup();
    }
});

test('owned materialization is idempotent, content-bound, reloadable, and cleanup-isolated', () =>
{
    const sample = fixture('media-owned-run');
    const other = fixture('media-other-run');
    try
    {
        const receipt = materializePositiveMedia({ store: sample.store, shapeIds: ['raster-small'] }).receipts[0];
        const rerun = materializePositiveMedia({ store: sample.store, shapeIds: ['raster-small'] }).receipts[0];
        assert.equal(rerun.assetId, receipt.assetId);
        assert.equal(rerun.status, 'reused');

        const reopened = new CanonicalMediaAssetStore({ root: sample.assetRoot, runNamespace: 'media-owned-run' });
        assert.deepEqual(verifyPositiveMediaReceipts({ receipts: [receipt], store: reopened }), []);
        assert.throws(() => sample.store.materialize({
            shapeId: 'raster-small',
            extension: '.png',
            bytes: Buffer.from('changed'),
            metadata: {},
            ordinal: 0
        }), /idempotent materialization mismatch/);

        const otherReceipt = materializePositiveMedia({ store: other.store, shapeIds: ['raster-small'] }).receipts[0];
        sample.store.cleanup([{ assetId: otherReceipt.assetId, storageKey: otherReceipt.storageRef.storageKey }]);
        assert.deepEqual(verifyPositiveMediaReceipts({ receipts: [otherReceipt], store: other.store }), []);
        sample.store.cleanup([{ assetId: receipt.assetId, storageKey: receipt.storageRef.storageKey }]);
        assert.throws(() => sample.store.read({ assetId: receipt.assetId, storageKey: receipt.storageRef.storageKey, byteDigest: receipt.byteDigest }), /not owned/);
    }
    finally
    {
        sample.cleanup();
        other.cleanup();
    }
});

test('zero, one, one thousand, and large-raster plans remain bounded', { timeout: 30_000 }, () =>
{
    const sample = fixture('media-bounds-run');
    try
    {
        const zero = materializePositiveMedia({ store: sample.store, shapeIds: ['raster-small'], replicas: 0 });
        assert.deepEqual(zero.receipts, []);
        const one = materializePositiveMedia({ store: sample.store, shapeIds: ['raster-large-bounded'], replicas: 1 });
        assert.equal(one.receipts[0].byteLength < 4 * 1024 * 1024, true);
        assert.equal(one.durationMs < 10_000, true);

        const before = process.memoryUsage().rss;
        const many = materializePositiveMedia({ store: sample.store, shapeIds: ['raster-small'], replicas: 1000 });
        const rssGrowth = process.memoryUsage().rss - before;
        assert.equal(many.receipts.length, 1000);
        assert.equal(many.durationMs < 25_000, true);
        assert.equal(rssGrowth < 256 * 1024 * 1024, true);
        const diskBytes = fs.readdirSync(sample.assetRoot, { recursive: true })
            .map((entry) => path.join(sample.assetRoot, entry))
            .filter((entry) => fs.statSync(entry).isFile())
            .reduce((total, entry) => total + fs.statSync(entry).size, 0);
        assert.equal(diskBytes < 8 * 1024 * 1024, true);
        assert.deepEqual(verifyPositiveMediaReceipts({ receipts: many.receipts, store: sample.store }), []);
    }
    finally
    {
        sample.cleanup();
    }
});

test('independent verification rejects format, bytes, metadata, and receipt drift', () =>
{
    const sample = fixture('media-tamper-run');
    try
    {
        const catalog = loadMediaShapeCatalog();
        const shape = catalog.shapes.find((item) => item.id === 'png-alpha');
        const generated = generatePositiveMediaBytes(shape, catalog);
        assert.throws(() => inspectMediaBytes(generated.bytes, { ...shape, extension: '.webp' }), /MIME or extension/);
        assert.throws(() => inspectMediaBytes(Buffer.from(generated.bytes.subarray(0, -12)), shape), /incomplete|truncated/);

        const receipt = materializePositiveMedia({ store: sample.store, shapeIds: [shape.id] }).receipts[0];
        const metadataTamper = structuredClone(receipt);
        metadataTamper.dimensions.width += 1;
        metadataTamper.contentDigest = mediaContentDigest(metadataTamper);
        assert.match(verifyPositiveMediaReceipts({ receipts: [metadataTamper], store: sample.store }).join('\n'), /dimensions are invalid/);

        const absolutePathTamper = structuredClone(receipt);
        absolutePathTamper.storageRef.storageKey = '/tmp/stolen.png';
        absolutePathTamper.contentDigest = mediaContentDigest(absolutePathTamper);
        assert.match(verifyPositiveMediaReceipts({ receipts: [absolutePathTamper], store: sample.store }).join('\n'), /record is not owned|storage key is unsafe|storage ref is unsafe/);

        const versionTamper = structuredClone(receipt);
        versionTamper.generator.id = 'fsusblog.deterministic-media-generator.v2';
        versionTamper.contentDigest = mediaContentDigest(versionTamper);
        assert.match(verifyPositiveMediaReceipts({ receipts: [versionTamper], store: sample.store }).join('\n'), /generator identity or version is invalid/);

        fs.appendFileSync(path.join(sample.assetRoot, receipt.storageRef.storageKey), 'tamper');
        assert.match(verifyPositiveMediaReceipts({ receipts: [receipt], store: sample.store }).join('\n'), /stored bytes mismatch/);
    }
    finally
    {
        sample.cleanup();
    }
});

test('static governance rejects remote, fake media, public-path, ambient-codec, default-image, and second-generator mutations', () =>
{
    assert.deepEqual(scanPositiveMediaGeneratorGovernance(), []);
    const errors = scanPositiveMediaGeneratorGovernance({
        source: '',
        additionalSources: [
            ['remote', "fetch('https://example.test/image.png')"],
            ['fake', "format: 'svg', extension: '.webp'"],
            ['public', "fs.writeFileSync(PublicAssetRoot, shape.extension)"],
            ['codec', "child_process.execFile('ImageMagick')"],
            ['font', "const style = 'font-family: system-font'"],
            ['default', "const defaultCover = 'default-cover'"],
            ['second', 'function generateMedia() {}']
        ]
    });
    assert.match(errors.join('\n'), /cannot fetch remote bytes/);
    assert.match(errors.join('\n'), /cannot fake a raster extension or MIME/);
    assert.match(errors.join('\n'), /cannot write directly to a public path/);
    assert.match(errors.join('\n'), /cannot use ambient codecs or fonts/);
    assert.match(errors.join('\n'), /cannot inject a default image/);
    assert.match(errors.join('\n'), /cannot define a second asset generator/);
});
