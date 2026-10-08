import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const sharedUrl = moduleUrl(readFileSync(path.join(root, 'src/frontend/src/codecs/binary/authoringCanvasWire.generated.ts'), 'utf8'));
const source = readFileSync(path.join(root, 'src/frontend/src/codecs/binary/articleCanvasLinkWire.generated.ts'), 'utf8')
    .replace("'./authoringCanvasWire.generated'", JSON.stringify(sharedUrl));
const wire = await import(moduleUrl(source));
const guid = '00112233-4455-6677-8899-aabbccddeeff';
const empty = '00000000-0000-0000-0000-000000000000';
const digest = 'a'.repeat(64);
const request = { requestId: guid, sourceArticleId: 7, expectedArticleRevision: '9007199254740993', mode: 0,
    targetJournalId: empty, canvasId: guid, canvasRevision: '3', canvasContentDigest: digest,
    edgeId: guid, targetArticleId: 8, expectedTargetRevision: '9223372036854775807' };
const receipt = { requestId: guid, journalId: guid, parentJournalId: empty, ownerAdminPrincipalId: '9',
    siteScope: 'primary-site', sourceArticleId: 7, previousArticleRevision: '9007199254740993',
    articleRevision: '9007199254740994', originalBeforeRevision: '9007199254740993', originalAfterRevision: '9007199254740994',
    mode: 0, targetJournalId: empty, canvasId: guid, canvasRevision: '3', canvasContentDigest: digest,
    edgeId: guid, targetArticleId: 8, targetRevision: '9223372036854775807', undoDepth: 1, redoDepth: 0,
    requestDigest: digest, receiptDigest: digest, idempotencyReplay: false };
const history = { sourceArticleId: 7, articleRevision: '9007199254740994', historyArticleRevision: '9007199254740994',
    lastJournalId: guid, undoEntries: [receipt], redoEntries: [], historyDigest: digest };
const cases = [];
function add(name, frameType, bytes, valid)
{
    cases.push({ name, frameType, payloadHex: Buffer.from(bytes).toString('hex'), valid });
}
for (const [type, frame, value] of [['ArticleCanvasLinkRequest', 266, request], ['ArticleCanvasLinkReceipt', 267, receipt], ['ArticleCanvasLinkHistoryResponse', 268, history]])
{
    const bytes = wire[`encode${type}`](value);
    add(type, frame, bytes, true);
    add(`${type}-truncated`, frame, bytes.subarray(0, bytes.length - 1), false);
    add(`${type}-trailing`, frame, Uint8Array.from([...bytes, 0]), false);
    const version = bytes.slice();
    version[0] = 2;
    add(`${type}-version`, frame, version, false);
}
add('undo-request', 266, wire.encodeArticleCanvasLinkRequest({ ...request, mode: 1, targetJournalId: guid,
    canvasId: empty, canvasRevision: '0', canvasContentDigest: '', edgeId: empty, targetArticleId: 0, expectedTargetRevision: '0' }), true);
add('empty-history', 268, wire.encodeArticleCanvasLinkHistoryResponse({ ...history, historyArticleRevision: '0', lastJournalId: empty, undoEntries: [] }), true);
add('hundred-history', 268, wire.encodeArticleCanvasLinkHistoryResponse({ ...history, undoEntries: Array(100).fill(receipt) }), true);
// Independently located offsets: version(1), UUID(16), article(4), revision(8), enum(1).
const encoded = wire.encodeArticleCanvasLinkRequest(request);
const mode = encoded.slice();
mode[29] = 3;
add('request-closed-mode', 266, mode, false);
const negative = encoded.slice();
negative.fill(255, 21, 29);
add('request-negative-revision', 266, negative, false);
const sourceZero = encoded.slice();
sourceZero.fill(0, 17, 21);
add('request-zero-source', 266, sourceZero, false);
const invalidUtf8 = encoded.slice();
invalidUtf8[74] = 0xff;
add('request-invalid-utf8', 266, invalidUtf8, false);
const historyBytes = wire.encodeArticleCanvasLinkHistoryResponse(history);
for (const count of [-1, 101, 2147483647])
{
    const bytes = historyBytes.slice();
    new DataView(bytes.buffer).setInt32(37, count, true);
    add(`history-invalid-count-${count}`, 268, bytes, false);
}
const badDigest = wire.encodeArticleCanvasLinkReceipt(receipt);
badDigest[188] = 0x47;
add('receipt-invalid-digest', 267, badDigest, false);
const output = JSON.stringify({ schemaVersion: 1, generatedBy: 'tools/contracts/generate-article-canvas-link-golden.mjs',
    note: 'Wire witnesses only; digest authenticity, database transaction and HTTP permissions require separate controls.', cases }, null, 2) + '\n';
const target = path.join(root, 'tests/fixtures/protocol/article-canvas-link-wire-golden.json');
if (process.argv.includes('--check'))
{
    if (readFileSync(target, 'utf8') !== output)
    {
        throw new Error('article_canvas_link_golden_drift');
    }
}
else
{
    writeFileSync(target, output);
}
// The complete frame catalog belongs to the canonical protocol producer.
// This payload producer verifies its roots without rewriting that derived owner.
const catalog = JSON.parse(readFileSync(path.join(root, 'tests/backend/Fixtures/aeds-golden-catalog.json'), 'utf8'));
const protocol = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8'));
for (const name of ['ArticleCanvasLinkRequest', 'ArticleCanvasLinkReceipt', 'ArticleCanvasLinkHistoryResponse'])
{
    const frame = protocol.frameTypes.find(row => row.name === name);
    const entries = catalog.frames.filter(row => row.name === name);
    if (!frame || entries.length !== 1 || entries[0].value !== frame.value
        || entries[0].family !== frame.goldenFamily)
    {
        throw new Error('article_canvas_link_golden_catalog_drift');
    }
}
console.log(`[article-canvas-link-golden] ${cases.length} wire cases`);
