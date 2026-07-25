import type { LocaleMessages } from './keys'
import { REGISTRY_BY_CODE } from './registry'

const CACHE = new Map<string, LocaleMessages>()

export function hasBundle(code: string): boolean {
    const desc = REGISTRY_BY_CODE.get(code)
    return desc?.loader !== null
}

export function getCachedBundle(code: string): LocaleMessages | undefined {
    return CACHE.get(code)
}

export function evictBundle(code: string): void {
    CACHE.delete(code)
}

export async function loadBundle(code: string): Promise<LocaleMessages> {
    const cached = CACHE.get(code)
    if (cached) return cached

    const desc = REGISTRY_BY_CODE.get(code)
    if (!desc?.loader) {
        throw new Error(`locale_bundle_unavailable:${code}`)
    }

    const mod = await desc.loader()
    CACHE.set(code, mod.default)
    return mod.default
}
