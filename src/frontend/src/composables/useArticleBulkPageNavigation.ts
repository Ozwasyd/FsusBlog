import { computed, nextTick, ref, watch, type Ref } from 'vue';

/** Only opaque page references are retained; rows remain in the single canonical page. */
export function useArticleBulkPageNavigation(
    current: () => { scopeDigest: string; reference: string; } | null,
    region: Ref<HTMLElement | null>
)
{
    const references = ref<string[]>([]);
    const position = ref(-1);
    watch(current, async (page, previous) =>
    {
        if (!page || page.scopeDigest !== previous?.scopeDigest)
        {
            references.value = [];
            position.value = -1;
        }
        if (!page)
        {
            return;
        }
        const known = references.value.indexOf(page.reference);
        if (known >= 0)
        {
            position.value = known;
        }
        else
        {
            references.value = references.value.slice(0, position.value + 1);
            references.value.push(page.reference);
            // At 50 rows/page the maximum frozen selection needs 200 pages; smaller pages keep a bounded window.
            if (references.value.length > 200)
            {
                references.value.shift();
            }
            position.value = references.value.length - 1;
        }
        if (page.reference !== previous?.reference || page.scopeDigest !== previous?.scopeDigest)
        {
            await nextTick();
            region.value?.focus();
        }
    }, { immediate: true });
    return { previousReference: computed(() => references.value[position.value - 1] ?? null) };
}
