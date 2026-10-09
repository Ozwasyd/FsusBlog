import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const golden = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/protocol/author-article-selection-wire-golden.json'), 'utf8'));
const source = readFileSync(path.join(root, 'src/frontend/src/codecs/binary/authorArticleSelectionWire.generated.ts'), 'utf8');
const wire = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64'));
const bytes = row => Uint8Array.from(Buffer.from(row.payloadHex, 'hex'));
for (const row of golden.cases) test(`closed selected-article wire: ${row.name}`, () => {
    const suffix = row.frameType === 276 ? 'Request' : 'Response';
    const decode = wire[`decodeAuthorArticleSelectionRevalidation${suffix}`];
    const encode = wire[`encodeAuthorArticleSelectionRevalidation${suffix}`];
    if (!row.valid) { assert.throws(() => decode(bytes(row))); return; }
    assert.deepEqual(decode(bytes(row)), row.value);
    assert.deepEqual(Buffer.from(encode(row.value)), Buffer.from(row.payloadHex, 'hex'));
    for (let end = 0; end < bytes(row).length; end++) assert.throws(() => decode(bytes(row).subarray(0, end)));
});
test('encoder rejects number coercion, owner injection, malformed Unicode and correlation changes', () => {
    const request = golden.cases[0].value;
    const response = golden.cases[1].value;
    assert.equal(wire.matchesAuthorArticleSelectionRequest(request, response), true);
    for (const serverRevision of [1, '01', '0', '-1', '9223372036854775808'])
        assert.throws(() => wire.encodeAuthorArticleSelectionRevalidationRequest({ ...request, serverRevision }));
    assert.throws(() => wire.encodeAuthorArticleSelectionRevalidationRequest({ ...request, owner: response.owner }));
    assert.throws(() => wire.encodeAuthorArticleSelectionRevalidationResponse({ ...response, owner: { ...response.owner, siteScope: 'site\ud800' } }));
    for (const delta of [{ articleId: 1 }, { serverRevision: '1' }, { requestId: '11111111-1111-1111-1111-111111111111' }, { permissionToken: 'b'.repeat(64) }])
        assert.equal(wire.matchesAuthorArticleSelectionRequest(request, { ...response, ...delta }), false);
});
function frame(type, payload) {
    const output = Buffer.alloc(16 + payload.length); output.writeUInt32LE(0x53444541, 0); output[4] = 2; output[5] = 16;
    output.writeUInt16LE(type, 8); output.writeUInt32LE(payload.length, 10); let crc = 0xffff;
    for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? crc >>> 1 ^ 0xa001 : crc >>> 1; }
    output.writeUInt16LE(crc, 14); payload.copy(output, 16); return output;
}
test('production dispatcher enforces selection error17 and retains unknown/retired/header/CRC negative controls', () => {
    const rows = golden.cases.map(row => `${row.valid ? 0 : 17} ${frame(row.frameType, Buffer.from(row.payloadHex, 'hex')).toString('hex')}`);
    for (const row of golden.cases.filter(row => row.valid)) {
        const payload = Buffer.from(row.payloadHex, 'hex');
        for (let end = 0; end < payload.length; end++) rows.push(`17 ${frame(row.frameType, payload.subarray(0, end)).toString('hex')}`);
    }
    for (const type of [65534, 65535]) rows.push(`8 ${frame(type, Buffer.alloc(0)).toString('hex')}`);
    rows.push(`9 ${frame(186, Buffer.alloc(0)).toString('hex')}`, `16 ${frame(275, Buffer.alloc(0)).toString('hex')}`);
    const valid = frame(276, Buffer.from(golden.cases[0].payloadHex, 'hex'));
    for (const [offset, value, error] of [[0, 0, 2], [4, 1, 4], [5, 0, 5], [10, 0, 3], [14, valid[14] ^ 1, 6]]) {
        const malformed = Buffer.from(valid); malformed[offset] = value; rows.push(`${error} ${malformed.toString('hex')}`);
    }
    const directory = mkdtempSync(path.join(tmpdir(), 'fsus-selection-native-'));
    try {
        const executable = path.join(directory, 'fixture'), input = path.join(directory, 'cases.txt');
        writeFileSync(input, rows.join('\n') + '\n');
        const compile = spawnSync(process.env.CXX ?? 'g++', ['-std=c++23', '-Wall', '-Wextra', '-Werror', '-I', path.join(root, 'src/frontend/wasm/aeds/include'), path.join(root, 'tests/fixtures/protocol/writing-aid-preference-wire-native.cpp'), ...['aeds_decode.cpp', 'aeds_crc32.cpp', 'pod_parse_article.cpp'].map(name => path.join(root, 'src/frontend/wasm/aeds/src', name)), '-o', executable], { encoding: 'utf8' });
        assert.equal(compile.status, 0, compile.stdout + compile.stderr);
        const run = spawnSync(executable, [input, String(rows.length)], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.equal(spawnSync(executable, [input, String(rows.length + 1)]).status, 4);
    } finally { rmSync(directory, { recursive: true, force: true }); assert.equal(existsSync(directory), false); }
});
