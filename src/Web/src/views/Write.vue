<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import {
  ElAlert, ElButton, ElDialog, ElDropdown, ElDropdownItem, ElDropdownMenu,
  ElInput, ElSettingsSection, ElTag,
} from '@ozwasyd/element-plus'
import { t } from '../siteLocale'
import ArticleTaxonomy from './ArticleTaxonomy.vue'
import ArticleProperties from './ArticleProperties.vue'
import WorkspaceTabs from '../authoring/WorkspaceTabs.vue'
import WorkspaceSourcePane from '../authoring/WorkspaceSourcePane.vue'
import ArticleLibraryRail from '../authoring/ArticleLibraryRail.vue'
import ArticleQuickSwitcher from '../authoring/ArticleQuickSwitcher.vue'
import EditorInspector from '../authoring/EditorInspector.vue'
import AuthorPluginPreview from '../authoring/AuthorPluginPreview.vue'
import RevisionHistory from '../authoring/RevisionHistory.vue'
import ArticleSchedule from '../authoring/ArticleSchedule.vue'
import ArticleRights from '../authoring/ArticleRights.vue'
import ArticleSummary from '../authoring/ArticleSummary.vue'
import ArticleMedia from '../authoring/ArticleMedia.vue'
import MarkdownExportControl from '../authoring/MarkdownExportControl.vue'
import DocumentExportTasks from '../authoring/DocumentExportTasks.vue'
import DraftMarkdownImport from '../authoring/DraftMarkdownImport.vue'
import { useWorkspaceSplitLayout } from '../authoring/useWorkspaceSplitLayout'
import { useWriteWorkspace } from '../authoring/useWriteWorkspace'
import type { RecentlyClosed, WorkspaceGroup } from '../authoring/workspaceRegistry'

const router = useRouter()
const summaryEditor = shallowRef<InstanceType<typeof ArticleSummary>>()
const taxonomyEditor = shallowRef<InstanceType<typeof ArticleTaxonomy>>()
const libraryRail = ref<InstanceType<typeof ArticleLibraryRail>>()
const quickSwitcher = ref<InstanceType<typeof ArticleQuickSwitcher>>()
const leftDock = ref<HTMLElement>()
const rightDock = ref<HTMLElement>()
const outlineLauncherSlot = ref<HTMLElement>()
const moreTrigger = ref<ComponentPublicInstance & { ref?: HTMLButtonElement }>()
const dialogArticleInput = ref<InstanceType<typeof ElInput>>()
const workspaceDialogOpen = ref(false)
let workspaceDialogFocus: (() => void) | undefined
const explicitTabStrip = ref(false)
const compactViewport = ref(false)
const paneRefs = new Map<number, InstanceType<typeof WorkspaceSourcePane>>()

let viewportMedia: MediaQueryList | undefined
function syncViewport() {
  compactViewport.value = viewportMedia?.matches ?? false
}
onMounted(() => {
  viewportMedia = window.matchMedia('(max-width: 1023px)')
  syncViewport()
  viewportMedia.addEventListener('change', syncViewport)
})
onBeforeUnmount(() => {
  viewportMedia?.removeEventListener('change', syncViewport)
})

const {
  route,
  id,
  tabsControl,
  articleInput,
  reload,
  currentSession,
  identityEpoch,
  credentialEpoch,
  workspaceState,
  original,
  tab,
  workspaceTabs,
  workspaceRevision,
  sourcePanes,
  hasSecondaryGroup,
  recentlyClosed,
  inspectorOpen,
  persistentWorkspace,
  authorizationReady,
  loading,
  opening,
  closingTabs,
  recovery,
  recoveryItems,
  recoveryFailure,
  recoveryChecking,
  recoveryWorking,
  recoveryBlocked,
  notice,
  failure,
  navigationNotice,
  groupNotice,
  layoutNotice,
  supportsSavedGroups,
  recentOpensVersion,
  recentOpensNotice,
  openInput,
  openAddress,
  inputArticle,
  selectedPanelTitle,
  articleDirty,
  summaryDirty,
  metadataDirty,
  dirty,
  hasConflict,
  articlePending,
  pending,
  canSwitch,
  retry,
  validBody,
  editable,
  cannotWrite,
  credential,
  publishedPath,
  canImportDraft,
  canPreviewPlugin,
  canChangeSummary,
  canArrangeGroups,
  otherGroup,
  activeGroupTabs,
  activeGroupIndex,
  canCloseGroupTabs,
  canPublishImages,
  revisionComparisonActive,
  taxonomyModalActive,
  sourceInspectorPending,
  sourceSeek,
  historicalSeek,
  propertySeek,
  summarySeek,
  finishSourceSeek,
  finishHistoricalSeek,
  closeHistoricalSeek,
  finishPropertySeek,
  recheckComparison,
  focusSource,
  focusGroup,
  reopenRecent,
  activateQuickResult,
  focusQuickResult,
  quickResultHref,
  openArticle,
  openSavedWorkspace,
  navigateTo,
  paneFocused,
  changeComposition,
  canMoveBackgroundTab,
  moveBackgroundTab,
  arrangeGroups,
  setInspectorOpen,
  togglePin,
  closeGroupTabs,
  closeTab,
  edit,
  loadImportedDraft,
  restoreDraft,
  submit,
  publishSelectedImages,
  saveSummary,
  reloadDraft,
  setTaxonomyDirty,
  setSummaryDirty,
  markTaxonomyStale,
  setPropertyPending,
  setRevisionComparisonActive,
  setTaxonomyModalActive,
} = useWriteWorkspace()

const {
  editorArea,
  splitter,
  selectedPanes,
  twoSources,
  minimumShare,
  primaryWidth,
  showComparison,
  splitColumns,
  primaryPane,
  resizePrimary,
  startResize,
  dragResize,
  endResize,
  keyboardResize,
} = useWorkspaceSplitLayout({
  sourcePanes,
  activeTab: tab,
  editable,
  credential,
  identityEpoch,
  recheckComparison,
  focusSource,
})

function setPaneRef(sessionId: number, instance: unknown) {
  if (instance) paneRefs.set(sessionId, instance as InstanceType<typeof WorkspaceSourcePane>)
  else paneRefs.delete(sessionId)
}

const activePaneRef = computed(() => tab.value ? paneRefs.get(tab.value.sessionId) : undefined)
const canOpenOutlineFromMenu = computed(() => {
  const pane = activePaneRef.value
  return Boolean(editable.value && pane?.hasNativeMarkdown && !pane.outlineDisabled)
})

function moreButtonElement(): HTMLElement | null {
  if (moreTrigger.value?.ref instanceof HTMLElement) return moreTrigger.value.ref
  if (moreTrigger.value?.$el instanceof HTMLElement) return moreTrigger.value.$el
  return null
}

function onLibraryVisibility(open: boolean) {
  if (!open) return
  for (const pane of paneRefs.values()) pane.closeOutline(false)
}

function onOutlineVisibility(open: boolean) {
  if (!open) return
  libraryRail.value?.close(false)
}

const pageHeading = computed(() => id.value === undefined
  ? t('author.write.articleWorkspace')
  : id.value === 0 ? t('author.write.newArticle') : t('author.write.editArticle'))

const statusTagType = computed<'danger' | 'warning' | 'success' | 'info'>(() => {
  if (hasConflict.value) return 'danger'
  if (articleDirty.value) return 'warning'
  if (original.value?.published) return 'success'
  return 'info'
})

const statusLabel = computed(() => {
  if (hasConflict.value) return t('author.write.saveConflict')
  if (articleDirty.value) return t('author.write.unsaved')
  if (original.value?.published) return t('author.write.published')
  return t('author.write.draft')
})

const showTabStrip = computed(() => Boolean(
  authorizationReady.value && currentSession.value?.canAuthor && (
    workspaceTabs.value.length >= 2
    || hasSecondaryGroup.value
    || (persistentWorkspace.value && workspaceTabs.value.length >= 1)
    || (explicitTabStrip.value && workspaceTabs.value.length >= 1)
  )
))

const hasWorkspaceNotices = computed(() => Boolean(
  opening.value
  || groupNotice.value
  || navigationNotice.value
  || layoutNotice.value
  || (hasSecondaryGroup.value && persistentWorkspace.value && !supportsSavedGroups.value)
  || recentOpensNotice.value
))

const activeTabTitle = computed(() => tab.value?.title.trim() || t('author.workspaceTabs.untitled.article'))
const cannotPinActiveTab = computed(() => {
  const current = tab.value
  if (!current) return true
  return !canSwitch.value || current.risk === 'blocked'
    || (current.mode === 'pinned' && (current.articleId === 0 || current.risk !== 'clean'))
})

watch(identityEpoch, () => {
  workspaceDialogFocus = undefined
  workspaceDialogOpen.value = false
  explicitTabStrip.value = false
})
watch(() => workspaceTabs.value.length, count => {
  if (count === 0) explicitTabStrip.value = false
})

function togglePinFromDialog() {
  const current = tab.value
  if (!current) return
  if (current.mode !== 'pinned') explicitTabStrip.value = true
  togglePin(current)
}

function openWorkspaceDialog() {
  workspaceDialogFocus = undefined
  workspaceDialogOpen.value = true
}

function finishWorkspaceDialogClose() {
  const focus = workspaceDialogFocus
  workspaceDialogFocus = undefined
  if (!workspaceDialogOpen.value) focus?.()
}

function focusDialogArticleInput() {
  dialogArticleInput.value?.focus()
}

function submitOpenArticle(splitGroup = false) {
  if (inputArticle.value !== undefined) workspaceDialogOpen.value = false
  openArticle(splitGroup)
}

function runArrangeGroups(destination?: WorkspaceGroup) {
  workspaceDialogFocus = arrangeGroups(destination)
  workspaceDialogOpen.value = false
}

function runEqualizeGroups() {
  resizePrimary(50)
}

async function runCloseGroupTabs(event: MouseEvent, onlyRight: boolean) {
  const beforeCount = workspaceTabs.value.length
  const epoch = identityEpoch.value
  const sessionId = tab.value?.sessionId
  const current = () => epoch === identityEpoch.value && sessionId === tab.value?.sessionId
  await closeGroupTabs(event, onlyRight)
  if (workspaceDialogOpen.value && workspaceTabs.value.length !== beforeCount && current()) {
    workspaceDialogFocus = () => { if (current()) tabsControl.value?.focusActive() }
    workspaceDialogOpen.value = false
  }
}

function runReopenRecent(item: RecentlyClosed, event: MouseEvent) {
  workspaceDialogOpen.value = false
  void reopenRecent(item, event)
}

function runCloseActiveTab() {
  const current = tab.value
  if (!current) return
  workspaceDialogOpen.value = false
  void closeTab(current)
}

function onMoreCommand(command: unknown) {
  switch (command) {
    case 'library':
      void nextTick(() => libraryRail.value?.open())
      break
    case 'outline':
      void nextTick(() => activePaneRef.value?.openOutline())
      break
    case 'quick-switch':
      void nextTick(() => quickSwitcher.value?.show(moreButtonElement()))
      break
    case 'new-draft':
      void router.push({ name: 'write', state: persistentWorkspace.value ? workspaceState : undefined })
      break
    case 'workspace':
      openWorkspaceDialog()
      break
    case 'open-saved-workspace':
      openSavedWorkspace()
      break
    case 'canvases':
      void router.push('/admin/canvas')
      break
    case 'withdraw':
      void submit('retract')
      break
  }
}
</script>

<template>
  <main class="editor-page" tabindex="-1">
    <header class="studio-topbar">
      <div class="studio-topbar__left">
        <RouterLink class="studio-back" to="/admin/articles" :aria-label="t('author.write.back')">
          <span aria-hidden="true">←</span>
          <span class="studio-back__label">{{ t('author.write.back') }}</span>
        </RouterLink>
        <span class="studio-divider studio-desktop-only" aria-hidden="true" />
        <h1 class="studio-heading">{{ pageHeading }}</h1>
        <template v-if="authorizationReady && currentSession?.canAuthor">
          <ArticleLibraryRail
            ref="libraryRail"
            :article-id="tab?.articleId"
            :article-revision="original?.revision"
            :recent-opens-version="recentOpensVersion"
            :disabled="!canSwitch"
            :activate="navigateTo"
            :dock-target="leftDock"
            :fallback-opener="moreButtonElement"
            @visibility="onLibraryVisibility"
          />
          <span v-if="!showComparison" ref="outlineLauncherSlot" class="studio-topbar__slot" />
          <ArticleQuickSwitcher
            ref="quickSwitcher"
            :disabled="!canSwitch || revisionComparisonActive"
            :other-group="otherGroup"
            :activate="activateQuickResult"
            :article-href="quickResultHref"
            :hide-launcher="compactViewport"
            quiet-launcher
            @activated="focusQuickResult"
          />
        </template>
        <ElTag v-if="editable && id !== undefined && !compactViewport" size="small" :type="statusTagType">{{ statusLabel }}</ElTag>
      </div>
      <div class="studio-topbar__right">
        <template v-if="editable && id !== undefined">
          <span v-if="retry" class="studio-action-slot">
            <ElButton type="primary" size="small" :disabled="closingTabs || pending" @click="submit(retry)">{{ t('author.write.tryAgain') }}</ElButton>
          </span>
          <span v-else class="studio-action-slot">
            <ElButton native-type="button" size="small" :disabled="cannotWrite || !articleDirty" @click="submit('save')">{{ t('author.write.saveDraft') }}</ElButton>
          </span>
          <span v-if="!retry" class="studio-action-slot">
            <ElButton
              native-type="button" size="small" :type="original?.published ? 'default' : 'primary'"
              :disabled="cannotWrite || dirty || id === 0 || !original?.body.trim()"
              @click="submit('publish')"
            >
              {{ original?.published ? t('author.write.publishRevision') : t('author.write.publishArticle') }}
            </ElButton>
          </span>
          <span v-if="original && original.id > 0" class="studio-action-slot">
            <EditorInspector
              v-slot="{ ready: inspectorReady }"
              :pane-target="rightDock"
              :nested-modal-active="revisionComparisonActive || taxonomyModalActive"
              :opened="persistentWorkspace ? !sourceInspectorPending && inspectorOpen : undefined"
              @update:opened="setInspectorOpen"
            >
            <ArticleTaxonomy ref="taxonomyEditor"
              :article-id="original.id"
              :revision="original.revision"
              :identity="identityEpoch"
              :disabled="articleDirty || summaryDirty || pending || recoveryBlocked || !!retry || hasConflict"
              @change="setTaxonomyDirty"
              @save="submit('assign-taxonomy', $event)"
              @stale="markTaxonomyStale"
              @modal-change="setTaxonomyModalActive"
            />
            <ArticleSummary ref="summaryEditor" :article-id="original.id" :revision="original.revision" :credential="credential"
              :can-change="canChangeSummary" :saving="articlePending && summaryDirty"
              :source-target="summarySeek" :inspector-ready="inspectorReady" @source-revealed="finishSourceSeek"
              @change="setSummaryDirty" @save="saveSummary" />
            <ArticleProperties
              :article-id="original.id"
              :revision="original.revision"
              :identity="identityEpoch"
              :disabled="articleDirty || metadataDirty || articlePending || recoveryBlocked || !!retry || hasConflict"
              :source-target="propertySeek" :inspector-ready="inspectorReady && !recoveryBlocked"
              @pending="setPropertyPending" @source-revealed="finishPropertySeek"
            />
            <ArticleMedia :article-id="original.id" :revision="original.revision"
              :credential="credential" :can-publish="canPublishImages"
              :can-change="!!currentSession?.siteSessionId && !dirty && !pending && !recoveryBlocked && !retry && !hasConflict"
              @save="submit('save-attachment', undefined, undefined, undefined, undefined, $event)" @publish-images="publishSelectedImages" />
            <ArticleSchedule
              :key="`schedule-${identityEpoch}`"
              :article-id="original.id"
              :revision="original.revision"
              :can-change="editable && !dirty && !pending && !recoveryBlocked && !retry && !hasConflict"
              @schedule="submit('schedule-publication', undefined, undefined, $event)"
            />
            <ArticleRights
              :key="`rights-${identityEpoch}`"
              :article-id="original.id"
              :revision="original.revision"
              :can-change="editable && !dirty && !pending && !recoveryBlocked && !retry && !hasConflict"
              @save="submit('save-rights', undefined, undefined, undefined, $event)"
            />
            <RevisionHistory
              :key="identityEpoch"
              :article-id="original.id"
              :revision="original.revision"
              :historical-seek="historicalSeek" :inspector-ready="inspectorReady && !recoveryBlocked"
              :editor-draft="editable && !pending && !hasConflict && !recoveryBlocked ? original : undefined"
              :editor-summary="summaryEditor?.comparisonSummary"
              :editor-taxonomy="taxonomyEditor?.comparisonTaxonomy"
              :can-rollback="editable && !dirty && !pending && !recoveryBlocked && !retry && !hasConflict"
              @restore="submit('rollback-history', undefined, $event)"
              @comparison-modal="setRevisionComparisonActive"
              @historical-revealed="finishHistoricalSeek" @historical-closed="closeHistoricalSeek"
            />
            <ElSettingsSection density="compact" title-tag="h3" :title="t('author.editorInspector.export')">
              <div class="inspector-export-grid">
                <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
                  size="small" block :disabled="pending || hasConflict" />
                <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
                  size="small" block :disabled="pending || hasConflict" format="docx" />
                <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
                  size="small" block :disabled="pending || hasConflict" format="html" />
                <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
                  size="small" block :disabled="pending || hasConflict" format="epub" />
                <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
                  size="small" block :disabled="pending || hasConflict" format="pdf" />
              </div>
              <DocumentExportTasks :article="original.id" :revision="original.revision" :selected="original.revision"
                :active="inspectorReady && !revisionComparisonActive" :disabled="pending || hasConflict" />
              <AuthorPluginPreview :article="original.id" :revision="original.revision"
                :active="inspectorReady && !revisionComparisonActive" :disabled="!canPreviewPlugin" />
            </ElSettingsSection>
            </EditorInspector>
          </span>
        </template>
        <ElDropdown
          v-if="authorizationReady && currentSession?.canAuthor"
          trigger="click"
          placement="bottom-end"
          @command="onMoreCommand"
        >
          <ElButton
            ref="moreTrigger"
            class="studio-more-trigger"
            text
            size="small"
            native-type="button"
            v-bind="{ 'aria-label': t('author.write.moreActions') }"
          >···</ElButton>
          <template #dropdown>
            <ElDropdownMenu>
              <template v-if="compactViewport">
                <ElDropdownItem command="library" :disabled="!canSwitch">{{ t('author.articleLibraryRail.article.library') }}</ElDropdownItem>
                <ElDropdownItem v-if="editable" command="outline" :disabled="!canOpenOutlineFromMenu">{{ t('author.articleOutlineRail.outline') }}</ElDropdownItem>
                <ElDropdownItem command="quick-switch" :disabled="!canSwitch || revisionComparisonActive">{{ t('author.articleQuickSwitcher.quick.switch.articles') }}</ElDropdownItem>
              </template>
              <ElDropdownItem command="new-draft" :divided="compactViewport">{{ t('author.write.newDraft') }}</ElDropdownItem>
              <ElDropdownItem command="workspace" :disabled="!canSwitch">{{ t('author.write.workspaceTools') }}</ElDropdownItem>
              <ElDropdownItem v-if="!persistentWorkspace && id !== undefined" command="open-saved-workspace" :disabled="!canSwitch">{{ t('author.write.openSavedWorkspace') }}</ElDropdownItem>
              <ElDropdownItem command="canvases">{{ t('author.write.canvases') }}</ElDropdownItem>
              <ElDropdownItem v-if="editable && original?.published && !retry" command="withdraw" divided :disabled="cannotWrite || dirty">{{ t('author.write.withdraw') }}</ElDropdownItem>
            </ElDropdownMenu>
          </template>
        </ElDropdown>
      </div>
    </header>

    <div v-if="showTabStrip || hasWorkspaceNotices" class="studio-subbar">
      <div v-if="showTabStrip" class="studio-tabs" :aria-label="t('author.write.articleWorkspace')">
        <WorkspaceTabs ref="tabsControl" :tabs="workspaceTabs" :disabled="!canSwitch" :workspace-revision="workspaceRevision"
          :can-move-background="canMoveBackgroundTab"
          @activate="navigateTo($event.articleId)" @pin="togglePin" @close="closeTab" @move="moveBackgroundTab" />
        <div v-if="twoSources && !showComparison" class="studio-tabs__groups" role="group" :aria-label="t('author.write.articleGroups')">
          <ElButton v-for="pane in selectedPanes" :key="pane.tab.sessionId" text size="small" native-type="button"
            :disabled="!canSwitch || pane.tab.active" @click="focusGroup(pane.tab)">
            {{ pane.tab.group === 'main' ? t('author.write.focusPrimaryGroup') : t('author.write.focusSecondaryGroup') }}
          </ElButton>
        </div>
        <ElButton v-if="tab && (hasSecondaryGroup || activeGroupTabs.length > 1)" text size="small" native-type="button"
          @click="openWorkspaceDialog">
          {{ hasSecondaryGroup ? t('author.write.groupActions') : t('author.write.tabActions') }}
        </ElButton>
      </div>
      <div v-if="hasWorkspaceNotices" class="studio-notices">
        <p v-if="opening" role="status">{{ t('author.write.openingArticle') }}</p>
        <p v-if="groupNotice" role="status">{{ groupNotice }}</p>
        <p v-if="navigationNotice" role="alert">{{ navigationNotice }}</p>
        <p v-if="layoutNotice" role="status">{{ layoutNotice }}</p>
        <p v-if="hasSecondaryGroup && persistentWorkspace && !supportsSavedGroups" role="status">{{ t('author.write.theSecondGroupStaysOpenInThisBrowser') }}</p>
        <p v-if="recentOpensNotice" role="status">{{ recentOpensNotice }}</p>
      </div>
    </div>

    <div class="studio-body">
      <div ref="leftDock" class="studio-dock studio-dock--left" />
      <div class="studio-canvas">
        <div v-if="!authorizationReady || loading" class="studio-state">
          <p role="status">{{ t('author.write.openingTheEditor') }}</p>
        </div>
        <div v-else-if="!currentSession?.canAuthor" class="studio-state">
          <ElAlert :title="failure || t('author.write.logInWithAnAuthorAccountToWrite')" type="info" :closable="false" />
          <p><RouterLink :to="{ name: 'login', query: { redirect: route.fullPath } }">{{ t('author.write.logIn') }}</RouterLink></p>
        </div>
        <section v-else-if="id === undefined" class="studio-empty" :aria-label="t('author.write.articleWorkspace')">
          <p class="studio-empty__prompt" role="status">{{ t('author.write.openAnArticleOrStartANewDraft') }}</p>
          <div class="studio-empty__actions">
            <span class="studio-action-slot">
              <ElButton type="primary" size="small" native-type="button" @click="router.push({ name: 'write', state: persistentWorkspace ? workspaceState : undefined })">{{ t('author.write.newDraft') }}</ElButton>
            </span>
            <span class="studio-action-slot">
              <ElButton size="small" native-type="button" :disabled="!canSwitch" @click="quickSwitcher?.show()">{{ t('author.articleQuickSwitcher.quick.switch.articles') }}</ElButton>
            </span>
            <span class="studio-action-slot">
              <ElButton size="small" native-type="button" :disabled="!canSwitch" @click="libraryRail?.open()">{{ t('author.articleLibraryRail.article.library') }}</ElButton>
            </span>
          </div>
          <form class="workspace-open studio-empty__form" @submit.prevent="openArticle()">
            <label for="workspace-article-id">{{ t('author.write.articleId') }}</label>
            <ElInput id="workspace-article-id" ref="articleInput" v-model="openInput" class="workspace-open-field" :disabled="!canSwitch" />
            <div class="workspace-open__actions">
              <ElButton native-type="submit" size="small" :disabled="!canSwitch">{{ t('author.write.openArticle') }}</ElButton>
              <RouterLink v-if="openAddress" class="workspace-open__link" :to="openAddress" target="_blank" rel="noopener">{{ t('author.write.openInBrowserTab') }}</RouterLink>
            </div>
          </form>
          <section v-if="recentlyClosed.length" class="studio-empty__recent">
            <h2>{{ t('author.write.recentlyClosed') }}</h2>
            <ul class="workspace-recent-list">
              <li v-for="item in recentlyClosed" :key="item.articleId">
                <ElButton text size="small" native-type="button" :disabled="!canSwitch" @click="reopenRecent(item, $event)">
                  {{ t('author.write.reopenTitle', { title: item.title }) }}
                </ElButton>
              </li>
            </ul>
          </section>
        </section>
        <div v-else-if="!editable" class="studio-state">
          <ElAlert :title="failure" type="error" :closable="false" />
          <ElButton class="retry" @click="reload++">{{ t('author.write.retry') }}</ElButton>
        </div>
        <section
          v-if="authorizationReady && currentSession?.canAuthor && sourcePanes.length"
          v-show="editable"
          id="workspace-editor"
          class="editor-document"
          role="tabpanel"
          :aria-label="selectedPanelTitle"
        >
          <div ref="editorArea" class="editor-source" :class="{ 'editor-source--split': showComparison }"
            :style="{ gridTemplateColumns: splitColumns }">
            <WorkspaceSourcePane
              v-for="pane in sourcePanes"
              :key="pane.tab.sessionId"
              :ref="instance => setPaneRef(pane.tab.sessionId, instance)"
              :pane="pane"
              :focus="paneFocused(pane)"
              :concealed="!pane.selected || (!pane.tab.active && !showComparison)"
              :blocked="closingTabs || pending || metadataDirty || recoveryBlocked"
              :split="hasSecondaryGroup"
              :can-switch="canSwitch"
              :source-target="!summarySeek && sourceSeek?.sessionId === pane.tab.sessionId ? sourceSeek : undefined"
              :outline-launcher-target="outlineLauncherSlot"
              :outline-dock-target="leftDock"
              :outline-fallback-opener="moreButtonElement"
              @source-revealed="finishSourceSeek"
              @outline-visibility="onOutlineVisibility"
              @edit="(field, value, edits) => edit(pane, field, value, edits)"
              @activate="focusGroup(pane.tab)"
              @compose="changeComposition(pane, $event)"
            >
              <template #before>
                <template v-if="paneFocused(pane)">
                  <p v-if="notice" class="write-notice" role="status">
                    {{ notice }} <a v-if="publishedPath" :href="publishedPath" target="_blank" rel="noopener">{{ t('author.write.readThePublishedArticle') }}</a>
                  </p>
                  <ElAlert v-if="failure" :title="failure" type="error" :closable="false" show-icon />
                  <ElButton v-if="hasConflict" class="retry" size="small" @click="reloadDraft">{{ t('author.write.loadLatestRevision') }}</ElButton>
                  <p v-if="recoveryChecking" role="status">{{ t('author.write.checkingLocalDraftRecovery') }}</p>
                </template>
              </template>
              <template #import>
                <DraftMarkdownImport v-if="paneFocused(pane) && canImportDraft" :key="credentialEpoch"
                  @load="loadImportedDraft(pane, $event)" />
              </template>
              <template #after>
                <template v-if="paneFocused(pane)">
                  <p v-if="recoveryFailure" role="status">{{ t('author.write.localDraftRecoveryIsUnavailableSaveToKeep') }}</p>
                  <section v-if="recoveryItems.length" class="studio-recovery" aria-labelledby="draft-recovery-title">
                    <h2 id="draft-recovery-title">{{ t('author.write.recoverAnUnsavedDraft') }}</h2>
                    <p>{{ t('author.write.unsavedTextIsStoredInThisBrowserFor') }}</p>
                    <div v-for="item in recoveryItems" :key="`${item.writer}-${item.editSequence}`" class="studio-recovery__item">
                      <h3>{{ item.title || t('author.write.untitledDraft') }}</h3>
                      <p v-if="item.relationship === 'compare'">{{ t('author.write.thisRecoveryCopyAndTheServerDraftHave') }}</p>
                      <details>
                        <summary>{{ t('author.write.compareDrafts') }}</summary>
                        <h4>{{ t('author.write.serverDraft') }}</h4><pre>{{ original?.body }}</pre>
                        <h4>{{ t('author.write.recoveryCopy') }}</h4><pre>{{ item.body }}</pre>
                      </details>
                      <div class="studio-recovery__actions">
                        <ElButton size="small" type="primary" native-type="button" :disabled="pending || recoveryWorking || articleDirty" @click="restoreDraft(item)">{{ t('author.write.restoreDraft') }}</ElButton>
                        <ElButton size="small" native-type="button" :disabled="pending || recoveryWorking" @click="recovery.remove(item)">{{ t('author.write.discardRecoveryCopy') }}</ElButton>
                      </div>
                    </div>
                  </section>
                  <p v-if="!validBody" role="alert">{{ t('author.write.theArticleExceedsTheSizeLimit') }}</p>
                </template>
              </template>
            </WorkspaceSourcePane>
            <div v-if="showComparison && primaryPane" ref="splitter" class="workspace-splitter" role="separator" tabindex="0"
              :aria-label="t('author.write.resizeArticleGroups')" aria-orientation="vertical" :aria-controls="`workspace-source-${primaryPane.sessionId}`"
              :aria-valuemin="minimumShare" :aria-valuemax="100 - minimumShare" :aria-valuenow="primaryWidth"
              :aria-valuetext="t('author.write.primaryWidth', { width: primaryWidth })"
              @pointerdown="startResize" @pointermove="dragResize" @pointerup="endResize" @pointercancel="endResize"
              @lostpointercapture="endResize" @keydown="keyboardResize" />
          </div>
        </section>
      </div>
      <div ref="rightDock" class="studio-dock studio-dock--right" />
    </div>

    <ElDialog
      v-if="authorizationReady && currentSession?.canAuthor"
      v-model="workspaceDialogOpen"
      :title="t('author.write.workspaceToolsTitle')"
      append-to-body
      destroy-on-close
      width="min(34rem, calc(100vw - 2rem))"
      @opened="focusDialogArticleInput"
      @closed="finishWorkspaceDialogClose"
    >
      <div class="workspace-dialog">
        <ElSettingsSection density="compact" title-tag="h3" :title="t('author.write.openArticle')">
          <form class="workspace-open" @submit.prevent="submitOpenArticle(false)">
            <label :for="id === undefined ? 'workspace-dialog-article-id' : 'workspace-article-id'">{{ t('author.write.articleId') }}</label>
            <ElInput
              :id="id === undefined ? 'workspace-dialog-article-id' : 'workspace-article-id'"
              ref="dialogArticleInput"
              v-model="openInput"
              class="workspace-open-field"
              :disabled="!canSwitch"
            />
            <div class="workspace-open__actions">
              <ElButton native-type="submit" type="primary" size="small" :disabled="!canSwitch">{{ t('author.write.openArticle') }}</ElButton>
              <ElButton v-if="tab" native-type="button" size="small" :disabled="!canSwitch || inputArticle === undefined"
                @click="submitOpenArticle(true)">{{ t('author.write.openInOtherGroup') }}</ElButton>
              <RouterLink v-if="openAddress" class="workspace-open__link" :to="openAddress" target="_blank" rel="noopener">{{ t('author.write.openInBrowserTab') }}</RouterLink>
            </div>
          </form>
          <p v-if="navigationNotice" class="workspace-dialog__notice" role="alert">{{ navigationNotice }}</p>
        </ElSettingsSection>

        <ElSettingsSection
          v-if="tab"
          density="compact"
          title-tag="h3"
          :title="hasSecondaryGroup ? t('author.write.groupActions') : activeGroupTabs.length > 1 ? t('author.write.tabActions') : t('author.write.currentArticle')"
        >
          <div class="workspace-dialog__actions">
            <template v-if="workspaceTabs.length === 1 && tab.risk !== 'blocked'">
              <ElButton
                size="small"
                native-type="button"
                v-bind="{
                  'aria-label': t('author.workspaceTabs.pin.action', { action: tab.mode === 'pinned' ? t('author.workspaceTabs.unpin') : t('author.workspaceTabs.pin'), title: activeTabTitle }),
                  'aria-pressed': tab.mode === 'pinned',
                }"
                :disabled="cannotPinActiveTab"
                @click="togglePinFromDialog"
              >
                {{ tab.mode === 'pinned' ? t('author.workspaceTabs.unpin') : t('author.workspaceTabs.pin') }}
              </ElButton>
              <ElButton
                size="small"
                native-type="button"
                v-bind="{ 'aria-label': t('author.workspaceTabs.close.article', { title: activeTabTitle }) }"
                :disabled="!canSwitch"
                @click="runCloseActiveTab"
              >
                {{ t('author.workspaceTabs.close') }}
              </ElButton>
            </template>
            <template v-if="hasSecondaryGroup">
              <ElButton size="small" native-type="button" :disabled="!canArrangeGroups || tab.group === 'main'"
                @click="runArrangeGroups('main')">{{ t('author.write.moveToPrimaryGroup') }}</ElButton>
              <ElButton size="small" native-type="button" :disabled="!canArrangeGroups || tab.group === 'secondary'"
                @click="runArrangeGroups('secondary')">{{ t('author.write.moveToSecondaryGroup') }}</ElButton>
              <ElButton size="small" native-type="button" :disabled="!canArrangeGroups" @click="runArrangeGroups()">{{ t('author.write.mergeGroups') }}</ElButton>
              <ElButton v-if="showComparison" size="small" native-type="button" @click="runEqualizeGroups">{{ t('author.write.equalizeGroupWidths') }}</ElButton>
            </template>
            <template v-if="activeGroupTabs.length > 1">
              <ElButton size="small" native-type="button" :disabled="!canCloseGroupTabs"
                @click="runCloseGroupTabs($event, false)">{{ t('author.write.closeOtherTabs') }}</ElButton>
              <ElButton size="small" native-type="button" :disabled="!canCloseGroupTabs || activeGroupIndex === activeGroupTabs.length - 1"
                @click="runCloseGroupTabs($event, true)">{{ t('author.write.closeTabsToTheRight') }}</ElButton>
            </template>
            <ElButton v-if="!persistentWorkspace && id !== undefined" text size="small" native-type="button" :disabled="!canSwitch"
              @click="workspaceDialogOpen = false; openSavedWorkspace()">{{ t('author.write.openSavedWorkspace') }}</ElButton>
          </div>
        </ElSettingsSection>

        <ElSettingsSection v-if="recentlyClosed.length" density="compact" title-tag="h3" :title="t('author.write.recentlyClosed')">
          <ul class="workspace-recent-list">
            <li v-for="item in recentlyClosed" :key="item.articleId">
              <ElButton text size="small" native-type="button" :disabled="!canSwitch" @click="runReopenRecent(item, $event)">
                {{ t('author.write.reopenTitle', { title: item.title }) }}
              </ElButton>
            </li>
          </ul>
        </ElSettingsSection>
      </div>
    </ElDialog>
  </main>
</template>

<style scoped>
.editor-page {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  inline-size: 100%;
  block-size: 100dvh;
  overflow: clip;
  background: var(--fsus-page);
}
.editor-page:not(:has(> .studio-subbar)) {
  grid-template-rows: auto minmax(0, 1fr);
}

.studio-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--fsus-space-3);
  min-block-size: 3.25rem;
  padding-inline: var(--fsus-space-4);
  border-block-end: 1px solid var(--fsus-border);
  background: var(--fsus-paper);
}
.studio-topbar__left,
.studio-topbar__right {
  display: flex;
  align-items: center;
  gap: var(--fsus-space-2);
  min-inline-size: 0;
}
.studio-topbar__right {
  flex: 0 0 auto;
}
.studio-action-slot {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
}
.studio-topbar__slot {
  display: contents;
}
.studio-back {
  display: inline-flex;
  align-items: center;
  gap: var(--fsus-space-1);
  min-block-size: 2rem;
  padding-inline: var(--fsus-space-2);
  border-radius: var(--fsus-radius-control);
  color: var(--fsus-color-text-muted);
  font-size: .875rem;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
}
.studio-back:hover {
  color: var(--fsus-ink);
  background: var(--el-fill-color-light);
}
.studio-divider {
  inline-size: 1px;
  block-size: 1rem;
  background: var(--fsus-border);
  flex: 0 0 auto;
}
.studio-heading {
  margin: 0;
  font-size: .875rem;
  font-weight: 600;
  color: var(--fsus-ink);
  white-space: nowrap;
}
.studio-more-trigger {
  font-weight: 700;
  letter-spacing: .06em;
  min-inline-size: 2rem;
  padding-inline: var(--fsus-space-2);
}

.studio-subbar {
  display: grid;
  border-block-end: 1px solid var(--fsus-border);
  background: var(--fsus-page);
}
.studio-tabs {
  display: flex;
  align-items: center;
  gap: var(--fsus-space-2);
  min-inline-size: 0;
  padding-inline: var(--fsus-space-3);
}
.studio-tabs__groups {
  display: inline-flex;
  align-items: center;
  gap: var(--fsus-space-1);
  flex: 0 0 auto;
}
.studio-notices {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--fsus-space-1) var(--fsus-space-4);
  padding: var(--fsus-space-1) var(--fsus-space-4);
  background: var(--fsus-paper);
  border-block-start: 1px solid var(--fsus-border);
}
.studio-subbar > .studio-notices:first-child {
  border-block-start: 0;
}
.studio-notices p {
  margin: 0;
  font-size: .8125rem;
  color: var(--fsus-color-text-muted);
}
.studio-notices p[role="alert"] {
  color: var(--el-color-danger);
}

.studio-body {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  min-block-size: 0;
  min-inline-size: 0;
  overflow: hidden;
}
.studio-dock {
  display: flex;
  min-block-size: 0;
  overflow: hidden;
}
.studio-dock:empty {
  display: none;
}
.studio-canvas {
  min-block-size: 0;
  min-inline-size: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding-inline: var(--fsusblog-page-gutter);
}

.studio-state,
.studio-empty {
  inline-size: min(36rem, 100%);
  margin-inline: auto;
  padding-block: clamp(2rem, 8vh, 5rem);
  display: grid;
  gap: var(--fsus-space-4);
}
.studio-empty__prompt {
  margin: 0;
  font-size: 1rem;
  color: var(--fsus-color-text-muted);
}
.studio-empty__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fsus-space-2);
}
.studio-empty__form {
  padding-block-start: var(--fsus-space-4);
  border-block-start: 1px solid var(--fsus-border);
}
.studio-empty__recent h2 {
  margin: 0 0 var(--fsus-space-2);
  font-size: var(--fsus-typography-heading-sm-size);
}

.editor-document {
  min-inline-size: 0;
  min-block-size: 100%;
  display: flex;
  flex-direction: column;
}
.editor-source {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  flex: 1 1 auto;
  min-inline-size: 0;
  min-block-size: 100%;
}
.editor-source--split {
  align-items: stretch;
  column-gap: 0;
}
.editor-source--split :deep(.workspace-source__heading) { min-block-size: var(--fsus-control-height-action); }
.editor-source--split > .workspace-source { grid-row: 1; grid-column: 1; }
.editor-source--split > .workspace-source--secondary { grid-column: 3; }

.workspace-splitter {
  position: relative;
  grid-row: 1;
  grid-column: 2;
  align-self: stretch;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}
.workspace-splitter::before {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 50%;
  inline-size: 1px;
  border-inline-start: 1px solid var(--fsus-border);
  content: '';
}
.workspace-splitter:hover::before, .workspace-splitter:focus-visible::before {
  border-inline-start-color: var(--fsus-color-action-primary);
}
.workspace-splitter:focus-visible { outline: 2px solid var(--fsus-color-action-primary); outline-offset: -2px; }

.write-notice {
  margin: 0;
  font-size: .875rem;
  color: var(--fsus-color-text-muted);
}
.studio-recovery {
  display: grid;
  gap: var(--fsus-space-2);
  padding: var(--fsus-space-4);
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-panel);
  background: var(--fsus-paper);
}
.studio-recovery h2,
.studio-recovery h3,
.studio-recovery p {
  margin: 0;
}
.studio-recovery__item {
  display: grid;
  gap: var(--fsus-space-2);
}
.studio-recovery__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fsus-space-2);
}

.workspace-dialog {
  display: grid;
  gap: var(--fsus-space-2);
}
.workspace-dialog > :deep(:first-child) {
  border-block-start: 0;
  padding-block-start: 0;
}
.workspace-open {
  display: grid;
  gap: var(--fsus-space-2);
}
.workspace-open label {
  font-size: .8125rem;
  color: var(--fsus-color-text-muted);
}
.workspace-open-field {
  max-inline-size: min(100%, 16rem);
}
.workspace-open__actions,
.workspace-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--fsus-space-2);
}
.workspace-open__link {
  font-size: .875rem;
  color: var(--fsus-color-action-primary);
  text-decoration: none;
}
.workspace-open__link:hover {
  text-decoration: underline;
}
.workspace-dialog__notice {
  margin: var(--fsus-space-2) 0 0;
  font-size: .8125rem;
  color: var(--el-color-danger);
}
.workspace-recent-list {
  display: grid;
  gap: var(--fsus-space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.inspector-export-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
  gap: var(--fsus-space-2);
  min-inline-size: 0;
}

@media (max-width: 1023px) {
  .studio-topbar {
    gap: var(--fsus-space-1);
    min-block-size: 3rem;
    padding-inline: var(--fsus-space-2);
  }
  .studio-topbar__left {
    flex: 0 0 auto;
    gap: var(--fsus-space-1);
  }
  .studio-topbar__right {
    gap: var(--fsus-space-1);
    max-inline-size: calc(100% - 2.5rem);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .studio-topbar__right::-webkit-scrollbar {
    display: none;
  }
  .studio-desktop-only {
    display: none;
  }
  .studio-heading {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .studio-back {
    min-inline-size: 2.25rem;
    min-block-size: 2.25rem;
    justify-content: center;
    padding-inline: var(--fsus-space-1);
  }
  .studio-back__label {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .studio-tabs {
    padding: var(--fsus-space-2);
    flex-wrap: wrap;
  }
  .studio-body {
    grid-template-columns: minmax(0, 1fr);
  }
  .studio-dock {
    display: none;
  }
  .studio-canvas {
    padding-inline: var(--fsus-space-3);
  }
}
@media (max-width: 360px) {
  .studio-topbar {
    gap: 2px;
    padding-inline: var(--fsus-space-1);
  }
  .studio-topbar__right {
    gap: 2px;
  }
  .studio-back {
    min-inline-size: 1.75rem;
    padding-inline: 2px;
  }
  .studio-more-trigger {
    min-inline-size: 1.75rem;
    padding-inline: var(--fsus-space-1);
  }
}
</style>
