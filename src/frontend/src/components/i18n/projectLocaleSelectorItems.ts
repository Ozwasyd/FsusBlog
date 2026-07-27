import type { LocaleSelectorItem } from '@/components/ui/localeSelectorTypes'
import { ENABLED_LOCALES } from '@/locales'

/**
 * Projects #1704 catalog descriptors into LocaleSelector items.
 * Shared by the runtime adapter and tests so item order stays catalog-identical
 * for AOT and client.
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
