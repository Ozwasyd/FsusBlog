import type { ArticleListCardViewContract } from '@/view-contracts/articleList';
import type { PublicHomeNavigationTarget } from '@/public-renderers/publicNavigationTargets'
import { createPublicHomeNavigationTarget } from '@/public-renderers/publicNavigationTargets'
import { PUBLIC_FILTER_TYPE, type PublicFilterType } from '@/public-renderers/publicFilterSemantics'

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
  filterType: PublicFilterType;
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
  filterType: PublicFilterType;
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
    filterType: view.filterType,
    header: createFilterHeaderViewContract({
      labelText: view.labelText,
      currentName: view.currentName,
      loadingMeta: view.loadingMeta
    }),
    loading: createFilterLoadingStateViewContract({
      loadingArticles: view.loadingArticles,
      isPowCalculating: view.isPowCalculating
    }),
    empty: createFilterEmptyStateViewContract({
      filterType: view.filterType,
      currentName: view.currentName,
      hasError: view.hasError,
      isInvalidTarget: view.isInvalidTarget
    }),
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
    indicatorText: '正在完成访问校验'
  };
}

function normalizeFilterName(value: string): string {
  return value.trim().replace(/^“|”$/gu, '')
}

function createFilterEmptyStateViewContract(view: {
  filterType: PublicFilterType;
  currentName: string;
  hasError: boolean;
  isInvalidTarget: boolean;
}): FilterEmptyStateViewContract {
  const homeTarget = createPublicHomeNavigationTarget()
  const currentName = normalizeFilterName(view.currentName)
  let title = '这里还没有文章'

  if (view.hasError) {
    title = '文章列表没取回来，稍后再试'
  } else if (view.isInvalidTarget) {
    title = view.filterType === PUBLIC_FILTER_TYPE.tag ? '没有找到这个标签' : '没有找到这个分类'
  } else if (view.filterType === PUBLIC_FILTER_TYPE.search) {
    title = currentName && currentName !== '全站搜索'
      ? `没搜到「${currentName}」，换个词试试`
      : '输入关键词后再查找文章'
  } else if (view.filterType === PUBLIC_FILTER_TYPE.category) {
    title = '这个分类还没放文章'
  } else if (view.filterType === PUBLIC_FILTER_TYPE.tag) {
    title = '这个标签下还没有文章'
  }

  return {
    hasError: view.hasError,
    isInvalidTarget: view.isInvalidTarget,
    title,
    actionText: '返回首页',
    actionRoute: homeTarget.route
  };
}
