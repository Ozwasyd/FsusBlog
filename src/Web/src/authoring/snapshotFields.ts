import { proxyRefs, type Ref } from 'vue'

/** Update existing refs in declaration order so synchronous watchers see the same field transitions. */
export function snapshotFields<T extends object>(fields: { [K in keyof T]: Ref<T[K]> }, changed?: (key: keyof T) => void) {
  const keys = Object.keys(fields) as (keyof T)[]
  function update(next: Readonly<T>) {
    for (const key of keys) {
      const field = fields[key]
      if (field.value !== next[key]) {
        field.value = next[key]
        changed?.(key)
      }
    }
  }
  return { state: proxyRefs(fields), update }
}
