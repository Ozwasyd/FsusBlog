import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useArchiveView } from '@/composables/useArchiveView'
import { PUBLIC_RENDERER_VERSION } from '@/public-renderers/publicEntryCore'
import {
  putPublicRouteSeed,
  resetPublicRouteSeedStoreForTests
} from '@/public-renderers/publicRouteSeedStore'
import type { PublicPageSeed } from '@/public-renderers/pageSeed'
import type { PublicHydrationPayloadFor } from '@/public-renderers/publicPayloadTypes'
import type { ArchivePageViewContract } from '@/view-contracts/archive'

const mockGetArticles = vi.hoisted(() => vi.fn())

vi.mock('@/api/article', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/article')>()
  return {
    ...actual,
    getArticles: mockGetArticles
  }
})

function createArchiveSeed(view: ArchivePageViewContract): PublicPageSeed<'Archive'> {
  return {
    bootstrap: null,
    hydration: {
      pageKind: 'Archive',
      routeKey: 'archive',
      rendererVersion: PUBLIC_RENDERER_VERSION,
      title: '归档',
      view
    } as PublicHydrationPayloadFor<'Archive'>
  }
}

describe('public page route seeds', () => {
  beforeEach(() => {
    ;(globalThis as { history?: History }).history = window.history
    setActivePinia(createPinia())
    resetPublicRouteSeedStoreForTests()
    mockGetArticles.mockResolvedValue({ total: 0, items: [] })
  })

  afterEach(() => {
    resetPublicRouteSeedStoreForTests()
    vi.clearAllMocks()
  })

  it('renders an injected archive route seed on the first SPA render without API loading', async () => {
    const archiveView: ArchivePageViewContract = {
      total: 1,
      yearGroups: [],
      emptyState: {
        title: 'Seeded archive'
      }
    }
    putPublicRouteSeed({
      kind: 'Archive',
      fullPath: '/archive',
      routeKey: 'archive',
      seed: createArchiveSeed(archiveView)
    })

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/archive', component: { template: '<div />' } }
      ]
    })
    await router.push('/archive')
    await router.isReady()

    const Probe = defineComponent({
      setup() {
        return useArchiveView()
      },
      template: '<div />'
    })

    const wrapper = mount(Probe, {
      global: {
        plugins: [router, createPinia()]
      }
    })

    await nextTick()
    await Promise.resolve()

    expect(wrapper.vm.loading).toBe(false)
    expect(wrapper.vm.archiveView).toEqual(archiveView)
    expect(mockGetArticles).not.toHaveBeenCalled()
  })
})
