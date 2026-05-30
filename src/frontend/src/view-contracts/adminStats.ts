import type { AdminStatsOverview, RecentCommentStatItem, RegionStatItem, StatsSummary } from '@/api/stats';
import type { AuthorAnalyticsResponse } from '@/api/authoring'
import { TimeUtils } from '@/utils/time';

type AdminStatCardViewContract = Readonly<{
  label: string;
  key: keyof Pick<StatsSummary, 'totalArticles' | 'totalComments' | 'totalVisits' | 'trashCount'>;
  value: number;
  description: string;
  iconName: 'document' | 'comments' | 'views' | 'trash';
}>;

type AdminPopularArticleViewContract = Readonly<{
  id: number;
  title: string;
  views: number;
  rank: number;
  rankClassName: string;
  href: string;
}>;

type AdminRecentCommentViewContract = Readonly<{
  id: string | number;
  userName: string;
  content: string;
  timeText: string;
  timeTitle: string;
  isLatest: boolean;
}>;

export type AdminDashboardViewContract = Readonly<{
  statCards: readonly AdminStatCardViewContract[];
  popularArticles: readonly AdminPopularArticleViewContract[];
  recentComments: readonly AdminRecentCommentViewContract[];
  visitChart: Readonly<{
    registeredVisits: number;
    anonymousVisits: number;
  }>;
  regionChart: Readonly<{
    labels: readonly string[];
    values: readonly number[];
  }>;
  authorAnalytics: Readonly<{
    publishedArticles: number;
    draftArticles: number;
    scheduledArticles: number;
    archivedArticles: number;
    totalHumanReadEvents: number;
    totalSearchableArticles: number;
    aotHitRateText: string;
    averageDwellText: string;
    readingCompletionText: string;
    topSearchKeywords: readonly AuthorAnalyticsListItem[];
    topSourceRoutes: readonly AuthorAnalyticsListItem[];
    notFoundHotspots: readonly AuthorAnalyticsListItem[];
    rumMetrics: readonly AuthorRumMetricViewItem[];
    rumPageTypes: readonly AuthorAnalyticsListItem[];
    rumAotSources: readonly AuthorAnalyticsListItem[];
  }>;
}>;

export type AuthorAnalyticsListItem = Readonly<{
  label: string;
  count: number;
}>;

export type AuthorRumMetricViewItem = Readonly<{
  name: string;
  count: number;
  p75Text: string;
  averageText: string;
}>;

const STAT_CARD_TEMPLATES: readonly Omit<AdminStatCardViewContract, 'value'>[] = [
  {
    label: '文章总计',
    key: 'totalArticles',
    description: '已发布内容总量',
    iconName: 'document'
  },
  {
    label: '评论总计',
    key: 'totalComments',
    description: '累计互动记录',
    iconName: 'comments'
  },
  {
    label: '累计访问',
    key: 'totalVisits',
    description: '站点历史访问量',
    iconName: 'views'
  },
  {
    label: '回收站',
    key: 'trashCount',
    description: '待恢复或清理',
    iconName: 'trash'
  }
];

export function createAdminDashboardViewContract(
  overview: AdminStatsOverview,
  recentComments: readonly RecentCommentStatItem[] = [],
  regions: readonly RegionStatItem[] = [],
  authorAnalytics?: AuthorAnalyticsResponse | null
): AdminDashboardViewContract {
  const stats = overview.summary;
  const analytics = authorAnalytics ?? createEmptyAuthorAnalytics();
  return {
    statCards: STAT_CARD_TEMPLATES.map((item) => ({
      ...item,
      value: Number(stats[item.key]) || 0
    })),
    popularArticles: (overview.popularArticles || []).map((article, index) => ({
      id: article.id,
      title: article.title,
      views: Number(article.views) || 0,
      rank: index + 1,
      rankClassName: index < 3 ? 'text-[var(--fsusblog-text-primary)] font-bold' : 'text-[var(--fsusblog-text-muted)]',
      href: `/article/${article.id}`
    })),
    recentComments: (recentComments || []).map((comment, index) => ({
      id: comment.userId ?? `${comment.userName}-${index}`,
      userName: comment.userName,
      content: comment.content,
      timeText: TimeUtils.toFullLocalString(comment.createTime),
      timeTitle: TimeUtils.toFullLocalString(comment.createTime),
      isLatest: index === 0
    })),
    visitChart: {
      registeredVisits: Number(stats.registeredVisits) || 0,
      anonymousVisits: Number(stats.anonymousVisits) || 0
    },
    regionChart: {
      labels: (regions || []).slice(0, 10).map((item) => item.region.split('-').pop() || '未知'),
      values: (regions || []).slice(0, 10).map((item) => Number(item.count) || 0)
    },
    authorAnalytics: {
      publishedArticles: Number(analytics.publishedArticles) || 0,
      draftArticles: Number(analytics.draftArticles) || 0,
      scheduledArticles: Number(analytics.scheduledArticles) || 0,
      archivedArticles: Number(analytics.archivedArticles) || 0,
      totalHumanReadEvents: Number(analytics.totalHumanReadEvents) || 0,
      totalSearchableArticles: Number(analytics.totalSearchableArticles) || 0,
      aotHitRateText: formatPercent(analytics.aotHitRate),
      averageDwellText: formatDuration(analytics.averageDwellMs),
      readingCompletionText: formatPercent(analytics.readingCompletionRate),
      topSearchKeywords: normalizeAnalyticsList(analytics.topSearchKeywords),
      topSourceRoutes: normalizeAnalyticsList(analytics.topSourceRoutes),
      notFoundHotspots: normalizeAnalyticsList(analytics.notFoundHotspots),
      rumMetrics: normalizeRumMetrics(analytics.rumMetrics),
      rumPageTypes: normalizeAnalyticsList(analytics.rumPageTypes),
      rumAotSources: normalizeAnalyticsList(analytics.rumAotSources)
    }
  };
}

function createEmptyAuthorAnalytics(): AuthorAnalyticsResponse {
  return {
    publishedArticles: 0,
    draftArticles: 0,
    scheduledArticles: 0,
    archivedArticles: 0,
    totalHumanReadEvents: 0,
    totalSearchableArticles: 0,
    aotHitRate: 0,
    averageDwellMs: 0,
    readingCompletionRate: 0,
    topSearchKeywords: [],
    topSourceRoutes: [],
    notFoundHotspots: [],
    rumMetrics: [],
    rumPageTypes: [],
    rumAotSources: []
  }
}

function normalizeAnalyticsList(items: AuthorAnalyticsResponse['topSearchKeywords']): readonly AuthorAnalyticsListItem[] {
  return (items ?? [])
    .slice(0, 6)
    .map((item) => ({
      label: item.label,
      count: Number(item.count) || 0
    }))
}

function normalizeRumMetrics(items: AuthorAnalyticsResponse['rumMetrics']): readonly AuthorRumMetricViewItem[] {
  return (items ?? [])
    .slice(0, 8)
    .map((item) => ({
      name: item.name,
      count: Number(item.count) || 0,
      p75Text: formatDuration(item.p75),
      averageText: formatDuration(item.average)
    }))
}

function formatPercent(value: number): string {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
  return `${Math.round(normalized * 100)}%`
}

function formatDuration(value: number): string {
  const ms = Number.isFinite(value) ? Math.max(0, value) : 0
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${Math.round(ms / 1000)}s`
}
