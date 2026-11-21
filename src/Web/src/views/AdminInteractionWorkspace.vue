<script setup lang="ts">
import { ref } from 'vue'
import { ElTabPane, ElTabs } from '@ozwasyd/element-plus'
import type { AdminSession } from '../../../Contracts/admin-identity'
import { t } from '../siteLocale'
import AdminModerationControls from './AdminModerationControls.vue'
import AdminAppealReview from './AdminAppealReview.vue'
import AdminInbox from './AdminInbox.vue'
import AdminReaderGovernance from './AdminReaderGovernance.vue'

defineProps<{
  session: AdminSession
  sessionSignal: AbortSignal
}>()
const emit = defineEmits<{ 'session-lost': [error: unknown] }>()
const selected = ref<string | number>('queue')
</script>

<template>
  <ElTabs v-model="selected" class="admin-interaction-tabs">
    <ElTabPane name="queue" :label="t('admin.moderation.m32')" lazy>
      <AdminModerationControls
        :session-signal="sessionSignal"
        @session-lost="emit('session-lost', $event)"
      />
    </ElTabPane>
    <ElTabPane name="appeals" :label="t('admin.appeals.m1')" lazy>
      <AdminAppealReview
        :session-signal="sessionSignal"
        @session-lost="emit('session-lost', $event)"
      />
    </ElTabPane>
    <ElTabPane name="inbox" :label="t('admin.inbox.m1')" lazy>
      <AdminInbox
        :session-signal="sessionSignal"
        @session-lost="emit('session-lost', $event)"
      />
    </ElTabPane>
    <ElTabPane name="readers" :label="t('admin.readers.tab')" lazy>
      <AdminReaderGovernance
        :session="session"
        :session-signal="sessionSignal"
        @session-lost="emit('session-lost', $event)"
      />
    </ElTabPane>
  </ElTabs>
</template>

<style scoped>
.admin-interaction-tabs { min-width: 0; }
.admin-interaction-tabs :deep(.el-tabs__content) { min-width: 0; overflow: visible; }
.admin-interaction-tabs :deep(.el-tab-pane) { min-width: 0; }
</style>
