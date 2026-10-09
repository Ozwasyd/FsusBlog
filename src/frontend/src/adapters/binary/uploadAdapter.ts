import { readFixedUtf8, readInt32, readInt64Number } from '@/codecs/binary/reader';
import type {
    UploadCompleteViewModel,
    UploadAssetPreviewViewModel,
    UploadAssetFactsViewModel,
    UploadInitViewModel,
    UploadPartAckViewModel,
    UploadPartMapViewModel,
    UploadPartRangeViewModel,
    UploadStatusViewModel
} from '@/contracts/binaryApi';
import { createAppError, AppErrorCode } from '@/utils/appError';

export function mapUploadInitFromPayload(payload: Uint8Array): UploadInitViewModel
{
    assertLength(payload, 568, 'upload_init_payload_invalid');
    return {
        uploadId: readFixedUtf8(payload, 0, 64),
        fileName: readFixedUtf8(payload, 64, 256),
        mimeType: readFixedUtf8(payload, 320, 64),
        targetFormat: readFixedUtf8(payload, 384, 32),
        totalBytes: readInt64Number(payload, 416),
        chunkSize: readInt32(payload, 424),
        totalParts: readInt32(payload, 428),
        expiresAt: readIsoDate(payload, 432),
        uploadToken: readFixedUtf8(payload, 440, 128)
    };
}

export function mapUploadStatusFromPayload(payload: Uint8Array): UploadStatusViewModel
{
    assertLength(payload, 136, 'upload_status_payload_invalid');
    return {
        uploadId: readFixedUtf8(payload, 0, 64),
        status: readFixedUtf8(payload, 64, 32),
        totalBytes: readInt64Number(payload, 96),
        uploadedBytes: readInt64Number(payload, 104),
        chunkSize: readInt32(payload, 112),
        totalParts: readInt32(payload, 116),
        uploadedPartCount: readInt32(payload, 120),
        nextPartHint: readInt32(payload, 124),
        expiresAt: readIsoDate(payload, 128)
    };
}

export function mapUploadPartMapFromPayload(payload: Uint8Array): UploadPartMapViewModel
{
    if (payload.byteLength < 72)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'upload_part_map_payload_invalid');
    }

    const uploadId = readFixedUtf8(payload, 0, 64);
    const count = readInt32(payload, 64);
    if (count < 0 || payload.byteLength !== 72 + count * 8)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'upload_part_map_count_invalid');
    }

    const uploadedRanges: UploadPartRangeViewModel[] = [];
    for (let i = 0; i < count; i++)
    {
        const offset = 72 + i * 8;
        uploadedRanges.push({
            start: readInt32(payload, offset),
            end: readInt32(payload, offset + 4)
        });
    }

    return { uploadId, uploadedRanges };
}

export function mapUploadPartAckFromPayload(payload: Uint8Array): UploadPartAckViewModel
{
    assertLength(payload, 92, 'upload_part_ack_payload_invalid');
    return {
        uploadId: readFixedUtf8(payload, 0, 64),
        partNumber: readInt32(payload, 64),
        offset: readInt64Number(payload, 68),
        size: readInt32(payload, 76),
        uploadedBytes: readInt64Number(payload, 80),
        uploadedPartCount: readInt32(payload, 88)
    };
}

export function mapUploadCompleteFromPayload(payload: Uint8Array): UploadCompleteViewModel
{
    assertLength(payload, 648, 'upload_complete_payload_invalid');
    return {
        uploadId: readFixedUtf8(payload, 0, 64),
        url: readFixedUtf8(payload, 64, 256),
        relativeUrl: readFixedUtf8(payload, 320, 256),
        mimeType: readFixedUtf8(payload, 576, 64),
        totalBytes: readInt64Number(payload, 640)
    };
}

function assertLength(payload: Uint8Array, expected: number, code: string): void
{
    if (payload.byteLength !== expected)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, code);
    }
}

function readIsoDate(payload: Uint8Array, offset: number): string
{
    return new Date(readInt64Number(payload, offset)).toISOString().replace('.000Z', 'Z');
}

export function mapUploadAssetFactsFromPayload(payload: Uint8Array): UploadAssetFactsViewModel
{
    return { ...readUploadAssetHeader(payload, 'fsusblog.upload-asset-facts.v1', 20971520n, false), schema: 'fsusblog.upload-asset-facts.v1' };
}

export function mapUploadAssetPreviewFromPayload(payload: Uint8Array): UploadAssetPreviewViewModel
{
    return { ...readUploadAssetHeader(payload, 'fsusblog.upload-asset-preview.v1', 8387832n, true),
        schema: 'fsusblog.upload-asset-preview.v1', bytes: payload.slice(760) };
}

function readUploadAssetHeader(payload: Uint8Array, expectedSchema: string, maximumSize: bigint, includesBytes: boolean): Omit<UploadAssetPreviewViewModel, 'schema' | 'bytes'>
{
    const invalid = (): never =>
    {
        throw createAppError(AppErrorCode.ProtocolFailure, includesBytes ? 'upload_asset_preview_invalid' : 'upload_asset_facts_invalid');
    };
    if (payload.byteLength < 760)
    {
        invalid();
    }
    const field = (offset: number, length: number): string =>
    {
        const bytes = payload.subarray(offset, offset + length);
        const zero = bytes.indexOf(0);
        const end = zero < 0 ? length : zero;
        for (let i = 0; i < length; i++)
        {
            const byte = bytes[i];
            if (i < end ? byte < 33 || byte > 126 : byte !== 0)
            {
                invalid();
            }
        }
        return String.fromCharCode(...bytes.subarray(0, end));
    };
    const schema = field(0, 64);
    const uploadId = field(64, 64);
    const assetId = field(128, 64);
    const publicUrl = field(192, 256);
    const mimeType = field(448, 64);
    const extension = field(512, 32);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const size = view.getBigInt64(544, true);
    const width = view.getInt32(552, true);
    const height = view.getInt32(556, true);
    const sha256 = field(560, 64);
    const assetVersionSha256 = field(624, 64);
    const referenceLedgerSha256 = field(688, 64);
    const referenceRowCount = view.getInt32(752, true);
    const mime = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
        ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.ico', 'image/x-icon']]).get(extension);
    const canonicalId = `${uploadId.slice(0, 8)}-${uploadId.slice(8, 12)}-${uploadId.slice(12, 16)}-${uploadId.slice(16, 20)}-${uploadId.slice(20)}`;
    if (schema !== expectedSchema || !/^[0-9a-f]{32}$/u.test(uploadId)
        || assetId !== canonicalId || !mime || mimeType !== mime
        || publicUrl !== `/uploads/illustration/${uploadId}${extension}`
        || size <= 0n || size > maximumSize || (includesBytes ? BigInt(payload.byteLength - 760) !== size : payload.byteLength !== 760)
        || width < 0 || height < 0 || (width === 0) !== (height === 0)
        || referenceRowCount < 0 || referenceRowCount > 1024 || view.getInt32(756, true) !== 0
        || ![sha256, assetVersionSha256, referenceLedgerSha256].every(value => /^[0-9a-f]{64}$/u.test(value)))
    {
        invalid();
    }
    return { uploadId, assetId, publicUrl, mimeType, extension,
        sizeBytes: Number(size), width, height, sha256, assetVersionSha256, referenceLedgerSha256,
        referenceRowCount };
}
