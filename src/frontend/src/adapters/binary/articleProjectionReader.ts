import { BinaryReader, readInt32, readInt64Number, readSliceRef } from '@/codecs/binary/reader';
import type { ArticleListItemResponse } from '@/contracts/binaryApi';
import { ARTICLE_LIST_WIRE as ARTICLE_LIST_ACCESS } from '@/generated/aedsArticleListWire';
import { AppErrorCode, createAppError } from '@/utils/appError';
import type { PublicArticleListCardProjection, PublicArticleListProjectionPage } from '@/view-contracts/articleList';


export type { PublicArticleListCardProjection, PublicArticleListProjectionPage };

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const PUBLIC_CARD_TAG_LIMIT = 5;

function fail(code: string): never
{
    throw createAppError(AppErrorCode.ProtocolFailure, code);
}

function readStrictSlice(blob: Uint8Array, slice: { offset: number; length: number; }): string
{
    if (slice.offset < 0 || slice.length < 0 || slice.offset > blob.byteLength || slice.length > blob.byteLength - slice.offset)
    {
        return fail('article_page_slice_range_invalid');
    }
    try
    {
        return strictUtf8.decode(blob.subarray(slice.offset, slice.offset + slice.length));
    }
    catch
    {
        return fail('article_page_slice_utf8_invalid');
    }
}

export function toPublicArticleListCardProjection(item: ArticleListItemResponse): PublicArticleListCardProjection
{
    return {
        id: item.id,
        createTime: item.createTime,
        category: {
            id: item.category?.id ?? 0,
            name: item.category?.name ?? ''
        },
        title: item.title,
        summary: item.summary ?? '',
        tags: (item.tags ?? []).slice(0, PUBLIC_CARD_TAG_LIMIT).map((tag) => ({ id: tag.id, name: tag.name }))
    };
}

export function mapPublicArticleListCardProjection(payload: Uint8Array): PublicArticleListProjectionPage
{
    let nextCursor: string | null;
    let hasMore: boolean;
    let total: number;
    let reader: BinaryReader;

    if (payload.byteLength < 8 || readInt32(payload, 0) !== ARTICLE_LIST_ACCESS.cursorMagic)
    {
        return fail('article_page_cursor_envelope_missing');
    }

    const version = readInt32(payload, 4);
    if (version === ARTICLE_LIST_ACCESS.cursorVersion)
    {
        reader = new BinaryReader(payload.subarray(8));
        const hasMoreByte = reader.readByte();
        if (hasMoreByte > 1)
        {
            return fail('article_page_cursor_has_more_invalid');
        }
        hasMore = hasMoreByte === 1;
        total = reader.readInt32();
        const cursorBytes = reader.readBlob();
        if (cursorBytes.byteLength > 512)
        {
            return fail('article_page_cursor_length_invalid');
        }
        try
        {
            nextCursor = cursorBytes.byteLength === 0 ? null : strictUtf8.decode(cursorBytes);
        }
        catch
        {
            return fail('article_page_cursor_utf8_invalid');
        }
        if (nextCursor && !/^[A-Za-z0-9_-]+$/.test(nextCursor))
        {
            return fail('article_page_cursor_format_invalid');
        }
        if (hasMore !== Boolean(nextCursor))
        {
            return fail('article_page_cursor_state_invalid');
        }
    }
    else
    {
        return fail('article_page_cursor_version_invalid');
    }

    const count = reader.readInt32();
    const tagRecordCount = reader.readInt32();
    if (count < 0 || tagRecordCount < 0)
    {
        return fail('article_page_count_invalid');
    }
    const blob = reader.readBlob();
    const tagBytes = tagRecordCount * ARTICLE_LIST_ACCESS.tagRecordBytes;
    const itemRecordSize = ARTICLE_LIST_ACCESS.recordBytes;
    if (total < 0 || reader.remaining() !== count * itemRecordSize + tagBytes)
    {
        return fail('article_page_record_layout_invalid');
    }

    const records = new Array<{
        id: number;
        createTimeUnixMs: number;
        categoryId: number;
        categoryName: { offset: number; length: number; };
        title: { offset: number; length: number; };
        summary: { offset: number; length: number; };
        tagStart: number;
        tagCount: number;
    }>(count);
    const o = ARTICLE_LIST_ACCESS.offsets;
    for (let index = 0; index < count; index += 1)
    {
        const record = reader.readSpan(itemRecordSize);
        const tagStart = readInt32(record, o.tagStart);
        const recordTagCount = readInt32(record, o.tagCount);
        const isDeleted = record[o.isDeleted] ?? 0;
        const hasIsDeleted = record[o.hasIsDeleted] ?? 0;
        if (tagStart < 0 || recordTagCount < 0 || tagStart > tagRecordCount
      || recordTagCount > tagRecordCount - tagStart || isDeleted > 1 || hasIsDeleted > 1
      || record[o.reserved0] !== 0 || record[o.reserved1] !== 0)
        {
            return fail('article_page_record_semantics_invalid');
        }
        const revisionLow = readInt32(record, o.currentRevisionId);
        const revisionHigh = readInt32(record, o.currentRevisionId + 4);
        const publicationLow = readInt32(record, o.currentPublicationId);
        const publicationHigh = readInt32(record, o.currentPublicationId + 4);
        const publicationNo = readInt32(record, o.publicationNo);
        if (revisionHigh < 0 || (revisionHigh === 0 && revisionLow === 0) || readInt32(record, o.revisionNo) <= 0
            || publicationHigh < 0 || publicationNo < 0 || (publicationHigh === 0 && publicationLow === 0) !== (publicationNo === 0))
        {
            return fail('article_version_coordinates_invalid');
        }
        records[index] = {
            id: readInt32(record, o.id),
            createTimeUnixMs: readInt64Number(record, o.createTimeUnixMs),
            categoryId: readInt32(record, o.categoryId),
            categoryName: readSliceRef(record, o.categoryName),
            title: readSliceRef(record, o.title),
            summary: readSliceRef(record, o.summary),
            tagStart,
            tagCount: recordTagCount
        };
    }

    const tagRecords = new Array<{ id: number; name: string; }>(tagRecordCount);
    for (let index = 0; index < tagRecordCount; index += 1)
    {
        const record = reader.readSpan(ARTICLE_LIST_ACCESS.tagRecordBytes);
        tagRecords[index] = {
            id: readInt32(record, 0),
            name: readStrictSlice(blob, readSliceRef(record, 4))
        };
    }
    if (reader.remaining() !== 0)
    {
        return fail('article_page_trailing_bytes');
    }

    const items = records.map((record) =>
    {
        const tagCount = Math.min(record.tagCount, PUBLIC_CARD_TAG_LIMIT);
        const tags = new Array<{ id: number; name: string; }>(tagCount);
        for (let tagIndex = 0; tagIndex < tagCount; tagIndex += 1)
        {
            tags[tagIndex] = tagRecords[record.tagStart + tagIndex]!;
        }
        return {
            id: record.id,
            createTime: new Date(record.createTimeUnixMs).toISOString(),
            category: {
                id: record.categoryId,
                name: readStrictSlice(blob, record.categoryName)
            },
            title: readStrictSlice(blob, record.title),
            summary: readStrictSlice(blob, record.summary),
            tags
        };
    });

    const result: PublicArticleListProjectionPage = {
        items,
        total,
        decodePath: 'projection'
    };
    return {
        ...result,
        nextCursor,
        hasMore
    };
}
