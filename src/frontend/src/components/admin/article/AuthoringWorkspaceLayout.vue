<template>
    <div
        ref="frameElement"
        class="authoring-workspace-layout"
        :data-layout-status="observation.status"
        :data-layout-block-reason="observation.reason ?? undefined"
    >
        <div
            ref="regionContainer"
            class="authoring-workspace-layout__regions"
            :style="regionStyle"
        >
            <section
                ref="leadingRegion"
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
                    :group="slotProjection?.state.groups[0] ?? null"
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
                ref="trailingRegion"
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
                    :group="slotProjection?.state.groups[1] ?? null"
                    :status="observation.status"
                />
            </section>
        </div>
        <slot
            name="retained"
            :expectation="outletExpectation"
            :placement-root="frameElement"
            :leading-region="leadingRegion"
            :trailing-region="trailingRegion"
            :owns-region="ownsRegion"
            :contains-placement-node="containsPlacementNode"
            :revoke-placement="invalidate"
        />
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

import { articleWorkspaceTabRouter } from '@/services/authoring/articleWorkspaceTabRouter';
import type { AuthoringWorkspaceGeometryPlan } from '@/services/authoring/authoringWorkspaceGeometryPolicy';
import type { AuthoringWorkspaceLayoutPort, AuthoringWorkspaceOutletExpectation } from '@/services/authoring/authoringWorkspaceLayoutContext';
import { copyAuthoringWorkspaceLayoutObservation, copyAuthoringWorkspaceLayoutProjection, createAuthoringWorkspaceLayoutController, unavailableAuthoringWorkspaceLayout } from '@/services/authoring/authoringWorkspaceLayoutController';
import type { AuthoringWorkspaceLayoutObservation, AuthoringWorkspaceLayoutProjection, AuthoringWorkspaceLayoutSource } from '@/services/authoring/authoringWorkspaceLayoutController';
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
const regionContainer = shallowRef<HTMLElement | null>(null);
const leadingRegion = shallowRef<HTMLElement | null>(null);
const trailingRegion = shallowRef<HTMLElement | null>(null);
const separatorRegion = shallowRef<HTMLElement | null>(null);
const separatorHandle = shallowRef<unknown>(null);
type RenderState = Readonly<{
    observation: AuthoringWorkspaceLayoutObservation;
    projection: AuthoringWorkspaceLayoutProjection | null;
    geometry: AuthoringWorkspaceGeometryPlan | null;
    separatorProps: AuthoringWorkspaceSeparatorProps | null;
    localOffset: Readonly<{ left: number; top: number; }>;
    outletOwners: Readonly<Pick<AuthoringWorkspaceOutletExpectation, 'groups' | 'registry'>> | null;
}>;
// Region DOM remains mounted independently of observations. Revocation clears all
// authority-bound presentation so the leading default editor becomes available again.
function fallbackRenderState(value: AuthoringWorkspaceLayoutObservation = unavailableAuthoringWorkspaceLayout()): RenderState
{
    return Object.freeze({ observation: value, projection: null, geometry: null, outletOwners: null,
                           separatorProps: null, localOffset: Object.freeze({ left: 0, top: 0 }) });
}
const renderState = shallowRef<RenderState>(fallbackRenderState());
const observation = computed(() => renderState.value.observation);
const projection = computed(() => renderState.value.projection);
const slotProjection = computed(() => projection.value ? copyAuthoringWorkspaceLayoutProjection(projection.value) : null);
const outletExpectation = computed<AuthoringWorkspaceOutletExpectation | null>(() =>
{
    const view = slotProjection.value;
    const owners = renderState.value.outletOwners;
    return view && owners ? Object.freeze({ groups: owners.groups, registry: owners.registry, projection: view }) : null;
});
const geometry = computed(() => renderState.value.geometry);
const separatorProps = computed(() => renderState.value.separatorProps);
let controller: ReturnType<typeof createAuthoringWorkspaceLayoutController> | null = null;
let unsubscribe: (() => void) | null = null;
let generation = 0;
let disposed = false;
let invalidating = false;
let resizeObserver: ResizeObserver | null = null;

function containsPlacementNode(node: HTMLElement): boolean
{
    const frame = frameElement.value;
    return !!frame?.isConnected && node.isConnected && node.ownerDocument === frame.ownerDocument && frame.contains(node);
}

function ownsRegion(index: 0 | 1, node: HTMLElement): boolean
{
    const frame = frameElement.value;
    const container = regionContainer.value;
    return containsPlacementNode(node) && !!container?.isConnected && container.parentElement === frame
        && node.parentElement === container && node === (index === 0 ? leadingRegion.value : trailingRegion.value)
        && node.id === (index === 0 ? props.primaryRegionId : props.secondaryRegionId);
}

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
    const source = props.source;
    const groups = source?.groups ?? null;
    const registry = articleWorkspaceTabRouter.getRegistry();
    let value = controller?.refresh() ?? unavailableAuthoringWorkspaceLayout();
    if (disposed || generation !== expected || props.source !== source || props.source?.groups !== groups && groups !== null
        || articleWorkspaceTabRouter.getRegistry() !== registry)
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
    renderState.value = value.status === 'planned'
        ? Object.freeze({ observation: value, projection: value.projection, geometry: value.geometry,
                          outletOwners: groups ? Object.freeze({ groups, registry }) : null,
                          separatorProps: value.separator.status === 'planned' ? value.separator.props : null,
                          localOffset: frame && available
                              ? Object.freeze({ left: available.left - frame.left, top: available.top - frame.top }) : Object.freeze({ left: 0, top: 0 }) })
        : fallbackRenderState(value);
    if (disposed || generation !== expected)
    {
        return;
    }
    emit('observation', copyAuthoringWorkspaceLayoutObservation(value));
}

function invalidate(): void
{
    generation++;
    renderState.value = fallbackRenderState();
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
} satisfies AuthoringWorkspaceLayoutPort);
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
