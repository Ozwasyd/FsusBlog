// @vitest-environment happy-dom

import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { useArticleWriteInspector } from '@/composables/useArticleWriteInspector'

describe('useArticleWriteInspector', () => {
  it('owns one active view, lazy loading, per-view scroll and exact focus return', async () => {
    const loadResources = vi.fn()
    const loadVersions = vi.fn()
    const inspector = useArticleWriteInspector({
      loadView: {
        resources: loadResources,
        versions: loadVersions
      }
    })
    const resourcesTrigger = document.createElement('button')
    const versionsTrigger = document.createElement('button')
    const resourcesScroll = document.createElement('div')
    const versionsScroll = document.createElement('div')
    document.body.append(resourcesTrigger, versionsTrigger, resourcesScroll, versionsScroll)
    inspector.registerTrigger('resources', resourcesTrigger)
    inspector.registerTrigger('versions', versionsTrigger)
    inspector.registerScrollContainer('resources', resourcesScroll)
    inspector.registerScrollContainer('versions', versionsScroll)

    await inspector.open('resources', resourcesTrigger)
    expect(inspector.activeInspector.value).toBe('resources')
    expect(loadResources).toHaveBeenCalledTimes(1)

    resourcesScroll.scrollTop = 137
    await inspector.switchTo('versions')
    expect(inspector.activeInspector.value).toBe('versions')
    expect(inspector.scrollPositions.get('resources')).toBe(137)
    expect(loadVersions).toHaveBeenCalledTimes(1)

    versionsScroll.scrollTop = 83
    inspector.close()
    await inspector.restoreFocus()
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(resourcesTrigger)
    })

    await inspector.open('resources', resourcesTrigger)
    await nextTick()
    expect(inspector.activeInspector.value).toBe('resources')
    expect(resourcesScroll.scrollTop).toBe(137)
    expect(loadResources).toHaveBeenCalledTimes(1)
    expect(inspector.requestedViews).toEqual(new Set(['resources', 'versions']))

    inspector.close()
    expect(inspector.activeInspector.value).toBeNull()
    await inspector.restoreFocus()
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(resourcesTrigger)
    })

    resourcesTrigger.remove()
    versionsTrigger.remove()
    resourcesScroll.remove()
    versionsScroll.remove()
  })
})
