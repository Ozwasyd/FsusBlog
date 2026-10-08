import fs from 'node:fs';

import { computeSha256 } from './runtime-plan.mjs';

const protocol = JSON.parse(fs.readFileSync(new URL('../../src/shared/Contracts/Validation/aeds-protocol.json', import.meta.url), 'utf8'));
const frameTypes = new Map(protocol.frameTypes.map((frame) => [frame.name, frame.value]));

function frameName(id)
{
    if (id.startsWith('article-list'))
    {
        return 'ArticleList';
    }
    if (id.startsWith('article-detail'))
    {
        return 'ArticleDetail';
    }
    if (id.startsWith('comment-root'))
    {
        return 'CommentTreeRootCursor';
    }
    if (id.startsWith('comment-nested'))
    {
        return 'CommentChildCursor';
    }
    if (id.startsWith('category') || id.startsWith('tag'))
    {
        return 'ArticleList';
    }
    return 'ArticleSearch';
}

export const queryCaseIds = Object.freeze([
    'article-list-first-page',
    'article-list-middle-page',
    'article-list-last-page',
    'article-list-deep-cursor',
    'comment-root-first',
    'comment-root-middle-cursor',
    'comment-root-last-cursor',
    'comment-nested-root-expansion',
    'category-largest',
    'category-empty',
    'tag-largest',
    'tag-empty',
    'article-detail-first',
    'article-detail-last',
    'search-title-canary',
    'search-body-canary'
]);

export const queryMatrixTiers = Object.freeze(['scale-xs', 'scale-s', 'scale-m']);

export function requireQueryBinding(binding)
{
    for (const field of ['sourceCommit', 'dataScaleRunId', 'fixtureGeneration', 'seedReceiptDigest', 'expectedModelDigest', 'businessEpochUtc'])
    {
        if (typeof binding?.[field] !== 'string' || !binding[field].trim())
        {
            throw new Error(`query binding missing ${field}`);
        }
    }
    if (!/^[0-9a-f]{40}$/u.test(binding.sourceCommit)
        || !/^sha256:[0-9a-f]{64}$/u.test(binding.seedReceiptDigest)
        || !/^sha256:[0-9a-f]{64}$/u.test(binding.expectedModelDigest)
        || !/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(binding.businessEpochUtc)
        || !Number.isFinite(Date.parse(binding.businessEpochUtc)))
    {
        throw new Error('query binding identity is invalid');
    }
}

export function assertSameQueryBinding(expected, actual)
{
    requireQueryBinding(expected);
    requireQueryBinding(actual);
    if (computeSha256(expected) !== computeSha256(actual))
    {
        throw new Error('query fixture generation or business epoch mismatch');
    }
}

function identifier(value)
{
    const text = String(value);
    if (!/^[1-9][0-9]*$/u.test(text))
    {
        throw new Error(`fixture ID is invalid: ${text}`);
    }
    return text;
}

function uniqueRows(rows, label)
{
    if (!Array.isArray(rows))
    {
        throw new Error(`${label} inventory missing`);
    }
    const ids = rows.map((row) => identifier(row.id));
    if (new Set(ids).size !== ids.length)
    {
        throw new Error(`${label} inventory contains duplicate IDs`);
    }
}

function idOrder(left, right)
{
    return BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0;
}

function articleOrder(left, right)
{
    const time = Date.parse(right.createTime) - Date.parse(left.createTime);
    return time || -idOrder(left, right);
}

function pageCoordinate(rows, pageSize, offset, path, requirePriorPage = false, allowEmpty = false)
{
    if ((!rows.length && !allowEmpty) || (rows.length && offset >= rows.length) || (requirePriorPage && offset < pageSize))
    {
        throw new Error('fixture has no requested nonempty cursor window');
    }
    return {
        path,
        pageSize,
        offset,
        total: rows.length,
        // The collector must traverse this exact prefix using returned cursors.
        // Page numbers alone do not advance the public article keyset path.
        traversalItems: rows,
        expectedItems: rows.slice(offset, offset + pageSize)
    };
}

/**
 * Consume the canonical expected model after IDs are mapped. Visibility is
 * supplied by that owner for the bound business epoch, never recomputed here.
 * This pure registry is not runtime admission or a qualification receipt.
 */
export function buildQueryCaseRegistry({ tier, binding, publicArticles, visibleComments, categories, tags, canaries, pageSize = 10, commentPageSize = 1 })
{
    requireQueryBinding(binding);
    if (!queryMatrixTiers.includes(tier) || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
        || !Number.isSafeInteger(commentPageSize) || commentPageSize < 1 || commentPageSize > 100)
    {
        throw new Error('query tier or page size is invalid');
    }
    for (const [label, rows] of Object.entries({ publicArticles, visibleComments, categories, tags }))
    {
        uniqueRows(rows, label);
    }
    for (const row of publicArticles)
    {
        if (typeof row.title !== 'string' || !row.title || !Number.isFinite(Date.parse(row.createTime))
            || !Array.isArray(row.tagIds) || typeof row.body !== 'string')
        {
            throw new Error('canonical public article expected fields missing');
        }
        identifier(row.categoryId);
        row.tagIds.forEach(identifier);
        if (new Set(row.tagIds.map(String)).size !== row.tagIds.length)
        {
            throw new Error('canonical article has duplicate tag references');
        }
    }
    const commentsById = new Map(visibleComments.map((row) => [String(row.id), row]));
    for (const row of visibleComments)
    {
        identifier(row.articleId);
        if (row.parentId !== null)
        {
            identifier(row.parentId);
            identifier(row.rootId);
        }
        if (typeof row.content !== 'string' || !Number.isFinite(Date.parse(row.createTime)))
        {
            throw new Error('canonical visible comment expected fields missing');
        }
        if (row.parentId !== null)
        {
            const parent = commentsById.get(String(row.parentId));
            if (!parent || String(parent.articleId) !== String(row.articleId)
                || String(row.rootId) !== String(parent.rootId ?? parent.id))
            {
                throw new Error('canonical comment parent/root coordinate mismatch');
            }
        }
    }
    const articles = [...publicArticles].sort(articleOrder);
    const listItem = (row) => ({
        id: row.id,
        title: row.title,
        createTime: new Date(row.createTime).toISOString(),
        category: { id: row.categoryId, name: categories.find((item) => String(item.id) === String(row.categoryId))?.name },
        tags: row.tagIds.map((id) => ({ id, name: tags.find((item) => String(item.id) === String(id))?.name }))
    });
    const articleItems = articles.map(listItem);
    if (articleItems.some((row) => !row.category.name || row.tags.some((tag) => !tag.name)))
    {
        throw new Error('canonical article taxonomy coordinate missing');
    }
    const articlePath = `/api/binary/article/list/home/1/${pageSize}.aeds`;
    const lastOffset = (rows) => Math.max(0, Math.floor((rows.length - 1) / pageSize) * pageSize);
    const middleOffset = (rows) => Math.floor(Math.floor((rows.length - 1) / pageSize) / 2) * pageSize;
    const cases = [];
    function add(id, resolve)
    {
        try
        {
            cases.push({ id, status: 'ready', coordinate: { ...resolve(), frameType: frameTypes.get(frameName(id)) } });
        }
        catch (error)
        {
            cases.push({ id, status: 'blocked', failureReasons: [error.message] });
        }
    }
    add('article-list-first-page', () => pageCoordinate(articleItems, pageSize, 0, articlePath));
    add('article-list-middle-page', () => pageCoordinate(articleItems, pageSize, middleOffset(articles), articlePath, true));
    add('article-list-last-page', () => pageCoordinate(articleItems, pageSize, lastOffset(articles), articlePath));
    add('article-list-deep-cursor', () => pageCoordinate(articleItems, pageSize, lastOffset(articles), articlePath, true));

    const commentArticleId = canaries?.commentArticleId;
    const roots = visibleComments.filter((row) => String(row.articleId) === String(commentArticleId) && row.parentId === null)
        .sort((left, right) => -idOrder(left, right));
    const childrenByParent = new Map();
    for (const row of visibleComments)
    {
        if (row.parentId !== null && String(row.articleId) === String(commentArticleId))
        {
            const key = String(row.parentId);
            const children = childrenByParent.get(key) ?? [];
            children.push(row);
            childrenByParent.set(key, children);
        }
    }
    const commentItem = (row) => ({ id: String(row.id), content: row.content, createTime: new Date(row.createTime).toISOString(),
        rootId: String(row.rootId ?? row.id), parentId: row.parentId === null ? null : String(row.parentId) });
    const rootItems = roots.map((row) => ({ ...commentItem(row),
        childrenPreview: [...(childrenByParent.get(String(row.id)) ?? [])].sort(idOrder).slice(0, 3).map(commentItem) }));
    const rootPath = `/api/binary/comment/${commentArticleId}?limit=${commentPageSize}`;
    add('comment-root-first', () =>
    {
        if (!articles.some((row) => String(row.id) === identifier(commentArticleId)))
        {
            throw new Error('exact comment article coordinate missing');
        }
        return pageCoordinate(rootItems, commentPageSize, 0, rootPath, false, true);
    });
    const commentLastOffset = Math.max(0, Math.floor((roots.length - 1) / commentPageSize) * commentPageSize);
    const commentMiddleOffset = Math.floor(Math.floor((roots.length - 1) / commentPageSize) / 2) * commentPageSize;
    add('comment-root-middle-cursor', () => pageCoordinate(rootItems, commentPageSize, commentMiddleOffset, rootPath, true));
    add('comment-root-last-cursor', () => pageCoordinate(rootItems, commentPageSize, commentLastOffset, rootPath, true));
    add('comment-nested-root-expansion', () =>
    {
        const rootId = identifier(canaries?.nestedRootId);
        if (!roots.some((root) => String(root.id) === rootId))
        {
            throw new Error('exact nested root canary missing');
        }
        const children = visibleComments.filter((row) => String(row.articleId) === String(commentArticleId) && String(row.parentId) === rootId)
            .sort(idOrder);
        const childItems = children.map((row) => ({ id: String(row.id), content: row.content, createTime: new Date(row.createTime).toISOString(), rootId, parentId: rootId }));
        return { ...pageCoordinate(childItems, commentPageSize, 0, `/api/binary/comment/${commentArticleId}/children/${rootId}?limit=${commentPageSize}`), rootId };
    });

    function taxonomyCoordinate(rows, type, empty)
    {
        const counted = rows.map((row) => ({
            ...row,
            articles: articles.filter((article) => type === 'category'
                ? String(article.categoryId) === String(row.id)
                : article.tagIds.some((id) => String(id) === String(row.id)))
        })).sort((left, right) => right.articles.length - left.articles.length || idOrder(left, right));
        const row = empty ? counted.find((item) => item.articles.length === 0) : counted[0];
        if (!row || (!empty && row.articles.length === 0) || typeof row.name !== 'string' || !row.name)
        {
            throw new Error(`fixture has no ${empty ? 'empty' : 'nonempty largest'} ${type}`);
        }
        return {
            ...pageCoordinate(row.articles.map(listItem), pageSize, 0, `/api/binary/article/list/${type}/${row.id}/1/${pageSize}.aeds`, false, empty),
            taxonomyId: identifier(row.id),
            taxonomyName: row.name,
            articleIds: row.articles.map((article) => article.id)
        };
    }
    for (const type of ['category', 'tag'])
    {
        add(`${type}-largest`, () => taxonomyCoordinate(type === 'category' ? categories : tags, type, false));
        add(`${type}-empty`, () => taxonomyCoordinate(type === 'category' ? categories : tags, type, true));
    }
    for (const [id, article] of [['article-detail-first', articles[0]], ['article-detail-last', articles.at(-1)]])
    {
        add(id, () =>
        {
            if (!article)
            {
                throw new Error('fixture public detail coordinate missing');
            }
            return { path: `/api/binary/article/${article.id}`, expectedItems: [{ ...listItem(article), content: article.body }] };
        });
    }
    for (const [id, canary] of [['search-title-canary', canaries?.titleSearch], ['search-body-canary', canaries?.bodySearch]])
    {
        add(id, () =>
        {
            if (typeof canary?.token !== 'string' || !canary.token || !Array.isArray(canary.articleIds) || !canary.articleIds.length)
            {
                throw new Error('exact search canary coordinate missing');
            }
            const expectedItems = canary.articleIds.map((articleId) =>
            {
                const article = articles.find((row) => String(row.id) === identifier(articleId));
                if (!article)
                {
                    throw new Error('search canary references nonpublic fixture article');
                }
                return listItem(article);
            });
            uniqueRows(expectedItems, 'search canary');
            return { path: `/api/binary/article/search/query.aeds?q=${encodeURIComponent(canary.token)}`, token: canary.token, expectedItems };
        });
    }
    const result = { schema: 'fsusblog.data-scale-query-registry.v1', tier, binding, cases };
    return { ...result, contentDigest: computeSha256(result) };
}
