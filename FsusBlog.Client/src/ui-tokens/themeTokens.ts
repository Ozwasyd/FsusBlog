import type { ThemeTokenContract } from '@/ui-contracts/theme';

export const themeTokens: ThemeTokenContract = {
  articleList: {
    container: 'flex flex-col gap-10 sm:gap-14 lg:gap-16',
    card: 'ui-article-card group flex flex-col items-start gap-5 sm:gap-6 subpixel-antialiased',
    metaRow: 'ui-article-meta min-h-5 flex flex-wrap items-center gap-5 text-[11px] sm:text-xs font-mono font-medium text-[#A1A1AA] uppercase dark:text-[#A1A1AA]',
    metaSeparator: 'ui-article-meta-separator text-[#D4D4D8] font-light dark:text-[#3F3F46]',
    metaCategory: 'ui-article-category text-[#71717A] dark:text-[#A1A1AA]',
    title: 'ui-article-title min-h-[3.5rem] sm:min-h-[4.25rem] text-xl sm:text-2xl font-bold text-[#0F0F11] dark:text-[#FCFCFC] group-hover:text-[#2A599C] dark:group-hover:text-[#F4F4F5] transition-colors duration-300 leading-snug safe-inline-wrap',
    titleLink: 'block rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0F0F11] safe-inline-wrap',
    summary: 'ui-article-summary min-h-[4.5rem] sm:min-h-[5.75rem] text-sm sm:text-base text-[#71717A] dark:text-[#D4D4D8] leading-relaxed sm:leading-loose line-clamp-3',
    readLink: 'ui-article-link mt-2 rounded-[8px] text-[11px] sm:text-xs font-bold uppercase text-[#0F0F11] dark:text-[#F4F4F5] hover:text-[#2A599C] dark:hover:text-[#D4D4D8] transition-colors flex items-center gap-2 py-2 -ml-0.5 outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0F0F11]',
    pagination: 'ui-pagination mt-16 sm:mt-20 pt-8 border-t border-[#F4F4F5] dark:border-[#27272A] flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-4',
    paginationButton: 'rounded-[8px] text-xs font-bold uppercase transition-colors text-[#A1A1AA] dark:text-[#A1A1AA] hover:text-[#2A599C] dark:hover:text-[#F4F4F5] px-4 py-4 sm:p-6 min-h-11 outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]',
    paginationButtonDisabled: 'opacity-30 cursor-not-allowed',
    paginationIndicator: 'text-xs font-mono font-medium text-[#D4D4D8] dark:text-[#71717A] tabular-nums'
  },
  articleDetail: {
    header: 'mb-10 sm:mb-16 pb-8 sm:pb-12 border-b border-[#F4F4F5] dark:border-[#27272A]',
    title: 'text-2xl sm:text-4xl font-bold text-[#0F0F11] dark:text-[#FCFCFC] leading-tight sm:leading-snug mb-5 sm:mb-6',
    metaRow: 'flex flex-wrap items-center gap-5 text-[10px] sm:text-xs font-mono font-medium text-[#A1A1AA] dark:text-[#A1A1AA] uppercase',
    metaSeparator: 'text-[#D4D4D8] dark:text-[#3F3F46] font-light',
    categoryLink: 'rounded-[8px] text-[#71717A] dark:text-[#A1A1AA] hover:text-[#2A599C] dark:hover:text-[#F4F4F5] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]',
    categoryText: 'text-[#71717A] dark:text-[#A1A1AA]',
    footer: 'mt-12 sm:mt-24 pt-8 sm:pt-10 border-t border-[#F4F4F5] dark:border-[#27272A]',
    tagList: 'flex flex-wrap gap-5 sm:gap-6',
    tagLink: 'rounded-[8px] text-[11px] sm:text-sm font-medium text-[#A1A1AA] dark:text-[#A1A1AA] hover:text-[#2A599C] dark:hover:text-[#F4F4F5] transition-colors px-0 py-1.5 sm:p-0 outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]',
    commentsRoot: 'mt-16 sm:mt-24 pt-12 border-t border-[#0F0F11]/5 dark:border-[#F4F4F5]/8 pb-24',
    commentsHeading: 'text-[10px] sm:text-xs font-bold text-[#A1A1AA] dark:text-[#A1A1AA] uppercase mb-8',
    commentsPlaceholderRoot: 'min-h-[5.5rem] rounded-[var(--fsus-radius-xl)] border border-dashed border-[#F4F4F5] dark:border-[#27272A] bg-[#FCFCFC]/60 dark:bg-[#18181B]/70 px-5 py-5 sm:px-6 sm:py-6',
    commentsPlaceholderTitle: 'text-sm sm:text-base font-bold text-[#0F0F11] dark:text-[#FCFCFC]',
    commentsPlaceholderBody: 'mt-1.5 text-sm sm:text-base text-[#71717A] dark:text-[#D4D4D8] leading-relaxed',
    commentsPlaceholderHint: 'mt-2 text-[10px] sm:text-xs font-mono uppercase text-[#A1A1AA] dark:text-[#A1A1AA]'
  },
  userComments: {
    list: 'space-y-10 sm:space-y-12',
    item: 'group relative pt-8 border-t border-[#F4F4F5] dark:border-[#27272A] first:border-t-0 sm:first:border-t',
    itemHeader: 'flex flex-col sm:flex-row justify-between items-start gap-5 sm:gap-6 mb-5 sm:mb-6',
    articleLabel: 'text-[9px] font-bold text-[#A1A1AA] uppercase tracking-normal',
    articleLink: 'block text-sm font-bold text-[#0F0F11] dark:text-[#FCFCFC] hover:text-[#2A599C] dark:hover:text-[#D4D4D8] transition-colors tracking-normal leading-snug wrap-break-word outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-1 focus-visible:ring-inset dark:focus-visible:ring-[#F4F4F5] rounded-[var(--fsus-radius-sm)]',
    time: 'text-[10px] font-mono font-bold text-[#D4D4D8] dark:text-[#71717A] uppercase tracking-normal shrink-0 pt-0.5 tabular-nums',
    content: 'text-[#71717A] dark:text-[#D4D4D8] text-sm leading-relaxed whitespace-pre-wrap mb-6 wrap-break-word overflow-hidden',
    deleteAction: 'text-[9px] font-bold uppercase tracking-normal text-[#D4D4D8] dark:text-[#FCFCFC] hover:text-[#E5484D] dark:hover:text-[#FDA4AF] transition-colors duration-300 py-3 -mr-3 px-3 active:scale-95 outline-none focus-visible:text-[#E5484D] dark:focus-visible:text-[#FDA4AF]',
    footer: 'pt-12 border-t border-[#0F0F11] dark:border-[#F4F4F5]/10 flex justify-center',
    loadMoreButton: 'w-full sm:w-auto px-10 py-4 sm:py-3 border border-[#0F0F11] dark:border-[#F4F4F5] text-[10px] font-black tracking-normal uppercase transition-all duration-300 active:bg-[#0F0F11] active:text-white dark:active:bg-[#F4F4F5] dark:active:text-[#0F0F11] sm:hover:border-[#2A599C] sm:hover:text-[#2A599C] dark:sm:hover:border-[#7EA7E0] dark:sm:hover:text-[#7EA7E0] disabled:opacity-30 outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-1 focus-visible:ring-inset dark:focus-visible:ring-[#F4F4F5]',
    endHint: 'text-[9px] font-bold tracking-normal text-[#D4D4D8] dark:text-[#71717A] uppercase'
  },
  dashboard: {
    statGrid: 'mb-5',
    statCard: 'border-none transition-all duration-300 hover:-translate-y-1',
    statIconWrap: 'p-6 rounded-[var(--fsus-radius-lg)] flex items-center justify-center shrink-0',
    statLabel: 'text-[#FCFCFC] dark:text-[#A1A1AA] text-xs font-bold mb-1 uppercase tracking-normal',
    statValue: 'text-2xl font-bold text-[#27272A] dark:text-[#F4F4F5] tracking-normal tabular-nums'
  },
  primitives: {
    buttonBase: 'ui-button inline-flex min-w-0 items-center justify-center rounded-[8px] font-bold uppercase transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0F0F11]',
    buttonSizes: {
      sm: 'min-h-10 px-3 py-2 text-[10px]',
      md: 'min-h-11 px-5 py-3 text-xs',
      lg: 'min-h-12 px-6 py-4 text-xs'
    },
    buttonVariants: {
      plain: 'bg-transparent text-[#0F0F11] underline underline-offset-4 hover:text-[#2A599C] dark:text-[#F4F4F5] dark:hover:text-[#D4D4D8]',
      quiet: 'bg-transparent text-[#A1A1AA] hover:text-[#2A599C] dark:text-[#A1A1AA] dark:hover:text-[#F4F4F5]',
      primary: 'bg-[#0F0F11] text-white hover:bg-[#2A599C] dark:bg-[#F4F4F5] dark:text-[#0F0F11] dark:hover:bg-[#E4E4E7]',
      secondary: 'border border-[#E4E4E7] bg-[#FCFCFC] text-[#0F0F11] hover:border-[#2A599C] hover:text-[#2A599C] dark:border-[#27272A] dark:bg-[#18181B] dark:text-[#F4F4F5] dark:hover:border-[#7EA7E0] dark:hover:text-[#7EA7E0]'
    },
    buttonTones: {
      neutral: '',
      danger: 'text-[#E5484D] hover:text-[#B4232A] focus-visible:ring-[#E5484D]'
    },
    emptyRoot: 'ui-empty safe-inline-wrap py-20 text-left',
    emptyTitle: 'ui-empty-title text-sm font-medium uppercase tracking-normal text-[#A1A1AA] dark:text-[#A1A1AA]',
    emptyBody: 'ui-empty-body mt-3 text-sm leading-relaxed text-[#71717A] dark:text-[#D4D4D8]',
    buttonDisabled: 'opacity-30 cursor-not-allowed pointer-events-none',
    tagBase: 'ui-tag inline-flex min-w-0 items-center rounded-[999px] font-mono font-medium uppercase tracking-normal',
    tagVariants: {
      ghost: 'text-[11px] sm:text-xs',
      badge: 'border px-2.5 py-1 text-[10px]',
      status: 'border px-2 py-0.5 text-[9px] font-bold'
    },
    tagTones: {
      neutral: 'border-[#E4E4E7] text-[#A1A1AA] dark:border-[#27272A] dark:text-[#A1A1AA]',
      info: 'border-[rgba(42,89,156,0.24)] bg-[rgba(42,89,156,0.06)] text-[#2A599C] dark:text-[#7EA7E0]',
      success: 'border-[#BBF7D0] bg-[#F0FDF4] text-[#166534] dark:border-[#14532D] dark:bg-[#052E16] dark:text-[#86EFAC]',
      danger: 'border-[#FECACA] bg-[#FEF2F2] text-[#E5484D] dark:border-[#7F1D1D] dark:bg-[#2A1212] dark:text-[#FDA4AF]',
      warning: 'border-[#FED7AA] bg-[#FFF7ED] text-[#A16207] dark:border-[#7C2D12] dark:bg-[#2A1608] dark:text-[#FDBA74]'
    },
    surfacePanel: 'border border-[var(--fsus-panel-border)] rounded-[24px] bg-[rgba(255,255,255,0.76)] shadow-[0_24px_54px_rgba(15,23,42,0.07),inset_0_1px_0_rgba(255,255,255,0.72)] backdrop-blur-[32px]',
    dialogPanel: 'border border-[#E4E4E7] rounded-[24px] bg-[var(--fsus-panel-bg)]/90 shadow-[0_32px_64px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.8)] backdrop-blur-[40px]',
    metaText: 'text-[10px] font-mono font-medium uppercase tracking-normal text-[#A1A1AA]',
    statusText: 'text-[10px] font-bold uppercase tracking-normal text-[#A1A1AA]'
  }
} as const;
