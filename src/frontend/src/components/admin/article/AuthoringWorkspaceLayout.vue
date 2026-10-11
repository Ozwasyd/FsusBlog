<template>
    <div
        ref="frameElement"
        class="authoring-workspace-layout"
        :data-layout-status="observation.status"
        :data-layout-block-reason="observation.reason ?? undefined"
    >
        <div
            class="authoring-workspace-layout__regions"
            :style="regionStyle"
        >
            <section
                :id="primaryRegionId"
                class="authoring-workspace-layout__group"
                :aria-label="primaryLabel"
                :data-group-ref="projection?.state.groups[0]?.groupId"
                :data-active="projection ? projection.state.activeGroupId === projection.state.groups[0]?.groupId : undefined"
                :data-focused="projection ? projection.state.focusedGroupId === projection.state.groups[0]?.groupId : undefined"
                :hidden="!leadingVisible"
                :inert="!leadingVisible"
                :style="leadingStyle"
            >
                <slot
                    name="leading"
                    :group="projection?.state.groups[0] ?? null"
                    :status="observation.status"
                >
                    <slot />
                </slot>
            </section>
            <div
                ref="separatorRegion"
                class="authoring-workspace-layout__separator"
                :class="{ 'is-measure-only': !separatorVisible }"
                :aria-hidden="!separatorVisible"
                :inert="!separatorVisible"
                :style="separatorStyle"
            >
                <FsusResizeSeparator
                    v-if="separatorProps"
                    ref="separatorHandle"
                    v-bind="separatorProps"
                    :disabled="observation.status !== 'planned'"
                    @start="start"
                    @proposal="proposal"
                    @end="end"
                    @cancel="cancel"
                />
            </div>
            <section
                :id="secondaryRegionId"
                class="authoring-workspace-layout__group"
                :aria-label="secondaryLabel"
                :data-group-ref="projection?.state.groups[1]?.groupId"
                :data-active="projection ? projection.state.activeGroupId === projection.state.groups[1]?.groupId : undefined"
                :data-focused="projection ? projection.state.focusedGroupId === projection.state.groups[1]?.groupId : undefined"
                :hidden="!trailingVisible"
                :inert="!trailingVisible"
                :style="trailingStyle"
            >
                <slot
                    name="trailing"
                    :group="projection?.state.groups[1] ?? null"
                    :status="observation.status"
                />
            </section>
        </div>
        <slot
            name="unavailable"
            :reason="observation.reason"
            :status="observation.status"
        />
    </div>
</template>

<script setup lang="ts">
import { FsusResizeSeparator } from '@ozwasyd/element-plus';
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';

import type { AuthoringTabGroupProjection } from '@/services/authoring/authoringTabGroupRegistry';
import type { AuthoringWorkspaceGeometryPlan } from '@/services/authoring/authoringWorkspaceGeometryPolicy';
import { createAuthoringWorkspaceLayoutController, unavailableAuthoringWorkspaceLayout } from '@/services/authoring/authoringWorkspaceLayoutController';
import type { AuthoringWorkspaceLayoutObservation, AuthoringWorkspaceLayoutSource } from '@/services/authoring/authoringWorkspaceLayoutController';
import type { AuthoringWorkspaceSeparatorProps } from '@/services/authoring/authoringWorkspaceSeparatorAdapter';

import type { ResizeSeparatorCancelPayload, ResizeSeparatorPayload } from '@ozwasyd/element-plus';

defineOptions({ name: 'AuthoringWorkspaceLayout' });

const props = defineProps<{
    source: AuthoringWorkspaceLayoutSource | null;
    primaryRegionId: string;
    secondaryRegionId: string;
    primaryLabel: string;
    secondaryLabel: string;
    separatorLabel: string;
}>();
const emit = defineEmits<{
    observation: [value: AuthoringWorkspaceLayoutObservation];
}>();
const frameElement = shallowRef<HTMLElement | null>(null);
const separatorRegion = shallowRef<HTMLElement | null>(null);
const separatorHandle = shallowRef<unknown>(null);
// Retain only genuine original observations while unavailable. They keep mounted DOM
// identity stable; blocked output never becomes a fresh layout/retention receipt.
const renderState = shallowRef<Readonly<{
    observation: AuthoringWorkspaceLayoutObservation;
    projection: AuthoringTabGroupProjection | null;
    geometry: AuthoringWorkspaceGeometryPlan | null;
    separatorProps: AuthoringWorkspaceSeparatorProps | null;
    localOffset: Readonly<{ left: number; top: number; }>;
}>>({ observation: unavailableAuthoringWorkspaceLayout(), projection: null, geometry: null,
      separatorProps: null, localOffset: { left: 0, top: 0 } });
const observation = computed(() => renderState.value.observation);
const projection = computed(() => renderState.value.projection);
const geometry = computed(() => renderState.value.geometry);
const separatorProps = computed(() => renderState.value.separatorProps);
let controller: ReturnType<typeof createAuthoringWorkspaceLayoutController> | null = null;
let unsubscribe: (() => void) | null = null;
let generation = 0;
let disposed = false;
let invalidating = false;
let resizeObserver: ResizeObserver | null = null;

// Check only the documented public cancel capability on the actual root component
// ref. This is a consumer requirement, not a fabricated SDK declaration or receipt.
function hasPublicCancel(value: unknown): value is { cancel(): void; }
{
    return !!value && typeof value === 'object' && 'cancel' in value && typeof value.cancel === 'function';
}
function cancelPublicSeparator(): void
{
    const value = separatorHandle.value;
    if (!hasPublicCancel(value))
    {
        throw new Error('public-resize-separator-cancel-unavailable');
    }
    value.cancel();
}

function refresh(): void
{
    if (disposed || invalidating)
    {
        return;
    }
    const expected = generation;
    let value = controller?.refresh() ?? unavailableAuthoringWorkspaceLayout();
    if (disposed || generation !== expected)
    {
        return;
    }
    const frame = frameElement.value?.getBoundingClientRect();
    const footprint = separatorRegion.value?.getBoundingClientRect();
    const available = value.geometry?.status === 'planned' ? value.geometry.available : null;
    if (value.status === 'planned' && (!frame || !footprint || !available || frame.width <= 0 || frame.height <= 0
        || footprint.width <= 0 || available.left < frame.left || available.top < frame.top
        || available.left + available.width > frame.right || available.top + available.height > frame.bottom
        || value.geometry?.status === 'planned' && value.geometry.effectiveLayout === 'horizontal-two-group'
        && footprint.width !== value.geometry.splitter.width))
    {
        controller?.invalidate();
        value = Object.freeze({ ...value, status: 'blocked', reason: 'component-measurement-unavailable',
                                separator: Object.freeze({ status: 'blocked' }) });
    }
    if (disposed || generation !== expected)
    {
        return;
    }
    const previous = renderState.value;
    renderState.value = Object.freeze({ observation: value,
                                        projection: value.status === 'planned' ? value.projection : previous.projection,
                                        geometry: value.status === 'planned' ? value.geometry : previous.geometry,
                                        separatorProps: value.status === 'planned'
                                            ? value.separator.status === 'planned' ? value.separator.props : null : previous.separatorProps,
                                        localOffset: value.status === 'planned' && frame && available
                                            ? Object.freeze({ left: available.left - frame.left, top: available.top - frame.top }) : previous.localOffset });
    if (disposed || generation !== expected)
    {
        return;
    }
    emit('observation', value);
}

function invalidate(): void
{
    generation++;
    renderState.value = Object.freeze({ ...renderState.value, observation: unavailableAuthoringWorkspaceLayout() });
    if (invalidating)
    {
        return;
    }
    invalidating = true;
    try
    {
        controller?.invalidate();
    }
    finally
    {
        invalidating = false;
    }
}

function start(payload: ResizeSeparatorPayload): void
{
    if (observation.value.status !== 'planned' || !controller?.start(payload))
    {
        invalidate();
    }
}
function proposal(payload: ResizeSeparatorPayload): void
{
    if (observation.value.status !== 'planned')
    {
        invalidate();
        return;
    }
    controller?.proposal(payload);
    refresh();
}
function end(payload: ResizeSeparatorPayload): void
{
    controller?.end(payload);
    refresh();
}
function cancel(payload: ResizeSeparatorCancelPayload): void
{
    controller?.cancel(payload);
    refresh();
}

watch(() => [props.source, props.primaryRegionId, props.secondaryRegionId, props.primaryLabel,
             props.secondaryLabel, props.separatorLabel] as const, () =>
             {
                 invalidate();
                 const expected = generation;
                 const oldRelease = unsubscribe;
                 unsubscribe = null;
                 const oldController = controller;
                 controller = null;
                 oldController?.dispose();
                 oldRelease?.();
                 if (disposed || generation !== expected)
                 {
                     return;
                 }
                 const source = props.source;
                 if (!disposed && source && props.primaryRegionId.trim() && props.secondaryRegionId.trim()
                     && props.primaryRegionId !== props.secondaryRegionId && props.primaryLabel.trim()
                     && props.secondaryLabel.trim() && props.separatorLabel.trim())
                 {
                     try
                     {
                         const candidate = createAuthoringWorkspaceLayoutController(source, {
                             label: props.separatorLabel, primaryRegionId: props.primaryRegionId,
                             secondaryRegionId: props.secondaryRegionId
                         }, cancelPublicSeparator);
                         if (disposed || generation !== expected)
                         {
                             candidate.dispose();
                             return;
                         }
                         controller = candidate;
                         const release = source.subscribeInvalidation(() =>
                         {
                             if (!disposed && props.source === source && controller === candidate)
                             {
                                 invalidate();
                                 const changed = generation;
                                 // Do not re-admit during a before-change callback.
                                 void nextTick().then(() =>
                                 {
                                     if (!disposed && generation === changed && controller === candidate && props.source === source)
                                     {
                                         refresh();
                                     }
                                 });
                             }
                         });
                         if (disposed || generation !== expected)
                         {
                             release();
                             candidate.dispose();
                             if (controller === candidate)
                             {
                                 controller = null;
                             }
                         }
                         else
                         {
                             unsubscribe = release;
                         }
                     }
                     catch
                     {
                         if (generation === expected)
                         {
                             const rejected = controller;
                             controller = null;
                             rejected?.dispose();
                         }
                     }
                 }
                 refresh();
             }, { immediate: true, flush: 'sync' });

onBeforeUnmount(() =>
{
    disposed = true;
    generation++;
    resizeObserver?.disconnect();
    unsubscribe?.();
    controller?.dispose();
});
onMounted(() =>
{
    if (frameElement.value)
    {
        resizeObserver = new ResizeObserver(() =>
        {
            if (!disposed)
            {
                invalidate();
                refresh();
            }
        });
        resizeObserver.observe(frameElement.value);
    }
    refresh();
});

const twoGroups = computed(() => projection.value?.state.effectiveLayoutState === 'horizontal-two-group');
const leadingVisible = computed(() => !projection.value || twoGroups.value
    || projection.value.state.groups[0]?.groupId === projection.value.state.effectiveFocusedGroupId);
const trailingVisible = computed(() => !!projection.value?.state.groups[1] && (twoGroups.value
    || projection.value.state.groups[1].groupId === projection.value.state.effectiveFocusedGroupId));
const separatorVisible = computed(() => twoGroups.value && geometry.value?.status === 'planned'
    && geometry.value.effectiveLayout === 'horizontal-two-group');
const regionStyle = computed(() => geometry.value?.status === 'planned'
    ? { inlineSize: `${geometry.value.available.width}px`,
        marginInlineStart: `${renderState.value.localOffset.left}px`,
        marginBlockStart: `${renderState.value.localOffset.top}px` } : undefined);
const leadingStyle = computed(() => twoGroups.value && geometry.value?.status === 'planned'
    && geometry.value.effectiveLayout === 'horizontal-two-group'
    ? { inlineSize: `${geometry.value.leadingGroupWidthCssPx}px` }
    : geometry.value?.status === 'planned' && leadingVisible.value
        ? { inlineSize: `${geometry.value.available.width}px` } : undefined);
const trailingStyle = computed(() => twoGroups.value && geometry.value?.status === 'planned'
    && geometry.value.effectiveLayout === 'horizontal-two-group'
    ? { inlineSize: `${geometry.value.trailingGroupWidthCssPx}px` }
    : geometry.value?.status === 'planned' && trailingVisible.value
        ? { inlineSize: `${geometry.value.available.width}px` } : undefined);
const separatorStyle = computed(() => geometry.value?.status === 'planned'
    && geometry.value.effectiveLayout === 'horizontal-two-group'
    ? { inlineSize: `${geometry.value.splitter.width}px` } : undefined);

// These are this component's own elements, not private FsusUI DOM. The caller
// measures the public reserved region and its actual frame in the same CSS space.
defineExpose({ refresh, invalidate,
               readFrameRect: () => frameElement.value?.getBoundingClientRect() ?? null,
               readSeparatorRect: () => separatorRegion.value?.getBoundingClientRect() ?? null
});
</script>

<style scoped lang="scss">
.authoring-workspace-layout
 {
    position: relative;
    min-inline-size: 0;
    max-inline-size: 100%;
    overflow-x: clip;
}

.authoring-workspace-layout__regions
 {
    display: flex;
    align-items: stretch;
    min-inline-size: 0;
    max-inline-size: 100%;
    overflow-x: clip;
}

.authoring-workspace-layout__group
 {
    flex: 0 0 auto;
    min-inline-size: 0;
    max-inline-size: 100%;
}

.authoring-workspace-layout__group[hidden]
 {
    display: none;
}

.authoring-workspace-layout__separator
 {
    display: flex;
    flex: 0 0 auto;
    align-items: stretch;
    justify-content: center;
    inline-size: var(--fsus-icon-target);

    &.is-measure-only
 {
        position: absolute;
        inset-block-start: 0;
        inset-inline-start: 0;
        visibility: hidden;
        pointer-events: none;
        block-size: var(--fsus-icon-target);
    }
}
</style>
