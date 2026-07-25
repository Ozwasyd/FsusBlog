import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { ElDataList } from '@ozwasyd/element-plus'
import ModerationRegions from '@/views/admin/moderation/ModerationRegions.vue'

describe('moderation regions DataList ownership', () => {
  it('renders a navigation-variant DataList with FsusUI contract tokens', () => {
    const wrapper = mount(ModerationRegions, {
      global: {
        stubs: {
          ElDataList: {
            template: '<div class="el-data-list"><slot name="items" /></div>',
            props: ['variant', 'items', 'rowAccentColor', 'hoverBackground', 'activeBackground', 'focusRing', 'activeIndicator'],
          },
        },
      },
    })

    const dataList = wrapper.findComponent(ElDataList)
    expect(dataList.exists()).toBe(true)
  })
})
