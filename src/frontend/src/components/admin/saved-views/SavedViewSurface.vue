<template>
    <section
        class="saved-view-surface"
        :data-surface="surface"
        aria-label="已保存视图"
    >
        <p
            v-if="deepLinkStatus === 'resolving'"
            role="status"
        >正在从服务端验证视图链接。</p>
        <p
            v-if="deepLinkStatus === 'invalid'"
            role="alert"
        >视图链接无效，请重新选择视图。</p>
        <template v-if="surface === 'rail' && identityVisible">
            <ul class="saved-view-pins">
                <li
                    v-for="pin in pinnedViews.slice(0, 20)"
                    :key="pin.viewId"
                >
                    <ElButton
                        class="saved-view-pin-button"
                        link
                        :aria-current="view?.viewId === pin.viewId ? 'page' : undefined"
                        @click="openView(pin)"
                    >
                        <span class="saved-view-pin-name">{{ pin.name }}{{ pin.isDefault ? '（默认）' : '' }}</span>
                    </ElButton>
                </li>
            </ul>
            <p v-if="pinnedViews.length === 0">暂无已固定视图。</p>
            <ElButton
                v-if="hasMorePins || pinnedViews.length > 20"
                data-action="next-pins"
                @click="nextPins"
            >下一页视图</ElButton>
        </template>
        <p v-if="view && identityVisible">{{ view.name }} · 服务端版本 {{ view.revision }}</p>
        <p :role="['invalid', 'stale', 'permission-denied'].includes(status) ? 'alert' : 'status'">{{ statusText }}</p>
        <ul v-if="status === 'invalid' && identityVisible">
            <li
                v-for="(reason, index) in reasons.slice(0, 64)"
                :key="index"
            >
                {{ reason.fieldIdentity }} · {{ reason.operatorId }}：{{ reason.reason }}
            </li>
        </ul>
        <ElButton
            v-if="status === 'invalid' && view && identityVisible"
            @click="repairView"
        >修复条件</ElButton>
        <slot
            v-if="status === 'ready' && view && identityVisible"
            name="results"
        />
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { FsusUiButton as ElButton } from '@/fsusui/button';

export interface SavedViewSummary {
    viewId: string;
    revision: number;
    schemaVersion: number;
    name: string;
    isDefault: boolean;
}

const props = withDefaults(defineProps<{
    surface: 'rail' | 'list' | 'search';
    status?: 'unavailable' | 'loading' | 'invalid' | 'stale' | 'permission-denied' | 'ready' | 'empty' | 'unsynced';
    view?: SavedViewSummary | null;
    /** Server-ordered pinned page; this component never derives pins from local state. */
    pinnedViews?: SavedViewSummary[];
    hasMorePins?: boolean;
    reasons?: { fieldIdentity: string; operatorId: string; reason: string; }[];
    deepLinkStatus?: 'none' | 'resolving' | 'invalid' | 'current';
}>(), {
    status: 'unavailable',
    view: null,
    pinnedViews: () => [],
    hasMorePins: false,
    reasons: () => [],
    deepLinkStatus: 'none'
});

const emit = defineEmits<{
    open: [identity: { viewId: string; expectedRevision: number; schemaVersion: number; }];
    nextPins: [];
    repair: [viewId: string];
}>();

const permissionRevoked = computed(() => props.reasons.some(reason => reason.reason === 'permission-revoked'));

const statusText = computed(() => permissionRevoked.value
    ? '当前账号或站点不能访问此视图。'
    : ({
        unavailable: '查询接口当前不可用。未执行筛选。',
        loading: '正在等待服务端查询结果。',
        invalid: '视图依赖已失效。所有条件均已保留，请修复后重试。',
        stale: '视图或权限已变化，请从服务端重新确认。',
        'permission-denied': '当前账号或站点不能访问此视图。',
        ready: '服务端查询结果已就绪。',
        empty: '服务端查询未返回文章。',
        unsynced: '修改尚未同步；当前展示仍属于服务端版本。'
    }[props.status]));

// A retained prior response is not authority after permission/link drift.
const identityVisible = computed(() => !permissionRevoked.value
    && !['stale', 'permission-denied'].includes(props.status)
    && !['invalid', 'resolving'].includes(props.deepLinkStatus));

function openView(view: SavedViewSummary): void
{
    if (!identityVisible.value)
    {
        return;
    }
    emit('open', { viewId: view.viewId, expectedRevision: view.revision, schemaVersion: view.schemaVersion });
}

function nextPins(): void
{
    if (identityVisible.value)
    {
        emit('nextPins');
    }
}

function repairView(): void
{
    if (identityVisible.value && props.view)
    {
        emit('repair', props.view.viewId);
    }
}
</script>

<style scoped>
.saved-view-surface
 {
    display: grid;
    min-width: 0;
    gap: var(--fsus-space-2);
    overflow-wrap: anywhere;
}

.saved-view-pins
 {
    display: grid;
    gap: var(--fsus-space-1);
    list-style: none;
    padding: 0;
    margin: 0;
}

.saved-view-surface p
 {
    margin: 0;
}

.saved-view-pins li
 {
    min-width: 0;
}

.saved-view-pin-button
 {
    max-width: 100%;
    text-align: start;
    justify-content: flex-start;
}

.saved-view-pin-name
 {
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
}
</style>
