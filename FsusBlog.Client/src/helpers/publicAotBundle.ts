import { getArticles, type PageResponse, type ArticleListItemResponse, type Tag } from '@/api/article';
import {
  PUBLIC_RENDERER_VERSION,
  renderPublicAboutBundle,
  renderPublicArchiveBundle,
  renderPublicArticleDetailBundle,
  renderPublicFilterBundle,
  renderPublicHomeBundle,
  type PublicArchiveHydrationPayload,
  type PublicArticleDetailHydrationPayload,
  type PublicFilterHydrationPayload,
  type PublicHomeHydrationPayload
} from '@/public-renderers';
import { createArticleDetailPageViewContract } from '@/view-contracts/articleDetail';
import { createArticleListViewContract } from '@/view-contracts/articleList';
import { renderPublicMarkdownHtml } from '@/helpers/publicMarkdown';
import { AppErrorCode, createAppError } from '@/utils/appError';

export type PublicAotShellPageId = 1 | 2 | 3 | 4 | 5;

export interface PublicAotShellEntryContract {
  pageId: PublicAotShellPageId;
  routeKey: string;
  html: string;
  articleId?: number | null;
  bootstrapJson?: string | null;
  hydrationPropsJson?: string | null;
  rendererVersion?: string | null;
  islandsJson?: string | null;
  title?: string | null;
  baseUrl?: string | null;
}

export interface PublicAotShellBundleContract {
  entries: PublicAotShellEntryContract[];
  generatedAtUtc: string;
}

export interface ArticleDetailPublicAotBundleOptions {
  articleId: number | null;
  title: string;
  content: string;
  summary: string;
  authorName?: string | null;
  createTime?: string;
  categoryId?: number | null;
  categoryName?: string | null;
  tags?: readonly Tag[];
  siteTitle?: string;
  siteDescription?: string;
  baseUrl?: string;
}
export interface AboutPublicAotBundleOptions {
  content: string;
  slug?: string;
  siteTitle?: string;
  siteDescription?: string;
  baseUrl?: string;
  title?: string;
}
export interface ArchivePublicAotBundleOptions {
  articles: Array<{
    id: number;
    title: string;
    createTime?: string;
  }>;
  siteTitle?: string;
  siteDescription?: string;
  baseUrl?: string;
  title?: string;
}
export interface FilterPublicAotBundleOptions {
  routeKey: string;
  pageIndex: number;
  pageSize: number;
  total: number;
  articles: Array<{
    id: number;
    title: string;
    summary?: string;
    createTime?: string;
  }>;
  siteTitle?: string;
  siteDescription?: string;
  baseUrl?: string;
  title?: string;
}

function buildReadingMetrics(content: string | null | undefined): { wordCount: number; estimatedReadingMinutes: number; showReadingNotice: boolean } {
  const normalized = (content ?? '').replace(/\s+/g, '');
  const wordCount = normalized.length;
  return {
    wordCount,
    estimatedReadingMinutes: Math.max(1, Math.ceil(wordCount / 300)),
    showReadingNotice: wordCount > 5000
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw createAppError(AppErrorCode.InvariantViolation, message);
  }
}

function parseJsonRecord(input: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(input);
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${label} must be an object`);
  return parsed as Record<string, unknown>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertStringField(record: Record<string, unknown>, key: string, expected: string, label: string): void {
  const actual = record[key];
  assert(typeof actual === 'string', `${label}.${key} must be a string`);
  assert(actual === expected, `${label}.${key} mismatch: expected ${expected}, got ${actual}`);
}

function assertNumberField(record: Record<string, unknown>, key: string, expected: number, label: string): void {
  const actual = record[key];
  if (typeof actual === 'number') {
    assert(actual === expected, `${label}.${key} mismatch: expected ${expected}, got ${actual}`);
    return;
  }

  if (typeof actual === 'string') {
    const parsed = Number(actual);
    assert(Number.isFinite(parsed), `${label}.${key} must be numeric`);
    assert(parsed === expected, `${label}.${key} mismatch: expected ${expected}, got ${actual}`);
    return;
  }

  assert(false, `${label}.${key} must be numeric`);
}

function assertOptionalNullish(record: Record<string, unknown>, key: string, label: string): void {
  const actual = record[key];
  assert(actual === undefined || actual === null, `${label}.${key} must be empty`);
}

function validatePublicAotShellEntry(entry: PublicAotShellEntryContract): void {
  assert(typeof entry.rendererVersion === 'string' && entry.rendererVersion.length > 0, 'rendererVersion is required');
  const rendererVersion = entry.rendererVersion.trim();
  assert(rendererVersion.startsWith('public-vue-renderer@'), `rendererVersion is invalid: ${rendererVersion}`);
  assert(entry.bootstrapJson && entry.hydrationPropsJson, 'bootstrapJson and hydrationPropsJson are required');

  const bootstrap = parseJsonRecord(entry.bootstrapJson, 'bootstrapJson');
  const hydration = parseJsonRecord(entry.hydrationPropsJson, 'hydrationPropsJson');

  assertStringField(bootstrap, 'rendererVersion', rendererVersion, 'bootstrapJson');
  assertStringField(hydration, 'rendererVersion', rendererVersion, 'hydrationPropsJson');

  const validator = entryValidators[entry.pageId];
  if (!validator) {
    throw createAppError(AppErrorCode.InvariantViolation, `Unsupported public AOT pageId: ${String(entry.pageId)}`);
  }

  validator(entry, bootstrap, hydration);
}

type EntryValidator = (
  entry: PublicAotShellEntryContract,
  bootstrap: Record<string, unknown>,
  hydration: Record<string, unknown>
) => void;

const entryValidators: Partial<Record<PublicAotShellPageId, EntryValidator>> = {
  1: (entry, bootstrap, hydration) => {
    assert(entry.articleId == null, 'home bundle should not carry articleId');
    assert(entry.routeKey === 'home', 'home bundle routeKey mismatch');
    assertStringField(bootstrap, 'kind', 'Home', 'bootstrapJson');
    assertStringField(bootstrap, 'pageKind', 'Home', 'bootstrapJson');
    assertStringField(bootstrap, 'routeKey', 'home', 'bootstrapJson');
    assertStringField(hydration, 'pageKind', 'Home', 'hydrationPropsJson');
    assertStringField(hydration, 'routeKey', 'home', 'hydrationPropsJson');
    assertOptionalNullish(hydration, 'articleId', 'hydrationPropsJson');
    assert(!entry.islandsJson, 'home bundle should not carry islandsJson');
  },
  2: (entry, bootstrap, hydration) => {
    assert(typeof entry.articleId === 'number' && entry.articleId > 0, 'article detail bundle requires a positive articleId');
    const articleId = entry.articleId;
    const expectedRouteKey = `article:${articleId}`;
    assert(entry.routeKey === expectedRouteKey, `article detail routeKey mismatch: expected ${expectedRouteKey}`);
    assertStringField(bootstrap, 'kind', 'ArticleDetail', 'bootstrapJson');
    assertStringField(bootstrap, 'pageKind', 'ArticleDetail', 'bootstrapJson');
    assertStringField(bootstrap, 'routeKey', expectedRouteKey, 'bootstrapJson');
    assertNumberField(bootstrap, 'articleId', articleId, 'bootstrapJson');
    assertStringField(hydration, 'pageKind', 'ArticleDetail', 'hydrationPropsJson');
    assertStringField(hydration, 'routeKey', expectedRouteKey, 'hydrationPropsJson');
    assertNumberField(hydration, 'articleId', articleId, 'hydrationPropsJson');
    assert(!entry.islandsJson, 'article detail bundle should not carry islandsJson');
  },
  3: (entry, bootstrap, hydration) => {
    assert(entry.articleId == null, 'filter bundle should not carry articleId');
    assertStringField(bootstrap, 'kind', 'Filter', 'bootstrapJson');
    assertStringField(bootstrap, 'pageKind', 'Filter', 'bootstrapJson');
    assertStringField(bootstrap, 'routeKey', entry.routeKey, 'bootstrapJson');
    assertStringField(hydration, 'pageKind', 'Filter', 'hydrationPropsJson');
    assertStringField(hydration, 'routeKey', entry.routeKey, 'hydrationPropsJson');
    assertOptionalNullish(hydration, 'articleId', 'hydrationPropsJson');
    assert(!entry.islandsJson, 'filter bundle should not carry islandsJson');
  },
  4: (entry, bootstrap, hydration) => {
    assert(entry.articleId == null, 'archive bundle should not carry articleId');
    assert(entry.routeKey === 'archive', 'archive bundle routeKey mismatch');
    assertStringField(bootstrap, 'kind', 'Archive', 'bootstrapJson');
    assertStringField(bootstrap, 'pageKind', 'Archive', 'bootstrapJson');
    assertStringField(bootstrap, 'routeKey', 'archive', 'bootstrapJson');
    assertStringField(hydration, 'pageKind', 'Archive', 'hydrationPropsJson');
    assertStringField(hydration, 'routeKey', 'archive', 'hydrationPropsJson');
    assertOptionalNullish(hydration, 'articleId', 'hydrationPropsJson');
    assert(!entry.islandsJson, 'archive bundle should not carry islandsJson');
  },
  5: (entry, bootstrap, hydration) => {
    assert(entry.articleId == null, 'about bundle should not carry articleId');
    assert(entry.routeKey === 'about', 'about bundle routeKey mismatch');
    assertStringField(bootstrap, 'kind', 'About', 'bootstrapJson');
    assertStringField(bootstrap, 'pageKind', 'About', 'bootstrapJson');
    assertStringField(bootstrap, 'routeKey', 'about', 'bootstrapJson');
    assertStringField(hydration, 'pageKind', 'About', 'hydrationPropsJson');
    assertStringField(hydration, 'routeKey', 'about', 'hydrationPropsJson');
    assertOptionalNullish(hydration, 'articleId', 'hydrationPropsJson');
    assert(!entry.islandsJson, 'about bundle should not carry islandsJson');
  }
};

export function validatePublicAotShellBundle(bundle: PublicAotShellBundleContract): PublicAotShellBundleContract {
  assert(Array.isArray(bundle.entries) && bundle.entries.length > 0, 'public hydration bundle is empty');
  bundle.entries.forEach(validatePublicAotShellEntry);
  return bundle;
}

function createArticleDetailBootstrap(options: ArticleDetailPublicAotBundleOptions): string {
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
    authorName: options.authorName?.trim() || options.siteTitle?.trim() || 'Fsu'
  });
}

async function createArticleDetailHydrationPayload(
  options: ArticleDetailPublicAotBundleOptions
): Promise<PublicArticleDetailHydrationPayload> {
  assert(Number.isFinite(options.articleId ?? NaN) && (options.articleId ?? 0) > 0, 'article detail bundle requires a positive articleId');

  const detailView = createArticleDetailPageViewContract(
    {
      id: options.articleId ?? 0,
      title: options.title,
      content: options.content,
      summary: options.summary,
      views: 0,
      ...buildReadingMetrics(options.content),
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
    },
    0,
    false
  );

  const markdownHtml = await renderPublicMarkdownHtml({
    source: detailView.body.content,
    mode: 'article',
    allowLatex: true,
    allowMermaid: true
  });

  return {
    pageKind: 'ArticleDetail',
    routeKey: options.articleId && options.articleId > 0 ? `article:${options.articleId}` : 'article:{{articleId}}',
    articleId: options.articleId ?? '{{articleId}}',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    title: options.title,
    authorName: options.authorName?.trim() || options.siteTitle?.trim() || 'Fsu',
    baseUrl: options.baseUrl ?? null,
    siteTitle: options.siteTitle ?? null,
    siteDescription: options.siteDescription ?? null,
    detailView: {
      ...detailView,
      body: {
        ...detailView.body,
        content: markdownHtml
      }
    }
  };
}

export async function buildArticleDetailPublicAotEntry(
  options: ArticleDetailPublicAotBundleOptions
): Promise<PublicAotShellEntryContract> {
  const hydrationPayload = await createArticleDetailHydrationPayload(options);
  const rendered = await renderPublicArticleDetailBundle(hydrationPayload);

  return {
    pageId: 2,
    routeKey: hydrationPayload.routeKey,
    html: rendered.html,
    articleId: options.articleId && options.articleId > 0 ? options.articleId : null,
    bootstrapJson: createArticleDetailBootstrap(options),
    hydrationPropsJson: rendered.hydrationPropsJson,
    rendererVersion: rendered.rendererVersion,
    islandsJson: rendered.islandsJson ?? null,
    title: options.title,
    baseUrl: options.baseUrl ?? null
  };
}

export async function buildHomePublicAotEntry(options: {
  siteTitle?: string;
  siteDescription?: string;
  baseUrl?: string;
  page?: number;
  size?: number;
  response?: PageResponse<ArticleListItemResponse>;
} = {}): Promise<PublicAotShellEntryContract> {
  const page = options.page ?? 1;
  const size = options.size ?? 10;
  assert(Number.isInteger(page) && page > 0, 'home page must be a positive integer');
  assert(Number.isInteger(size) && size > 0, 'home size must be a positive integer');
  const response: PageResponse<ArticleListItemResponse> =
    options.response ??
    (await getArticles({ page, size }));

  const view = createArticleListViewContract(response, {
    currentPage: page,
    pageSize: size
  });

  const hydrationPayload: PublicHomeHydrationPayload = {
    pageKind: 'Home',
    routeKey: 'home',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    title: options.siteTitle ?? '首页',
    siteTitle: options.siteTitle ?? null,
    siteDescription: options.siteDescription ?? null,
    baseUrl: options.baseUrl ?? null,
    currentPage: page,
    pageSize: size,
    total: Number(response.total) || 0,
    view
  };

  const rendered = await renderPublicHomeBundle(hydrationPayload);

  return {
    pageId: 1,
    routeKey: 'home',
    html: rendered.html,
    bootstrapJson: JSON.stringify({
      kind: 'Home',
      pageKind: 'Home',
      routeKey: 'home',
      rendererVersion: PUBLIC_RENDERER_VERSION,
      total: hydrationPayload.total,
      articles: response.items,
      pageIndex: page,
      pageSize: size,
      siteTitle: options.siteTitle ?? null,
      siteDescription: options.siteDescription ?? null
    }),
    hydrationPropsJson: rendered.hydrationPropsJson,
    rendererVersion: rendered.rendererVersion,
    islandsJson: rendered.islandsJson ?? null,
    title: hydrationPayload.title,
    baseUrl: options.baseUrl ?? null
  };
}

export async function buildAboutPublicAotEntry(options: AboutPublicAotBundleOptions): Promise<PublicAotShellEntryContract> {
  const title = options.title ?? '关于';
  const hydrationPayload = {
    pageKind: 'About' as const,
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
  };

  const rendered = await renderPublicAboutBundle(hydrationPayload);
  return {
    pageId: 5,
    routeKey: 'about',
    html: rendered.html,
    bootstrapJson: JSON.stringify({
      kind: 'About',
      pageKind: 'About',
      routeKey: 'about',
      rendererVersion: PUBLIC_RENDERER_VERSION,
      siteTitle: options.siteTitle ?? null,
      siteDescription: options.siteDescription ?? null,
      about: hydrationPayload.about
    }),
    hydrationPropsJson: rendered.hydrationPropsJson,
    rendererVersion: rendered.rendererVersion,
    islandsJson: null,
    title,
    baseUrl: options.baseUrl ?? null
  };
}

export async function buildArchivePublicAotEntry(options: ArchivePublicAotBundleOptions): Promise<PublicAotShellEntryContract> {
  const title = options.title ?? '归档';
  const hydrationPayload: PublicArchiveHydrationPayload = {
    pageKind: 'Archive',
    routeKey: 'archive',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    title,
    siteTitle: options.siteTitle ?? null,
    siteDescription: options.siteDescription ?? null,
    baseUrl: options.baseUrl ?? null,
    total: options.articles.length,
    articles: options.articles
  };
  const rendered = await renderPublicArchiveBundle(hydrationPayload);
  return {
    pageId: 4,
    routeKey: 'archive',
    html: rendered.html,
    bootstrapJson: JSON.stringify({
      kind: 'Archive',
      pageKind: 'Archive',
      routeKey: 'archive',
      rendererVersion: PUBLIC_RENDERER_VERSION,
      siteTitle: options.siteTitle ?? null,
      siteDescription: options.siteDescription ?? null,
      total: options.articles.length,
      articles: options.articles
    }),
    hydrationPropsJson: rendered.hydrationPropsJson,
    rendererVersion: rendered.rendererVersion,
    islandsJson: null,
    title,
    baseUrl: options.baseUrl ?? null
  };
}

export async function buildFilterPublicAotEntry(options: FilterPublicAotBundleOptions): Promise<PublicAotShellEntryContract> {
  assert(typeof options.routeKey === 'string' && options.routeKey.trim().length > 0, 'filter routeKey is required');
  const title = options.title ?? '筛选';
  const hydrationPayload: PublicFilterHydrationPayload = {
    pageKind: 'Filter',
    routeKey: options.routeKey.trim(),
    rendererVersion: PUBLIC_RENDERER_VERSION,
    title,
    siteTitle: options.siteTitle ?? null,
    siteDescription: options.siteDescription ?? null,
    baseUrl: options.baseUrl ?? null,
    filter: {
      pageIndex: options.pageIndex,
      pageSize: options.pageSize,
      total: options.total,
      articles: options.articles
    }
  };
  const rendered = await renderPublicFilterBundle(hydrationPayload);
  return {
    pageId: 3,
    routeKey: hydrationPayload.routeKey,
    html: rendered.html,
    bootstrapJson: JSON.stringify({
      kind: 'Filter',
      pageKind: 'Filter',
      routeKey: hydrationPayload.routeKey,
      rendererVersion: PUBLIC_RENDERER_VERSION,
      siteTitle: options.siteTitle ?? null,
      siteDescription: options.siteDescription ?? null,
      filter: hydrationPayload.filter
    }),
    hydrationPropsJson: rendered.hydrationPropsJson,
    rendererVersion: rendered.rendererVersion,
    islandsJson: null,
    title,
    baseUrl: options.baseUrl ?? null
  };
}

export async function buildPublicHydrationBundle(
  options: ArticleDetailPublicAotBundleOptions & {
    includeHome?: boolean;
    homeResponse?: PageResponse<ArticleListItemResponse>;
    homePage?: number;
    homeSize?: number;
    includeAbout?: boolean;
    about?: AboutPublicAotBundleOptions;
    includeArchive?: boolean;
    archive?: ArchivePublicAotBundleOptions;
    includeFilter?: boolean;
    filter?: FilterPublicAotBundleOptions;
  }
): Promise<PublicAotShellBundleContract> {
  const entries: PublicAotShellEntryContract[] = [await buildArticleDetailPublicAotEntry(options)];

  if (options.includeHome !== false) {
    entries.push(
      await buildHomePublicAotEntry({
        siteTitle: options.siteTitle,
        siteDescription: options.siteDescription,
        baseUrl: options.baseUrl,
        response: options.homeResponse,
        page: options.homePage,
        size: options.homeSize
      })
    );
  }

  if (options.includeAbout && options.about) {
    entries.push(await buildAboutPublicAotEntry(options.about));
  }

  if (options.includeArchive && options.archive) {
    entries.push(await buildArchivePublicAotEntry(options.archive));
  }

  if (options.includeFilter && options.filter) {
    entries.push(await buildFilterPublicAotEntry(options.filter));
  }

  const bundle = {
    generatedAtUtc: new Date().toISOString(),
    entries
  };
  validatePublicAotShellBundle(bundle);
  return bundle;
}
