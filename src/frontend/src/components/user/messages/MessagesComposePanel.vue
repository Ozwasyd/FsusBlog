<template>
  <div class="messages-flat-pane messages-compose-panel" :class="{ 'messages-mobile-compose': mobile }">
    <header v-if="!mobile" class="messages-pane-header">
      <span class="messages-header-title">{{ title }}</span>
    </header>
    <div class="messages-pane-body">
      <div v-if="mobile" class="messages-subheader">{{ title }}</div>
      <el-form label-position="top">
        <template v-if="mode === 'admin'">
          <el-form-item :label="composeCopy.targetAccountIdLabel">
            <el-input
              :model-value="systemTargetAccountId"
              :name="mobile ? 'systemTargetAccountIdMobile' : 'systemTargetAccountIdDesktop'"
              :placeholder="composeCopy.targetAccountIdPlaceholder"
              @update:model-value="emit('update:systemTargetAccountId', $event)"
            />
          </el-form-item>
          <el-form-item :label="composeCopy.subjectLabel">
            <el-input
              :model-value="systemSubject"
              :name="mobile ? 'systemSubjectMobile' : 'systemSubjectDesktop'"
              maxlength="160"
              show-word-limit
              :placeholder="composeCopy.systemSubjectPlaceholder"
              @update:model-value="emit('update:systemSubject', $event)"
            />
          </el-form-item>
          <el-form-item :label="composeCopy.bodyLabel">
            <el-input
              :model-value="systemBody"
              :name="mobile ? 'systemBodyMobile' : 'systemBodyDesktop'"
              :csp-safe="true"
              type="textarea"
              :rows="4"
              maxlength="4000"
              show-word-limit
              :placeholder="composeCopy.bodyPlaceholderAdmin"
              @update:model-value="emit('update:systemBody', $event)"
            />
          </el-form-item>
          <el-button type="primary" :loading="loading" @click="emit('submit')">{{ composeCopy.submitAdminCta }}</el-button>
        </template>

        <template v-else>
          <el-form-item :label="composeCopy.subjectLabel">
            <el-input
              :model-value="createSubject"
              :name="mobile ? 'ticketSubjectMobile' : 'ticketSubjectDesktop'"
              maxlength="160"
              show-word-limit
              :placeholder="composeCopy.accountSubjectPlaceholder"
              @update:model-value="emit('update:createSubject', $event)"
            />
          </el-form-item>
          <el-form-item :label="composeCopy.bodyLabel">
            <el-input
              :model-value="createBody"
              :name="mobile ? 'ticketBodyMobile' : 'ticketBodyDesktop'"
              :csp-safe="true"
              type="textarea"
              :rows="4"
              maxlength="4000"
              show-word-limit
              :placeholder="composeCopy.bodyPlaceholderAccount"
              @update:model-value="emit('update:createBody', $event)"
            />
          </el-form-item>
          <el-button type="primary" :loading="loading" @click="emit('submit')">{{ composeCopy.submitAccountCta }}</el-button>
        </template>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { FSUSBLOG_MESSAGES_COPY } from '@/copy'

const composeCopy = FSUSBLOG_MESSAGES_COPY.composePanel

const props = withDefaults(defineProps<{
  mode: 'admin' | 'account'
  mobile?: boolean
  loading: boolean
  systemTargetAccountId?: string
  systemSubject?: string
  systemBody?: string
  createSubject?: string
  createBody?: string
}>(), {
  mobile: false,
  systemTargetAccountId: '',
  systemSubject: '',
  systemBody: '',
  createSubject: '',
  createBody: ''
})

const emit = defineEmits<{
  'update:systemTargetAccountId': [value: string]
  'update:systemSubject': [value: string]
  'update:systemBody': [value: string]
  'update:createSubject': [value: string]
  'update:createBody': [value: string]
  submit: []
}>()

const title = computed(() => (props.mode === 'admin' ? composeCopy.titleAdmin : composeCopy.titleAccount))
</script>

<style scoped>
@reference "@/assets/main.css";

.messages-flat-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  max-width: 100%;
}

.messages-compose-panel {
  margin-top: 4rem;
}

.messages-mobile-compose {
  height: auto;
  margin-top: 1.5rem;
}

.messages-pane-header {
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  margin-bottom: 2rem;
}

.messages-pane-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
}

.messages-header-title,
.messages-subheader {
  color: var(--fsusblog-text-primary);
  font-size: 1.125rem;
  font-weight: 700;
  letter-spacing: 0;
}

.messages-subheader {
  margin-bottom: 1rem;
}
</style>
