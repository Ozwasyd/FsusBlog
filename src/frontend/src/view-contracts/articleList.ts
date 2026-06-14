import type { ArticleListItemResponse, PageResponse } from '@/api/article';
import { createPublicArticleDetailNavigationTarget } from '@/public-renderers/publicNavigationTargets'
import type { CardContract, PaginationContract } from '@/ui-contracts/primitives';
import { TimeUtils } from '@/utils/time';

const DEFAULT_CATEGORY = '通用类';
const MAX_TAGS_DISPLAY = 5;

export type ArticleListCardViewContract = Readonly<{
  card: CardContract;
  id: number;
  href: string;
  title: string;
  summary: string;
  meta: Readonly<{
    isoTime: string;
    displayTime: string;
    fullTime: string;
    categoryName: string;
  }>;
  tags: readonly ArticleTagViewContract[];
}>;

type ArticleTagViewContract = Readonly<{
  label: string;
  hiddenOnMobile?: boolean;
}>;

type ArticleListEmptyStateViewContract = Readonly<{
  title: string;
  body?: string;
}>;

export type ArticleListViewContract = Readonly<{
  items: readonly ArticleListCardViewContract[];
  pagination: PaginationContract;
  showPagination: boolean;
  emptyState: ArticleListEmptyStateViewContract;
  searchKeyword: string;
}>;

function toArticleTagView(name: string): ArticleTagViewContract {
  return {
    label: `#${name}`,
    hiddenOnMobile: true
  };
}

export function createArticleListCardViewContract(
  article: ArticleListItemResponse,
  index = 0
): ArticleListCardViewContract {
  const articleTarget = createPublicArticleDetailNavigationTarget(article.id)
  return {
    card: {
      kind: 'article-list-card',
      index
    },
    id: article.id,
    href: articleTarget.href,
    title: article.title,
    summary: article.summary || '',
    meta: {
      isoTime: article.createTime,
      displayTime: TimeUtils.toSmartTime(article.createTime),
      fullTime: TimeUtils.toFullLocalString(article.createTime),
      categoryName: article.category?.name || DEFAULT_CATEGORY
    },
    tags: (article.tags || []).slice(0, MAX_TAGS_DISPLAY).map((tag) => toArticleTagView(tag.name))
  };
}

export function createArticleListViewContract(
  response: PageResponse<ArticleListItemResponse>,
  options: { currentPage: number; pageSize: number; searchKeyword?: string }
): ArticleListViewContract {
  const total = Number(response.total) || 0;
  const currentPage = Math.max(1, options.currentPage);
  const pageSize = Math.max(1, options.pageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    items: response.items.map((article, index) => createArticleListCardViewContract(article, index)),
    pagination: {
      previous: {
        label: '上一页',
        disabled: currentPage <= 1,
        action: { action: 'page-prev' }
      },
      next: {
        label: '下一页',
        disabled: currentPage >= totalPages,
        action: { action: 'page-next' }
      },
      indicator: `${currentPage} / ${totalPages}`
    },
    showPagination: totalPages > 1,
    emptyState: {
      title: '这里还没有文章'
    },
    searchKeyword: options.searchKeyword?.trim() ?? ''
  };
}
