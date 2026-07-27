import { readonly, shallowRef } from 'vue'

import {
  getLocalePreference,
  updateLocalePreference
} from '@/api/auth'
import type {
  LocalePreferenceMode,
  UserLocalePreference
} from '@/contracts/binaryApi'
import { requestLocale } from '@/locales'
import type { SupportedLocale } from '@/locales/localeCatalog'
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

async function refresh(signal?: AbortSignal): Promise<UserLocalePreference> {
  if (!signal && refreshInFlight) return refreshInFlight
  const execute = async (): Promise<UserLocalePreference> => {
    status.value = 'loading'
    failure.value = null
    try {
      const snapshot = await getLocalePreference({ signal })
      preference.value = snapshot
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
  const current = preference.value ?? await refresh()
  status.value = 'saving'
  failure.value = null
  try {
    const snapshot = await updateLocalePreference({
      mode,
      fixedLocale,
      expectedRevision: current.revision
    })
    preference.value = snapshot
    if (snapshot.mode === 'fixed' && snapshot.fixedLocale) {
      await requestLocale(snapshot.fixedLocale)
    }
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
