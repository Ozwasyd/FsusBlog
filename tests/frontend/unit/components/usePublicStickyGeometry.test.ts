// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  publicStickyGeometryOwnerSelector,
  publicStickyGeometryTokens,
  publicStickyHeaderSelector,
  usePublicStickyGeometry
} from '@/components/public/usePublicStickyGeometry'

type ResizeObserverCallbackRecord = {
  callback: ResizeObserverCallback
  observe: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

const resizeObservers: ResizeObserverCallbackRecord[] = []

class TestResizeObserver {
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(callback: ResizeObserverCallback) {
    resizeObservers.push({ callback, observe: this.observe, disconnect: this.disconnect })
  }
}

const Probe = defineComponent({
  setup() {
    const root = ref<HTMLElement>()
    usePublicStickyGeometry(root)
    return { root }
  },
  template: `
    <div ref="root">
      <div data-public-sticky-geometry-owner>
        <header class="el-public-shell__header" data-public-shell-header data-test-height="64"></header>
      </div>
    </div>
  `
})

function rectForHeight(height: number): DOMRect {
  return {
    bottom: height,
    height,
    left: 0,
    right: 320,
    top: 0,
    width: 320,
    x: 0,
    y: 0,
    toJSON: () => ({})
  } as DOMRect
}

async function settleGeometry(): Promise<void> {
  await nextTick()
  await Promise.resolve()
}

afterEach(() => {
  resizeObservers.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('usePublicStickyGeometry', () => {
  it('publishes actual header geometry and keeps it current after resize', async () => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    const addEventListener = vi.spyOn(window, 'addEventListener')
    const removeEventListener = vi.spyOn(window, 'removeEventListener')
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      return rectForHeight(Number(this.dataset.testHeight ?? '0'))
    })

    const wrapper = mount(Probe, { attachTo: document.body })
    await settleGeometry()

    const root: Element = wrapper.element
    const header = root.querySelector<HTMLElement>(publicStickyHeaderSelector)
    const geometryOwner = root.querySelector<HTMLElement>(publicStickyGeometryOwnerSelector)
    expect(header).not.toBeNull()
    expect(geometryOwner).not.toBeNull()
    expect(publicStickyGeometryTokens).toEqual({
      headerHeight: '--fsusblog-public-header-height-current',
      stickyTop: '--fsusblog-public-sticky-top',
      anchorOffset: '--fsusblog-public-anchor-offset'
    })
    expect(publicStickyHeaderSelector).toBe('[data-public-shell-header]')
    expect(publicStickyGeometryOwnerSelector).toBe('[data-public-sticky-geometry-owner]')
    expect(publicStickyHeaderSelector).not.toContain('.el-')
    expect(header?.matches('.el-public-shell__header')).toBe(true)
    expect(root.hasAttribute('style')).toBe(false)
    expect(root.className).not.toMatch(/fsus-csp-style-/u)
    expect(geometryOwner?.className).toMatch(/fsus-csp-style-/u)
    const geometryRule = document.head.querySelector<HTMLStyleElement>(
      '[data-fsus-csp-runtime-style="public-sticky-geometry"]'
    )?.sheet?.cssRules[0] as CSSStyleRule | undefined
    expect(geometryRule?.style.getPropertyValue(publicStickyGeometryTokens.headerHeight)).toBe('64px')
    expect(geometryRule?.style.getPropertyValue(publicStickyGeometryTokens.stickyTop)).toBe('64px')
    expect(geometryRule?.style.getPropertyValue(publicStickyGeometryTokens.anchorOffset)).toBe('calc(64px + 0.75rem)')
    expect(resizeObservers).toHaveLength(1)
    expect(resizeObservers[0]?.observe).toHaveBeenCalledWith(header)
    const resizeRegistration = addEventListener.mock.calls.find(([type]) => type === 'resize')
    expect(resizeRegistration).toBeDefined()

    // The 40px landscape touch floor can reflow the header; publish the rendered
    // height instead of copying the four-pixel control delta into sticky offsets.
    header?.setAttribute('data-test-height', '68')
    resizeObservers[0]?.callback([], {} as ResizeObserver)
    expect(geometryRule?.style.getPropertyValue(publicStickyGeometryTokens.headerHeight)).toBe('68px')
    expect(geometryRule?.style.getPropertyValue(publicStickyGeometryTokens.stickyTop)).toBe('68px')
    expect(geometryRule?.style.getPropertyValue(publicStickyGeometryTokens.anchorOffset)).toBe('calc(68px + 0.75rem)')

    header?.setAttribute('data-test-height', '80')
    window.dispatchEvent(new window.Event('resize'))
    expect(geometryRule?.style.getPropertyValue(publicStickyGeometryTokens.headerHeight)).toBe('80px')

    wrapper.unmount()
    expect(resizeObservers[0]?.disconnect).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledWith('resize', resizeRegistration?.[1])
    expect(document.head.querySelector('[data-fsus-csp-runtime-style="public-sticky-geometry"]')).toBeNull()
  })
})
