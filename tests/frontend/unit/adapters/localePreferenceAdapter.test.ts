import { describe, expect, it } from 'vitest'

import { mapUserLocalePreferenceFromPayload } from '@/adapters/binary/localePreferenceAdapter'
import { encodeUserLocalePreferenceUpdateRequest } from '@/api/binaryFrame'
import { USER_LOCALE_PREFERENCE_POD_SIZE } from '@/adapters/binary/types'
import { ENABLED_LOCALES } from '@/locales/localeCatalog'

function encodePreference(
  mode: 'auto' | 'fixed',
  fixedLocale: string | null,
  revision: number,
  updatedAtMs: number
): Uint8Array {
  const command = encodeUserLocalePreferenceUpdateRequest(mode, fixedLocale, revision)
  const bytes = new Uint8Array(USER_LOCALE_PREFERENCE_POD_SIZE)
  const view = new DataView(bytes.buffer)
  view.setBigInt64(0, BigInt(revision), true)
  view.setBigInt64(8, BigInt(updatedAtMs), true)
  bytes.set(command.subarray(8), 16)
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


for (const descriptor of ENABLED_LOCALES) {
  it(`preserves canonical request/response preference identity for ${descriptor.code}`, () => {
    const payload = encodePreference('fixed', descriptor.code, 9, Date.UTC(2026, 6, 28))
    expect(mapUserLocalePreferenceFromPayload(payload)).toEqual({
      mode: 'fixed', fixedLocale: descriptor.code, revision: 9,
      updatedAt: new Date(Date.UTC(2026, 6, 28)).toISOString()
    })
    const command = encodeUserLocalePreferenceUpdateRequest('fixed', descriptor.code, 9)
    expect(new DataView(command.buffer, command.byteOffset, command.byteLength).getBigInt64(0, true)).toBe(9n)
    expect(payload.subarray(16)).toEqual(command.subarray(8))
  })
}

for (const offset of [19, 20, 21, 22, 23]) {
  it(`rejects corrupted reserved preference byte ${offset}`, () => {
    const payload = encodePreference('auto', null, 0, 0)
    payload[offset] = 1
    expect(() => mapUserLocalePreferenceFromPayload(payload)).toThrow(/locale_preference_reserved_invalid/)
  })
}
