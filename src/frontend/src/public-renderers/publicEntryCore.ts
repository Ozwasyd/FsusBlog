import { createSSRApp, type Component } from 'vue'
import { renderToString } from '@vue/server-renderer'
import type { ArticleDetailResponse, ArticleListItemResponse, Tag } from '@/api/article'
import type { SiteComplianceConfigPublic } from '@/api/system'
import { encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import { provideFsusUiAppContext } from '@/fsusui/appContext'
import { getSharedPublicPageManifestEntry } from '@/public-renderers/generated/publicPageManifest'
import type { PublicPageKind } from '@/public-renderers/publicRenderBase'
import { renderPublicAotShell, type PublicAotPageAssembly } from '@/public-renderers/scaffold'
import { registerPublicStaticRouterLink } from '@/public-renderers/publicStaticRouterLink'
import { renderMarkdownWithFsusRuntime } from '@/fsusui/markdown'

export const PUBLIC_RENDERER_VERSION = 'public-app-ssr@2026-06-03-fsusui-boundary-3'

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
    summary: toText(options.summary, '')
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

  return result.ok ? result.value.html ?? '' : ''
}

function encodePayload(value: unknown): string {
  return encodePublicAotPayload(value)
}

export async function renderShell(
  kind: PublicPageKind,
  siteTitle: string,
  page: PublicAotPageAssembly,
  compliance: SiteComplianceConfigPublic | null = null,
  brand: Readonly<{
    siteDescription?: string | null
    siteLogoUrl?: string | null
    siteLogoDarkUrl?: string | null
    siteWordmarkUrl?: string | null
    renderYear?: number | null
  }> = {}
): Promise<string> {
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
        compliance,
        page
      })
    }
  }

  const app = createSSRApp(Root)
  provideFsusUiAppContext(app)
  registerPublicStaticRouterLink(app)
  return await renderToString(app)
}

export function createEntry(kind: PublicPageKind, routeKey: string, html: string, bootstrap: Record<string, unknown>, hydration: Record<string, unknown>, options: {
  articleId?: number | null
  title?: string | null
  baseUrl?: string | null
} = {}): RenderResult {
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
      baseUrl: options.baseUrl ?? toText(hydration.baseUrl, '')
    }
  }
}
