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
})
