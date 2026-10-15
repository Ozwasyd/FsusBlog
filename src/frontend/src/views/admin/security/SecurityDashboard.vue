<template>
    <SecurityDashboardWorkbench
        v-if="model"
        :error-message="errorMessage"
        :loading="loading"
        :model="model"
        @refresh="loadOverview"
    />
    <section
        v-else
        class="security-dashboard-loading"
        role="status"
        aria-live="polite"
    >
        <strong>{{ errorMessage ? '安全状态暂不可用' : '正在读取安全状态' }}</strong>
        <span>{{ errorMessage || '正在汇总待处理任务、异常、趋势和最近策略变化。' }}</span>
        <FsusUiButton
            v-if="errorMessage"
            class="security-dashboard-loading__retry"
            native-type="button"
            @click="loadOverview"
        >重新检查</FsusUiButton>
    </section>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef } from 'vue';

import { getSecurityOverview, type SecurityOverviewResponse } from '@/api/security';
import SecurityDashboardWorkbench from '@/components/admin/SecurityDashboardWorkbench.vue';
import { FsusUiButton } from '@/fsusui/button';
import { createSecurityDashboardModel } from '@/view-contracts/securityDashboard';

const errorMessage = shallowRef('');
const loading = shallowRef(false);
const overview = shallowRef<SecurityOverviewResponse | null>(null);
const model = computed(() => overview.value ? createSecurityDashboardModel(overview.value) : null);

const loadOverview = async (): Promise<void> =>
{
    loading.value = true;
    errorMessage.value = '';
    try
    {
        overview.value = await getSecurityOverview();
    }
    catch
    {
        errorMessage.value = '安全状态读取失败，请检查连接后重试';
    }
    finally
    {
        loading.value = false;
    }
};

onMounted(() =>
{
    void loadOverview();
});
</script>

<style scoped>
.security-dashboard-loading
 {
    display: grid;
    gap: var(--fsus-space-2);
    padding: var(--fsus-space-5);
    border-block: 1px solid var(--fsusblog-panel-border);
    color: var(--fsusblog-text-secondary);
    background: var(--fsusblog-page-bg-soft);
    font-size: 14px;
    line-height: 1.5;
}

.security-dashboard-loading strong
 {
    color: var(--fsusblog-text-primary);
    font-size: 18px;
}

.security-dashboard-loading__retry
 {
    width: fit-content;
}
</style>
