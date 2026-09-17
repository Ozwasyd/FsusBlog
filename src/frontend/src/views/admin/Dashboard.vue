<template>
    <AdminDashboardTaskWorkbench
        :can-view-audit-log="canViewAuditLog"
        :has-summary-data="hasSummaryData"
        :help-links="helpLinks"
        :ledger-items="ledgerItems"
        :pending-actions="pendingActions"
        :recent-changes="recentChanges"
        :recent-changes-error-message="recentChangesErrorMessage"
        :recent-changes-loaded="recentChangesLoaded"
        :recent-changes-loading="recentChangesLoading"
        :summary-error-message="summaryErrorMessage"
        :summary-loaded="summaryLoaded"
        :summary-loading="summaryLoading"
        :system-status="systemStatus"
        :write-action="writeAction"
        @refresh-recent-changes="refreshRecentChanges"
        @refresh-summary="refreshSummary"
    />
</template>

<script setup lang="ts">
import AdminDashboardTaskWorkbench from '@/components/admin/AdminDashboardTaskWorkbench.vue';
import { useAdminDashboardWorkbench } from '@/composables/useAdminDashboardWorkbench';

const {
    canViewAuditLog,
    hasSummaryData,
    helpLinks,
    ledgerItems,
    pendingActions,
    recentChanges,
    recentChangesErrorMessage,
    recentChangesLoaded,
    recentChangesLoading,
    refreshRecentChanges,
    refreshSummary,
    summaryErrorMessage,
    summaryLoaded,
    summaryLoading,
    systemStatus,
    writeAction
} = useAdminDashboardWorkbench();
</script>
