<template>
    <slot
        :model="model"
        :state="state"
        :refresh="refresh"
    />
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue';

import { articlePropertyValuesApi } from '@/api/articlePropertyValues';
import type { ArticlePropertyValueReadResponse } from '@/codecs/binary/articlePropertyValueReadCodecs';
import type { ArticleDocumentContext } from '@/services/authoring/articleDocumentContext';

// Nested read consumer for the existing inspector. The owner supplies its live
// binding.context and explicit permission/schema refresh generation. Body source
// revisions are not metadata revisions. No draft or mutation transport exists here.
const props = defineProps<{
    context: ArticleDocumentContext | null;
    definitionOwnerUserId: string | null;
    enabled: boolean;
    readKey: string;
}>();

type ReadState = 'inactive' | 'article-required' | 'draft-unavailable' | 'loading' | 'ready' | 'unavailable';

defineSlots<{
    default(props: {
        model: ArticlePropertyValueReadResponse | null;
        state: ReadState;
        refresh: () => void;
    }): unknown;
}>();

const model = shallowRef<ArticlePropertyValueReadResponse | null>(null);
const state = ref<ReadState>('inactive');
const refreshGeneration = ref(0);
const refresh = (): void =>
{
    refreshGeneration.value++;
};

const stop = watch([
    () => props.context?.articleId,
    () => props.context?.documentId,
    () => props.context?.documentEpoch,
    () => props.context?.editorSessionId,
    () => props.context?.siteScope,
    () => props.context?.userScope,
    () => props.context?.draftId,
    () => props.context?.draftRevision,
    () => props.definitionOwnerUserId,
    () => props.enabled,
    () => props.readKey,
    () => refreshGeneration.value
], async (_current, _previous, onCleanup) =>
{
    model.value = null;
    const context = props.context;
    if (!props.enabled || context === null)
    {
        state.value = 'inactive';
        return;
    }
    if (context.articleId === null)
    {
        state.value = 'article-required';
        return;
    }
    if (context.draftRevision !== null)
    {
        state.value = 'draft-unavailable';
        return;
    }
    const controller = new AbortController();
    let current = true;
    onCleanup(() =>
    {
        current = false;
        controller.abort();
    });
    state.value = 'loading';
    try
    {
        const response = await articlePropertyValuesApi.read(context.articleId, props.definitionOwnerUserId, controller.signal);
        if (!current)
        {
            return;
        }
        // Transport/Server own validation, authorization and reconciliation.
        // Refuse cross-article delivery without interpreting any typed payload.
        if (response.articleId !== context.articleId)
        {
            state.value = 'unavailable';
            return;
        }
        model.value = response;
        state.value = 'ready';
    }
    catch
    {
        if (current)
        {
            state.value = 'unavailable';
        }
    }
}, { immediate: true, flush: 'sync' });

onBeforeUnmount(() =>
{
    stop();
    model.value = null;
});
</script>
