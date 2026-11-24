import { computed, proxyRefs, ref, shallowRef, type ComputedRef, type Ref } from 'vue'

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

export function createSnapshotRefs<T extends object>(initial: Readonly<T>, shallow: readonly (keyof T)[] = []) {
  const shallowSet = new Set<keyof T>(shallow)
  const fields = {} as { [K in keyof T]: Ref<T[K]> }
  for (const key of Object.keys(initial) as (keyof T)[]) {
    fields[key] = (shallowSet.has(key) ? shallowRef(initial[key]) : ref(initial[key])) as Ref<T[typeof key]>
  }
  return fields
}

export function computedProps<T extends object>(source: Readonly<Ref<T>>): { [K in keyof T]: ComputedRef<T[K]> } {
  const result = {} as { [K in keyof T]: ComputedRef<T[K]> }
  for (const key of Object.keys(source.value) as (keyof T)[]) {
    result[key] = computed(() => source.value[key])
  }
  return result
}
