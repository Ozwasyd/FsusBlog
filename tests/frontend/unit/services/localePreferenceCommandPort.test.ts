import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/auth', () => ({
  getLocalePreference: vi.fn(),
  updateLocalePreference: vi.fn()
}))

vi.mock('@/locales', () => ({
  requestLocale: vi.fn(async (locale: string) => locale)
}))

import {
  getLocalePreference,
  updateLocalePreference
} from '@/api/auth'
import { requestLocale } from '@/locales'
import { localePreferenceCommandPort } from '@/services/localePreferenceCommandPort'
import { createAppError, AppErrorCode } from '@/utils/appError'

const getLocalePreferenceMock = vi.mocked(getLocalePreference)
const updateLocalePreferenceMock = vi.mocked(updateLocalePreference)
const requestLocaleMock = vi.mocked(requestLocale)

describe('localePreferenceCommandPort', () => {
  beforeEach(() => {
    getLocalePreferenceMock.mockReset()
    updateLocalePreferenceMock.mockReset()
    requestLocaleMock.mockReset()
    requestLocaleMock.mockImplementation(async (locale) => locale)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('loads the independent preference snapshot without localStorage', async () => {
    getLocalePreferenceMock.mockResolvedValue({
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

  it('saves fixed preference through one command port and projects locale', async () => {
    getLocalePreferenceMock.mockResolvedValue({
      mode: 'auto',
      fixedLocale: null,
      revision: 0,
      updatedAt: '1970-01-01T00:00:00.000Z'
    })
    updateLocalePreferenceMock.mockResolvedValue({
      mode: 'fixed',
      fixedLocale: 'de-DE',
      revision: 1,
      updatedAt: '2026-07-28T01:00:00.000Z'
    })

    await localePreferenceCommandPort.refresh()
    const saved = await localePreferenceCommandPort.setFixed('de-DE')

    expect(updateLocalePreferenceMock).toHaveBeenCalledWith({
      mode: 'fixed',
      fixedLocale: 'de-DE',
      expectedRevision: 0
    })
    expect(requestLocaleMock).toHaveBeenCalledWith('de-DE')
    expect(saved.revision).toBe(1)
    expect(localePreferenceCommandPort.status.value).toBe('success')
  })

  it('surfaces revision conflict for multi-device retry without silent overwrite', async () => {
    getLocalePreferenceMock.mockResolvedValue({
      mode: 'fixed',
      fixedLocale: 'en-US',
      revision: 4,
      updatedAt: '2026-07-28T02:00:00.000Z'
    })
    updateLocalePreferenceMock.mockRejectedValue(
      createAppError(AppErrorCode.Conflict, 'locale_preference_revision_conflict')
    )

    await localePreferenceCommandPort.refresh()
    await expect(localePreferenceCommandPort.setAuto()).rejects.toMatchObject({
      message: expect.stringContaining('locale_preference_revision_conflict')
    })
    expect(localePreferenceCommandPort.status.value).toBe('conflict')
    expect(updateLocalePreferenceMock).toHaveBeenCalledWith({
      mode: 'auto',
      fixedLocale: null,
      expectedRevision: 4
    })
  })
})
