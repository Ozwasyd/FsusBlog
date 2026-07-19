import { describe, expect, it } from 'vitest'

import { themeTokens } from '@/ui-tokens/themeTokens'

const responsiveTextScale = (classes: string): string[] => classes
  .split(/\s+/u)
  .filter((className) => /^(?:(?:sm|lg):)?text-(?:xl|2xl|3xl|4xl|5xl)$/u.test(className))

describe('public display typography contract', () => {
  it('keeps hydrated article detail titles on the AOT 20/24/30px scale', () => {
    expect(responsiveTextScale(themeTokens.articleDetail.title)).toEqual([
      'text-xl',
      'sm:text-2xl',
      'lg:text-3xl'
    ])
    expect(responsiveTextScale(themeTokens.articleDetail.title)).toEqual(
      responsiveTextScale(themeTokens.articleList.title)
    )
  })

  it('retains the loaded 700 title weight from the shared font contract', () => {
    expect(themeTokens.articleDetail.title.split(/\s+/u)).toContain('font-bold')
    expect(themeTokens.articleDetail.title).not.toMatch(/\bfont-(?:semibold|extrabold|black)\b/u)
  })
})
