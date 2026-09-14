import { readFixedUtf8, readInt32, readInt64Number } from '@/codecs/binary/reader';
import type {
    UploadCompleteViewModel,
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
