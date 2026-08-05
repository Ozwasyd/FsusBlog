<template>
    <div class="account-page ops-health-page account-motion-enter w-full">
        <FsusUiTaskPageHeader
            title="服务与后台状态"
            description="先处理异常，再按需查看正常服务与运行证据。"
            class="account-task-page-header"
            density="compact"
        />

        <OpsHealthWorkbench
            v-if="health"
            :health="health"
            :loading="loading"
            @refresh="loadHealth"
        />

        <FsusUiEmptyState
            v-else
            size="compact"
            :illustration="false"
            :title="stateTitle"
            :role="loading ? 'status' : undefined"
            :aria-live="loading ? 'polite' : 'off'"
            data-ops-health-state
        >
            <template
                v-if="failure"
                #description
            >
                <span
                    id="ops-health-failure-reason"
                    data-ops-health-failure-reason
                >{{ failure }}</span>
            </template>
            <template
                v-if="failure"
                #actions
            >
                <ElButton
                    native-type="button"
                    data-ops-health-retry
                    aria-describedby="ops-health-failure-reason"
                    :loading="loading"
                    :disabled="loading"
                    @click="loadHealth"
                >重新加载</ElButton>
            </template>
        </FsusUiEmptyState>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from 'vue';

import { getOpsHealth, type OpsHealthResponse } from '@/api/authoring';
import OpsHealthWorkbench from '@/components/admin/OpsHealthWorkbench.vue';
import { FsusUiEmptyState, FsusUiTaskPageHeader } from '@/fsusui';
import { showErrorToast } from '@/utils/errorPresentation';

const loading = shallowRef(false);
const health = shallowRef<OpsHealthResponse | null>(null);
const failure = shallowRef('');
const stateTitle = computed(() =>
{
    if (loading.value)
    {
        return failure.value
            ? '正在重新读取运维状态…'
            : '正在读取运维状态…';
    }
    return '运维状态暂不可用';
});

let activeController: AbortController | null = null;
let activeRequest: Promise<void> | null = null;
let requestVersion = 0;
let unmounted = false;

function loadHealth(): Promise<void>
{
    if (activeRequest)
    {
        return activeRequest;
    }

    const version = ++requestVersion;
    const controller = new AbortController();
    activeController = controller;
    loading.value = true;

    activeRequest = (async () =>
    {
        try
        {
            const nextHealth = await getOpsHealth({ signal: controller.signal });
            if (!unmounted && version === requestVersion)
            {
                health.value = nextHealth;
                failure.value = '';
            }
        }
        catch (error)
        {
            if (!unmounted && version === requestVersion && !controller.signal.aborted)
            {
                failure.value = showErrorToast(error, '服务与后台状态加载失败');
            }
        }
        finally
        {
            if (!unmounted && version === requestVersion)
            {
                loading.value = false;
            }
            if (activeController === controller)
            {
                activeController = null;
                activeRequest = null;
            }
        }
    })();

    return activeRequest;
}

onMounted(loadHealth);
onUnmounted(() =>
{
    unmounted = true;
    requestVersion += 1;
    activeController?.abort();
    activeController = null;
    activeRequest = null;
});
</script>
