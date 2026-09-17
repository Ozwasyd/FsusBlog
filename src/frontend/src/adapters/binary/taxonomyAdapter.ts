import { readInt32, readSliceRef, readSliceText } from '@/codecs/binary/reader';
import type { CategoryItem, TagItem, TaxonomyExactMetadata } from '@/contracts/binaryApi';
import { AppErrorCode, createAppError } from '@/utils/appError';

export function mapCategoryListFromPayload(payload: Uint8Array): CategoryItem[]
{
    return readCompactTaxonomyList(payload);
}

export function mapTagListFromPayload(payload: Uint8Array): TagItem[]
{
    return readCompactTaxonomyList(payload);
}

export function mapTaxonomyExactMetadataFromPayload(payload: Uint8Array): TaxonomyExactMetadata
{
    if (payload.byteLength < 24)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'taxonomy_exact_metadata_payload_too_short');
    }

    const blobLength = readInt32(payload, 4);
    const recordsOffset = 8 + blobLength;
    if (blobLength < 0 || payload.byteLength !== recordsOffset + 16)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'taxonomy_exact_metadata_payload_size_mismatch');
    }

    const blob = payload.subarray(8, recordsOffset);
    const description = readSliceText(blob, readSliceRef(payload, recordsOffset + 8));
    return {
        id: readInt32(payload, 0),
        name: readSliceText(blob, readSliceRef(payload, recordsOffset)),
        description: description.length === 0 ? null : description
    };
}

function readCompactTaxonomyList<T extends { id: number; name: string; articleCount: number; }>(payload: Uint8Array): T[]
{
    if (payload.byteLength < 8)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'taxonomy_payload_too_short');
    }

    const count = readInt32(payload, 0);
    if (count < 0)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'taxonomy_count_invalid');
    }

    const blobLength = readInt32(payload, 4);
    const recordsOffset = 8 + blobLength;
    const expectedLength = recordsOffset + count * 16;
    if (blobLength < 0 || payload.byteLength !== expectedLength)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'taxonomy_payload_size_mismatch');
    }

    const blob = payload.subarray(8, recordsOffset);
    const items: { id: number; name: string; articleCount: number; }[] = [];
    let offset = recordsOffset;
    for (let i = 0; i < count; i += 1)
    {
        const record = payload.subarray(offset, offset + 16);
        items.push({
            id: readInt32(record, 0),
            articleCount: readInt32(record, 4),
            name: readSliceText(blob, readSliceRef(record, 8))
        });
        offset += 16;
    }

    return items as T[];
}
