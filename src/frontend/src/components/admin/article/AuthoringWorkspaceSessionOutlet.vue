<template>
    <Teleport
        :to="placement.target"
        :disabled="!placement.target"
    >
        <div
            class="authoring-workspace-session-outlet"
            :hidden="!placement.visible"
            :inert="!placement.visible"
        >
            <slot />
        </div>
    </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { AuthoringWorkspaceLayoutProjection } from '@/services/authoring/authoringWorkspaceLayoutController';
import type { OpenArticleDocumentEntry } from '@/services/authoring/openArticleDocumentRegistry';

defineOptions({ name: 'AuthoringWorkspaceSessionOutlet' });

const props = defineProps<{
    projection: AuthoringWorkspaceLayoutProjection | null;
    leadingRegion: HTMLElement | null;
    trailingRegion: HTMLElement | null;
    /** Fresh original registry/native owner read; never a route-derived session identity. */
    readEntry: () => OpenArticleDocumentEntry | null;
    /** Only the existing primary Write editor receives fallback visibility. */
    primary: boolean;
}>();

// A session's slot subtree has one persistent VNode parent. Placement/visibility
// changes only move its DOM; this host never acquires, binds, pauses or releases it.
const placement = computed(() =>
{
    const projection = props.projection;
    const fallback = () => Object.freeze({ target: props.primary ? props.leadingRegion : null,
                                           visible: props.primary });
    if (!projection)
    {
        return fallback();
    }
    let entry: OpenArticleDocumentEntry | null;
    try
    {
        entry = props.readEntry();
    }
    catch
    {
        return Object.freeze({ target: null, visible: false });
    }
    if (props.projection !== projection)
    {
        return fallback();
    }
    if (!entry)
    {
        return Object.freeze({ target: props.primary ? props.leadingRegion : null, visible: false });
    }
    const groupIndex = projection.state.groups.findIndex(group => group.groupId === entry.owningGroupId
        && group.tabs.some(tab => tab.tabId === entry.tabId && tab.editorSessionRef === entry.editorSessionRef
            && tab.documentEpoch === entry.documentContext.documentEpoch && tab.lifecycleRevision === entry.lifecycleRevision));
    const group = projection.state.groups[groupIndex];
    const target = groupIndex === 0 ? props.leadingRegion : groupIndex === 1 ? props.trailingRegion : null;
    return Object.freeze({ target, visible: !!target && !!group && group.activeTabId === entry.tabId });
});
</script>

<style scoped lang="scss">
.authoring-workspace-session-outlet
{
    min-inline-size: 0;
    max-inline-size: 100%;
}

.authoring-workspace-session-outlet[hidden]
{
    display: none;
}
</style>
