import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const spec = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/document-export-source-options-wire.json'), 'utf8'));
const golden = JSON.parse(readFileSync(path.join(root, 'tests/backend/Fixtures/document-export-source-options-payload-goldens-v1.json'), 'utf8'));
const source = readFileSync(path.join(root, 'src/frontend/src/codecs/binary/documentExportSourceOptionsWire.generated.ts'), 'utf8');
const wire = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const selector = { kind: 2, articleId: 42, draftKey: null, revisionId: '17', publicationId: null };
const coordinate = { kind: 2, articleId: '42', draftKey: null, revisionId: '17', publicationId: null, sourceVersion: '9007199254740993' };
const choice = { choiceId: 'a'.repeat(64), label: '原始标题 🌍', coordinate };
const nativeRows = [];
function frame(type, payload, flags = 0)
{
    const result = Buffer.alloc(16 + payload.length);
    result.writeUInt32LE(0x53444541, 0);
    result[4] = 2;
    result[5] = 16;
    result.writeUInt16LE(flags, 6);
    result.writeUInt16LE(type, 8);
    result.writeUInt32LE(payload.length, 10);
    let crc = 0xffff;
    for (const byte of payload)
    {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
        {
            crc = crc & 1 ? crc >>> 1 ^ 0xa001 : crc >>> 1;
        }
    }
    result.writeUInt16LE(crc, 14);
    payload.copy(result, 16);
    return result;
}
function row(error, bytes)
{
    nativeRows.push(`${error} ${bytes.length ? bytes.toString('hex') : '-'}`);
}
function payloadRow(name, payload, valid)
{
    row(valid ? 0 : 19, frame(spec.roots[name].value, Buffer.from(payload)));
}
function accept(name, value)
{
    const payload = wire[`encode${name}`](value);
    assert.deepEqual(wire[`decode${name}`](payload), value);
    payloadRow(name, payload, true);
    return payload;
}
function reject(name, payload)
{
    assert.throws(() => wire[`decode${name}`](payload), /document_export_source_options_payload_invalid|encoded data/u);
    payloadRow(name, payload, false);
}
for (const vector of golden.vectors)
{
    test(`literal POD golden parity: ${vector.name}`, () =>
    {
        const payload = Buffer.from(vector.hex, 'hex');
        assert.deepEqual(wire[`decode${vector.root}`](payload), vector.model);
        assert.deepEqual(Buffer.from(wire[`encode${vector.root}`](vector.model)), payload);
        payloadRow(vector.root, payload, true);
        for (let end = 0; end < payload.length; end++)
        {
            reject(vector.root, payload.subarray(0, end));
        }
        reject(vector.root, Buffer.concat([payload, Buffer.of(0)]));
        const revision = Buffer.from(payload);
        revision.writeInt32LE(2, 0);
        reject(vector.root, revision);
    });
}
test('formal source roots retain existing identities and one response decoder', () =>
{
    const protocol = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8'));
    assert.deepEqual(protocol.frameTypes.filter(item => item.value >= 278).map(item => [item.name, item.value]), [
        ['DocumentExportRequest', 278], ['DocumentExportTaskRequest', 279], ['DocumentExportJobResponse', 280], ['DocumentExportPageResponse', 281],
        ['DocumentExportSourceCaptureRequest', 282], ['DocumentExportRevisionChoicesRequest', 283], ['DocumentExportSourceChoicesResponse', 284]
    ]);
    const registry = readFileSync(path.join(root, 'src/frontend/src/composition/binaryDecoderRegistry.ts'), 'utf8');
    assert.equal(registry.split('    [FrameType.DocumentExportSourceChoicesResponse, decodeDocumentExportSourceChoicesResponse]').length - 1, 1);
    assert.ok(!registry.includes('FrameType.DocumentExportSourceCaptureRequest'));
    assert.ok(!registry.includes('FrameType.DocumentExportRevisionChoicesRequest'));
});
test('all source kinds preserve independent full Int64 coordinates', () =>
{
    for (const selected of [
        { kind: 1, articleId: 42, draftKey: '草稿-🌍', revisionId: null, publicationId: null },
        selector, { ...selector, kind: 3, revisionId: '9223372036854775807', publicationId: '9007199254740993' }
    ])
    {
        accept('DocumentExportSourceCaptureRequest', { sources: [selected] });
        accept('DocumentExportSourceChoicesResponse', { choices: [{ ...choice, coordinate: { ...selected, articleId: '9223372036854775807', sourceVersion: '9223372036854775807' } }] });
    }
    for (const sourceVersion of [1, '0', '-1', '01', '-0', '9223372036854775808'])
    {
        assert.throws(() => wire.encodeDocumentExportSourceChoicesResponse({ choices: [{ ...choice, coordinate: { ...coordinate, sourceVersion } }] }));
    }
});
test('actual persisted string bounds and dotnet trim rules retain Unicode', () =>
{
    for (const label of ['', '🌍'.repeat(128), '界'.repeat(256), '\ufeff', 'x\n\u0000'])
    {
        accept('DocumentExportSourceChoicesResponse', { choices: [{ ...choice, label }] });
    }
    for (const draftKey of ['🌍'.repeat(48), '界'.repeat(96), '\ufeff', 'x\n\u0000x'])
    {
        accept('DocumentExportSourceCaptureRequest', { sources: [{ kind: 1, articleId: 42, draftKey, revisionId: null, publicationId: null }] });
    }
    for (const draftKey of ['', ' ', '\u0085draft', 'draft\r', '\ud800', '🌍'.repeat(49)])
    {
        assert.throws(() => wire.encodeDocumentExportSourceCaptureRequest({ sources: [{ kind: 1, articleId: 42, draftKey, revisionId: null, publicationId: null }] }));
    }
    for (const label of ['\ud800', '界'.repeat(257)])
    {
        assert.throws(() => wire.encodeDocumentExportSourceChoicesResponse({ choices: [{ ...choice, label }] }));
    }
});
test('closed fields refuse forged actors versions sources and duplicate identities', () =>
{
    for (const delta of [{ actor: 'forged' }, { siteScope: 'forged' }, { sessionId: 'forged' }, { sourceVersion: '1' }])
    {
        assert.throws(() => wire.encodeDocumentExportSourceCaptureRequest({ sources: [{ ...selector, ...delta }] }));
    }
    for (const delta of [{ boundSource: {} }, { fingerprint: 'forged' }, { rights: {} }, { source: 'private' }])
    {
        assert.throws(() => wire.encodeDocumentExportSourceChoicesResponse({ choices: [{ ...choice, ...delta }] }));
    }
    for (const delta of [{ kind: 0 }, { articleId: 2147483648 }, { articleId: 0 }, { draftKey: 'mixed' }, { publicationId: '1' }])
    {
        assert.throws(() => wire.encodeDocumentExportSourceCaptureRequest({ sources: [{ ...selector, ...delta }] }));
    }
    assert.throws(() => wire.encodeDocumentExportSourceCaptureRequest({ sources: [selector, selector] }));
    assert.throws(() => wire.encodeDocumentExportSourceChoicesResponse({ choices: [choice, choice] }));
    for (const choiceId of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)])
    {
        assert.throws(() => wire.encodeDocumentExportSourceChoicesResponse({ choices: [{ ...choice, choiceId }] }));
    }
    const duplicateCapture = Buffer.concat([Buffer.from('0100000002000000', 'hex'), Buffer.from(golden.vectors[0].hex, 'hex').subarray(8), Buffer.from(golden.vectors[0].hex, 'hex').subarray(8)]);
    reject('DocumentExportSourceCaptureRequest', duplicateCapture);
    const duplicatedChoice = Buffer.from(golden.vectors[3].hex, 'hex').subarray(8);
    reject('DocumentExportSourceChoicesResponse', Buffer.concat([Buffer.from('0100000002000000', 'hex'), duplicatedChoice, duplicatedChoice]));
});
test('fifty choice budgets bound real fields without truncating source content', () =>
{
    const sources = Array.from({ length: 50 }, (_, index) => ({ kind: 1, articleId: index + 1, draftKey: '界'.repeat(96), revisionId: null, publicationId: null }));
    const choices = sources.map((selected, index) => ({ choiceId: index.toString(16).padStart(64, '0'), label: '界'.repeat(256), coordinate: { ...selected, articleId: String(selected.articleId), sourceVersion: '9223372036854775807' } }));
    assert.ok(accept('DocumentExportSourceCaptureRequest', { sources }).length <= 65520);
    assert.ok(accept('DocumentExportSourceChoicesResponse', { choices }).length <= 131072);
    accept('DocumentExportSourceCaptureRequest', { sources: [] });
    assert.throws(() => wire.encodeDocumentExportSourceCaptureRequest({ sources: [...sources, { ...sources[0], articleId: 51 }] }));
    assert.throws(() => wire.encodeDocumentExportSourceChoicesResponse({ choices: [...choices, { ...choices[0], choiceId: 'f'.repeat(64) }] }));
    for (const name of ['DocumentExportSourceCaptureRequest', 'DocumentExportSourceChoicesResponse'])
    {
        for (const count of [-1, 51, 2147483647])
        {
            const bytes = Buffer.alloc(8);
            bytes.writeInt32LE(1, 0);
            bytes.writeInt32LE(count, 4);
            reject(name, bytes);
        }
    }
});
test('hostile UTF8 lengths tags and exact selector patterns refuse in both decoders', () =>
{
    const capture = Buffer.from(golden.vectors[0].hex, 'hex');
    for (const [offset, byte] of [[8, 0], [12, 0], [16, 2], [17, 2], [26, 1]])
    {
        const bad = Buffer.from(capture);
        bad[offset] = byte;
        reject('DocumentExportSourceCaptureRequest', bad);
    }
    const original = Buffer.from(golden.vectors[3].hex, 'hex');
    for (const count of [-1, 2147483647, 257])
    {
        const bad = Buffer.from(original);
        bad.writeInt32LE(count, 8);
        reject('DocumentExportSourceChoicesResponse', bad);
    }
    for (const hex of ['ff', 'c080', 'eda080', 'f4908080'])
    {
        const bytes = Buffer.from(hex, 'hex');
        const length = Buffer.alloc(4);
        length.writeInt32LE(bytes.length);
        // Label begins after version/count and the bounded 64-byte ChoiceId.
        reject('DocumentExportSourceChoicesResponse', Buffer.concat([original.subarray(0, 76), length, bytes, original.subarray(80 + original.readInt32LE(76))]));
    }
});
test('production dispatcher preserves source error19 budgets CRC guards and cleans native resources', () =>
{
    row(1, Buffer.alloc(0));
    row(8, frame(65535, Buffer.alloc(0)));
    row(9, frame(40, Buffer.alloc(0)));
    for (const [name, item] of Object.entries(spec.roots))
    {
        const payload = Buffer.from(golden.vectors.find(vector => vector.root === name).hex, 'hex');
        const badCrc = frame(item.value, payload);
        badCrc[14] ^= 1;
        row(6, badCrc);
        for (const flags of [1, 256])
        {
            const bytes = frame(item.value, payload, flags);
            bytes[14] ^= 1;
            row(19, bytes);
        }
        const oversized = frame(item.value, Buffer.alloc(item.maxPayloadBytes + 1));
        oversized[14] ^= 1;
        row(19, oversized);
    }
    assert.equal(nativeRows.length, 236);
    const directory = mkdtempSync(path.join(tmpdir(), 'fsus-export-source-options-native-'));
    try
    {
        const executable = path.join(directory, 'fixture');
        const input = path.join(directory, 'cases.txt');
        writeFileSync(input, nativeRows.join('\n') + '\n');
        const compile = spawnSync(process.env.CXX ?? 'g++', ['-std=c++23', '-Wall', '-Wextra', '-Werror', '-I', path.join(root, 'src/frontend/wasm/aeds/include'), path.join(root, 'tests/fixtures/protocol/document-export-wire-native.cpp'), ...['aeds_decode.cpp', 'aeds_crc32.cpp', 'pod_parse_article.cpp'].map(name => path.join(root, 'src/frontend/wasm/aeds/src', name)), '-o', executable], { encoding: 'utf8' });
        assert.equal(compile.status, 0, compile.stdout + compile.stderr);
        const run = spawnSync(executable, [input, String(nativeRows.length)], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.equal(spawnSync(executable, [input, String(nativeRows.length + 1)]).status, 4);
        if (process.env.FSUSBLOG_EXPORT_SOURCE_OPTIONS_EVIDENCE)
        {
            const evidence = process.env.FSUSBLOG_EXPORT_SOURCE_OPTIONS_EVIDENCE;
            writeFileSync(path.join(evidence, 'native-cases.txt'), nativeRows.join('\n') + '\n');
            writeFileSync(path.join(evidence, 'native-count.txt'), String(nativeRows.length) + '\n');
            writeFileSync(path.join(evidence, 'native-run.log'), run.stdout + run.stderr);
        }
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
        assert.equal(existsSync(directory), false);
    }
});
