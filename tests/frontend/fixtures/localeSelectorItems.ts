import { ENABLED_LOCALES } from '@/locales'
import type { LocaleSelectorItem } from '@/components/ui/localeSelectorTypes'

/**
 * Projects the generated #1704 catalog descriptors into LocaleSelector items.
 * Mirrors the caller-side projection contract: the component never enumerates
 * enabled locales itself.
 */
export function projectLocaleSelectorItems(
    activeLocale: string,
    options: Readonly<{ hrefByCode?: Readonly<Record<string, string>> }> = {}
): LocaleSelectorItem[] {
    return ENABLED_LOCALES.map((descriptor) => ({
        code: descriptor.code,
        nativeName: descriptor.nativeName,
        englishName: descriptor.englishName,
        direction: descriptor.direction,
        selected: descriptor.code === activeLocale,
        href: options.hrefByCode?.[descriptor.code]
    }))
}
