<template>
  <AdminDashboardTaskWorkbench
    :has-summary-data="hasSummaryData"
    :help-links="helpLinks"
    :ledger-items="ledgerItems"
    :summary-error-message="summaryErrorMessage"
    :summary-loaded="summaryLoaded"
    :summary-loading="summaryLoading"
    :today-actions="todayActions"
    @refresh-summary="refreshSummary"
  />
</template>

<script setup lang="ts">
import AdminDashboardTaskWorkbench from '@/components/admin/AdminDashboardTaskWorkbench.vue'
import { useAdminDashboardWorkbench } from '@/composables/useAdminDashboardWorkbench'

const {
  hasSummaryData,
  helpLinks,
  ledgerItems,
  refreshSummary,
  summaryErrorMessage,
  summaryLoaded,
  summaryLoading,
  todayActions
} = useAdminDashboardWorkbench()
</script>
