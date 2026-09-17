<template>
    <div class="account-page profile-page">
        <FsusUiTaskPageHeader
            :title="profileCopy.pageTitle"
            :description="profileCopy.pageDescription"
            class="account-task-page-header"
        />

        <FsusUiEmptyState
            size="inline"
            :illustration="false"
            role="status"
            aria-live="polite"
            :title="profileCopy.emptyTitle"
            :description="profileCopy.emptyContent"
        >
            <template #actions>
                <RouterLink
                    to="/user/identity"
                    class="inline-flex rounded-[var(--fsus-radius-control)] bg-[var(--fsusblog-color-primary)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--fsusblog-color-primary-hover)] focus-visible:outline-none"
                >
                    {{ profileCopy.openIdentityCta }}
                </RouterLink>
            </template>
        </FsusUiEmptyState>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';

import { useI18nText } from '@/composables/useI18nText';
import { FsusUiEmptyState, FsusUiTaskPageHeader } from '@/fsusui';

const { messages } = useI18nText();
const profileCopy = computed(() => messages.value.identity.profile);

const router = useRouter();

onMounted(() =>
{
    void router.replace({ name: 'UserIdentityOverview' });
});
</script>
