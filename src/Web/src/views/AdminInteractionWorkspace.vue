<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElTabPane, ElTabs } from '@ozwasyd/element-plus'
import { t } from '../siteLocale'
import { ApiError } from '../../../Contracts/aeds'
import AdminModerationControls from './AdminModerationControls.vue'
import AdminAppealReview from './AdminAppealReview.vue'
import AdminInbox from './AdminInbox.vue'

const props = defineProps<{
  sessionSignal: AbortSignal
  canModerate: boolean
  canManageInbox: boolean
}>()
const emit = defineEmits<{ 'session-lost': [error: unknown] }>()
const defaultTab = computed(() => props.canModerate ? 'queue' : 'inbox')
const selected = ref<string | number>(defaultTab.value)
</script>

<template>
  <ElTabs v-model="selected" class="admin-interaction-tabs">
    <ElTabPane v-if="canModerate" name="queue" :label="t('admin.moderation.m32')" lazy>
      <AdminModerationControls
        :session-signal="sessionSignal"
        @session-lost="emit('session-lost', $event)"
      />
    </ElTabPane>
    <ElTabPane v-if="canModerate" name="appeals" :label="t('admin.appeals.m1')" lazy>
      <AdminAppealReview
        :session-signal="sessionSignal"
        @session-lost="emit('session-lost', $event)"
      />
    </ElTabPane>
    <ElTabPane v-if="canManageInbox" name="inbox" :label="t('admin.inbox.m1')" lazy>
      <AdminInbox
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
