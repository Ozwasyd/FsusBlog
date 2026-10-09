import { describe, expect, it } from 'vitest';

import { mapUploadAssetFactsFromPayload, mapUploadAssetPreviewFromPayload } from '@/adapters/binary/uploadAdapter';

// Independent ABI input, not an HTTP or committed-file receipt.
function header(size: bigint = 20_971_520n): Uint8Array
{
    const bytes = new Uint8Array(760);
    const text = (offset: number, value: string): void => { bytes.set(new TextEncoder().encode(value), offset); };
    text(0, 'fsusblog.upload-asset-facts.v1');
    text(64, '0123456789abcdef0123456789abcdef');
    text(128, '01234567-89ab-cdef-0123-456789abcdef');
    text(192, '/uploads/illustration/0123456789abcdef0123456789abcdef.png');
    text(448, 'image/png');
    text(512, '.png');
    text(560, 'a'.repeat(64));
    text(624, 'b'.repeat(64));
    text(688, 'c'.repeat(64));
    new DataView(bytes.buffer).setBigInt64(544, size, true);
    return bytes;
}

describe('facts-only upload wire', () =>
{
    it.each([1n, 8_387_832n, 8_387_833n, 20_971_520n])('admits exact header for committed size %s without bytes', size =>
    {
        const facts = mapUploadAssetFactsFromPayload(header(size));
        expect(facts.sizeBytes).toBe(Number(size));
        expect(facts.schema).toBe('fsusblog.upload-asset-facts.v1');
        expect(Object.keys(facts).sort()).toEqual(['assetId', 'assetVersionSha256', 'extension', 'height', 'mimeType',
            'publicUrl', 'referenceLedgerSha256', 'referenceRowCount', 'schema', 'sha256', 'sizeBytes', 'uploadId', 'width']);
        expect(facts).not.toHaveProperty('bytes');
        expect(facts).not.toHaveProperty('receiptRef');
        expect(facts).not.toHaveProperty('references');
    });

    it.each([0n, -1n, 20_971_521n, 9_007_199_254_740_993n])('refuses out-of-contract Int64 size %s', size =>
    {
        expect(() => mapUploadAssetFactsFromPayload(header(size))).toThrow();
    });

    it('rejects truncated, appended and preview payloads', () =>
    {
        const bytes = header();
        expect(() => mapUploadAssetFactsFromPayload(bytes.subarray(0, 759))).toThrow();
        expect(() => mapUploadAssetFactsFromPayload(new Uint8Array([...bytes, 1]))).toThrow();
        bytes.fill(0, 0, 64);
        bytes.set(new TextEncoder().encode('fsusblog.upload-asset-preview.v1'));
        expect(() => mapUploadAssetFactsFromPayload(bytes)).toThrow();
    });

    it('shares canonical field, reserved-byte and privacy validation with preview', () =>
    {
        for (const [offset, value] of [[0, 1], [100, 65], [128, 70], [192, 104], [448, 65],
            [548, 1], [555, 128], [560, 71], [624, 71], [688, 71], [755, 255], [756, 1]])
        {
            const changed = header();
            changed[offset] = value;
            expect(() => mapUploadAssetFactsFromPayload(changed)).toThrow();
        }
    });

    it('keeps original preview byte ownership and limits distinct', () =>
    {
        expect(() => mapUploadAssetPreviewFromPayload(header(1n))).toThrow();
        const preview = new Uint8Array(761);
        preview.set(header(1n));
        preview.fill(0, 0, 64);
        preview.set(new TextEncoder().encode('fsusblog.upload-asset-preview.v1'));
        preview[760] = 255;
        expect(mapUploadAssetPreviewFromPayload(preview).bytes).toEqual(new Uint8Array([255]));
        new DataView(preview.buffer).setBigInt64(544, 8_387_833n, true);
        expect(() => mapUploadAssetPreviewFromPayload(preview)).toThrow();
    });
});
