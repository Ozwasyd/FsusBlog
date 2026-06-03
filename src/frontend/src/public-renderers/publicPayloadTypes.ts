import type { PublicHomeRouteKey } from '@/public-renderers/publicFixedPageSemantics'
import type { PublicFilterType } from '@/public-renderers/publicFilterSemantics'
import type { PublicPageKind } from '@/public-renderers/publicRenderBase'
import type { RelatedReadingResponse } from '@/api/article'
import type { AboutPageViewContract } from '@/view-contracts/aboutPage'
import type { ArchivePageViewContract } from '@/view-contracts/archive'
import type { ArticleDetailPageViewContract } from '@/view-contracts/articleDetail'
import type { ArticleListViewContract } from '@/view-contracts/articleList'
import type { FilterPageViewContract } from '@/view-contracts/filterView'

export type PublicAotBootstrapKind = PublicPageKind

export type BootstrapArticleSummary = Readonly<{
  id: number
  title: string
  summary?: string | null
  snippet?: string | null
  content?: string | null
  views?: number | null
  createTime: string
  category?: string | Readonly<{ id?: number | null; name?: string | null }> | null
  tags?: readonly string[] | null
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
  title?: string
  generatedAt?: string
}>

export type PublicAotBootstrapPayloadByKind = {
  Home: BaseBootstrapPayload<'Home'> & Readonly<{
    total: number
    articles: readonly BootstrapArticleSummary[]
  }>
  About: BaseBootstrapPayload<'About'> & Readonly<{
    bodyHtml?: string | null
    about?: Readonly<{
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
    article?: BootstrapArticleSummary
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
}>

export type PublicHydrationPayloadByKind = {
  Home: BaseHydrationPayload<'Home'> & Readonly<{
    routeKey: PublicHomeRouteKey
    currentPage: number
    pageSize: number
    total: number
    view: ArticleListViewContract
  }>
  ArticleDetail: BaseHydrationPayload<'ArticleDetail'> & Readonly<{
    articleId: number | string
    authorName?: string | null
    articleSummary?: string | null
    bodyContent?: string | null
    bodyHtml?: string | null
    detailView: ArticleDetailPageViewContract
    commentsIsland: Readonly<{
      articleId: number | string
    }>
  }>
  About: BaseHydrationPayload<'About'> & Readonly<{
    bodyHtml?: string | null
    view?: AboutPageViewContract
    about?: Readonly<{
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
export type PublicPassiveHydrationPayload = PublicHydrationPayloadByKind['About']
export type PublicArchiveHydrationPayload = PublicHydrationPayloadByKind['Archive']
export type PublicFilterHydrationPayload = PublicHydrationPayloadByKind['Filter']

export type PublicHydrationPayload = PublicHydrationPayloadByKind[PublicPageKind]

export type PublicHydrationPayloadFor<K extends PublicPageKind> = PublicHydrationPayloadByKind[K]

export type PublicRenderMetadata = Readonly<{
  rendererVersion: string
  templateHash?: string | null
  generatedAt?: string | null
}>
