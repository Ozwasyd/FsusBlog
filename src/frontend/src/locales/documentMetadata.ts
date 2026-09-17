import { getLocaleDescriptor, type SupportedLocale } from './keys';

export function syncLocaleDocumentMetadata(locale: SupportedLocale): void
{
    if (typeof document === 'undefined')
    {
        return;
    }

    const descriptor = getLocaleDescriptor(locale);
    document.documentElement.lang = descriptor.documentLanguage;
    document.documentElement.dir = descriptor.direction;

    let openGraphLocale = document.head.querySelector<HTMLMetaElement>('meta[property="og:locale"]');
    if (!openGraphLocale)
    {
        openGraphLocale = document.createElement('meta');
        openGraphLocale.setAttribute('property', 'og:locale');
        document.head.appendChild(openGraphLocale);
    }
    openGraphLocale.content = descriptor.openGraphLocale;
}
