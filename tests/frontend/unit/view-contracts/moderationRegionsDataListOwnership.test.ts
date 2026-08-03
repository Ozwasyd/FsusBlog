import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../../../../src/frontend/src/views/admin/moderation/ModerationRegions.vue', import.meta.url),
  'utf8'
)

describe('moderation regions DataList ownership', () => {
  it('renders a navigation-variant DataList with FsusUI contract tokens', () => {
    expect(source).toContain('FsusUiDataList')
    expect(source).toMatch(/variant="navigation"/u)
    expect(source).toMatch(/variant="summary"/u)
    expect(source).toContain('--el-data-list-row-accent-color')
    expect(source).toContain('--el-data-list-active-background')
    expect(source).toContain('--el-data-list-focus-ring')
    expect(source).not.toContain('<el-data-list')
  })
})
