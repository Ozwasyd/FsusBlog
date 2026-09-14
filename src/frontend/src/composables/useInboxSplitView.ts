import { computed, ref, type Ref } from 'vue';

import { useMediaQuery } from '@/composables/useMediaQuery';

const MOBILE_BREAKPOINT = 1024;
type InboxMobilePane = 'list' | 'detail';

export function useInboxSplitView(selectedConversationId: Readonly<Ref<string>>)
{
    const isMobile = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const requestedMobilePane = ref<InboxMobilePane | null>(null);
    const mobilePane = computed<InboxMobilePane>((previousPane) =>
    {
        if (!isMobile.value)
        {
            return 'detail';
        }

        if (!selectedConversationId.value)
        {
            return 'list';
        }

        return requestedMobilePane.value ?? previousPane ?? 'list';
    });

    const openListPane = (): void =>
    {
        requestedMobilePane.value = 'list';
    };

    const openDetailPane = (): void =>
    {
        requestedMobilePane.value = 'detail';
    };

    return {
        isMobile,
        mobilePane,
        showListPane: computed(() => !isMobile.value || mobilePane.value === 'list'),
        showDetailPane: computed(() => !isMobile.value || mobilePane.value === 'detail'),
        openListPane,
        openDetailPane
    };
}
