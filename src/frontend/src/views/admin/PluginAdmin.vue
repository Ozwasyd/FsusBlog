<template>
    <div class="account-page plugin-admin-page account-motion-enter w-full">
        <FsusUiTaskPageHeader
            title="插件"
            description="集中处理权限、运行状态、错误和节点加载差异。"
            class="account-task-page-header"
            density="compact"
        >
            <template #actions>
                <div class="plugin-admin-page__header-actions">
                    <input
                        ref="fileInput"
                        class="sr-only"
                        type="file"
                        accept=".fspkg,application/octet-stream"
                        @change="handleInstall"
                    >
                    <ElButton
                        :loading="installing"
                        @click="fileInput?.click()"
                    >安装 .fspkg</ElButton>
                    <ElButton
                        :loading="loading"
                        @click="loadOverview"
                    >刷新</ElButton>
                </div>
            </template>
        </FsusUiTaskPageHeader>

        <section class="plugin-admin-layout">
            <aside
                class="plugin-admin-list"
                aria-label="已安装插件"
            >
                <div class="plugin-admin-list__summary">
                    <strong>{{ overview?.plugins.length ?? 0 }} 个插件</strong>
                    <span>当前节点 {{ overview?.currentNodeId ?? '—' }}</span>
                </div>
                <button
                    v-for="plugin in overview?.plugins ?? []"
                    :key="plugin.pluginId"
                    type="button"
                    class="plugin-admin-list__item"
                    :class="{ 'is-active': plugin.pluginId === selectedId }"
                    @click="selectPlugin(plugin.pluginId)"
                >
                    <span class="plugin-admin-list__identity">
                        <strong>{{ plugin.name }}</strong>
                        <small>{{ plugin.pluginId }} · {{ plugin.version }}</small>
                    </span>
                    <span class="plugin-admin-list__status">
                        <ElTag
                            :type="healthTag(plugin.healthState)"
                            size="small"
                        >
                            {{ healthLabel(plugin.healthState) }}
                        </ElTag>
                        <small>{{ plugin.runtime }}</small>
                    </span>
                </button>
                <p
                    v-if="!loading && overview?.plugins.length === 0"
                    class="plugin-admin-empty"
                >
                    尚未安装插件。安装包只会写入受控 Registry，不会在确认权限前执行。
                </p>
            </aside>

            <main class="plugin-admin-detail">
                <div
                    v-if="detail"
                    class="space-y-8"
                >
                    <FsusUiSettingsSection
                        title="运行摘要"
                        id="plugin-runtime-summary"
                    >
                        <template #actions>
                            <div class="plugin-admin-actions">
                                <ElButton
                                    v-if="!detail.summary.enabled"
                                    type="primary"
                                    :loading="actionLoading === 'enable'"
                                    @click="runAction('enable')"
                                >启用</ElButton>
                                <ElButton
                                    v-else
                                    :loading="actionLoading === 'disable'"
                                    @click="runAction('disable')"
                                >禁用</ElButton>
                                <ElButton
                                    :disabled="!detail.summary.enabled"
                                    :loading="actionLoading === 'reload'"
                                    @click="runAction('reload')"
                                >重载</ElButton>
                                <ElButton
                                    v-if="detail.summary.healthState === 'quarantined'"
                                    :loading="actionLoading === 'restore'"
                                    @click="runDangerousAction('restore')"
                                >恢复为禁用</ElButton>
                                <ElButton
                                    v-else
                                    type="warning"
                                    :loading="actionLoading === 'quarantine'"
                                    @click="runDangerousAction('quarantine')"
                                >隔离</ElButton>
                                <ElButton
                                    type="danger"
                                    :loading="actionLoading === 'uninstall'"
                                    @click="runDangerousAction('uninstall')"
                                >卸载</ElButton>
                            </div>
                        </template>
                        <FsusUiKeyValueGrid class="grid gap-4 md:grid-cols-4">
                            <FsusUiKeyValueItem label="状态">
                                <ElTag :type="healthTag(detail.summary.healthState)">
                                    {{ healthLabel(detail.summary.healthState) }}
                                </ElTag>
                            </FsusUiKeyValueItem>
                            <FsusUiKeyValueItem label="运行时">{{ detail.summary.runtime }}</FsusUiKeyValueItem>
                            <FsusUiKeyValueItem label="Hooks">{{ detail.summary.activeHookCount }}</FsusUiKeyValueItem>
                            <FsusUiKeyValueItem label="集群一致">
                                {{ detail.summary.clusterConsistent ? '是' : '否 / 尚未上报' }}
                            </FsusUiKeyValueItem>
                        </FsusUiKeyValueGrid>
                        <ElDescriptions
                            class="mt-5"
                            :column="1"
                            border
                        >
                            <ElDescriptionsItem label="入口">{{ detail.manifest.runtimeEntry }}</ElDescriptionsItem>
                            <ElDescriptionsItem label="作者">{{ detail.manifest.author }}</ElDescriptionsItem>
                            <ElDescriptionsItem label="兼容范围">{{ detail.manifest.hostVersionRange }}</ElDescriptionsItem>
                            <ElDescriptionsItem label="说明">{{ detail.manifest.description }}</ElDescriptionsItem>
                            <ElDescriptionsItem label="最近错误">
                                {{ detail.summary.lastErrorCode ?? '无' }}
                            </ElDescriptionsItem>
                        </ElDescriptions>
                    </FsusUiSettingsSection>

                    <ElTabs
                        v-model="activeTab"
                        class="plugin-admin-tabs"
                    >
                        <ElTabPane
                            label="权限与 Hooks"
                            name="permissions"
                        >
                            <FsusUiSettingsSection
                                title="权限请求"
                                id="plugin-permissions"
                            >
                                <p class="plugin-admin-hint">
                                    Dangerous / Trusted 权限不会自动授予。启用前，Hook 所需权限必须已明确授权。
                                </p>
                                <div class="plugin-permission-list">
                                    <article
                                        v-for="permission in detail.permissions"
                                        :key="permission.name"
                                        class="plugin-permission"
                                    >
                                        <div>
                                            <strong>{{ permission.name }}</strong>
                                            <p>{{ permission.reason }}</p>
                                        </div>
                                        <div class="plugin-permission__action">
                                            <ElTag :type="riskTag(permission.risk)">{{ permission.risk }}</ElTag>
                                            <ElSwitch
                                                :model-value="permission.granted"
                                                :loading="actionLoading === `permission:${permission.name}`"
                                                :aria-label="`${permission.name} 授权`"
                                                @change="togglePermission(permission.name, Boolean($event))"
                                            />
                                        </div>
                                    </article>
                                </div>
                                <ElAlert
                                    v-if="detail.manifest.deniedRawPermissions.length"
                                    type="error"
                                    :closable="false"
                                    title="此包请求了永不允许的原始权限"
                                    :description="detail.manifest.deniedRawPermissions.join('、')"
                                />
                            </FsusUiSettingsSection>

                            <FsusUiSettingsSection
                                class="mt-8"
                                title="Hook 注册"
                                id="plugin-hooks"
                            >
                                <ElTable :data="detail.manifest.hooks">
                                    <ElTableColumn
                                        prop="name"
                                        label="Hook"
                                        min-width="190"
                                    />
                                    <ElTableColumn
                                        prop="scope"
                                        label="范围"
                                        width="125"
                                    />
                                    <ElTableColumn
                                        prop="failPolicy"
                                        label="失败策略"
                                        width="130"
                                    />
                                    <ElTableColumn
                                        prop="timeoutMs"
                                        label="超时 ms"
                                        width="100"
                                    />
                                    <ElTableColumn
                                        label="幂等"
                                        width="75"
                                    >
                                        <template #default="{ row }">{{ row.idempotent ? '是' : '否' }}</template>
                                    </ElTableColumn>
                                    <template #empty>
                                        <AdminInlineEmptyState
                                            title="未声明 Hook"
                                            description="此插件没有注册可执行 Hook。"
                                        />
                                    </template>
                                </ElTable>
                            </FsusUiSettingsSection>
                        </ElTabPane>

                        <ElTabPane
                            label="配置"
                            name="config"
                        >
                            <FsusUiSettingsSection
                                title="配置 Schema"
                                id="plugin-config"
                            >
                                <div class="plugin-config-form">
                                    <label
                                        v-for="field in configFields"
                                        :key="field.name"
                                        class="plugin-config-field"
                                    >
                                        <span>{{ field.title }}</span>
                                        <small>{{ field.description }}</small>
                                        <ElSwitch
                                            v-if="field.type === 'boolean'"
                                            v-model="configDraft[field.name]"
                                        />
                                        <ElSelect
                                            v-else-if="field.enumValues.length"
                                            v-model="configDraft[field.name]"
                                            :placeholder="field.title"
                                        >
                                            <ElOption
                                                v-for="option in field.enumValues"
                                                :key="String(option)"
                                                :label="String(option)"
                                                :value="option"
                                            />
                                        </ElSelect>
                                        <ElInputNumber
                                            v-else-if="field.type === 'integer' || field.type === 'number'"
                                            v-model="configDraft[field.name]"
                                            :min="field.minimum"
                                            :max="field.maximum"
                                        />
                                        <ElInput
                                            v-else
                                            v-model="configDraft[field.name]"
                                            :placeholder="field.title"
                                        />
                                    </label>
                                    <p
                                        v-if="configFields.length === 0"
                                        class="plugin-admin-empty"
                                    >
                                        此插件没有可编辑的顶层配置字段。
                                    </p>
                                </div>
                                <template #footer>
                                    <div class="plugin-config-footer">
                                        <span>版本 {{ detail.config.version }} · {{ detail.config.reloadState }}</span>
                                        <ElButton
                                            type="primary"
                                            :loading="actionLoading === 'update-config'"
                                            @click="saveConfig"
                                        >校验并保存</ElButton>
                                    </div>
                                </template>
                            </FsusUiSettingsSection>
                        </ElTabPane>

                        <ElTabPane
                            label="指标与错误"
                            name="metrics"
                        >
                            <FsusUiSettingsSection
                                title="执行指标"
                                id="plugin-metrics"
                            >
                                <FsusUiKeyValueGrid class="grid gap-4 md:grid-cols-4">
                                    <FsusUiKeyValueItem label="执行">{{ detail.metrics.executionCount }}</FsusUiKeyValueItem>
                                    <FsusUiKeyValueItem label="错误">{{ detail.metrics.errorCount }}</FsusUiKeyValueItem>
                                    <FsusUiKeyValueItem label="超时">{{ detail.metrics.timeoutCount }}</FsusUiKeyValueItem>
                                    <FsusUiKeyValueItem label="平均耗时">
                                        {{ detail.metrics.averageDurationMilliseconds.toFixed(2) }} ms
                                    </FsusUiKeyValueItem>
                                </FsusUiKeyValueGrid>
                                <ElTable
                                    class="mt-5"
                                    :data="detail.recentExecutions"
                                >
                                    <ElTableColumn
                                        prop="hookName"
                                        label="Hook"
                                        min-width="180"
                                    />
                                    <ElTableColumn
                                        prop="nodeId"
                                        label="节点"
                                        min-width="120"
                                    />
                                    <ElTableColumn
                                        label="结果"
                                        width="90"
                                    >
                                        <template #default="{ row }">{{ row.success ? '成功' : row.errorCode }}</template>
                                    </ElTableColumn>
                                    <ElTableColumn
                                        label="耗时"
                                        width="100"
                                    >
                                        <template #default="{ row }">{{ row.durationMilliseconds.toFixed(2) }} ms</template>
                                    </ElTableColumn>
                                    <ElTableColumn
                                        prop="traceId"
                                        label="Trace"
                                        min-width="170"
                                    />
                                    <template #empty>
                                        <AdminInlineEmptyState
                                            title="暂无执行记录"
                                            description="该插件尚未产生执行记录。"
                                        />
                                    </template>
                                </ElTable>
                            </FsusUiSettingsSection>

                            <FsusUiSettingsSection
                                class="mt-8"
                                title="最近错误"
                                id="plugin-errors"
                            >
                                <ElTable :data="detail.recentErrors">
                                    <ElTableColumn
                                        prop="createdAtUtc"
                                        label="时间"
                                        min-width="170"
                                    />
                                    <ElTableColumn
                                        prop="code"
                                        label="错误码"
                                        min-width="180"
                                    />
                                    <ElTableColumn
                                        prop="hookName"
                                        label="Hook"
                                        min-width="160"
                                    />
                                    <ElTableColumn
                                        prop="nodeId"
                                        label="节点"
                                        min-width="120"
                                    />
                                    <template #empty>
                                        <AdminInlineEmptyState
                                            title="暂无错误记录"
                                            description="该插件尚未产生错误记录。"
                                        />
                                    </template>
                                </ElTable>
                            </FsusUiSettingsSection>
                        </ElTabPane>

                        <ElTabPane
                            label="日志"
                            name="logs"
                        >
                            <FsusUiSettingsSection
                                title="插件日志"
                                id="plugin-logs"
                            >
                                <p class="plugin-admin-hint">每个插件每节点最多保留最近 200 条，避免日志刷爆。</p>
                                <ElTable :data="detail.recentLogs">
                                    <ElTableColumn
                                        prop="createdAtUtc"
                                        label="时间"
                                        min-width="170"
                                    />
                                    <ElTableColumn
                                        prop="level"
                                        label="级别"
                                        width="90"
                                    />
                                    <ElTableColumn
                                        prop="hookName"
                                        label="Hook"
                                        min-width="150"
                                    />
                                    <ElTableColumn
                                        prop="nodeId"
                                        label="节点"
                                        min-width="120"
                                    />
                                    <ElTableColumn
                                        prop="message"
                                        label="消息"
                                        min-width="240"
                                    />
                                    <template #empty>
                                        <AdminInlineEmptyState
                                            title="插件暂无日志"
                                            description="该插件尚未产生日志条目。"
                                        />
                                    </template>
                                </ElTable>
                            </FsusUiSettingsSection>
                        </ElTabPane>

                        <ElTabPane
                            label="集群状态"
                            name="cluster"
                        >
                            <FsusUiSettingsSection
                                title="逐节点加载状态"
                                id="plugin-cluster"
                            >
                                <ElAlert
                                    v-if="!detail.summary.clusterConsistent"
                                    type="warning"
                                    :closable="false"
                                    title="当前未证明所有目标节点一致"
                                    description="not-reported 表示该节点尚未向当前控制面提交插件运行态，不能视为已加载。"
                                />
                                <ElTable
                                    class="mt-5"
                                    :data="detail.nodes"
                                >
                                    <ElTableColumn
                                        prop="nodeId"
                                        label="节点"
                                        min-width="150"
                                    />
                                    <ElTableColumn
                                        prop="memberStatus"
                                        label="成员状态"
                                        width="120"
                                    />
                                    <ElTableColumn
                                        prop="runtimeState"
                                        label="运行态"
                                        width="130"
                                    />
                                    <ElTableColumn
                                        label="Hooks"
                                        min-width="220"
                                    >
                                        <template #default="{ row }">
                                            {{ row.registeredHooks.join('、') || '—' }}
                                        </template>
                                    </ElTableColumn>
                                    <ElTableColumn
                                        prop="lastErrorCode"
                                        label="最近错误"
                                        min-width="160"
                                    />
                                    <template #empty>
                                        <AdminInlineEmptyState
                                            title="暂无节点"
                                            description="当前没有节点上报插件运行状态。"
                                        />
                                    </template>
                                </ElTable>
                            </FsusUiSettingsSection>
                        </ElTabPane>
                    </ElTabs>
                </div>

                <section
                    v-else
                    class="plugin-admin-placeholder"
                    aria-live="polite"
                >
                    {{ detailLoading ? '正在读取插件状态…' : '选择一个插件查看权限、配置和运行证据。' }}
                </section>
            </main>
        </section>
    </div>
</template>

<script setup lang="ts">
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue';
import { usePluginAdmin } from '@/composables/usePluginAdmin';
import {
    FsusUiKeyValueGrid,
    FsusUiKeyValueItem,
    FsusUiSettingsSection,
    FsusUiTaskPageHeader
} from '@/fsusui';

const {
    loading,
    detailLoading,
    installing,
    actionLoading,
    activeTab,
    selectedId,
    fileInput,
    overview,
    detail,
    configDraft,
    configFields,
    loadOverview,
    selectPlugin,
    handleInstall,
    runAction,
    runDangerousAction,
    togglePermission,
    saveConfig,
    healthTag,
    riskTag,
    healthLabel
} = usePluginAdmin();
</script>

<style scoped>
.plugin-admin-page__header-actions,
.plugin-admin-actions,
.plugin-config-footer
 {
    flex-wrap: wrap;
    align-items: center;
    display: grid;
    grid-template-columns: minmax(240px, 0.32fr) minmax(0, 1fr);
    gap: var(--fsus-space-6);
}

.plugin-admin-list
 {
    overflow: hidden;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-panel);
    background: var(--fsusblog-panel-bg);
}

.plugin-admin-list__summary,
.plugin-admin-list__item
 {
    display: flex;
    justify-content: space-between;
    gap: var(--fsus-space-4);
    padding: var(--fsus-space-4);
}

.plugin-admin-list__summary
 {
    border-bottom: 1px solid var(--fsusblog-panel-border);
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
}

.plugin-admin-list__item
 {
    width: 100%;
    border: 0;
    border-bottom: 1px solid var(--fsusblog-panel-border);
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
}

.plugin-admin-list__item:hover,
.plugin-admin-list__item.is-active
 {
    background: var(--fsusblog-surface-muted);
}

.plugin-admin-list__identity,
.plugin-admin-list__status
 {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: var(--fsus-space-1);
    overflow: hidden;
    color: var(--fsusblog-text-secondary);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.plugin-admin-list__status
 {
    align-items: flex-end;
}

.plugin-admin-empty,
.plugin-admin-hint
 {
    margin: 0;
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
    line-height: 1.7;
}

.plugin-admin-empty
 {
    padding: var(--fsus-space-5);
}

.plugin-admin-placeholder
 {
    display: grid;
    min-height: 240px;
    place-items: center;
    border: 1px dashed var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-panel);
    color: var(--fsusblog-text-secondary);
}

.plugin-permission-list,
.plugin-config-form
 {
    display: grid;
    gap: var(--fsus-space-3);
    margin: var(--fsus-space-5) 0;
}

.plugin-permission
 {
    display: flex;
    justify-content: space-between;
    gap: var(--fsus-space-5);
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control);
    padding: var(--fsus-space-4);
}

.plugin-permission p
 {
    margin: var(--fsus-space-2) 0 0;
    color: var(--fsusblog-text-secondary);
    font-size: 12px;
}

.plugin-permission__action
 {
    display: flex;
    align-items: center;
    gap: var(--fsus-space-3);
}

.plugin-config-field
 {
    display: grid;
    grid-template-columns: minmax(140px, 0.35fr) minmax(180px, 1fr);
    gap: var(--fsus-space-2) var(--fsus-space-5);
    align-items: center;
}

.plugin-config-field small
 {
    grid-column: 1;
    color: var(--fsusblog-text-secondary);
}

.plugin-config-field > *
 {
    grid-column: 2;
    grid-row: 1 / span 2;
}

.plugin-config-footer
 {
    justify-content: space-between;
}

@media (width <= 1023px)
 {
    .plugin-admin-layout
 {
        grid-template-columns: 1fr;
    }

    .plugin-admin-list
 {
        max-height: 320px;
        overflow-y: auto;
    }
}

@media (width <= 639px)
 {
    .plugin-permission,
    .plugin-config-field
 {
        grid-template-columns: 1fr;
    }

    .plugin-permission
 {
        flex-direction: column;
    }

    .plugin-permission__action
 {
        justify-content: space-between;
    }

    .plugin-config-field > *
 {
        grid-column: 1;
        grid-row: auto;
    }
}
</style>
