import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/auth', () => ({
  getLocalePreference: vi.fn(),
  updateLocalePreference: vi.fn()
}))

vi.mock('@/locales/runtime/localeRuntimeComposition', async () => {
  const actual = await vi.importActual<typeof import('@/locales/runtime/localeRuntimeComposition')>(
    '@/locales/runtime/localeRuntimeComposition'
  )
  return {
    ...actual,
    requestLocalePreference: vi.fn(async () => 'de-DE'),
    refreshPreferenceSnapshot: vi.fn(),
    getPreferenceSnapshot: vi.fn()
  }
})

import {
  getLocalePreference,
  updateLocalePreference
} from '@/api/auth'
import {
  getPreferenceSnapshot,
  refreshPreferenceSnapshot,
  requestLocalePreference
} from '@/locales/runtime/localeRuntimeComposition'
import { localePreferenceCommandPort } from '@/services/localePreferenceCommandPort'
import { createAppError, AppErrorCode } from '@/utils/appError'

const getLocalePreferenceMock = vi.mocked(getLocalePreference)
const updateLocalePreferenceMock = vi.mocked(updateLocalePreference)
const requestLocalePreferenceMock = vi.mocked(requestLocalePreference)
const refreshPreferenceSnapshotMock = vi.mocked(refreshPreferenceSnapshot)
const getPreferenceSnapshotMock = vi.mocked(getPreferenceSnapshot)

describe('localePreferenceCommandPort', () => {
  beforeEach(() => {
    getLocalePreferenceMock.mockReset()
    updateLocalePreferenceMock.mockReset()
    requestLocalePreferenceMock.mockReset()
    refreshPreferenceSnapshotMock.mockReset()
    getPreferenceSnapshotMock.mockReset()
    requestLocalePreferenceMock.mockImplementation(async () => 'de-DE')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('loads the independent preference snapshot without localStorage', async () => {
    refreshPreferenceSnapshotMock.mockResolvedValue({
      mode: 'fixed',
      fixedLocale: 'ja-JP',
      revision: 2,
      updatedAt: '2026-07-28T00:00:00.000Z'
    })

    const snapshot = await localePreferenceCommandPort.refresh()

    expect(snapshot.fixedLocale).toBe('ja-JP')
    expect(localePreferenceCommandPort.preference.value?.revision).toBe(2)
    expect(localePreferenceCommandPort.status.value).toBe('idle')
    expect(localStorage.length).toBe(0)
  })

  it('saves fixed preference through one command path that drives the runtime transaction', async () => {
    refreshPreferenceSnapshotMock.mockResolvedValue({
      mode: 'auto',
      fixedLocale: null,
      revision: 0,
      updatedAt: '1970-01-01T00:00:00.000Z'
    })
    getPreferenceSnapshotMock.mockReturnValue({
      mode: 'fixed',
      fixedLocale: 'de-DE',
      revision: 1,
      updatedAt: '2026-07-28T01:00:00.000Z'
    })

    await localePreferenceCommandPort.refresh()
    const saved = await localePreferenceCommandPort.setFixed('de-DE')

    expect(requestLocalePreferenceMock).toHaveBeenCalledWith({
      mode: 'fixed',
      locale: 'de-DE'
    })
    expect(updateLocalePreferenceMock).not.toHaveBeenCalled()
    expect(saved.revision).toBe(1)
    expect(localePreferenceCommandPort.status.value).toBe('success')
  })

  it('surfaces revision conflict for multi-device retry without silent overwrite', async () => {
    refreshPreferenceSnapshotMock.mockResolvedValue({
      mode: 'fixed',
      fixedLocale: 'en-US',
      revision: 4,
      updatedAt: '2026-07-28T02:00:00.000Z'
    })
    requestLocalePreferenceMock.mockRejectedValue(
      createAppError(AppErrorCode.Conflict, 'locale_preference_revision_conflict')
    )

    await localePreferenceCommandPort.refresh()
    await expect(localePreferenceCommandPort.setAuto()).rejects.toMatchObject({
      message: expect.stringContaining('locale_preference_revision_conflict')
    })
    expect(localePreferenceCommandPort.status.value).toBe('conflict')
    expect(requestLocalePreferenceMock).toHaveBeenCalledWith({ mode: 'auto' })
  })
})
