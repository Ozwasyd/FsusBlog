import type { LocaleSelectorItem } from '@/components/ui/localeSelectorTypes';

export function findActiveLocaleItem(
    items: readonly LocaleSelectorItem[],
    activeLocale: string
): LocaleSelectorItem | null
{
    return items.find((item) => item.code === activeLocale) ?? items[0] ?? null;
}

export function localeTriggerLabel(
    item: LocaleSelectorItem | null,
    activeLocale: string,
    compact: boolean
): string
{
    if (!item)
    {
        return activeLocale;
    }
    return compact ? item.code : item.nativeName;
}

export function localeTriggerAriaLabel(
    item: LocaleSelectorItem | null,
    activeLocale: string
): string
{
    return item ? `${item.nativeName} (${item.code})` : activeLocale;
}

export function selectedLocaleIndex(
    items: readonly LocaleSelectorItem[],
    activeLocale: string
): number
{
    const index = items.findIndex((item) => item.code === activeLocale);
    return index >= 0 ? index : 0;
}

export function localeRetryLabel(
    items: readonly LocaleSelectorItem[],
    code: string | null
): string
{
    return code ? items.find((item) => item.code === code)?.nativeName ?? code : '';
}

export function localeItemDomId(menuId: string, code: string): string
{
    return `${menuId}-item-${code}`;
}

export function isLocaleItemSelected(item: LocaleSelectorItem, activeLocale: string): boolean
{
    return item.selected || item.code === activeLocale;
}

export function isLocaleItemPending(item: LocaleSelectorItem, pendingLocale: string | null): boolean
{
    return pendingLocale === item.code;
}
