export const PUBLIC_FILTER_TYPE = Object.freeze({
    category: 'category',
    tag: 'tag',
    search: 'search'
} as const);

export type PublicFilterType = typeof PUBLIC_FILTER_TYPE[keyof typeof PUBLIC_FILTER_TYPE];

const PUBLIC_FILTER_TYPE_SET = new Set<string>(Object.values(PUBLIC_FILTER_TYPE));

const PUBLIC_FILTER_LABELS = Object.freeze({
    [PUBLIC_FILTER_TYPE.category]: '分类',
    [PUBLIC_FILTER_TYPE.tag]: '标签',
    [PUBLIC_FILTER_TYPE.search]: '搜索'
} as const satisfies Record<PublicFilterType, string>);

export function isPublicFilterType(value: unknown): value is PublicFilterType
{
    return typeof value === 'string' && PUBLIC_FILTER_TYPE_SET.has(value);
}

export function normalizePublicFilterType(
    value: unknown,
    fallback: PublicFilterType = PUBLIC_FILTER_TYPE.search
): PublicFilterType
{
    return isPublicFilterType(value) ? value : fallback;
}

export function getPublicFilterLabel(filterType: PublicFilterType): string
{
    return PUBLIC_FILTER_LABELS[filterType];
}

export function shouldShowPublicFilterSearchSort(filterType: PublicFilterType): boolean
{
    return filterType === PUBLIC_FILTER_TYPE.search;
}
