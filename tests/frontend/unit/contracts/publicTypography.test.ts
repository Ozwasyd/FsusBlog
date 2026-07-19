import { describe, expect, it } from 'vitest'

import { themeTokens } from '@/ui-tokens/themeTokens'

const responsiveTextScale = (classes: string): string[] => classes
  .split(/\s+/u)
  .filter((className) => /^(?:(?:sm|lg):)?text-(?:lg|xl|2xl|3xl|4xl|5xl)$/u.test(className))

describe('public display typography contract', () => {
  it('keeps article list titles on the 18/20/24px list scale', () => {
    expect(responsiveTextScale(themeTokens.articleList.title)).toEqual([
      'text-lg',
      'sm:text-xl',
      'lg:text-2xl'
    ])
    expect(themeTokens.articleList.title).toContain('leading-[1.25]')
    expect(themeTokens.articleList.title).toContain('sm:leading-[1.2]')
  })

  it('keeps hydrated article detail titles on the 24/30px page scale', () => {
    expect(responsiveTextScale(themeTokens.articleDetail.title)).toEqual([
      'text-2xl',
      'sm:text-3xl'
    ])
    expect(themeTokens.articleDetail.title).toContain('leading-[1.25]')
    expect(themeTokens.articleDetail.title).toContain('sm:leading-[1.2]')
  })

  it('retains the loaded 700 title weight from the shared font contract', () => {
    expect(themeTokens.articleDetail.title.split(/\s+/u)).toContain('font-bold')
    expect(themeTokens.articleDetail.title).not.toMatch(/\bfont-(?:semibold|extrabold|black)\b/u)
  })

  it('uses stable article list summary, metadata, CTA, and feed spacing roles', () => {
    expect(themeTokens.articleList.summary).toContain('text-sm sm:text-base')
    expect(themeTokens.articleList.summary).toContain('font-normal')
    expect(themeTokens.articleList.summary).toContain('leading-[1.7]')
    expect(themeTokens.articleList.summary).not.toMatch(/\bfont-light\b|sm:leading-\[1\.9\]/u)

    expect(themeTokens.articleList.metaRow).not.toMatch(/\buppercase\b/u)
    expect(themeTokens.articleList.readLink).not.toMatch(/\buppercase\b/u)
    expect(themeTokens.articleList.readLink).toContain('text-[var(--fsusblog-text-muted)]')
    expect(themeTokens.articleList.readLink).toContain('hover:text-[var(--fsusblog-color-primary)]')
    expect(themeTokens.articleList.container).toBe('flex flex-col gap-10 sm:gap-12')
  })
})
