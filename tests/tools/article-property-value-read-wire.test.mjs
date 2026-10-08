import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64');
const wire = await import(moduleUrl(readFileSync(path.join(root, 'src/frontend/src/codecs/binary/articlePropertyValueReadWire.generated.ts'), 'utf8')));
const golden = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/protocol/article-property-value-read-wire-golden.json'), 'utf8'));
const bytesOf = name => Buffer.from(golden.cases.find(item => item.name === name).payloadHex, 'hex');
const witness = name => wire.decodeArticlePropertyValueReadResponse(bytesOf(name));

test('all current typed cross-stack witnesses round-trip or reject actual malformed bytes', () =>
{
    for (const entry of golden.cases)
    {
        const bytes = Buffer.from(entry.payloadHex, 'hex');
        if (entry.valid)
        {
            assert.deepEqual(Buffer.from(wire.encodeArticlePropertyValueReadResponse(wire.decodeArticlePropertyValueReadResponse(bytes))), bytes, entry.name);
        }
        else
        {
            assert.throws(() => wire.decodeArticlePropertyValueReadResponse(bytes), undefined, entry.name);
        }
    }
});

test('independent empty root proves LE int64 beyondJS precision and absent persisted snapshot', () =>
{
    assert.equal(bytesOf('current-0').toString('hex'), '010700000001000000000020000000000000000000000000000000000000');
    const value = witness('current-0');
    assert.equal(value.currentArticleRevisionId, '9007199254740993');
    assert.equal(value.current, null);
    assert.equal(value.propertyRevision, '0');
});

test('eight union tags retain decimal96bits, UTC100ns ticks, false and stable identities', () =>
{
    const all = witness('current-8');
    assert.deepEqual(all.current.snapshot.values.map(item => item.value.type), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(witness('typed-1').current.snapshot.values[0].value.number,
        { lo: 4294967295, mid: 4294967295, hi: 4294967295, scale: 28, negative: true });
    assert.equal(witness('typed-3').current.snapshot.values[0].value.utc, '638954208000000001');
    assert.equal(witness('typed-2').current.snapshot.values[0].value.boolean, false);
    assert.deepEqual(witness('typed-6').current.snapshot.values[0].value.articleIds, ['9007199254740993', '9223372036854775807']);
});

test('zero/one/thousand definitions and values use bounded real generated array codecs', () =>
{
    for (const count of [0, 1, 1000])
    {
        const value = witness(`current-${count}`);
        assert.equal(value.definitions.length, count);
        assert.equal(value.current?.snapshot.values.length ?? 0, count);
    }
    const value = witness('current-1');
    assert.throws(() => wire.encodeArticlePropertyValueReadResponse({ ...value, definitions: Array(1001).fill(value.definitions[0]) }));
    const aggregate = witness('current-1000');
    const option = aggregate.definitions.find(definition => definition.options.length > 0).options[0];
    assert.ok(option);
    aggregate.definitions = aggregate.definitions.map(definition => ({
        ...definition,
        options: Array(40).fill(option)
    }));
    assert.throws(() => wire.encodeArticlePropertyValueReadResponse(aggregate), RangeError, 'Global40000 facts is a real limit even when every individual array is bounded');
});

test('every small witness truncation, malformed long, decimal and lone surrogate fails closed', () =>
{
    const bytes = bytesOf('current-1');
    for (let end = 0;
        end < bytes.length;
        end++)
    {
        assert.throws(() => wire.decodeArticlePropertyValueReadResponse(bytes.subarray(0, end)));
    }
    assert.throws(() => wire.decodeArticlePropertyValueReadResponse(new Uint8Array(8388609)));
    const value = witness('typed-1');
    for (const currentArticleRevisionId of ['01', '+1', '1e2', '-0', '9223372036854775808', 9007199254740992])
    {
        assert.throws(() => wire.encodeArticlePropertyValueReadResponse({ ...value, currentArticleRevisionId }));
    }
    for (const number of [1.1, '1.1', { lo: 4294967296, mid: 0, hi: 0, scale: 0, negative: false },
        { lo: 1, mid: 0, hi: 0, scale: 29, negative: false }, { lo: 1, mid: 0, hi: 0, scale: 0, negative: 0 }])
    {
        const invalid = structuredClone(value);
        invalid.current.snapshot.values[0].value.number = number;
        assert.throws(() => wire.encodeArticlePropertyValueReadResponse(invalid));
    }
    const text = witness('typed-0');
    text.current.snapshot.values[0].value.text = '\ud800';
    assert.throws(() => wire.encodeArticlePropertyValueReadResponse(text));
});

test('primitive lower-case digests, closed enums, null/default provenance and coordinates refuse ambiguity', () =>
{
    const value = witness('current-1');
    for (const field of ['valueType', 'cardinality', 'status', 'visibilityScope', 'displayPlacement'])
    {
        const invalid = structuredClone(value);
        invalid.definitions[0][field] = 255;
        assert.throws(() => wire.encodeArticlePropertyValueReadResponse(invalid));
    }
    const invalid = structuredClone(value);
    invalid.current.snapshot.values[0].definitionDigest = 'A'.repeat(64);
    assert.throws(() => wire.encodeArticlePropertyValueReadResponse(invalid));
    const nullValue = witness('presence-1');
    nullValue.current.snapshot.values[0].value = { type: 2, boolean: true };
    assert.throws(() => wire.encodeArticlePropertyValueReadResponse(nullValue));
    const missing = witness('presence-0');
    missing.current.snapshot.values[0].defaultApplied = true;
    assert.throws(() => wire.encodeArticlePropertyValueReadResponse(missing));
    const draft = structuredClone(value);
    draft.current.snapshot.coordinates.draftId = '9';
    assert.throws(() => wire.encodeArticlePropertyValueReadResponse(draft));
    const unknown = structuredClone(value);
    unknown.current.snapshot.values[0].value = { type: 8, object: {}
    };
    assert.throws(() => wire.encodeArticlePropertyValueReadResponse(unknown));
    for (const status of [6, 7])
    {
        const allowed = { ...value, reconciliation: [{ definitionId: value.definitions[0].definitionId, status, reasonCode: 'canonical_owner_status' }] };
        assert.deepEqual(wire.decodeArticlePropertyValueReadResponse(wire.encodeArticlePropertyValueReadResponse(allowed)), allowed);
    }
    assert.throws(() => wire.encodeArticlePropertyValueReadResponse({ ...value, reconciliation: [{ definitionId: value.definitions[0].definitionId, status: 255, reasonCode: 'invalid' }] }));
});

test('read-only API passes canonical IDs, admin scope and no-store through existing transport', async () =>
{
    const calls = [];
    const transportUrl = moduleUrl('export function requestBinaryOnly(request) { globalThis.__propertyReadCalls.push(request); return Promise.resolve({ articleId: 7 }); }');
    globalThis.__propertyReadCalls = calls;
    const apiSource = readFileSync(path.join(root, 'src/frontend/src/api/articlePropertyValues.ts'), 'utf8')
        .replace("'@/composition/binaryTransport'", JSON.stringify(transportUrl))
        .replace("'@wasm/protocol/frame'", JSON.stringify(moduleUrl('export const FrameType = { ArticlePropertyValueReadResponse: 269 };')));
    const { articlePropertyValuesApi }
        = await import(moduleUrl(apiSource));
    await articlePropertyValuesApi.read(7, '9007199254740993');
    await articlePropertyValuesApi.read(7);
    assert.equal(calls[0].binaryUrl, '/api/binary/author/articles/7/properties?ownerUserId=9007199254740993');
    assert.equal(calls[1].binaryUrl, '/api/binary/author/articles/7/properties');
    assert.equal(calls[0].privateScope, 'admin');
    assert.equal(calls[0].frameType, 269);
    assert.deepEqual(calls[0].requestOptions, { method: 'GET', cache: 'no-store' });
    for (const owner of ['01', '+1', '0', '1e2', '9223372036854775808', 9007199254740992])
    {
        assert.throws(() => articlePropertyValuesApi.read(7, owner));
    }
    for (const article of [0, -1, 1.1, 2147483648])
    {
        assert.throws(() => articlePropertyValuesApi.read(article));
    }
    assert.equal(calls.length, 2);
    delete globalThis.__propertyReadCalls;
});
