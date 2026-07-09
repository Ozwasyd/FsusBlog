import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('public article rights presentation workflow', () => {
  const articlePage = readRepoFile('src/frontend/src/views/ArticleDetail.vue')
  const publicArticleContent = readRepoFile('src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue')
  const codeBlockCopy = readRepoFile('src/frontend/src/composables/article/useCodeBlockCopy.ts')
  const publicAotMapper = readRepoFile('src/backend/Infrastructure/PublicAot/PublicAotRendererPayloadMapper.cs')
  const apiDocs = readRepoFile('docs/api/contracts.md')

  it('renders a visible Rights V3 notice from decoded ArticleDetail state', () => {
    expect(publicArticleContent).toContain('data-article-rights-notice')
    expect(publicArticleContent).toContain('detailView.rights.enabled')
    expect(publicArticleContent).toContain('detailView.rights.licenseType')
    expect(publicArticleContent).toContain('detailView.rights.rightsStatement')
    expect(publicArticleContent).toContain('detailView.rights.attributionTemplate')
    expect(publicArticleContent).toContain('detailView.rights.copyPolicy')
    expect(publicArticleContent).toContain('detailView.rights.maxExcerptChars')
    expect(publicArticleContent).toContain('detailView.rights.proofUrl')
    expect(publicArticleContent).toContain('detailView.rights.contentCanonicalHash')
  })

  it('renders copyright and citation details after article tags', () => {
    expect(publicArticleContent.indexOf('data-article-rights-notice')).toBeGreaterThan(
      publicArticleContent.indexOf('<ArticleDetailTagsFooter')
    )
  })

  it('keeps the public rights notice compact instead of a tall stacked card', () => {
    expect(publicArticleContent).toContain('data-article-tail-group')
    expect(publicArticleContent).toContain('class="article-tail-group mt-8 sm:mt-10 divide-y divide-[var(--fsusblog-panel-border)] border-y border-[var(--fsusblog-panel-border)]"')
    expect(publicArticleContent).toContain('class="py-2.5"')
    expect(publicArticleContent).toContain('class="article-rights-notice py-4 sm:py-4"')
    expect(publicArticleContent).toContain('grid grid-cols-[4.5rem_minmax(0,1fr)]')
    expect(publicArticleContent).toContain('data-public-related-reading="true"\n        class="article-related-reading pt-5 pb-4 sm:pt-6 sm:pb-5"')
    expect(publicArticleContent).toContain('id="fsus-comments-island"\n      class="mt-6 sm:mt-8"')
    expect(publicArticleContent).toContain('id="fsus-comments-island-content"\n        class="min-h-0"')
    expect(publicArticleContent).not.toContain('class="mt-10 sm:mt-12 pt-6 sm:pt-8 border-t border-[var(--fsusblog-panel-border)]"')
    expect(publicArticleContent).not.toContain('class="article-rights-notice mt-6 border-y border-[var(--fsusblog-panel-border)] py-3 sm:py-4"')
    expect(publicArticleContent).not.toContain('class="mt-12 sm:mt-16 border-t border-[var(--fsusblog-panel-border)] pt-8 sm:pt-10"')
    expect(publicArticleContent).not.toContain('mt-8 border-y border-[var(--fsusblog-panel-border)] py-5')
    expect(publicArticleContent).not.toContain('class="mt-10 sm:mt-12 border-t border-[var(--fsusblog-panel-border)] pt-6 sm:pt-8"')
    expect(publicArticleContent).not.toContain('class="mt-6 sm:mt-8 border-t border-[var(--fsusblog-panel-border)] pt-4 sm:pt-5"')
    expect(publicArticleContent).not.toContain('class="border-b border-[var(--fsusblog-panel-border)] py-4"')
    expect(publicArticleContent).not.toContain('class="min-h-[10rem]"')
    expect(publicArticleContent).not.toContain('<dl class="mt-4 divide-y divide-[var(--fsusblog-panel-border)]')
    expect(publicArticleContent).not.toContain('py-3 first:pt-0')
  })

  it('uses one heading scale for adjacent rights and extended reading sections', () => {
    const rightsHeadingClass = publicArticleContent.match(/id="article-rights-notice-title"\s+class="([^"]+)"/)?.[1]
    const relatedHeadingClass = publicArticleContent.match(/id="fsus-related-reading-heading"\s+class="([^"]+)"/)?.[1]

    expect(rightsHeadingClass).toBe('text-sm font-semibold normal-case tracking-normal text-[var(--fsusblog-text-primary)]')
    expect(relatedHeadingClass).toBe(rightsHeadingClass)
  })

  it('keeps extended reading compact with matching previous and related article density', () => {
    expect(publicArticleContent).toContain('aria-label="延伸阅读文章"')
    expect(publicArticleContent).toContain('class="mt-3 divide-y divide-[var(--fsusblog-panel-border)]"')
    expect(publicArticleContent).toContain('class="py-2.5 first:pt-0 last:pb-0"')
    expect(publicArticleContent).toContain('class="group blog-motion-state-change block min-w-0"')
    expect(publicArticleContent).toContain('class="mb-0.5 block text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]"')
    expect(publicArticleContent).toContain('class="blog-link-underline text-sm font-bold leading-5 text-[var(--fsusblog-text-primary)]"')
    expect(publicArticleContent).toContain('{{ detailView.relatedReading.previous.displayTime }}')
    expect(publicArticleContent).toContain('{{ item.displayTime }}')
    expect(publicArticleContent).not.toContain('grid-cols-[4rem_minmax(0,1fr)]')
    expect(publicArticleContent).not.toContain('class="flex flex-col gap-8"')
    expect(publicArticleContent).not.toContain('class="flex flex-col gap-4"')
    expect(publicArticleContent).not.toContain('class="grid gap-4 sm:grid-cols-2"')
    expect(publicArticleContent).not.toContain('class="grid gap-3 sm:grid-cols-2"')
    expect(publicArticleContent).not.toContain('class="mt-4 grid gap-4"')
    expect(publicArticleContent).not.toContain('class="mt-2 grid gap-2"')
    expect(publicArticleContent).not.toContain('<h3 class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">')
    expect(publicArticleContent).not.toContain('v-if="item.summary"')
    expect(publicArticleContent).not.toContain('{{ item.summary }}')
    expect(publicArticleContent).not.toContain('{{ item.reason }} · {{ item.displayTime }}')
    expect(publicArticleContent).not.toContain('{{ detailView.relatedReading.previous.reason }} · {{ detailView.relatedReading.previous.displayTime }}')
  })

  it('does not add a separate public rights endpoint or side channel', () => {
    expect(articlePage).toContain('pageDetailView.value.rights.allowCodeCopy')
    expect(articlePage).not.toContain('/rights')
    expect(articlePage).not.toContain('rights.aeds')
    expect(articlePage).not.toContain('getArticleRights')
    expect(publicArticleContent).not.toContain('/rights')
  })

  it('gates code-copy enhancement with the decoded Rights V3 code flag', () => {
    expect(articlePage).toContain('useCodeBlockCopy(() => articleContentRoot.value, () => pageDetailView.value.rights.allowCodeCopy)')
    expect(codeBlockCopy).toContain('allowCodeCopy: MaybeRefOrGetter<boolean>')
    expect(codeBlockCopy).toContain('if (!toValue(allowCodeCopy))')
    expect(codeBlockCopy).toContain('cleanup()')
  })

  it('keeps PublicAOT ArticleDetail rights metadata in the same hydration payload', () => {
    expect(publicAotMapper).toContain('common["rights"] = ToRightsPayload(article.Rights)')
    expect(publicArticleContent).toContain('itemprop="license"')
    expect(publicArticleContent).toContain('itemprop="copyrightHolder"')
    expect(publicArticleContent).toContain('itemprop="copyrightYear"')
  })

  it('documents the public article Rights V3 behavior', () => {
    expect(apiDocs).toContain('Public Rights V3 presentation')
    expect(apiDocs).toContain('does not request a separate rights endpoint')
    expect(apiDocs).toContain('allowCodeCopy')
    expect(apiDocs).toContain('PublicAOT ArticleDetail output includes rights metadata')
  })
})
