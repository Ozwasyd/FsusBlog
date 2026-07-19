import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (relativePath: string): string => fileURLToPath(
  new URL(`../../../../${relativePath}`, import.meta.url)
)

const commentComposer = readFileSync(
  repoFile('src/frontend/src/components/article/ArticleCommentComposer.vue'),
  'utf8'
)
const articleToc = readFileSync(
  repoFile('src/frontend/src/components/article/ArticleTocPanel.vue'),
  'utf8'
)
const markdown = readFileSync(
  repoFile('src/frontend/src/assets/markdown.css'),
  'utf8'
)

function ruleBody(source: string, pattern: RegExp): string {
  const body = pattern.exec(source)?.groups?.body
  expect(body).toBeDefined()
  return body ?? ''
}

function expectFontWeight(source: string, pattern: RegExp, expected: string): void {
  expect(ruleBody(source, pattern)).toMatch(
    new RegExp(`font-weight\\s*:\\s*${expected};`, 'u')
  )
}

describe('loaded font-weight role contract', () => {
  it('keeps compact comment-composer identity and feedback roles on loaded 700', () => {
    for (const pattern of [
      /\.comment-identity-label\s*\{(?<body>[^}]*)\}/u,
      /\.comment-identity-badge\s*\{(?<body>[^}]*)\}/u,
      /\.comment-identity-toggle\s*\{(?<body>[^}]*)\}/u,
      /\.comment-composer-draft\s*\{(?<body>[^}]*)\}/u,
      /\.comment-composer-preview\.is-empty\s*\{(?<body>[^}]*)\}/u,
      /\.comment-composer-feedback\s*\{(?<body>[^}]*)\}/u,
      /\.comment-composer-metrics\s*\{(?<body>[^}]*)\}/u
    ]) {
      expectFontWeight(commentComposer, pattern, '700')
    }
  })

  it('keeps the desktop TOC title on loaded 700', () => {
    expectFontWeight(
      articleToc,
      /\.article-toc-panel__title\s*\{(?<body>[^}]*)\}/u,
      '700'
    )
  })

  it('keeps blockquotes on the inherited loaded 400 Markdown weight', () => {
    expectFontWeight(markdown, /\.markdown-body\s*\{(?<body>[^}]*)\}/u, '400')
    expect(ruleBody(markdown, /\.markdown-body blockquote\s*\{(?<body>[^}]*)\}/u))
      .not.toMatch(/font-weight\s*:/u)
  })
})
