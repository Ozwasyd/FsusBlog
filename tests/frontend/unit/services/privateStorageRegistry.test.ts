import { describe, expect, it } from 'vitest'
import {
  clearRegisteredPrivateStorage,
  PRIVATE_STORAGE_REGISTRY
} from '@/services/privateStorageRegistry'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) }
  }
}

describe('private storage registry', () => {
  it('cleans every registered exact key and prefix without touching public preferences', () => {
    const local = memoryStorage()
    const session = memoryStorage()
    for (const entry of PRIVATE_STORAGE_REGISTRY) {
      const storage = entry.scope === 'local' ? local : session
      storage.setItem(entry.match === 'exact' ? entry.value : `${entry.value}fixture`, 'private')
    }
    local.setItem('fsus:theme-mode', 'dark')
    local.setItem('fsus:image-upload-preferences', '{"format":"webp"}')

    const result = clearRegisteredPrivateStorage({ local, session })

    expect(result.failed).toEqual([])
    expect(result.removed).toHaveLength(PRIVATE_STORAGE_REGISTRY.length)
    expect(local.getItem('fsus:theme-mode')).toBe('dark')
    expect(local.getItem('fsus:image-upload-preferences')).not.toBeNull()
    for (const entry of PRIVATE_STORAGE_REGISTRY) {
      const storage = entry.scope === 'local' ? local : session
      expect(storage.getItem(entry.match === 'exact' ? entry.value : `${entry.value}fixture`), entry.id).toBeNull()
    }
  })
})
