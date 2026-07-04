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
