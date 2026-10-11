<template>
    <div
        ref="parkingElement"
        class="authoring-workspace-session-parking"
    >
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
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';

import type { AuthoringWorkspaceOutletExpectation } from '@/services/authoring/authoringWorkspaceLayoutContext';
import type { OpenArticleDocumentEntry } from '@/services/authoring/openArticleDocumentRegistry';

defineOptions({ name: 'AuthoringWorkspaceSessionOutlet' });

const props = defineProps<{
    expectation: AuthoringWorkspaceOutletExpectation | null;
    placementRoot: HTMLElement | null;
    leadingRegion: HTMLElement | null;
    trailingRegion: HTMLElement | null;
    ownsRegion: (index: 0 | 1, node: HTMLElement) => boolean;
    containsPlacementNode: (node: HTMLElement) => boolean;
    revokePlacement: () => void;
    /** Bind the original read to captured real owner instances and expected revisions. */
    readEntry: (expected: AuthoringWorkspaceOutletExpectation) => OpenArticleDocumentEntry | null;
    primary: boolean;
}>();
const parkingElement = shallowRef<HTMLElement | null>(null);
const nodeGeneration = shallowRef(0n);
let disposed = false;
let observer: MutationObserver | null = null;
let stopWatchingRoot: (() => void) | null = null;
let invalidatedNodes = false;
let observerGeneration = 0n;
const snapshot = () => Object.freeze({ expectation: props.expectation, root: props.placementRoot,
                                       leading: props.leadingRegion, trailing: props.trailingRegion, parking: parkingElement.value, generation: nodeGeneration.value,
                                       primary: props.primary, readEntry: props.readEntry, ownsRegion: props.ownsRegion, containsPlacementNode: props.containsPlacementNode });
type Snapshot = ReturnType<typeof snapshot>;
const isCurrent = (value: Snapshot): boolean => !disposed && value.generation === nodeGeneration.value
    && props.expectation === value.expectation && props.placementRoot === value.root
    && props.leadingRegion === value.leading && props.trailingRegion === value.trailing && parkingElement.value === value.parking
    && props.primary === value.primary && props.readEntry === value.readEntry && props.ownsRegion === value.ownsRegion
    && props.containsPlacementNode === value.containsPlacementNode;

function containsOwnedNode(node: HTMLElement | null, value: Snapshot): boolean
{
    if (!isCurrent(value) || !value.root?.isConnected || !node?.isConnected || node.ownerDocument !== value.root.ownerDocument)
    {
        return false;
    }
    try
    {
        const owned = value.containsPlacementNode(node);
        return owned && isCurrent(value) && value.root.isConnected && node.isConnected && value.root.contains(node);
    }
    catch
    {
        return false;
    }
}

function isOwnedRegion(index: 0 | 1, node: HTMLElement | null, value: Snapshot): boolean
{
    if (!containsOwnedNode(node, value) || !node)
    {
        return false;
    }
    try
    {
        const owned = value.ownsRegion(index, node);
        return owned && isCurrent(value) && containsOwnedNode(node, value)
            && node === (index === 0 ? props.leadingRegion : props.trailingRegion);
    }
    catch
    {
        return false;
    }
}

function fallback(value: Snapshot): Readonly<{ target: HTMLElement | null; visible: boolean; }>
{
    const leading = value.primary && isOwnedRegion(0, value.leading, value) ? value.leading : null;
    return Object.freeze({ target: leading, visible: value.primary && isCurrent(value)
        && (leading !== null || containsOwnedNode(value.parking, value)) });
}

// The editor has one persistent VNode parent. Invalid targets park the same subtree,
// without acquiring, rebinding, releasing or constructing another native editor.
const placement = computed(() =>
{
    const value = snapshot();
    const expected = value.expectation;
    if (!expected)
    {
        return fallback(value);
    }
    const leadingOwned = isOwnedRegion(0, value.leading, value);
    const trailingOwned = isOwnedRegion(1, value.trailing, value);
    if (!isCurrent(value) || !leadingOwned || !trailingOwned)
    {
        return fallback(value);
    }
    let entry: OpenArticleDocumentEntry | null;
    try
    {
        entry = value.readEntry(expected);
    }
    catch
    {
        return Object.freeze({ target: null, visible: false });
    }
    if (!isCurrent(value) || !isOwnedRegion(0, value.leading, value) || !isOwnedRegion(1, value.trailing, value))
    {
        return fallback(value);
    }
    if (!entry)
    {
        return Object.freeze({ target: null, visible: false });
    }
    const groupIndex = expected.projection.state.groups.findIndex(group => group.groupId === entry.owningGroupId
        && group.tabs.some(tab => tab.tabId === entry.tabId && tab.editorSessionRef === entry.editorSessionRef
            && tab.documentEpoch === entry.documentContext.documentEpoch && tab.lifecycleRevision === entry.lifecycleRevision));
    const group = expected.projection.state.groups[groupIndex];
    const target = groupIndex === 0 ? value.leading : groupIndex === 1 ? value.trailing : null;
    return Object.freeze({ target, visible: !!target && !!group && group.activeTabId === entry.tabId && isCurrent(value) });
});

// React to real disconnection/reparenting even when Vue props keep the same node refs.
// This observer issues no session/resource/retention receipt.
onMounted(() =>
{
    stopWatchingRoot = watch(() => props.placementRoot, root =>
    {
        observer?.disconnect();
        const observedGeneration = ++observerGeneration;
        nodeGeneration.value += 1n;
        invalidatedNodes = false;
        if (!root || disposed)
        {
            return;
        }
        observer = new MutationObserver(() =>
        {
            if (disposed || observerGeneration !== observedGeneration || props.placementRoot !== root)
            {
                return;
            }
            nodeGeneration.value += 1n;
            const value = snapshot();
            const invalid = !isOwnedRegion(0, value.leading, value) || !isOwnedRegion(1, value.trailing, value);
            if (invalid && !invalidatedNodes)
            {
                invalidatedNodes = true;
                try
                {
                    props.revokePlacement();
                }
                catch
                {
                    // Node generation already revoked local placement; do not revive it.
                }
            }
            else if (!invalid)
            {
                invalidatedNodes = false;
            }
        });
        observer.observe(root.ownerDocument, { childList: true, subtree: true, attributes: true, attributeFilter: ['id'] });
    }, { immediate: true, flush: 'sync' });
});
onBeforeUnmount(() =>
{
    disposed = true;
    observerGeneration++;
    observer?.disconnect();
    stopWatchingRoot?.();
});
</script>

<style scoped lang="scss">
.authoring-workspace-session-parking,
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
