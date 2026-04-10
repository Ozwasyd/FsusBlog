#!/usr/bin/env node

import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import 'dayjs/locale/zh-cn.js'
import { pathToFileURL } from 'node:url'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

export const PUBLIC_RENDERER_VERSION = 'public-vue-renderer@2026-04-06-2'
const MARKDOWN_RENDERER_VERSION = 'markdown-wasm-contract@2026-04-06-3'
const MARKDOWN_SURFACE_ROOT = 'markdown-body prose prose-zinc max-w-none subpixel-antialiased'
const MARKDOWN_SURFACE_BODY = 'markdown-renderer__body'

const themeTokens = {
  articleList: {
    container: 'flex flex-col gap-12 sm:gap-20',
    card: 'ui-article-card group flex flex-col items-start gap-3 sm:gap-4 subpixel-antialiased',
    metaRow: 'ui-article-meta min-h-5 flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase',
    metaSeparator: 'ui-article-meta-separator text-zinc-300 font-light',
    metaCategory: 'ui-article-category text-zinc-600',
    title: 'ui-article-title min-h-[3.5rem] sm:min-h-[4.25rem] text-xl sm:text-2xl font-bold text-zinc-950 group-hover:text-zinc-500 transition-colors duration-300 leading-snug',
    titleLink: 'block',
    summary: 'ui-article-summary min-h-[4.5rem] sm:min-h-[5.75rem] text-sm sm:text-base text-zinc-600 leading-relaxed sm:leading-loose line-clamp-3',
    readLink: 'ui-article-link mt-2 text-[11px] sm:text-xs font-bold tracking-[0.2em] uppercase text-zinc-950 hover:text-zinc-500 transition-colors flex items-center gap-2 py-2 -ml-0.5',
    pagination: 'ui-pagination mt-20 pt-8 border-t border-zinc-100 flex justify-between items-center',
    paginationButton: 'text-xs font-bold tracking-[0.2em] uppercase transition-colors text-zinc-400 hover:text-zinc-950 p-4 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950',
    paginationButtonDisabled: 'opacity-30 cursor-not-allowed',
    paginationIndicator: 'text-xs font-mono font-medium text-zinc-300 tabular-nums'
  },
  articleDetail: {
    header: 'mb-10 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100',
    title: 'text-2xl sm:text-4xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-5 sm:mb-6 tracking-tight',
    metaRow: 'flex flex-wrap items-center gap-3 text-[10px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase',
    metaSeparator: 'text-zinc-300 font-light',
    categoryLink: 'text-zinc-500 hover:text-zinc-950 transition-colors',
    categoryText: 'text-zinc-500',
    tagList: 'flex flex-wrap gap-3 sm:gap-4',
    tagLink: 'text-[11px] sm:text-sm font-medium text-zinc-400 hover:text-zinc-950 transition-colors px-0 py-1.5 sm:p-0',
    commentsRoot: 'mt-16 sm:mt-24 pt-12 border-t border-zinc-950/5 pb-24',
    commentsHeading: 'text-[10px] sm:text-xs font-bold tracking-[0.2em] text-zinc-400 uppercase mb-8',
    commentsPlaceholderRoot: 'min-h-[11rem] rounded-3xl border border-dashed border-zinc-100 bg-zinc-50/60 px-6 py-8 sm:px-8 sm:py-10',
    commentsPlaceholderTitle: 'text-sm sm:text-base font-bold text-zinc-950',
    commentsPlaceholderBody: 'mt-2 text-sm sm:text-base text-zinc-500 leading-relaxed',
    commentsPlaceholderHint: 'mt-4 text-[10px] sm:text-xs font-mono uppercase tracking-[0.2em] text-zinc-400'
  },
  primitives: {
    tagGhost: 'ui-tag ui-tag--ghost hidden sm:inline text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase'
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function escapeHtml(input) {
  return String(input).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case '\'': return '&#39;'
      default: return char
    }
  })
}

function escapeAttribute(value) {
  return escapeHtml(value)
}

function escapeMarkdownHtml(input) {
  return escapeHtml(input)
}

function normalizeMarkdownSource(input) {
  const raw = typeof input === 'string' ? input : ''
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

function parseUtc(input) {
  if (!input) {
    return null
  }

  let instance
  if (typeof input === 'number') {
    instance = input < 10000000000 ? dayjs.unix(input) : dayjs(input)
  } else if (typeof input === 'string') {
    instance = dayjs.utc(input)
  } else {
    instance = dayjs(input)
  }

  return instance.isValid() ? instance : null
}

function toFullLocalString(input) {
  const value = parseUtc(input)
  return value ? value.local().format('YYYY-MM-DD HH:mm:ss') : '时间格式错误'
}

function toSmartTime(input) {
  const target = parseUtc(input)
  if (!target) {
    return '-'
  }

  const localTarget = target.local()
  const now = dayjs()
  const diffInMinutes = now.diff(localTarget, 'minute')

  if (diffInMinutes < -1) {
    return localTarget.format('YYYY-MM-DD HH:mm')
  }
  if (diffInMinutes <= 0) {
    return '刚刚'
  }
  if (diffInMinutes < 1440) {
    return localTarget.fromNow()
  }

  const formatStr = now.year() === localTarget.year() ? 'MM-DD HH:mm' : 'YYYY-MM-DD HH:mm'
  return localTarget.format(formatStr)
}

function createArticleDetailPageViewContract(article, commentCount, hasMore) {
  const headingText = commentCount > 0 ? `评论 (${commentCount}${hasMore ? '+' : ''})` : '评论'
  return {
    header: {
      id: article.id,
      title: article.title,
      viewsText: `${article.views} 浏览`,
      meta: {
        isoTime: article.createTime,
        displayTime: toSmartTime(article.createTime),
        fullTime: toFullLocalString(article.createTime),
        categoryName: article.category?.name || '未分类',
        categoryHref: article.category ? `/category/${article.category.id}` : undefined
      },
      tags: (article.tags || []).map((tag) => ({ label: `#${tag.name}` }))
    },
    body: { content: article.content },
    comments: {
      title: '评论',
      headingText,
      loadingText: '加载中',
      endText: commentCount > 0 ? '上面的评论已为最后一条。' : '暂无评论。',
      placeholderTitle: '评论流正在接管中',
      placeholderBody: 'AOT 会先直出正文与评论占位，Vue SPA 接管后会自动插入真实评论流。',
      placeholderHint: '这里预留真实评论列表容器，避免首屏与接管后的布局跳变。'
    },
    errorState: {
      title: '数据加载异常，请稍后重试。',
      retryText: '重载页面'
    },
    notFoundState: {
      title: '文章未找到。',
      actionText: '回到主页',
      actionHref: '/'
    }
  }
}

function createArticleListCardViewContract(article, index = 0) {
  return {
    card: {
      kind: 'article-list-card',
      index
    },
    id: article.id,
    href: `/article/${article.id}`,
    title: article.title,
    summary: article.snippet || article.summary || '',
    meta: {
      isoTime: article.createTime,
      displayTime: toSmartTime(article.createTime),
      fullTime: toFullLocalString(article.createTime),
      categoryName: article.category?.name || '通用类'
    },
    tags: (article.tags || []).slice(0, 5).map((tag) => ({
      label: `#${tag.name}`,
      hiddenOnMobile: true
    }))
  }
}

function createArticleListViewContract(response, options) {
  const total = Number(response.total) || 0
  const currentPage = Math.max(1, options.currentPage)
  const pageSize = Math.max(1, options.pageSize)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return {
    items: response.items.map((article, index) => createArticleListCardViewContract(article, index)),
    pagination: {
      previous: {
        label: '上一页',
        variant: 'quiet',
        disabled: currentPage <= 1,
        action: { action: 'page-prev' }
      },
      next: {
        label: '下一页',
        variant: 'quiet',
        disabled: currentPage >= totalPages,
        action: { action: 'page-next' }
      },
      indicator: `${currentPage} / ${totalPages}`
    },
    showPagination: totalPages > 1,
    emptyState: {
      title: '没有找到文章。'
    },
    searchKeyword: options.searchKeyword?.trim() ?? ''
  }
}

const simdProbe = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
  1, 8, 0, 65, 0, 253, 15, 253, 98, 11
])

function supportsSimdMarkdown() {
  try {
    return WebAssembly.validate(simdProbe)
  } catch {
    return false
  }
}

function resolveMarkdownAsset(kind) {
  const fileBase = kind === 'simd' ? 'markdown_simd' : 'markdown_basic'
  const cwd = process.cwd().replace(/\\/g, '/').replace(/\/+$/, '')
  return {
    moduleUrl: pathToFileURL(`${cwd}/public/wasm/${fileBase}.js`).href,
    wasmUrl: pathToFileURL(`${cwd}/public/wasm/${fileBase}.wasm`).href
  }
}

function pickExport(raw, name) {
  const direct = raw[name]
  if (direct) {
    return direct
  }

  const underscored = raw[`_${name}`]
  if (underscored) {
    return underscored
  }

  throw new Error(`wasm_export_missing:${name}`)
}

function readCString(module, ptr, len) {
  if (ptr <= 0 || len <= 0) {
    return ''
  }

  const memory = module.memory ?? (module.HEAPU8 ? { buffer: module.HEAPU8.buffer } : null)
  if (!memory) {
    return ''
  }

  const view = new Uint8Array(memory.buffer, ptr, len)
  return new TextDecoder().decode(view)
}

let markdownModulePromise = null

async function loadMarkdownModule() {
  if (!markdownModulePromise) {
    markdownModulePromise = (async () => {
      const kind = supportsSimdMarkdown() ? 'simd' : 'basic'
      const asset = resolveMarkdownAsset(kind)
      const moduleRef = await import(asset.moduleUrl)
      const factory = moduleRef.default ?? moduleRef.createMarkdownModule
      assert(typeof factory === 'function', `[public-hydration-bundle] missing markdown wasm factory: ${kind}`)
      return await factory({
        locateFile: (path) => path.endsWith('.wasm') ? asset.wasmUrl : path,
        print: () => {},
        printErr: () => {}
      })
    })().catch(() => null)
  }

  return await markdownModulePromise
}

async function renderPublicMarkdownHtml(request) {
  const payload = typeof request === 'string' ? { source: request } : request
  const source = normalizeMarkdownSource(payload.source)
  const module = await loadMarkdownModule()

  if (!module) {
    return `<div class="markdown-renderer__error"><p>Markdown Wasm 运行时不可用，已回退为安全文本。</p><pre class="shiki"><code>${escapeMarkdownHtml(payload.source)}</code></pre></div>`
  }

  const raw = module
  const render = pickExport(raw, 'markdown_render')
  const getHtmlPtr = pickExport(raw, 'markdown_get_last_html_ptr')
  const getHtmlLen = pickExport(raw, 'markdown_get_last_html_len')
  const alloc = pickExport(raw, 'markdown_alloc_buffer')
  const free = pickExport(raw, 'markdown_free_buffer')

  const bytes = new TextEncoder().encode(source)
  const ptr = alloc(bytes.byteLength)
  if (ptr <= 0) {
    return `<div class="markdown-renderer__error"><p>Markdown Wasm 运行时不可用，已回退为安全文本。</p><pre class="shiki"><code>${escapeMarkdownHtml(payload.source)}</code></pre></div>`
  }

  try {
    module.HEAPU8.set(bytes, ptr)
    const ok = render(ptr, bytes.byteLength, payload.allowHtml ? 1 : 0, payload.allowLatex === false ? 0 : 1, payload.allowMermaid === false ? 0 : 1)
    if (ok !== 1) {
      return `<div class="markdown-renderer__error"><p>Markdown Wasm 运行时不可用，已回退为安全文本。</p><pre class="shiki"><code>${escapeMarkdownHtml(payload.source)}</code></pre></div>`
    }

    return readCString(module, getHtmlPtr(), getHtmlLen())
  } finally {
    free(ptr)
  }
}

function renderArticleList(items) {
  const cards = items.map((item) => {
    const tags = item.tags.length
      ? `<span class="${themeTokens.articleList.metaSeparator} hidden sm:inline" aria-hidden="true">/</span>${item.tags.map((tag) => `<span class="${themeTokens.primitives.tagGhost}">${escapeHtml(tag.label)}</span>`).join('')}`
      : ''

    return `<article class="${themeTokens.articleList.card}" style="--index:${item.card.index ?? 0};"><div class="${themeTokens.articleList.metaRow}"><time datetime="${escapeAttribute(item.meta.isoTime)}" title="${escapeAttribute(item.meta.fullTime)}" class="tabular-nums">${escapeHtml(item.meta.displayTime)}</time><span class="${themeTokens.articleList.metaSeparator}" aria-hidden="true">/</span><span class="${themeTokens.articleList.metaCategory}">${escapeHtml(item.meta.categoryName)}</span>${tags}</div><h2 class="${themeTokens.articleList.title}"><a href="${escapeAttribute(item.href)}" class="${themeTokens.articleList.titleLink}" data-public-link="article">${escapeHtml(item.title)}</a></h2><p class="${themeTokens.articleList.summary}">${escapeHtml(item.summary)}</p><a href="${escapeAttribute(item.href)}" class="${themeTokens.articleList.readLink}" aria-label="阅读全文" data-public-link="article">阅读<span aria-hidden="true">→</span></a></article>`
  }).join('')

  return `<div class="${themeTokens.articleList.container}">${cards}</div>`
}

function renderPagination(view) {
  if (!view.showPagination) {
    return ''
  }

  const previousDisabled = view.pagination.previous.disabled ? ` ${themeTokens.articleList.paginationButtonDisabled}` : ''
  const nextDisabled = view.pagination.next.disabled ? ` ${themeTokens.articleList.paginationButtonDisabled}` : ''
  const previousAttr = view.pagination.previous.disabled ? ' disabled' : ''
  const nextAttr = view.pagination.next.disabled ? ' disabled' : ''

  return `<nav class="${themeTokens.articleList.pagination}" aria-label="文章分页"><button class="${themeTokens.articleList.paginationButton} -ml-4${previousDisabled}"${previousAttr} data-aot-action="page-prev">${escapeHtml(view.pagination.previous.label)}</button><span class="${themeTokens.articleList.paginationIndicator}">${escapeHtml(view.pagination.indicator)}</span><button class="${themeTokens.articleList.paginationButton} -mr-4${nextDisabled}"${nextAttr} data-aot-action="page-next">${escapeHtml(view.pagination.next.label)}</button></nav>`
}

function renderPublicHomeHtml(payload) {
  const siteTitleText = payload.siteTitle?.trim() || 'Fsus'
  const siteDescriptionText = payload.siteDescription?.trim() || '以极简形式呈现内容与思考。'
  const currentYear = new Date().getFullYear()
  return `<div id="fsus-aot-shell" data-public-hydration-kind="Home" class="font-sans min-h-screen flex flex-col bg-white text-zinc-950 subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-zinc-950 selection:text-white"><header class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10"><div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8"><div class="shrink-0"><a href="/" class="text-2xl sm:text-3xl font-bold tracking-tight hover:opacity-60 transition-opacity outline-none focus-visible:opacity-60">${escapeHtml(siteTitleText)}<span class="text-zinc-400">.</span></a></div><nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航"><a href="/" class="mono-link active-link">首页</a><a href="/archive" class="mono-link">归档</a><a href="/about" class="mono-link">关于</a><form action="/search" method="get" class="hidden sm:flex items-center group border-b border-zinc-100 focus-within:border-zinc-950 transition-colors duration-300"><input type="text" name="q" placeholder="搜索" class="public-shell-search bg-transparent border-none p-0 focus:ring-0 focus:outline-none text-sm w-12 focus:w-28 transition-all duration-500 placeholder:text-zinc-300 text-zinc-500 focus:text-zinc-950 pb-0.5" aria-label="搜索内容"></form><span class="text-zinc-300 font-light" aria-hidden="true">/</span><a href="/login" class="mono-link">登录</a></nav></div></header><main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-4 pb-24 sm:pb-32"><div class="flex flex-col lg:flex-row gap-12 lg:gap-24"><div class="grow lg:w-2/3"><header class="mb-12 sm:mb-20"><h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-950">${escapeHtml(siteTitleText)}<span class="text-zinc-400">.</span></h1><p class="mt-4 text-sm sm:text-base text-zinc-500 max-w-xl leading-relaxed">${escapeHtml(siteDescriptionText)}</p></header>${renderArticleList(payload.view.items)}${renderPagination(payload.view)}</div><aside class="hidden lg:block lg:w-80 shrink-0 space-y-16 pt-8 lg:pt-0"><section class="public-aside-placeholder rounded-3xl border border-zinc-100 bg-zinc-50/60 px-6 py-8" aria-hidden="true"><h2 class="text-xs font-bold tracking-[0.2em] text-zinc-400 uppercase mb-8">热门文章</h2><div class="space-y-6"><div class="flex items-start gap-4"><div class="w-6 text-sm font-mono text-zinc-200">01</div><div class="flex-1 space-y-2 pt-0.5"><div class="h-3 rounded-sm bg-zinc-100"></div><div class="h-3 w-2/3 rounded-sm bg-zinc-100/90"></div></div></div><div class="flex items-start gap-4"><div class="w-6 text-sm font-mono text-zinc-200">02</div><div class="flex-1 space-y-2 pt-0.5"><div class="h-3 rounded-sm bg-zinc-100"></div><div class="h-3 w-2/3 rounded-sm bg-zinc-100/90"></div></div></div><div class="flex items-start gap-4"><div class="w-6 text-sm font-mono text-zinc-200">03</div><div class="flex-1 space-y-2 pt-0.5"><div class="h-3 rounded-sm bg-zinc-100"></div><div class="h-3 w-2/3 rounded-sm bg-zinc-100/90"></div></div></div><div class="flex items-start gap-4"><div class="w-6 text-sm font-mono text-zinc-200">04</div><div class="flex-1 space-y-2 pt-0.5"><div class="h-3 rounded-sm bg-zinc-100"></div><div class="h-3 w-2/3 rounded-sm bg-zinc-100/90"></div></div></div><div class="flex items-start gap-4"><div class="w-6 text-sm font-mono text-zinc-200">05</div><div class="flex-1 space-y-2 pt-0.5"><div class="h-3 rounded-sm bg-zinc-100"></div><div class="h-3 w-2/3 rounded-sm bg-zinc-100/90"></div></div></div></div></section></aside></div></main><footer class="w-full pb-12 pt-8 sm:pb-16 border-t border-zinc-100"><div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6"><div class="text-sm text-zinc-500 font-medium tracking-normal select-none">&copy; ${currentYear} ${escapeHtml(siteTitleText)}. All rights reserved.</div><div class="flex items-center gap-6 sm:gap-8 text-sm font-medium text-zinc-500"><a href="/api/Article/rss" class="hover:text-zinc-950 transition-colors">RSS</a><a href="#top" class="hover:text-zinc-950 transition-colors flex items-center gap-2 group"><span>回到顶部</span><span class="group-hover:-translate-y-0.5 transition-transform" aria-hidden="true">↑</span></a></div></div></footer></div>`
}

function renderPublicArticleDetailHtml(payload) {
  const siteTitleText = payload.siteTitle?.trim() || 'Fsus'
  const currentYear = new Date().getFullYear()
  const commentsIsland = payload.commentsIsland ?? {
    articleId: payload.articleId,
    placeholderTitle: payload.detailView.comments.placeholderTitle,
    placeholderBody: payload.detailView.comments.placeholderBody,
    placeholderHint: payload.detailView.comments.placeholderHint
  }
  const tags = payload.detailView.header.tags.length > 0
    ? `<footer class="mt-12 sm:mt-24 pt-8 sm:pt-10 border-t border-zinc-100"><div class="${themeTokens.articleDetail.tagList}">${payload.detailView.header.tags.map((tag) => `<a href="/tag/${escapeAttribute(tag.label.replace(/^#/, ''))}" class="${themeTokens.articleDetail.tagLink}" data-public-link="filter">${escapeHtml(tag.label)}</a>`).join('')}</div></footer>`
    : ''
  const category = payload.detailView.header.meta.categoryHref
    ? `<a href="${escapeAttribute(payload.detailView.header.meta.categoryHref)}" class="${themeTokens.articleDetail.categoryLink}" data-public-link="filter">${escapeHtml(payload.detailView.header.meta.categoryName)}</a>`
    : `<span class="${themeTokens.articleDetail.categoryText}">${escapeHtml(payload.detailView.header.meta.categoryName)}</span>`
  const commentsLoading = '<div class="mt-4 inline-flex items-center gap-2 text-zinc-400" aria-hidden="true"><span class="h-1.5 w-1.5 rounded-full bg-zinc-300 animate-pulse"></span><span class="h-1.5 w-1.5 rounded-full bg-zinc-300 animate-pulse [animation-delay:120ms]"></span><span class="h-1.5 w-1.5 rounded-full bg-zinc-300 animate-pulse [animation-delay:240ms]"></span></div>'

  return `<div id="fsus-aot-shell" data-public-hydration-kind="ArticleDetail" class="font-sans min-h-screen flex flex-col bg-white text-zinc-950 subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-zinc-950 selection:text-white"><header class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10"><div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8"><div class="shrink-0"><a href="/" class="text-2xl sm:text-3xl font-bold tracking-tight hover:opacity-60 transition-opacity outline-none focus-visible:opacity-60">${escapeHtml(siteTitleText)}<span class="text-zinc-400">.</span></a></div><nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航"><a href="/" class="mono-link">首页</a><a href="/archive" class="mono-link">归档</a><a href="/about" class="mono-link">关于</a><form action="/search" method="get" class="hidden sm:flex items-center group border-b border-zinc-100 focus-within:border-zinc-950 transition-colors duration-300"><input type="text" name="q" placeholder="搜索" class="public-shell-search bg-transparent border-none p-0 focus:ring-0 focus:outline-none text-sm w-12 focus:w-28 transition-all duration-500 placeholder:text-zinc-300 text-zinc-500 focus:text-zinc-950 pb-0.5" aria-label="搜索内容"></form><span class="text-zinc-300 font-light" aria-hidden="true">/</span><a href="/login" class="mono-link">登录</a></nav></div></header><main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-4 pb-24 sm:pb-32"><div class="max-w-3xl mx-auto min-h-screen"><article style="overflow-anchor: none;"><header class="${themeTokens.articleDetail.header}"><h1 class="${themeTokens.articleDetail.title}">${escapeHtml(payload.detailView.header.title)}</h1><div class="${themeTokens.articleDetail.metaRow}"><time datetime="${escapeAttribute(payload.detailView.header.meta.isoTime)}" title="${escapeAttribute(payload.detailView.header.meta.fullTime)}">${escapeHtml(payload.detailView.header.meta.displayTime)}</time><span class="${themeTokens.articleDetail.metaSeparator}" aria-hidden="true">/</span>${category}<span class="${themeTokens.articleDetail.metaSeparator}" aria-hidden="true">/</span><span>${escapeHtml(payload.detailView.header.viewsText)}</span></div></header><div class="markdown-body prose prose-zinc max-w-none subpixel-antialiased whitespace-pre-wrap"><div class="${MARKDOWN_SURFACE_ROOT} ${MARKDOWN_SURFACE_BODY}" role="article" aria-live="polite" data-markdown-renderer="wasm">${payload.detailView.body.content}</div></div>${tags}<section id="fsus-comments-island" class="${themeTokens.articleDetail.commentsRoot}" data-article-id="${escapeAttribute(String(commentsIsland.articleId ?? payload.articleId ?? 0))}"><h3 class="${themeTokens.articleDetail.commentsHeading}">${escapeHtml(payload.detailView.comments.headingText)}</h3><div class="${themeTokens.articleDetail.commentsPlaceholderRoot}"><p class="${themeTokens.articleDetail.commentsPlaceholderTitle}">${escapeHtml(commentsIsland.placeholderTitle)}</p><p class="${themeTokens.articleDetail.commentsPlaceholderBody}">${escapeHtml(commentsIsland.placeholderBody)}</p>${commentsLoading}<p class="${themeTokens.articleDetail.commentsPlaceholderHint}">${escapeHtml(commentsIsland.placeholderHint)}</p></div></section></article></div></main><footer class="w-full pb-12 pt-8 sm:pb-16 border-t border-zinc-100"><div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6"><div class="text-sm text-zinc-500 font-medium tracking-normal select-none">&copy; ${currentYear} ${escapeHtml(siteTitleText)}. All rights reserved.</div><div class="flex items-center gap-6 sm:gap-8 text-sm font-medium text-zinc-500"><a href="/api/Article/rss" class="hover:text-zinc-950 transition-colors">RSS</a><a href="#top" class="hover:text-zinc-950 transition-colors flex items-center gap-2 group"><span>回到顶部</span><span class="group-hover:-translate-y-0.5 transition-transform" aria-hidden="true">↑</span></a></div></div></footer></div>`
}

function formatPublicDate(input) {
  if (!input) {
    return ''
  }
  const parsed = parseUtc(input)
  return parsed ? parsed.local().format('YYYY-MM-DD') : ''
}

function renderPublicAboutHtml(payload) {
  const siteTitleText = payload.siteTitle?.trim() || 'Fsus'
  const currentYear = new Date().getFullYear()
  const content = payload.about?.content ?? ''
  return `<div id="fsus-aot-shell" data-public-hydration-kind="About" class="font-sans min-h-screen flex flex-col bg-white text-zinc-950 subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-zinc-950 selection:text-white"><header class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10"><div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8"><div class="shrink-0"><a href="/" class="text-2xl sm:text-3xl font-bold tracking-tight hover:opacity-60 transition-opacity outline-none focus-visible:opacity-60">${escapeHtml(siteTitleText)}<span class="text-zinc-400">.</span></a></div><nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航"><a href="/" class="mono-link">首页</a><a href="/archive" class="mono-link">归档</a><a href="/about" class="mono-link active-link">关于</a><span class="text-zinc-300 font-light" aria-hidden="true">/</span><a href="/login" class="mono-link">登录</a></nav></div></header><main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-4 pb-24 sm:pb-32"><article class="min-h-[60vh]"><header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100"><h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6 tracking-tighter">${escapeHtml(payload.title ?? '关于')}</h1><div class="flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase"><time>${currentYear}</time><span class="text-zinc-300 font-light" aria-hidden="true">/</span><span class="text-zinc-600 font-medium tracking-[0.05em]">MANIFESTO</span></div></header><div class="markdown-body markdown-renderer__body prose prose-zinc max-w-none subpixel-antialiased whitespace-pre-wrap" role="article" aria-live="polite" data-markdown-renderer="wasm">${escapeHtml(content)}</div></article></main></div>`
}

function renderPublicArchiveHtml(payload) {
  const groups = new Map()
  for (const article of payload.articles ?? []) {
    const date = parseUtc(article.createTime)?.local()
    if (!date) continue
    const year = date.format('YYYY')
    const month = date.format('MM')
    const day = date.format('DD')
    if (!groups.has(year)) groups.set(year, new Map())
    const monthMap = groups.get(year)
    if (!monthMap.has(month)) monthMap.set(month, [])
    monthMap.get(month).push({
      id: article.id,
      title: article.title,
      day,
      fullTime: date.format('YYYY-MM-DD HH:mm:ss')
    })
  }
  let timeline = ''
  for (const [year, monthMap] of groups.entries()) {
    let monthsHtml = ''
    for (const [month, items] of monthMap.entries()) {
      const itemsHtml = items.map((item) => `<article class="relative group"><a href="/article/${item.id}" data-aot-action="open-article" data-aot-id="${item.id}" class="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-6 group py-1 sm:py-0 outline-none"><time datetime="${escapeAttribute(item.fullTime)}" title="${escapeAttribute(item.fullTime)}" class="flex-none text-xs sm:text-sm font-mono text-zinc-400 group-hover:text-zinc-950 transition-colors w-12 tabular-nums">${escapeHtml(item.day)}</time><span class="text-base sm:text-lg font-medium text-zinc-600 group-hover:text-zinc-950 transition-colors leading-snug border-b border-transparent group-hover:border-zinc-950 pb-0.5">${escapeHtml(item.title)}</span></a></article>`).join('')
      monthsHtml += `<div class="relative"><h3 class="text-xs font-black tracking-[0.3em] text-zinc-400 uppercase mb-6 flex items-center gap-4">${escapeHtml(month)}<span class="h-px grow bg-zinc-100/80" aria-hidden="true"></span></h3><div class="space-y-6">${itemsHtml}</div></div>`
    }
    timeline += `<section class="relative"><div class="sticky top-20 z-10 bg-white py-3 mb-10 flex items-center"><div class="absolute left-0 w-9 h-9 bg-white flex items-center justify-center"><div class="w-2.5 h-2.5 rounded-full bg-zinc-950 ring-4 ring-white"></div></div><h2 class="text-3xl sm:text-4xl font-bold text-zinc-950 pl-12 font-mono tracking-tighter">${escapeHtml(year)}</h2></div><div class="space-y-14 pl-12">${monthsHtml}</div></section>`
  }
  return `<div id="fsus-aot-shell" data-public-hydration-kind="Archive" class="font-sans min-h-screen flex flex-col bg-white text-zinc-950 subpixel-antialiased"><main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-12 pb-24"><header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100"><h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6">${escapeHtml(payload.title ?? '归档')}</h1><div class="flex items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase"><span>目前发布</span><span class="text-zinc-300 font-light" aria-hidden="true">/</span><span class="text-zinc-950 font-bold tabular-nums">${escapeHtml(String(payload.total ?? 0))}</span></div></header><div class="relative pb-24"><div class="absolute left-4.5 top-3 bottom-0 w-px bg-zinc-200 z-0"></div><div class="space-y-20">${timeline}</div></div></main></div>`
}

function renderPublicFilterHtml(payload) {
  const routeKey = payload.routeKey ?? 'filter:unknown'
  const title = payload.title ?? '筛选'
  const articles = payload.filter?.articles ?? []
  const current = Number(payload.filter?.pageIndex ?? 1)
  const total = Number(payload.filter?.total ?? 0)
  const size = Math.max(1, Number(payload.filter?.pageSize ?? 10))
  const totalPages = Math.max(1, Math.ceil(total / size))
  const itemsHtml = articles.map((article) => `<article class="ui-article-card group flex flex-col items-start gap-3 sm:gap-4 subpixel-antialiased animate-fade-in"><div class="ui-article-meta flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase"><time class="tabular-nums">${escapeHtml(formatPublicDate(article.createTime))}</time></div><h2 class="ui-article-title text-xl sm:text-2xl font-bold text-zinc-950 group-hover:text-zinc-500 transition-colors duration-300 leading-snug"><a class="block" href="/article/${article.id}" data-aot-action="open-article" data-aot-id="${article.id}">${escapeHtml(article.title)}</a></h2><p class="ui-article-summary text-sm sm:text-base text-zinc-600 leading-relaxed sm:leading-loose line-clamp-3">${escapeHtml(article.summary ?? '')}</p></article>`).join('')
  return `<div id="fsus-aot-shell" data-public-hydration-kind="Filter" class="max-w-3xl mx-auto w-full px-6 sm:px-8 min-h-screen"><div class="flex flex-col lg:flex-row gap-12 lg:gap-24 subpixel-antialiased"><div class="grow lg:w-2/3"><header class="mb-12 sm:mb-20 select-none"><p class="text-[10px] font-bold tracking-[0.3em] text-zinc-400 uppercase mb-4">${escapeHtml(routeKey.startsWith('category:') ? '分类' : routeKey.startsWith('tag:') ? '标签' : '筛选')}</p><h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-950">${escapeHtml(title)}</h1></header><div class="flex flex-col gap-12 sm:gap-20">${itemsHtml}</div><nav class="mt-24 pt-12 border-t border-zinc-100 flex justify-between items-center select-none"><button data-aot-action="page-prev" ${current <= 1 ? 'disabled' : ''}>上一页</button><span class="text-[10px] font-mono font-bold text-zinc-400 tracking-widest tabular-nums">${String(current).padStart(2, '0')} / ${String(totalPages).padStart(2, '0')}</span><button data-aot-action="page-next" ${current >= totalPages ? 'disabled' : ''}>下一页</button></nav></div></div></div>`
}

function createArticleDetailBootstrap(options) {
  return JSON.stringify({
    kind: 'ArticleDetail',
    pageKind: 'ArticleDetail',
    routeKey: options.articleId && options.articleId > 0 ? `article:${options.articleId}` : 'article:{{articleId}}',
    articleId: options.articleId ?? '{{articleId}}',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    article: {
      id: options.articleId ?? '{{articleId}}',
      title: options.title,
      summary: options.summary,
      content: options.content,
      views: 0,
      createTime: options.createTime ?? new Date().toISOString(),
      category: options.categoryName?.trim() || '未分类',
      tags: (options.tags ?? []).map((tag) => tag.name)
    },
    commentsPlaceholder: '评论将在 SPA 接管后加载'
  })
}

async function createArticleDetailHydrationPayload(options) {
  assert(Number.isFinite(options.articleId ?? Number.NaN) && (options.articleId ?? 0) > 0, 'article detail bundle requires a positive articleId')

  const detailView = createArticleDetailPageViewContract({
    id: options.articleId ?? 0,
    title: options.title,
    content: options.content,
    summary: options.summary,
    views: 0,
    createTime: options.createTime ?? new Date().toISOString(),
    category: options.categoryId
      ? {
          id: options.categoryId,
          name: options.categoryName?.trim() || '未分类'
        }
      : undefined,
    tags: (options.tags ?? []).map((tag) => ({
      id: tag.id,
      name: tag.name
    }))
  }, 0, false)

  const markdownHtml = await renderPublicMarkdownHtml({
    source: detailView.body.content,
    mode: 'article',
    allowLatex: true,
    allowMermaid: true
  })

  return {
    pageKind: 'ArticleDetail',
    routeKey: options.articleId && options.articleId > 0 ? `article:${options.articleId}` : 'article:{{articleId}}',
    articleId: options.articleId ?? '{{articleId}}',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    title: options.title,
    baseUrl: options.baseUrl ?? null,
    siteTitle: options.siteTitle ?? null,
    siteDescription: options.siteDescription ?? null,
    detailView: {
      ...detailView,
      body: {
        content: markdownHtml
      }
    },
    commentsIsland: {
      articleId: options.articleId ?? '{{articleId}}',
      placeholderTitle: detailView.comments.placeholderTitle,
      placeholderBody: detailView.comments.placeholderBody,
      placeholderHint: detailView.comments.placeholderHint
    }
  }
}

async function buildArticleDetailPublicAotEntry(options) {
  const hydrationPayload = await createArticleDetailHydrationPayload(options)
  return {
    pageId: 2,
    routeKey: hydrationPayload.routeKey,
    html: renderPublicArticleDetailHtml(hydrationPayload),
    articleId: options.articleId && options.articleId > 0 ? options.articleId : null,
    bootstrapJson: createArticleDetailBootstrap(options),
    hydrationPropsJson: JSON.stringify(hydrationPayload),
    rendererVersion: PUBLIC_RENDERER_VERSION,
    islandsJson: JSON.stringify({ comments: hydrationPayload.commentsIsland }),
    title: options.title,
    baseUrl: options.baseUrl ?? null
  }
}

async function buildHomePublicAotEntry(options = {}) {
  const page = options.page ?? 1
  const size = options.size ?? 10
  assert(Number.isInteger(page) && page > 0, 'home page must be a positive integer')
  assert(Number.isInteger(size) && size > 0, 'home size must be a positive integer')
  assert(options.response, 'home response is required')

  const view = createArticleListViewContract(options.response, {
    currentPage: page,
    pageSize: size
  })

  const hydrationPayload = {
    pageKind: 'Home',
    routeKey: 'home',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    title: options.siteTitle ?? '首页',
    siteTitle: options.siteTitle ?? null,
    siteDescription: options.siteDescription ?? null,
    baseUrl: options.baseUrl ?? null,
    currentPage: page,
    pageSize: size,
    total: Number(options.response.total) || 0,
    view
  }

  return {
    pageId: 1,
    routeKey: 'home',
    html: renderPublicHomeHtml(hydrationPayload),
    bootstrapJson: JSON.stringify({
      kind: 'Home',
      pageKind: 'Home',
      routeKey: 'home',
      rendererVersion: PUBLIC_RENDERER_VERSION,
      total: hydrationPayload.total,
      articles: options.response.items,
      pageIndex: page,
      pageSize: size,
      siteTitle: options.siteTitle ?? null,
      siteDescription: options.siteDescription ?? null
    }),
    hydrationPropsJson: JSON.stringify(hydrationPayload),
    rendererVersion: PUBLIC_RENDERER_VERSION,
    islandsJson: null,
    title: hydrationPayload.title,
    baseUrl: options.baseUrl ?? null
  }
}

async function buildAboutPublicAotEntry(options = {}) {
  const title = options.title ?? '关于'
  const hydrationPayload = {
    pageKind: 'About',
    routeKey: 'about',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    title,
    siteTitle: options.siteTitle ?? null,
    siteDescription: options.siteDescription ?? null,
    baseUrl: options.baseUrl ?? null,
    about: {
      slug: options.slug ?? 'about',
      content: options.content ?? ''
    }
  }

  return {
    pageId: 4,
    routeKey: 'about',
    html: renderPublicAboutHtml(hydrationPayload),
    bootstrapJson: JSON.stringify({
      kind: 'About',
      pageKind: 'About',
      routeKey: 'about',
      rendererVersion: PUBLIC_RENDERER_VERSION,
      siteTitle: options.siteTitle ?? null,
      siteDescription: options.siteDescription ?? null,
      about: hydrationPayload.about
    }),
    hydrationPropsJson: JSON.stringify(hydrationPayload),
    rendererVersion: PUBLIC_RENDERER_VERSION,
    islandsJson: null,
    title,
    baseUrl: options.baseUrl ?? null
  }
}

async function buildArchivePublicAotEntry(options = {}) {
  const title = options.title ?? '归档'
  const articles = options.articles ?? []
  const hydrationPayload = {
    pageKind: 'Archive',
    routeKey: 'archive',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    title,
    siteTitle: options.siteTitle ?? null,
    siteDescription: options.siteDescription ?? null,
    baseUrl: options.baseUrl ?? null,
    total: Number(options.total ?? articles.length),
    articles
  }

  return {
    pageId: 5,
    routeKey: 'archive',
    html: renderPublicArchiveHtml(hydrationPayload),
    bootstrapJson: JSON.stringify({
      kind: 'Archive',
      pageKind: 'Archive',
      routeKey: 'archive',
      rendererVersion: PUBLIC_RENDERER_VERSION,
      siteTitle: options.siteTitle ?? null,
      siteDescription: options.siteDescription ?? null,
      total: hydrationPayload.total,
      articles
    }),
    hydrationPropsJson: JSON.stringify(hydrationPayload),
    rendererVersion: PUBLIC_RENDERER_VERSION,
    islandsJson: null,
    title,
    baseUrl: options.baseUrl ?? null
  }
}

async function buildFilterPublicAotEntry(options = {}) {
  assert(typeof options.routeKey === 'string' && options.routeKey.trim().length > 0, 'filter routeKey is required')
  const title = options.title ?? '筛选'
  const hydrationPayload = {
    pageKind: 'Filter',
    routeKey: options.routeKey.trim(),
    rendererVersion: PUBLIC_RENDERER_VERSION,
    title,
    siteTitle: options.siteTitle ?? null,
    siteDescription: options.siteDescription ?? null,
    baseUrl: options.baseUrl ?? null,
    filter: {
      pageIndex: Number(options.pageIndex ?? 1),
      pageSize: Number(options.pageSize ?? 10),
      total: Number(options.total ?? 0),
      articles: options.articles ?? []
    }
  }

  return {
    pageId: 3,
    routeKey: hydrationPayload.routeKey,
    html: renderPublicFilterHtml(hydrationPayload),
    bootstrapJson: JSON.stringify({
      kind: 'Filter',
      pageKind: 'Filter',
      routeKey: hydrationPayload.routeKey,
      rendererVersion: PUBLIC_RENDERER_VERSION,
      siteTitle: options.siteTitle ?? null,
      siteDescription: options.siteDescription ?? null,
      filter: hydrationPayload.filter
    }),
    hydrationPropsJson: JSON.stringify(hydrationPayload),
    rendererVersion: PUBLIC_RENDERER_VERSION,
    islandsJson: null,
    title,
    baseUrl: options.baseUrl ?? null
  }
}

function parseJsonRecord(input, label) {
  const parsed = JSON.parse(input)
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${label} must be an object`)
  return parsed
}

function asRecord(value, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value
}

function assertStringField(record, key, expected, label) {
  const actual = record[key]
  assert(typeof actual === 'string', `${label}.${key} must be a string`)
  assert(actual === expected, `${label}.${key} mismatch: expected ${expected}, got ${actual}`)
}

function assertNumberField(record, key, expected, label) {
  const actual = record[key]
  if (typeof actual === 'number') {
    assert(actual === expected, `${label}.${key} mismatch: expected ${expected}, got ${actual}`)
    return
  }
  if (typeof actual === 'string') {
    const parsed = Number(actual)
    assert(Number.isFinite(parsed), `${label}.${key} must be numeric`)
    assert(parsed === expected, `${label}.${key} mismatch: expected ${expected}, got ${actual}`)
    return
  }
  assert(false, `${label}.${key} must be numeric`)
}

function assertOptionalNullish(record, key, label) {
  const actual = record[key]
  assert(actual === undefined || actual === null, `${label}.${key} must be empty`)
}

function validatePublicAotShellEntry(entry) {
  assert(typeof entry.rendererVersion === 'string' && entry.rendererVersion.length > 0, 'rendererVersion is required')
  const rendererVersion = entry.rendererVersion.trim()
  assert(rendererVersion.startsWith('public-vue-renderer@'), `rendererVersion is invalid: ${rendererVersion}`)
  assert(entry.bootstrapJson && entry.hydrationPropsJson, 'bootstrapJson and hydrationPropsJson are required')

  const bootstrap = parseJsonRecord(entry.bootstrapJson, 'bootstrapJson')
  const hydration = parseJsonRecord(entry.hydrationPropsJson, 'hydrationPropsJson')

  assertStringField(bootstrap, 'rendererVersion', rendererVersion, 'bootstrapJson')
  assertStringField(hydration, 'rendererVersion', rendererVersion, 'hydrationPropsJson')

  const validator = entryValidators[entry.pageId]
  if (!validator) {
    throw new Error(`Unsupported public AOT pageId: ${String(entry.pageId)}`)
  }

  validator(entry, bootstrap, hydration)
}

const entryValidators = {
  1: (entry, bootstrap, hydration) => {
    assert(entry.articleId == null, 'home bundle should not carry articleId')
    assert(entry.routeKey === 'home', 'home bundle routeKey mismatch')
    assertStringField(bootstrap, 'kind', 'Home', 'bootstrapJson')
    assertStringField(bootstrap, 'pageKind', 'Home', 'bootstrapJson')
    assertStringField(bootstrap, 'routeKey', 'home', 'bootstrapJson')
    assertStringField(hydration, 'pageKind', 'Home', 'hydrationPropsJson')
    assertStringField(hydration, 'routeKey', 'home', 'hydrationPropsJson')
    assertOptionalNullish(hydration, 'articleId', 'hydrationPropsJson')
    assert(!entry.islandsJson, 'home bundle should not carry islandsJson')
  },
  2: (entry, bootstrap, hydration) => {
    assert(typeof entry.articleId === 'number' && entry.articleId > 0, 'article detail bundle requires a positive articleId')
    const articleId = entry.articleId
    const expectedRouteKey = `article:${articleId}`
    assert(entry.routeKey === expectedRouteKey, `article detail routeKey mismatch: expected ${expectedRouteKey}`)
    assertStringField(bootstrap, 'kind', 'ArticleDetail', 'bootstrapJson')
    assertStringField(bootstrap, 'pageKind', 'ArticleDetail', 'bootstrapJson')
    assertStringField(bootstrap, 'routeKey', expectedRouteKey, 'bootstrapJson')
    assertNumberField(bootstrap, 'articleId', articleId, 'bootstrapJson')
    assertStringField(hydration, 'pageKind', 'ArticleDetail', 'hydrationPropsJson')
    assertStringField(hydration, 'routeKey', expectedRouteKey, 'hydrationPropsJson')
    assertNumberField(hydration, 'articleId', articleId, 'hydrationPropsJson')

    const commentsIsland = asRecord(hydration.commentsIsland, 'hydrationPropsJson.commentsIsland')
    assertNumberField(commentsIsland, 'articleId', articleId, 'hydrationPropsJson.commentsIsland')

    assert(entry.islandsJson, 'article detail bundle requires islandsJson')
    const islands = parseJsonRecord(entry.islandsJson, 'islandsJson')
    const comments = asRecord(islands.comments, 'islandsJson.comments')
    assertNumberField(comments, 'articleId', articleId, 'islandsJson.comments')
  },
  3: (entry, bootstrap, hydration) => {
    assert(entry.articleId == null, 'filter bundle should not carry articleId')
    assertStringField(bootstrap, 'kind', 'Filter', 'bootstrapJson')
    assertStringField(bootstrap, 'pageKind', 'Filter', 'bootstrapJson')
    assertStringField(bootstrap, 'routeKey', entry.routeKey, 'bootstrapJson')
    assertStringField(hydration, 'pageKind', 'Filter', 'hydrationPropsJson')
    assertStringField(hydration, 'routeKey', entry.routeKey, 'hydrationPropsJson')
    assertOptionalNullish(hydration, 'articleId', 'hydrationPropsJson')
    assert(!entry.islandsJson, 'filter bundle should not carry islandsJson')
  },
  4: (entry, bootstrap, hydration) => {
    assert(entry.articleId == null, 'about bundle should not carry articleId')
    assert(entry.routeKey === 'about', 'about bundle routeKey mismatch')
    assertStringField(bootstrap, 'kind', 'About', 'bootstrapJson')
    assertStringField(bootstrap, 'pageKind', 'About', 'bootstrapJson')
    assertStringField(bootstrap, 'routeKey', 'about', 'bootstrapJson')
    assertStringField(hydration, 'pageKind', 'About', 'hydrationPropsJson')
    assertStringField(hydration, 'routeKey', 'about', 'hydrationPropsJson')
    assertOptionalNullish(hydration, 'articleId', 'hydrationPropsJson')
    assert(!entry.islandsJson, 'about bundle should not carry islandsJson')
  },
  5: (entry, bootstrap, hydration) => {
    assert(entry.articleId == null, 'archive bundle should not carry articleId')
    assert(entry.routeKey === 'archive', 'archive bundle routeKey mismatch')
    assertStringField(bootstrap, 'kind', 'Archive', 'bootstrapJson')
    assertStringField(bootstrap, 'pageKind', 'Archive', 'bootstrapJson')
    assertStringField(bootstrap, 'routeKey', 'archive', 'bootstrapJson')
    assertStringField(hydration, 'pageKind', 'Archive', 'hydrationPropsJson')
    assertStringField(hydration, 'routeKey', 'archive', 'hydrationPropsJson')
    assertOptionalNullish(hydration, 'articleId', 'hydrationPropsJson')
    assert(!entry.islandsJson, 'archive bundle should not carry islandsJson')
  }
}

export function validatePublicAotShellBundle(bundle) {
  assert(Array.isArray(bundle.entries) && bundle.entries.length > 0, 'public hydration bundle is empty')
  bundle.entries.forEach(validatePublicAotShellEntry)
  return bundle
}

export async function buildPublicHydrationBundle(options) {
  const entries = [await buildArticleDetailPublicAotEntry(options)]

  if (options.includeHome !== false) {
    entries.push(await buildHomePublicAotEntry({
      siteTitle: options.siteTitle,
      siteDescription: options.siteDescription,
      baseUrl: options.baseUrl,
      response: options.homeResponse,
      page: options.homePage,
      size: options.homeSize
    }))
  }

  if (options.includeAbout && options.about) {
    entries.push(await buildAboutPublicAotEntry({
      ...options.about,
      siteTitle: options.about.siteTitle ?? options.siteTitle,
      siteDescription: options.about.siteDescription ?? options.siteDescription,
      baseUrl: options.about.baseUrl ?? options.baseUrl
    }))
  }

  if (options.includeArchive && options.archive) {
    entries.push(await buildArchivePublicAotEntry({
      ...options.archive,
      siteTitle: options.archive.siteTitle ?? options.siteTitle,
      siteDescription: options.archive.siteDescription ?? options.siteDescription,
      baseUrl: options.archive.baseUrl ?? options.baseUrl
    }))
  }

  if (options.includeFilter && options.filter) {
    entries.push(await buildFilterPublicAotEntry({
      ...options.filter,
      siteTitle: options.filter.siteTitle ?? options.siteTitle,
      siteDescription: options.filter.siteDescription ?? options.siteDescription,
      baseUrl: options.filter.baseUrl ?? options.baseUrl
    }))
  }

  const bundle = {
    generatedAtUtc: new Date().toISOString(),
    entries
  }

  validatePublicAotShellBundle(bundle)
  return bundle
}

export {
  MARKDOWN_RENDERER_VERSION,
  renderPublicMarkdownHtml
}
