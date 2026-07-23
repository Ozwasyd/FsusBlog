<template>
    <FsusUiEmptyState
        v-bind="emptyStateProps"
        class="admin-inline-empty-state"
        :data-state="state"
        :role="stateRole"
        :aria-live="stateAriaLive"
        :aria-busy="state === 'loading' ? 'true' : undefined"
        :title="title"
        :description="descriptionText"
    >
        <template
            v-if="hasActionContent()"
            #actions
        >
            <div class="admin-inline-empty-state__actions"><slot name="actions" /></div>
        </template>
    </FsusUiEmptyState>
</template>

<script setup lang="ts">
import { Comment, computed, Text, useSlots, type VNode } from 'vue';

import { FsusUiEmptyState, toFsusUiInlineEmptyStateProps } from '@/fsusui/primitiveAdapters';

defineOptions({ name: 'AdminInlineEmptyState' });
const props = withDefaults(defineProps<{
    title: string;
    description?: string;
    content?: string;
    state?: 'neutral' | 'error' | 'loading';
}>(), {
    description: '',
    content: '',
    state: 'neutral'
});
const slots = useSlots();
const emptyStateProps = toFsusUiInlineEmptyStateProps('adminCollection');
const descriptionText = computed(() => props.description || props.content || '');
const stateRole = computed(() => props.state === 'error' ? 'alert' : 'status');
const stateAriaLive = computed(() => props.state === 'error' ? 'assertive' : 'polite');

function hasRenderableContent(nodes: VNode[]): boolean
{
    return nodes.some((node) =>
    {
        if (node.type === Comment)
        {
            return false;
        }
        if (node.type === Text)
        {
            return typeof node.children === 'string' && node.children.trim().length > 0;
        }
        return Array.isArray(node.children) ? hasRenderableContent(node.children as VNode[]) : true;
    });
}

function hasActionContent(): boolean
{
    return hasRenderableContent(slots.actions?.() ?? []);
}
</script>
