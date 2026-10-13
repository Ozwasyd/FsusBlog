import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const shared = moduleUrl(readFileSync(path.join(root, 'src/frontend/src/codecs/binary/authoringCanvasWire.generated.ts'), 'utf8'));
const wireUrl = moduleUrl(readFileSync(path.join(root, 'src/frontend/src/codecs/binary/articleCanvasLinkWire.generated.ts'), 'utf8')
    .replace("'./authoringCanvasWire.generated'", JSON.stringify(shared)));
const runtimeUrl = moduleUrl(readFileSync(path.join(root, 'src/frontend/src/services/privateRequestRuntime.ts'), 'utf8'));
const { privateRequestRuntime } = await import(runtimeUrl);
let convert;
let history;
class BinaryTransportError extends Error
{
    constructor(kind)
    {
        super(kind);
        this.kind = kind;
    }
}
globalThis.__articleCanvasLinkProviderControls = { api: { convert: (...args) => convert(...args), history: (...args) => history(...args) }, BinaryTransportError };
let source = readFileSync(path.join(root, 'src/frontend/src/services/articleCanvasLinkTransaction.ts'), 'utf8')
    .replace("import { articleCanvasLinksApi } from '@/api/articleCanvasLinks';", 'const articleCanvasLinksApi = globalThis.__articleCanvasLinkProviderControls.api;')
    .replace("'@/codecs/binary/articleCanvasLinkWire.generated'", JSON.stringify(wireUrl))
    .replace("'@/services/privateRequestRuntime'", JSON.stringify(runtimeUrl))
    .replace("import { BinaryTransportError } from '@/composition/binaryTransport';", 'const BinaryTransportError = globalThis.__articleCanvasLinkProviderControls.BinaryTransportError;');
const { createArticleCanvasLinkTransaction } = await import(moduleUrl(source));
const empty = '00000000-0000-0000-0000-000000000000';
const id = '00112233-4455-6677-8899-aabbccddeeff';
const other = '10112233-4455-6677-8899-aabbccddeeff';
const hash = values => createHash('sha256').update(values.map(value => `${String(value).length}:${value}`).join('')).digest('hex');
const owner = { userId: '9', siteId: 'primary-site' };
const request = { requestId: id, canvasId: id, canvasRevision: 3, canvasContentDigest: 'a'.repeat(64),
    sourceArticleId: 7, expectedArticleRevision: '9007199254740993', targetArticleId: 8, expectedTargetRevision: '19',
    plan: { valid: true, edgeType: 'explicit-reference-note', insertPosition: 'end_of_document', edgeId: id,
        sourceArticleId: 7, targetArticleId: 8 } };
function receipt(wire)
{
    const requestDigest = hash([1, wire.requestId, wire.sourceArticleId, wire.expectedArticleRevision, wire.mode,
        wire.targetJournalId, wire.canvasId, wire.canvasRevision, wire.canvasContentDigest,
        wire.edgeId, wire.targetArticleId, wire.expectedTargetRevision]);
    const value = { requestId: wire.requestId, journalId: other, parentJournalId: empty, ownerAdminPrincipalId: '9',
        siteScope: 'primary-site', sourceArticleId: 7, previousArticleRevision: wire.expectedArticleRevision,
        articleRevision: '9007199254740994', originalBeforeRevision: '9007199254740993', originalAfterRevision: '9007199254740994',
        mode: wire.mode, targetJournalId: wire.targetJournalId, canvasId: id, canvasRevision: '3', canvasContentDigest: 'a'.repeat(64),
        edgeId: id, targetArticleId: 8, targetRevision: '19', undoDepth: wire.mode === 1 ? 0 : 1, redoDepth: wire.mode === 1 ? 1 : 0,
        requestDigest, receiptDigest: '', idempotencyReplay: false };
    value.receiptDigest = hash([1, value.requestId, value.journalId, value.parentJournalId, value.ownerAdminPrincipalId, value.siteScope,
        value.sourceArticleId, value.previousArticleRevision, value.articleRevision, value.originalBeforeRevision, value.originalAfterRevision,
        value.mode, value.targetJournalId, value.canvasId, value.canvasRevision, value.canvasContentDigest, value.edgeId,
        value.targetArticleId, value.targetRevision, value.undoDepth, value.redoDepth, value.requestDigest]);
    return value;
}

test('unknown response freezes the exact request and UUID across retry and Workspace remount recovery', async () =>
{
    const tx = createArticleCanvasLinkTransaction(owner);
    const seen = [];
    convert = async wire =>
    {
        seen.push({ ...wire });
        throw new Error('network lost after write');
    };
    await assert.rejects(tx.commit(request));
    assert.equal(tx.pendingWrite().request.requestId, id);
    await assert.rejects(tx.commit({ ...request, requestId: other }), /unresolved/);
    assert.equal(seen.length, 1);
    convert = async wire =>
    {
        seen.push({ ...wire });
        return receipt(wire);
    };
    const actual = await tx.retryPending();
    assert.deepEqual(seen[0], seen[1]);
    assert.equal(actual.articleRevision, '9007199254740994');
    assert.equal(tx.pendingWrite(), null);
});

test('initial definite rejection clears pending but a denial after unknown outcome retains it', async () =>
{
    const tx = createArticleCanvasLinkTransaction(owner);
    convert = async () =>
    {
        throw new BinaryTransportError('conflict');
    };
    await assert.rejects(tx.commit(request));
    assert.equal(tx.pendingWrite(), null);
    convert = async () =>
    {
        throw new Error('unknown');
    };
    await assert.rejects(tx.commit(request));
    convert = async () =>
    {
        throw new BinaryTransportError('not_found');
    };
    await assert.rejects(tx.retryPending());
    assert.equal(tx.pendingWrite().request.requestId, id);
});

test('invalid digest and a receipt from another principal fail closed without acknowledging the request', async () =>
{
    for (const mutate of [value => ({ ...value, receiptDigest: 'b'.repeat(64) }), value => ({ ...value, ownerAdminPrincipalId: '10' })])
    {
        const tx = createArticleCanvasLinkTransaction(owner);
        convert = async wire => mutate(receipt(wire));
        await assert.rejects(tx.commit(request));
        assert.equal(tx.pendingWrite().request.requestId, id);
    }
});

test('history verifies the canonical digest and distinguishes empty from corrupt initial state', async () =>
{
    const tx = createArticleCanvasLinkTransaction(owner);
    const value = { sourceArticleId: 7, articleRevision: '9007199254740993', historyArticleRevision: '0',
        lastJournalId: empty, undoEntries: [], redoEntries: [], historyDigest: hash([1, 7, '0', empty, '', '']) };
    history = async () => value;
    assert.equal((await tx.history(7)).historyArticleRevision, '0');
    history = async () => ({ ...value, lastJournalId: id });
    await assert.rejects(tx.history(7));
});

test('undo and redo use the selected journal and source CAS without inventing Canvas command payload', async () =>
{
    for (const [kind, mode] of [['undo', 1], ['redo', 2]])
    {
        const tx = createArticleCanvasLinkTransaction(owner);
        let seen;
        convert = async wire =>
        {
            seen = wire;
            return receipt(wire);
        };
        await tx[kind]({ requestId: id, sourceArticleId: 7, expectedArticleRevision: '9007199254740993', targetJournalId: other });
        assert.equal(seen.mode, mode);
        assert.equal(seen.targetJournalId, other);
        assert.equal(seen.canvasId, empty);
        assert.equal(seen.canvasContentDigest, '');
        assert.equal(seen.expectedTargetRevision, '0');
    }
});

async function pausedDigest(action, scope, expectedReject)
{
    let started;
    let release;
    const reached = new Promise(resolve =>
    {
        started = resolve;
    });
    const resumed = new Promise(resolve =>
    {
        release = resolve;
    });
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let first = true;
    crypto.subtle.digest = async (...args) =>
    {
        if (first)
        {
            first = false;
            started();
            await resumed;
        }
        return original(...args);
    };
    try
    {
        const result = action();
        await reached;
        privateRequestRuntime.advance(scope);
        release();
        if (expectedReject)
        {
            await assert.rejects(result, error => error.name === 'AbortError');
        }
        else
        {
            await result;
        }
    }
    finally
    {
        crypto.subtle.digest = original;
    }
}

test('actual admin generation advancement during receipt digest prevents acknowledgement and retains the original request', async () =>
{
    const tx = createArticleCanvasLinkTransaction(owner);
    convert = async wire => receipt(wire);
    await pausedDigest(() => tx.commit(request), 'admin', true);
    assert.equal(tx.pendingWrite().request.requestId, id);
    await assert.rejects(tx.retryPending(), error => error.name === 'AbortError');
});

test('actual admin generation advancement during history digest refuses the private history', async () =>
{
    const tx = createArticleCanvasLinkTransaction(owner);
    history = async () => ({ sourceArticleId: 7, articleRevision: '9007199254740993', historyArticleRevision: '0',
        lastJournalId: empty, undoEntries: [], redoEntries: [], historyDigest: hash([1, 7, '0', empty, '', '']) });
    await pausedDigest(() => tx.history(7), 'admin', true);
});

test('account advancement during digest preserves independent admin generation and the matching receipt', async () =>
{
    const tx = createArticleCanvasLinkTransaction(owner);
    convert = async wire => receipt(wire);
    await pausedDigest(() => tx.commit(request), 'account', false);
    assert.equal(tx.pendingWrite(), null);
});
