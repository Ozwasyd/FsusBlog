import {
    decodeAedsFrame,
    decodeArticlePage,
    decodeArticleDetail,
    decodeTaxonomyList,
    decodeSearchManifest,
    decodePublicAotPayload,
    encodeAedsFrame
} from '../../tests/frontend/support/aeds-envelope.mjs';

const UTF8_DECODER = new TextDecoder('utf-8');
const UTF8_ENCODER = new TextEncoder();

export {
    decodeAedsFrame,
    decodeArticlePage,
    decodeArticleDetail,
    decodeTaxonomyList,
    decodeSearchManifest,
    decodePublicAotPayload,
    encodeAedsFrame
};

export function encodeTaxonomyList(items = [])
{
    const strings = items.map((it) => Buffer.from(it.name || '', 'utf8'));
    const totalBlobLen = strings.reduce((sum, s) => sum + s.length, 0);
    const blob = Buffer.alloc(totalBlobLen);
    let offset = 0;
    const sliceRefs = [];
    for (const s of strings)
    {
        s.copy(blob, offset);
        sliceRefs.push({ offset, length: s.length });
        offset += s.length;
    }

    const buf = Buffer.alloc(8 + totalBlobLen + items.length * 16);
    buf.writeInt32LE(items.length, 0);
    buf.writeInt32LE(totalBlobLen, 4);
    blob.copy(buf, 8);
    let recordOffset = 8 + totalBlobLen;
    for (let i = 0; i < items.length; i += 1)
    {
        buf.writeInt32LE(items[i].id, recordOffset);
        buf.writeInt32LE(items[i].articleCount ?? 0, recordOffset + 4);
        buf.writeInt32LE(sliceRefs[i].offset, recordOffset + 8);
        buf.writeInt32LE(sliceRefs[i].length, recordOffset + 12);
        recordOffset += 16;
    }
    return buf;
}


export function murmurHash3(source)
{
    const data = typeof source === 'string' ? UTF8_ENCODER.encode(source) : new Uint8Array(source);
    const length = data.byteLength;
    const roundedEnd = length & ~3;
    let h1 = 0;

    const C1 = 0xcc9e2d51;
    const C2 = 0x1b873593;

    for (let i = 0; i < roundedEnd; i += 4)
    {
        let k1 = (data[i]) | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
        k1 = Math.imul(k1, C1);
        k1 = (k1 << 15) | (k1 >>> 17);
        k1 = Math.imul(k1, C2);

        h1 ^= k1;
        h1 = (h1 << 13) | (h1 >>> 19);
        h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
    }

    let k1 = 0;
    switch (length & 3)
    {
        case 3:
            k1 ^= data[roundedEnd + 2] << 16;
            // fallthrough
        case 2:
            k1 ^= data[roundedEnd + 1] << 8;
            // fallthrough
        case 1:
            k1 ^= data[roundedEnd];
            k1 = Math.imul(k1, C1);
            k1 = (k1 << 15) | (k1 >>> 17);
            k1 = Math.imul(k1, C2);
            h1 ^= k1;
            break;
        default:
            break;
    }

    h1 ^= length;
    h1 ^= h1 >>> 16;
    h1 = Math.imul(h1, 0x85ebca6b);
    h1 ^= h1 >>> 13;
    h1 = Math.imul(h1, 0xc2b2ae35);
    h1 ^= h1 >>> 16;
    return h1 >>> 0;
}

export function decodeCommentArticleCursor(payload)
{
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    if (bytes.byteLength < 13)
    {
        throw new Error('comment_article_cursor_header_truncated');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const nextCursorRaw = view.getBigInt64(0, true);
    const hasMore = bytes[8] === 1;
    const count = view.getInt32(9, true);
    if (count < 0)
    {
        throw new Error('comment_article_cursor_count_invalid');
    }

    let offset = 13;
    const data = [];

    for (let index = 0; index < count; index += 1)
    {
        if (offset + 68 > bytes.byteLength)
        {
            throw new Error('comment_thread_pod_truncated');
        }

        const pod = bytes.subarray(offset, offset + 68);
        const podView = new DataView(pod.buffer, pod.byteOffset, pod.byteLength);
        offset += 68;

        if (offset + 4 > bytes.byteLength)
        {
            throw new Error('comment_thread_blob_length_truncated');
        }

        const blobLength = view.getInt32(offset, true);
        offset += 4;
        if (blobLength < 0 || offset + blobLength > bytes.byteLength)
        {
            throw new Error('comment_thread_blob_truncated');
        }

        const blob = bytes.subarray(offset, offset + blobLength);
        offset += blobLength;

        const id = String(podView.getBigInt64(0, true));
        const rootId = String(podView.getBigInt64(16, true));
        const isDeleted = pod[40] === 1;
        const isEdited = (pod[42] & 1) === 1;
        const createTime = new Date(Number(podView.getBigInt64(44, true))).toISOString();
        const contentOffset = podView.getInt32(52, true);
        const contentLength = podView.getInt32(56, true);

        if (contentOffset < 0 || contentLength < 0 || contentOffset + contentLength > blob.byteLength)
        {
            throw new Error('comment_content_slice_invalid');
        }

        const content = UTF8_DECODER.decode(blob.subarray(contentOffset, contentOffset + contentLength));
        const replyCount = podView.getInt32(60, true);
        const hasMoreReplies = pod[64] === 1;
        const previewReplyCount = pod[65] ?? 0;

        const repliesPreview = [];
        for (let r = 0; r < previewReplyCount; r += 1)
        {
            if (offset + 28 > bytes.byteLength)
            {
                throw new Error('comment_reply_preview_pod_truncated');
            }
            const replyPod = bytes.subarray(offset, offset + 28);
            const replyPodView = new DataView(replyPod.buffer, replyPod.byteOffset, replyPod.byteLength);
            offset += 28;

            if (offset + 4 > bytes.byteLength)
            {
                throw new Error('comment_reply_preview_blob_length_truncated');
            }
            const replyBlobLength = view.getInt32(offset, true);
            offset += 4;
            if (replyBlobLength < 0 || offset + replyBlobLength > bytes.byteLength)
            {
                throw new Error('comment_reply_preview_blob_truncated');
            }
            const replyBlob = bytes.subarray(offset, offset + replyBlobLength);
            offset += replyBlobLength;

            const replyId = String(replyPodView.getBigInt64(0, true));
            const replyIsDeleted = replyPod[8] === 1;
            const replyCreateTime = new Date(Number(replyPodView.getBigInt64(12, true))).toISOString();
            const replyContentOffset = replyPodView.getInt32(20, true);
            const replyContentLength = replyPodView.getInt32(24, true);
            const replyContent = (replyContentOffset >= 0 && replyContentOffset + replyContentLength <= replyBlob.byteLength)
                ? UTF8_DECODER.decode(replyBlob.subarray(replyContentOffset, replyContentOffset + replyContentLength))
                : '';

            repliesPreview.push({
                id: replyId,
                isDeleted: replyIsDeleted,
                createTime: replyCreateTime,
                content: replyContent
            });
        }

        data.push({
            id,
            rootId,
            isDeleted,
            isEdited,
            createTime,
            content,
            replyCount,
            hasMoreReplies,
            repliesPreview
        });
    }

    return {
        nextCursor: nextCursorRaw === 0n ? null : String(nextCursorRaw),
        hasMore,
        count,
        data
    };
}

export function encodeCommentArticleCursor(cursorData)
{
    const dataList = Array.isArray(cursorData.data) ? cursorData.data : [];
    const count = Number.isInteger(cursorData.count) ? cursorData.count : dataList.length;
    const hasMore = Boolean(cursorData.hasMore);
    const nextCursorRaw = cursorData.nextCursor ? BigInt(cursorData.nextCursor) : 0n;

    // First pass: compute total byte size
    let totalSize = 13;
    for (const comment of dataList)
    {
        const contentBytes = UTF8_ENCODER.encode(comment.content ?? '');
        totalSize += 68 + 4 + contentBytes.byteLength;
        const replies = Array.isArray(comment.repliesPreview) ? comment.repliesPreview : [];
        for (const reply of replies)
        {
            const replyBytes = UTF8_ENCODER.encode(reply.content ?? '');
            totalSize += 28 + 4 + replyBytes.byteLength;
        }
    }

    const buffer = new Uint8Array(totalSize);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    view.setBigInt64(0, nextCursorRaw, true);
    buffer[8] = hasMore ? 1 : 0;
    view.setInt32(9, count, true);

    let offset = 13;
    for (const comment of dataList)
    {
        const podStart = offset;
        const commentId = BigInt(comment.id ?? 0);
        const rootId = BigInt(comment.rootId ?? 0);
        const createTimeMs = BigInt(new Date(comment.createTime || Date.now()).getTime());
        const contentBytes = UTF8_ENCODER.encode(comment.content ?? '');
        const replies = Array.isArray(comment.repliesPreview) ? comment.repliesPreview : [];

        view.setBigInt64(podStart, commentId, true);
        view.setBigInt64(podStart + 16, rootId, true);
        buffer[podStart + 40] = comment.isDeleted ? 1 : 0;
        buffer[podStart + 42] = comment.isEdited ? 1 : 0;
        view.setBigInt64(podStart + 44, createTimeMs, true);
        view.setInt32(podStart + 52, 0, true);
        view.setInt32(podStart + 56, contentBytes.byteLength, true);
        view.setInt32(podStart + 60, comment.replyCount ?? replies.length, true);
        buffer[podStart + 64] = comment.hasMoreReplies ? 1 : 0;
        buffer[podStart + 65] = replies.length;
        offset += 68;

        view.setInt32(offset, contentBytes.byteLength, true);
        offset += 4;
        buffer.set(contentBytes, offset);
        offset += contentBytes.byteLength;

        for (const reply of replies)
        {
            const replyPodStart = offset;
            const replyId = BigInt(reply.id ?? 0);
            const replyCreateTimeMs = BigInt(new Date(reply.createTime || Date.now()).getTime());
            const replyBytes = UTF8_ENCODER.encode(reply.content ?? '');

            view.setBigInt64(replyPodStart, replyId, true);
            buffer[replyPodStart + 8] = reply.isDeleted ? 1 : 0;
            view.setBigInt64(replyPodStart + 12, replyCreateTimeMs, true);
            view.setInt32(replyPodStart + 20, 0, true);
            view.setInt32(replyPodStart + 24, replyBytes.byteLength, true);
            offset += 28;

            view.setInt32(offset, replyBytes.byteLength, true);
            offset += 4;
            buffer.set(replyBytes, offset);
            offset += replyBytes.byteLength;
        }
    }

    return buffer;
}

export function decodeSearchShard(payload)
{
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    if (bytes.byteLength < 72)
    {
        throw new Error('search_shard_header_truncated');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = view.getUint32(0, true);
    const version = view.getUint32(4, true);
    if (magic !== 0x32534846 || version !== 4)
    {
        throw new Error(`search_shard_magic_or_version_invalid: magic=0x${magic.toString(16)}, version=${version}`);
    }

    const role = view.getUint32(8, true);
    const flags = view.getUint32(12, true);
    const termCount = view.getUint32(16, true);
    const docCount = view.getUint32(20, true);
    const categoryCount = view.getUint32(24, true);
    const tagCount = view.getUint32(28, true);
    const tagRefCount = view.getUint32(32, true);
    const termOffset = view.getUint32(36, true);
    const docOffset = view.getUint32(40, true);
    const categoryOffset = view.getUint32(44, true);
    const tagOffset = view.getUint32(48, true);
    const tagRefOffset = view.getUint32(52, true);
    const stringPoolOffset = view.getUint32(56, true);
    const postingOffset = view.getUint32(60, true);
    const postingLength = view.getUint32(64, true);
    const avgDocLength = view.getFloat32(68, true);

    const readString = (offset, length) =>
    {
        if (length === 0)
        {
            return '';
        }
        const start = stringPoolOffset + offset;
        if (start + length > bytes.byteLength)
        {
            throw new Error('search_shard_string_overflow');
        }
        return UTF8_DECODER.decode(bytes.subarray(start, start + length));
    };

    const categories = [];
    for (let i = 0; i < categoryCount; i += 1)
    {
        const entryOffset = categoryOffset + i * 16;
        if (entryOffset + 16 > bytes.byteLength)
        {
            throw new Error('search_shard_category_truncated');
        }
        const id = view.getUint32(entryOffset, true);
        const nameOffset = view.getUint32(entryOffset + 4, true);
        const nameLength = view.getUint16(entryOffset + 8, true);
        const name = readString(nameOffset, nameLength);
        categories.push({ id, name });
    }

    const tags = [];
    for (let i = 0; i < tagCount; i += 1)
    {
        const entryOffset = tagOffset + i * 16;
        if (entryOffset + 16 > bytes.byteLength)
        {
            throw new Error('search_shard_tag_truncated');
        }
        const id = view.getUint32(entryOffset, true);
        const nameOffset = view.getUint32(entryOffset + 4, true);
        const nameLength = view.getUint16(entryOffset + 8, true);
        const name = readString(nameOffset, nameLength);
        tags.push({ id, name });
    }

    const tagRefs = [];
    for (let i = 0; i < tagRefCount; i += 1)
    {
        const offset = tagRefOffset + i * 2;
        if (offset + 2 > bytes.byteLength)
        {
            throw new Error('search_shard_tag_refs_truncated');
        }
        tagRefs.push(view.getUint16(offset, true));
    }

    const docs = [];
    for (let i = 0; i < docCount; i += 1)
    {
        const entryOffset = docOffset + i * 76;
        if (entryOffset + 76 > bytes.byteLength)
        {
            throw new Error('search_shard_doc_truncated');
        }
        const articleId = view.getUint32(entryOffset, true);
        const categoryIndex = view.getUint16(entryOffset + 4, true);
        const tagCountForDoc = view.getUint16(entryOffset + 6, true);
        const tagRefStart = view.getUint32(entryOffset + 8, true);
        const views = view.getUint32(entryOffset + 12, true);
        const commentCount = view.getUint32(entryOffset + 16, true);
        const docLength = view.getUint32(entryOffset + 20, true);
        const publishUnixMs = Number(view.getBigInt64(entryOffset + 24, true));
        const titleOffset = view.getUint32(entryOffset + 32, true);
        const titleLength = view.getUint16(entryOffset + 36, true);
        const summaryOffset = view.getUint32(entryOffset + 40, true);
        const summaryLength = view.getUint16(entryOffset + 44, true);
        const revisionId = Number(view.getBigInt64(entryOffset + 52, true));
        const revisionNo = view.getInt32(entryOffset + 60, true);
        const publicationId = Number(view.getBigInt64(entryOffset + 64, true));
        const publicationNo = view.getInt32(entryOffset + 72, true);

        const title = readString(titleOffset, titleLength);
        const summary = readString(summaryOffset, summaryLength);
        const category = categories[categoryIndex] ?? null;
        const docTagRefs = tagRefs.slice(tagRefStart, tagRefStart + tagCountForDoc).map((idx) => tags[idx] ?? null);

        docs.push({
            articleId,
            categoryIndex,
            category,
            tagRefs: docTagRefs,
            views,
            commentCount,
            docLength,
            publishUnixMs,
            title,
            summary,
            revisionId,
            revisionNo,
            publicationId,
            publicationNo
        });
    }

    const terms = [];
    for (let i = 0; i < termCount; i += 1)
    {
        const entryOffset = termOffset + i * 24;
        if (entryOffset + 24 > bytes.byteLength)
        {
            throw new Error('search_shard_term_truncated');
        }
        const hash = view.getUint32(entryOffset, true);
        const idf = view.getFloat32(entryOffset + 4, true);
        const termPostingOffset = view.getUint32(entryOffset + 8, true);
        const termPostingLength = view.getUint32(entryOffset + 12, true);
        const hasPositions = view.getUint32(entryOffset + 16, true) !== 0;
        terms.push({
            hash,
            idf,
            postingOffset: termPostingOffset,
            postingLength: termPostingLength,
            hasPositions
        });
    }

    return {
        magic,
        version,
        role,
        flags,
        termCount,
        docCount,
        categoryCount,
        tagCount,
        tagRefCount,
        termOffset,
        docOffset,
        categoryOffset,
        tagOffset,
        tagRefOffset,
        stringPoolOffset,
        postingOffset,
        postingLength,
        avgDocLength,
        categories,
        tags,
        tagRefs,
        docs,
        terms,
        bytes
    };
}

function writeVint(buffer, cursorRef, value)
{
    let current = value >>> 0;
    while (current >= 0x80)
    {
        buffer[cursorRef.offset++] = (current & 0x7f) | 0x80;
        current >>>= 7;
    }
    buffer[cursorRef.offset++] = current & 0x7f;
}

function readVint(bytes, cursorRef, end)
{
    let value = 0;
    let shift = 0;
    while (cursorRef.offset < end && shift <= 28)
    {
        const b = bytes[cursorRef.offset++];
        value |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0)
        {
            return value >>> 0;
        }
        shift += 7;
    }
    throw new Error('search_shard_vint_overflow');
}

export function encodeSearchShard({
    role = 0,
    flags = 1,
    avgDocLength = 1.0,
    categories = [],
    tags = [],
    tagRefs = [],
    docs = [],
    terms = [],
    postingsBlob = new Uint8Array(0)
})
{
    let stringPoolLength = 0;
    const stringPoolMap = [];

    const internString = (str) =>
    {
        if (!str)
        {
            return { offset: 0, length: 0 };
        }
        const encoded = UTF8_ENCODER.encode(str);
        const offset = stringPoolLength;
        stringPoolLength += encoded.byteLength;
        stringPoolMap.push(encoded);
        return { offset, length: encoded.byteLength };
    };

    const categoryEntries = categories.map((cat) => ({
        id: cat.id,
        str: internString(cat.name)
    }));

    const tagEntries = tags.map((t) => ({
        id: t.id,
        str: internString(t.name)
    }));

    const docEntries = docs.map((doc) => ({
        articleId: doc.articleId,
        categoryIndex: doc.categoryIndex ?? 0,
        tagCount: (doc.tagRefs ?? []).length,
        tagRefStart: 0,
        views: doc.views ?? 0,
        commentCount: doc.commentCount ?? 0,
        docLength: doc.docLength ?? 1,
        publishUnixMs: BigInt(doc.publishUnixMs ?? 0),
        titleStr: internString(doc.title),
        summaryStr: internString(doc.summary),
        revisionId: BigInt(doc.revisionId ?? 0),
        revisionNo: doc.revisionNo ?? 0,
        publicationId: BigInt(doc.publicationId ?? 0),
        publicationNo: doc.publicationNo ?? 0
    }));

    const headerSize = 72;
    const categoryOffset = headerSize;
    const categorySize = categoryEntries.length * 16;
    const tagOffset = categoryOffset + categorySize;
    const tagSize = tagEntries.length * 16;
    const tagRefOffset = tagOffset + tagSize;
    const tagRefSize = tagRefs.length * 2;
    const docOffset = tagRefOffset + tagRefSize;
    const docSize = docEntries.length * 76;
    const termOffset = docOffset + docSize;
    const termSize = terms.length * 24;
    const stringPoolOffset = termOffset + termSize;
    const postingOffset = stringPoolOffset + stringPoolLength;
    const totalSize = postingOffset + postingsBlob.byteLength;

    const buffer = new Uint8Array(totalSize);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    // Header
    view.setUint32(0, 0x32534846, true);
    view.setUint32(4, 4, true);
    view.setUint32(8, role, true);
    view.setUint32(12, flags, true);
    view.setUint32(16, terms.length, true);
    view.setUint32(20, docEntries.length, true);
    view.setUint32(24, categoryEntries.length, true);
    view.setUint32(28, tagEntries.length, true);
    view.setUint32(32, tagRefs.length, true);
    view.setUint32(36, termOffset, true);
    view.setUint32(40, docOffset, true);
    view.setUint32(44, categoryOffset, true);
    view.setUint32(48, tagOffset, true);
    view.setUint32(52, tagRefOffset, true);
    view.setUint32(56, stringPoolOffset, true);
    view.setUint32(60, postingOffset, true);
    view.setUint32(64, postingsBlob.byteLength, true);
    view.setFloat32(68, avgDocLength, true);

    // Categories
    for (let i = 0; i < categoryEntries.length; i += 1)
    {
        const entry = categoryEntries[i];
        const offset = categoryOffset + i * 16;
        view.setUint32(offset, entry.id, true);
        view.setUint32(offset + 4, entry.str.offset, true);
        view.setUint16(offset + 8, entry.str.length, true);
    }

    // Tags
    for (let i = 0; i < tagEntries.length; i += 1)
    {
        const entry = tagEntries[i];
        const offset = tagOffset + i * 16;
        view.setUint32(offset, entry.id, true);
        view.setUint32(offset + 4, entry.str.offset, true);
        view.setUint16(offset + 8, entry.str.length, true);
    }

    // TagRefs
    for (let i = 0; i < tagRefs.length; i += 1)
    {
        view.setUint16(tagRefOffset + i * 2, tagRefs[i], true);
    }

    // Docs
    for (let i = 0; i < docEntries.length; i += 1)
    {
        const entry = docEntries[i];
        const offset = docOffset + i * 76;
        view.setUint32(offset, entry.articleId, true);
        view.setUint16(offset + 4, entry.categoryIndex, true);
        view.setUint16(offset + 6, entry.tagCount, true);
        view.setUint32(offset + 8, entry.tagRefStart, true);
        view.setUint32(offset + 12, entry.views, true);
        view.setUint32(offset + 16, entry.commentCount, true);
        view.setUint32(offset + 20, entry.docLength, true);
        view.setBigInt64(offset + 24, entry.publishUnixMs, true);
        view.setUint32(offset + 32, entry.titleStr.offset, true);
        view.setUint16(offset + 36, entry.titleStr.length, true);
        view.setUint32(offset + 40, entry.summaryStr.offset, true);
        view.setUint16(offset + 44, entry.summaryStr.length, true);
        view.setBigInt64(offset + 52, entry.revisionId, true);
        view.setInt32(offset + 60, entry.revisionNo, true);
        view.setBigInt64(offset + 64, entry.publicationId, true);
        view.setInt32(offset + 72, entry.publicationNo, true);
    }

    // Terms
    for (let i = 0; i < terms.length; i += 1)
    {
        const term = terms[i];
        const offset = termOffset + i * 24;
        view.setUint32(offset, term.hash, true);
        view.setFloat32(offset + 4, term.idf ?? 1.0, true);
        view.setUint32(offset + 8, term.postingOffset ?? 0, true);
        view.setUint32(offset + 12, term.postingLength ?? 0, true);
        view.setUint32(offset + 16, term.hasPositions ? 1 : 0, true);
    }

    // String pool
    let curStringOffset = stringPoolOffset;
    for (const chunk of stringPoolMap)
    {
        buffer.set(chunk, curStringOffset);
        curStringOffset += chunk.byteLength;
    }

    // Postings blob
    if (postingsBlob.byteLength > 0)
    {
        buffer.set(postingsBlob, postingOffset);
    }

    return buffer;
}

export function buildPostingsBlobForTerms(termPostings)
{
    // termPostings: Array of { hash, idf, hits: [{ articleId, titleTf, metaTf, bodyTf, positions }] }
    let totalSize = 0;
    for (const entry of termPostings)
    {
        totalSize += 10;
        for (const hit of entry.hits)
        {
            totalSize += 10 + 3 + 10;
            for (const pos of (hit.positions ?? []))
            {
                totalSize += 15;
            }
        }
    }

    const tempBuffer = new Uint8Array(Math.max(totalSize, 1024));
    const cursor = { offset: 0 };
    const termsMeta = [];

    for (const entry of termPostings)
    {
        const postingStart = cursor.offset;
        const hits = Array.isArray(entry.hits) ? entry.hits : [];
        writeVint(tempBuffer, cursor, hits.length);

        let previousArticleId = 0;
        for (const hit of hits)
        {
            const delta = (hit.articleId - previousArticleId) >>> 0;
            previousArticleId = hit.articleId;
            writeVint(tempBuffer, cursor, delta);
            tempBuffer[cursor.offset++] = hit.titleTf ?? 1;
            tempBuffer[cursor.offset++] = hit.metaTf ?? 0;
            tempBuffer[cursor.offset++] = hit.bodyTf ?? 1;

            const positions = Array.isArray(hit.positions) ? hit.positions : [];
            writeVint(tempBuffer, cursor, positions.length);
            let previousPosition = 0;
            for (const pos of positions)
            {
                writeVint(tempBuffer, cursor, (pos.position - previousPosition) >>> 0);
                writeVint(tempBuffer, cursor, pos.length ?? 1);
                writeVint(tempBuffer, cursor, pos.field ?? 0);
                previousPosition = pos.position;
            }
        }

        const postingLength = cursor.offset - postingStart;
        termsMeta.push({
            hash: entry.hash,
            idf: entry.idf ?? 1.0,
            postingOffset: postingStart,
            postingLength,
            hasPositions: hits.some((h) => (h.positions ?? []).length > 0)
        });
    }

    const postingsBlob = tempBuffer.slice(0, cursor.offset);
    return { postingsBlob, terms: termsMeta };
}

export function querySearchShard(shard, keyword)
{
    if (!shard || !shard.terms || !shard.docs)
    {
        return [];
    }

    const trimmed = String(keyword ?? '').trim().toLowerCase();
    if (!trimmed)
    {
        return [];
    }

    const directHash = murmurHash3(trimmed);
    const words = trimmed.match(/[a-z0-9]+/gu) ?? [];
    const queryHashes = new Set([directHash]);
    for (const w of words)
    {
        queryHashes.add(murmurHash3(w));
    }

    const postingsBlob = shard.bytes.subarray(shard.postingOffset, shard.postingOffset + shard.postingLength);
    const matchingArticleIds = new Set();

    for (const term of shard.terms)
    {
        if (queryHashes.has(term.hash))
        {
            if (term.postingOffset + term.postingLength <= postingsBlob.byteLength && term.postingLength > 0)
            {
                const cursor = { offset: term.postingOffset };
                const end = term.postingOffset + term.postingLength;
                try
                {
                    const count = readVint(postingsBlob, cursor, end);
                    let previousArticleId = 0;
                    for (let i = 0; i < count; i += 1)
                    {
                        const delta = readVint(postingsBlob, cursor, end);
                        previousArticleId += delta;
                        matchingArticleIds.add(previousArticleId);
                        cursor.offset += 3;
                        const posCount = readVint(postingsBlob, cursor, end);
                        for (let p = 0; p < posCount; p += 1)
                        {
                            readVint(postingsBlob, cursor, end);
                            readVint(postingsBlob, cursor, end);
                            readVint(postingsBlob, cursor, end);
                        }
                    }
                }
                catch
                {
                    // Ignore corrupted posting read
                }
            }
        }
    }

    // Direct match from docs title/summary if postings didn't catch (fallback for testing)
    for (const doc of shard.docs)
    {
        if (doc.title?.toLowerCase().includes(trimmed) || doc.summary?.toLowerCase().includes(trimmed))
        {
            matchingArticleIds.add(doc.articleId);
        }
    }

    return shard.docs.filter((doc) => matchingArticleIds.has(doc.articleId));
}
