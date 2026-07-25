import type { LocaleMessages } from './keys'

export type LocaleBundle = { readonly default: LocaleMessages }

const LOADERS: Record<string, () => Promise<LocaleBundle>> = {
    'zh-CN': () => import('./zh-CN'),
    'en-US': () => import('./en-US')
}

const CACHE = new Map<string, LocaleMessages>()

export function hasBundle(code: string): boolean {
    return code in LOADERS
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

    const loader = LOADERS[code]
    if (!loader) {
        throw new Error(`locale_bundle_unavailable:${code}`)
    }

    const mod = await loader()
    CACHE.set(code, mod.default)
    return mod.default
}
