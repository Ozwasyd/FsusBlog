import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const componentPath = fileURLToPath(new URL(
  '../../../../../src/frontend/src/components/admin/AdminTaxonomyManageView.vue',
  import.meta.url
))

const source = readFileSync(componentPath, 'utf8')

describe('AdminTaxonomyManageView visual and accessibility contracts', () => {
  it('renders a focusable locked status instead of a disabled info button', () => {
    const lockedBlock = source.match(/<el-tooltip v-if="!row\.canDelete"[\s\S]*?<\/el-tooltip>/u)?.[0] ?? ''

    expect(lockedBlock).toContain('class="taxonomy-action-locked"')
    expect(lockedBlock).toContain('tabindex="0"')
    expect(lockedBlock).toContain(':title="state.relationLockReason(row)"')
    expect(lockedBlock).toContain(':aria-label="`锁定：${state.relationLockReason(row)}`"')
    expect(lockedBlock).toContain(':size="14"')
    expect(lockedBlock).not.toContain('<el-button')
    expect(source).toMatch(/\.taxonomy-action-locked\s*\{[\s\S]*?min-height:\s*32px;[\s\S]*?color:\s*var\(--fsusblog-text-muted\);/u)
    expect(source).toMatch(/@media \(max-width: 639px\)[\s\S]*?\.taxonomy-action-locked\s*\{[\s\S]*?min-width:\s*32px;/u)
  })

  it('keeps the deletable state as a danger action', () => {
    expect(source).toMatch(/<el-button v-else link type="danger"[^>]*@click="state\.handleDelete\(row\)"/u)
  })

  it('gives every compact action an explicit centered 32px touch target', () => {
    expect(source.match(/'admin-table-action--compact': isCompact/gu)).toHaveLength(3)
    expect(source).toMatch(/\.admin-table-action--compact\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;[\s\S]*?min-width:\s*32px;[\s\S]*?min-height:\s*32px;/u)
    expect(source).toContain(':width="actionColumnWidth"')
  })
})
