import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function header(size = 20_971_520n)
{
    const bytes = Buffer.alloc(760);
    for (const [offset, value] of [[0, 'fsusblog.upload-asset-facts.v1'], [64, '0123456789abcdef0123456789abcdef'],
        [128, '01234567-89ab-cdef-0123-456789abcdef'], [192, '/uploads/illustration/0123456789abcdef0123456789abcdef.png'],
        [448, 'image/png'], [512, '.png'], [560, 'a'.repeat(64)], [624, 'b'.repeat(64)], [688, 'c'.repeat(64)]])
    {
        bytes.write(value, offset, 'ascii');
    }
    bytes.writeBigInt64LE(size, 544);
    return bytes;
}

function frame(payload, type = 285, flags = 0)
{
    const bytes = Buffer.alloc(16 + payload.length);
    bytes.writeUInt32LE(0x53444541);
    bytes[4] = 2;
    bytes[5] = 16;
    bytes.writeUInt16LE(flags, 6);
    bytes.writeUInt16LE(type, 8);
    bytes.writeUInt32LE(payload.length, 10);
    let crc = 0xffff;
    for (const byte of payload)
    {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
        {
            crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
        }
    }
    bytes.writeUInt16LE(crc, 14);
    payload.copy(bytes, 16);
    return bytes;
}

test('production native decoder admits fixed facts and preserves every refusal and count control', () =>
{
    const cases = [];
    const add = (name, bytes, expected) => cases.push({ name, bytes, expected });
    for (const size of [1n, 8_387_832n, 8_387_833n, 20_971_520n])
    {
        add(`size-${size}`, frame(header(size)), 0);
    }
    for (const size of [0n, -1n, 20_971_521n, 9_007_199_254_740_993n])
    {
        add(`refused-size-${size}`, frame(header(size)), 20);
    }
    for (const [offset, value] of [[0, 1], [100, 65], [128, 70], [192, 104], [448, 65], [548, 1],
        [555, 128], [560, 71], [624, 71], [688, 71], [755, 255], [756, 1]])
    {
        const bytes = header();
        bytes[offset] = value;
        add(`field-${offset}`, frame(bytes), 20);
    }
    const excessiveReferences = header();
    excessiveReferences.writeInt32LE(1025, 752);
    add('reference-cap', frame(excessiveReferences), 20);
    add('truncated-payload', frame(header().subarray(0, 759)), 20);
    add('appended-byte', frame(Buffer.concat([header(), Buffer.from([1])])), 20);
    add('flags-low', frame(header(), 285, 1), 20);
    add('flags-high', frame(header(), 285, 256), 20);
    const badCrc = frame(header());
    badCrc[14] ^= 1;
    add('crc', badCrc, 6);
    add('preview-is-not-facts', frame(header(), 275), 16);
    add('canvas-is-not-facts', frame(header(), 253), 11);
    add('retired-root', frame(header(), 40), 9);
    add('unknown-root', frame(header(), 65535), 8);
    const previewSchema = header();
    previewSchema.fill(0, 0, 64);
    previewSchema.write('fsusblog.upload-asset-preview.v1');
    add('preview-schema', frame(previewSchema), 20);
    const directory = mkdtempSync(path.join(tmpdir(), 'upload-facts-wire-'));
    try
    {
        const executable = path.join(directory, 'native');
        const compile = spawnSync(process.env.CXX ?? 'g++', ['-std=c++23', '-Wall', '-Wextra', '-Werror',
            '-I', path.join(root, 'src/frontend/wasm/aeds/include'), path.join(root, 'tests/native/UploadAssetFactsProtocolTests.cpp'),
            ...['aeds_decode.cpp', 'aeds_crc32.cpp', 'pod_parse_article.cpp'].map(name => path.join(root, 'src/frontend/wasm/aeds/src', name)),
            '-o', executable], { encoding: 'utf8' });
        assert.equal(compile.status, 0, compile.stdout + compile.stderr);
        const count = Buffer.alloc(4);
        count.writeUInt32LE(cases.length);
        const rows = cases.map(row =>
        {
            const metadata = Buffer.alloc(8);
            metadata.writeUInt32LE(row.bytes.length);
            metadata.writeUInt32LE(row.expected, 4);
            return Buffer.concat([metadata, row.bytes]);
        });
        const input = path.join(directory, 'cases.bin');
        writeFileSync(input, Buffer.concat([count, ...rows]));
        const run = spawnSync(executable, [input, String(cases.length)], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.equal(run.stdout.trim(), `verified_cases=${cases.length}`);
        const wrongCount = spawnSync(executable, [input, String(cases.length + 1)], { encoding: 'utf8' });
        assert.equal(wrongCount.status, 4);
        process.stdout.write(`native cases=${cases.length}, expected-count negative exit=4\n`);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
        assert.equal(existsSync(directory), false);
    }
});
