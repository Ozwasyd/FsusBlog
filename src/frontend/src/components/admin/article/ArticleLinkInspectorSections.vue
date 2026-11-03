<template>
    <p
        v-if="!available"
        role="status"
    >{{ labels.unavailable }}</p>
    <template v-else>
        <FsusUiSettingsSection
            v-for="section in sections"
            :key="section"
            :title="labels.titles[section]"
            :aria-label="labels.titles[section]"
            title-tag="h3"
            density="compact"
        >
            <template
                v-if="currentPage(section)"
                #actions
            >
                <FsusUiInlineActions>
                    <FsusUiButton
                        native-type="button"
                        text
                        :disabled="!pages[section]?.hasPreviousPage"
                        @click="requestPage(section, 'previous')"
                    >{{ labels.previous }}</FsusUiButton>
                    <FsusUiButton
                        native-type="button"
                        text
                        :disabled="!pages[section]?.hasNextPage"
                        @click="requestPage(section, 'next')"
                    >{{ labels.next }}</FsusUiButton>
                </FsusUiInlineActions>
            </template>
            <FsusUiResourceList
                v-if="currentPage(section)?.rowIds.length"
                :key="JSON.stringify([contextKey, section, pages[section]?.pageKey])"
                density="compact"
            >
                <FsusUiResourceListItem
                    v-for="rowId in currentPage(section)?.rowIds"
                    :key="rowId"
                    density="compact"
                >
                    <slot
                        :name="section"
                        :row-id="rowId"
                    />
                </FsusUiResourceListItem>
            </FsusUiResourceList>
            <p
                v-else
                role="status"
            >{{ statusText(section) }}</p>
        </FsusUiSettingsSection>
    </template>
</template>

<script setup lang="ts">
import { FsusUiButton } from '@/fsusui/button';
import {
    FsusUiInlineActions,
    FsusUiResourceList,
    FsusUiResourceListItem,
    FsusUiSettingsSection
} from '@/fsusui/settingsSection';

const sections = ['outgoing', 'backlinks', 'risks', 'mentions'] as const;
type Section = typeof sections[number];
type PageState = 'current' | 'loading' | 'error' | 'stale' | 'rebuild-required' | 'offline';

// Local presentation only. The owner supplies verified pages and canonical row
// controls; these keys cannot establish permissions or decode server facts.
interface PresentationPage {
    contextKey: string;
    pageKey: string;
    state: PageState;
    rowIds: readonly string[];
    hasPreviousPage: boolean;
    hasNextPage: boolean;
}

const props = defineProps<{
    available: boolean;
    contextKey: string;
    pages: Partial<Record<Section, PresentationPage>>;
    labels: {
        titles: Record<Section, string>;
        states: Record<Exclude<PageState, 'current'>, string>;
        unavailable: string;
        empty: string;
        previous: string;
        next: string;
    };
}>();

const emit = defineEmits<{
    page: [request: {
        section: Section;
        direction: 'previous' | 'next';
        contextKey: string;
        pageKey: string;
    }];
}>();

function currentPage(section: Section): PresentationPage | null
{
    const page = props.pages[section];
    if (!props.available || !props.contextKey || page?.state !== 'current'
        || page.contextKey !== props.contextKey || !page.pageKey || page.rowIds.length > 20
        || page.rowIds.some((id) => !id) || new Set(page.rowIds).size !== page.rowIds.length)
    {
        return null;
    }
    return page;
}

function statusText(section: Section): string
{
    if (currentPage(section))
    {
        return props.labels.empty;
    }
    const page = props.pages[section];
    if (!page)
    {
        return props.labels.states.loading;
    }
    if (page.contextKey !== props.contextKey || page.state === 'current')
    {
        return props.labels.states.stale;
    }
    return props.labels.states[page.state];
}

function requestPage(section: Section, direction: 'previous' | 'next'): void
{
    const page = currentPage(section);
    if (!page || !(direction === 'previous' ? page.hasPreviousPage : page.hasNextPage))
    {
        return;
    }
    emit('page', { section, direction, contextKey: props.contextKey, pageKey: page.pageKey });
}
</script>
