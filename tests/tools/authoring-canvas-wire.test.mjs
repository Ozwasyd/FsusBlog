import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { validateCanvasWireOwners } = await import(new URL('../../tools/contracts/generate-authoring-canvas-wire.mjs', import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/authoring-canvas-wire.json'), 'utf8'));
const source = readFileSync(path.join(root, 'src/frontend/src/codecs/binary/authoringCanvasWire.generated.ts'), 'utf8');
const wire = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
const guid = '00112233-4455-6677-8899-aabbccddeeff';
const digest = 'a'.repeat(64);
const camel = (value) => value[0].toLowerCase() + value.slice(1);

test('all thirteen roots match frozen cross-stack bytes and refuse the frozen malformed controls', () =>
{
    const golden = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/protocol/authoring-canvas-wire-golden.json'), 'utf8'));
    for (const row of golden.cases)
    {
        const type = schema.roots.find(entry => entry.frameType === row.frameType)?.type;
        assert.ok(type, row.name);
        const bytes = Buffer.from(row.payloadHex, 'hex');
        if (row.valid)
        {
            const value = wire[`decode${type}`](bytes);
            assert.deepEqual(Buffer.from(wire[`encode${type}`](value)), bytes, row.name);
        }
        else
        {
            assert.throws(() => wire[`decode${type}`](bytes), undefined, row.name);
        }
    }
    for (const entry of schema.roots)
    {
        assert.ok(golden.cases.some(row => row.frameType === entry.frameType && row.valid), entry.type);
        assert.ok(golden.cases.some(row => row.frameType === entry.frameType && !row.valid), entry.type);
    }
});

function sample(field)
{
    if (field.nullable)
    {
        return null;
    }
    if (field.array)
    {
        return [];
    }
    if (field.type === 'guid')
    {
        return guid;
    }
    if (field.type === 'string')
    {
        return field.digest ? digest : '';
    }
    if (field.type === 'int64')
    {
        return String(field.min ?? 0);
    }
    if (field.type === 'timestamp')
    {
        return '0';
    }
    if (field.type === 'int32' || field.type === 'double')
    {
        return Math.max(0, field.min ?? 0);
    }
    if (field.type === 'bool')
    {
        return false;
    }
    if (schema.enums[field.type])
    {
        return (field.allowed ?? schema.enums[field.type])[0];
    }
    return Object.fromEntries(schema.records[field.type].fields.map((item) => [camel(item.name), sample(item)]));
}

function mutateInt32(bytes, offset, value)
{
    const copy = bytes.slice();
    new DataView(copy.buffer).setInt32(offset, value, true);
    return copy;
}

for (const { type } of schema.roots)
{
    test(`generated ${type} round-trips and refuses every truncation, schema and trailing bytes`, () =>
    {
        const value = sample({ type });
        const bytes = wire[`encode${type}`](value);
        assert.equal(bytes[0], 1);
        assert.deepEqual(wire[`decode${type}`](bytes), value);
        for (let end = 0; end < bytes.length; end++)
        {
            assert.throws(() => wire[`decode${type}`](bytes.subarray(0, end)));
        }
        const invalidVersion = bytes.slice();
        invalidVersion[0] = 2;
        assert.throws(() => wire[`decode${type}`](invalidVersion));
        assert.throws(() => wire[`decode${type}`](Uint8Array.from([...bytes, 0])));
    });
}

test('create request matches independent network-Guid / little-endian scalar golden bytes', () =>
{
    const value = { canvasId: guid, requestId: guid, title: 'A', viewport: { x: 1, y: -2, zoom: 0.5 } };
    // Schema=1; two RFC/network-order GUIDs; int32 UTF8 length=1; ASCII A;
    // IEEE754 little-endian 1.0, -2.0 and 0.5. No generated schema helper builds this oracle.
    const golden = Buffer.from('01'
        + '00112233445566778899aabbccddeeff'.repeat(2)
        + '0100000041'
        + '000000000000f03f00000000000000c0000000000000e03f', 'hex');
    assert.deepEqual(Buffer.from(wire.encodeAuthoringCanvasCreateRequest(value)), golden);
    assert.deepEqual(wire.decodeAuthoringCanvasCreateRequest(golden), value);
});

test('UTF8 decoding is fatal and preserves BOM and paired supplementary scalars', () =>
{
    const input = { canvasId: guid, requestId: guid, title: '\ufeff画布😀', viewport: { x: 0, y: 0, zoom: 1 } };
    assert.deepEqual(wire.decodeAuthoringCanvasCreateRequest(wire.encodeAuthoringCanvasCreateRequest(input)), input);
    for (const title of ['\ud800', '\udc00', 'a\ud800b', '\udfff\ud800'])
    {
        assert.throws(() => wire.encodeAuthoringCanvasCreateRequest({ ...input, title }));
    }
    // Independent malformed scalar byte strings: overlong, encoded surrogate, out-of-range,
    // truncated multibyte scalar, stray continuation, bad continuation.
    for (const invalid of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe4, 0xb8], [0x80], [0xe4, 0x41, 0xad]])
    {
        const prefix = Buffer.from('01' + '00112233445566778899aabbccddeeff'.repeat(2), 'hex');
        const length = Buffer.alloc(4);
        length.writeInt32LE(invalid.length);
        const numbers = Buffer.from('00000000000000000000000000000000000000000000f03f', 'hex');
        assert.throws(() => wire.decodeAuthoringCanvasCreateRequest(Buffer.concat([prefix, length, Buffer.from(invalid), numbers])));
    }
});

test('string lengths check UTF16 characters and declared byte bounds before slicing', () =>
{
    const input = { canvasId: guid, requestId: guid, title: '😀'.repeat(64), viewport: { x: 0, y: 0, zoom: 1 } };
    const bytes = wire.encodeAuthoringCanvasCreateRequest(input);
    assert.equal(wire.decodeAuthoringCanvasCreateRequest(bytes).title.length, 128);
    assert.throws(() => wire.encodeAuthoringCanvasCreateRequest({ ...input, title: input.title + 'a' }));
    assert.throws(() => wire.decodeAuthoringCanvasCreateRequest(mutateInt32(bytes, 33, -1)));
    assert.throws(() => wire.decodeAuthoringCanvasCreateRequest(mutateInt32(bytes, 33, 513)));
    assert.throws(() => wire.decodeAuthoringCanvasCreateRequest(mutateInt32(bytes, 33, 2147483647)));
});

test('Int64 stays exact above Number.MAX_SAFE_INTEGER and refuses noncanonical/out-of-range strings', () =>
{
    const value = { requestId: guid, expectedRevision: '9223372036854775807' };
    const bytes = wire.encodeAuthoringCanvasDeleteRequest(value);
    assert.deepEqual(wire.decodeAuthoringCanvasDeleteRequest(bytes), value);
    assert.equal(Buffer.from(bytes.subarray(17)).toString('hex'), 'ffffffffffffff7f');
    for (const expectedRevision of ['0', '-1', '9223372036854775808', '01', '+1', '1e2', '-0', ' 1', 9007199254740992])
    {
        assert.throws(() => wire.encodeAuthoringCanvasDeleteRequest({ ...value, expectedRevision }));
    }
    const zero = bytes.slice();
    zero.fill(0, 17);
    assert.throws(() => wire.decodeAuthoringCanvasDeleteRequest(zero));
});

test('DateTime wire bounds exactly match existing UnixMs POD timestamps', () =>
{
    const header = sample({ type: 'AuthoringCanvasDocumentHeader' });
    for (const createdAtUtc of ['-62135596800000', '253402300799999'])
    {
        const value = { ...header, createdAtUtc, updatedAtUtc: createdAtUtc };
        assert.deepEqual(wire.decodeAuthoringCanvasDocumentHeader(wire.encodeAuthoringCanvasDocumentHeader(value)), value);
    }
    for (const createdAtUtc of ['-62135596800001', '253402300800000'])
    {
        assert.throws(() => wire.encodeAuthoringCanvasDocumentHeader({ ...header, createdAtUtc }));
    }
});

test('geometry and viewport refuse nonfinite and out-of-bound doubles during encode and decode', () =>
{
    const value = { canvasId: guid, requestId: guid, title: '', viewport: { x: 0, y: 0, zoom: 1 } };
    const bytes = wire.encodeAuthoringCanvasCreateRequest(value);
    for (const x of [NaN, Infinity, -Infinity, 10000001, -10000001])
    {
        assert.throws(() => wire.encodeAuthoringCanvasCreateRequest({ ...value, viewport: { ...value.viewport, x } }));
        const mutated = bytes.slice();
        new DataView(mutated.buffer).setFloat64(37, x, true);
        assert.throws(() => wire.decodeAuthoringCanvasCreateRequest(mutated));
    }
    for (const zoom of [0, 0.099, 4.001])
    {
        assert.throws(() => wire.encodeAuthoringCanvasCreateRequest({ ...value, viewport: { ...value.viewport, zoom } }));
    }
});

test('closed enums and strict nullable / boolean markers reject substituted values', () =>
{
    const request = sample({ type: 'AuthoringCanvasUndoRedoRequest' });
    const bytes = wire.encodeAuthoringCanvasUndoRedoRequest(request);
    assert.equal(bytes.at(-1), 1);
    for (const mode of [0, 3, 255])
    {
        assert.throws(() => wire.encodeAuthoringCanvasUndoRedoRequest({ ...request, mode }));
        const changed = bytes.slice();
        changed[changed.length - 1] = mode;
        assert.throws(() => wire.decodeAuthoringCanvasUndoRedoRequest(changed));
    }
    const nodes = sample({ type: 'AuthoringCanvasNodesResponse' });
    const page = wire.encodeAuthoringCanvasNodesResponse(nodes);
    assert.equal(page.at(-1), 0);
    const marker = page.slice();
    marker[marker.length - 1] = 2;
    assert.throws(() => wire.decodeAuthoringCanvasNodesResponse(marker));
});

test('digest bytes are lowercase 64-byte hexadecimal rather than arbitrary text', () =>
{
    const value = sample({ type: 'AuthoringCanvasApplyRequest' });
    for (const expectedContentDigest of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63) + '😀'])
    {
        assert.throws(() => wire.encodeAuthoringCanvasApplyRequest({ ...value, expectedContentDigest }));
    }
    const bytes = wire.encodeAuthoringCanvasApplyRequest(value);
    bytes[29] = 'G'.charCodeAt(0);
    assert.throws(() => wire.decodeAuthoringCanvasApplyRequest(bytes));
});

test('array count and physical element widths refuse claimed allocation before reading members', () =>
{
    const request = sample({ type: 'AuthoringCanvasResolveRequest' });
    const bytes = wire.encodeAuthoringCanvasResolveRequest(request);
    // schema + requestId16 + revision8 + digestLength4 + digest64 = 93.
    for (const count of [-1, 1, 257, 2147483647])
    {
        assert.throws(() => wire.decodeAuthoringCanvasResolveRequest(mutateInt32(bytes, 93, count)));
    }
    assert.throws(() => wire.encodeAuthoringCanvasResolveRequest({ ...request, nodeIds: Array(257).fill(guid) }));
    const page = sample({ type: 'AuthoringCanvasNodesResponse' });
    assert.throws(() => wire.encodeAuthoringCanvasNodesResponse({ ...page, items: Array(257).fill(sample({ type: 'AuthoringCanvasNode' })) }));
});

test('fact payload preserves optional typed branches and omits untrusted content digests', () =>
{
    const node = sample({ type: 'AuthoringCanvasNode' });
    node.noteSource = '真实 note 😀';
    node.type = 3;
    node.members = [guid];
    const fact = { kind: 0, id: guid, exists: true, node, edge: null, viewport: null };
    const command = { commandId: guid, kind: 3, before: [fact], after: [{ ...fact, node: { ...node, geometry: { ...node.geometry, x: 2 } } }] };
    const request = { ...sample({ type: 'AuthoringCanvasApplyRequest' }), commands: [command] };
    const bytes = wire.encodeAuthoringCanvasApplyRequest(request);
    assert.deepEqual(wire.decodeAuthoringCanvasApplyRequest(bytes), request);
    assert.deepEqual(wire.encodeAuthoringCanvasApplyRequest({ ...request, commands: [{ ...command, contentDigest: 'client-forged', before: [{ ...fact, contentDigest: 'client-forged' }] }] }), bytes);
});

test('aggregate Before plus After facts are bounded across commands, on both encoding and decoding', () =>
{
    const fact = { kind: 0, id: guid, exists: false, node: null, edge: null, viewport: null };
    const chunk = Array(20001).fill(fact);
    const request = { ...sample({ type: 'AuthoringCanvasApplyRequest' }), commands: [{ commandId: guid, kind: 11, before: chunk, after: chunk }] };
    const bytes = wire.encodeAuthoringCanvasApplyRequest(request);
    const result = wire.decodeAuthoringCanvasApplyRequest(bytes);
    assert.equal(result.commands[0].before.length + result.commands[0].after.length, 40002);
    const extra = { commandId: guid, kind: 11, before: [fact], after: [] };
    assert.throws(() => wire.encodeAuthoringCanvasApplyRequest({ ...request, commands: [...request.commands, extra] }));
    const extraOnly = wire.encodeAuthoringCanvasApplyRequest({ ...request, commands: [extra] });
    // Append a independently encoded second command, then change only the existing request's count.
    const offset = 1 + 16 + 8 + (4 + 64) * 2;
    const combined = new Uint8Array(bytes.length + extraOnly.length - offset - 4);
    combined.set(bytes);
    combined.set(extraOnly.subarray(offset + 4), bytes.length);
    new DataView(combined.buffer).setInt32(offset, 2, true);
    assert.throws(() => wire.decodeAuthoringCanvasApplyRequest(combined), /authoring_canvas_wire_invalid/);
});

test('8 MiB global payload cap refuses excessive valid bounded nested nodes', () =>
{
    const request = sample({ type: 'AuthoringCanvasApplyRequest' });
    const node = { ...sample({ type: 'AuthoringCanvasNode' }), type: 3, noteSource: '中'.repeat(8192) };
    const fact = { kind: 0, id: guid, exists: true, node, edge: null, viewport: null };
    const command = { commandId: guid, kind: 10, before: [], after: Array(400).fill(fact) };
    assert.throws(() => wire.encodeAuthoringCanvasApplyRequest({ ...request, commands: [command] }));
    assert.throws(() => wire.decodeAuthoringCanvasApplyRequest(new Uint8Array(8388609)));
});

test('resolution receipt nested coordinate, open intent, projection reference and UTF8 context are preserved', () =>
{
    const response = sample({ type: 'AuthoringCanvasReferenceResolutionBatch' });
    const projection = sample({ type: 'AuthoringCanvasReferenceProjection' });
    const intent = { articleId: 7, revision: '9007199254740993', headingIdentity: '段落', blockIdentity: null, stableRoute: '/article/7', mode: 0, targetGroupId: 'workspace' };
    Object.assign(projection, { title: '标题', contextSnippet: '片段 😀', targetRevision: '9007199254740993', currentTargetRevision: '9007199254740994', openIntent: intent, displayProjectionReference: 'projection-identity' });
    const item = { ...sample({ type: 'AuthoringCanvasReferenceResolutionReceiptItem' }), title: projection.title, contextSnippet: projection.contextSnippet, targetRevision: projection.targetRevision, openIntent: intent };
    response.projections = [projection];
    response.receipt.items = [item];
    response.receipt.targetCount = 1;
    assert.deepEqual(wire.decodeAuthoringCanvasReferenceResolutionBatch(wire.encodeAuthoringCanvasReferenceResolutionBatch(response)), response);
});

test('generator binds current frame, enum, constructor and domain budgets and refuses owner drift', () =>
{
    const protocol = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8'));
    const domains = ['Document', 'Operation', 'Reference', 'Transport'].map((domain) => readFileSync(path.join(root, `src/shared/Contracts/AuthoringCanvas/AuthoringCanvas${domain}Contracts.cs`), 'utf8'));
    assert.doesNotThrow(() => validateCanvasWireOwners(schema, protocol, domains));
    const frameChange = structuredClone(protocol);
    frameChange.frameTypes.find((frame) => frame.name === 'AuthoringCanvasCreateRequest').value++;
    assert.throws(() => validateCanvasWireOwners(schema, frameChange, domains), /protocol frame drift/);
    const enumChange = domains.slice();
    enumChange[0] = enumChange[0].replace('PlainTextNote = 3', 'PlainTextNote = 7');
    assert.throws(() => validateCanvasWireOwners(schema, protocol, enumChange), /domain enum drift/);
    const fieldChange = domains.slice();
    fieldChange[3] = fieldChange[3].replace('long ExpectedRevision', 'int ExpectedRevision');
    assert.throws(() => validateCanvasWireOwners(schema, protocol, fieldChange), /domain field drift/);
    const budgetChange = domains.slice();
    budgetChange[2] = budgetChange[2].replace('MaxContextSnippetLength = 320', 'MaxContextSnippetLength = 321');
    assert.throws(() => validateCanvasWireOwners(schema, protocol, budgetChange), /domain budget drift/);
    const factBudgetChange = domains.slice();
    factBudgetChange[0] = factBudgetChange[0].replace('MaxNodesPerCanvas = 10_000', 'MaxNodesPerCanvas = 10_001');
    assert.throws(() => validateCanvasWireOwners(schema, protocol, factBudgetChange), /domain aggregate facts drift/);
    const schemaFieldChange = structuredClone(schema);
    schemaFieldChange.records.AuthoringCanvasCreateRequest.fields.reverse();
    assert.throws(() => validateCanvasWireOwners(schemaFieldChange, protocol, domains), /domain field drift/);
    const clientLimitChange = structuredClone(schema);
    clientLimitChange.clientLimits.maxNodesPerCanvas = '10000';
    assert.throws(() => validateCanvasWireOwners(clientLimitChange, protocol, domains), /invalid client limit owner/);
    clientLimitChange.clientLimits.maxNodesPerCanvas = 'AuthoringCanvasContract.Unknown';
    assert.throws(() => validateCanvasWireOwners(clientLimitChange, protocol, domains), /unsupported domain constant/);
    assert.equal(wire.authoringCanvasLimits.maxNodesPerCanvas, 10000);
    assert.equal(wire.authoringCanvasLimits.maxNoteSourceLength, 8192);
    assert.equal(wire.authoringCanvasLimits.minZoom, 0.1);
    assert.ok(Object.isFrozen(wire.authoringCanvasLimits));
});
