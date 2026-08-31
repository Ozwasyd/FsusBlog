import { createApp, nextTick, type App } from 'vue';

import PublicArticleCommentsIsland from './PublicArticleCommentsIsland.vue';

let mountedCommentsIslandApp: App<Element> | null = null;
let mountedArticleId: string | null = null;

function ensureCommentsHost(articleId: string): HTMLElement | null
{
    const existing = document.getElementById('fsus-comments-island');
    if (existing)
    {
        existing.dataset.articleId = articleId;
        return existing;
    }

    const article = document.querySelector<HTMLElement>('#fsus-aot-shell article');
    if (!article)
    {
        return null;
    }

    const host = document.createElement('div');
    host.id = 'fsus-comments-island';
    host.dataset.articleId = articleId;
    host.dataset.dynamicIsland = 'comments';
    host.className = 'mt-16 sm:mt-24';
    article.appendChild(host);
    return host;
}

export async function mountArticleCommentsIsland(articleId: number | string): Promise<void>
{
    await nextTick();

    const candidateArticleId = String(articleId ?? '').trim();
    if (!candidateArticleId)
    {
        return;
    }

    const parsedArticleId = Number(candidateArticleId);
    if (!Number.isFinite(parsedArticleId) || parsedArticleId <= 0)
    {
        return;
    }
    const normalizedArticleId = String(Math.trunc(parsedArticleId));
    const container = ensureCommentsHost(normalizedArticleId);
    if (!container)
    {
        return;
    }

    if (mountedCommentsIslandApp && mountedArticleId === normalizedArticleId && container.dataset.commentsIslandMounted === 'true')
    {
        return;
    }

    mountedCommentsIslandApp?.unmount();
    const mountTarget = (() =>
    {
        const existing = container.querySelector<HTMLElement>('#fsus-comments-island-content');
        if (existing)
        {
            existing.replaceChildren();
            return existing;
        }

        const fallback = document.createElement('div');
        fallback.id = 'fsus-comments-island-content';
        container.appendChild(fallback);
        return fallback;
    })();

    const app = createApp(PublicArticleCommentsIsland, { articleId: normalizedArticleId });
    app.mount(mountTarget);

    mountedCommentsIslandApp = app;
    mountedArticleId = normalizedArticleId;
    container.dataset.commentsIslandMounted = 'true';
}

export function unmountArticleCommentsIsland(): void
{
    mountedCommentsIslandApp?.unmount();
    mountedCommentsIslandApp = null;
    mountedArticleId = null;

    const container = document.getElementById('fsus-comments-island');
    if (!container)
    {
        return;
    }

    container.dataset.commentsIslandMounted = 'false';
    const mountTarget = container.querySelector<HTMLElement>('#fsus-comments-island-content');
    mountTarget?.replaceChildren();
}
