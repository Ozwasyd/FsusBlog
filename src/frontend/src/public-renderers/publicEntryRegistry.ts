import type { FeaturedArticleItem, PopularArticleSummaryResponse, RelatedReadingItemResponse, RelatedReadingResponse } from '@/api/article';
import type { SiteComplianceConfigPublic } from '@/api/system';
import { isSupportedLocale, prepareLocaleDomains, type SupportedLocale } from '@/locales';
import { LOCALE_CATALOG_DIGEST } from '@/locales/localeCatalog';
import {
    getSharedPublicPageManifestEntry,
    PUBLIC_PAGE_MANIFEST
} from '@/public-renderers/generated/publicPageManifest';
import {
  createPublicAboutPageAssembly,
  createPublicArchivePageAssembly,
  createPublicArticleDetailPageAssembly,
  createPublicFilterPageAssembly,
  createPublicHomePageAssembly
} from '@/public-renderers/pageAssemblies'
import {
  createEntry,
  normalizeArticleDetail,
  normalizeArticleSummary,
  PUBLIC_RENDERER_VERSION,
  renderAotMarkdown,
  renderShell,
  toNumber,
  toText,
  type PublicEntryBuildOptions,
  type RenderResult
} from '@/public-renderers/publicEntryCore'
import type { PublicAotPageAssembly } from '@/public-renderers/scaffold'
import {
    createPublicRenderBase,
    type PublicPageKind,
    type PublicRenderBase
} from '@/public-renderers/publicRenderBase';
import {
    getPublicFilterLabel,
    normalizePublicFilterType,
    shouldShowPublicFilterSearchSort,
    type PublicFilterType
} from '@/public-renderers/publicFilterSemantics';
import {
    buildPublicAboutRouteKey,
    buildPublicArchiveRouteKey,
    buildPublicArticleHref,
    buildPublicArticleRouteKey,
    buildPublicCopyrightRouteKey,
    buildPublicFilterRouteKey,
    buildPublicGuidelinesRouteKey,
    buildPublicHomeRouteKey,
    buildPublicHomePaginationHref,
    buildPublicRoutePaginationHref,
    buildPublicPrivacyRouteKey
} from '@/public-renderers/publicRouteIdentity';
import {
    createAuthoritativePublicRenderClock,
    createPublicLocaleContext,
    createPublicRenderTimeOptions,
    type PublicRenderClock
} from '@/public-renderers/publicRenderClock';
import {
    normalizePublicComplianceConfig,
    normalizePublicSiteDescription,
    normalizePublicSiteTitle
} from '@/public-renderers/publicSiteIdentity';
import type { TimeRenderOptions } from '@/utils/time';
import { requiredLocaleDomainsForPublicPage } from '@/locales/routeLocaleDomains';
import { createAboutPageViewContract } from '@/view-contracts/aboutPage';
import { createArchivePageViewContract } from '@/view-contracts/archive';
import { createArticleDetailPageViewContract, type ArticleDetailPageViewContract } from '@/view-contracts/articleDetail';
import {
    createArticleListCardViewContract,
    createArticleListViewContract
} from '@/view-contracts/articleList';
import { normalizeArticleResponsibilityPublicView } from '@/view-contracts/articleResponsibility';
import { createFilterPageViewContract } from '@/view-contracts/filterView';

export type PublicEntryBuilder = (options: PublicEntryBuildOptions) => Promise<RenderResult>;

type PublicEntryCreateOptions = Parameters<typeof createEntry>[5];

type PublicEntryScope<K extends PublicPageKind = PublicPageKind> = Readonly<{
    kind: K;
    routeKey: string;
    siteTitle: string;
    siteDescription: string;
    siteLogoUrl: string;
    siteLogoDarkUrl: string;
    siteWordmarkUrl: string;
    loginLogoUrl: string;
    loginIconUrl: string;
    compliance: SiteComplianceConfigPublic | null;
    baseUrlInput: unknown;
    baseUrlText: string;
    renderClock: PublicRenderClock;
    renderTimeOptions: TimeRenderOptions;
    renderLocale: SupportedLocale;
    localeCatalogDigest: string;
    baseModel: PublicRenderBase;
    renderShell: (page: PublicAotPageAssembly) => Promise<string>;
    createEntry: (
        html: string,
        bootstrap: Record<string, unknown>,
        hydration: Record<string, unknown>,
        options?: PublicEntryCreateOptions
    ) => RenderResult;
}>;

type PublicEntryDefinition<K extends PublicPageKind = PublicPageKind> = Readonly<{
    kind: K;
    build: (createScope: (routeKey: string) => PublicEntryScope<K>, options: PublicEntryBuildOptions) => Promise<RenderResult>;
}>;

type DefinedPublicEntry<K extends PublicPageKind = PublicPageKind> = Readonly<{
    kind: K;
    build: PublicEntryBuilder;
}>;

function asRecord(value: unknown): Record<string, unknown> | null
{
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function requireArray(value: unknown, fieldName: string): unknown[]
{
    if (!Array.isArray(value))
    {
        throw new Error(`public_aot_payload_missing_array:${fieldName}`);
    }

    return value;
}

function createPublicEntryScope<K extends PublicPageKind>(kind: K, options: PublicEntryBuildOptions, routeKey: string): PublicEntryScope<K>
{
    const siteTitle = normalizePublicSiteTitle(options.siteTitle);
    const siteDescription = normalizePublicSiteDescription(options.siteDescription);
    const siteLogoUrl = toText(options.siteLogoUrl, '');
    const siteLogoDarkUrl = toText(options.siteLogoDarkUrl, '');
    const siteWordmarkUrl = toText(options.siteWordmarkUrl, '');
    const loginLogoUrl = toText(options.loginLogoUrl, '');
    const loginIconUrl = toText(options.loginIconUrl, '');
    const compliance = normalizePublicComplianceConfig(options.compliance);
    const baseUrlInput = options.baseUrl;
    const baseUrlText = toText(baseUrlInput, '');
    const renderClock = createAuthoritativePublicRenderClock(options.renderTimestamp);
    if (!renderClock)
    {
        throw new Error('public_aot_render_timestamp_invalid');
    }
    const localeContext = createPublicLocaleContext({
        locale: toText(options.renderLocale ?? options.locale, ''),
        timeZone: toText(options.renderDisplayTimeZone ?? options.timeZone, '')
    });
    if (!isSupportedLocale(localeContext.locale))
    {
        throw new Error(`public_aot_render_locale_invalid:${localeContext.locale}`);
    }
    const renderLocale = localeContext.locale;
    const localeCatalogDigest = toText(options.localeCatalogDigest, '');
    const renderTimeOptions = createPublicRenderTimeOptions(renderClock, localeContext);
    const baseModel = createPublicRenderBase(kind, routeKey, {
        rendererVersion: PUBLIC_RENDERER_VERSION,
        siteTitle,
        siteDescription,
        baseUrl: baseUrlInput,
        siteLogoUrl,
        siteLogoDarkUrl,
        siteWordmarkUrl,
        loginLogoUrl,
        loginIconUrl,
        compliance,
        renderClock,
        renderLocale,
        localeCatalogDigest
    });

    return {
        kind,
        routeKey,
        siteTitle,
        siteDescription,
        siteLogoUrl,
        siteLogoDarkUrl,
        siteWordmarkUrl,
        loginLogoUrl,
        loginIconUrl,
        compliance,
        baseUrlInput,
        baseUrlText,
        renderClock,
        renderTimeOptions,
        renderLocale,
        localeCatalogDigest,
        baseModel,
        renderShell: async (page) => await renderShell(kind, siteTitle, page, compliance, {
            siteDescription,
            siteLogoUrl,
            siteLogoDarkUrl,
            siteWordmarkUrl,
            renderYear: renderClock.renderYear,
            renderLocale
        }),
        createEntry: (html, bootstrap, hydration, entryOptions) => createEntry(kind, routeKey, html, bootstrap, hydration, {
            ...entryOptions,
            baseUrl: entryOptions?.baseUrl ?? baseUrlText
        })
    };
}

function definePublicEntry<K extends PublicPageKind>(definition: PublicEntryDefinition<K>): DefinedPublicEntry<K>
{
    return {
        kind: definition.kind,
        build: async (options) => await definition.build((routeKey) => createPublicEntryScope(definition.kind, options, routeKey), options)
    };
}

function normalizeRelatedReading(value: unknown): RelatedReadingResponse
{
    const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const related = Array.isArray(source.related)
        ? source.related.map(normalizeRelatedReadingItem).filter((item): item is RelatedReadingItemResponse => item !== null)
        : [];

    return {
        related,
        previous: normalizeRelatedReadingItem(source.previous),
        next: normalizeRelatedReadingItem(source.next)
    };
}

function normalizeRelatedReadingItem(value: unknown): RelatedReadingItemResponse | null
{
    if (!value || typeof value !== 'object')
    {
        return null;
    }

    const item = value as Record<string, unknown>;
    const id = toNumber(item.id ?? item.Id);
    const title = toText(item.title ?? item.Title, '');
    if (id <= 0 || !title)
    {
        return null;
    }

    return {
        id,
        title,
        summary: toText(item.summary ?? item.Summary, ''),
        createTime: toText(item.createTime ?? item.CreateTime, new Date(0).toISOString()),
        reason: toText(item.reason ?? item.Reason, '相关')
    };
}

function normalizeFeaturedArticle(value: unknown): FeaturedArticleItem | null
{
    if (!value || typeof value !== 'object')
    {
        return null;
    }

    const item = value as Record<string, unknown>;
    const category = item.category && typeof item.category === 'object'
        ? item.category as Record<string, unknown>
        : {
        id: item.categoryId,
        name: item.categoryName
      };
    const id = toNumber(item.id ?? item.Id);
    const title = toText(item.title ?? item.Title, '');
    const coverImageUrl = toText(item.coverImageUrl ?? item.CoverImageUrl, '');
    if (id <= 0 || !title || !coverImageUrl)
    {
        return null;
    }

    return {
        id,
        title,
        coverImageUrl,
        views: toNumber(item.views ?? item.Views),
        createTime: toText(item.createTime ?? item.CreateTime, new Date(0).toISOString()),
        category: {
            id: toNumber(category.id ?? category.Id),
            name: toText(category.name ?? category.Name, 'Uncategorized')
        }
    };
}

function normalizeHotArticle(value: unknown): PopularArticleSummaryResponse | null
{
    if (!value || typeof value !== 'object')
    {
        return null;
    }

    const item = value as Record<string, unknown>;
    const id = toNumber(item.id ?? item.Id);
    const title = toText(item.title ?? item.Title, '');
    if (id <= 0 || !title)
    {
        return null;
    }

    return {
        id,
        title,
        views: toNumber(item.views ?? item.Views)
    };
}

const homeEntryDefinition = definePublicEntry({
    kind: 'Home',
    async build(createScope, options)
    {
        const items = requireArray(options.articles, 'Home.articles').map(normalizeArticleSummary);
        const featuredArticles = requireArray(options.featuredArticles, 'Home.featuredArticles')
            .map(normalizeFeaturedArticle)
            .filter((item): item is FeaturedArticleItem => item !== null);
        const hotArticles = requireArray(options.hotArticles, 'Home.hotArticles')
            .map(normalizeHotArticle)
            .filter((item): item is PopularArticleSummaryResponse => item !== null);
        const currentPage = toNumber(options.pageIndex ?? options.page, 1);
        const pageSize = toNumber(options.pageSize ?? options.size, 8);
        const total = toNumber(options.total, items.length);
        const scope = createScope(toText(options.routeKey, buildPublicHomeRouteKey()));
        const view = createArticleListViewContract({ items, total }, {
            currentPage,
            pageSize,
            pageHref: buildPublicHomePaginationHref,
            time: scope.renderTimeOptions
        });
        const hydration = {
            ...scope.baseModel.hydrationBase,
            title: scope.siteTitle,
            currentPage,
            pageSize,
            total,
            view,
            featuredArticles,
            hotArticles
        };
        const bootstrap = {
            ...scope.baseModel.bootstrapBase,
            pageIndex: currentPage,
            pageSize,
            total,
            articles: items,
            featuredArticles,
            hotArticles
        };
        const html = await scope.renderShell(createPublicHomePageAssembly({
            view,
            featuredArticles,
            hotArticles
        }));
        return scope.createEntry(html, bootstrap, hydration, {
            title: scope.siteTitle
        });
    }
});

const articleDetailEntryDefinition = definePublicEntry({
    kind: 'ArticleDetail',
    async build(createScope, options)
    {
        const article = normalizeArticleDetail(options);
        const articleId = article.id;
        const scope = createScope(buildPublicArticleRouteKey(articleId));
        const authorName = toText(options.authorName, scope.siteTitle);
        const responsibilityAuthors = normalizeResponsibilityAuthors(options.authors, authorName);
        const responsibilityManifest = normalizeArticleResponsibilityPublicView(options.responsibility);
        const relatedReading = normalizeRelatedReading(options.relatedReading);
        const detailView: ArticleDetailPageViewContract = createArticleDetailPageViewContract(
            article,
            0,
            false,
            relatedReading,
            scope.renderTimeOptions
        );
        const initialRender = await renderAotMarkdown(article.content, scope.baseUrlText || null);
        const hydration = {
            ...scope.baseModel.hydrationBase,
            articleId,
            title: article.title,
            authorName,
            responsibilityAuthors,
            responsibilityManifest,
            articleSummary: article.summary,
            bodyContent: article.content,
            rights: article.rights,
            detailView,
            commentsIsland: { articleId }
        };
        const bootstrap = {
            ...scope.baseModel.bootstrapBase,
            article,
            relatedReading,
            commentsPlaceholder: ''
        };
        const html = await scope.renderShell(createPublicArticleDetailPageAssembly({
            detailView,
            articleId,
            authorName,
            responsibilityAuthors,
            responsibilityManifest,
            articleSummary: article.summary,
            canonicalUrl: scope.baseUrlInput
                ? `${String(scope.baseUrlInput).replace(/\/+$/u, '')}${buildPublicArticleHref(articleId)}`
                : null,
            baseUrl: scope.baseUrlText || null,
            hasBodyContent: article.content.trim().length > 0,
            bodyContent: article.content,
            initialRender
        }));
        return scope.createEntry(html, bootstrap, hydration, {
            articleId,
            title: article.title
        });
    }
});

function normalizeResponsibilityAuthors(value: unknown, fallbackAuthor: string): readonly Readonly<{ name: string; profileUrl: string | null; }>[]
{
    if (!Array.isArray(value))
    {
        return [{ name: fallbackAuthor, profileUrl: null }];
    }
    const authors = value.flatMap((item) =>
    {
        if (!item || typeof item !== 'object')
        {
            return [];
        }
        const record = item as Record<string, unknown>;
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        if (!name)
        {
            return [];
        }
        const profileUrl = typeof record.profileUrl === 'string' && /^https?:\/\//iu.test(record.profileUrl)
            ? record.profileUrl
            : null;
        return [{ name, profileUrl }];
    });
    return authors.length > 0 ? authors.slice(0, 8) : [{ name: fallbackAuthor, profileUrl: null }];
}

function createStaticPageEntryDefinition<K extends Extract<PublicPageKind, 'About' | 'Privacy' | 'Guidelines' | 'Copyright'>>(
    kind: K,
    buildRouteKey: () => string,
    defaultTitle: string
): DefinedPublicEntry<K>
{
    return definePublicEntry({
        kind,
        async build(createScope, options)
        {
            const scope = createScope(buildRouteKey());
            const content = toText(options.content, '');
            const title = toText(options.title, defaultTitle);
            const slug = toText(options.slug, getSharedPublicPageManifestEntry(kind).canonicalSlug);
            const view = createAboutPageViewContract({
                currentYear: scope.renderClock.renderYear,
                content,
                title
            });
            const initialRender = await renderAotMarkdown(content, scope.baseUrlText, 'about');
            const staticPage = {
                slug,
                content
            };
            const hydration = {
                ...scope.baseModel.hydrationBase,
                title,
                view,
                staticPage
            };
            const bootstrap = {
                ...scope.baseModel.bootstrapBase,
                title: hydration.title,
                staticPage
            };
            const html = await scope.renderShell(createPublicAboutPageAssembly({
                view,
                content,
                initialRender,
                baseUrl: scope.baseUrlText
            }));
            return scope.createEntry(html, bootstrap, hydration, {
                title: hydration.title
            });
        }
    });
}

const aboutEntryDefinition = createStaticPageEntryDefinition('About', buildPublicAboutRouteKey, '关于');
const privacyEntryDefinition = createStaticPageEntryDefinition('Privacy', buildPublicPrivacyRouteKey, '隐私政策');
const guidelinesEntryDefinition = createStaticPageEntryDefinition('Guidelines', buildPublicGuidelinesRouteKey, '用户守则');
const copyrightEntryDefinition = createStaticPageEntryDefinition('Copyright', buildPublicCopyrightRouteKey, '版权声明');

const archiveEntryDefinition = definePublicEntry({
    kind: 'Archive',
    async build(createScope, options)
    {
        const scope = createScope(buildPublicArchiveRouteKey());
        const articles = Array.isArray(options.articles) ? options.articles.map(normalizeArticleSummary) : [];
        const total = toNumber(options.total, articles.length);
        const view = createArchivePageViewContract(articles, total, scope.renderTimeOptions);
        const hydration = {
            ...scope.baseModel.hydrationBase,
            title: toText(options.title, '归档'),
            total,
            articles,
            view
        };
        const bootstrap = {
            ...scope.baseModel.bootstrapBase,
            total,
            articles
        };
        const html = await scope.renderShell(createPublicArchivePageAssembly({
            view
        }));
        return scope.createEntry(html, bootstrap, hydration, {
            title: hydration.title
        });
    }
});

const filterEntryDefinition = definePublicEntry({
    kind: 'Filter',
    async build(createScope, options)
    {
        const filterInput = asRecord(options.filter) ?? options;
        const filterType: PublicFilterType = normalizePublicFilterType(filterInput.filterType);
        const filterName = toText(filterInput.filterName, '');
        const scope = createScope(buildPublicFilterRouteKey({
            routeKey: options.routeKey,
            filterType,
            filterKey: filterInput.filterKey,
            filterId: filterInput.filterId,
            filterName
        }));
        const title = toText(options.title, filterName || '筛选');
        const pageIndex = toNumber(filterInput.pageIndex, 1);
        const pageSize = toNumber(filterInput.pageSize, 10);
        const total = toNumber(filterInput.total, 0);
        const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
        const articles = Array.isArray(filterInput.articles) ? filterInput.articles.map(normalizeArticleSummary) : [];
        const cards = articles.map((article, index) => createArticleListCardViewContract(article, index, scope.renderTimeOptions));
        const isInvalidTarget = Boolean(filterInput.isInvalidTarget);
        const view = createFilterPageViewContract({
            filterType,
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
            canGoNext: pageIndex < totalPages,
            previousHref: buildPublicRoutePaginationHref(scope.routeKey, Math.max(1, pageIndex - 1)),
            nextHref: buildPublicRoutePaginationHref(scope.routeKey, Math.min(totalPages, pageIndex + 1))
        });
        const filter = {
            filterType,
            filterKey: toText(filterInput.filterKey, scope.routeKey),
            filterId: toNumber(filterInput.filterId),
            filterName,
            isInvalidTarget,
            pageIndex,
            pageSize,
            total,
            articles
        };
        const hydration = {
            ...scope.baseModel.hydrationBase,
            title,
            view,
            filter
        };
        const bootstrap = {
            ...scope.baseModel.bootstrapBase,
            title,
            filter
        };
        const html = await scope.renderShell(createPublicFilterPageAssembly({
            view,
            invalidTarget: isInvalidTarget,
            showSearchSort: shouldShowPublicFilterSearchSort(filterType)
        }));
        return scope.createEntry(html, bootstrap, hydration, {
            title
        });
    }
});

const PUBLIC_ENTRY_DEFINITIONS = [
    homeEntryDefinition,
    articleDetailEntryDefinition,
    aboutEntryDefinition,
    privacyEntryDefinition,
    guidelinesEntryDefinition,
    copyrightEntryDefinition,
    archiveEntryDefinition,
    filterEntryDefinition
] as const satisfies readonly DefinedPublicEntry[];

const PUBLIC_ENTRY_BUILDERS = Object.freeze(
    Object.fromEntries(
        PUBLIC_ENTRY_DEFINITIONS.map((definition) => [definition.kind, definition.build])
    ) as Record<PublicPageKind, PublicEntryBuilder>
);

const SHARED_SEO_ENTRY_KINDS = Object.freeze(
    Object.values(PUBLIC_PAGE_MANIFEST)
        .filter((definition) => definition.seoEligible)
        .map((definition) => definition.kind)
) as readonly PublicPageKind[];

const missingEntryBuilders = SHARED_SEO_ENTRY_KINDS.filter((kind) => !(kind in PUBLIC_ENTRY_BUILDERS));
if (missingEntryBuilders.length > 0)
{
    throw new Error(`publicEntryRegistry is missing builders for shared SEO pages: ${missingEntryBuilders.join(', ')}`);
}

export const renderPublicHomeEntry = homeEntryDefinition.build;
export const renderPublicArticleDetailEntry = articleDetailEntryDefinition.build;
export const renderPublicAboutEntry = aboutEntryDefinition.build;
export const renderPublicPrivacyEntry = privacyEntryDefinition.build;
export const renderPublicGuidelinesEntry = guidelinesEntryDefinition.build;
export const renderPublicCopyrightEntry = copyrightEntryDefinition.build;
export const renderPublicArchiveEntry = archiveEntryDefinition.build;
export const renderPublicFilterEntry = filterEntryDefinition.build;

export async function buildPublicEntry(pageKind: PublicPageKind, options: PublicEntryBuildOptions): Promise<RenderResult>
{
    if (!isSupportedLocale(options.renderLocale))
    {
        throw new Error('public_aot_render_locale_missing');
    }
    if (options.localeCatalogDigest !== LOCALE_CATALOG_DIGEST)
    {
        throw new Error('public_aot_locale_catalog_digest_mismatch');
    }
    await prepareLocaleDomains(
        options.renderLocale,
        requiredLocaleDomainsForPublicPage(pageKind)
    );
    return await PUBLIC_ENTRY_BUILDERS[pageKind](options);
}
