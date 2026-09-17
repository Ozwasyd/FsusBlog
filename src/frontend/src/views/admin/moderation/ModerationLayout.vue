<template>
    <div class="account-page moderation-system-page account-motion-enter w-full">
        <FsusUiTaskPageHeader
            title="审核系统"
            class="account-task-page-header"
            density="compact"
        />

        <section class="admin-muted-alert admin-muted-alert--warning mb-8 px-5 py-4 text-[12px] leading-6">
            <strong class="text-[var(--fsusblog-text-primary)]">地区法律策略优先级高于反垃圾模型。</strong>
            <span class="ml-2">模型输出只作为风险信号；最终动作来自地区策略、硬词库和管理员审核。</span>
        </section>

        <AdminSystemTabs
            class="mb-8"
            :items="moderationSystemTabs"
            aria-label="审核系统栏目"
        />
        <RouterView />
    </div>
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router';

import AdminSystemTabs, { type AdminSystemTab } from '@/components/admin/AdminSystemTabs.vue';
import { FsusUiTaskPageHeader } from "@/fsusui";

const moderationSystemTabs = [
    { label: '总览', name: 'ManageModerationDashboard' },
    { label: '评论审核', name: 'ManageModerationComments' },
    { label: '词库管理', name: 'ManageModerationDictionaries' },
    { label: '地区策略', name: 'ManageModerationPolicies' },
    { label: '地区', name: 'ManageModerationRegions' },
    { label: '大区', name: 'ManageModerationRegionGroups' },
    { label: '模板', name: 'ManageModerationPolicyTemplates' },
    { label: '策略回放', name: 'ManageModerationReplay' },
    { label: '审核模型', name: 'ManageModerationModel' },
    { label: '审核审计', name: 'ManageModerationAudit' }
] as const satisfies readonly AdminSystemTab[];
</script>
