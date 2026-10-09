import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const spec = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/document-export-wire.json'), 'utf8'));
const golden = JSON.parse(readFileSync(path.join(root, 'tests/backend/Fixtures/document-export-payload-goldens-v1.json'), 'utf8'));
const source = readFileSync(path.join(root, 'src/frontend/src/codecs/binary/documentExportWire.generated.ts'), 'utf8');
const wire = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const coordinate = { kind: 2, articleId: '42', draftKey: null, revisionId: '17', publicationId: null, sourceVersion: '3' };
const request = { requestId: 'request-1', idempotencyKey: 'key-1', source: coordinate, formatId: 'self-contained-html', layoutProfile: 'document-reading-v1', themeProfile: 'light-v1', locale: 'en' };
const job = { taskId: 'task-1', requestId: 'request-1', source: coordinate, inputDigest: 'sha256:' + 'a'.repeat(64), taskDigest: 'sha256:' + 'b'.repeat(64), formatId: 'self-contained-html', providerId: 'fsus-html', providerVersion: '1', layoutProfile: 'document-reading-v1', themeProfile: 'light-v1', locale: 'en', status: 1, version: '1', createdAtUnixMs: '0', expiresAtUnixMs: '1000', reason: '', attempts: [], output: null };
const models = [request, { taskId: 'task-1' }, job, { offset: 0, limit: 20, hasMore: false, jobs: [] }, { offset: 20, limit: 20, hasMore: false, jobs: [job] }];
const roots = ['DocumentExportRequest', 'DocumentExportTaskRequest', 'DocumentExportJobResponse', 'DocumentExportPageResponse', 'DocumentExportPageResponse'];
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
        for (let bit = 0;
            bit < 8;
            bit++)
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
function payloadRow(rootName, payload, valid)
{
    row(valid ? 0 : 18, frame(spec.roots[rootName].value, Buffer.from(payload)));
}
function accept(rootName, value)
{
    const payload = wire[`encode${rootName}`](value);
    assert.deepEqual(wire[`decode${rootName}`](payload), value);
    payloadRow(rootName, payload, true);
    return payload;
}
for (const [index, vector] of golden.vectors.entries())
{
    test(`managed literal golden parity: ${vector.name}`, () =>
    {
        const rootName = roots[index];
        const payload = Buffer.from(vector.hex, 'hex');
        assert.deepEqual(wire[`decode${rootName}`](payload), models[index]);
        assert.deepEqual(Buffer.from(wire[`encode${rootName}`](models[index])), payload);
        payloadRow(rootName, payload, true);
        for (let end = 0;
            end < payload.length;
            end++)
        {
            const truncated = payload.subarray(0, end);
            assert.throws(() => wire[`decode${rootName}`](truncated));
            payloadRow(rootName, truncated, false);
        }
        for (const invalid of [Buffer.concat([payload, Buffer.of(0)]), Buffer.concat([Buffer.of(2, 0, 0, 0), payload.subarray(4)])])
        {
            assert.throws(() => wire[`decode${rootName}`](invalid));
            payloadRow(rootName, invalid, false);
        }
    });
}
test('closed root allocation and sole response decoder mappings', () =>
{
    const protocol = JSON.parse(readFileSync(path.join(root, 'src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8'));
    assert.deepEqual(protocol.frameTypes.filter(item => item.value >= 278).map(item => [item.name, item.value, item.goldenFamily, item.goldenOrder]), Object.entries(spec.roots).map(([name, value], index) => [name, value.value, value.family, 269 + index]));
    assert.deepEqual(protocol.reservedFrameValues ?? [], []);
    const registry = readFileSync(path.join(root, 'src/frontend/src/composition/binaryDecoderRegistry.ts'), 'utf8');
    for (const name of ['DocumentExportJobResponse', 'DocumentExportPageResponse'])
    {
        assert.equal(registry.split(`    FrameType.${name}`).length - 1, 1);
        assert.equal(registry.split(`    [FrameType.${name}, decode${name}]`).length - 1, 1);
    }
    for (const name of ['DocumentExportRequest', 'DocumentExportTaskRequest'])
    {
        assert.ok(!registry.includes(`FrameType.${name}`));
    }
});
test('full Int64 and timestamp bounds remain exact decimal strings', () =>
{
    const exact = { ...job, source: { ...coordinate, articleId: '9223372036854775807', revisionId: '9007199254740993', sourceVersion: '9223372036854775807' }, version: '9223372036854775807', createdAtUnixMs: '-62135596800000', expiresAtUnixMs: '253402300799999', attempts: [{ number: 1, diagnostic: true, startedAtUnixMs: '-62135596800000', finishedAtUnixMs: '253402300799999', status: 10, reason: '' }], output: { outputId: 'output', mediaType: 'application/pdf', extension: '.pdf', outputDigest: 'sha256:' + 'c'.repeat(64), resultReceiptDigest: 'sha256:' + 'd'.repeat(64), length: '9223372036854775807', createdAtUnixMs: '-62135596800000', expiresAtUnixMs: '253402300799999', deletedAtUnixMs: '0' } };
    accept('DocumentExportJobResponse', exact);
    for (const version of [1, '-0', '01', '0', '9223372036854775808', '-1'])
    {
        assert.throws(() => wire.encodeDocumentExportJobResponse({ ...exact, version }));
    }
    for (const createdAtUnixMs of ['-62135596800001', '253402300800000'])
    {
        assert.throws(() => wire.encodeDocumentExportJobResponse({ ...exact, createdAtUnixMs }));
    }
});
test('Unicode scalars, UTF16 limits and exact whitespace rules', () =>
{
    for (const taskId of [' leading and trailing ', '\ufeff', '\ufffe', '🌍'.repeat(96), '界'.repeat(192)])
    {
        accept('DocumentExportTaskRequest', { taskId });
    }
    for (const taskId of ['', ' '.repeat(192), '\u1680', '\u0085', 'x\u0000', 'x\u007f', 'x\u009f', '\ud800', '🌍'.repeat(97), '界'.repeat(193)])
    {
        assert.throws(() => wire.encodeDocumentExportTaskRequest({ taskId }));
    }
    accept('DocumentExportJobResponse', { ...job, reason: ' '.repeat(2048) });
    for (const reason of ['x'.repeat(2049), '\udfff', 'x\n'])
    {
        assert.throws(() => wire.encodeDocumentExportJobResponse({ ...job, reason }));
    }
    for (const bad of [Buffer.from('0100000001000000ff', 'hex'), Buffer.from('0100000002000000c080', 'hex'), Buffer.from('0100000003000000eda080', 'hex'), Buffer.from('0100000004000000f4908080', 'hex')])
    {
        assert.throws(() => wire.decodeDocumentExportTaskRequest(bad));
        payloadRow('DocumentExportTaskRequest', bad, false);
    }
});
test('closed coordinates, format, status, digest and presence tags', () =>
{
    for (const source of [{ kind: 1, articleId: '42', draftKey: '草稿-🌍', revisionId: null, publicationId: null, sourceVersion: '3' }, { ...coordinate, kind: 3, publicationId: '9' }])
    {
        accept('DocumentExportRequest', { ...request, source });
    }
    for (const formatId of ['self-contained-html', 'pdf', 'docx', 'epub'])
    {
        accept('DocumentExportRequest', { ...request, formatId });
    }
    for (const delta of [{ owner: 'forged' }, { formatId: 'html' }, { source: { ...coordinate, draftKey: 'mixed' } }, { source: { ...coordinate, kind: 3 } }, { source: { ...coordinate, articleId: '0' } }])
    {
        assert.throws(() => wire.encodeDocumentExportRequest({ ...request, ...delta }));
    }
    for (const delta of [{ status: 0 }, { status: 11 }, { inputDigest: 'SHA256:' + 'a'.repeat(64) }, { inputDigest: 'sha256:' + 'A'.repeat(64) }, { output: { ...job, length: '-1' } }, { expiresAtUnixMs: '0' }, { attempts: [{ number: 2, diagnostic: false, startedAtUnixMs: '0', finishedAtUnixMs: null, status: 1, reason: '' }] }])
    {
        assert.throws(() => wire.encodeDocumentExportJobResponse({ ...job, ...delta }));
    }
    const bad = Buffer.from(golden.vectors[4].hex, 'hex');
    bad[12] = 2;
    assert.throws(() => wire.decodeDocumentExportPageResponse(bad));
    payloadRow('DocumentExportPageResponse', bad, false);
    const badSource = Buffer.from(golden.vectors[0].hex, 'hex');
    badSource[38] = 2;
    assert.throws(() => wire.decodeDocumentExportRequest(badSource));
    payloadRow('DocumentExportRequest', badSource, false);
});
test('bounded attempts, pages, duplicate identities and maximum valid payloads', () =>
{
    const big = { ...job, taskId: '界'.repeat(192), requestId: '界'.repeat(192), source: { kind: 1, articleId: '9223372036854775807', draftKey: '界'.repeat(192), revisionId: null, publicationId: null, sourceVersion: '9223372036854775807' }, providerId: '界'.repeat(192), providerVersion: '界'.repeat(192), layoutProfile: '界'.repeat(192), themeProfile: '界'.repeat(192), locale: '界'.repeat(192), reason: '界'.repeat(2048), attempts: [1, 2, 3].map(number => ({ number, diagnostic: true, startedAtUnixMs: '-62135596800000', finishedAtUnixMs: '253402300799999', status: 10, reason: '界'.repeat(2048) })), output: { outputId: '界'.repeat(192), mediaType: '界'.repeat(192), extension: '界'.repeat(192), outputDigest: 'sha256:' + 'c'.repeat(64), resultReceiptDigest: 'sha256:' + 'd'.repeat(64), length: '9223372036854775807', createdAtUnixMs: '-62135596800000', expiresAtUnixMs: '253402300799999', deletedAtUnixMs: '0' } };
    const payload = accept('DocumentExportJobResponse', big);
    assert.ok(payload.length <= 32768);
    const jobs = Array.from({ length: 50 }, (_, index) => ({ ...big, taskId: String(index).padStart(3, '0') + '界'.repeat(189) }));
    accept('DocumentExportPageResponse', { offset: 2147483647, limit: 50, hasMore: true, jobs });
    for (const value of [{ offset: -1, limit: 20, hasMore: false, jobs: [] }, { offset: 0, limit: 51, hasMore: false, jobs: [] }, { offset: 0, limit: 20, hasMore: true, jobs: [job] }, { offset: 0, limit: 20, hasMore: false, jobs: [job, job] }])
    {
        assert.throws(() => wire.encodeDocumentExportPageResponse(value));
    }
});
// This deliberately unchecked fixture writer creates hostile fields without using the production encoder.
function hostilePayload(rootName, value)
{
    const chunks = [];
    const putInt = (value, size) =>
    {
        const bytes = Buffer.alloc(size);
        if (size === 4)
        {
            bytes.writeInt32LE(value);
        }
        else
        {
            bytes.writeBigInt64LE(BigInt(value));
        }
        chunks.push(bytes);
    };
    const field = (type, value) =>
    {
        if (type.endsWith('?'))
        {
            chunks.push(Buffer.of(value === null ? 0 : 1));
            if (value !== null)
            {
                field(type.slice(0, -1), value);
            }
        }
        else if (type.startsWith('IReadOnlyList<'))
        {
            putInt(value.length, 4);
            for (const item of value)
            {
                record(type.slice(14, -1), item);
            }
        }
        else if (type === 'int')
        {
            putInt(value, 4);
        }
        else if (type === 'long')
        {
            putInt(value, 8);
        }
        else if (type === 'bool')
        {
            chunks.push(Buffer.of(typeof value === 'boolean' ? Number(value) : value));
        }
        else if (type === 'string')
        {
            const bytes = Buffer.from(value);
            putInt(bytes.length, 4);
            chunks.push(bytes);
        }
        else
        {
            record(type, value);
        }
    };
    const record = (type, value) =>
    {
        for (const declaration of spec.records[type])
        {
            const split = declaration.lastIndexOf(' ');
            const name = declaration.slice(split + 1);
            field(declaration.slice(0, split), value[name[0].toLowerCase() + name.slice(1)]);
        }
    };
    putInt(1, 4);
    record(spec.roots[rootName].model, value);
    return Buffer.concat(chunks);
}
test('hostile structured fields refuse in TypeScript and real native without encoder sanitization', () =>
{
    const attempt = { number: 1, diagnostic: true, startedAtUnixMs: '0', finishedAtUnixMs: '1', status: 1, reason: '' };
    const output = { outputId: 'output', mediaType: 'application/pdf', extension: '.pdf', outputDigest: 'sha256:' + 'c'.repeat(64), resultReceiptDigest: 'sha256:' + 'd'.repeat(64), length: '1', createdAtUnixMs: '0', expiresAtUnixMs: '1000', deletedAtUnixMs: null };
    const rows = [];
    for (const delta of [{ kind: 0 }, { kind: 4 }, { articleId: '0' }, { articleId: '-1' }, { revisionId: '0' }, { sourceVersion: '0' }, { draftKey: 'mixed' }, { kind: 3, publicationId: null }, { kind: 3, publicationId: '0' }, { kind: 1, draftKey: 'draft' }])
    {
        rows.push(['DocumentExportRequest', { ...request, source: { ...coordinate, ...delta } }]);
    }
    for (const delta of [{ formatId: 'HTML' }, { requestId: '' }, { locale: '界'.repeat(193) }, { idempotencyKey: 'x\u0085' }])
    {
        rows.push(['DocumentExportRequest', { ...request, ...delta }]);
    }
    for (const delta of [{ status: 0 }, { status: 11 }, { version: '0' }, { version: '-1' }, { createdAtUnixMs: '-62135596800001' }, { expiresAtUnixMs: '253402300800000' }, { expiresAtUnixMs: '0' }, { inputDigest: 'SHA256:' + 'a'.repeat(64) }, { taskDigest: 'sha256:' + 'A'.repeat(64) }, { reason: '界'.repeat(2049) }])
    {
        rows.push(['DocumentExportJobResponse', { ...job, ...delta }]);
    }
    for (const delta of [{ number: 0 }, { number: 2 }, { diagnostic: 2 }, { status: 0 }, { status: 11 }, { startedAtUnixMs: '2' }, { startedAtUnixMs: '-62135596800001' }, { finishedAtUnixMs: '253402300800000' }, { reason: 'x\n' }])
    {
        rows.push(['DocumentExportJobResponse', { ...job, attempts: [{ ...attempt, ...delta }] }]);
    }
    rows.push(['DocumentExportJobResponse', { ...job, attempts: [attempt, attempt, attempt, attempt] }]);
    for (const delta of [{ outputId: '' }, { length: '-1' }, { outputDigest: 'sha256:' + 'A'.repeat(64) }, { resultReceiptDigest: 'unsigned' }, { expiresAtUnixMs: '0' }, { createdAtUnixMs: '-62135596800001' }, { deletedAtUnixMs: '253402300800000' }])
    {
        rows.push(['DocumentExportJobResponse', { ...job, output: { ...output, ...delta } }]);
    }
    for (const value of [{ offset: -1, limit: 20, hasMore: false, jobs: [] }, { offset: 0, limit: 0, hasMore: false, jobs: [] }, { offset: 0, limit: 51, hasMore: false, jobs: [] }, { offset: 0, limit: 20, hasMore: 2, jobs: [] }, { offset: 0, limit: 20, hasMore: true, jobs: [job] }, { offset: 0, limit: 20, hasMore: false, jobs: [job, job] }, { offset: 0, limit: 50, hasMore: false, jobs: Array.from({ length: 51 }, (_, index) => ({ ...job, taskId: String(index) })) }])
    {
        rows.push(['DocumentExportPageResponse', value]);
    }
    assert.equal(rows.length, 48);
    for (const [rootName, value] of rows)
    {
        const payload = hostilePayload(rootName, value);
        assert.throws(() => wire[`decode${rootName}`](payload));
        payloadRow(rootName, payload, false);
    }
    const tag = Buffer.from(golden.vectors[2].hex, 'hex');
    tag[tag.length - 1] = 2;
    assert.throws(() => wire.decodeDocumentExportJobResponse(tag));
    payloadRow('DocumentExportJobResponse', tag, false);
});

test('production native dispatcher preserves guards, per-root budgets, error18 and CRC order', () =>
{
    const valid = frame(278, Buffer.from(golden.vectors[0].hex, 'hex'));
    row(1, Buffer.alloc(0));
    row(1, Buffer.alloc(15));
    for (const [offset, value, expected] of [[0, 0, 2], [4, 1, 4], [5, 0, 5], [10, 0, 3], [14, valid[14] ^ 1, 6]])
    {
        const bad = Buffer.from(valid);
        bad[offset] = value;
        row(expected, bad);
    }
    for (const type of [65534, 65535])
    {
        row(8, frame(type, Buffer.alloc(0), 65535));
    }
    for (const type of [40, 43, 44, 45, 46, 180, 181, 186])
    {
        row(9, frame(type, Buffer.alloc(0), 65535));
    }
    for (const [name, item] of Object.entries(spec.roots))
    {
        const payload = Buffer.alloc(item.maxPayloadBytes + 1);
        const oversize = frame(item.value, payload);
        oversize[14] ^= 1;
        row(18, oversize);
        const inBudget = frame(item.value, Buffer.alloc(item.maxPayloadBytes));
        inBudget[14] ^= 1;
        row(6, inBudget);
        const flags = frame(item.value, Buffer.from(golden.vectors[roots.indexOf(name)].hex, 'hex'), 1);
        flags[14] ^= 1;
        row(18, flags);
        const flagsHigh = frame(item.value, Buffer.from(golden.vectors[roots.indexOf(name)].hex, 'hex'), 256);
        row(18, flagsHigh);
    }
    row(16, frame(275, Buffer.alloc(0)));
    row(17, frame(276, Buffer.alloc(0)));
    row(15, frame(272, Buffer.alloc(0)));
    assert.equal(nativeRows.length, 940);
    const directory = mkdtempSync(path.join(tmpdir(), 'fsus-export-native-'));
    try
    {
        const executable = path.join(directory, 'fixture');
        const input = path.join(directory, 'cases.txt');
        writeFileSync(input, nativeRows.join('\n') + '\n');
        const compile = spawnSync(process.env.CXX ?? 'g++', ['-std=c++23', '-Wall', '-Wextra', '-Werror', '-I', path.join(root, 'src/frontend/wasm/aeds/include'), path.join(root, 'tests/fixtures/protocol/writing-aid-preference-wire-native.cpp'), ...['aeds_decode.cpp', 'aeds_crc32.cpp', 'pod_parse_article.cpp'].map(name => path.join(root, 'src/frontend/wasm/aeds/src', name)), '-o', executable], { encoding: 'utf8' });
        assert.equal(compile.status, 0, compile.stdout + compile.stderr);
        const run = spawnSync(executable, [input, String(nativeRows.length)], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.equal(spawnSync(executable, [input, String(nativeRows.length + 1)]).status, 4);
        if (process.env.FSUSBLOG_EXPORT_WIRE_EVIDENCE)
        {
            writeFileSync(path.join(process.env.FSUSBLOG_EXPORT_WIRE_EVIDENCE, 'native-cases.txt'), nativeRows.join('\n') + '\n');
            writeFileSync(path.join(process.env.FSUSBLOG_EXPORT_WIRE_EVIDENCE, 'native-count.txt'), String(nativeRows.length) + '\n');
            writeFileSync(path.join(process.env.FSUSBLOG_EXPORT_WIRE_EVIDENCE, 'native-run.log'), run.stdout + run.stderr);
        }
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
        assert.equal(existsSync(directory), false);
    }
});
