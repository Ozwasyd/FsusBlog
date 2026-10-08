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

function retainedManifest()
{
    const source = structuredClone(manifest);
    source.frameTypes = source.frameTypes.filter((frame) => frame.goldenOrder < 236);
    return source;
}

function goldenFrom(source)
{
    return JSON.parse(new Map(renderAedsProtocolOutputs(source)).get(goldenPath));
}

test('the original producer owns five products with manifest-derived identities and explicit metadata', () =>
{
    const outputs = renderAedsProtocolOutputs(manifest);
    assert.deepEqual(outputs.slice(0, 5).map(([file]) => file), productPaths);
    assert.deepEqual(outputs.slice(5).map(([file]) => file), [
        'src/shared/Contracts/Validation/AedsArticleListWire.Generated.cs',
        'src/frontend/src/generated/aedsArticleListWire.ts',
        'src/frontend/wasm/aeds/include/aeds_article_list_wire.generated.hpp',
        'src/shared/Contracts/Validation/AedsArticleSearchWire.Generated.cs',
        'src/frontend/src/generated/aedsArticleSearchWire.ts',
        'src/frontend/wasm/aeds/include/aeds_article_search_wire.generated.hpp',
        'src/shared/Contracts/Models/CommentPolicySnapshotPod.Generated.cs',
        'src/frontend/src/generated/commentPolicyWire.ts',
        'src/frontend/wasm/aeds/include/comment_policy_wire.generated.hpp',
        'src/shared/Contracts/Models/CommentCreateRequestPod.Generated.cs',
        'src/core/Mapping/Models/CommentCreateRequest.Generated.cs',
        'src/frontend/src/generated/commentCreateWire.ts',
        'src/frontend/wasm/aeds/include/comment_create_wire.generated.hpp'
    ]);
    const golden = goldenFrom(manifest);
    assert.equal(golden.version, manifest.goldenCatalog.version);
    assert.equal(golden.generatedFrom, productPaths[0]);
    assert.deepEqual(golden.defaultEvidence, manifest.goldenCatalog.defaultEvidence);
    assert.deepEqual(golden.retiredFrameValues, manifest.retiredFrameValues);
    assert.deepEqual(golden.frames, [...manifest.frameTypes]
        .sort((left, right) => left.goldenOrder - right.goldenOrder)
        .map((frame) => ({ name: frame.name, value: frame.value, family: frame.goldenFamily })));
    assert.equal(golden.frames.length, 244);
});

test('the original 236 golden records, evidence and retirement remain unchanged', () =>
{
    const retained = new Map(renderAedsProtocolOutputs(retainedManifest())).get(goldenPath);
    assert.equal(JSON.parse(retained).frames.length, 236);
    assert.equal(digest(retained.replace(/\bCommentCreateRequest\b/gu, 'CommentCreateV2Request')), retainedProductDigests[4]);
});

test('the original four renderer outputs and complete golden bytes are preserved for the retained source', () =>
{
    // Original renderer controls remain independent of products, including tracked TS formatting drift.
    const outputs = new Map(renderAedsProtocolOutputs(retainedManifest()));
    for (const [index, file] of productPaths.entries())
    {
        assert.equal(digest(outputs.get(file).replace(/\bCommentCreateRequest\b/gu, 'CommentCreateV2Request')), retainedProductDigests[index], file);
    }
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
    ['missing golden metadata', (source) =>
    {
        delete source.goldenCatalog;
    }, /closed v1 shape/u],
    ['unknown golden metadata field', (source) =>
    {
        source.goldenCatalog.extra = true;
    }, /closed v1 shape/u],
    ['unknown catalog version', (source) =>
    {
        source.goldenCatalog.version = 'unknown';
    }, /closed v1 shape/u],
    ['empty evidence', (source) =>
    {
        source.goldenCatalog.defaultEvidence = [];
    }, /canonical backend test paths/u],
    ['duplicate evidence', (source) =>
    {
        source.goldenCatalog.defaultEvidence.push(source.goldenCatalog.defaultEvidence[0]);
    }, /canonical backend test paths/u],
    ['outside evidence', (source) =>
    {
        source.goldenCatalog.defaultEvidence[0] = '../outside.cs';
    }, /canonical backend test paths/u],
    ['traversing evidence', (source) =>
    {
        source.goldenCatalog.defaultEvidence[0] = 'tests/backend/../outside.cs';
    }, /canonical backend test paths/u],
    ['evidence with terminal LF', (source) =>
    {
        source.goldenCatalog.defaultEvidence[0] += '\n';
    }, /canonical backend test paths/u],
    ['missing family', (source) =>
    {
        delete source.frameTypes[0].goldenFamily;
    }, /family is missing or invalid/u],
    ['empty family', (source) =>
    {
        source.frameTypes[0].goldenFamily = '';
    }, /family is missing or invalid/u],
    ['family with terminal LF', (source) =>
    {
        source.frameTypes[0].goldenFamily += '\n';
    }, /family is missing or invalid/u],
    ['missing order', (source) =>
    {
        delete source.frameTypes[0].goldenOrder;
    }, /uniquely cover every frame/u],
    ['duplicate order', (source) =>
    {
        source.frameTypes[0].goldenOrder = source.frameTypes[1].goldenOrder;
    }, /uniquely cover every frame/u],
    ['negative order', (source) =>
    {
        source.frameTypes[0].goldenOrder = -1;
    }, /uniquely cover every frame/u],
    ['out of range order', (source) =>
    {
        source.frameTypes[0].goldenOrder = source.frameTypes.length;
    }, /uniquely cover every frame/u],
    ['fractional order', (source) =>
    {
        source.frameTypes[0].goldenOrder = 0.5;
    }, /uniquely cover every frame/u],
    ['unannotated registered frame', (source) =>
    {
        source.frameTypes.push({ name: 'Unannotated', value: 65535 });
    }, /family is missing or invalid/u],
    ['removed registered frame leaving a metadata gap', (source) =>
    {
        source.frameTypes.splice(0, 1);
    }, /uniquely cover every frame/u],
    ['duplicate frame identity', (source) =>
    {
        source.frameTypes[1].value = source.frameTypes[0].value;
    }, /Duplicate frame type value/u],
    ['retired frame reused as active', (source) =>
    {
        source.frameTypes[0].value = source.retiredFrameValues[0].value;
    }, /reuses retired value/u],
    ['empty frame collection', (source) =>
    {
        source.frameTypes = [];
    }, /complete arrays/u]
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
    source.frameTypes.push({ name: 'FutureFrame', value: 65535, goldenFamily: 'test-response', goldenOrder: 244 });
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

for (const mutation of ['missing-field', 'overlap', 'old-size'])
{
    test(`current comment policy authority refuses ${mutation}`, () =>
    {
        const source = structuredClone(manifest);
        const wire = source.payloadLayouts.CommentPolicySnapshot;
        if (mutation === 'missing-field') wire.fields.pop();
        if (mutation === 'overlap') wire.fields[10].offset = 12;
        if (mutation === 'old-size') wire.podBytes = 48;
        assert.throws(() => renderAedsProtocolOutputs(source), /comment_policy_current_wire/u);
    });
}

test('canonical comment creation keeps frame 166 and refuses retired aliases or account inputs', () =>
{
    const current = manifest.frameTypes.find(frame => frame.name === 'CommentCreateRequest');
    assert.equal(current.value, 166);
    assert.equal(manifest.frameTypes.some(frame => /CommentCreateV2/u.test(frame.name)), false);
    for (const location of ['fields', 'coreFields', 'frontendFields'])
    {
        const source = structuredClone(manifest);
        const wire = source.payloadLayouts.CommentCreateRequest;
        if (location === 'fields') wire.fields[0].name = 'replyToUserId';
        else wire[location][0][0] = 'replyToUserId';
        assert.throws(() => renderAedsProtocolOutputs(source), /comment_create_current/u);
    }
});
