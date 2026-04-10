import { createApp, nextTick, type App } from 'vue';
import PublicArticleCommentsIsland from './PublicArticleCommentsIsland.vue';

let mountedCommentsIslandApp: App<Element> | null = null;
let mountedArticleId: string | null = null;

export async function mountArticleCommentsIsland(articleId: number | string): Promise<void> {
  await nextTick();

  const container = document.getElementById('fsus-comments-island');
  if (!container) {
    return;
  }

  const candidateArticleId = String(articleId ?? container.getAttribute('data-article-id') ?? '').trim();
  if (!candidateArticleId) {
    return;
  }

  const parsedArticleId = Number(candidateArticleId);
  if (!Number.isFinite(parsedArticleId) || parsedArticleId <= 0) {
    return;
  }
  const normalizedArticleId = String(Math.trunc(parsedArticleId));

  if (mountedCommentsIslandApp && mountedArticleId === normalizedArticleId && container.dataset.commentsIslandMounted === 'true') {
    return;
  }

  mountedCommentsIslandApp?.unmount();
  container.replaceChildren();

  const app = createApp(PublicArticleCommentsIsland, { articleId: normalizedArticleId });
  app.mount(container);

  mountedCommentsIslandApp = app;
  mountedArticleId = normalizedArticleId;
  container.dataset.commentsIslandMounted = 'true';
}
