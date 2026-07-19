import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

const markdown = readSource('src/assets/markdown.css')
const comment = readSource('src/components/article/CommentMarkdownRenderer.vue')
const preview = readSource('src/components/admin/article/ArticleBodyMarkdownPreview.vue')

describe('shared reading typography contract', () => {
  it('keeps article, about, comment, and preview on the 16px/400/1.8 baseline', () => {
    expect(markdown).toMatch(/\.markdown-body\s*\{[^}]*font-size:\s*1rem;[^}]*line-height:\s*1\.8;[^}]*letter-spacing:\s*normal;[^}]*font-weight:\s*400;/su)
    expect(comment).toMatch(/\.comment-markdown-renderer\s*\{[^}]*font-size:\s*16px;[^}]*font-weight:\s*400;[^}]*line-height:\s*1\.8;/su)
    expect(comment).not.toMatch(/font-family:\s*monospace|font-size:\s*14px\s*!important|line-height:\s*1\.6\s*!important/u)
    expect(preview).toContain('mode="preview"')
  })

  it('uses only the 20/24px reading heading tiers on a shared left baseline', () => {
    expect(markdown).toMatch(/\.markdown-body h1\s*\{[^}]*font-size:\s*1\.5rem;[^}]*text-align:\s*left;/su)
    expect(markdown).toMatch(/\.markdown-body h2\s*\{[^}]*font-size:\s*1\.25rem;[^}]*text-align:\s*left;/su)
    expect(markdown).toMatch(/\.markdown-body h3\s*\{[^}]*font-size:\s*1\.25rem;[^}]*text-align:\s*left;/su)
    expect(markdown).not.toMatch(/\.markdown-body--article h1\s*\{|\.markdown-body h[1-6][^{]*\{[^}]*text-align:\s*(?:center|justify)|letter-spacing:\s*-|font-size:\s*1\.(?:05|15|4|6)em/su)
  })

  it('uses one exact mono stack and contains long code horizontally', () => {
    const canonical = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
    expect(markdown).toContain(`font-family: ${canonical};`)
    expect(markdown).toContain(`font-family: ${canonical} !important;`)
    expect(markdown).not.toMatch(/font-family:[^;]*(?:Monaco|Consolas|var\(--font-sans\))/u)
    expect(markdown).toMatch(/\.markdown-body \.shiki\s*\{[^}]*overflow-x:\s*auto;/su)
    expect(comment).toMatch(/\.fsus-markdown-body :deep\(\.markdown-body pre\),[\s\S]*?overflow-x:\s*auto;/u)
  })

  it('keeps quotes on the body size and aligns reading blocks', () => {
    expect(markdown).toMatch(/\.markdown-body blockquote\s*\{[^}]*margin:\s*1\.5rem 0 !important;[^}]*padding:\s*0 !important;/su)
    expect(markdown.match(/\.markdown-body blockquote\s*\{(?<body>[^}]*)\}/u)?.groups?.body).not.toMatch(/font-size|font-weight/u)
    expect(markdown).toMatch(/\.markdown-body (?:ul|ol)\s*\{[^}]*margin:\s*1\.5rem 0;/su)
  })
})
