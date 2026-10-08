import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const shared = moduleUrl(readFileSync(path.join(root, 'src/frontend/src/codecs/binary/authoringCanvasWire.generated.ts'), 'utf8'));
const wire = await import(moduleUrl(readFileSync(path.join(root, 'src/frontend/src/codecs/binary/articleCanvasLinkWire.generated.ts'), 'utf8')
    .replace("'./authoringCanvasWire.generated'", JSON.stringify(shared))));
const golden = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/protocol/article-canvas-link-wire-golden.json'), 'utf8'));
const names = { 266: 'ArticleCanvasLinkRequest', 267: 'ArticleCanvasLinkReceipt', 268: 'ArticleCanvasLinkHistoryResponse' };

test('all new cross-stack wire witnesses round-trip or refuse their actual malformed bytes', () =>
{
    for (const entry of golden.cases)
    {
        const bytes = Buffer.from(entry.payloadHex, 'hex');
        const type = names[entry.frameType];
        if (entry.valid)
        {
            const value = wire[`decode${type}`](bytes);
            assert.deepEqual(Buffer.from(wire[`encode${type}`](value)), bytes, entry.name);
        }
        else
        {
            assert.throws(() => wire[`decode${type}`](bytes), undefined, entry.name);
        }
    }
});

test('apply request exact bytes independently prove network UUID, closed enum and 64-bit LE revision layout', () =>
{
    const actual = golden.cases.find(row => row.name === 'ArticleCanvasLinkRequest');
    const guid = '00112233445566778899aabbccddeeff';
    const independent = '01' + guid + '07000000' + '0100000000002000' + '00' + '00'.repeat(16)
        + guid + '0300000000000000' + '40000000' + '61'.repeat(64)
        + guid + '08000000' + 'ffffffffffffff7f';
    assert.equal(actual.payloadHex, independent);
});

for (const [frame, type] of Object.entries(names))
{
    test(`${type} refuses every truncation, oversized root and canonical scalar violations`, () =>
    {
        const witness = golden.cases.find(row => row.frameType === Number(frame) && row.valid);
        const bytes = Buffer.from(witness.payloadHex, 'hex');
        for (let end = 0; end < bytes.length; end++)
        {
            assert.throws(() => wire[`decode${type}`](bytes.subarray(0, end)));
        }
        assert.throws(() => wire[`decode${type}`](new Uint8Array(131073)));
    });
}

test('request refuses unsafe number and noncanonical revision strings; history refuses 101 entries before emission', () =>
{
    const request = wire.decodeArticleCanvasLinkRequest(Buffer.from(golden.cases[0].payloadHex, 'hex'));
    for (const revision of ['01', '+1', '1e2', '-0', '9223372036854775808', 9007199254740992])
    {
        assert.throws(() => wire.encodeArticleCanvasLinkRequest({ ...request, expectedArticleRevision: revision }));
    }
    const history = wire.decodeArticleCanvasLinkHistoryResponse(Buffer.from(golden.cases.find(row => row.name === 'ArticleCanvasLinkHistoryResponse').payloadHex, 'hex'));
    assert.throws(() => wire.encodeArticleCanvasLinkHistoryResponse({ ...history, undoEntries: Array(101).fill(history.undoEntries[0]) }));
});
