import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const componentPath = fileURLToPath(new URL(
  '../../../../src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue',
  import.meta.url
))
const source = readFileSync(componentPath, 'utf8')

describe('PublicArticleDetailPageContent visual contracts', () => {
  it('documents the Chinese reading-line rationale without changing the 760px column', () => {
    expect(source).toContain('<!-- 760px 将中文正文行长控制在舒适阅读范围，避免宽屏下单行文字过长。 -->')
    expect(source).toContain('max-w-[760px]')
  })

  it('promotes the comments heading with the recommended option A hierarchy', () => {
    expect(source).toMatch(
      /id="comments"\s+class="mb-6 border-b border-\[var\(--fsusblog-panel-border\)\] pb-4 text-sm font-bold normal-case text-\[var\(--fsusblog-text-primary\)\]"/u
    )
  })

  it('separates appendix copyright, tags, and the related-reading label', () => {
    expect(source).toMatch(/\.fsus-appendix\s*\{[^}]*gap:\s*24px;/su)
    expect(source).toMatch(
      /\.fsus-appendix__copyright\s*\{[^}]*padding:\s*16px;[^}]*border-radius:\s*var\(--fsusblog-radius-control, 6px\);[^}]*background:\s*var\(--fsusblog-page-bg-soft\);[^}]*color:\s*var\(--fsusblog-text-tertiary\);[^}]*font-size:\s*13px;[^}]*font-weight:\s*400;[^}]*line-height:\s*1\.7;/su
    )
    expect(source).toMatch(
      /\.fsus-appendix__nav-label\s*\{[^}]*margin-bottom:\s*12px;[^}]*color:\s*var\(--fsusblog-text-muted\);[^}]*font-size:\s*12px;[^}]*font-weight:\s*700;[^}]*letter-spacing:\s*0\.05em;[^}]*text-transform:\s*uppercase;/su
    )
    expect(source).toMatch(
      /\.fsus-appendix__tag:hover,\s*\.fsus-appendix__tag:focus-visible\s*\{[^}]*color:\s*var\(--fsusblog-text-primary\) !important;/su
    )
  })
})
