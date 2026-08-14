import { computed, onMounted, ref, shallowRef } from 'vue';

import {
    getPlugin,
    installPlugin,
    listPlugins,
    mutatePlugin,
    type PluginAdminDetail,
    type PluginAdminMutation,
    type PluginAdminOverview
} from '@/api/authoring';
import { ensureAdminSensitiveProof } from '@/composables/useAdminSensitiveProof';
import { confirmDanger, confirmWarning, toast } from '@/fsusui/feedback';
import { showErrorToast } from '@/utils/errorPresentation';

export function usePluginAdmin()
{
    interface ConfigField {
        name: string;
        title: string;
        description: string;
        type: string;
        enumValues: unknown[];
        minimum?: number;
        maximum?: number;
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
    const configDraft = ref<Record<string, unknown>>({});

    function configText(value: unknown, fallback: string): string
    {
        return typeof value === 'string' ? value : fallback;
    }

    const configFields = computed<ConfigField[]>(() =>
    {
        const properties = detail.value?.config.schema?.properties;
        if (!properties || typeof properties !== 'object' || Array.isArray(properties))
        {
            return [];
        }
        return Object.entries(properties as Record<string, Record<string, unknown>>).map(([name, schema]) => ({
            name,
            title: configText(schema.title, name),
            description: configText(schema.description, ''),
            type: configText(schema.type, 'string'),
            enumValues: Array.isArray(schema.enum) ? schema.enum : [],
            minimum: typeof schema.minimum === 'number' ? schema.minimum : undefined,
            maximum: typeof schema.maximum === 'number' ? schema.maximum : undefined
        }));
    });

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

    return {
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
    };
}
