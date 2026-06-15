<template>
  <section class="article-asset-library-panel border-t border-[var(--fsusblog-panel-border)]" aria-labelledby="article-asset-library-title">
    <header class="px-4 py-3 bg-[var(--fsusblog-page-bg-soft)] border-b border-[var(--fsusblog-panel-border)]">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div id="article-asset-library-title" class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">资产库</div>
          <p class="mt-1 text-xs text-[var(--fsusblog-text-tertiary)]" aria-live="polite">{{ statusText }}</p>
        </div>
        <div class="asset-actions">
          <el-button
            circle
            :icon="Refresh"
            :loading="loading"
            :disabled="loading"
            aria-label="刷新资产库"
            @click="$emit('refresh')"
          />
          <el-button
            circle
            :icon="FolderChecked"
            :loading="loading"
            :disabled="loading || !canReindex"
            aria-label="重建资产索引"
            @click="$emit('reindex')"
          />
          <el-button
            circle
            type="danger"
            :icon="Delete"
            :loading="loading"
            :disabled="loading || orphanCount === 0"
            aria-label="清理孤儿资产"
            @click="$emit('cleanup-orphans')"
          />
        </div>
      </div>
    </header>

    <div class="space-y-4 p-4 bg-[var(--fsusblog-page-bg)]">
      <p v-if="assets.length === 0" class="asset-empty">暂无可复用资产。</p>
      <div v-else class="asset-list" aria-label="可复用资产列表">
        <p
          v-if="assetRowMotion.summary.value"
          class="blog-motion-summary-enter asset-motion-summary"
          role="status"
          aria-live="polite"
        >
          {{ assetRowMotion.summary.value }}
        </p>
        <article
          v-for="asset in visibleAssets"
          :key="asset.id"
          class="asset-row"
          :class="[assetRowMotion.classFor(asset.id), { 'asset-row--orphan': asset.referenceCount === 0 }]"
          v-memo="[asset.id, asset.url, asset.referenceCount, assetRowMotion.stateFor(asset.id)]"
        >
          <img class="asset-row__thumb" :src="asset.url" :alt="asset.altText ?? ''" loading="lazy" decoding="async" />
          <div class="asset-row__meta">
            <div class="asset-row__url">{{ asset.url }}</div>
            <div class="asset-row__sub">引用 {{ asset.referenceCount }} · 来源 #{{ asset.sourceArticleId ?? '-' }}</div>
          </div>
          <div class="asset-row__insert">
            <el-button
              type="primary"
              :icon="Plus"
              :disabled="loading || asset.referenceCount === 0"
              :aria-label="`插入资产 ${asset.url}`"
              @click="$emit('insert', asset)"
            >
              插入
            </el-button>
          </div>
        </article>
        <el-button
          v-if="hiddenAssetCount > 0"
          link
          type="primary"
          @click="visibleAssetLimit += ASSET_RENDER_WINDOW"
        >
          显示更多资产（{{ hiddenAssetCount }}）
        </el-button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Delete, FolderChecked, Plus, Refresh } from '@/fsusui/icons'
import { useRowStateMotion } from '@/composables/useRowStateMotion'
import type { AssetLibraryItemResponse } from '@/api/authoring'

const props = defineProps<{
  assets: AssetLibraryItemResponse[]
  loading: boolean
  statusText: string
  canReindex: boolean
}>()
const ASSET_RENDER_WINDOW = 20
const visibleAssetLimit = ref(ASSET_RENDER_WINDOW)
const assetRowMotion = useRowStateMotion({ visibleLimit: ASSET_RENDER_WINDOW })

defineEmits<{
  (e: 'refresh'): void
  (e: 'reindex'): void
  (e: 'cleanup-orphans'): void
  (e: 'insert', asset: AssetLibraryItemResponse): void
}>()

const visibleAssets = computed(() => props.assets.slice(0, visibleAssetLimit.value))
const hiddenAssetCount = computed(() => Math.max(0, props.assets.length - visibleAssets.value.length))
const orphanCount = computed(() => props.assets.reduce((count, asset) => count + (asset.referenceCount === 0 ? 1 : 0), 0))

watch(() => props.assets, (assets, previousAssets) => {
  visibleAssetLimit.value = ASSET_RENDER_WINDOW
  if (!previousAssets || previousAssets.length === 0) {
    return
  }

  const previousById = new Map(previousAssets.map((asset) => [asset.id, `${asset.url}:${asset.referenceCount}`]))
  const changedIds = assets
    .filter((asset) => previousById.get(asset.id) !== `${asset.url}:${asset.referenceCount}`)
    .slice(0, ASSET_RENDER_WINDOW)
    .map((asset) => asset.id)
  if (changedIds.length > 0) {
    assetRowMotion.markUpdated(changedIds, `资产库已更新：${changedIds.length} 项`)
  }
})
</script>

<style scoped>
.asset-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 0.4rem;
}

.asset-list {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.asset-row {
  display: grid;
  grid-template-columns: 4rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  border: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg-soft);
  padding: 0.6rem;
}

.asset-row--orphan {
  opacity: 0.68;
}

.asset-row__thumb {
  aspect-ratio: 1;
  width: 4rem;
  border: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg);
  object-fit: cover;
}

.asset-row__meta {
  min-width: 0;
}

.asset-row__url,
.asset-row__sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-row__url {
  color: var(--fsusblog-text-primary);
  font-size: 0.8125rem;
  font-weight: 600;
}

.asset-row__sub,
.asset-empty {
  color: var(--fsusblog-text-tertiary);
  font-size: 0.75rem;
}

.asset-empty {
  margin: 0;
}

.asset-motion-summary {
  border: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg-soft);
  padding: 0.55rem 0.7rem;
  color: var(--fsusblog-text-muted);
  font-size: 0.75rem;
  font-weight: 600;
}

.asset-row__insert {
  display: grid;
}

@media (max-width: 640px) {
  .asset-row {
    grid-template-columns: 3.5rem minmax(0, 1fr);
  }

  .asset-row__insert {
    grid-column: 1 / -1;
  }
}
</style>
