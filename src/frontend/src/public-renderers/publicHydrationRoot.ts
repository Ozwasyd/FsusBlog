import { defineComponent, type VNode } from 'vue'
import {
  createPublicAboutPageAssembly,
  createPublicArchivePageAssembly,
  createPublicArticleDetailPageAssembly,
  createPublicFilterPageAssembly,
  createPublicHomePageAssembly
} from '@/public-renderers/pageAssemblies'
import { renderPublicAotShell, type PublicAotPageAssembly } from '@/public-renderers/scaffold'
import { PUBLIC_SHELL_DEFAULTS } from '@/public-renderers/publicShellState'
import type { PublicHydrationPayload } from '@/public-renderers/types'

function getSiteTitle(payload: PublicHydrationPayload): string {
  const title = payload.siteTitle?.trim()
  return title || PUBLIC_SHELL_DEFAULTS.siteTitle
}

function getSiteDescription(payload: PublicHydrationPayload): string {
  return payload.siteDescription?.trim() ?? ''
}

function createHydrationPageAssembly(payload: PublicHydrationPayload): PublicAotPageAssembly {
  switch (payload.pageKind) {
    case 'Home':
      return createPublicHomePageAssembly({
        siteTitleText: getSiteTitle(payload),
        siteDescriptionText: getSiteDescription(payload),
        view: payload.view
      })
    case 'ArticleDetail':
      return createPublicArticleDetailPageAssembly({
        detailView: payload.detailView,
        articleId: Number(payload.articleId) || payload.articleId,
        authorName: payload.authorName?.trim() || getSiteTitle(payload),
        articleSummary: payload.articleSummary?.trim() || payload.detailView.header.title,
        canonicalUrl: payload.baseUrl
          ? `${String(payload.baseUrl).replace(/\/+$/u, '')}/article/${payload.articleId}`
          : null,
        hasBodyContent: Boolean(payload.bodyContent?.trim()),
        bodyContent: payload.bodyContent ?? '',
        bodyHtml: payload.bodyHtml ?? ''
      })
    case 'About':
    case 'Privacy':
    case 'Guidelines':
    case 'Copyright':
      return createPublicAboutPageAssembly({
        view: payload.view!,
        content: payload.staticPage?.content ?? '',
        bodyHtml: payload.bodyHtml ?? '',
        baseUrl: payload.baseUrl ?? null
      })
    case 'Archive':
      return createPublicArchivePageAssembly({
        view: payload.view!
      })
    case 'Filter':
      return createPublicFilterPageAssembly({
        view: payload.view!,
        invalidTarget: Boolean(payload.isInvalidTarget),
        showSearchSort: payload.filterType === 'search'
      })
  }
}

export function createPublicHydrationRoot(payload: PublicHydrationPayload): VNode {
  const page = createHydrationPageAssembly(payload)
  return renderPublicAotShell({
    kind: payload.pageKind,
    siteTitle: getSiteTitle(payload),
    compliance: payload.compliance ?? null,
    page
  })
}

export function createPublicHydrationRootComponent(payload: PublicHydrationPayload): ReturnType<typeof defineComponent> {
  return defineComponent({
    name: 'PublicHydrationRoot',
    render: () => createPublicHydrationRoot(payload)
  })
}
