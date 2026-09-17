<template>
    <time
        :datetime="datetime"
        :title="titleText"
    >
        <slot>{{ displayText }}</slot>
    </time>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useI18nText } from '@/composables/useI18nText';

const props = withDefaults(defineProps<{
    value?: string | number | Date | null;
    text?: string;
    format?: 'date' | 'datetime';
}>(), {
    value: null,
    text: '',
    format: 'datetime'
});

const { formatDate } = useI18nText();

const parsedDate = computed(() =>
{
    if (!props.value)
    {
        return null;
    }

    const date = props.value instanceof Date ? props.value : new Date(props.value);
    return Number.isNaN(date.getTime()) ? null : date;
});

const datetime = computed(() => parsedDate.value?.toISOString() ?? '');
const titleText = computed(() => parsedDate.value
    ? formatDate(parsedDate.value, {
        year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
    })
    : props.text);
const displayText = computed(() =>
{
    if (props.text)
    {
        return props.text;
    }

    if (!parsedDate.value)
    {
        return '-';
    }

    return formatDate(parsedDate.value, props.format === 'date'
        ? { year: 'numeric', month: 'short', day: 'numeric' }
        : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
});
</script>
