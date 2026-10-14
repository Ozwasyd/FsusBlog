<template>
    <div class="account-page plugin-admin-page account-motion-enter w-full">
        <FsusUiTaskPageHeader
            title="插件"
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
                                        <AdminInlineEmptyState title="未声明 Hook" />
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
                                <div
                                    v-if="configObject === null"
                                    class="plugin-config-json"
                                >
                                    <p role="alert">当前根配置不是对象，原值已保留。请显式编辑 JSON；不会自动替换为对象。</p>
                                    <pre>{{ displayJsonValue(configDraft) }}</pre>
                                    <ElButton @click="beginJsonEdit(null)">编辑根 JSON</ElButton>
                                </div>
                                <div
                                    v-else
                                    class="plugin-config-form"
                                >
                                    <component
                                        :is="entry.field.enumOptions.length ? 'fieldset' : 'label'"
                                        v-for="entry in configWidgetFields"
                                        :key="entry.field.name"
                                        class="plugin-config-field"
                                        :class="{ 'plugin-config-field--enum': entry.field.enumOptions.length > 0 }"
                                    >
                                        <legend v-if="entry.field.enumOptions.length">{{ entry.field.title }}</legend>
                                        <span v-else>{{ entry.field.title }}</span>
                                        <small>
                                            {{ entry.field.description }}
                                            <span v-if="!entry.present"> · 未设置（控件显示不会写入默认值）</span>
                                        </small>
                                        <div
                                            v-if="entry.field.enumOptions.length"
                                            class="plugin-config-enum"
                                        >
                                            <label
                                                v-for="option in entry.field.enumOptions"
                                                :key="option.key"
                                                class="plugin-config-enum-option"
                                            >
                                                <input
                                                    type="radio"
                                                    :name="`${configInputId}:${entry.field.name}`"
                                                    :checked="selectedEnumOption(entry.field) === option"
                                                    @change="selectEnumOption(entry.field, option)"
                                                >
                                                <span>{{ option.label }}</span>
                                            </label>
                                            <p
                                                v-if="!entry.present"
                                                class="plugin-config-enum-status"
                                            >未设置</p>
                                            <p
                                                v-else-if="!selectedEnumOption(entry.field)"
                                                class="plugin-config-enum-status"
                                            >当前配置值不在选项中，请选择一个合法值。</p>
                                        </div>
                                        <ElSwitch
                                            v-else-if="entry.model.kind === 'boolean'"
                                            :model-value="entry.model.value"
                                            @update:model-value="updateBooleanField(entry, $event)"
                                        />
                                        <ElInputNumber
                                            v-else-if="entry.model.kind === 'number'"
                                            :model-value="entry.model.value"
                                            :min="entry.field.minimum"
                                            :max="entry.field.maximum"
                                            @update:model-value="updateNumberField(entry, $event)"
                                        />
                                        <ElInput
                                            v-else-if="entry.model.kind === 'text'"
                                            :model-value="entry.model.value"
                                            :placeholder="entry.field.title"
                                            @update:model-value="updateTextField(entry, $event)"
                                        />
                                        <div
                                            v-else
                                            class="plugin-config-json"
                                        >
                                            <p
                                                v-if="entry.model.error"
                                                role="alert"
                                            >{{ entry.model.error }}</p>
                                            <pre>{{ entry.present ? displayJsonValue(entry.value) : '未设置' }}</pre>
                                            <ElButton @click="beginJsonEdit(entry.field)">编辑字段 JSON</ElButton>
                                        </div>
                                    </component>
                                    <p
                                        v-if="configFields.length === 0"
                                        class="plugin-admin-empty"
                                    >
                                        此插件没有可编辑的顶层配置字段。
                                    </p>
                                </div>
                                <div
                                    v-if="jsonEditor"
                                    class="plugin-config-json-editor"
                                >
                                    <h3>{{ jsonEditor.field ? jsonEditor.field.title : '根配置' }} · JSON 编辑</h3>
                                    <p>应用只更新本地配置。解析失败保留原值和输入；保存仍需单独确认。</p>
                                    <ElInput
                                        type="textarea"
                                        :rows="6"
                                        :model-value="jsonEditor.text"
                                        :aria-label="`${jsonEditor.field ? jsonEditor.field.title : '根配置'} JSON`"
                                        @update:model-value="updateJsonText"
                                    />
                                    <p
                                        v-if="jsonEditor.error"
                                        role="alert"
                                    >{{ jsonEditor.error }}</p>
                                    <div class="plugin-config-json-actions">
                                        <ElButton @click="applyJsonEdit">应用 JSON</ElButton>
                                        <ElButton @click="jsonEditor = null">关闭编辑</ElButton>
                                    </div>
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
                                        <AdminInlineEmptyState title="该插件尚未产生执行记录" />
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
                                        <AdminInlineEmptyState title="该插件尚未产生错误记录" />
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
                                        <AdminInlineEmptyState title="该插件尚未产生日志条目" />
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
                                        <AdminInlineEmptyState title="没有节点" />
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
import { computed, onMounted, ref, shallowRef, toRaw, useId } from 'vue';

import {
    getPlugin,
    installPlugin,
    listPlugins,
    mutatePlugin,
    type PluginAdminDetail,
    type PluginAdminMutation,
    type PluginAdminOverview
} from '@/api/authoring';
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue';
import { ensureAdminSensitiveProof } from '@/composables/useAdminSensitiveProof';
import {
    FsusUiKeyValueGrid,
    FsusUiKeyValueItem,
    FsusUiSettingsSection,
    FsusUiTaskPageHeader
} from '@/fsusui';
import { confirmDanger, confirmWarning, toast } from '@/fsusui/feedback';
import { showErrorToast } from '@/utils/errorPresentation';

import { createPluginConfigEnumOptions, pluginConfigJsonValuesEqual, type PluginConfigEnumOption } from './pluginConfigEnum';
import {
    getPluginConfigWidgetModel,
    isPluginConfigObject,
    parsePluginConfigJson,
    pluginConfigJsonText,
    type PluginConfigWidgetModel
} from './pluginConfigModel';

interface ConfigField {
    name: string;
    title: string;
    description: string;
    type: string;
    enumOptions: readonly PluginConfigEnumOption[];
    minimum?: number;
    maximum?: number;
}

interface ConfigWidgetEntry {
    readonly field: ConfigField;
    readonly present: boolean;
    readonly value: unknown;
    readonly model: PluginConfigWidgetModel;
}

interface ConfigJsonEditor {
    readonly field: ConfigField | null;
    readonly sourceDetail: PluginAdminDetail;
    readonly sourceDraft: unknown;
    readonly text: string;
    readonly error: string | null;
}

const loading = ref(false);
const detailLoading = ref(false);
const installing = ref(false);
const actionLoading = ref('');
const activeTab = ref('permissions');
const selectedId = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const overview = shallowRef<PluginAdminOverview | null>(null);
const detail = shallowRef<PluginAdminDetail | null>(null);
const configDraft = ref<unknown>();
const configInputId = useId();
const jsonEditor = shallowRef<ConfigJsonEditor | null>(null);
const configObject = computed(() => isPluginConfigObject(configDraft.value) ? configDraft.value : null);

const configFields = computed<ConfigField[]>(() =>
{
    const properties = detail.value?.config.schema?.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties))
    {
        return [];
    }
    return Object.entries(properties).map(([name, schema]) => ({
        name,
        title: String(schema.title ?? name),
        description: String(schema.description ?? ''),
        type: String(schema.type ?? 'string'),
        enumOptions: Array.isArray(schema.enum) ? createPluginConfigEnumOptions(schema.enum) : [],
        minimum: typeof schema.minimum === 'number' ? schema.minimum : undefined,
        maximum: typeof schema.maximum === 'number' ? schema.maximum : undefined
    }));
});

const configWidgetFields = computed<readonly ConfigWidgetEntry[]>(() =>
{
    const object = configObject.value;
    if (object === null)
    {
        return [];
    }
    return configFields.value.map((field) =>
    {
        const present = Object.hasOwn(object, field.name);
        const value = present ? object[field.name] : undefined;
        return { field, present, value, model: getPluginConfigWidgetModel(field, value, present) };
    });
});

function displayJsonValue(value: unknown): string
{
    return pluginConfigJsonText(toRaw(value)) ?? '当前值无法表示为有限 JSON；原值未更改。';
}

function writeWidgetField(entry: ConfigWidgetEntry, value: unknown): void
{
    const object = configObject.value;
    if (object === null || !configWidgetFields.value.includes(entry))
    {
        return;
    }
    configDraft.value = { ...object, [entry.field.name]: value };
}

function updateBooleanField(entry: ConfigWidgetEntry, value: boolean | string | number): void
{
    if (entry.model.kind === 'boolean' && typeof value === 'boolean')
    {
        writeWidgetField(entry, value);
    }
}

function updateNumberField(entry: ConfigWidgetEntry, value: number | null | undefined): void
{
    if (entry.model.kind === 'number' && (value === null || value === undefined || Number.isFinite(value)))
    {
        writeWidgetField(entry, value);
    }
}

function updateTextField(entry: ConfigWidgetEntry, value: string): void
{
    if (entry.model.kind === 'text')
    {
        writeWidgetField(entry, value);
    }
}

function beginJsonEdit(field: ConfigField | null): void
{
    const sourceDetail = detail.value;
    if (sourceDetail === null || field !== null && !configFields.value.includes(field))
    {
        return;
    }
    const sourceDraft = configDraft.value;
    const object = configObject.value;
    if (field !== null && object === null)
    {
        return;
    }
    const value = field === null
        ? sourceDraft
        : object !== null && Object.hasOwn(object, field.name) ? object[field.name] : undefined;
    const text = pluginConfigJsonText(toRaw(value));
    jsonEditor.value = {
        field,
        sourceDetail,
        sourceDraft,
        text: text ?? '',
        error: text === null ? '当前值没有可用的 JSON 文本，请显式输入；原值仍保留。' : null
    };
}

function updateJsonText(text: string): void
{
    const editor = jsonEditor.value;
    if (editor !== null)
    {
        jsonEditor.value = { ...editor, text, error: null };
    }
}

function applyJsonEdit(): void
{
    const editor = jsonEditor.value;
    if (editor === null)
    {
        return;
    }
    if (detail.value !== editor.sourceDetail || configDraft.value !== editor.sourceDraft
        || editor.field !== null && !configFields.value.includes(editor.field))
    {
        jsonEditor.value = { ...editor, error: '配置或 Schema 已变更；输入已保留，请重新打开当前值的编辑器。' };
        return;
    }
    let value: unknown;
    try
    {
        value = parsePluginConfigJson(editor.text);
    }
    catch (error)
    {
        jsonEditor.value = { ...editor, error: error instanceof Error ? error.message : 'JSON 解析失败；原值和输入均已保留。' };
        return;
    }
    const object = configObject.value;
    if (editor.field !== null && object === null)
    {
        jsonEditor.value = { ...editor, error: '根配置不是对象；原值和输入均已保留。' };
        return;
    }
    configDraft.value = editor.field === null ? value : { ...object, [editor.field.name]: value };
    jsonEditor.value = null;
}

function selectedEnumOption(field: ConfigField): PluginConfigEnumOption | null
{
    const object = configObject.value;
    if (object === null || !Object.hasOwn(object, field.name))
    {
        return null;
    }
    const value = toRaw(object[field.name]);
    return field.enumOptions.find((option) => option.value === value)
        ?? field.enumOptions.find((option) => pluginConfigJsonValuesEqual(option.value, value))
        ?? null;
}

function selectEnumOption(field: ConfigField, option: PluginConfigEnumOption): void
{
    const object = configObject.value;
    if (object === null || !configFields.value.includes(field) || !field.enumOptions.includes(option))
    {
        return;
    }
    // Keep the canonical value itself, including null and nested objects/arrays.
    configDraft.value = { ...object, [field.name]: option.value };
}

async function loadOverview(): Promise<void>
{
    loading.value = true;
    try
    {
        overview.value = await listPlugins();
        const nextId = overview.value.plugins.some((item) => item.pluginId === selectedId.value)
            ? selectedId.value
            : overview.value.plugins[0]?.pluginId ?? '';
        if (nextId)
        {
            await selectPlugin(nextId);
        }
        else
        {
            selectedId.value = '';
            detail.value = null;
        }
    }
    catch (error)
    {
        showErrorToast(error, '插件列表加载失败');
    }
    finally
    {
        loading.value = false;
    }
}

async function selectPlugin(pluginId: string): Promise<void>
{
    selectedId.value = pluginId;
    detailLoading.value = true;
    try
    {
        detail.value = await getPlugin(pluginId);
        configDraft.value = structuredClone(detail.value.config.value);
    }
    catch (error)
    {
        showErrorToast(error, '插件详情加载失败');
    }
    finally
    {
        detailLoading.value = false;
    }
}

async function handleInstall(event: Event): Promise<void>
{
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file)
    {
        return;
    }
    const confirmation = await confirmWarning(
        `安装 ${file.name} 会把已验证包写入集群 Registry，但不会自动授予权限或启用。`,
        '确认安装插件',
        { confirmButtonText: '验证并安装' }
    );
    if (confirmation.kind !== 'confirmed')
    {
        return;
    }
    installing.value = true;
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        const installed = await installPlugin(file, { mfaProofToken });
        toast.success(`${installed.summary.name} 已安装，等待权限确认`);
        await loadOverview();
        await selectPlugin(installed.summary.pluginId);
    }
    catch (error)
    {
        showErrorToast(error, '插件安装失败');
    }
    finally
    {
        installing.value = false;
    }
}

async function runAction(action: PluginAdminMutation['action']): Promise<void>
{
    if (!detail.value)
    {
        return;
    }
    actionLoading.value = action;
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        const result = await mutatePlugin(detail.value.summary.pluginId, { action }, { mfaProofToken });
        if (result)
        {
            detail.value = result;
            configDraft.value = structuredClone(result.config.value);
        }
        toast.success(`插件操作已完成：${action}`);
        await loadOverview();
    }
    catch (error)
    {
        showErrorToast(error, `插件操作失败：${action}`);
    }
    finally
    {
        actionLoading.value = '';
    }
}

async function runDangerousAction(action: 'quarantine' | 'restore' | 'uninstall'): Promise<void>
{
    if (!detail.value)
    {
        return;
    }
    const confirmation = await confirmDanger(
        action === 'uninstall'
            ? '卸载会清除包内容、运行时和授权，操作不可直接撤销。'
            : action === 'quarantine'
                ? '隔离会立即卸载 Hook 并清空授权，不需要重启。'
                : '恢复只会回到禁用状态，仍需重新确认权限后启用。',
        `${action} ${detail.value.summary.name}`,
        { confirmButtonText: '确认执行' }
    );
    if (confirmation.kind !== 'confirmed')
    {
        return;
    }
    actionLoading.value = action;
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        const result = await mutatePlugin(
            detail.value.summary.pluginId,
            { action, confirmed: true },
            { mfaProofToken }
        );
        toast.success(`插件操作已完成：${action}`);
        if (result)
        {
            detail.value = result;
        }
        await loadOverview();
    }
    catch (error)
    {
        showErrorToast(error, `插件操作失败：${action}`);
    }
    finally
    {
        actionLoading.value = '';
    }
}

async function togglePermission(name: string, granted: boolean): Promise<void>
{
    if (!detail.value)
    {
        return;
    }
    const capability = detail.value.permissions.find((item) => item.name === name);
    const current = detail.value.permissions.filter((item) => item.granted).map((item) => item.name);
    const next = granted
        ? [...new Set([...current, name])]
        : current.filter((item) => item !== name);
    if (granted && capability?.requiresAdministratorConfirmation)
    {
        const confirmation = await confirmWarning(capability.reason, `授权 ${name}`);
        if (confirmation.kind !== 'confirmed')
        {
            return;
        }
    }
    actionLoading.value = `permission:${name}`;
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        const result = await mutatePlugin(
            detail.value.summary.pluginId,
            {
                action: granted ? 'grant' : 'revoke',
                capabilities: next,
                confirmed: granted && capability?.requiresAdministratorConfirmation === true
            },
            { mfaProofToken }
        );
        if (result)
        {
            detail.value = result;
        }
        toast.success(granted ? `${name} 已授权` : `${name} 已撤销`);
    }
    catch (error)
    {
        showErrorToast(error, '插件权限更新失败');
    }
    finally
    {
        actionLoading.value = '';
    }
}

async function saveConfig(): Promise<void>
{
    if (!detail.value)
    {
        return;
    }
    actionLoading.value = 'update-config';
    try
    {
        const mfaProofToken = await ensureAdminSensitiveProof();
        const result = await mutatePlugin(
            detail.value.summary.pluginId,
            {
                action: 'update-config',
                config: configDraft.value,
                expectedConfigVersion: detail.value.config.version
            },
            { mfaProofToken }
        );
        if (result)
        {
            detail.value = result;
            configDraft.value = structuredClone(result.config.value);
        }
        toast.success('插件配置已校验并保存');
    }
    catch (error)
    {
        showErrorToast(error, '插件配置保存失败');
    }
    finally
    {
        actionLoading.value = '';
    }
}

function healthTag(state: string): 'success' | 'warning' | 'danger' | 'info'
{
    if (state === 'healthy')
    {
        return 'success';
    }
    if (state === 'degraded')
    {
        return 'warning';
    }
    if (state === 'quarantined' || state === 'failed')
    {
        return 'danger';
    }
    return 'info';
}

function riskTag(risk: string): 'success' | 'warning' | 'danger' | 'info'
{
    if (risk === 'safe')
    {
        return 'success';
    }
    if (risk === 'sensitive')
    {
        return 'warning';
    }
    return risk === 'dangerous' || risk === 'trusted' ? 'danger' : 'info';
}

function healthLabel(state: string): string
{
    return {
        healthy: 'Healthy',
        degraded: 'Degraded',
        quarantined: 'Quarantined',
        disabled: 'Disabled',
        failed: 'Failed'
    }[state] ?? state;
}

onMounted(loadOverview);
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
    font-size: 13px;
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
    font-size: 13px;
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

.plugin-config-field--enum
 {
    display: block;
    min-width: 0;
    margin: 0;
    border: 0;
    padding: 0;
}

.plugin-config-enum
 {
    display: grid;
    gap: var(--fsus-space-2);
    margin-top: var(--fsus-space-2);
}

.plugin-config-enum-option
 {
    display: flex;
    align-items: flex-start;
    gap: var(--fsus-space-2);
    min-width: 0;
}

.plugin-config-enum-option span
 {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.plugin-config-enum-status
 {
    margin: 0;
    color: var(--fsusblog-text-secondary);
}

.plugin-config-json,
.plugin-config-json-editor
 {
    display: grid;
    gap: var(--fsus-space-2);
    min-width: 0;
}

.plugin-config-json pre
 {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.plugin-config-json-editor
 {
    grid-column: 1 / -1;
}

.plugin-config-json-actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-2);
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
