import type { AboutPageViewContract } from '@/view-contracts/aboutPage';
import type { ArticleDetailPageViewContract } from '@/view-contracts/articleDetail';
import type { ArticleListCardViewContract, ArticleListViewContract } from '@/view-contracts/articleList';
import { renderPublicMarkdownHtml } from '@/helpers/publicMarkdown';
import { themeTokens } from '@/ui-tokens/themeTokens';
import { MARKDOWN_RENDERER_SURFACE_CLASSES } from '@wasm/markdown';

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case '\'':
        return '&#39;';
      default:
        return char;
    }
  });
}

function escapeHtmlWithHighlight(input: string, searchKeyword: string): string {
  const safeText = escapeHtml(input);
  const keyword = searchKeyword.trim();
  if (!keyword) {
    return safeText;
  }

  try {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    return safeText.replace(regex, '<mark class="highlight-mark">$1</mark>');
  } catch {
    return safeText;
  }
}

function renderTag(label: string): string {
  return `<span class="${themeTokens.primitives.tagGhost}">${escapeHtml(label)}</span>`;
}

async function renderMarkdownBody(content: string): Promise<string> {
  const raw = typeof content === 'string' ? content : '';
  if (!raw) {
    return `<div class="${MARKDOWN_RENDERER_SURFACE_CLASSES.root} ${MARKDOWN_RENDERER_SURFACE_CLASSES.body}" role="article" aria-live="polite" data-markdown-renderer="wasm"></div>`;
  }

  const rendered = await renderPublicMarkdownHtml({ source: raw, mode: 'article', allowLatex: true, allowMermaid: true });
  return `<div class="${MARKDOWN_RENDERER_SURFACE_CLASSES.root} ${MARKDOWN_RENDERER_SURFACE_CLASSES.body}" role="article" aria-live="polite" data-markdown-renderer="wasm">${rendered}</div>`;
}

function renderArticleCard(view: ArticleListCardViewContract, searchKeyword = ''): string {
  const tags = view.tags.length > 0
    ? `<span class="${themeTokens.articleList.metaSeparator} hidden sm:inline" aria-hidden="true">/</span>${view.tags.map((tag) => renderTag(tag.label)).join('')}`
    : '';

  return [
    `<article class="${themeTokens.articleList.card}" style="--index:${view.card.index ?? 0}">`,
    `<div class="${themeTokens.articleList.metaRow}">`,
    `<time datetime="${escapeHtml(view.meta.isoTime)}" title="${escapeHtml(view.meta.fullTime)}" class="tabular-nums">${escapeHtml(view.meta.displayTime)}</time>`,
    `<span class="${themeTokens.articleList.metaSeparator}" aria-hidden="true">/</span>`,
    `<span class="${themeTokens.articleList.metaCategory}">${escapeHtml(view.meta.categoryName)}</span>`,
    tags,
    `</div>`,
    `<h2 class="${themeTokens.articleList.title}"><a class="${themeTokens.articleList.titleLink}" href="${escapeHtml(view.href)}" data-aot-action="open-article" data-aot-id="${view.id}">${escapeHtmlWithHighlight(view.title, searchKeyword)}</a></h2>`,
    `<p class="${themeTokens.articleList.summary}">${escapeHtmlWithHighlight(view.summary, searchKeyword)}</p>`,
    `<a class="${themeTokens.articleList.readLink}" href="${escapeHtml(view.href)}" aria-label="阅读全文" data-aot-action="open-article" data-aot-id="${view.id}">阅读<span aria-hidden="true">→</span></a>`,
    `</article>`
  ].join('');
}

function renderPagination(view: ArticleListViewContract): string {
  if (!view.showPagination) {
    return '';
  }

  const prevClass = `${themeTokens.articleList.paginationButton} -ml-4${view.pagination.previous.disabled ? ` ${themeTokens.articleList.paginationButtonDisabled}` : ''}`;
  const nextClass = `${themeTokens.articleList.paginationButton} -mr-4${view.pagination.next.disabled ? ` ${themeTokens.articleList.paginationButtonDisabled}` : ''}`;

  return [
    `<nav class="${themeTokens.articleList.pagination}" aria-label="文章分页">`,
    `<button class="${prevClass}" data-aot-action="page-prev"${view.pagination.previous.disabled ? ' disabled' : ''}>${escapeHtml(view.pagination.previous.label)}</button>`,
    `<span class="${themeTokens.articleList.paginationIndicator}">${escapeHtml(view.pagination.indicator)}</span>`,
    `<button class="${nextClass}" data-aot-action="page-next"${view.pagination.next.disabled ? ' disabled' : ''}>${escapeHtml(view.pagination.next.label)}</button>`,
    `</nav>`
  ].join('');
}

export function renderArticleListAot(view: ArticleListViewContract): string {
  if (view.items.length === 0) {
    return `<div class="${themeTokens.articleList.container}"><div class="${themeTokens.primitives.emptyRoot}"><p class="${themeTokens.primitives.emptyTitle}">${escapeHtml(view.emptyState.title)}</p></div></div>`;
  }

  return [
    `<div class="${themeTokens.articleList.container}">`,
    view.items.map((item) => renderArticleCard(item, view.searchKeyword)).join(''),
    renderPagination(view),
    `</div>`
  ].join('');
}

export async function renderArticleDetailAot(view: ArticleDetailPageViewContract): Promise<string> {
  const body = await renderMarkdownBody(view.body.content);

  return body;
}

export function renderArticleDetailCommentsPlaceholder(view: ArticleDetailPageViewContract): string {
  return [
    `<section class="${themeTokens.articleDetail.commentsRoot}" aria-busy="true" aria-live="polite">`,
    `<h3 class="${themeTokens.articleDetail.commentsHeading}">${escapeHtml(view.comments.headingText)}</h3>`,
    `<div class="${themeTokens.articleDetail.commentsPlaceholderRoot}">`,
    `<p class="${themeTokens.articleDetail.commentsPlaceholderTitle}">${escapeHtml(view.comments.placeholderTitle)}</p>`,
    `<p class="${themeTokens.articleDetail.commentsPlaceholderBody}">${escapeHtml(view.comments.placeholderBody)}</p>`,
    `<p class="${themeTokens.articleDetail.commentsPlaceholderHint}">${escapeHtml(view.comments.placeholderHint)}</p>`,
    `</div>`,
    `</section>`
  ].join('');
}

function renderArticleDetailHeader(view: ArticleDetailPageViewContract): string {
  const category = view.header.meta.categoryHref
    ? `<a href="${escapeHtml(view.header.meta.categoryHref)}" class="text-zinc-600 font-medium tracking-[0.05em]">${escapeHtml(view.header.meta.categoryName)}</a>`
    : `<span class="text-zinc-600 font-medium tracking-[0.05em]">${escapeHtml(view.header.meta.categoryName)}</span>`;
  const tags = view.header.tags.length > 0
    ? `<div class="mt-6 flex flex-wrap gap-2">${view.header.tags.map((tag) => renderTag(tag.label)).join('')}</div>`
    : '';

  return [
    `<header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">`,
    `<h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6 tracking-tighter">${escapeHtml(view.header.title)}</h1>`,
    `<div class="flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">`,
    `<time datetime="${escapeHtml(view.header.meta.isoTime)}" title="${escapeHtml(view.header.meta.fullTime)}">${escapeHtml(view.header.meta.displayTime)}</time>`,
    `<span class="text-zinc-300 font-light" aria-hidden="true">/</span>`,
    category,
    `<span class="text-zinc-300 font-light" aria-hidden="true">/</span>`,
    `<span>${escapeHtml(view.header.viewsText)}</span>`,
    `</div>`,
    tags,
    `</header>`
  ].join('');
}

export async function renderArticleDetailPublicPageAot(view: ArticleDetailPageViewContract): Promise<string> {
  const body = await renderMarkdownBody(view.body.content);

  return [
    `<div class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen">`,
    `<article class="animate-in fade-in slide-in-from-bottom-4 duration-700" style="overflow-anchor: none;">`,
    renderArticleDetailHeader(view),
    body,
    renderArticleDetailCommentsPlaceholder(view),
    `</article>`,
    `</div>`
  ].join('');
}

export async function renderAboutAot(view: AboutPageViewContract): Promise<string> {
  const body = await renderMarkdownBody(view.body.content);

  return [
    `<div class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen flex flex-col">`,
    `<article class="animate-in fade-in slide-in-from-bottom-4 duration-700 grow">`,
    `<header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">`,
    `<h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6 tracking-tighter">`,
    `${escapeHtml(view.header.title)}`,
    `</h1>`,
    `<div class="flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">`,
    `<time>${String(view.header.currentYear)}</time>`,
    `<span class="text-zinc-300 font-light" aria-hidden="true">/</span>`,
    `<span class="text-zinc-600 font-medium tracking-[0.05em]">${escapeHtml(view.header.manifestoLabel)}</span>`,
    `<span class="text-zinc-300 font-light" aria-hidden="true">/</span>`,
    `<span>${escapeHtml(view.header.readmeLabel)}</span>`,
    `</div>`,
    `</header>`,
    body,
    `<footer class="mt-24 pt-10 border-t border-zinc-100 mb-20 flex justify-between items-center opacity-80 hover:opacity-100 transition-opacity">`,
    `<div class="flex flex-col gap-1">`,
    `<span class="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-950">`,
    `${escapeHtml(view.footer.siteTitle)}`,
    `</span>`,
    `</div>`,
    `</footer>`,
    `</article>`,
    `</div>`
  ].join('');
}
