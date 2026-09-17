import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

const mediaQueryState = vi.hoisted(() => ({
  isMobile: null as null | { value: boolean }
}))

vi.mock('@/composables/useMediaQuery', async () => {
  const { ref: vueRef } = await import('vue')
  mediaQueryState.isMobile = vueRef(false)
  return {
    useMediaQuery: vi.fn(() => mediaQueryState.isMobile)
  }
})

describe('frontend derived-state watch simplification', () => {
  beforeEach(() => {
    if (!mediaQueryState.isMobile) {
      mediaQueryState.isMobile = ref(false)
    }
    mediaQueryState.isMobile.value = false
  })

  it('keeps inbox split pane behavior while deriving pane state through computed', async () => {
    const { useInboxSplitView } = await import('@/composables/useInboxSplitView')
    const selectedConversationId = ref('')
    const splitView = useInboxSplitView(selectedConversationId)

    expect(splitView.mobilePane.value).toBe('detail')
    expect(splitView.showListPane.value).toBe(true)
    expect(splitView.showDetailPane.value).toBe(true)

    mediaQueryState.isMobile!.value = true
    await nextTick()
    expect(splitView.mobilePane.value).toBe('list')
    expect(splitView.showListPane.value).toBe(true)
    expect(splitView.showDetailPane.value).toBe(false)

    selectedConversationId.value = 'conversation-1'
    splitView.openDetailPane()
    await nextTick()
    expect(splitView.mobilePane.value).toBe('detail')
    expect(splitView.showListPane.value).toBe(false)
    expect(splitView.showDetailPane.value).toBe(true)

    selectedConversationId.value = ''
    await nextTick()
    expect(splitView.mobilePane.value).toBe('list')
  })

  it('preserves inbox split pane timing across breakpoint changes', async () => {
    const { useInboxSplitView } = await import('@/composables/useInboxSplitView')
    const selectedConversationId = ref('conversation-1')
    const splitView = useInboxSplitView(selectedConversationId)

    expect(splitView.mobilePane.value).toBe('detail')

    mediaQueryState.isMobile!.value = true
    await nextTick()
    expect(splitView.mobilePane.value).toBe('detail')

    splitView.openListPane()
    mediaQueryState.isMobile!.value = false
    await nextTick()
    expect(splitView.mobilePane.value).toBe('detail')

    mediaQueryState.isMobile!.value = true
    await nextTick()
    expect(splitView.mobilePane.value).toBe('list')
  })

  it('keeps the old mobile initial-pane timing when a conversation is preselected', async () => {
    const { useInboxSplitView } = await import('@/composables/useInboxSplitView')
    mediaQueryState.isMobile!.value = true

    const selectedConversationId = ref('conversation-1')
    const splitView = useInboxSplitView(selectedConversationId)

    expect(splitView.mobilePane.value).toBe('list')

    splitView.openDetailPane()
    await nextTick()
    expect(splitView.mobilePane.value).toBe('detail')
  })

})
