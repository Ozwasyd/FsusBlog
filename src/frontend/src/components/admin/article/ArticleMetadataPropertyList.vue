<template>
    <section
        class="article-metadata-property-list"
        :aria-label="labels.properties"
        :aria-busy="loading"
    >
        <template v-if="available">
            <div class="article-metadata-property-list__actions">
                <ElButton
                    :disabled="blocked"
                    :aria-expanded="showAll"
                    @click="emit('update:showAll', !showAll)"
                >
                    {{ showAll ? labels.compact : labels.more }}
                </ElButton>
                <ElButton
                    v-if="canManage"
                    :disabled="blocked"
                    @click="emit('manage')"
                >
                    {{ labels.manage }}
                </ElButton>
            </div>
            <ElInput
                v-if="showAll"
                :model-value="query"
                :aria-label="labels.search"
                :disabled="blocked"
                @update:model-value="emit('update:query', $event)"
            />
        </template>

        <p
            ref="statusElement"
            class="article-metadata-property-list__status"
            role="status"
            tabindex="-1"
        >
            {{ statusText }}
        </p>
        <slot
            v-if="!blocked && !pageOverflow"
            name="status"
        />

        <div
            v-if="!blocked && !pageOverflow"
            :key="contextKey"
        >
            <ul
                :key="pageKey"
                class="article-metadata-property-list__fields"
                :aria-label="labels.properties"
            >
                <li
                    v-for="definitionId in definitionIds"
                    :key="definitionId"
                >
                    <slot
                        name="property"
                        :definition-id="definitionId"
                    />
                </li>
            </ul>
        </div>

        <nav
            v-if="available && (hasPreviousPage || hasNextPage)"
            class="article-metadata-property-list__actions"
            :aria-label="labels.pagination"
        >
            <ElButton
                :disabled="blocked || !hasPreviousPage"
                @click="requestPage('previous')"
            >
                {{ labels.previous }}
            </ElButton>
            <ElButton
                :disabled="blocked || !hasNextPage"
                @click="requestPage('next')"
            >
                {{ labels.next }}
            </ElButton>
        </nav>
    </section>
</template>

<script setup lang="ts">
import { ElButton, ElInput } from '@ozwasyd/element-plus';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

// Presentation only: the owner supplies a permission-filtered, ordered page of
// stable IDs and renders authoritative typed controls in the property slot.
// This budget limits mounted forms; it does not define a server schema limit.
const mountedPropertyBudget = 20;

const props = defineProps<{
    definitionIds: readonly string[];
    contextKey: string;
    pageKey: string;
    showAll: boolean;
    query: string;
    available: boolean;
    loading: boolean;
    stale: boolean;
    canManage: boolean;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
    labels: {
        properties: string;
        compact: string;
        more: string;
        manage: string;
        search: string;
        pagination: string;
        previous: string;
        next: string;
        unavailable: string;
        loading: string;
        stale: string;
        pageOverflow: string;
        empty: string;
        ready: string;
    };
}>();

const emit = defineEmits<{
    (event: 'update:showAll', value: boolean): void;
    (event: 'update:query', value: string): void;
    (event: 'page', direction: 'previous' | 'next'): void;
    (event: 'manage'): void;
}>();

const blocked = computed(() => !props.available || props.loading || props.stale);
const pageOverflow = computed(() => props.definitionIds.length > mountedPropertyBudget);
const statusText = computed(() =>
{
    if (!props.available)
    {
        return props.labels.unavailable;
    }
    if (props.stale)
    {
        return props.labels.stale;
    }
    if (props.loading)
    {
        return props.labels.loading;
    }
    if (pageOverflow.value)
    {
        return props.labels.pageOverflow;
    }
    return props.definitionIds.length === 0 ? props.labels.empty : props.labels.ready;
});

const statusElement = ref<HTMLElement | null>(null);
let focusGeneration = 0;
let disposed = false;
let requestedPage: {
    contextKey: string;
    pageKey: string;
    query: string;
    showAll: boolean;
} | null = null;

const requestPage = (direction: 'previous' | 'next'): void =>
{
    if (blocked.value || !(direction === 'next' ? props.hasNextPage : props.hasPreviousPage))
    {
        return;
    }
    focusGeneration++;
    requestedPage = {
        contextKey: props.contextKey,
        pageKey: props.pageKey,
        query: props.query,
        showAll: props.showAll
    };
    emit('page', direction);
};

watch(() => [props.contextKey, props.query, props.showAll], () =>
{
    focusGeneration++;
    requestedPage = null;
}, { flush: 'sync' });

watch(() => [props.pageKey, blocked.value, pageOverflow.value], () =>
{
    focusGeneration++;
}, { flush: 'sync' });

onBeforeUnmount(() =>
{
    disposed = true;
    focusGeneration++;
    requestedPage = null;
});

watch(() => [props.contextKey, props.showAll, props.query, props.pageKey, blocked.value], async () =>
{
    if (!requestedPage)
    {
        return;
    }
    if (requestedPage.contextKey !== props.contextKey || requestedPage.query !== props.query
        || requestedPage.showAll !== props.showAll)
    {
        requestedPage = null;
        return;
    }
    if (requestedPage.pageKey === props.pageKey || blocked.value)
    {
        return;
    }
    const request = requestedPage;
    const pageKey = props.pageKey;
    const generation = focusGeneration;
    requestedPage = null;
    await nextTick();
    if (!disposed && generation === focusGeneration && props.contextKey === request.contextKey
        && props.query === request.query && props.showAll === request.showAll
        && props.pageKey === pageKey && !blocked.value && !pageOverflow.value)
    {
        statusElement.value?.focus();
    }
});
</script>

<style scoped>
.article-metadata-property-list
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-3);
}

.article-metadata-property-list__actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-2);
}

.article-metadata-property-list__fields
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
}

.article-metadata-property-list__fields > li
 {
    min-width: 0;
    overflow-wrap: anywhere;
}

.article-metadata-property-list__status
 {
    margin: 0;
    color: var(--el-text-color-regular);
}
</style>
