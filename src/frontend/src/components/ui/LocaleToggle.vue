<template>
    <button
        type="button"
        class="fsusblog-locale-toggle"
        :class="{ 'fsusblog-locale-toggle--bordered': bordered }"
        :aria-label="t('common.locale.toggleLabel')"
        :title="t('common.locale.toggleLabel')"
        @click="toggleLocale"
    >
        <span :class="{ 'fsusblog-locale-toggle__active': locale === 'zh-CN' }">中</span>
        <span aria-hidden="true">/</span>
        <span :class="{ 'fsusblog-locale-toggle__active': locale === 'en-US' }">EN</span>
    </button>
</template>

<script setup lang="ts">
import { useI18nText } from '@/composables/useI18nText';

withDefaults(defineProps<{
    bordered?: boolean;
}>(), {
    bordered: false
});

const { locale, t, toggleLocale } = useI18nText();
</script>

<style scoped>
.fsusblog-locale-toggle {
    display: inline-flex;
    min-height: 2.5rem;
    min-width: 2.75rem;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    border: 0;
    border-radius: var(--fsus-radius-control-small);
    background: transparent;
    color: var(--fsusblog-text-muted);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    padding-inline: var(--fsus-space-2);
}

.fsusblog-locale-toggle:hover,
.fsusblog-locale-toggle:focus-visible {
    color: var(--fsusblog-text-primary);
}

.fsusblog-locale-toggle--bordered {
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control);
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-secondary);
}

.fsusblog-locale-toggle--bordered:hover {
    border-color: var(--fsusblog-color-primary);
    background: var(--fsusblog-page-bg-soft);
    color: var(--fsusblog-color-primary);
}

.fsusblog-locale-toggle:focus-visible {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.fsusblog-locale-toggle__active {
    color: var(--fsusblog-text-primary);
    font-weight: 700;
}
</style>
