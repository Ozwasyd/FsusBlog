import type { ThemeTokenContract } from '@/ui-contracts/theme';

const textPrimary = 'text-[var(--fsusblog-text-primary)]';
const textHeading = 'text-[var(--fsusblog-text-heading)]';
const textSecondary = 'text-[var(--fsusblog-text-secondary)]';
const textTertiary = 'text-[var(--fsusblog-text-tertiary)]';
const textMuted = 'text-[var(--fsusblog-text-muted)]';
const textSubtle = 'text-[var(--fsusblog-text-subtle)]';
const textDecorative = 'text-[var(--fsusblog-text-decorative)]';
const lineBorder = 'border-[var(--fsusblog-panel-border)]';
const lineBorderStrong = 'border-[var(--fsusblog-panel-border-strong)]';
const surface = 'bg-[var(--fsusblog-panel-bg)]';
const focusRing = 'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)]';
const primaryHover = 'hover:text-[var(--fsusblog-color-primary)]';
const colorTransition = 'transition-fsus transition-fsus-fast';
const microRadius = 'rounded-[var(--fsusblog-radius-control)]';
const metadataText = `text-xs sm:text-sm leading-4 sm:leading-5 font-medium ${textMuted} uppercase tracking-normal`;
const articleListMetadataText = `text-xs sm:text-sm leading-4 sm:leading-5 font-medium ${textMuted} tracking-normal`;
const numericText = 'tabular-nums';

export const themeTokens: ThemeTokenContract = {
  focusRing,
  articleList: {
    container: 'flex flex-col gap-10 sm:gap-12',
    card: 'ui-article-card group flex flex-col items-start gap-4 sm:gap-5',
    metaRow: `ui-article-meta min-h-5 flex flex-wrap items-center gap-6 ${articleListMetadataText}`,
    metaSeparator: `ui-article-meta-separator font-normal ${textDecorative}`,
    metaCategory: `ui-article-category inline-flex min-h-9 items-center -mx-1 px-1 ${microRadius} outline-none ${focusRing} ${textMuted} ${primaryHover} ${colorTransition} cursor-pointer`,
    title: `ui-article-title text-lg sm:text-xl lg:text-2xl font-bold ${textHeading} group-hover:text-[var(--fsusblog-color-primary)] ${colorTransition} leading-[1.25] sm:leading-[1.2] safe-inline-wrap tracking-normal`,
    titleLink: `flex min-h-11 items-center ${microRadius} outline-none ${focusRing} safe-inline-wrap`,
    summary: `ui-article-summary mt-2 text-sm sm:text-base font-normal ${textSecondary} leading-[1.7] line-clamp-3`,
    readLink: `ui-article-link mt-4 min-h-11 ${microRadius} text-xs sm:text-sm leading-4 sm:leading-5 font-medium tracking-normal ${textMuted} ${primaryHover} ${colorTransition} flex items-center gap-3 px-2 py-2 -ml-0.5 outline-none ${focusRing}`,
    pagination: `ui-pagination mt-24 sm:mt-32 pt-12 border-t ${lineBorder} flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-6`,
    paginationIndicator: `text-xs font-bold ${textMuted} uppercase tracking-normal ${numericText}`
  },
  articleDetail: {
    header: `mb-3 sm:mb-4 pb-3 sm:pb-4 border-b ${lineBorder}`,
    title: `text-2xl sm:text-3xl font-bold ${textHeading} leading-[1.25] sm:leading-[1.2] tracking-normal mb-8 sm:mb-10`,
    metaRow: `flex flex-wrap items-center gap-6 ${metadataText}`,
    metaSeparator: `font-normal ${textDecorative}`,
    categoryLink: `inline-flex min-h-9 items-center px-1 ${textMuted} ${primaryHover} ${colorTransition} outline-none ${focusRing}`,
    categoryText: textMuted,
    footer: `mt-12 sm:mt-16 pt-6 sm:pt-8 border-t ${lineBorder}`,
    tagList: 'flex flex-wrap gap-x-5 gap-y-2 sm:gap-x-6',
    tagLink: `inline-flex min-h-9 items-center px-1 text-xs sm:text-sm leading-4 sm:leading-5 font-medium uppercase tracking-normal ${textMuted} hover:text-[var(--fsusblog-text-primary)] ${colorTransition} outline-none ${focusRing}`,
    commentsRoot: 'mt-6 sm:mt-8 pb-20',
    commentsHeading: `text-xs font-medium ${textMuted} uppercase tracking-normal mb-6`,
    commentsPlaceholderRoot: `flex items-center justify-center gap-2 rounded-[var(--fsusblog-radius-panel)] py-3 text-xs ${textTertiary} font-medium normal-case tracking-normal shadow-none`,
    commentsPlaceholderDot: 'fsusblog-dot-loader',
    commentsPlaceholderText: `${textTertiary}`
  },
  userComments: {
    list: 'space-y-10 sm:space-y-12',
    item: `group relative pt-8 border-t ${lineBorder} first:border-t-0 sm:first:border-t`,
    itemHeader: 'flex flex-col sm:flex-row justify-between items-start gap-5 sm:gap-6 mb-5 sm:mb-6',
    articleLabel: `text-xs font-medium ${textMuted} uppercase tracking-normal`,
    articleLink: `block text-sm font-bold ${textPrimary} ${primaryHover} ${colorTransition} tracking-normal leading-snug wrap-break-word outline-none ${focusRing}`,
    time: `text-xs sm:text-sm leading-4 sm:leading-5 font-medium ${textMuted} uppercase tracking-normal shrink-0 pt-0.5 ${numericText}`,
    content: `${textTertiary} text-sm leading-relaxed whitespace-pre-wrap mb-6 wrap-break-word overflow-hidden`,
    footer: `pt-12 border-t ${lineBorderStrong} flex justify-center`,
    endHint: `text-xs font-medium tracking-normal ${textMuted} uppercase`
  },
  dashboard: {
    statGrid: 'mb-8 gap-3',
    statCard: `${surface} p-6`,
    statIconWrap: `shrink-0 ${textSubtle}`,
    statLabel: `${textMuted} text-xs font-medium mb-2 uppercase tracking-normal`,
    statValue: `text-2xl font-bold ${textPrimary} tracking-normal ${numericText}`
  }
} as const;
