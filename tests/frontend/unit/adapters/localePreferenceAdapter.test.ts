import { describe, expect, it } from 'vitest'

import { mapUserLocalePreferenceFromPayload } from '@/adapters/binary/localePreferenceAdapter'
import { encodeUserLocalePreferenceUpdateRequest } from '@/api/binaryFrame'
import { USER_LOCALE_PREFERENCE_POD_SIZE } from '@/adapters/binary/types'

function encodePreference(
  mode: 'auto' | 'fixed',
  fixedLocale: string | null,
  revision: number,
  updatedAtMs: number
): Uint8Array {
  const localeWireValues: Readonly<Record<string, number>> = {
    'zh-CN': 1,
    'en-US': 2,
    'zh-Hant': 3,
    'ja-JP': 4,
    'ko-KR': 5,
    'es-419': 6,
    'fr-FR': 7,
    'de-DE': 8,
    'pt-BR': 9,
    'ru-RU': 10
  }
  const bytes = new Uint8Array(USER_LOCALE_PREFERENCE_POD_SIZE)
  const view = new DataView(bytes.buffer)
  view.setBigInt64(0, BigInt(revision), true)
  view.setBigInt64(8, BigInt(updatedAtMs), true)
  view.setUint8(16, mode === 'fixed' ? 2 : 1)
  view.setUint8(17, mode === 'fixed' ? 1 : 0)
  view.setUint8(18, mode === 'fixed' && fixedLocale ? (localeWireValues[fixedLocale] ?? 0) : 0)
  return bytes
}

describe('locale preference adapter and request encoding', () => {
  it('decodes auto and fixed preference pods', () => {
    const auto = mapUserLocalePreferenceFromPayload(encodePreference('auto', null, 0, 0))
    expect(auto).toEqual({
      mode: 'auto',
      fixedLocale: null,
      revision: 0,
      updatedAt: new Date(0).toISOString()
    })

    const fixed = mapUserLocalePreferenceFromPayload(
      encodePreference('fixed', 'ja-JP', 5, Date.UTC(2026, 6, 28))
    )
    expect(fixed.mode).toBe('fixed')
    expect(fixed.fixedLocale).toBe('ja-JP')
    expect(fixed.revision).toBe(5)
  })

  it('rejects invalid fixed locale wire value', () => {
    const bytes = encodePreference('fixed', 'ja-JP', 1, 0)
    bytes[18] = 99
    expect(() => mapUserLocalePreferenceFromPayload(bytes)).toThrow(/locale_preference_state_invalid/)
  })

  it('encodes update request with expected revision and catalog wire values', () => {
    const auto = encodeUserLocalePreferenceUpdateRequest('auto', null, 0)
    expect(auto.byteLength).toBe(16)
    expect(auto[8]).toBe(1)
    expect(auto[9]).toBe(0)
    expect(auto[10]).toBe(0)

    const fixed = encodeUserLocalePreferenceUpdateRequest('fixed', 'de-DE', 9)
    const view = new DataView(fixed.buffer)
    expect(view.getBigInt64(0, true)).toBe(9n)
    expect(fixed[8]).toBe(2)
    expect(fixed[9]).toBe(1)
    expect(fixed[10]).toBe(8)
  })
})
