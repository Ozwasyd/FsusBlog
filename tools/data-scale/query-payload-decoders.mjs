import fs from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { queryCaseIds } from './query-case-registry.mjs';

const frontendRoot = new URL('../../src/frontend/src/', import.meta.url);
let decodersPromise;

/** Load the current product adapters rather than maintaining another POD decoder. */
export function loadQueryPayloadDecoders()
{
    decodersPromise ??= loadProductAdapters();
    return decodersPromise;
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
    try
    {
        article = await import(new URL('../../src/frontend/src/adapters/binary/articleAdapter.ts', import.meta.url));
        comment = await import(new URL('../../src/frontend/src/adapters/binary/commentAdapter.ts', import.meta.url));
    }
    finally
    {
        hook.deregister();
    }
    return Object.fromEntries(queryCaseIds.map((id) =>
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
