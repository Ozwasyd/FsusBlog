import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

const extractWatchBlock = (source: string, marker: string): string => {
  const markerIndex = source.lastIndexOf(marker)
  expect(markerIndex, `missing marker ${marker}`).toBeGreaterThanOrEqual(0)
  const start = source.lastIndexOf('watch(', markerIndex)
  expect(start, `missing watch before ${marker}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n  )', markerIndex)
  expect(end, `missing watch end after ${marker}`).toBeGreaterThan(markerIndex)
  return source.slice(start, end + 5)
}

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

  it('does not keep derived-state watches in inbox split view', () => {
    const inboxSplitView = readRepoFile('src/frontend/src/composables/useInboxSplitView.ts')

    expect(inboxSplitView).toContain('const requestedMobilePane = ref<InboxMobilePane | null>(null)')
    expect(inboxSplitView).toContain('const mobilePane = computed<InboxMobilePane>')
    expect(inboxSplitView).not.toContain('watch(isMobile')
    expect(inboxSplitView).not.toContain('watch(selectedConversationId')
  })

  it('watches home readiness through upstream sources instead of listView computed output', () => {
    const homeView = readRepoFile('src/frontend/src/composables/useHomeView.ts')
    const readinessWatch = extractWatchBlock(homeView, 'markRouteReadyIfSettled()')

    expect(readinessWatch).not.toContain('listView.value.items.length')
    expect(readinessWatch).toContain('initialViewItems.value?.length')
    expect(readinessWatch).toContain('articleItems.value.length')
  })
})
