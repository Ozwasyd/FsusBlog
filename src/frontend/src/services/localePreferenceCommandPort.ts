import { readonly, shallowRef } from 'vue'

import type {
  LocalePreferenceMode,
  UserLocalePreference
} from '@/contracts/binaryApi'
import type { SupportedLocale } from '@/locales/localeCatalog'
import {
  getPreferenceSnapshot,
  refreshPreferenceSnapshot,
  requestLocalePreference
} from '@/locales/runtime/localeRuntimeComposition'
import { toAppError } from '@/utils/appError'

type LocalePreferenceStatus =
  | 'idle'
  | 'loading'
  | 'saving'
  | 'success'
  | 'conflict'
  | 'failure'

const preference = shallowRef<UserLocalePreference | null>(null)
const status = shallowRef<LocalePreferenceStatus>('idle')
const failure = shallowRef<Error | null>(null)
let refreshInFlight: Promise<UserLocalePreference> | null = null

function syncPreferenceView(snapshot: UserLocalePreference | null): void {
  preference.value = snapshot
}

async function refresh(signal?: AbortSignal): Promise<UserLocalePreference> {
  if (!signal && refreshInFlight) return refreshInFlight
  const execute = async (): Promise<UserLocalePreference> => {
    status.value = 'loading'
    failure.value = null
    try {
      const snapshot = await refreshPreferenceSnapshot(signal)
      syncPreferenceView(snapshot)
      status.value = 'idle'
      return snapshot
    } catch (error) {
      failure.value = toAppError(error, 'locale_preference_unavailable')
      status.value = 'failure'
      throw failure.value
    }
  }
  if (signal) return execute()
  refreshInFlight = execute()
  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

const ensureLoaded = (): Promise<UserLocalePreference> =>
  preference.value ? Promise.resolve(preference.value) : refresh()

async function save(
  mode: LocalePreferenceMode,
  fixedLocale: SupportedLocale | null
): Promise<UserLocalePreference> {
  if (!preference.value) await refresh()
  status.value = 'saving'
  failure.value = null
  try {
    const command = mode === 'fixed' && fixedLocale
      ? Object.freeze({ mode: 'fixed' as const, locale: fixedLocale })
      : Object.freeze({ mode: 'auto' as const })
    await requestLocalePreference(command)
    const snapshot = getPreferenceSnapshot()
    if (!snapshot) {
      throw toAppError(
        new Error('locale_preference_unavailable'),
        'locale_preference_unavailable'
      )
    }
    syncPreferenceView(snapshot)
    status.value = 'success'
    return snapshot
  } catch (error) {
    const appError = toAppError(error, 'locale_preference_unavailable')
    failure.value = appError
    status.value = appError.message.includes('locale_preference_revision_conflict')
      ? 'conflict'
      : 'failure'
    throw appError
  }
}

export const localePreferenceCommandPort = Object.freeze({
  preference: readonly(preference),
  status: readonly(status),
  failure: readonly(failure),
  refresh,
  ensureLoaded,
  setAuto: () => save('auto', null),
  setFixed: (locale: SupportedLocale) => save('fixed', locale)
})
