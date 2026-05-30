import type { ArticleListCardViewContract } from '@/view-contracts/articleList';
import type { PublicHomeNavigationTarget } from '@/public-renderers/publicNavigationTargets'
import { createPublicHomeNavigationTarget } from '@/public-renderers/publicNavigationTargets'

export type FilterHeaderViewContract = Readonly<{
  labelText: string;
  currentName: string;
  loadingMeta: boolean;
}>;

export type FilterLoadingStateViewContract = Readonly<{
  loadingArticles: boolean;
  isPowCalculating: boolean;
  skeletonCount: number;
  indicatorText: string;
}>;

type FilterEmptyStateViewContract = Readonly<{
  hasError: boolean;
  isInvalidTarget: boolean;
  title: string;
  actionText: string;
  actionRoute: PublicHomeNavigationTarget['route'];
}>;

export type FilterPageViewContract = Readonly<{
  header: FilterHeaderViewContract;
  loading: FilterLoadingStateViewContract;
  empty: FilterEmptyStateViewContract;
  articles: readonly ArticleListCardViewContract[];
  pagination: Readonly<{
    currentPage: number;
    totalPages: number;
    pageIndicatorText: string;
    canGoPrev: boolean;
    canGoNext: boolean;
  }>;
}>;

export function createFilterPageViewContract(view: {
  labelText: string;
  currentName: string;
  loadingMeta: boolean;
  loadingArticles: boolean;
  isPowCalculating: boolean;
  hasError: boolean;
  isInvalidTarget: boolean;
  articles: readonly ArticleListCardViewContract[];
  currentPage: number;
  totalPages: number;
  pageIndicatorText: string;
  canGoPrev: boolean;
  canGoNext: boolean;
}): FilterPageViewContract {
  return {
    header: createFilterHeaderViewContract({
      labelText: view.labelText,
      currentName: view.currentName,
      loadingMeta: view.loadingMeta
    }),
    loading: createFilterLoadingStateViewContract({
      loadingArticles: view.loadingArticles,
      isPowCalculating: view.isPowCalculating
    }),
    empty: createFilterEmptyStateViewContract(view.hasError, view.isInvalidTarget),
    articles: view.articles,
    pagination: {
      currentPage: view.currentPage,
      totalPages: view.totalPages,
      pageIndicatorText: view.pageIndicatorText,
      canGoPrev: view.canGoPrev,
      canGoNext: view.canGoNext
    }
  };
}

function createFilterHeaderViewContract(view: {
  labelText: string;
  currentName: string;
  loadingMeta: boolean;
}): FilterHeaderViewContract {
  return {
    labelText: view.labelText,
    currentName: view.currentName,
    loadingMeta: view.loadingMeta
  };
}

function createFilterLoadingStateViewContract(view: {
  loadingArticles: boolean;
  isPowCalculating: boolean;
}): FilterLoadingStateViewContract {
  return {
    loadingArticles: view.loadingArticles,
    isPowCalculating: view.isPowCalculating,
    skeletonCount: 3,
    indicatorText: 'Security verifying...'
  };
}

function createFilterEmptyStateViewContract(
  hasError: boolean,
  isInvalidTarget: boolean
): FilterEmptyStateViewContract {
  const homeTarget = createPublicHomeNavigationTarget()
  return {
    hasError,
    isInvalidTarget,
    title: hasError ? '暂时无法加载内容' : isInvalidTarget ? '筛选目标不存在' : '无相关内容',
    actionText: '返回首页',
    actionRoute: homeTarget.route
  };
}
