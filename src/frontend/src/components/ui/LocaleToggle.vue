<template>
    <button
        type="button"
        class="fsusblog-locale-toggle"
        :class="{ 'fsusblog-locale-toggle--bordered': bordered }"
        :aria-label="toggleLabel"
        :title="toggleLabel"
        @click="toggleLocale"
    >
        <span class="fsusblog-locale-toggle__active" aria-hidden="true">Aa</span>
    </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18nText } from '@/composables/useI18nText';
import { getLocaleMessages, type SupportedLocale } from '@/locales';

const props = withDefaults(defineProps<{
    bordered?: boolean;
    localeOverride?: SupportedLocale | null;
}>(), {
    bordered: false,
    localeOverride: null
});

const { t, toggleLocale } = useI18nText();
const toggleLabel = computed(() => props.localeOverride
    ? getLocaleMessages(props.localeOverride).common.locale.toggleLabel
    : t('common.locale.toggleLabel'));
</script>

<style scoped>
.fsusblog-locale-toggle
 {
    display: inline-flex;
    min-height: 2.75rem;
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
    font-size: 14px;
    font-weight: 500;
    line-height: 1;
    padding-inline: var(--fsus-space-2);
}

.fsusblog-locale-toggle:hover,
.fsusblog-locale-toggle:focus-visible
 {
    color: var(--fsusblog-text-primary);
}

.fsusblog-locale-toggle--bordered
 {
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control);
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-secondary);
}

.fsusblog-locale-toggle--bordered:hover
 {
    border-color: var(--fsusblog-color-primary);
    background: var(--fsusblog-page-bg-soft);
    color: var(--fsusblog-color-primary);
}

.fsusblog-locale-toggle:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.fsusblog-locale-toggle__active
 {
    color: var(--fsusblog-text-primary);
    font-weight: 500;
}
</style>
