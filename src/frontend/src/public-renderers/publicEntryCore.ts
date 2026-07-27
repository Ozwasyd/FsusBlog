import { createSSRApp, type Component } from 'vue'
import { renderToString } from '@vue/server-renderer'
import {
  prepareLocaleDomains,
  provideLocaleTextContext
} from '@/locales'
import { requiredLocaleDomainsForPublicPage } from '@/locales/routeLocaleDomains'
import type { ArticleDetailResponse, ArticleListItemResponse, ArticleRightsResponse, Tag } from '@/api/article'
import type { SiteComplianceConfigPublic } from '@/api/system'
import { encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import { provideFsusUiAppContext } from '@/fsusui/appContext'
import { getSharedPublicPageManifestEntry } from '@/public-renderers/generated/publicPageManifest'
import type { PublicPageKind } from '@/public-renderers/publicRenderBase'
import { renderPublicAotShell, type PublicAotPageAssembly } from '@/public-renderers/scaffold'
import { registerPublicStaticRouterLink } from '@/public-renderers/publicStaticRouterLink'
import { renderMarkdownWithFsusRuntime } from '@/fsusui/markdown'
import { sanitizeMarkdownRuntimeHtml } from '@/utils/safeHtml'
import { isSupportedLocale, type SupportedLocale } from '@/locales'

export const PUBLIC_RENDERER_VERSION = 'public-app-ssr@2026-07-27-locale-cutover-4'

export type RenderedPublicEntry = Readonly<{
  pageId: number
  routeKey: string
  html: string
  articleId?: number | null
  bootstrapPayload: string
  hydrationPropsPayload: string
  rendererVersion: string
  islandsPayload?: string | null
  title?: string | null
  baseUrl?: string | null
  renderLocale: SupportedLocale
}>

export type RenderResult = Readonly<{
  entry: RenderedPublicEntry
}>

export type PublicEntryBuildOptions = Record<string, unknown>

export function toNumber(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function toText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

export function normalizeTags(value: unknown): Tag[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map((tag, index) => {
    if (typeof tag === 'string') {
      return { id: index + 1, name: tag }
    }

    const item = tag as Record<string, unknown>
    return {
      id: toNumber(item.id, index + 1),
      name: toText(item.name, '')
    }
  }).filter((tag) => tag.name.length > 0)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function toOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function toRequiredText(value: unknown, fieldName: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) {
    throw new Error(`public_aot_article_rights_invalid:${fieldName}`)
  }

  return text
}

function toRequiredIdText(value: unknown, fieldName: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim()
  }

  const number = Number(value)
  if (Number.isFinite(number) && number > 0) {
    return String(Math.trunc(number))
  }

  throw new Error(`public_aot_article_rights_invalid:${fieldName}`)
}

function toOptionalNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : null
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function normalizeArticleRights(value: unknown): ArticleRightsResponse {
  const rights = asRecord(value)
  if (!rights) {
    throw new Error('public_aot_article_rights_missing')
  }

  const revisionNo = toNumber(rights.revisionNo ?? rights.RevisionNo)
  if (revisionNo <= 0) {
    throw new Error('public_aot_article_rights_invalid:revisionNo')
  }

  return {
    snapshotId: toRequiredIdText(rights.snapshotId ?? rights.SnapshotId, 'snapshotId'),
    articleRevisionId: toRequiredIdText(rights.articleRevisionId ?? rights.ArticleRevisionId, 'articleRevisionId'),
    revisionNo,
    enabled: toBoolean(rights.enabled ?? rights.Enabled, true),
    licenseType: toRequiredText(rights.licenseType ?? rights.LicenseType, 'licenseType'),
    copyrightHolder: toOptionalText(rights.copyrightHolder ?? rights.CopyrightHolder),
    copyrightYear: toOptionalNumber(rights.copyrightYear ?? rights.CopyrightYear),
    rightsStatement: toOptionalText(rights.rightsStatement ?? rights.RightsStatement),
    attributionTemplate: toOptionalText(rights.attributionTemplate ?? rights.AttributionTemplate),
    copyPolicy: toRequiredText(rights.copyPolicy ?? rights.CopyPolicy, 'copyPolicy'),
    maxExcerptChars: Math.max(0, toNumber(rights.maxExcerptChars ?? rights.MaxExcerptChars, 0)),
    allowCodeCopy: toBoolean(rights.allowCodeCopy ?? rights.AllowCodeCopy, false),
    showPublicBadge: toBoolean(rights.showPublicBadge ?? rights.ShowPublicBadge, false),
    proofBindingEnabled: toBoolean(rights.proofBindingEnabled ?? rights.ProofBindingEnabled, false),
    canonicalUrl: toOptionalText(rights.canonicalUrl ?? rights.CanonicalUrl),
    policyHash: toRequiredText(rights.policyHash ?? rights.PolicyHash, 'policyHash'),
    contentCanonicalHash: toRequiredText(rights.contentCanonicalHash ?? rights.ContentCanonicalHash, 'contentCanonicalHash'),
    proofUrl: toOptionalText(rights.proofUrl ?? rights.ProofUrl),
    proofStatus: toOptionalText(rights.proofStatus ?? rights.ProofStatus)
  }
}

export function normalizeArticleSummary(value: unknown): ArticleListItemResponse {
  const item = value as Record<string, unknown>
  const category = item.category && typeof item.category === 'object'
    ? item.category as Record<string, unknown>
    : {
        id: item.categoryId,
        name: item.categoryName
      }

  return {
    id: toNumber(item.id ?? item.Id),
    title: toText(item.title ?? item.Title, 'Untitled'),
    summary: toText(item.summary ?? item.Summary ?? item.snippet ?? item.Snippet, ''),
    coverImageUrl: toText(item.coverImageUrl ?? item.CoverImageUrl, ''),
    views: toNumber(item.views ?? item.Views),
    createTime: toText(item.createTime ?? item.CreateTime, new Date(0).toISOString()),
    category: {
      id: toNumber(category.id ?? category.Id),
      name: toText(category.name ?? category.Name, '未分类')
    },
    tags: normalizeTags(item.tags ?? item.Tags)
  }
}

export function normalizeArticleDetail(options: Record<string, unknown>): ArticleDetailResponse {
  return {
    ...normalizeArticleSummary(options),
    id: toNumber(options.articleId ?? options.id),
    content: toText(options.bodyContent ?? options.content, ''),
    summary: toText(options.summary, ''),
    publishedAt: toOptionalText(options.publishedAt ?? options.PublishedAt),
    updatedAt: toOptionalText(options.updatedAt ?? options.UpdatedAt),
    rights: normalizeArticleRights(options.rights ?? options.Rights)
  }
}

export async function renderAotBodyHtml(source: string, baseUrl: string | null = null): Promise<string> {
  if (!source.trim()) {
    return ''
  }

  const result = await renderMarkdownWithFsusRuntime({
    source,
    mode: 'article',
    allowHtml: false,
    allowLatex: true,
    allowMermaid: true,
    baseUrl
  })

  const html = result.ok ? result.value.html ?? '' : ''
  return html.trim() ? html : renderFallbackAotMarkdownHtml(source, baseUrl)
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

function resolveMarkdownUrl(rawUrl: string, baseUrl: string | null): string {
  const trimmed = rawUrl.trim()
  if (!baseUrl || /^(?:https?:|data:|mailto:|#)/iu.test(trimmed)) {
    return escapeMarkdownText(trimmed)
  }

  try {
    return escapeMarkdownText(new URL(trimmed, baseUrl).toString())
  } catch {
    return escapeMarkdownText(trimmed)
  }
}

function renderParagraph(lines: string[]): string {
  const text = lines.join(' ').trim()
  return text ? `<p>${escapeMarkdownText(text)}</p>` : ''
}

function renderFallbackTable(lines: string[]): string {
  const cells = (line: string): string[] =>
    line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim())
  const [headerLine, , ...bodyLines] = lines
  const headers = cells(headerLine ?? '')
  const rows = bodyLines.map(cells)
  const thead = `<thead><tr>${headers.map((cell) => `<th>${escapeMarkdownText(cell)}</th>`).join('')}</tr></thead>`
  const tbody = `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeMarkdownText(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`
  return `<table>${thead}${tbody}</table>`
}

function renderFallbackAotMarkdownHtml(source: string, baseUrl: string | null): string {
  const html: string[] = []
  const paragraph: string[] = []
  const lines = source.replace(/\r\n?/gu, '\n').split('\n')

  const flushParagraph = (): void => {
    const rendered = renderParagraph(paragraph.splice(0))
    if (rendered) {
      html.push(rendered)
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()

    if (!trimmed) {
      flushParagraph()
      continue
    }

    const fence = trimmed.match(/^```([A-Za-z0-9_-]*)\s*$/u)
    if (fence) {
      flushParagraph()
      const language = fence[1] ? ` class="language-${escapeMarkdownText(fence[1])}"` : ''
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/u.test(lines[index]?.trim() ?? '')) {
        codeLines.push(lines[index] ?? '')
        index += 1
      }
      html.push(`<pre><code${language}>${escapeMarkdownText(codeLines.join('\n'))}</code></pre>`)
      continue
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/u)
    if (heading) {
      flushParagraph()
      const level = heading[1].length
      html.push(`<h${level}>${escapeMarkdownText(heading[2])}</h${level}>`)
      continue
    }

    const image = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/u)
    if (image) {
      flushParagraph()
      html.push(`<p><img src="${resolveMarkdownUrl(image[2], baseUrl)}" alt="${escapeMarkdownText(image[1])}" loading="lazy" decoding="async"></p>`)
      continue
    }

    if (
      trimmed.startsWith('|')
      && (lines[index + 1] ?? '').trim().match(/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/u)
    ) {
      flushParagraph()
      const tableLines = [line, lines[index + 1] ?? '']
      index += 2
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) {
        tableLines.push(lines[index] ?? '')
        index += 1
      }
      index -= 1
      html.push(renderFallbackTable(tableLines))
      continue
    }

    if (trimmed.startsWith('>')) {
      flushParagraph()
      const quoteLines: string[] = []
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        quoteLines.push((lines[index] ?? '').trim().replace(/^>\s?/u, ''))
        index += 1
      }
      index -= 1
      html.push(`<blockquote>${renderParagraph(quoteLines)}</blockquote>`)
      continue
    }

    paragraph.push(line)
  }

  flushParagraph()
  return sanitizeMarkdownRuntimeHtml(html.join('\n'))
}

function encodePayload(value: unknown): string {
  return encodePublicAotPayload(value)
}

export async function renderShell(
  kind: PublicPageKind,
  siteTitle: string,
  page: PublicAotPageAssembly,
  compliance: SiteComplianceConfigPublic | null,
  brand: Readonly<{
    siteDescription?: string | null
    siteLogoUrl?: string | null
    siteLogoDarkUrl?: string | null
    siteWordmarkUrl?: string | null
    renderYear?: number | null
    renderLocale: SupportedLocale
  }>
): Promise<string> {
  if (!isSupportedLocale(brand.renderLocale)) {
    throw new Error('public_aot_shell_render_locale_invalid')
  }
  const localeSnapshot = await prepareLocaleDomains(
    brand.renderLocale,
    requiredLocaleDomainsForPublicPage(kind)
  )
  const Root: Component = {
    render() {
      return renderPublicAotShell({
        kind,
        siteTitle,
        siteDescription: brand.siteDescription ?? null,
        siteLogoUrl: brand.siteLogoUrl ?? null,
        siteLogoDarkUrl: brand.siteLogoDarkUrl ?? null,
        siteWordmarkUrl: brand.siteWordmarkUrl ?? null,
        renderYear: brand.renderYear ?? null,
        renderLocale: brand.renderLocale,
        compliance,
        page
      })
    }
  }

  const app = createSSRApp(Root)
  provideLocaleTextContext(app, localeSnapshot)
  provideFsusUiAppContext(app)
  registerPublicStaticRouterLink(app)
  return await renderToString(app)
}

export function createEntry(kind: PublicPageKind, routeKey: string, html: string, bootstrap: Record<string, unknown>, hydration: Record<string, unknown>, options: {
  articleId?: number | null
  title?: string | null
  baseUrl?: string | null
} = {}): RenderResult {
  if (!isSupportedLocale(hydration.renderLocale)) {
    throw new Error('public_aot_hydration_render_locale_missing')
  }

  return {
    entry: {
      pageId: getSharedPublicPageManifestEntry(kind).pageId,
      routeKey,
      html,
      articleId: options.articleId ?? null,
      bootstrapPayload: encodePayload(bootstrap),
      hydrationPropsPayload: encodePayload(hydration),
      rendererVersion: PUBLIC_RENDERER_VERSION,
      islandsPayload: null,
      title: options.title ?? toText(hydration.title, ''),
      baseUrl: options.baseUrl ?? toText(hydration.baseUrl, ''),
      renderLocale: hydration.renderLocale
    }
  }
}
