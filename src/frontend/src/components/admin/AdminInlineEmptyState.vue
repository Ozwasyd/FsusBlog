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
            <div class="admin-inline-empty-state__actions">
                <slot name="actions" />
            </div>
        </template>
    </FsusUiEmptyState>
</template>
<script setup lang="ts">
import { Comment, computed, Text, useSlots, type VNode } from 'vue';

import {
    FsusUiEmptyState,
    toFsusUiInlineEmptyStateProps
} from '@/fsusui/primitiveAdapters';

type AdminInlineEmptyStateKind = 'neutral' | 'error' | 'loading';

defineOptions({ name: 'AdminInlineEmptyState' });
const props = withDefaults(defineProps<{
    title: string;
    description?: string;
    content?: string;
    state?: AdminInlineEmptyStateKind;
}>(), {
    description: '',
    content: '',
    state: 'neutral'
});

const emptyStateProps = toFsusUiInlineEmptyStateProps('adminCollection');
const descriptionText = computed(() => props.description || props.content || '');
const stateRole = computed(() => props.state === 'error' ? 'alert' : 'status');
const stateAriaLive = computed(() => props.state === 'error' ? 'assertive' : 'polite');
const slots = useSlots();

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
        if (Array.isArray(node.children))
        {
            return hasRenderableContent(node.children as VNode[]);
        }
        return true;
    });
}

function hasActionContent(): boolean
{
    return hasRenderableContent(slots.actions?.() ?? []);
}
</script>

<style scoped>
.admin-inline-empty-state
 {
    --fsus-admin-inline-empty-state-inset: var(--fsus-space-5);

    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    padding: var(--fsus-admin-inline-empty-state-inset);
    text-align: left;
}

.admin-inline-empty-state__actions
 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fsus-space-3);
    margin-top: var(--fsus-space-3);
}

@media (width <= 639px)
 {
    .admin-inline-empty-state
 {
        --fsus-admin-inline-empty-state-inset: var(--fsus-space-4);
    }

    .admin-inline-empty-state__actions
 {
        gap: var(--fsus-space-2);
    }
}
</style>
