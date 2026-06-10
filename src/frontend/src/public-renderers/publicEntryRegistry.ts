import {
  createArticleListCardViewContract,
  createArticleListViewContract
} from '@/view-contracts/articleList'
import { createArticleDetailPageViewContract, type ArticleDetailPageViewContract } from '@/view-contracts/articleDetail'
import type { RelatedReadingItemResponse, RelatedReadingResponse } from '@/api/article'
import { createAboutPageViewContract } from '@/view-contracts/aboutPage'
import { createArchivePageViewContract } from '@/view-contracts/archive'
import { createFilterPageViewContract } from '@/view-contracts/filterView'
import type { SiteComplianceConfigPublic } from '@/api/system'
import {
  createEntry,
  normalizeArticleDetail,
  normalizeArticleSummary,
  PUBLIC_RENDERER_VERSION,
  renderAotBodyHtml,
  renderShell,
  toNumber,
  toText,
  type PublicEntryBuildOptions,
  type RenderResult
} from '@/public-renderers/publicEntryCore'
import type { PublicAotPageAssembly } from '@/public-renderers/scaffold'
import {
  createPublicAboutPageAssembly,
  createPublicArchivePageAssembly,
  createPublicArticleDetailPageAssembly,
  createPublicFilterPageAssembly,
  createPublicHomePageAssembly
} from '@/public-renderers/pageAssemblies'
import {
  createPublicRenderBase,
  type PublicPageKind,
  type PublicRenderBase
} from '@/public-renderers/publicRenderBase'
import {
  getSharedPublicPageManifestEntry,
  PUBLIC_PAGE_MANIFEST
} from '@/public-renderers/generated/publicPageManifest'
import {
  getPublicFilterLabel,
  normalizePublicFilterType,
  shouldShowPublicFilterSearchSort,
  type PublicFilterType
} from '@/public-renderers/publicFilterSemantics'
import {
  buildPublicAboutRouteKey,
  buildPublicArchiveRouteKey,
  buildPublicArticleHref,
  buildPublicArticleRouteKey,
  buildPublicCopyrightRouteKey,
  buildPublicFilterRouteKey,
  buildPublicGuidelinesRouteKey,
  buildPublicHomeRouteKey,
  buildPublicPrivacyRouteKey
} from '@/public-renderers/publicRouteIdentity'
import { PUBLIC_SHELL_DEFAULTS } from '@/public-renderers/publicShellState'

export type PublicEntryBuilder = (options: PublicEntryBuildOptions) => Promise<RenderResult>

type PublicEntryCreateOptions = Parameters<typeof createEntry>[5]

type PublicEntryScope<K extends PublicPageKind = PublicPageKind> = Readonly<{
  kind: K
  routeKey: string
  siteTitle: string
  siteDescription: string
  compliance: SiteComplianceConfigPublic | null
  baseUrlInput: unknown
  baseUrlText: string
  baseModel: PublicRenderBase
  renderShell: (page: PublicAotPageAssembly) => Promise<string>
  createEntry: (
    html: string,
    bootstrap: Record<string, unknown>,
    hydration: Record<string, unknown>,
    options?: PublicEntryCreateOptions
  ) => RenderResult
}>

type PublicEntryDefinition<K extends PublicPageKind = PublicPageKind> = Readonly<{
  kind: K
  build: (createScope: (routeKey: string) => PublicEntryScope<K>, options: PublicEntryBuildOptions) => Promise<RenderResult>
}>

type DefinedPublicEntry<K extends PublicPageKind = PublicPageKind> = Readonly<{
  kind: K
  build: PublicEntryBuilder
}>

function normalizeComplianceConfig(value: unknown): SiteComplianceConfigPublic | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const source = value as Record<string, unknown>
  const text = (key: string): string => toText(source[key], '')
  const startYear = toNumber(source.copyrightStartYear, 0)

  return {
    enabled: Boolean(source.enabled),
    regionMode: text('regionMode') === 'mainland-cn' ? 'mainland-cn' : 'global',
    copyrightOwner: text('copyrightOwner'),
    copyrightStartYear: startYear > 0 ? startYear : null,
    copyrightText: text('copyrightText'),
    contentLicenseName: text('contentLicenseName'),
    contentLicenseUrl: text('contentLicenseUrl'),
    icpRecordNumber: text('icpRecordNumber'),
    icpRecordUrl: text('icpRecordUrl') || 'https://beian.miit.gov.cn/',
    policeRecordNumber: text('policeRecordNumber'),
    policeRecordUrl: text('policeRecordUrl') || 'https://beian.mps.gov.cn/',
    policeBadgeIconUrl: text('policeBadgeIconUrl'),
    operatorName: text('operatorName'),
    contactEmail: text('contactEmail')
  }
}

function createPublicEntryScope<K extends PublicPageKind>(kind: K, options: PublicEntryBuildOptions, routeKey: string): PublicEntryScope<K> {
  const siteTitle = toText(options.siteTitle, PUBLIC_SHELL_DEFAULTS.siteTitle)
  const siteDescription = toText(options.siteDescription, '')
  const compliance = normalizeComplianceConfig(options.compliance)
  const baseUrlInput = options.baseUrl
  const baseUrlText = toText(baseUrlInput, '')
  const baseModel = createPublicRenderBase(kind, routeKey, {
    rendererVersion: PUBLIC_RENDERER_VERSION,
    siteTitle,
    siteDescription,
    baseUrl: baseUrlInput,
    compliance
  })

  return {
    kind,
    routeKey,
    siteTitle,
    siteDescription,
    compliance,
    baseUrlInput,
    baseUrlText,
    baseModel,
    renderShell: async (page) => await renderShell(kind, siteTitle, page, compliance),
    createEntry: (html, bootstrap, hydration, entryOptions) => createEntry(kind, routeKey, html, bootstrap, hydration, {
      ...entryOptions,
      baseUrl: entryOptions?.baseUrl ?? baseUrlText
    })
  }
}

function definePublicEntry<K extends PublicPageKind>(definition: PublicEntryDefinition<K>): DefinedPublicEntry<K> {
  return {
    kind: definition.kind,
    build: async (options) => await definition.build((routeKey) => createPublicEntryScope(definition.kind, options, routeKey), options)
  }
}

function normalizeRelatedReading(value: unknown): RelatedReadingResponse {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const related = Array.isArray(source.related)
    ? source.related.map(normalizeRelatedReadingItem).filter((item): item is RelatedReadingItemResponse => item !== null)
    : []

  return {
    related,
    previous: normalizeRelatedReadingItem(source.previous),
    next: normalizeRelatedReadingItem(source.next)
  }
}

function normalizeRelatedReadingItem(value: unknown): RelatedReadingItemResponse | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const item = value as Record<string, unknown>
  const id = toNumber(item.id ?? item.Id)
  const title = toText(item.title ?? item.Title, '')
  if (id <= 0 || !title) {
    return null
  }

  return {
    id,
    title,
    summary: toText(item.summary ?? item.Summary, ''),
    createTime: toText(item.createTime ?? item.CreateTime, new Date(0).toISOString()),
    reason: toText(item.reason ?? item.Reason, '相关')
  }
}

const homeEntryDefinition = definePublicEntry({
  kind: 'Home',
  async build(createScope, options) {
    const response = options.response as Record<string, unknown> | undefined
    const items = Array.isArray(response?.items) ? response.items.map(normalizeArticleSummary) : []
    const currentPage = toNumber(options.page, 1)
    const pageSize = toNumber(options.size, 8)
    const total = toNumber(response?.total, items.length)
    const scope = createScope(buildPublicHomeRouteKey())
    const view = createArticleListViewContract({ items, total }, { currentPage, pageSize })
    const hydration = {
      ...scope.baseModel.hydrationBase,
      title: scope.siteTitle,
      currentPage,
      pageSize,
      total,
      view
    }
    const bootstrap = {
      ...scope.baseModel.bootstrapBase,
      pageIndex: currentPage,
      pageSize,
      total,
      articles: items
    }
    const html = await scope.renderShell(createPublicHomePageAssembly({
      siteTitleText: scope.siteTitle,
      siteDescriptionText: scope.siteDescription,
      view
    }))
    return scope.createEntry(html, bootstrap, hydration, {
      title: scope.siteTitle
    })
  }
})

const articleDetailEntryDefinition = definePublicEntry({
  kind: 'ArticleDetail',
  async build(createScope, options) {
    const article = normalizeArticleDetail(options)
    const articleId = article.id
    const scope = createScope(buildPublicArticleRouteKey(articleId))
    const authorName = toText(options.authorName, scope.siteTitle)
    const relatedReading = normalizeRelatedReading(options.relatedReading)
    const detailView: ArticleDetailPageViewContract = createArticleDetailPageViewContract(article, 0, false, relatedReading)
    const bodyHtml = await renderAotBodyHtml(article.content, scope.baseUrlText || null)
    const hydration = {
      ...scope.baseModel.hydrationBase,
      articleId,
      title: article.title,
      authorName,
      articleSummary: article.summary,
      bodyContent: article.content,
      bodyHtml,
      detailView,
      commentsIsland: { articleId }
    }
    const bootstrap = {
      ...scope.baseModel.bootstrapBase,
      article,
      relatedReading,
      commentsPlaceholder: ''
    }
    const islands = { comments: { articleId } }
    const html = await scope.renderShell(createPublicArticleDetailPageAssembly({
      detailView,
      articleId,
      authorName,
      articleSummary: article.summary,
      canonicalUrl: scope.baseUrlInput
        ? `${String(scope.baseUrlInput).replace(/\/+$/u, '')}${buildPublicArticleHref(articleId)}`
        : null,
      hasBodyContent: article.content.trim().length > 0,
      bodyContent: article.content,
      bodyHtml
    }))
    return scope.createEntry(html, bootstrap, hydration, {
      articleId,
      islands,
      title: article.title
    })
  }
})

function createStaticPageEntryDefinition<K extends Extract<PublicPageKind, 'About' | 'Privacy' | 'Guidelines' | 'Copyright'>>(
  kind: K,
  buildRouteKey: () => string,
  defaultTitle: string
): DefinedPublicEntry<K> {
  return definePublicEntry({
    kind,
    async build(createScope, options) {
      const scope = createScope(buildRouteKey())
      const content = toText(options.content, '')
      const title = toText(options.title, defaultTitle)
      const slug = toText(options.slug, getSharedPublicPageManifestEntry(kind).canonicalSlug)
      const view = createAboutPageViewContract({
        siteTitle: scope.siteTitle,
        currentYear: new Date().getFullYear(),
        content,
        title
      })
      const bodyHtml = await renderAotBodyHtml(content, scope.baseUrlText)
      const staticPage = {
        slug,
        content
      }
      const hydration = {
        ...scope.baseModel.hydrationBase,
        title,
        bodyHtml,
        view,
        staticPage
      }
      const bootstrap = {
        ...scope.baseModel.bootstrapBase,
        title: hydration.title,
        bodyHtml,
        staticPage
      }
      const html = await scope.renderShell(createPublicAboutPageAssembly({
        view,
        content,
        bodyHtml,
        baseUrl: scope.baseUrlText
      }))
      return scope.createEntry(html, bootstrap, hydration, {
        title: hydration.title
      })
    }
  })
}

const aboutEntryDefinition = createStaticPageEntryDefinition('About', buildPublicAboutRouteKey, '关于')
const privacyEntryDefinition = createStaticPageEntryDefinition('Privacy', buildPublicPrivacyRouteKey, '隐私政策')
const guidelinesEntryDefinition = createStaticPageEntryDefinition('Guidelines', buildPublicGuidelinesRouteKey, '用户守则')
const copyrightEntryDefinition = createStaticPageEntryDefinition('Copyright', buildPublicCopyrightRouteKey, '版权声明')

const archiveEntryDefinition = definePublicEntry({
  kind: 'Archive',
  async build(createScope, options) {
    const scope = createScope(buildPublicArchiveRouteKey())
    const articles = Array.isArray(options.articles) ? options.articles.map(normalizeArticleSummary) : []
    const total = toNumber(options.total, articles.length)
    const view = createArchivePageViewContract(articles, total)
    const hydration = {
      ...scope.baseModel.hydrationBase,
      title: toText(options.title, '归档'),
      total,
      articles,
      view
    }
    const bootstrap = {
      ...scope.baseModel.bootstrapBase,
      total,
      articles
    }
    const html = await scope.renderShell(createPublicArchivePageAssembly({
      view
    }))
    return scope.createEntry(html, bootstrap, hydration, {
      title: hydration.title
    })
  }
})

const filterEntryDefinition = definePublicEntry({
  kind: 'Filter',
  async build(createScope, options) {
    const filterType: PublicFilterType = normalizePublicFilterType(options.filterType)
    const filterName = toText(options.filterName, '')
    const scope = createScope(buildPublicFilterRouteKey({
      routeKey: options.routeKey,
      filterType,
      filterKey: options.filterKey,
      filterId: options.filterId,
      filterName
    }))
    const title = toText(options.title, filterName || '筛选')
    const pageIndex = toNumber(options.pageIndex, 1)
    const pageSize = toNumber(options.pageSize, 10)
    const total = toNumber(options.total, 0)
    const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
    const articles = Array.isArray(options.articles) ? options.articles.map(normalizeArticleSummary) : []
    const cards = articles.map((article, index) => createArticleListCardViewContract(article, index))
    const isInvalidTarget = Boolean(options.isInvalidTarget)
    const view = createFilterPageViewContract({
      labelText: getPublicFilterLabel(filterType),
      currentName: title,
      loadingMeta: false,
      loadingArticles: false,
      isPowCalculating: false,
      hasError: false,
      isInvalidTarget,
      articles: cards,
      currentPage: pageIndex,
      totalPages,
      pageIndicatorText: `${pageIndex} / ${totalPages}`,
      canGoPrev: pageIndex > 1,
      canGoNext: pageIndex < totalPages
    })
    const filter = {
      filterType,
      filterKey: toText(options.filterKey, scope.routeKey),
      filterId: toNumber(options.filterId),
      filterName,
      isInvalidTarget,
      pageIndex,
      pageSize,
      total,
      articles
    }
    const hydration = {
      ...scope.baseModel.hydrationBase,
      title,
      filterType,
      filterKey: filter.filterKey,
      filterId: filter.filterId,
      filterName,
      isInvalidTarget,
      view,
      filter
    }
    const bootstrap = {
      ...scope.baseModel.bootstrapBase,
      title,
      filterType,
      filterKey: filter.filterKey,
      filterId: filter.filterId,
      filterName,
      isInvalidTarget,
      filter
    }
    const html = await scope.renderShell(createPublicFilterPageAssembly({
      view,
      invalidTarget: isInvalidTarget,
      showSearchSort: shouldShowPublicFilterSearchSort(filterType)
    }))
    return scope.createEntry(html, bootstrap, hydration, {
      title
    })
  }
})

const PUBLIC_ENTRY_DEFINITIONS = [
  homeEntryDefinition,
  articleDetailEntryDefinition,
  aboutEntryDefinition,
  privacyEntryDefinition,
  guidelinesEntryDefinition,
  copyrightEntryDefinition,
  archiveEntryDefinition,
  filterEntryDefinition
] as const satisfies readonly DefinedPublicEntry[]

const PUBLIC_ENTRY_BUILDERS = Object.freeze(
  Object.fromEntries(
    PUBLIC_ENTRY_DEFINITIONS.map((definition) => [definition.kind, definition.build])
  ) as Record<PublicPageKind, PublicEntryBuilder>
)

const SHARED_SEO_ENTRY_KINDS = Object.freeze(
  Object.values(PUBLIC_PAGE_MANIFEST)
    .filter((definition) => definition.seoEligible)
    .map((definition) => definition.kind)
) as readonly PublicPageKind[]

const missingEntryBuilders = SHARED_SEO_ENTRY_KINDS.filter((kind) => !(kind in PUBLIC_ENTRY_BUILDERS))
if (missingEntryBuilders.length > 0) {
  throw new Error(`publicEntryRegistry is missing builders for shared SEO pages: ${missingEntryBuilders.join(', ')}`)
}

export const renderPublicHomeEntry = homeEntryDefinition.build
export const renderPublicArticleDetailEntry = articleDetailEntryDefinition.build
export const renderPublicAboutEntry = aboutEntryDefinition.build
export const renderPublicPrivacyEntry = privacyEntryDefinition.build
export const renderPublicGuidelinesEntry = guidelinesEntryDefinition.build
export const renderPublicCopyrightEntry = copyrightEntryDefinition.build
export const renderPublicArchiveEntry = archiveEntryDefinition.build
export const renderPublicFilterEntry = filterEntryDefinition.build

export async function buildPublicEntry(pageKind: PublicPageKind, options: PublicEntryBuildOptions): Promise<RenderResult> {
  return await PUBLIC_ENTRY_BUILDERS[pageKind](options)
}
