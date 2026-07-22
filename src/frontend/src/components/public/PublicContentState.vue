<template>
    <section
        class="public-content-state"
        :class="[`public-content-state--${size}`, `public-content-state--${tone}`]"
        :role="role || undefined"
        :aria-live="ariaLive || undefined"
    >
        <div
            class="public-content-state__rule"
            aria-hidden="true"
        ></div>
        <div class="public-content-state__title-row">
            <span
                v-if="publicPeriodMotif.contentState.showsForTone(tone)"
                :class="publicPeriodMotif.loading.className"
                aria-hidden="true"
            ></span>
            <p class="public-content-state__title">{{ title }}</p>
        </div>
        <p
            v-if="description"
            class="public-content-state__description"
        >{{ description }}</p>
        <div
            v-if="$slots.default"
            class="public-content-state__actions"
        >
            <slot />
        </div>
    </section>
</template>

<script setup lang="ts">
import { publicPeriodMotif } from '@/ui-contracts/publicPeriodMotif';

withDefaults(defineProps<{
    title: string;
    description?: string;
    tone?: 'neutral' | 'error';
    size?: 'inline' | 'page';
    role?: 'status' | 'alert';
    ariaLive?: 'polite' | 'assertive';
}>(), {
    description: '',
    tone: 'neutral',
    size: 'inline',
    role: undefined,
    ariaLive: undefined
});
</script>

<style scoped>
.public-content-state
 {
    color: var(--fsusblog-text-secondary);
}

.public-content-state--inline
 {
    padding: 2rem 0;
}

.public-content-state--page
 {
    width: min(100%, 32rem);
    padding: 3rem 0;
}

.public-content-state__rule
 {
    width: 3rem;
    height: 1px;
    margin-bottom: 1.25rem;
    background: var(--fsusblog-panel-border-strong, var(--fsusblog-panel-border));
}

.public-content-state--error .public-content-state__rule
 {
    background: var(--fsusblog-color-error, var(--fsusblog-panel-border-strong, var(--fsusblog-panel-border)));
}

.public-content-state__title-row
 {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
}

.public-content-state__title
 {
    margin: 0;
    color: var(--fsusblog-text-primary);
    font-size: 1rem;
    font-weight: 700;
    line-height: 1.6;
}

.public-content-state--page .public-content-state__title
 {
    font-size: 1.125rem;
}

.public-content-state__description
 {
    margin: 0.5rem 0 0;
    color: var(--fsusblog-text-tertiary);
    font-size: 14px;
    line-height: 1.8;
}

.public-content-state__actions
 {
    margin-top: 1.25rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
}
</style>
