import type { ThemeTokenContract } from '@/ui-contracts/theme';

export const themeTokens: ThemeTokenContract = {
  articleList: {
    container: 'flex flex-col gap-12 sm:gap-20',
    card: 'ui-article-card group flex flex-col items-start gap-3 sm:gap-4 subpixel-antialiased',
    metaRow: 'ui-article-meta min-h-5 flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase',
    metaSeparator: 'ui-article-meta-separator text-zinc-300 font-light',
    metaCategory: 'ui-article-category text-zinc-600',
    title: 'ui-article-title min-h-[3.5rem] sm:min-h-[4.25rem] text-xl sm:text-2xl font-bold text-zinc-950 group-hover:text-zinc-500 transition-colors duration-300 leading-snug',
    titleLink: 'block',
    summary: 'ui-article-summary min-h-[4.5rem] sm:min-h-[5.75rem] text-sm sm:text-base text-zinc-600 leading-relaxed sm:leading-loose line-clamp-3',
    readLink: 'ui-article-link mt-2 text-[11px] sm:text-xs font-bold tracking-[0.2em] uppercase text-zinc-950 hover:text-zinc-500 transition-colors flex items-center gap-2 py-2 -ml-0.5',
    pagination: 'ui-pagination mt-20 pt-8 border-t border-zinc-100 flex justify-between items-center',
    paginationButton: 'text-xs font-bold tracking-[0.2em] uppercase transition-colors text-zinc-400 hover:text-zinc-950 p-4 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950',
    paginationButtonDisabled: 'opacity-30 cursor-not-allowed',
    paginationIndicator: 'text-xs font-mono font-medium text-zinc-300 tabular-nums'
  },
  articleDetail: {
    header: 'mb-10 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100',
    title: 'text-2xl sm:text-4xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-5 sm:mb-6 tracking-tight',
    metaRow: 'flex flex-wrap items-center gap-3 text-[10px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase',
    metaSeparator: 'text-zinc-300 font-light',
    categoryLink: 'text-zinc-500 hover:text-zinc-950 transition-colors',
    categoryText: 'text-zinc-500',
    footer: 'mt-12 sm:mt-24 pt-8 sm:pt-10 border-t border-zinc-100',
    tagList: 'flex flex-wrap gap-3 sm:gap-4',
    tagLink: 'text-[11px] sm:text-sm font-medium text-zinc-400 hover:text-zinc-950 transition-colors px-0 py-1.5 sm:p-0',
    commentsRoot: 'mt-16 sm:mt-24 pt-12 border-t border-zinc-950/5 pb-24',
    commentsHeading: 'text-[10px] sm:text-xs font-bold tracking-[0.2em] text-zinc-400 uppercase mb-8',
    commentsPlaceholderRoot: 'min-h-[11rem] rounded-3xl border border-dashed border-zinc-100 bg-zinc-50/60 px-6 py-8 sm:px-8 sm:py-10',
    commentsPlaceholderTitle: 'text-sm sm:text-base font-bold text-zinc-950',
    commentsPlaceholderBody: 'mt-2 text-sm sm:text-base text-zinc-500 leading-relaxed',
    commentsPlaceholderHint: 'mt-4 text-[10px] sm:text-xs font-mono uppercase tracking-[0.2em] text-zinc-400'
  },
  userComments: {
    list: 'space-y-10 sm:space-y-12',
    item: 'group relative pt-8 border-t border-zinc-100 first:border-t-0 sm:first:border-t',
    itemHeader: 'flex flex-col sm:flex-row justify-between items-start gap-3 sm:gap-6 mb-5 sm:mb-6',
    articleLabel: 'text-[9px] font-bold text-zinc-400 uppercase tracking-[0.2em]',
    articleLink: 'block text-sm font-bold text-zinc-950 hover:text-zinc-500 transition-colors tracking-wide leading-snug wrap-break-word outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 rounded-sm',
    time: 'text-[10px] font-mono font-bold text-zinc-300 uppercase tracking-widest shrink-0 pt-0.5 tabular-nums',
    content: 'text-zinc-600 text-sm leading-relaxed whitespace-pre-wrap mb-6 wrap-break-word overflow-hidden',
    deleteAction: 'text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-300 hover:text-zinc-950 transition-colors duration-300 py-3 -mr-3 px-3 active:scale-95 outline-none focus-visible:text-zinc-950',
    footer: 'pt-12 border-t border-zinc-950 flex justify-center',
    loadMoreButton: 'w-full sm:w-auto px-10 py-4 sm:py-3 border border-zinc-950 text-[10px] font-black tracking-[0.3em] uppercase transition-all duration-300 active:bg-zinc-950 active:text-white sm:hover:bg-zinc-950 sm:hover:text-white disabled:opacity-30 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950',
    endHint: 'text-[9px] font-bold tracking-[0.3em] text-zinc-300 uppercase'
  },
  dashboard: {
    statGrid: 'mb-5',
    statCard: 'border-none transition-all duration-300 hover:-translate-y-1',
    statIconWrap: 'p-4 rounded-xl flex items-center justify-center shrink-0',
    statLabel: 'text-zinc-500 text-xs font-bold mb-1 uppercase tracking-wider',
    statValue: 'text-2xl font-bold text-zinc-800 tracking-tight tabular-nums'
  },
  primitives: {
    tagGhost: 'ui-tag ui-tag--ghost hidden sm:inline text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase',
    emptyRoot: 'ui-empty py-20 text-center',
    emptyTitle: 'ui-empty-title text-sm font-medium tracking-widest uppercase text-zinc-400',
    emptyBody: 'ui-empty-body mt-3 text-sm text-zinc-500',
    buttonPlain: 'ui-button ui-button--plain text-xs font-bold underline hover:text-zinc-950 uppercase tracking-widest',
    buttonQuiet: 'ui-button ui-button--quiet text-xs font-bold tracking-[0.2em] uppercase transition-colors text-zinc-400 hover:text-zinc-950 p-4 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950',
    buttonPrimary: 'ui-button ui-button--primary inline-flex items-center justify-center rounded-xl bg-zinc-950 px-4 py-2 text-xs font-bold tracking-[0.2em] uppercase text-white transition-colors hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-zinc-950',
    buttonDisabled: 'opacity-30 cursor-not-allowed'
  }
} as const;
