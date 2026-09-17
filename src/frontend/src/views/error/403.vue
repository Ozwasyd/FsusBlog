<template>
    <main
        class="blog-page-shell error-page-shell min-h-[75vh] px-5 py-10 sm:px-8 sm:py-16"
        aria-labelledby="forbidden-page-title"
    >
        <section class="mx-auto w-full max-w-xl animate-in fade-in transition-fsus transition-fsus-fast">
            <p
                class="mb-4 text-sm font-bold leading-6 text-[var(--fsusblog-text-muted)]"
                aria-hidden="true"
            >
                {{ copy.codePrefix }}<span class="text-[var(--fsusblog-text-muted)]">.</span>
            </p>

            <div class="safe-inline-wrap">
                <h1
                    id="forbidden-page-title"
                    class="text-2xl font-bold leading-tight tracking-normal text-[var(--fsusblog-text-primary)] sm:text-3xl"
                >
                    {{ copy.title }}
                </h1>
                <p class="mt-4 text-sm font-normal leading-7 text-[var(--fsusblog-text-secondary)]">
                    {{ copy.description }}
                </p>

                <div class="mt-6 flex flex-col gap-3 sm:flex-row">
                    <ElButton
                        :tag="RouterLink"
                        to="/"
                        type="primary"
                    >
                        {{ copy.homeCta }}
                    </ElButton>

                    <ElButton @click="handleSwitchAccount">
                        {{ copy.reLoginCta }}
                    </ElButton>
                </div>
            </div>
        </section>
    </main>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';

import { useI18nText } from '@/composables/useI18nText';
import { useUserStore } from '@/store/user';

const { messages } = useI18nText();
const copy = computed(() => messages.value.errors.forbidden);

const router = useRouter();
const route = useRoute();
const userStore = useUserStore();

const handleSwitchAccount = async () =>
{
    await userStore.logout();
    router.push({
        path: '/login',
        query: {
            redirect: route.fullPath
        }
    });
};
</script>

<style scoped>
@reference "@/assets/main.css";

.error-page-shell
 {
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-primary);
}
</style>
