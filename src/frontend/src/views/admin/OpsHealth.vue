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

        <section
            v-else
            class="ops-health-loading"
            aria-live="polite"
        >
            {{ loading ? '正在读取运维状态…' : '运维状态暂不可用，请刷新重试。' }}
            <button
                v-if="!loading"
                type="button"
                @click="loadHealth"
            >重新加载</button>
        </section>
    </div>
</template>

<script setup lang="ts">
import { onMounted, shallowRef } from 'vue';

import { getOpsHealth, type OpsHealthResponse } from '@/api/authoring';
import OpsHealthWorkbench from '@/components/admin/OpsHealthWorkbench.vue';
import { FsusUiTaskPageHeader } from '@/fsusui';
import { showErrorToast } from '@/utils/errorPresentation';

const loading = shallowRef(false);
const health = shallowRef<OpsHealthResponse | null>(null);

async function loadHealth(): Promise<void>
{
    loading.value = true;
    try
    {
        health.value = await getOpsHealth();
    }
    catch (error)
    {
        showErrorToast(error, '服务与后台状态加载失败');
    }
    finally
    {
        loading.value = false;
    }
}

onMounted(loadHealth);
</script>

<style scoped>
.ops-health-loading
 {
    display: flex;
    min-height: 9rem;
    align-items: center;
    justify-content: center;
    gap: var(--fsus-space-3);
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-panel);
    background: var(--fsusblog-panel-bg);
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
}

.ops-health-loading button
 {
    min-height: 40px;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control);
    background: transparent;
    padding: 0 var(--fsus-space-4);
    color: var(--fsusblog-text-primary);
    cursor: pointer;
    font: inherit;
    font-weight: 500;
}
</style>
