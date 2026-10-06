import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderAedsProtocolOutputs } from '../../tools/frontend/generate-aeds-protocol.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8'));
const goldenPath = 'tests/backend/Fixtures/aeds-golden-catalog.json';
const productPaths = [
    'src/core/Algorithms/AedsFrameType.cs',
    'src/shared/AedsFrameHeader.cs',
    'src/frontend/wasm/web/protocol/frame.ts',
    'src/frontend/wasm/aeds/include/aeds_frame.hpp',
    goldenPath
];
const retainedProductDigests = [
    '8eede212194921ed95ff5922d0ff612c7d1f6a8695a4b375adef8336c4d77373',
    '4a6c9ee5b88414607dfa4bf7400c893112dc2863501a5ada0c795baa57c0edf9',
    'ad076e3362419d936147f2d1ba07cd68a3d2f221b0a5590c9b0bdc6ba9632327',
    '3fc272760a3193c05268697be665e6283ecccf7b1a106def39f2843a3a96f882',
    '3d21d351288b0cdf7c8d9852fda94b108f8111b0ed9e3c941c5453b9f687edaa'
];

function digest(text)
{
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

const originalDefaultEvidence = [
    'tests/backend/Unit/BackendGoldenCatalogTests.cs',
    'tests/backend/Unit/PodBinaryCodecTests.cs',
    'tests/backend/Unit/UserLocalePreferenceCodecAndNormalizeTests.cs'
];

function retainedManifest(frameCount = 236)
{
    const source = structuredClone(manifest);
    source.frameTypes = source.frameTypes.filter((frame) => frame.goldenOrder < frameCount);
    // Historical subsets use their own canonical evidence, before the two private wire families existed.
    source.goldenCatalog.defaultEvidence = [...originalDefaultEvidence];
    return source;
}

function goldenFrom(source)
{
    return JSON.parse(new Map(renderAedsProtocolOutputs(source)).get(goldenPath));
}

test('the original producer owns five products with manifest-derived identities and explicit metadata', () =>
{
    const outputs = renderAedsProtocolOutputs(manifest);
    assert.deepEqual(outputs.map(([file]) => file), productPaths);
    const golden = goldenFrom(manifest);
    assert.equal(golden.version, manifest.goldenCatalog.version);
    assert.equal(golden.generatedFrom, productPaths[0]);
    assert.deepEqual(golden.defaultEvidence, manifest.goldenCatalog.defaultEvidence);
    assert.deepEqual(golden.retiredFrameValues, manifest.retiredFrameValues);
    assert.deepEqual(golden.frames, [...manifest.frameTypes]
        .sort((left, right) => left.goldenOrder - right.goldenOrder)
        .map((frame) => ({ name: frame.name, value: frame.value, family: frame.goldenFamily })));
    assert.equal(golden.frames.length, 260);
});

test('the original 236 golden records, evidence and retirement remain unchanged', () =>
{
    const retained = new Map(renderAedsProtocolOutputs(retainedManifest())).get(goldenPath);
    assert.equal(JSON.parse(retained).frames.length, 236);
    assert.equal(digest(retained), retainedProductDigests[4]);
});

test('the original four renderer outputs and complete golden bytes are preserved for the retained source', () =>
{
    // Original renderer controls remain independent of products, including tracked TS formatting drift.
    const outputs = new Map(renderAedsProtocolOutputs(retainedManifest()));
    for (const [index, file] of productPaths.entries())
    {
        assert.equal(digest(outputs.get(file)), retainedProductDigests[index], file);
    }
});

// Exact five product digests from the original 244-frame source at 162fe4028cf8f97e0a71706107f417b4ab11a749.
// This protects the complete old public identities, order, header/ABI declarations and evidence bytes.
test('all original 244 frames and every old protocol product remain exact before private additions', () =>
{
    const original244Digests = ["ec89e32d33e126d2cd0f90579525c37cb1cc7ef7decbc292d1fe3d1305400d85", "cf91019019f7dee0872c8ba18d0a999205630e05a5af4190dc9a63f7615f6783", "5926df80b86c71d15771ae8b21f17c1b3178e5f388819ae45401d2a38c146e19", "bd886fa5dbdadbde37f3ab17d4d424cf549ba309df60c36e18a193c29f7f7f60", "b6bf43fe315cd1cc736dbd98ba840194aad74071912b194534313f634b86b5f7"];
    const outputs = new Map(renderAedsProtocolOutputs(retainedManifest(244)));
    for (const [index, file] of productPaths.entries())
    {
        assert.equal(digest(outputs.get(file)), original244Digests[index], file);
    }
    assert.deepEqual(goldenFrom(manifest).frames.slice(0, 244), goldenFrom(retainedManifest(244)).frames);
    assert.deepEqual(manifest.goldenCatalog.defaultEvidence, [...originalDefaultEvidence,
        'tests/backend/Unit/AuthoringCanvasWireCodecTests.cs', 'tests/backend/Unit/ArticleCanvasLinkWireCodecTests.cs']);
});

for (const [name, value, family] of [
    ['FontRegistryList', 244, 'font-registry-response'],
    ['FontRegistryDetail', 245, 'font-registry-response'],
    ['FontActivationList', 246, 'font-activation-response'],
    ['ThemeRegistryList', 247, 'theme-registry-response'],
    ['ThemeRegistryDetail', 248, 'theme-registry-response'],
    ['ThemeActivationList', 249, 'theme-activation-response'],
    ['ThemeActivation', 250, 'theme-activation-response'],
    ['ThemeActivationHistory', 252, 'theme-activation-response']
])
{
    test(`the ${name} golden identity comes from the same protocol frame used by every language`, () =>
    {
        const outputs = new Map(renderAedsProtocolOutputs(manifest));
        const source = manifest.frameTypes.find((frame) => frame.name === name);
        assert.equal(source.value, value);
        assert.equal(source.goldenFamily, family);
        assert.deepEqual(goldenFrom(manifest).frames.find((frame) => frame.name === name), { name, value, family });
        for (const file of [productPaths[0], productPaths[1], productPaths[3]])
        {
            assert.ok(outputs.get(file).includes(`${name} = ${value}`), file);
        }
        assert.ok(outputs.get(productPaths[2]).includes(`${name}: ${value},`));
    });
}

for (const [label, mutate, expected] of [
    ['missing golden metadata', (source) => { delete source.goldenCatalog; }, /closed v1 shape/u],
    ['unknown golden metadata field', (source) => { source.goldenCatalog.extra = true; }, /closed v1 shape/u],
    ['unknown catalog version', (source) => { source.goldenCatalog.version = 'unknown'; }, /closed v1 shape/u],
    ['empty evidence', (source) => { source.goldenCatalog.defaultEvidence = []; }, /canonical backend test paths/u],
    ['duplicate evidence', (source) => { source.goldenCatalog.defaultEvidence.push(source.goldenCatalog.defaultEvidence[0]); }, /canonical backend test paths/u],
    ['outside evidence', (source) => { source.goldenCatalog.defaultEvidence[0] = '../outside.cs'; }, /canonical backend test paths/u],
    ['traversing evidence', (source) => { source.goldenCatalog.defaultEvidence[0] = 'tests/backend/../outside.cs'; }, /canonical backend test paths/u],
    ['evidence with terminal LF', (source) => { source.goldenCatalog.defaultEvidence[0] += '\n'; }, /canonical backend test paths/u],
    ['missing family', (source) => { delete source.frameTypes[0].goldenFamily; }, /family is missing or invalid/u],
    ['empty family', (source) => { source.frameTypes[0].goldenFamily = ''; }, /family is missing or invalid/u],
    ['family with terminal LF', (source) => { source.frameTypes[0].goldenFamily += '\n'; }, /family is missing or invalid/u],
    ['missing order', (source) => { delete source.frameTypes[0].goldenOrder; }, /uniquely cover every frame/u],
    ['duplicate order', (source) => { source.frameTypes[0].goldenOrder = source.frameTypes[1].goldenOrder; }, /uniquely cover every frame/u],
    ['negative order', (source) => { source.frameTypes[0].goldenOrder = -1; }, /uniquely cover every frame/u],
    ['out of range order', (source) => { source.frameTypes[0].goldenOrder = source.frameTypes.length; }, /uniquely cover every frame/u],
    ['fractional order', (source) => { source.frameTypes[0].goldenOrder = 0.5; }, /uniquely cover every frame/u],
    ['unannotated registered frame', (source) => { source.frameTypes.push({ name: 'Unannotated', value: 65535 }); }, /family is missing or invalid/u],
    ['removed registered frame leaving a metadata gap', (source) => { source.frameTypes.splice(0, 1); }, /uniquely cover every frame/u],
    ['duplicate frame identity', (source) => { source.frameTypes[1].value = source.frameTypes[0].value; }, /Duplicate frame type value/u],
    ['retired frame reused as active', (source) => { source.frameTypes[0].value = source.retiredFrameValues[0].value; }, /reuses retired value/u],
    ['empty frame collection', (source) => { source.frameTypes = []; }, /complete arrays/u]
])
{
    test(`the original renderer refuses ${label} before any output`, () =>
    {
        const source = structuredClone(manifest);
        mutate(source);
        assert.throws(() => renderAedsProtocolOutputs(source), expected);
    });
}

test('every frame, including future registrations, must explicitly provide complete golden metadata', () =>
{
    const source = structuredClone(manifest);
    source.frameTypes.push({ name: 'FutureFrame', value: 65535, goldenFamily: 'test-response', goldenOrder: source.frameTypes.length });
    const golden = goldenFrom(source);
    assert.deepEqual(golden.frames.at(-1), { name: 'FutureFrame', value: 65535, family: 'test-response' });
});

test('source values and explicit metadata, not old output values, determine the complete catalog', () =>
{
    const source = structuredClone(manifest);
    const frame = source.frameTypes.find((entry) => entry.name === 'FontRegistryList');
    frame.value = 65535;
    frame.goldenFamily = 'test-source-response';
    assert.deepEqual(goldenFrom(source).frames.find((entry) => entry.name === frame.name), {
        name: frame.name,
        value: 65535,
        family: 'test-source-response'
    });
});

const privateFrames = [
    ['AuthoringCanvasCreateRequest', 253], ['AuthoringCanvasDocumentHeader', 254],
    ['AuthoringCanvasListResponse', 255], ['AuthoringCanvasNodesResponse', 256],
    ['AuthoringCanvasEdgesResponse', 257], ['AuthoringCanvasApplyRequest', 258],
    ['AuthoringCanvasOperationReceipt', 259], ['AuthoringCanvasUndoRedoRequest', 260],
    ['AuthoringCanvasHistoryResponse', 261], ['AuthoringCanvasDeleteRequest', 262],
    ['AuthoringCanvasWriteReceipt', 263], ['AuthoringCanvasResolveRequest', 264],
    ['AuthoringCanvasReferenceResolutionBatch', 265], ['ArticleCanvasLinkRequest', 266],
    ['ArticleCanvasLinkReceipt', 267], ['ArticleCanvasLinkHistoryResponse', 268]
];

function assertNativeErrorContract(header, decoder, exports)
{
    // Published master 726ffb95a owns codes 0..9; the three distinct payload families append.
    const originalNames = ['None', 'InvalidInput', 'MagicMismatch', 'PayloadLengthMismatch',
        'VersionMismatch', 'HeaderLengthMismatch', 'PayloadCrcMismatch', 'ArticlePayloadInvalid',
        'FrameTypeUnsupported', 'FrameTypeRetired'];
    const appendedNames = ['FontThemePayloadInvalid', 'AuthoringCanvasPayloadInvalid', 'ArticleCanvasLinkPayloadInvalid'];
    const enumBody = header.match(/enum class ErrorCode : std::uint8_t\s*\{([^}]+)\}/u)?.[1];
    assert.ok(enumBody);
    const entries = [...enumBody.matchAll(/(\w+)\s*=\s*(\d+)/gu)].map(([, name, value]) => [name, Number(value)]);
    assert.deepEqual(entries, [...originalNames, ...appendedNames].map((name, value) => [name, value]));
    assert.equal(new Set(entries.map(([, value]) => value)).size, entries.length);
    for (const [index, error] of ['font_theme_payload_invalid', 'authoring_canvas_payload_invalid', 'article_canvas_link_payload_invalid'].entries())
    {
        assert.ok(decoder.includes(`case ErrorCode::${appendedNames[index]}:\n            return "${error}";`));
        assert.ok(decoder.includes(`return MakeError(ErrorCode::${appendedNames[index]});`));
    }
    assert.ok(exports.includes('t_errorCode = static_cast<std::uint8_t>(Result.error_code);'));
    assert.match(exports, /std::uint8_t get_last_error_code\(\)\s*\{\s*return t_errorCode;\s*\}/u);
}

test('native error export keeps published codes and three distinct current payload failures', () =>
{
    const header = readFileSync(path.join(root, 'src/frontend/wasm/aeds/include/aeds_decode.hpp'), 'utf8');
    const decoder = readFileSync(path.join(root, 'src/frontend/wasm/aeds/src/aeds_decode.cpp'), 'utf8');
    const exports = readFileSync(path.join(root, 'src/frontend/wasm/aeds/src/exports.cpp'), 'utf8');
    assertNativeErrorContract(header, decoder, exports);
    assert.throws(() => assertNativeErrorContract(header.replace('AuthoringCanvasPayloadInvalid = 11', 'AuthoringCanvasPayloadInvalid = 10'), decoder, exports));
    assert.throws(() => assertNativeErrorContract(header.replace('MagicMismatch = 2', 'MagicMismatch = 13'), decoder, exports));
    assert.throws(() => assertNativeErrorContract(header, decoder, exports.replace('return t_errorCode;', 'return 0;')));
    assert.throws(() => assertNativeErrorContract(header, decoder.replace('return MakeError(ErrorCode::ArticleCanvasLinkPayloadInvalid);', 'return MakeError(ErrorCode::InvalidInput);'), exports));
});

test('exactly thirteen Canvas and three Link identities append after all original 244 frames', () =>
{
    const outputs = new Map(renderAedsProtocolOutputs(manifest));
    assert.deepEqual(manifest.frameTypes.slice(244), privateFrames.map(([name, value], index) => ({
        name, value, goldenFamily: index < 13 ? 'private-authoring-canvas' : 'private-article-canvas-link', goldenOrder: 244 + index
    })));
    assert.deepEqual(goldenFrom(manifest).frames.slice(244), privateFrames.map(([name, value], index) => ({
        name, value, family: index < 13 ? 'private-authoring-canvas' : 'private-article-canvas-link'
    })));
    for (const [name, value] of privateFrames)
    {
        for (const file of [productPaths[0], productPaths[1], productPaths[3]])
        {
            assert.ok(outputs.get(file).includes(`${name} = ${value}`), file);
        }
        assert.ok(outputs.get(productPaths[2]).includes(`${name}: ${value},`));
    }
});
