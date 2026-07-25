<template>
  <div class="space-y-8">
    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
      <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
        <h2 class="text-xl font-bold text-[var(--fsusblog-text-primary)]">{{ copy.sectionTitle }}</h2>
        <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">{{ copy.sectionDescription }}</p>
      </div>

      <div
        class="moderation-replay-controls"
        :aria-label="copy.replayParamsAriaLabel"
        role="group"
      >
        <label class="moderation-replay-field">
          <span class="moderation-replay-field__label">{{
            copy.regionFieldLabel
          }}</span>
          <el-select
            v-model="form.region"
            allow-create
            clearable
            default-first-option
            filterable
            class="moderation-replay-field__control"
            :loading="regionsLoading"
            :placeholder="copy.inputRegionPlaceholder"
            :aria-label="copy.inputRegionAriaLabel"
          >
            <el-option
              v-for="option in replayRegionOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </label>
        <label class="moderation-replay-field">
          <span class="moderation-replay-field__label">{{
            copy.policyVersionFieldLabel
          }}</span>
          <el-input
            v-model="form.policyVersion"
            clearable
            class="moderation-replay-field__control"
            :placeholder="copy.inputPolicyVersionPlaceholder"
            :aria-label="copy.inputPolicyVersionAriaLabel"
          />
        </label>
        <label class="moderation-replay-field">
          <span class="moderation-replay-field__label">{{
            copy.dictionaryIdFieldLabel
          }}</span>
          <el-input
            v-model="form.dictionaryId"
            clearable
            class="moderation-replay-field__control"
            :placeholder="copy.inputDictionaryIdPlaceholder"
            :aria-label="copy.inputDictionaryIdAriaLabel"
          />
        </label>
        <label class="moderation-replay-field">
          <span class="moderation-replay-field__label">{{
            copy.limitFieldLabel
          }}</span>
          <el-input-number
            v-model="form.limit"
            class="moderation-replay-field__control"
            :min="1"
            :max="200"
            controls-position="right"
            :aria-label="copy.inputLimitAriaLabel"
          />
        </label>
        <div class="moderation-replay-action">
          <el-button
            type="primary"
            :icon="DocumentChecked"
            :loading="loading"
            @click="runPreview"
            >{{ copy.generatePreviewCta }}</el-button
          >
        </div>
      </div>

      <AdminStatusMatrix v-if="preview" :items="metrics" density="compact" :aria-label="copy.previewMetricsAriaLabel" />

      <div v-if="preview" class="blog-scroll-x-safe moderation-replay-table-scroll">
        <el-table v-loading="loading" :data="preview.items" row-key="commentId">
          <el-table-column :label="copy.columnComment" width="110" prop="commentId" />
          <el-table-column :label="copy.columnPolicyVersion" min-width="240">
            <template #default="{ row }: { row: ModerationReplayPreviewItemResponse }">
              <div class="text-xs text-[var(--fsusblog-text-secondary)]">
                <div>{{ row.previousPolicyVersion }}</div>
                <div class="mt-1 text-[var(--fsusblog-text-muted)]">-> {{ row.nextPolicyVersion }}</div>
              </div>
            </template>
          </el-table-column>
          <el-table-column :label="copy.columnBlockedRegions" min-width="220">
            <template #default="{ row }: { row: ModerationReplayPreviewItemResponse }">
              <div class="flex flex-wrap gap-1">
                <el-tag v-for="region in row.addedBlockedRegions" :key="`add-${region}`" size="small" type="danger">+ {{ region }}</el-tag>
                <el-tag v-for="region in row.removedBlockedRegions" :key="`remove-${region}`" size="small" type="info">- {{ region }}</el-tag>
                <span v-if="row.addedBlockedRegions.length + row.removedBlockedRegions.length === 0">{{ copy.blockedRegionsEmpty }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column :label="copy.columnRiskLabels" min-width="220">
            <template #default="{ row }: { row: ModerationReplayPreviewItemResponse }">
              <div class="flex flex-wrap gap-1">
                <el-tag v-for="label in row.addedRiskLabels" :key="`add-${label}`" size="small" type="warning">+ {{ label }}</el-tag>
                <el-tag v-for="label in row.removedRiskLabels" :key="`remove-${label}`" size="small" type="info">- {{ label }}</el-tag>
                <span v-if="row.addedRiskLabels.length + row.removedRiskLabels.length === 0">{{ copy.riskLabelsEmpty }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column :label="copy.columnVisibility" width="140">
            <template #default="{ row }: { row: ModerationReplayPreviewItemResponse }">
              <el-tag :type="row.publicVisibilityChanged ? 'warning' : 'info'">{{ row.publicVisibilityChanged ? copy.visibilityChanged : copy.visibilityUnchanged }}</el-tag>
            </template>
          </el-table-column>
          <template #empty>
            <AdminInlineEmptyState
              :title="copy.emptyPreviewTitle"
              :description="copy.emptyPreviewDescription"
            />
          </template>
        </el-table>
      </div>
      <AdminInlineEmptyState
        v-else
        :title="copy.notGeneratedTitle"
        :description="copy.notGeneratedDescription"
      />
    </section>

    <section class="admin-muted-alert admin-muted-alert--warning px-5 py-4 text-[12px] leading-6">
      {{ copy.executionNotice }}
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from 'vue'
import {
  listModerationRegions,
  previewModerationReplay,
  type ModerationRegionDefinition,
  type ModerationReplayPreviewItemResponse,
  type ModerationReplayPreviewResponse
} from '@/api/authoring'
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'
import AdminStatusMatrix, { type AdminStatusMatrixItem } from '@/components/admin/AdminStatusMatrix.vue'
import { DocumentChecked } from '@/fsusui/icons'
import { showErrorToast } from '@/utils/errorPresentation'
import { formatModerationRegionName } from '@/utils/moderationRegionDisplay'
import { useI18nText } from '@/composables/useI18nText'

const { messages } = useI18nText()
const copy = computed(() => messages.value.admin.moderationReplay)
const fallbackReplayRegionCodes = ['CN-MAINLAND', 'GLOBAL', 'EU', 'US', 'UNKNOWN']

const loading = shallowRef(false)
const regionsLoading = shallowRef(false)
const replayRegions = shallowRef<ModerationRegionDefinition[]>([])
const preview = shallowRef<ModerationReplayPreviewResponse | null>(null)
const form = reactive({
  region: 'CN-MAINLAND',
  policyVersion: '',
  dictionaryId: '',
  limit: 50
})

const replayRegionOptions = computed(() => {
  const regionCodes = new Set<string>([
    form.region,
    ...fallbackReplayRegionCodes,
    ...replayRegions.value.map((region) => region.regionCode)
  ])

  return Array.from(regionCodes)
    .filter(Boolean)
    .map((value) => ({
      label: formatModerationRegionName(value),
      value
    }))
})

const metrics = computed<AdminStatusMatrixItem[]>(() => {
  if (!preview.value) return []
  return [
    { label: copy.value.metricScanned, value: preview.value.scannedCount },
    { label: copy.value.metricAffected, value: preview.value.affectedCommentCount },
    { label: copy.value.metricVisibilityChanged, value: preview.value.publicVisibilityChangedCount },
    { label: copy.value.metricHighRiskChanged, value: preview.value.highRiskChangeCount },
    { label: copy.value.metricAddedRegions, value: preview.value.addedBlockedRegionCount },
    { label: copy.value.metricRemovedRegions, value: preview.value.removedBlockedRegionCount },
    { label: copy.value.metricAddedRiskLabels, value: preview.value.addedRiskLabelCount },
    { label: copy.value.metricRemovedRiskLabels, value: preview.value.removedRiskLabelCount }
  ]
})

const loadReplayRegions = async (): Promise<void> => {
  regionsLoading.value = true
  try {
    replayRegions.value = await listModerationRegions()
  } catch (error) {
    showErrorToast(error, copy.value.regionOptionsErrorToastFallback)
  } finally {
    regionsLoading.value = false
  }
}

const runPreview = async (): Promise<void> => {
  loading.value = true
  try {
    preview.value = await previewModerationReplay({
      region: form.region || null,
      policyVersion: form.policyVersion || null,
      dictionaryId: form.dictionaryId || null,
      limit: form.limit
    })
  } catch (error) {
    showErrorToast(error, copy.value.errorToastFallback)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadReplayRegions()
})
</script>

<style scoped>
.tabular-nums {
  font-variant-numeric: tabular-nums;
}

.moderation-replay-controls {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--fsus-space-3);
  align-items: end;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg-soft);
  padding: var(--fsus-space-4);
}

.moderation-replay-field {
  display: grid;
  min-width: 0;
  gap: var(--fsus-space-2);
}

.moderation-replay-field__label {
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.2;
}

.moderation-replay-field__control,
.moderation-replay-action > * {
  width: 100%;
}

.moderation-replay-field > * {
  width: 100%;
}

.moderation-replay-action {
  display: flex;
  grid-column: 1 / -1;
  justify-content: flex-end;
  min-width: 0;
}

.moderation-replay-action > * {
  width: auto;
  min-width: 168px;
}

.moderation-replay-table-scroll {
  max-width: 100%;
  overflow-x: auto;
}

@media (max-width: 767px) {
  .moderation-replay-controls {
    grid-template-columns: 1fr;
  }

  .moderation-replay-action {
    justify-content: stretch;
  }

  .moderation-replay-action > * {
    width: 100%;
  }
}
</style>
