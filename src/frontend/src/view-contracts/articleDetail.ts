import type { ArticleDetailResponse, ArticleRightsResponse, RelatedReadingItemResponse, RelatedReadingResponse } from '@/api/article';
import { buildPublicArticleHref, buildPublicCategoryHref, buildPublicTagHref } from '@/public-renderers/publicRouteIdentity';
import { estimateReading } from '@/utils/readingEstimate';
import { TimeUtils, type TimeRenderOptions } from '@/utils/time';

export type ArticleReadingNoticeContract = Readonly<{
  visible: boolean;
  wordCount: number;
  readingMinutes: number;
}>;

function buildReadingNotice(content: string): ArticleReadingNoticeContract {
  const estimate = estimateReading(content);

  return {
    visible: estimate.showLongReadNotice,
    wordCount: estimate.effectiveChars,
    readingMinutes: estimate.minutes
  };
}

type ArticleTagViewContract = Readonly<{
  label: string;
  href?: string;
}>;

export type ArticleDetailHeaderViewContract = Readonly<{
  id: number;
  title: string;
  coverImageUrl?: string;
  viewsText: string;
  meta: Readonly<{
    isoTime: string;
    displayTime: string;
    fullTime: string;
    categoryName: string;
    categoryHref?: string;
  }>;
  tags: readonly ArticleTagViewContract[];
}>;

type ArticleDetailBodyViewContract = Readonly<{
  content: string;
  notice: ArticleReadingNoticeContract;
}>;

type ArticleDetailCommentsViewContract = Readonly<{
  title: string;
  headingText: string;
  loadingText: string;
  endText: string;
  placeholderText: string;
}>;

export type RelatedReadingItemViewContract = Readonly<{
  id: number;
  title: string;
  summary: string;
  reason: string;
  href: string;
  displayTime: string;
}>;

export type ArticleDetailRelatedReadingViewContract = Readonly<{
  title: string;
  previousLabel: string;
  nextLabel: string;
  relatedLabel: string;
  emptyText: string;
  previous: RelatedReadingItemViewContract | null;
  next: RelatedReadingItemViewContract | null;
  items: readonly RelatedReadingItemViewContract[];
}>;

export type ArticleRightsViewContract = Readonly<{
  snapshotId: string;
  articleRevisionId: string;
  revisionNo: number;
  enabled: boolean;
  licenseType: string;
  copyrightHolder: string | null;
  copyrightYear: number | null;
  rightsStatement: string | null;
  attributionTemplate: string | null;
  copyPolicy: string;
  maxExcerptChars: number;
  allowCodeCopy: boolean;
  showPublicBadge: boolean;
  proofBindingEnabled: boolean;
  canonicalUrl: string | null;
  policyHash: string;
  contentCanonicalHash: string;
  proofUrl: string | null;
  proofStatus: string | null;
}>;

export type ArticleDetailErrorStateViewContract = Readonly<{
  title: string;
  retryText: string;
}>;

export type ArticleDetailNotFoundStateViewContract = Readonly<{
  title: string;
  actionText: string;
  actionHref: string;
}>;

export type ArticleDetailPageViewContract = Readonly<{
  header: ArticleDetailHeaderViewContract;
  body: ArticleDetailBodyViewContract;
  rights: ArticleRightsViewContract;
  relatedReading: ArticleDetailRelatedReadingViewContract;
  comments: ArticleDetailCommentsViewContract;
  errorState: ArticleDetailErrorStateViewContract;
  notFoundState: ArticleDetailNotFoundStateViewContract;
}>;

export const articleDetailStates = {
  errorState: {
    title: '文章暂时无法加载',
    retryText: '重试'
  },
  notFoundState: {
    title: '文章不存在或已不可见',
    actionText: '返回首页',
    actionHref: '/'
  }
} as const;

export const emptyArticleDetailHeaderView: ArticleDetailHeaderViewContract = {
  id: 0,
  title: '',
  viewsText: '0 浏览',
  meta: {
    isoTime: '',
    displayTime: '',
    fullTime: '',
    categoryName: '未分类'
  },
  tags: []
};

export const emptyArticleRightsView: ArticleRightsViewContract = {
  snapshotId: '0',
  articleRevisionId: '0',
  revisionNo: 0,
  enabled: false,
  licenseType: 'all-rights-reserved',
  copyrightHolder: null,
  copyrightYear: null,
  rightsStatement: null,
  attributionTemplate: null,
  copyPolicy: 'disabled',
  maxExcerptChars: 0,
  allowCodeCopy: false,
  showPublicBadge: false,
  proofBindingEnabled: false,
  canonicalUrl: null,
  policyHash: '',
  contentCanonicalHash: '',
  proofUrl: null,
  proofStatus: null
};

export const emptyArticleDetailPageView: ArticleDetailPageViewContract = {
  header: emptyArticleDetailHeaderView,
  body: {
    content: '',
    notice: {
      visible: false,
      wordCount: 0,
      readingMinutes: 1
    }
  },
  rights: emptyArticleRightsView,
  relatedReading: {
    title: '延伸阅读',
    previousLabel: '上一篇',
    nextLabel: '下一篇',
    relatedLabel: '相关文章',
    emptyText: '暂无延伸阅读。',
    previous: null,
    next: null,
    items: []
  },
  comments: {
    title: '评论',
    headingText: '评论',
    loadingText: '加载中',
    endText: '暂无评论。',
    placeholderText: '还没有评论。期待你在这篇文章下留下第一条想法。'
  },
  errorState: articleDetailStates.errorState,
  notFoundState: articleDetailStates.notFoundState
};

export function createArticleRightsViewContract(rights: ArticleRightsResponse): ArticleRightsViewContract {
  return {
    snapshotId: rights.snapshotId,
    articleRevisionId: rights.articleRevisionId,
    revisionNo: rights.revisionNo,
    enabled: rights.enabled,
    licenseType: rights.licenseType,
    copyrightHolder: rights.copyrightHolder,
    copyrightYear: rights.copyrightYear,
    rightsStatement: rights.rightsStatement,
    attributionTemplate: rights.attributionTemplate,
    copyPolicy: rights.copyPolicy,
    maxExcerptChars: rights.maxExcerptChars,
    allowCodeCopy: rights.allowCodeCopy,
    showPublicBadge: rights.showPublicBadge,
    proofBindingEnabled: rights.proofBindingEnabled,
    canonicalUrl: rights.canonicalUrl,
    policyHash: rights.policyHash,
    contentCanonicalHash: rights.contentCanonicalHash,
    proofUrl: rights.proofUrl,
    proofStatus: rights.proofStatus
  };
}

export function createArticleDetailHeaderViewContract(
  article: ArticleDetailResponse,
  timeOptions?: TimeRenderOptions
): ArticleDetailHeaderViewContract {
  return {
    id: article.id,
    title: article.title,
    coverImageUrl: article.coverImageUrl,
    viewsText: `${article.views} 浏览`,
    meta: {
      isoTime: article.createTime,
      displayTime: TimeUtils.toSmartTime(article.createTime, timeOptions),
      fullTime: TimeUtils.toFullLocalString(article.createTime, timeOptions),
      categoryName: article.category?.name || '未分类',
      categoryHref: article.category ? buildPublicCategoryHref(article.category.id) : undefined
    },
    tags: article.tags.map((tag) => ({
      label: `#${tag.name}`,
      href: buildPublicTagHref(tag.id)
    }))
  };
}

export function createArticleDetailPageViewContract(
  article: ArticleDetailResponse,
  commentCount: number,
  hasMore: boolean,
  relatedReading?: RelatedReadingResponse | null,
  timeOptions?: TimeRenderOptions
): ArticleDetailPageViewContract {
  const headingText = commentCount > 0 ? `评论 (${commentCount}${hasMore ? '+' : ''})` : '评论';

  return {
    header: createArticleDetailHeaderViewContract(article, timeOptions),
    body: {
      content: article.content,
      notice: buildReadingNotice(article.content)
    },
    rights: createArticleRightsViewContract(article.rights),
    relatedReading: createRelatedReadingViewContract(relatedReading, timeOptions),
    comments: {
      title: '评论',
      headingText,
      loadingText: '加载中',
      endText: commentCount > 0 ? '上面的评论已为最后一条。' : '暂无评论。',
      placeholderText: '还没有评论。期待你在这篇文章下留下第一条想法。'
    },
    errorState: articleDetailStates.errorState,
    notFoundState: articleDetailStates.notFoundState
  };
}

function createRelatedReadingViewContract(
  relatedReading?: RelatedReadingResponse | null,
  timeOptions?: TimeRenderOptions
): ArticleDetailRelatedReadingViewContract {
  return {
    title: '延伸阅读',
    previousLabel: '上一篇',
    nextLabel: '下一篇',
    relatedLabel: '相关文章',
    emptyText: '暂无延伸阅读。',
    previous: relatedReading?.previous ? createRelatedReadingItemView(relatedReading.previous, timeOptions) : null,
    next: relatedReading?.next ? createRelatedReadingItemView(relatedReading.next, timeOptions) : null,
    items: (relatedReading?.related ?? []).map((item) => createRelatedReadingItemView(item, timeOptions))
  };
}

function createRelatedReadingItemView(
  item: RelatedReadingItemResponse,
  timeOptions?: TimeRenderOptions
): RelatedReadingItemViewContract {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary?.trim() ?? '',
    reason: item.reason,
    href: buildPublicArticleHref(item.id),
    displayTime: TimeUtils.toSmartTime(item.createTime, timeOptions)
  };
}
