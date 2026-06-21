<template>
  <div class="messages-flat-pane messages-compose-panel" :class="{ 'messages-mobile-compose': mobile }">
    <header v-if="!mobile" class="messages-pane-header">
      <span class="messages-header-title">{{ title }}</span>
    </header>
    <div class="messages-pane-body">
      <div v-if="mobile" class="messages-subheader">{{ title }}</div>
      <el-form label-position="top">
        <template v-if="mode === 'admin'">
          <el-form-item label="目标账号 ID">
            <el-input
              :model-value="systemTargetAccountId"
              :name="mobile ? 'systemTargetAccountIdMobile' : 'systemTargetAccountIdDesktop'"
              placeholder="请输入账号 ID"
              @update:model-value="emit('update:systemTargetAccountId', $event)"
            />
          </el-form-item>
          <el-form-item label="主题">
            <el-input
              :model-value="systemSubject"
              :name="mobile ? 'systemSubjectMobile' : 'systemSubjectDesktop'"
              maxlength="160"
              show-word-limit
              placeholder="例如：系统通知"
              @update:model-value="emit('update:systemSubject', $event)"
            />
          </el-form-item>
          <el-form-item label="内容">
            <el-input
              :model-value="systemBody"
              :name="mobile ? 'systemBodyMobile' : 'systemBodyDesktop'"
              type="textarea"
              :rows="4"
              maxlength="4000"
              show-word-limit
              placeholder="请输入消息正文"
              @update:model-value="emit('update:systemBody', $event)"
            />
          </el-form-item>
          <el-button type="success" :loading="loading" @click="emit('submit')">发送系统消息</el-button>
        </template>

        <template v-else>
          <el-form-item label="主题">
            <el-input
              :model-value="createSubject"
              :name="mobile ? 'ticketSubjectMobile' : 'ticketSubjectDesktop'"
              maxlength="160"
              show-word-limit
              placeholder="例如：账号误封申诉"
              @update:model-value="emit('update:createSubject', $event)"
            />
          </el-form-item>
          <el-form-item label="内容">
            <el-input
              :model-value="createBody"
              :name="mobile ? 'ticketBodyMobile' : 'ticketBodyDesktop'"
              type="textarea"
              :rows="4"
              maxlength="4000"
              show-word-limit
              placeholder="请描述问题与诉求"
              @update:model-value="emit('update:createBody', $event)"
            />
          </el-form-item>
          <el-button type="success" :loading="loading" @click="emit('submit')">提交工单</el-button>
        </template>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

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

const title = computed(() => (props.mode === 'admin' ? '发送系统消息' : '新建申诉工单'))
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
