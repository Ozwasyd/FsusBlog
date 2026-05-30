import type { ThemeTokenContract } from '@/ui-contracts/theme';

const textPrimary = 'text-[var(--fsusblog-text-primary)]';
const textSecondary = 'text-[var(--fsusblog-text-secondary)]';
const textTertiary = 'text-[var(--fsusblog-text-tertiary)]';
const textMuted = 'text-[var(--fsusblog-text-muted)]';
const textSubtle = 'text-[var(--fsusblog-text-subtle)]';
const lineBorder = 'border-[var(--fsusblog-panel-border)]';
const lineBorderStrong = 'border-[var(--fsusblog-panel-border-strong)]';
const surface = 'bg-[var(--fsusblog-panel-bg)]';
const surfaceSoft = 'bg-[var(--fsusblog-panel-bg-soft)]';
const pageSurfaceTranslucent = 'bg-[var(--fsusblog-page-bg)]/50';
const focusRing = 'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)]';
const primaryHover = 'hover:text-[var(--fsusblog-color-primary)]';
const colorTransition = 'transition-colors duration-[var(--fsus-motion-control-fast)] ease-[var(--fsus-motion-standard)]';
const stateTransition = 'transition-[background-color,border-color,color,opacity] duration-[var(--fsus-motion-control-fast)] ease-[var(--fsus-motion-standard)]';
const microRadius = 'rounded-[var(--fsus-radius-control)]';
const metadataText = `text-[10px] sm:text-[11px] font-bold ${textMuted} uppercase tracking-normal`;
const numericText = 'tabular-nums';

export const themeTokens: ThemeTokenContract = {
  articleList: {
    container: 'flex flex-col gap-20 sm:gap-28 lg:gap-32',
    card: 'ui-article-card group flex flex-col items-start gap-6 sm:gap-8',
    metaRow: `ui-article-meta min-h-5 flex flex-wrap items-center gap-6 ${metadataText}`,
    metaSeparator: `ui-article-meta-separator ${textSubtle} font-thin`,
    metaCategory: `ui-article-category ${textMuted} ${primaryHover} ${colorTransition} cursor-pointer`,
    title: `ui-article-title text-xl sm:text-2xl lg:text-3xl font-bold ${textPrimary} group-hover:text-[var(--fsusblog-color-primary)] ${colorTransition} leading-[1.1] sm:leading-[1.05] safe-inline-wrap tracking-normal`,
    titleLink: `block ${microRadius} outline-none ${focusRing} safe-inline-wrap`,
    summary: `ui-article-summary mt-2 text-base sm:text-lg ${textSecondary} leading-[1.8] sm:leading-[1.9] line-clamp-3 font-light`,
    readLink: `ui-article-link mt-4 ${microRadius} text-[10px] sm:text-xs font-bold uppercase tracking-normal ${textPrimary} ${primaryHover} ${colorTransition} flex items-center gap-3 py-2 -ml-0.5 outline-none ${focusRing}`,
    pagination: `ui-pagination mt-24 sm:mt-32 pt-12 border-t ${lineBorder} flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-6`,
    paginationIndicator: `text-xs font-bold ${textSubtle} uppercase tracking-normal ${numericText}`
  },
  articleDetail: {
    header: `mb-16 sm:mb-24 pb-12 sm:pb-16 border-b ${lineBorder}`,
    title: `text-2xl sm:text-4xl lg:text-5xl font-bold ${textPrimary} leading-[1.1] sm:leading-[1.05] tracking-normal mb-8 sm:mb-10`,
    metaRow: `flex flex-wrap items-center gap-6 ${metadataText}`,
    metaSeparator: `${textSubtle} font-thin`,
    categoryLink: `${textMuted} ${primaryHover} ${colorTransition} outline-none ${focusRing}`,
    categoryText: textMuted,
    footer: `mt-20 sm:mt-32 pt-12 sm:pt-16 border-t ${lineBorder}`,
    tagList: 'flex flex-wrap gap-6 sm:gap-8',
    tagLink: `text-[11px] sm:text-xs font-bold uppercase tracking-normal ${textMuted} hover:text-[var(--fsusblog-text-primary)] ${colorTransition} outline-none ${focusRing}`,
    commentsRoot: `mt-24 sm:mt-32 pt-16 border-t ${lineBorder} pb-32`,
    commentsHeading: `text-[11px] font-black ${textMuted} uppercase tracking-normal mb-12`,
    commentsPlaceholderRoot: `min-h-[6rem] border ${lineBorder} ${pageSurfaceTranslucent} px-8 py-8 sm:px-10 sm:py-10 backdrop-blur-[var(--fsus-backdrop-blur-soft)]`,
    commentsPlaceholderTitle: `text-base sm:text-lg font-bold ${textPrimary} tracking-normal`,
    commentsPlaceholderBody: `mt-3 text-sm sm:text-base ${textSecondary} leading-relaxed font-light`,
    commentsPlaceholderHint: `mt-4 text-[10px] font-bold uppercase tracking-normal ${textSubtle}`
  },
  userComments: {
    list: 'space-y-10 sm:space-y-12',
    item: `group relative pt-8 border-t ${lineBorder} first:border-t-0 sm:first:border-t`,
    itemHeader: 'flex flex-col sm:flex-row justify-between items-start gap-5 sm:gap-6 mb-5 sm:mb-6',
    articleLabel: `text-[9px] font-black ${textMuted} uppercase tracking-normal`,
    articleLink: `block text-sm font-bold ${textPrimary} ${primaryHover} ${colorTransition} tracking-normal leading-snug wrap-break-word outline-none ${focusRing}`,
    time: `text-[10px] font-bold ${textSubtle} uppercase tracking-normal shrink-0 pt-0.5 ${numericText}`,
    content: `${textTertiary} text-sm leading-relaxed whitespace-pre-wrap mb-6 wrap-break-word overflow-hidden`,
    footer: `pt-12 border-t ${lineBorderStrong} flex justify-center`,
    endHint: `text-[9px] font-black tracking-normal ${textSubtle} uppercase`
  },
  dashboard: {
    statGrid: `mb-8 gap-px ${surfaceSoft}`,
    statCard: `${surface} p-8 ${stateTransition} hover:bg-[var(--fsusblog-panel-bg-soft)]`,
    statIconWrap: `shrink-0 ${textSubtle}`,
    statLabel: `${textMuted} text-[10px] font-black mb-2 uppercase tracking-normal`,
    statValue: `text-4xl font-bold ${textPrimary} tracking-normal ${numericText}`
  }
} as const;
