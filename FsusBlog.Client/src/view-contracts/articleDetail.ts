import type { ArticleDetail } from '@/api/article';
import type { TagContract } from '@/ui-contracts/primitives';
import { TimeUtils } from '@/utils/time';

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
  tags: readonly TagContract[];
}>;

export type ArticleDetailBodyViewContract = Readonly<{
  content: string;
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
    content: ''
  },
  comments: {
    title: '评论',
    headingText: '评论',
    loadingText: '加载中',
    endText: '暂无评论。',
    placeholderTitle: '评论流正在接管中',
    placeholderBody: 'AOT 会先直出正文与评论占位，Vue SPA 接管后会自动插入真实评论流。',
    placeholderHint: '这里预留真实评论列表容器，避免首屏与接管后的布局跳变。'
  },
  errorState: articleDetailStates.errorState,
  notFoundState: articleDetailStates.notFoundState
};

export function createArticleDetailHeaderViewContract(article: ArticleDetail): ArticleDetailHeaderViewContract {
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
  article: ArticleDetail,
  commentCount: number,
  hasMore: boolean
): ArticleDetailPageViewContract {
  const headingText = commentCount > 0 ? `评论 (${commentCount}${hasMore ? '+' : ''})` : '评论';

  return {
    header: createArticleDetailHeaderViewContract(article),
    body: {
      content: article.content
    },
    comments: {
      title: '评论',
      headingText,
      loadingText: '加载中',
      endText: commentCount > 0 ? '上面的评论已为最后一条。' : '暂无评论。',
      placeholderTitle: '评论流正在接管中',
      placeholderBody: 'AOT 会先直出正文与评论占位，Vue SPA 接管后会自动插入真实评论流。',
      placeholderHint: '这里预留真实评论列表容器，避免首屏与接管后的布局跳变。'
    },
    errorState: articleDetailStates.errorState,
    notFoundState: articleDetailStates.notFoundState
  };
}
