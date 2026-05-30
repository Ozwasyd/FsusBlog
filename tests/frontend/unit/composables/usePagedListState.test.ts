import { describe, it, expect } from 'vitest'
import { usePagedListState } from '@/composables/usePagedListState'

describe('usePagedListState', () => {
  it('has default values', () => {
    const state = usePagedListState()
    expect(state.currentPage.value).toBe(1)
    expect(state.pageSize.value).toBe(10)
    expect(state.total.value).toBe(0)
    expect(state.loading.value).toBe(false)
    expect(state.error.value).toBeNull()
    expect(state.hasMore.value).toBe(true)
    expect(state.nextCursor.value).toBeNull()
    expect(state.isEmpty.value).toBe(true)
    expect(state.totalPages.value).toBe(1)
  })

  it('respects custom options', () => {
    const state = usePagedListState({ initialPage: 3, pageSize: 20 })
    expect(state.currentPage.value).toBe(3)
    expect(state.pageSize.value).toBe(20)
  })

  it('beginLoading sets loading true and clears error', () => {
    const state = usePagedListState()
    state.error.value = 'some error'
    state.beginLoading()
    expect(state.loading.value).toBe(true)
    expect(state.error.value).toBeNull()
  })

  it('endLoading sets loading false', () => {
    const state = usePagedListState()
    state.beginLoading()
    state.endLoading()
    expect(state.loading.value).toBe(false)
  })

  it('setError sets error message and stops loading', () => {
    const state = usePagedListState()
    state.beginLoading()
    state.setError('fetch failed')
    expect(state.error.value).toBe('fetch failed')
    expect(state.loading.value).toBe(false)
  })

  it('setPageTotal sets total correctly', () => {
    const state = usePagedListState({ pageSize: 10 })
    state.setPageTotal(35)
    expect(state.total.value).toBe(35)
    expect(state.totalPages.value).toBe(4)
    expect(state.isEmpty.value).toBe(false)
  })

  it('setPageTotal clamps negative to 0', () => {
    const state = usePagedListState()
    state.setPageTotal(-5)
    expect(state.total.value).toBe(0)
  })

  it('setPageTotal handles Infinity gracefully', () => {
    const state = usePagedListState()
    state.setPageTotal(Infinity)
    expect(state.total.value).toBe(0)
  })

  it('totalPages minimum is 1 when total is 0', () => {
    const state = usePagedListState({ pageSize: 10 })
    expect(state.totalPages.value).toBe(1)
  })

  it('resetCursorState resets hasMore and nextCursor', () => {
    const state = usePagedListState()
    state.hasMore.value = false
    state.nextCursor.value = 'cursor-abc'
    state.resetCursorState()
    expect(state.hasMore.value).toBe(true)
    expect(state.nextCursor.value).toBeNull()
  })

  it('isEmpty is false when total > 0', () => {
    const state = usePagedListState()
    state.setPageTotal(1)
    expect(state.isEmpty.value).toBe(false)
  })
})
