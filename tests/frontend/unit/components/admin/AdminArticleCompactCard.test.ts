// @vitest-environment happy-dom

import { ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu, ElIcon, ElLink, ElTag } from '@ozwasyd/element-plus'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AdminArticleCompactCard from '@/components/admin/article/AdminArticleCompactCard.vue'
import type { AdminArticleCompactCardRow } from '@/components/admin/article/AdminArticleCompactCard.vue'

const row = {
  id: 17,
  title: '公开组件承载原有文章操作',
  views: 12,
  coverImageUrl: '',
  categoryName: '一个很长的分类名称用于验证公开 Tag 的自有 class 与省略文本',
  statusText: '草稿',
  statusTagType: 'info',
  statusTimeLabel: '更新',
  statusTimeValue: '2026-10-08T00:00:00Z',
  statusTimeText: '2026-10-08',
  primaryActionLabel: '编辑',
  previewActionLabel: '预览',
  publicPreviewAvailable: false
} as AdminArticleCompactCardRow

describe('article compact card public Tag class boundary', () => {
  it('retains both tags, the category slot and the existing edit identity', async () => {
    const wrapper = mount(AdminArticleCompactCard, {
      props: { row },
      global: { components: { ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu, ElIcon, ElLink, ElTag } }
    })
    const tags = wrapper.findAllComponents(ElTag)
    expect(tags).toHaveLength(2)
    expect(tags.map((tag) => tag.classes().includes('article-compact-tag'))).toEqual([true, true])
    expect(wrapper.get('.article-compact-tag-text').text()).toBe(row.categoryName)
    expect(tags[1].props('type')).toBe('info')
    await wrapper.get('.article-compact-title').trigger('click')
    expect(wrapper.emitted('edit')).toEqual([[17]])
    const edit = wrapper.findAllComponents(ElButton).find((button) => button.text() === '编辑')!
    await edit.trigger('click')
    expect(wrapper.emitted('edit')).toEqual([[17], [17]])
    wrapper.unmount()
  })
})
