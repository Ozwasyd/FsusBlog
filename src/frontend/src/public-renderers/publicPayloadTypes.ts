import type { PublicHomeRouteKey } from '@/public-renderers/publicFixedPageSemantics'
import type { PublicFilterType } from '@/public-renderers/publicFilterSemantics'
import type { PublicPageKind } from '@/public-renderers/publicRenderBase'
import type { ArticleRightsResponse, FeaturedArticleItem, PopularArticleSummaryResponse, RelatedReadingResponse } from '@/api/article'
import type { SiteComplianceConfigPublic } from '@/api/system'
import type { AboutPageViewContract } from '@/view-contracts/aboutPage'
import type { ArchivePageViewContract } from '@/view-contracts/archive'
import type { ArticleDetailPageViewContract } from '@/view-contracts/articleDetail'
import type { ArticleResponsibilityPublicView } from '@/view-contracts/articleResponsibility'
import type { ArticleListViewContract } from '@/view-contracts/articleList'
import type { FilterPageViewContract } from '@/view-contracts/filterView'
import type { SupportedLocale } from '@/locales'

export type PublicAotBootstrapKind = PublicPageKind

export type BootstrapArticleSummary = Readonly<{
  id: number
  title: string
  summary?: string | null
  snippet?: string | null
  content?: string | null
  views?: number | null
  createTime: string
  coverImageUrl?: string | null
  category?: string | Readonly<{ id?: number | null; name?: string | null }> | null
  tags?: readonly string[] | null
}>

export type BootstrapArticleDetailSummary = BootstrapArticleSummary & Readonly<{
  rights: ArticleRightsResponse
}>

type BaseBootstrapPayload<K extends PublicAotBootstrapKind> = Readonly<{
  kind: K
  pageKind?: K
  routeKey?: string
  rendererVersion?: string
  path?: string
  query?: string
  siteTitle?: string
  siteDescription?: string
  siteLogoUrl?: string | null
  siteLogoDarkUrl?: string | null
  siteWordmarkUrl?: string | null
  loginLogoUrl?: string | null
  loginIconUrl?: string | null
  compliance?: SiteComplianceConfigPublic | null
  title?: string
  generatedAt?: string
  renderTimestamp?: string
  renderYear?: number
  renderTimeZone?: string
  renderLocale?: SupportedLocale
}>

export type PublicAotBootstrapPayloadByKind = {
  Home: BaseBootstrapPayload<'Home'> & Readonly<{
    total: number
    articles: readonly BootstrapArticleSummary[]
    featuredArticles: readonly FeaturedArticleItem[]
    hotArticles: readonly PopularArticleSummaryResponse[]
  }>
  About: BaseBootstrapPayload<'About'> & Readonly<{
    bodyHtml?: string | null
    staticPage?: Readonly<{
      slug?: string
      content?: string
    }>
  }>
  Privacy: BaseBootstrapPayload<'Privacy'> & Readonly<{
    bodyHtml?: string | null
    staticPage?: Readonly<{
      slug?: string
      content?: string
    }>
  }>
  Guidelines: BaseBootstrapPayload<'Guidelines'> & Readonly<{
    bodyHtml?: string | null
    staticPage?: Readonly<{
      slug?: string
      content?: string
    }>
  }>
  Copyright: BaseBootstrapPayload<'Copyright'> & Readonly<{
    bodyHtml?: string | null
    staticPage?: Readonly<{
      slug?: string
      content?: string
    }>
  }>
  Archive: BaseBootstrapPayload<'Archive'> & Readonly<{
    total: number
    articles: readonly Readonly<{
      id: number
      title: string
      createTime: string
    }> []
  }>
  ArticleDetail: BaseBootstrapPayload<'ArticleDetail'> & Readonly<{
    article?: BootstrapArticleDetailSummary
    relatedReading?: RelatedReadingResponse | null
    commentsPlaceholder?: string
  }>
  Filter: BaseBootstrapPayload<'Filter'> & Readonly<{
    filterType?: PublicFilterType | null
    filterKey?: string | null
    filterId?: number
    filterName?: string | null
    isInvalidTarget?: boolean
    filter?: Readonly<{
      filterType?: PublicFilterType | null
      filterKey?: string | null
      filterId?: number
      filterName?: string | null
      isInvalidTarget?: boolean
      pageIndex?: number
      pageSize?: number
      total?: number
      articles?: readonly BootstrapArticleSummary[]
    }>
  }>
}

export type PublicAotBootstrapPayload = PublicAotBootstrapPayloadByKind[PublicAotBootstrapKind]

export type PublicAotBootstrapPayloadFor<K extends PublicAotBootstrapKind> = PublicAotBootstrapPayloadByKind[K]

type BaseHydrationPayload<K extends PublicPageKind> = Readonly<{
  pageKind: K
  routeKey: string
  rendererVersion: string
  title: string
  siteTitle?: string | null
  siteDescription?: string | null
  baseUrl?: string | null
  siteLogoUrl?: string | null
  siteLogoDarkUrl?: string | null
  siteWordmarkUrl?: string | null
  loginLogoUrl?: string | null
  loginIconUrl?: string | null
  compliance?: SiteComplianceConfigPublic | null
  renderTimestamp?: string
  renderYear?: number
  renderTimeZone?: string
  renderLocale?: SupportedLocale
}>

export type PublicHydrationPayloadByKind = {
  Home: BaseHydrationPayload<'Home'> & Readonly<{
    routeKey: PublicHomeRouteKey
    currentPage: number
    pageSize: number
    total: number
    view: ArticleListViewContract
    featuredArticles: readonly FeaturedArticleItem[]
    hotArticles: readonly PopularArticleSummaryResponse[]
  }>
  ArticleDetail: BaseHydrationPayload<'ArticleDetail'> & Readonly<{
    articleId: number | string
    authorName?: string | null
    responsibilityAuthors?: readonly Readonly<{ name: string; profileUrl: string | null }>[]
    responsibilityManifest?: ArticleResponsibilityPublicView | null
    articleSummary?: string | null
    bodyContent: string
    bodyHtml?: string | null
    rights: ArticleRightsResponse
    detailView: ArticleDetailPageViewContract
    commentsIsland: Readonly<{
      articleId: number | string
    }>
  }>
  About: BaseHydrationPayload<'About'> & Readonly<{
    bodyHtml?: string | null
    view?: AboutPageViewContract
    staticPage?: Readonly<{
      slug?: string | null
      content?: string | null
    }> | null
  }>
  Privacy: BaseHydrationPayload<'Privacy'> & Readonly<{
    bodyHtml?: string | null
    view?: AboutPageViewContract
    staticPage?: Readonly<{
      slug?: string | null
      content?: string | null
    }> | null
  }>
  Guidelines: BaseHydrationPayload<'Guidelines'> & Readonly<{
    bodyHtml?: string | null
    view?: AboutPageViewContract
    staticPage?: Readonly<{
      slug?: string | null
      content?: string | null
    }> | null
  }>
  Copyright: BaseHydrationPayload<'Copyright'> & Readonly<{
    bodyHtml?: string | null
    view?: AboutPageViewContract
    staticPage?: Readonly<{
      slug?: string | null
      content?: string | null
    }> | null
  }>
  Archive: BaseHydrationPayload<'Archive'> & Readonly<{
    view?: ArchivePageViewContract
    total?: number
    articles?: ReadonlyArray<Readonly<{
      id: number
      title: string
      createTime?: string | null
    }>>
  }>
  Filter: BaseHydrationPayload<'Filter'> & Readonly<{
    filterType?: PublicFilterType | null
    filterKey?: string | null
    filterId?: number
    filterName?: string | null
    isInvalidTarget?: boolean
    view?: FilterPageViewContract
    filter?: Readonly<{
      filterType?: PublicFilterType | null
      filterKey?: string | null
      filterId?: number
      filterName?: string | null
      isInvalidTarget?: boolean
      pageIndex?: number
      pageSize?: number
      total?: number
      articles?: ReadonlyArray<Readonly<{
        id: number
        title: string
        summary?: string | null
        createTime?: string | null
      }>>
    }> | null
  }>
}

export type PublicHomeHydrationPayload = PublicHydrationPayloadByKind['Home']
export type PublicArticleDetailHydrationPayload = PublicHydrationPayloadByKind['ArticleDetail']
export type PublicPassiveHydrationPayload =
  | PublicHydrationPayloadByKind['About']
  | PublicHydrationPayloadByKind['Privacy']
  | PublicHydrationPayloadByKind['Guidelines']
  | PublicHydrationPayloadByKind['Copyright']
export type PublicArchiveHydrationPayload = PublicHydrationPayloadByKind['Archive']
export type PublicFilterHydrationPayload = PublicHydrationPayloadByKind['Filter']

export type PublicHydrationPayload = PublicHydrationPayloadByKind[PublicPageKind]

export type PublicHydrationPayloadFor<K extends PublicPageKind> = PublicHydrationPayloadByKind[K]

export type PublicRenderMetadata = Readonly<{
  rendererVersion: string
  templateHash?: string | null
  generatedAt?: string | null
}>
