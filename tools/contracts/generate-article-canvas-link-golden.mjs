import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderAedsProtocolOutputs } from '../frontend/generate-aeds-protocol.mjs';
export const articleCanvasLinkGoldenPath = 'tests/fixtures/protocol/article-canvas-link-wire-golden.json';
const catalogPath = 'tests/backend/Fixtures/aeds-golden-catalog.json';

/** The AEDS protocol producer alone writes its complete shared catalog. */
export function validateArticleCanvasLinkCatalog(protocol, catalogSource)
{
    const canonical = new Map(renderAedsProtocolOutputs(protocol)).get(catalogPath);
    if (catalogSource !== canonical)
    {
        throw new Error('article_canvas_link_catalog_requires_aeds_protocol_producer');
    }
}

export function renderArticleCanvasLinkGolden(wire, protocol)
{
    const frameType = (name) =>
    {
        const frame = protocol.frameTypes.find(row => row.name === name);
        if (!frame || frame.goldenFamily !== 'private-article-canvas-link')
        {
            throw new Error(`article_canvas_link_catalog_unregistered: ${name}`);
        }
        return frame.value;
    };
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
    for (const [type, value] of [['ArticleCanvasLinkRequest', request], ['ArticleCanvasLinkReceipt', receipt], ['ArticleCanvasLinkHistoryResponse', history]])
    {
        const frame = frameType(type);
        const bytes = wire[`encode${type}`](value);
        add(type, frame, bytes, true);
        add(`${type}-truncated`, frame, bytes.subarray(0, bytes.length - 1), false);
        add(`${type}-trailing`, frame, Uint8Array.from([...bytes, 0]), false);
        const version = bytes.slice();
        version[0] = 2;
        add(`${type}-version`, frame, version, false);
    }
    add('undo-request', frameType('ArticleCanvasLinkRequest'), wire.encodeArticleCanvasLinkRequest({ ...request, mode: 1, targetJournalId: guid,
        canvasId: empty, canvasRevision: '0', canvasContentDigest: '', edgeId: empty, targetArticleId: 0, expectedTargetRevision: '0' }), true);
    add('empty-history', frameType('ArticleCanvasLinkHistoryResponse'), wire.encodeArticleCanvasLinkHistoryResponse({ ...history, historyArticleRevision: '0', lastJournalId: empty, undoEntries: [] }), true);
    add('hundred-history', frameType('ArticleCanvasLinkHistoryResponse'), wire.encodeArticleCanvasLinkHistoryResponse({ ...history, undoEntries: Array(100).fill(receipt) }), true);
    // Independently located offsets: version(1), UUID(16), article(4), revision(8), enum(1).
    const encoded = wire.encodeArticleCanvasLinkRequest(request);
    const mode = encoded.slice();
    mode[29] = 3;
    add('request-closed-mode', frameType('ArticleCanvasLinkRequest'), mode, false);
    const negative = encoded.slice();
    negative.fill(255, 21, 29);
    add('request-negative-revision', frameType('ArticleCanvasLinkRequest'), negative, false);
    const sourceZero = encoded.slice();
    sourceZero.fill(0, 17, 21);
    add('request-zero-source', frameType('ArticleCanvasLinkRequest'), sourceZero, false);
    const invalidUtf8 = encoded.slice();
    invalidUtf8[74] = 0xff;
    add('request-invalid-utf8', frameType('ArticleCanvasLinkRequest'), invalidUtf8, false);
    const historyBytes = wire.encodeArticleCanvasLinkHistoryResponse(history);
    for (const count of [-1, 101, 2147483647])
    {
        const bytes = historyBytes.slice();
        new DataView(bytes.buffer).setInt32(37, count, true);
        add(`history-invalid-count-${count}`, frameType('ArticleCanvasLinkHistoryResponse'), bytes, false);
    }
    const badDigest = wire.encodeArticleCanvasLinkReceipt(receipt);
    badDigest[188] = 0x47;
    add('receipt-invalid-digest', frameType('ArticleCanvasLinkReceipt'), badDigest, false);
    return JSON.stringify({ schemaVersion: 1, generatedBy: 'tools/contracts/generate-article-canvas-link-golden.mjs',
        note: 'Wire witnesses only; digest authenticity, database transaction and HTTP permissions require separate controls.', cases }, null, 2) + '\n';
}

/** This producer's complete write roster excludes the protocol-owned catalog. */
export function renderArticleCanvasLinkGoldenOutputs(wire, protocol, catalogSource)
{
    validateArticleCanvasLinkCatalog(protocol, catalogSource);
    return [[articleCanvasLinkGoldenPath, renderArticleCanvasLinkGolden(wire, protocol)]];
}

async function main()
{
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const protocol = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8'));
    const catalogSource = readFileSync(path.join(root, catalogPath), 'utf8');

    const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
    const sharedUrl = moduleUrl(readFileSync(path.join(root, 'src/frontend/src/codecs/binary/authoringCanvasWire.generated.ts'), 'utf8'));
    const source = readFileSync(path.join(root, 'src/frontend/src/codecs/binary/articleCanvasLinkWire.generated.ts'), 'utf8')
        .replace("'./authoringCanvasWire.generated'", JSON.stringify(sharedUrl));
    const wire = await import(moduleUrl(source));

    // Preflight before any write; every output comes from this producer's closed roster.
    const outputs = renderArticleCanvasLinkGoldenOutputs(wire, protocol, catalogSource);
    for (const [relativePath, output] of outputs)
    {
        const target = path.join(root, relativePath);
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
    }
    console.log(`[article-canvas-link-golden] ${JSON.parse(outputs[0][1]).cases.length} wire cases`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    await main();
}
