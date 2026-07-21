<template>
  <section
    v-if="isEdit"
    class="article-revision-panel border-t border-[var(--fsusblog-panel-border)]"
    aria-labelledby="article-revision-title"
  >
    <header class="px-4 py-3 bg-[var(--fsusblog-page-bg-soft)] border-b border-[var(--fsusblog-panel-border)]">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div id="article-revision-title" class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">修订历史</div>
          <p class="mt-1 text-xs text-[var(--fsusblog-text-tertiary)]" aria-live="polite">{{ statusText }}</p>
        </div>
        <el-button
          circle
          :icon="Refresh"
          :loading="loading"
          :disabled="loading || rollbacking"
          aria-label="刷新修订历史"
          @click="$emit('refresh')"
        />
      </div>
    </header>

    <div class="space-y-4 p-4 bg-[var(--fsusblog-page-bg)]">
      <p v-if="!loading && revisions.length === 0" class="text-xs text-[var(--fsusblog-text-tertiary)]">
        暂无修订记录。发布或更新文章后会自动写入历史版本。
      </p>

      <div v-else class="revision-list" aria-label="历史版本列表">
        <button
          v-for="revision in revisions"
          :key="revision.id"
          type="button"
          class="revision-row"
          :class="{ 'revision-row--active': selectedRevision?.id === revision.id }"
          :disabled="loading || rollbacking"
          :aria-current="selectedRevision?.id === revision.id ? 'true' : undefined"
          @click="$emit('select-revision', revision)"
        >
          <span class="revision-row__main">
            <span class="revision-row__title">版本 {{ revision.revisionNo }} · {{ revision.title }}</span>
            <span class="revision-row__meta">
              {{ revision.diffSummary }} · <SemanticTime :value="revision.createdAt" />
            </span>
          </span>
          <span class="revision-row__actor">Admin #{{ revision.createdByAdminPrincipalId }}</span>
        </button>
      </div>

      <div v-if="selectedRevision" class="revision-compare border-t border-[var(--fsusblog-panel-border)] pt-4">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]">{{ selectedLabel }}</div>
            <p class="mt-1 text-xs text-[var(--fsusblog-text-secondary)]">{{ compareText }}</p>
          </div>
          <el-button
            type="primary"
            :icon="RefreshLeft"
            :loading="rollbacking"
            :disabled="loading || rollbacking || !selectedRevision.packageComplete || rollbackReason.trim().length < 8"
            aria-label="从此版本创建新版本"
            @click="$emit('rollback', { targetStatus: rollbackStatus, reason: rollbackReason.trim() })"
          >
            创建回滚版本
          </el-button>
        </div>
        <dl class="revision-fields">
          <div>
            <dt>标题</dt>
            <dd>{{ selectedRevision.title }}</dd>
          </div>
          <div>
            <dt>正文</dt>
            <dd>{{ selectedRevision.content.length }} 字符</dd>
          </div>
          <div>
            <dt>标签</dt>
            <dd>{{ selectedRevision.tagIds.length }} 个</dd>
          </div>
          <div>
            <dt>版权快照</dt>
            <dd>{{ selectedRevision.rights?.licenseType ?? '缺失（不可回滚）' }}</dd>
          </div>
          <div>
            <dt>责任快照</dt>
            <dd>{{ selectedRevision.responsibility ? `${selectedRevision.responsibility.authors.length} 位作者` : '缺失（不可回滚）' }}</dd>
          </div>
          <div>
            <dt>历史发布</dt>
            <dd>{{ selectedRevision.release ? `发布 #${selectedRevision.release.publicationNo}` : '未公开版本' }}</dd>
          </div>
        </dl>
        <div class="revision-rollback-form" aria-label="回滚设置">
          <label for="revision-rollback-status">新版本状态</label>
          <el-select id="revision-rollback-status" v-model="rollbackStatus" :disabled="loading || rollbacking">
            <el-option label="草稿" :value="0" />
            <el-option label="已发布" :value="2" />
            <el-option label="已归档" :value="3" />
          </el-select>
          <label for="revision-rollback-reason">回滚原因</label>
          <el-input
            id="revision-rollback-reason"
            v-model="rollbackReason"
            type="textarea"
            :csp-safe="true"
            :rows="2"
            maxlength="500"
            show-word-limit
            placeholder="说明为何需要从此历史版本创建新版本（至少 8 个字符）"
            :disabled="loading || rollbacking"
          />
          <p class="revision-rollback-hint">回滚会复制所选版本的内容、版权与责任快照，并创建新的修订和发布记录；历史记录不会被修改。</p>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Refresh, RefreshLeft } from '@/fsusui/icons'
import { ref, watch } from 'vue'
import SemanticTime from '@/components/ui/SemanticTime.vue'
import type { ArticleRevisionDetailResponse, ArticleRevisionSummaryResponse } from '@/api/authoring'

const props = defineProps<{
  isEdit: boolean
  revisions: ArticleRevisionSummaryResponse[]
  selectedRevision: ArticleRevisionDetailResponse | null
  selectedLabel: string
  loading: boolean
  rollbacking: boolean
  statusText: string
  compareText: string
}>()

defineEmits<{
  (e: 'refresh'): void
  (e: 'select-revision', revision: ArticleRevisionSummaryResponse): void
  (e: 'rollback', selection: { targetStatus: 0 | 2 | 3; reason: string }): void
}>()

const rollbackStatus = ref<0 | 2 | 3>(2)
const rollbackReason = ref('')

watch(() => props.selectedRevision?.id, () => {
  rollbackStatus.value = 2
  rollbackReason.value = ''
})

</script>

<style scoped>
.revision-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.revision-row {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg-soft);
  padding: 0.75rem;
  text-align: left;
  transition: border-color var(--fsus-motion-control-fast) var(--fsus-motion-standard),
    background-color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.revision-row:hover,
.revision-row--active {
  border-color: var(--fsus-state-focus-border, var(--fsusblog-color-primary));
  background: var(--fsus-state-selected-bg, var(--fsusblog-page-bg));
}

.revision-row__main {
  min-width: 0;
}

.revision-row__title,
.revision-row__meta {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.revision-row__title {
  color: var(--fsusblog-text-primary);
  font-size: 14px;
  font-weight: 700;
}

.revision-row__meta,
.revision-row__actor {
  color: var(--fsusblog-text-tertiary);
  font-size: 12px;
}

.revision-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
  margin-top: 1rem;
}

.revision-rollback-form {
  display: grid;
  gap: 0.5rem;
  margin-top: 1rem;
}

.revision-rollback-form label {
  color: var(--fsusblog-text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.revision-rollback-hint {
  color: var(--fsusblog-text-tertiary);
  font-size: 12px;
  line-height: 1.6;
}

.revision-fields div {
  min-width: 0;
}

.revision-fields dt {
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 500;
}

.revision-fields dd {
  overflow: hidden;
  margin: 0.25rem 0 0;
  color: var(--fsusblog-text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
