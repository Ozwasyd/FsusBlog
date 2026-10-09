<template>
    <main>
        <h1>已安装插件</h1>
        <section
            v-if="mounted"
            data-testid="collection"
        >
            <FsusUiDataList
                v-if="candidate === 'data-list'"
                :rows="plugins"
                :columns="columns"
                row-key="pluginId"
                :active-key="selectedId"
                :loading-key="state === 'loading' ? selectedId : null"
                :loading="collectionLoading"
                :disabled="disabled"
                :disabled-keys="disabledKeys"
                aria-label="已安装插件"
                density="compact"
                variant="navigation"
                :responsive="responsive"
                :show-header="false"
                @change="(_row, key) => activate(String(key))"
            >
                <template #cell="{ row, column }">
                    <span
                        v-if="column.key === 'identity'"
                        class="plugin-identity"
                        :data-plugin-id="row.pluginId"
                    >
                        <strong>{{ row.name }}</strong>
                        <small>{{ row.pluginId }} · {{ row.version }}</small>
                    </span>
                    <span
                        v-else
                        class="plugin-status"
                    >
                        <ElTag size="small">{{ row.healthState }}</ElTag>
                        <small>{{ row.runtime }}</small>
                    </span>
                </template>
                <template #empty>
                    <FsusEmptyState
                        size="inline"
                        :title="stateTitle"
                        :illustration="false"
                    />
                </template>
            </FsusUiDataList>
            <ElResponsiveCollection
                v-else-if="candidate === 'responsive-collection'"
                :items="plugins"
                row-key="pluginId"
                aria-label="已安装插件"
            >
                <template #table="{ items }">
                    <div role="list" aria-label="已安装插件">
                        <FsusEmptyState
                            v-if="items.length === 0"
                            size="inline"
                            :title="stateTitle"
                            :illustration="false"
                        />
                        <span
                            v-for="plugin in items.map(asPlugin)"
                            :key="plugin.pluginId"
                            role="listitem"
                            :data-plugin-id="plugin.pluginId"
                        >{{ plugin.name }} {{ plugin.pluginId }} {{ plugin.version }} {{ plugin.healthState }} {{ plugin.runtime }}</span>
                    </div>
                </template>
                <template #item="{ item }">
                    <template v-for="plugin in [asPlugin(item)]" :key="plugin.pluginId">
                        <span
                            role="listitem"
                            :data-plugin-id="plugin.pluginId"
                        >{{ plugin.name }} {{ plugin.pluginId }} {{ plugin.version }} {{ plugin.healthState }} {{ plugin.runtime }}</span>
                    </template>
                </template>
                <template #empty>
                    <FsusEmptyState size="inline" :title="stateTitle" :illustration="false" />
                </template>
            </ElResponsiveCollection>
            <ElMenu
                v-else
                :default-active="selectedId"
                aria-label="已安装插件"
                @select="activate"
            >
                <ElMenuItem
                    v-for="plugin in plugins"
                    :key="plugin.pluginId"
                    :index="plugin.pluginId"
                    :disabled="state === 'loading'"
                >
                    <span class="plugin-identity" :data-plugin-id="plugin.pluginId">
                        <strong>{{ plugin.name }}</strong>
                        <small>{{ plugin.pluginId }} · {{ plugin.version }}</small>
                    </span>
                    <span class="plugin-status">
                        <ElTag size="small">{{ plugin.healthState }}</ElTag>
                        <small>{{ plugin.runtime }}</small>
                    </span>
                </ElMenuItem>
            </ElMenu>
            <FsusEmptyState
                v-if="candidate === 'menu' && plugins.length === 0"
                size="inline"
                :title="stateTitle"
                :illustration="false"
            />
            <ElAlert
                v-if="state === 'loading' || state === 'error'"
                :title="stateTitle"
                :type="state === 'error' ? 'error' : 'info'"
                :closable="false"
            />
        </section>
    </main>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { ElAlert, ElMenu, ElMenuItem, ElResponsiveCollection, ElTag, FsusEmptyState } from '@ozwasyd/element-plus';

import { FsusUiDataList } from '@/fsusui/dataList';

type Candidate = 'data-list' | 'responsive-collection' | 'menu';
type ProbeState = 'ready' | 'loading' | 'error';
type Plugin = {
    pluginId: string;
    name: string;
    version: string;
    healthState: string;
    runtime: string;
};

const candidate = ref<Candidate>('data-list');
const state = ref<ProbeState>('ready');
const plugins = ref<Plugin[]>([]);
const selectedId = ref('');
const activations = ref<string[]>([]);
const acceptSelection = ref(true);
const mounted = ref(true);
const disabled = ref(false);
const disabledKeys = ref<string[]>([]);
const collectionLoading = ref(false);
const responsive = ref(true);
const columns = [
    { key: 'identity', label: '插件', grid: 'minmax(0, 1fr)' },
    { key: 'status', label: '状态', grid: 'minmax(90px, 0.5fr)', align: 'end' as const }
];
const stateTitle = computed(() => state.value === 'loading'
    ? '正在读取插件列表…'
    : state.value === 'error' ? '插件列表加载失败' : '尚未安装插件');

function isPlugin(value: unknown): value is Plugin
{
    return typeof value === 'object' && value !== null
        && 'pluginId' in value && typeof value.pluginId === 'string'
        && 'name' in value && typeof value.name === 'string'
        && 'version' in value && typeof value.version === 'string'
        && 'healthState' in value && typeof value.healthState === 'string'
        && 'runtime' in value && typeof value.runtime === 'string';
}

function asPlugin(value: unknown): Plugin
{
    if (!isPlugin(value))
    {
        throw new Error('Collection returned an invalid plugin fixture');
    }
    return value;
}

function activate(pluginId: string): void
{
    activations.value.push(pluginId);
    if (acceptSelection.value)
    {
        selectedId.value = pluginId;
    }
}

const probe = {
    async configure(value: {
        candidate: Candidate;
        count: number;
        state?: ProbeState;
        acceptSelection?: boolean;
        longId?: boolean;
        disabled?: boolean;
        disabledKeys?: string[];
        collectionLoading?: boolean;
        responsive?: boolean;
    })
    {
        mounted.value = false;
        await nextTick();
        candidate.value = value.candidate;
        state.value = value.state ?? 'ready';
        disabled.value = value.disabled ?? false;
        disabledKeys.value = value.disabledKeys ?? [];
        collectionLoading.value = value.collectionLoading ?? false;
        responsive.value = value.responsive ?? true;
        acceptSelection.value = value.acceptSelection ?? true;
        activations.value = [];
        plugins.value = Array.from({ length: value.count }, (_, index) => ({
            pluginId: `plugin-${index}${value.longId ? '-long-identity'.repeat(12) : ''}`,
            name: 'Duplicate plugin name',
            version: '1.2.3',
            healthState: index % 2 ? 'Degraded' : 'Healthy',
            runtime: 'wasm'
        }));
        selectedId.value = plugins.value[0]?.pluginId ?? '';
        mounted.value = true;
        await nextTick();
    },
    async reverse()
    {
        plugins.value = [...plugins.value].reverse();
        await nextTick();
    },
    async unmount()
    {
        mounted.value = false;
        await nextTick();
    },
    snapshot: () => ({
        selectedId: selectedId.value,
        activations: [...activations.value],
        ids: plugins.value.map((plugin) => plugin.pluginId)
    }),
    publicComponents: {
        dataList: FsusUiDataList.name,
        responsiveCollection: ElResponsiveCollection.name,
        menu: ElMenu.name
    }
};

Object.assign(window, { pluginCollectionProbe: probe });
</script>

<style>
body {
    margin: 0;
    color: var(--el-text-color-primary);
    background: var(--el-bg-color);
    font-family: sans-serif;
}

main {
    padding: 16px;
    max-width: 500px;
}

.plugin-identity,
.plugin-status {
    display: flex;
    flex-direction: column;
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
}

.plugin-status {
    align-items: flex-end;
}

[data-testid="collection"] {
    max-height: 500px;
    overflow: auto;
}

[data-testid="collection"] [data-plugin-id][role="listitem"] {
    display: block;
}
</style>
