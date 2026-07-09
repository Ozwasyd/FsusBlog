import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStaticPage } from '@/composables/useStaticPage'
import { createPublicSiteIdentity, providePublicSiteIdentity } from '@/public-renderers/publicSiteIdentityContext'
import { createAboutPageViewContract } from '@/view-contracts/aboutPage'

const mockGetPageData = vi.hoisted(() => vi.fn())
const mockGetSiteConfig = vi.hoisted(() => vi.fn())
const mockGetSiteComplianceConfig = vi.hoisted(() => vi.fn())
const mockConsumePublicPageSeed = vi.hoisted(() => vi.fn())

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

describe('static public page identity ownership', () => {
  beforeEach(() => {
    const pinia = createPinia()
    setActivePinia(pinia)
    vi.clearAllMocks()
    mockGetPageData.mockResolvedValue({ content: 'Static page content' })
    mockGetSiteConfig.mockResolvedValue(null)
    mockGetSiteComplianceConfig.mockResolvedValue(null)
    mockConsumePublicPageSeed.mockReturnValue({
      bootstrap: null,
      hydration: null
    })
  })

  it('keeps the about page view free of shell-owned site identity', () => {
    const pinia = createPinia()
    setActivePinia(pinia)

    const Child = defineComponent({
      setup() {
        const { staticPageView } = useStaticPage({
          kind: 'About',
          slug: 'about',
          title: '关于'
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

    expect(wrapper.findComponent(Child).vm.staticPageView).not.toHaveProperty('footer')
    expect(wrapper.findComponent(Child).vm.staticPageView.header.title).toBe('关于')
  })

  it('keeps policy page views free of shell-owned site identity', () => {
    const pinia = createPinia()
    setActivePinia(pinia)

    const Child = defineComponent({
      setup() {
        const { staticPageView } = useStaticPage({
          kind: 'Privacy',
          slug: 'privacy',
          title: '隐私政策'
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

    expect(wrapper.findComponent(Child).vm.staticPageView).not.toHaveProperty('footer')
    expect(wrapper.findComponent(Child).vm.staticPageView.header.title).toBe('隐私政策')
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
