import { type LocaleDescriptor, REGISTRY_BY_CODE } from './registry'

export function syncLocaleDocumentMetadata(locale: string): void {
    if (typeof document === 'undefined') return

    document.documentElement.lang = locale
    const descriptor = REGISTRY_BY_CODE.get(locale)
    if (descriptor) {
        document.documentElement.dir = descriptor.direction
    }

    let openGraphLocale = document.head.querySelector<HTMLMetaElement>('meta[property="og:locale"]')
    if (!openGraphLocale) {
        openGraphLocale = document.createElement('meta')
        openGraphLocale.setAttribute('property', 'og:locale')
        document.head.appendChild(openGraphLocale)
    }
    openGraphLocale.content = locale.replace('-', '_')
}
