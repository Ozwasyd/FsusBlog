import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, getActivePinia, setActivePinia } from 'pinia'
import { computed, defineComponent } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStaticPage } from '@/composables/useStaticPage'
import { createPublicSiteIdentity, providePublicSiteIdentity } from '@/public-renderers/publicSiteIdentityContext'
import { createAboutPageViewContract } from '@/view-contracts/aboutPage'

const mockGetPageData = vi.hoisted(() => vi.fn())
const mockGetSiteConfig = vi.hoisted(() => vi.fn())
const mockGetSiteComplianceConfig = vi.hoisted(() => vi.fn())
const mockConsumePublicPageSeed = vi.hoisted(() => vi.fn())
const seenPiniaInstances = new WeakSet<object>()
const seenWrapperInstances = new WeakSet<object>()

type StaticPageShellIdentityCase = {
  caseName: string
  kind: 'About' | 'Privacy'
  slug: string
  title: string
}

vi.mock('@/api/system', () => ({
  getPageData: mockGetPageData,
  getSiteConfig: mockGetSiteConfig,
  getSiteComplianceConfig: mockGetSiteComplianceConfig
}))

vi.mock('@/public-renderers/pageSeed', () => ({
  consumePublicPageSeed: mockConsumePublicPageSeed
}))

vi.mock('@/bootstrap/publicHydrationBootstrap', () => ({
  readPublicHydrationPayload: vi.fn(() => null)
}))

function mountStaticPageWithShellIdentity(pageCase: StaticPageShellIdentityCase) {
  const pinia = createPinia()
  setActivePinia(pinia)

  const Child = defineComponent({
    setup() {
      const { staticPageView } = useStaticPage({
        kind: pageCase.kind,
        slug: pageCase.slug,
        title: pageCase.title
      })
      return { staticPageView }
    },
    template: '<div />'
  })
  const wrapper = mount(defineComponent({
    components: { Child },
    setup() {
      providePublicSiteIdentity(computed(() => createPublicSiteIdentity({ siteTitle: 'Shell Blog' })))
    },
    template: '<Child />'
  }), {
    global: {
      plugins: [pinia]
    }
  })

  return { Child, pinia, wrapper }
}

describe('static public page identity ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPageData.mockResolvedValue({ content: 'Static page content' })
    mockGetSiteConfig.mockResolvedValue(null)
    mockGetSiteComplianceConfig.mockResolvedValue(null)
    mockConsumePublicPageSeed.mockReturnValue({
      bootstrap: null,
      hydration: null
    })
  })

  it.each([
    { caseName: 'about', kind: 'About' as const, slug: 'about', title: '关于' },
    { caseName: 'privacy', kind: 'Privacy' as const, slug: 'privacy', title: '隐私政策' }
  ])('keeps the $caseName page view free of shell-owned site identity', async (pageCase) => {
    const { Child, pinia, wrapper } = mountStaticPageWithShellIdentity(pageCase)

    try {
      await flushPromises()
      const staticPageView = wrapper.findComponent(Child).vm.staticPageView

      expect(seenPiniaInstances.has(pinia)).toBe(false)
      expect(seenWrapperInstances.has(wrapper)).toBe(false)
      seenPiniaInstances.add(pinia)
      seenWrapperInstances.add(wrapper)
      expect(getActivePinia()).toBe(pinia)
      expect(staticPageView).not.toHaveProperty('footer')
      expect(staticPageView.header.title).toBe(pageCase.title)
      expect(JSON.stringify(staticPageView.header)).not.toContain('Shell Blog')
      expect(staticPageView.body.content).not.toContain('Shell Blog')
      expect(mockConsumePublicPageSeed).toHaveBeenCalledTimes(1)
      expect(mockConsumePublicPageSeed).toHaveBeenCalledWith(pageCase.kind, { fullPath: undefined })
      expect(mockGetPageData).toHaveBeenCalledTimes(1)
      expect(mockGetPageData.mock.calls[0]?.[0]).toBe(pageCase.slug)
    } finally {
      wrapper.unmount()
      setActivePinia(undefined)
      expect(wrapper.exists()).toBe(false)
    }
  })

  it('does not preserve stale hydration titles inside static page content contracts', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    mockConsumePublicPageSeed.mockReturnValue({
      bootstrap: {
        siteTitle: 'Bootstrap Blog',
        staticPage: { content: 'Bootstrap content' }
      },
      hydration: {
        siteTitle: 'Hydration Blog',
        renderYear: 2026,
        view: createAboutPageViewContract({
          currentYear: 2026,
          content: 'Hydration content'
        })
      }
    })

    const Child = defineComponent({
      setup() {
        const { staticPageView: aboutPageView } = useStaticPage({
          kind: 'About',
          slug: 'about',
          title: '关于'
        })
        const { staticPageView } = useStaticPage({
          kind: 'Privacy',
          slug: 'privacy',
          title: '隐私政策'
        })
        return { aboutPageView, staticPageView }
      },
      template: '<div />'
    })
    const wrapper = mount(defineComponent({
      components: { Child },
      setup() {
        providePublicSiteIdentity(computed(() => createPublicSiteIdentity({ siteTitle: 'Shell Blog' })))
      },
      template: '<Child />'
    }), {
      global: {
        plugins: [pinia]
      }
    })

    const child = wrapper.findComponent(Child)
    expect(child.vm.aboutPageView).not.toHaveProperty('footer')
    expect(child.vm.staticPageView).not.toHaveProperty('footer')
    expect(child.vm.aboutPageView.body.content).toBe('Hydration content')
    expect(child.vm.staticPageView.body.content).toBe('Hydration content')
  })
})
