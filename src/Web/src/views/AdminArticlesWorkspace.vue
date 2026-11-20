<script setup lang="ts">
import { computed, reactive, ref, shallowRef } from 'vue'
import { ElTabs, ElTabPane } from '@ozwasyd/element-plus'
import { t } from '../siteLocale'
import AdminArticleInventory from './AdminArticleInventory.vue'
import AdminTaxonomy from './AdminTaxonomy.vue'
import AdminArticleRollback from './AdminArticleRollback.vue'

export type AdminArticleTaxonomyFilter = Readonly<{
  kind: 'category' | 'tag'
  id: number
  name: string
}>

defineProps<{ sessionSignal: AbortSignal; canRollback?: boolean }>()
const emit = defineEmits<{ 'session-lost': [cause: unknown] }>()
const selected = ref<string | number>('articles')
const keyword = ref('')
const taxonomyFilter = shallowRef<AdminArticleTaxonomyFilter>()
const working = reactive({ articles: false, trash: false, recovery: false })
const locked = computed(() => Object.values(working).some(Boolean))
const mayLeave = () => !locked.value

function openArticlesByTaxonomy(filter: AdminArticleTaxonomyFilter) {
  taxonomyFilter.value = filter
  selected.value = 'articles'
}
</script>

<template>
  <ElTabs v-model="selected" class="admin-article-tabs" :before-leave="mayLeave">
    <ElTabPane name="articles" :label="t('admin.articles.articles')" lazy>
      <AdminArticleInventory
        v-model:keyword="keyword"
        :taxonomy-filter="taxonomyFilter"
        :session-signal="sessionSignal"
        :active="selected === 'articles'"
        @clear-taxonomy-filter="taxonomyFilter = undefined"
        @busy="working.articles = $event"
        @session-lost="emit('session-lost', $event)"
      />
    </ElTabPane>
    <ElTabPane name="trash" :label="t('admin.articles.trash')" lazy>
      <AdminArticleInventory v-model:keyword="keyword" trash :session-signal="sessionSignal" :active="selected === 'trash'"
        @busy="working.trash = $event" @session-lost="emit('session-lost', $event)" />
    </ElTabPane>
    <ElTabPane name="categories" :label="t('admin.articles.categories')" lazy>
      <AdminTaxonomy
        initial-kind="categories"
        :active="selected === 'categories'"
        @view-articles="openArticlesByTaxonomy"
        @session-lost="emit('session-lost', $event)"
      />
    </ElTabPane>
    <ElTabPane name="tags" :label="t('admin.articles.tags')" lazy>
      <AdminTaxonomy
        initial-kind="tags"
        :active="selected === 'tags'"
        @view-articles="openArticlesByTaxonomy"
        @session-lost="emit('session-lost', $event)"
      />
    </ElTabPane>
    <ElTabPane v-if="canRollback !== false" name="recovery" :label="t('admin.articles.recovery')" lazy>
      <AdminArticleRollback :session-signal="sessionSignal" @busy="working.recovery = $event"
        @session-lost="emit('session-lost', $event)" />
    </ElTabPane>
  </ElTabs>
</template>

<style scoped>
.admin-article-tabs { min-width: 0; }
.admin-article-tabs :deep(.el-tabs__content) { min-width: 0; overflow: visible; }
.admin-article-tabs :deep(.el-tab-pane) { min-width: 0; }
</style>
