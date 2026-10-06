import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderAedsProtocolOutputs } from '../../tools/frontend/generate-aeds-protocol.mjs';
import { articleCanvasLinkGoldenPath, renderArticleCanvasLinkGoldenOutputs } from '../../tools/contracts/generate-article-canvas-link-golden.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const protocol = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8'));
const catalogPath = 'tests/backend/Fixtures/aeds-golden-catalog.json';
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const sharedUrl = moduleUrl(readFileSync(path.join(root, 'src/frontend/src/codecs/binary/authoringCanvasWire.generated.ts'), 'utf8'));
const wire = await import(moduleUrl(readFileSync(path.join(root, 'src/frontend/src/codecs/binary/articleCanvasLinkWire.generated.ts'), 'utf8')
    .replace("'./authoringCanvasWire.generated'", JSON.stringify(sharedUrl))));
const catalog = new Map(renderAedsProtocolOutputs(protocol)).get(catalogPath);
const payloadGolden = readFileSync(path.join(root, articleCanvasLinkGoldenPath), 'utf8');

function compactProtocol()
{
    const source = structuredClone(protocol);
    source.frameTypes = source.frameTypes.filter(frame => frame.goldenFamily === 'private-article-canvas-link')
        .map((frame, goldenOrder) => ({ ...frame, goldenOrder }));
    return source;
}

test('Link output roster owns the unchanged payload fixture while AEDS alone owns the catalog', () =>
{
    const outputs = renderArticleCanvasLinkGoldenOutputs(wire, protocol, catalog);
    assert.deepEqual(outputs.map(([file]) => file), [articleCanvasLinkGoldenPath]);
    assert.equal(outputs[0][1], payloadGolden);
    assert.ok(renderAedsProtocolOutputs(protocol).some(([file]) => file === catalogPath));
    assert.ok(!renderAedsProtocolOutputs(protocol).some(([file]) => file === articleCanvasLinkGoldenPath));
});

test('sequential complete producer outputs reach a fixed point without duplicating three Link identities', () =>
{
    const source = compactProtocol();
    const staged = new Map(renderAedsProtocolOutputs(source));
    const initialCatalog = staged.get(catalogPath);
    for (let pass = 0; pass < 3; pass++)
    {
        for (const [file, bytes] of renderArticleCanvasLinkGoldenOutputs(wire, source, staged.get(catalogPath)))
        {
            staged.set(file, bytes);
        }
        for (const [file, bytes] of renderAedsProtocolOutputs(source))
        {
            staged.set(file, bytes);
        }
        assert.equal(staged.get(catalogPath), initialCatalog);
        assert.equal(staged.get(articleCanvasLinkGoldenPath), payloadGolden);
        assert.deepEqual(JSON.parse(staged.get(catalogPath)).frames.map(frame => [frame.name, frame.value]), [
            ['ArticleCanvasLinkRequest', 266], ['ArticleCanvasLinkReceipt', 267], ['ArticleCanvasLinkHistoryResponse', 268]
        ]);
    }
});

for (const [label, change] of [
    ['duplicate spaced Link row', value => value.frames.push({ ...value.frames.at(-1) })],
    ['missing root', value => value.frames.pop()],
    ['changed public frame identity', value => { value.frames[0].value = 65535; }],
    ['missing evidence', value => value.defaultEvidence.pop()]
])
{
    test(`Link preflight refuses ${label} without returning any write output`, () =>
    {
        const value = JSON.parse(catalog);
        change(value);
        assert.throws(() => renderArticleCanvasLinkGoldenOutputs(wire, protocol, JSON.stringify(value, null, 2) + '\n'),
            /requires_aeds_protocol_producer/u);
    });
}

test('source duplicate identities and missing private root family fail before any output', () =>
{
    const duplicate = compactProtocol();
    duplicate.frameTypes[1].value = duplicate.frameTypes[0].value;
    assert.throws(() => renderArticleCanvasLinkGoldenOutputs(wire, duplicate, ''), /Duplicate frame type value/u);
    const wrongFamily = compactProtocol();
    wrongFamily.frameTypes[0].goldenFamily = 'public-response';
    const wrongCatalog = new Map(renderAedsProtocolOutputs(wrongFamily)).get(catalogPath);
    assert.throws(() => renderArticleCanvasLinkGoldenOutputs(wire, wrongFamily, wrongCatalog), /catalog_unregistered/u);
});
