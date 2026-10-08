import fs from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { queryCaseIdsForSchema, queryRegistrySchemas, threadReplyCaseId } from './query-case-registry.mjs';

const frontendRoot = new URL('../../src/frontend/src/', import.meta.url);
let decodersPromise;

/** Load the current product adapters rather than maintaining another POD decoder. */
export async function loadQueryPayloadDecoders(registrySchema)
{
    const ids = queryCaseIdsForSchema(registrySchema);
    decodersPromise ??= loadProductAdapters();
    const all = await decodersPromise;
    return Object.fromEntries(ids.map((id) => [id, all[id]]));
}

async function loadProductAdapters()
{
    const hook = registerHooks({
        resolve(specifier, context, nextResolve)
        {
            if (specifier.startsWith('@/') && context.parentURL?.startsWith(frontendRoot.href))
            {
                return { url: new URL(`${specifier.slice(2)}.ts`, frontendRoot).href, shortCircuit: true };
            }
            if (specifier.startsWith('.') && context.parentURL?.startsWith(frontendRoot.href))
            {
                const url = new URL(specifier, context.parentURL);
                if (fs.existsSync(fileURLToPath(url)) && url.pathname.endsWith('.ts'))
                {
                    return { url: url.href, shortCircuit: true };
                }
                const withExtension = pathToFileURL(`${fileURLToPath(url)}.ts`);
                if (fs.existsSync(fileURLToPath(withExtension)))
                {
                    return { url: withExtension.href, shortCircuit: true };
                }
            }
            return nextResolve(specifier, context);
        },
        load(url, context, nextLoad)
        {
            if (url.startsWith(frontendRoot.href) && url.endsWith('.ts'))
            {
                return {
                    format: 'module', shortCircuit: true,
                    source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url })
                };
            }
            return nextLoad(url, context);
        }
    });
    let article;
    let comment;
    let sizes;
    try
    {
        article = await import(new URL('../../src/frontend/src/adapters/binary/articleAdapter.ts', import.meta.url));
        comment = await import(new URL('../../src/frontend/src/adapters/binary/commentAdapter.ts', import.meta.url));
        sizes = await import(new URL('../../src/frontend/src/adapters/binary/types.ts', import.meta.url));
    }
    finally
    {
        hook.deregister();
    }
    return Object.fromEntries(queryCaseIdsForSchema(queryRegistrySchemas[1]).map((id) =>
    {
        let decode = article.mapArticlePageFromPodPayload;
        if (id.startsWith('article-detail'))
        {
            decode = (payload) => ({ items: [article.mapArticleDetailFromPodPayload(payload)] });
        }
        else if (id.startsWith('search'))
        {
            decode = article.mapArticleSearchFromPodPayload;
        }
        else if (id.startsWith('comment-root'))
        {
            decode = (payload) =>
            {
                const cursor = comment.mapCommentTreeRootCursorFromPayload(payload);
                return { ...cursor, items: cursor.data.map((row) => ({ ...row.node,
                    childrenPreview: row.childrenPreview.map((child) => ({ id: child.id, content: child.content,
                        createTime: child.createTime, rootId: child.rootId, parentId: child.parentId })) })) };
            };
        }
        else if (id === threadReplyCaseId)
        {
            decode = (payload) => boundedThreadReplyPayload(payload, comment.mapThreadReplyCursorFromPodPayload, sizes.COMMENT_REPLY_ITEM_POD_SIZE);
        }
        else if (id.startsWith('comment-nested'))
        {
            decode = (payload) =>
            {
                const cursor = comment.mapCommentChildCursorFromPayload(payload);
                return { ...cursor, items: cursor.data };
            };
        }
        return [id, decode];
    }));
}

/** Check envelope/record bounds; item semantics remain with the current product adapter. */
function boundedThreadReplyPayload(payload, decode, recordSize)
{
    if (!(payload instanceof Uint8Array) || payload.byteLength < 21 || !Number.isInteger(recordSize) || recordSize < 1)
    {
        throw new Error('thread_reply_payload_header_invalid');
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const root = view.getBigInt64(0, true);
    const cursor = view.getBigInt64(8, true);
    const count = view.getInt32(17, true);
    if (root < 1n || cursor < 0n || payload[16] > 1 || count < 0 || count > 100
        || (payload[16] === 1 ? cursor === 0n || count === 0 : cursor !== 0n))
    {
        throw new Error('thread_reply_payload_envelope_invalid');
    }
    let offset = 21;
    for (let index = 0; index < count; index += 1)
    {
        if (offset + recordSize + 4 > payload.byteLength)
        {
            throw new Error('thread_reply_payload_record_truncated');
        }
        offset += recordSize;
        const blobLength = view.getInt32(offset, true);
        offset += 4;
        if (blobLength < 0 || blobLength > payload.byteLength - offset)
        {
            throw new Error('thread_reply_payload_blob_invalid');
        }
        offset += blobLength;
    }
    if (offset !== payload.byteLength)
    {
        throw new Error('thread_reply_payload_trailing_bytes');
    }
    const decoded = decode(payload);
    if (decoded.data.some((row) => row.rootId !== String(root)))
    {
        throw new Error('thread_reply_payload_root_mismatch');
    }
    return { ...decoded, rootId: String(root), items: decoded.data };
}
