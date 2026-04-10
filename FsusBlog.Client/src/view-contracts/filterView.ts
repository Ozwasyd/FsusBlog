import type { ArticleListCardViewContract } from '@/view-contracts/articleList';

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

export type FilterEmptyStateViewContract = Readonly<{
  hasError: boolean;
  title: string;
  actionText: string;
  actionRoute: {
    readonly name: 'Home';
  };
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

export function createFilterHeaderViewContract(view: {
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

export function createFilterLoadingStateViewContract(view: {
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

export function createFilterEmptyStateViewContract(hasError: boolean): FilterEmptyStateViewContract {
  return {
    hasError,
    title: hasError ? '暂时无法加载内容' : '无相关内容',
    actionText: '返回首页',
    actionRoute: {
      name: 'Home'
    }
  };
}
