import type { ArchiveArticleViewContract, ArchiveMonthGroupViewContract, ArchivePageViewContract, ArchiveYearGroupViewContract } from '@/view-contracts/archive'

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case '\'':
        return '&#39;'
      default:
        return char
    }
  })
}

function renderArchiveArticle(item: ArchiveArticleViewContract): string {
  return [
    '<article class="relative group">',
    `<a href="/article/${item.id}" data-aot-action="open-article" data-aot-id="${item.id}" class="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-6 group py-1 sm:py-0 outline-none">`,
    `<time datetime="${escapeHtml(item.createTime)}" title="${escapeHtml(item.fullLocalTimeText)}" class="flex-none text-xs sm:text-sm font-mono text-zinc-400 group-hover:text-zinc-950 transition-colors w-12 tabular-nums">${escapeHtml(item.dayText)}</time>`,
    `<span class="text-base sm:text-lg font-medium text-zinc-600 group-hover:text-zinc-950 transition-colors leading-snug border-b border-transparent group-hover:border-zinc-950 pb-0.5">${escapeHtml(item.title)}</span>`,
    '</a>',
    '</article>'
  ].join('')
}

function renderArchiveMonth(monthGroup: ArchiveMonthGroupViewContract): string {
  return [
    '<div class="relative">',
    `<h3 class="text-xs font-black tracking-[0.3em] text-zinc-400 uppercase mb-6 flex items-center gap-4">${escapeHtml(monthGroup.monthLabel)}<span class="h-px grow bg-zinc-100/80" aria-hidden="true"></span></h3>`,
    `<div class="space-y-6">${monthGroup.items.map((item) => renderArchiveArticle(item)).join('')}</div>`,
    '</div>'
  ].join('')
}

function renderArchiveYear(yearGroup: ArchiveYearGroupViewContract, yearIndex: number): string {
  return [
    `<section class="relative animate-in slide-in-from-bottom-4 fade-in duration-700" style="--stagger:${yearIndex}">`,
    '<div class="sticky top-20 z-10 bg-white py-3 mb-10 flex items-center">',
    '<div class="absolute left-0 w-9 h-9 bg-white flex items-center justify-center">',
    '<div class="w-2.5 h-2.5 rounded-full bg-zinc-950 ring-4 ring-white"></div>',
    '</div>',
    `<h2 class="text-3xl sm:text-4xl font-bold text-zinc-950 pl-12 font-mono tracking-tighter">${escapeHtml(yearGroup.year)}</h2>`,
    '</div>',
    `<div class="space-y-14 pl-12">${yearGroup.months.map((month) => renderArchiveMonth(month)).join('')}</div>`,
    '</section>'
  ].join('')
}

export function renderArchiveAot(view: ArchivePageViewContract): string {
  const header = [
    '<header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">',
    '<h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6">归档</h1>',
    '<div class="flex items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">',
    '<span>目前发布</span>',
    '<span class="text-zinc-300 font-light" aria-hidden="true">/</span>',
    `<span class="text-zinc-950 font-bold tabular-nums">${view.total}</span>`,
    '</div>',
    '</header>'
  ].join('')

  const body = view.yearGroups.length > 0
    ? [
        '<div class="relative pb-24">',
        '<div class="absolute left-4.5 top-3 bottom-0 w-px bg-zinc-200 z-0"></div>',
        `<div class="space-y-20">${view.yearGroups.map((yearGroup, yearIndex) => renderArchiveYear(yearGroup, yearIndex)).join('')}</div>`,
        '</div>'
      ].join('')
    : [
        '<div class="py-32 text-center">',
        `<p class="text-[11px] font-mono text-zinc-300 uppercase tracking-widest">${escapeHtml(view.emptyState.title)}</p>`,
        '</div>'
      ].join('')

  return [
    '<div class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen">',
    header,
    body,
    '</div>'
  ].join('')
}
