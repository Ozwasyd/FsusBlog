import type { ArticleDetailResponse } from '@/api/article';
import { TimeUtils } from '@/utils/time';

const READING_CHARS_PER_MINUTE = 300;
const LONG_READ_THRESHOLD = 5_000;

function buildReadingNotice(content: string): { visible: boolean; label: string } {
  const normalized = content.replace(/\s+/g, '');
  const wordCount = normalized.length;
  const estimatedReadingMinutes = Math.max(1, Math.ceil(wordCount / READING_CHARS_PER_MINUTE));

  return {
    visible: wordCount > LONG_READ_THRESHOLD,
    label: `长文预警：全文约 ${wordCount.toLocaleString('zh-CN')} 字，预计阅读 ${estimatedReadingMinutes} 分钟`
  };
}

export type ArticleTagViewContract = Readonly<{
  label: string;
}>;

export type ArticleDetailHeaderViewContract = Readonly<{
  id: number;
  title: string;
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

export type ArticleDetailBodyViewContract = Readonly<{
  content: string;
  notice: Readonly<{
    visible: boolean;
    label: string;
  }>;
}>;

export type ArticleDetailCommentsViewContract = Readonly<{
  title: string;
  headingText: string;
  loadingText: string;
  endText: string;
  placeholderTitle: string;
  placeholderBody: string;
  placeholderHint: string;
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
  comments: ArticleDetailCommentsViewContract;
  errorState: ArticleDetailErrorStateViewContract;
  notFoundState: ArticleDetailNotFoundStateViewContract;
}>;

export const articleDetailStates = {
  errorState: {
    title: '数据加载异常，请稍后重试。',
    retryText: '重载页面'
  },
  notFoundState: {
    title: '文章未找到。',
    actionText: '回到主页',
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

export const emptyArticleDetailPageView: ArticleDetailPageViewContract = {
  header: emptyArticleDetailHeaderView,
  body: {
    content: '',
    notice: {
      visible: false,
      label: ''
    }
  },
  comments: {
    title: '评论',
    headingText: '评论',
    loadingText: '加载中',
    endText: '暂无评论。',
    placeholderTitle: '暂无评论',
    placeholderBody: '',
    placeholderHint: ''
  },
  errorState: articleDetailStates.errorState,
  notFoundState: articleDetailStates.notFoundState
};

export function createArticleDetailHeaderViewContract(article: ArticleDetailResponse): ArticleDetailHeaderViewContract {
  return {
    id: article.id,
    title: article.title,
    viewsText: `${article.views} 浏览`,
    meta: {
      isoTime: article.createTime,
      displayTime: TimeUtils.toSmartTime(article.createTime),
      fullTime: TimeUtils.toFullLocalString(article.createTime),
      categoryName: article.category?.name || '未分类',
      categoryHref: article.category ? `/category/${article.category.id}` : undefined
    },
    tags: article.tags.map((tag) => ({
      label: `#${tag.name}`
    }))
  };
}

export function createArticleDetailPageViewContract(
  article: ArticleDetailResponse,
  commentCount: number,
  hasMore: boolean
): ArticleDetailPageViewContract {
  const headingText = commentCount > 0 ? `评论 (${commentCount}${hasMore ? '+' : ''})` : '评论';

  return {
    header: createArticleDetailHeaderViewContract(article),
    body: {
      content: article.content,
      notice: buildReadingNotice(article.content)
    },
    comments: {
      title: '评论',
      headingText,
      loadingText: '加载中',
      endText: commentCount > 0 ? '上面的评论已为最后一条。' : '暂无评论。',
      placeholderTitle: '暂无评论',
      placeholderBody: '',
      placeholderHint: ''
    },
    errorState: articleDetailStates.errorState,
    notFoundState: articleDetailStates.notFoundState
  };
}
