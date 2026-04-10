import type { SiteStats } from '@/api/stats';
import { TimeUtils } from '@/utils/time';

export type AdminStatCardViewContract = Readonly<{
  label: string;
  key: keyof Pick<SiteStats, 'totalArticles' | 'totalComments' | 'totalVisits' | 'trashCount'>;
  value: number;
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
  statIconWrap: 'p-4 rounded-xl flex items-center justify-center shrink-0',
  statLabel: 'text-zinc-500 text-xs font-bold mb-1 uppercase tracking-wider',
  statValue: 'text-2xl font-bold text-zinc-800 tracking-tight tabular-nums',
  chartRow: 'mb-5 grid grid-cols-1 gap-5 lg:grid-cols-3',
  chartCard: 'border-zinc-100 h-full',
  chartHeader: 'flex items-center justify-between',
  chartHeaderTitle: 'font-bold text-zinc-700',
  chartHeaderHint: 'text-zinc-400 cursor-help',
  chartBody: 'h-75 w-full',
  chartSummary: 'h-75 w-full flex flex-col justify-center gap-4 p-4',
  chartSummaryCard: 'rounded-xl border border-zinc-100 bg-zinc-50 p-4',
  chartSummaryLabel: 'text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-400',
  chartSummaryValue: 'mt-2 text-2xl font-bold text-zinc-800 tabular-nums',
  chartList: 'space-y-3 p-4',
  chartListItem: 'flex items-center gap-3',
  chartListLabel: 'min-w-0 flex-1 truncate text-sm font-medium text-zinc-600',
  chartListValue: 'text-sm font-mono font-bold text-zinc-800 tabular-nums',
  chartBarTrack: 'h-2 flex-1 rounded-full bg-zinc-100 overflow-hidden',
  chartBarFill: 'h-full rounded-full bg-gradient-to-r from-blue-400 to-blue-600',
  tableCard: 'border-zinc-100 h-full',
  tableWrap: 'overflow-hidden',
  table: 'w-full border-collapse',
  tableHead: 'border-b border-zinc-100 bg-zinc-50 text-xs uppercase tracking-[0.2em] text-zinc-400',
  tableHeadCell: 'px-4 py-3 font-bold',
  tableBodyRow: 'border-b border-zinc-50 last:border-b-0',
  tableBodyCell: 'px-4 py-4 align-middle',
  tableRank: 'font-bold',
  tableTitle: 'text-zinc-700 hover:text-blue-600 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded-sm',
  tableViews: 'inline-flex rounded-full border border-zinc-100 bg-zinc-50 px-3 py-1 text-xs font-mono font-bold text-zinc-600',
  timelineCard: 'border-zinc-100 h-full',
  timelineEmpty: 'h-75 flex flex-col items-center justify-center',
  timelineWrap: 'max-h-[320px] overflow-auto',
  timelineList: 'relative space-y-5 p-4',
  timelineItem: 'relative pl-6',
  timelineDot: 'absolute left-0 top-2 h-3 w-3 rounded-full border-2 border-blue-500 bg-white',
  timelineDotMuted: 'border-zinc-300',
  timelineCardBox: 'rounded-xl border border-zinc-100 bg-zinc-50 p-4',
  timelineCardBoxLatest: 'border-blue-100 bg-blue-50/60',
  timelineName: 'mb-1 text-sm font-bold tracking-wide text-blue-600',
  timelineContent: 'text-zinc-600 text-sm leading-relaxed whitespace-pre-wrap break-words',
  timelineMeta: 'mt-3 text-[10px] font-mono text-zinc-400 tabular-nums'
} as const;

const STAT_CARD_TEMPLATES: readonly Omit<AdminStatCardViewContract, 'value'>[] = [
  {
    label: '文章总计',
    key: 'totalArticles',
    iconName: 'document',
    bgClass: 'bg-blue-50',
    iconClass: 'text-blue-600'
  },
  {
    label: '评论总计',
    key: 'totalComments',
    iconName: 'comments',
    bgClass: 'bg-emerald-50',
    iconClass: 'text-emerald-600'
  },
  {
    label: '累计访问',
    key: 'totalVisits',
    iconName: 'views',
    bgClass: 'bg-orange-50',
    iconClass: 'text-orange-600'
  },
  {
    label: '回收站',
    key: 'trashCount',
    iconName: 'trash',
    bgClass: 'bg-rose-50',
    iconClass: 'text-rose-600'
  }
];

export function createAdminDashboardViewContract(stats: SiteStats): AdminDashboardViewContract {
  return {
    statCards: STAT_CARD_TEMPLATES.map((item) => ({
      ...item,
      value: Number(stats[item.key]) || 0
    })),
    popularArticles: (stats.popularArticles || []).map((article, index) => ({
      id: article.id,
      title: article.title,
      views: Number(article.views) || 0,
      rank: index + 1,
      rankClassName: index < 3 ? 'text-blue-600 font-bold' : 'text-zinc-400',
      href: `/article/${article.id}`
    })),
    recentComments: (stats.recentComments || []).map((comment, index) => ({
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
      labels: (stats.regionDistributions || []).slice(0, 10).map((item) => item.region.split('-').pop() || '未知'),
      values: (stats.regionDistributions || []).slice(0, 10).map((item) => Number(item.count) || 0)
    }
  };
}
