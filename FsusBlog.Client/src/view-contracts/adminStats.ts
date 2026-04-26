import type { AdminStatsOverview, RecentCommentStatItem, RegionStatItem, StatsSummary } from '@/api/stats';
import { TimeUtils } from '@/utils/time';

export type AdminStatCardViewContract = Readonly<{
  label: string;
  key: keyof Pick<StatsSummary, 'totalArticles' | 'totalComments' | 'totalVisits' | 'trashCount'>;
  value: number;
  description: string;
  iconName: 'document' | 'comments' | 'views' | 'trash';
  bgClass: string;
  iconClass: string;
}>;

export type AdminPopularArticleViewContract = Readonly<{
  id: number;
  title: string;
  views: number;
  rank: number;
  rankClassName: string;
  href: string;
}>;

export type AdminRecentCommentViewContract = Readonly<{
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
}>;

export const dashboardTokens = {
  wrapper: 'dashboard-wrapper',
  statGrid: 'mb-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4',
  statCard: 'border-none transition-all duration-300 hover:-translate-y-1',
  statCardInner: 'flex items-center gap-4',
  statIconWrap: 'p-4 rounded-[var(--fsus-radius-lg)] flex items-center justify-center shrink-0',
  statLabel: 'text-[#8E8E93] text-xs font-bold mb-1 uppercase tracking-normal',
  statValue: 'text-2xl font-bold text-[#27272A] tracking-normal tabular-nums',
  chartRow: 'mb-5 grid grid-cols-1 gap-5 lg:grid-cols-3',
  chartCard: 'border-[#F4F4F5] h-full',
  chartHeader: 'flex items-center justify-between',
  chartHeaderTitle: 'font-bold text-[#3F3F46]',
  chartHeaderHint: 'text-[#A1A1AA] cursor-help',
  chartBody: 'h-75 w-full',
  chartSummary: 'h-75 w-full flex flex-col justify-center gap-4 p-4',
  chartSummaryCard: 'rounded-[var(--fsus-radius-lg)] border border-[#F4F4F5] bg-[#FCFCFC] p-4',
  chartSummaryLabel: 'text-[10px] font-bold uppercase tracking-normal text-[#A1A1AA]',
  chartSummaryValue: 'mt-2 text-2xl font-bold text-[#27272A] tabular-nums',
  chartList: 'space-y-3 p-4',
  chartListItem: 'flex items-center gap-3',
  chartListLabel: 'min-w-0 flex-1 truncate text-sm font-medium text-[#71717A]',
  chartListValue: 'text-sm font-mono font-bold text-[#27272A] tabular-nums',
  chartBarTrack: 'h-2 flex-1 rounded-full bg-[#F4F4F5] overflow-hidden',
  chartBarFill: 'h-full rounded-[999px] bg-[#2A599C]',
  tableCard: 'border-[#F4F4F5] h-full',
  tableWrap: 'overflow-hidden',
  table: 'w-full border-collapse',
  tableHead: 'border-b border-[#F4F4F5] bg-[#FCFCFC] text-xs uppercase tracking-normal text-[#A1A1AA]',
  tableHeadCell: 'px-4 py-3 font-bold',
  tableBodyRow: 'border-b border-[#FCFCFC] last:border-b-0',
  tableBodyCell: 'px-4 py-4 align-middle',
  tableRank: 'font-bold',
  tableTitle: 'text-[#3F3F46] hover:text-[#2A599C] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] rounded-[var(--fsus-radius-sm)]',
  tableViews: 'inline-flex rounded-full border border-[#F4F4F5] bg-[#FCFCFC] px-3 py-1 text-xs font-mono font-bold text-[#71717A]',
  timelineCard: 'border-[#F4F4F5] h-full',
  timelineEmpty: 'h-75 flex flex-col items-center justify-center',
  timelineWrap: 'max-h-[320px] overflow-auto',
  timelineList: 'relative space-y-5 p-4',
  timelineItem: 'relative pl-6',
  timelineDot: 'absolute left-0 top-2 h-3 w-3 rounded-[999px] border-2 border-[#2A599C] bg-white',
  timelineDotMuted: 'border-[#D4D4D8]',
  timelineCardBox: 'rounded-[var(--fsus-radius-lg)] border border-[#F4F4F5] bg-[#FCFCFC] p-4',
  timelineCardBoxLatest: 'border-[rgba(42,89,156,0.24)] bg-[rgba(42,89,156,0.06)]',
  timelineName: 'mb-1 text-sm font-bold tracking-normal text-[#2A599C]',
  timelineContent: 'text-[#71717A] text-sm leading-relaxed whitespace-pre-wrap break-words',
  timelineMeta: 'mt-3 text-[10px] font-mono text-[#A1A1AA] tabular-nums'
} as const;

const STAT_CARD_TEMPLATES: readonly Omit<AdminStatCardViewContract, 'value'>[] = [
  {
    label: '文章总计',
    key: 'totalArticles',
    description: '已发布内容总量',
    iconName: 'document',
    bgClass: 'bg-[rgba(42,89,156,0.08)]',
    iconClass: 'text-[#2A599C]'
  },
  {
    label: '评论总计',
    key: 'totalComments',
    description: '累计互动记录',
    iconName: 'comments',
    bgClass: 'bg-emerald-50',
    iconClass: 'text-emerald-600'
  },
  {
    label: '累计访问',
    key: 'totalVisits',
    description: '站点历史访问量',
    iconName: 'views',
    bgClass: 'bg-orange-50',
    iconClass: 'text-orange-600'
  },
  {
    label: '回收站',
    key: 'trashCount',
    description: '待恢复或清理',
    iconName: 'trash',
    bgClass: 'bg-rose-50',
    iconClass: 'text-rose-600'
  }
];

export function createAdminDashboardViewContract(
  overview: AdminStatsOverview,
  recentComments: readonly RecentCommentStatItem[] = [],
  regions: readonly RegionStatItem[] = []
): AdminDashboardViewContract {
  const stats = overview.summary;
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
      rankClassName: index < 3 ? 'text-[#2A599C] font-bold' : 'text-[#A1A1AA]',
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
    }
  };
}
