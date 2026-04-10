import type { ArticleListItem, ArticleListRes } from '@/api/article';
import type { CardContract, EmptyStateContract, PaginationContract, TagContract } from '@/ui-contracts/primitives';
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
  tags: readonly TagContract[];
}>;

export type ArticleListViewContract = Readonly<{
  items: readonly ArticleListCardViewContract[];
  pagination: PaginationContract;
  showPagination: boolean;
  emptyState: EmptyStateContract;
  searchKeyword: string;
}>;

function toArticleHref(id: number): string {
  return `/article/${id}`;
}

function toTagContract(name: string): TagContract {
  return {
    label: `#${name}`,
    hiddenOnMobile: true
  };
}

export function createArticleListCardViewContract(
  article: ArticleListItem,
  index = 0
): ArticleListCardViewContract {
  return {
    card: {
      kind: 'article-list-card',
      index
    },
    id: article.id,
    href: toArticleHref(article.id),
    title: article.title,
    summary: article.snippet || article.summary || '',
    meta: {
      isoTime: article.createTime,
      displayTime: TimeUtils.toSmartTime(article.createTime),
      fullTime: TimeUtils.toFullLocalString(article.createTime),
      categoryName: article.category?.name || DEFAULT_CATEGORY
    },
    tags: (article.tags || []).slice(0, MAX_TAGS_DISPLAY).map((tag) => toTagContract(tag.name))
  };
}

export function createArticleListViewContract(
  response: ArticleListRes,
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
        variant: 'quiet',
        disabled: currentPage <= 1,
        action: { action: 'page-prev' }
      },
      next: {
        label: '下一页',
        variant: 'quiet',
        disabled: currentPage >= totalPages,
        action: { action: 'page-next' }
      },
      indicator: `${currentPage} / ${totalPages}`
    },
    showPagination: totalPages > 1,
    emptyState: {
      title: '没有找到文章。'
    },
    searchKeyword: options.searchKeyword?.trim() ?? ''
  };
}
