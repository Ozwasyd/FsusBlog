<script setup lang="ts">
import { computed, defineAsyncComponent, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElAlert, ElTabs, ElTabPane } from '@ozwasyd/element-plus'
import { t } from '../siteLocale'
import { currentSession, refreshSession } from '../authorSession'
import { savedViewLink } from '../authoring/savedViewLink'
import AdminArticleInventory from './AdminArticleInventory.vue'
import AdminTaxonomy from './AdminTaxonomy.vue'
import AdminArticleRollback from './AdminArticleRollback.vue'

export type AdminArticleTaxonomyFilter = Readonly<{
  kind: 'category' | 'tag'
  id: number
  name: string
}>

const props = defineProps<{ sessionSignal: AbortSignal; canRollback?: boolean }>()
const emit = defineEmits<{ 'session-lost': [cause: unknown] }>()
const SavedViewPanel = defineAsyncComponent(() => import('../authoring/SavedViewPanel.vue'))
const route = useRoute()
const showSavedView = computed(() => savedViewLink(route.query) !== undefined)
const savedViewAuthorized = ref<boolean>()
const selected = ref<string | number>('articles')
const keyword = ref('')
const taxonomyFilter = shallowRef<AdminArticleTaxonomyFilter>()
const working = reactive({ articles: false, trash: false, recovery: false })
const locked = computed(() => Object.values(working).some(Boolean))
const mayLeave = () => !locked.value

watch(showSavedView, async (show, _, cleanup) => {
  savedViewAuthorized.value = undefined
  if (!show) return
  selected.value = 'articles'
  const request = new AbortController()
  cleanup(() => request.abort())
  const signal = AbortSignal.any([props.sessionSignal, request.signal])
  const authorized = await refreshSession(signal, false).then(() => currentSession.value !== null, () => false)
  if (!signal.aborted) savedViewAuthorized.value = authorized
}, { immediate: true })

function openArticlesByTaxonomy(filter: AdminArticleTaxonomyFilter) {
  taxonomyFilter.value = filter
  selected.value = 'articles'
}
</script>

<template>
  <ElTabs v-model="selected" class="admin-article-tabs" :before-leave="mayLeave">
    <ElTabPane name="articles" :label="t('admin.articles.articles')" lazy>
      <template v-if="showSavedView">
        <p v-if="savedViewAuthorized === undefined" role="status">{{ t('author.savedViewPanel.loading.saved.views') }}</p>
        <SavedViewPanel v-else-if="savedViewAuthorized" />
        <ElAlert v-else type="error" :closable="false" :title="t('author.savedViewPanel.saved.views.are.temporarily.unavailable')" />
      </template>
      <AdminArticleInventory
        v-else
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
    <ElTabPane name="categories" :label="t('admin.taxonomy.m5')" lazy>
      <AdminTaxonomy
        initial-kind="categories"
        :active="selected === 'categories'"
        @view-articles="openArticlesByTaxonomy"
        @session-lost="emit('session-lost', $event)"
      />
    </ElTabPane>
    <ElTabPane name="tags" :label="t('admin.taxonomy.m6')" lazy>
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
