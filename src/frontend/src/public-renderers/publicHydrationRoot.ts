import { defineComponent, type Ref, type ShallowRef, type VNode } from 'vue'
import {
  createPublicAboutPageAssembly,
  createPublicArchivePageAssembly,
  createPublicArticleDetailPageAssembly,
  createPublicFilterPageAssembly,
  createPublicHomePageAssembly
} from '@/public-renderers/pageAssemblies'
import { renderPublicAotShell, type PublicAotPageAssembly } from '@/public-renderers/scaffold'
import type { PublicHydrationPayload } from '@/public-renderers/types'
import { parsePositiveInt } from '@/public-renderers/publicRouteIdentity'
import {
  normalizePublicComplianceConfig,
  normalizePublicSiteDescription,
  normalizePublicSiteTitle
} from '@/public-renderers/publicSiteIdentity'
import { isSupportedLocale } from '@/locales'
import {
  renderMarkdownOrThrow,
  type MarkdownSafeRenderResult
} from '@/fsusui/markdown'

function getSiteTitle(payload: PublicHydrationPayload): string {
  return normalizePublicSiteTitle(payload.siteTitle ?? payload.title)
}

function getSiteDescription(payload: PublicHydrationPayload): string {
  return normalizePublicSiteDescription(payload.siteDescription)
}

function requireHydrationView<T>(view: T | null | undefined, pageKind: string): T {
  if (!view) {
    throw new Error(`public_aot_hydration_view_missing:${pageKind}`)
  }

  return view
}

function createHydrationPageAssembly(
  payload: PublicHydrationPayload,
  initialRender: MarkdownSafeRenderResult | null
): PublicAotPageAssembly {
  switch (payload.pageKind) {
    case 'Home':
      return createPublicHomePageAssembly({
        view: payload.view,
        featuredArticles: payload.featuredArticles,
        hotArticles: payload.hotArticles
      })
    case 'ArticleDetail': {
      if (!initialRender) {
        throw new Error('public_aot_hydration_markdown_render_missing')
      }
      const articleId = parsePositiveInt(payload.articleId)
      return createPublicArticleDetailPageAssembly({
        detailView: payload.detailView,
        articleId,
        authorName: payload.authorName?.trim() || getSiteTitle(payload),
        responsibilityAuthors: payload.responsibilityAuthors?.length
          ? payload.responsibilityAuthors
          : [{ name: payload.authorName?.trim() || getSiteTitle(payload), profileUrl: null }],
        responsibilityManifest: payload.responsibilityManifest ?? null,
        articleSummary: payload.articleSummary?.trim() || payload.detailView.header.title,
        canonicalUrl: payload.baseUrl
          ? `${String(payload.baseUrl).replace(/\/+$/u, '')}/article/${articleId}`
          : null,
        baseUrl: payload.baseUrl ?? null,
        hasBodyContent: Boolean(payload.bodyContent?.trim()),
        bodyContent: payload.bodyContent ?? '',
        initialRender
      })
    }
    case 'About':
    case 'Privacy':
    case 'Guidelines':
    case 'Copyright':
      if (!initialRender) {
        throw new Error('public_aot_hydration_markdown_render_missing')
      }
      return createPublicAboutPageAssembly({
        view: requireHydrationView(payload.view, payload.pageKind),
        content: payload.staticPage?.content ?? '',
        initialRender,
        baseUrl: payload.baseUrl ?? null
      })
    case 'Archive':
      return createPublicArchivePageAssembly({
        view: requireHydrationView(payload.view, payload.pageKind)
      })
    case 'Filter':
      return createPublicFilterPageAssembly({
        view: requireHydrationView(payload.view, payload.pageKind),
        invalidTarget: Boolean(payload.isInvalidTarget),
        showSearchSort: (payload.filter?.filterType ?? payload.filterType) === 'search'
      })
  }
}

export function createPublicHydrationRoot(
  payload: PublicHydrationPayload,
  initialRender: MarkdownSafeRenderResult | null = null
): VNode {
  if (!isSupportedLocale(payload.renderLocale)) {
    throw new Error('public_aot_hydration_render_locale_invalid')
  }
  const page = createHydrationPageAssembly(payload, initialRender)
  return renderPublicAotShell({
    kind: payload.pageKind,
    siteTitle: getSiteTitle(payload),
    siteDescription: getSiteDescription(payload),
    siteLogoUrl: payload.siteLogoUrl ?? null,
    siteLogoDarkUrl: payload.siteLogoDarkUrl ?? null,
    siteWordmarkUrl: payload.siteWordmarkUrl ?? null,
    renderYear: payload.renderYear ?? null,
    compliance: normalizePublicComplianceConfig(payload.compliance),
    renderLocale: payload.renderLocale,
    page
  })
}

export type PublicHydrationTakeoverController = Readonly<{
  active: Ref<boolean>
  renderer: ShallowRef<(() => VNode) | null>
}>

export function createPublicHydrationRootComponent(
  payload: PublicHydrationPayload,
  initialRender: MarkdownSafeRenderResult | null = null,
  takeover?: PublicHydrationTakeoverController
): ReturnType<typeof defineComponent> {
  return defineComponent({
    name: 'PublicHydrationRoot',
    render: () => takeover?.active.value && takeover.renderer.value
      ? takeover.renderer.value()
      : createPublicHydrationRoot(payload, initialRender)
  })
}

export async function renderPublicHydrationMarkdown(
  payload: PublicHydrationPayload
): Promise<MarkdownSafeRenderResult | null> {
  switch (payload.pageKind) {
    case 'ArticleDetail':
      return renderMarkdownOrThrow({
        source: payload.bodyContent ?? '',
        baseUrl: payload.baseUrl ?? null,
        mode: 'article'
      })
    case 'About':
    case 'Privacy':
    case 'Guidelines':
    case 'Copyright':
      return renderMarkdownOrThrow({
        source: payload.staticPage?.content ?? '',
        baseUrl: payload.baseUrl ?? null,
        mode: 'about'
      })
    default:
      return null
  }
}
