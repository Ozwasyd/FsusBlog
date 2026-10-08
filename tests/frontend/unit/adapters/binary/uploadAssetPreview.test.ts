import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapUploadAssetPreviewFromPayload } from '@/adapters/binary/uploadAdapter';

function fixture(): Uint8Array {
    const bytes = new Uint8Array(761);
    const text = (offset: number, value: string): void => { bytes.set(new TextEncoder().encode(value), offset); };
    text(0, 'fsusblog.upload-asset-preview.v1');
    text(64, '0123456789abcdef0123456789abcdef');
    text(128, '01234567-89ab-cdef-0123-456789abcdef');
    text(192, '/uploads/illustration/0123456789abcdef0123456789abcdef.png');
    text(448, 'image/png'); text(512, '.png');
    const view = new DataView(bytes.buffer);
    view.setBigInt64(544, 1n, true); view.setInt32(552, 1, true); view.setInt32(556, 1, true);
    text(560, 'a'.repeat(64)); text(624, 'b'.repeat(64)); text(688, 'c'.repeat(64));
    bytes[760] = 255;
    return bytes;
}

describe('upload asset preview closed wire', () => {
    it('copies bytes and projects only closed public facts', () => {
        const bytes = fixture();
        const preview = mapUploadAssetPreviewFromPayload(bytes);
        expect(preview.assetId).toBe('01234567-89ab-cdef-0123-456789abcdef');
        expect([...preview.bytes]).toEqual([255]);
        bytes[760] = 0;
        expect([...preview.bytes]).toEqual([255]);
        expect(preview).not.toHaveProperty('uploadToken');
        expect(preview).not.toHaveProperty('storageKey');
        expect(preview).not.toHaveProperty('references');
    });
    it.each([[0,1],[100,65],[128,70],[192,104],[448,65],[544,0],[548,1],[555,128],
        [560,71],[624,71],[688,71],[755,255],[756,1]])('rejects mutated header at %i', (offset, value) => {
        const bytes = fixture(); bytes[offset!] = value!;
        expect(() => mapUploadAssetPreviewFromPayload(bytes)).toThrow('upload_asset_preview_invalid');
    });
    it('rejects missing/trailing original bytes', () => {
        expect(() => mapUploadAssetPreviewFromPayload(fixture().slice(0,760))).toThrow();
        expect(() => mapUploadAssetPreviewFromPayload(new Uint8Array(759))).toThrow();
        expect(() => mapUploadAssetPreviewFromPayload(new Uint8Array([...fixture(),0]))).toThrow();
    });
    // Optional cross-stack companion to the actual PostgreSQL/native-file test, never a fabricated fixture.
    if (process.env.FSUSBLOG_PREVIEW_TEST_FRAME) {
        it('consumes the actual C# protected transport frame', () => {
            const frame = new Uint8Array(readFileSync(process.env.FSUSBLOG_PREVIEW_TEST_FRAME!));
            expect(new DataView(frame.buffer).getUint16(8,true)).toBe(253);
            const preview = mapUploadAssetPreviewFromPayload(frame.subarray(16));
            expect(preview.mimeType).toBe('image/png');
            expect(preview.sizeBytes).toBe(preview.bytes.length);
            expect(preview.width).toBe(1);
            expect(preview.referenceRowCount).toBe(0);
        });
    }
});
