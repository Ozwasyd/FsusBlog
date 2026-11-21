<script setup lang="ts">
import { shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
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

const summaryEditor = shallowRef<InstanceType<typeof ArticleSummary>>()
const taxonomyEditor = shallowRef<InstanceType<typeof ArticleTaxonomy>>()

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
</script>

<template>
  <main class="editor-page" tabindex="-1">
    <header class="editor-header">
      <div>
        <RouterLink class="editor-back" to="/admin/articles">{{ t('author.write.back') }}</RouterLink>
        <RouterLink v-if="currentSession?.canAuthor" class="canvas-entry" to="/admin/canvas">{{ t('author.write.canvases') }}</RouterLink>
        <h1>{{ id === undefined ? t('author.write.articleWorkspace') : id === 0 ? t('author.write.newArticle') : t('author.write.editArticle') }}</h1>
        <span v-if="editable" class="metadata">{{ original?.published ? t('author.write.published') : t('author.write.draft') }}</span>
      </div>
      <div v-if="editable" class="editor-actions">
        <ElButton v-if="retry" type="primary" :disabled="closingTabs || pending" @click="submit(retry)">{{ t('author.write.tryAgain') }}</ElButton>
        <ElButton v-else native-type="button" :disabled="cannotWrite || !articleDirty" @click="submit('save')">{{ t('author.write.saveDraft') }}</ElButton>
        <ElButton
          v-if="!retry" native-type="button" :type="original?.published ? 'default' : 'primary'"
          :disabled="cannotWrite || dirty || id === 0 || !original?.body.trim()"
          @click="submit('publish')"
        >
          {{ original?.published ? t('author.write.publishRevision') : t('author.write.publishArticle') }}
        </ElButton>
        <ElButton v-if="original?.published && !retry" native-type="button" :disabled="cannotWrite || dirty" @click="submit('retract')">{{ t('author.write.withdraw') }}</ElButton>
      </div>
    </header>
    <section v-if="authorizationReady && currentSession?.canAuthor" class="workspace-actions" :aria-label="t('author.write.articleWorkspace')">
      <WorkspaceTabs ref="tabsControl" :tabs="workspaceTabs" :disabled="!canSwitch" :workspace-revision="workspaceRevision"
        :can-move-background="canMoveBackgroundTab"
        @activate="navigateTo($event.articleId)" @pin="togglePin" @close="closeTab" @move="moveBackgroundTab" />
      <form class="workspace-open" @submit.prevent="openArticle()">
        <label for="workspace-article-id">{{ t('author.write.articleId') }}</label>
        <ElInput id="workspace-article-id" ref="articleInput" v-model="openInput" class="workspace-open-field"
          :disabled="!canSwitch" />
        <ElButton native-type="submit" :disabled="!canSwitch">{{ t('author.write.openArticle') }}</ElButton>
        <ElButton v-if="tab" native-type="button" :disabled="!canSwitch || inputArticle === undefined"
          @click="openArticle(true)">{{ t('author.write.openInOtherGroup') }}</ElButton>
        <RouterLink v-if="openAddress" :to="openAddress" target="_blank" rel="noopener">{{ t('author.write.openInBrowserTab') }}</RouterLink>
        <RouterLink :to="{ name: 'write', state: persistentWorkspace ? workspaceState : undefined }">{{ t('author.write.newDraft') }}</RouterLink>
        <ElButton v-if="!persistentWorkspace && id !== undefined" text native-type="button" :disabled="!canSwitch" @click="openSavedWorkspace">{{ t('author.write.openSavedWorkspace') }}</ElButton>
      </form>
      <div v-if="twoSources && !showComparison" class="workspace-groups" role="group" :aria-label="t('author.write.articleGroups')">
        <ElButton v-for="pane in selectedPanes" :key="pane.tab.sessionId" text native-type="button"
          :disabled="!canSwitch || pane.tab.active" @click="focusGroup(pane.tab)">
          {{ pane.tab.group === 'main' ? t('author.write.focusPrimaryGroup') : t('author.write.focusSecondaryGroup') }}
        </ElButton>
      </div>
      <details v-if="tab && (hasSecondaryGroup || activeGroupTabs.length > 1)" class="workspace-group-actions">
        <summary>{{ hasSecondaryGroup ? t('author.write.groupActions') : t('author.write.tabActions') }}</summary>
        <div>
          <template v-if="hasSecondaryGroup">
            <ElButton text native-type="button" :disabled="!canArrangeGroups || tab.group === 'main'"
              @click="arrangeGroups('main')">{{ t('author.write.moveToPrimaryGroup') }}</ElButton>
            <ElButton text native-type="button" :disabled="!canArrangeGroups || tab.group === 'secondary'"
              @click="arrangeGroups('secondary')">{{ t('author.write.moveToSecondaryGroup') }}</ElButton>
            <ElButton text native-type="button" :disabled="!canArrangeGroups" @click="arrangeGroups()">{{ t('author.write.mergeGroups') }}</ElButton>
            <ElButton v-if="showComparison" text native-type="button" @click="resizePrimary(50)">{{ t('author.write.equalizeGroupWidths') }}</ElButton>
          </template>
          <template v-if="activeGroupTabs.length > 1">
            <ElButton text native-type="button" :disabled="!canCloseGroupTabs"
              @click="closeGroupTabs($event, false)">{{ t('author.write.closeOtherTabs') }}</ElButton>
            <ElButton text native-type="button" :disabled="!canCloseGroupTabs || activeGroupIndex === activeGroupTabs.length - 1"
              @click="closeGroupTabs($event, true)">{{ t('author.write.closeTabsToTheRight') }}</ElButton>
          </template>
        </div>
      </details>
      <ArticleQuickSwitcher :disabled="!canSwitch || revisionComparisonActive" :other-group="otherGroup" :activate="activateQuickResult"
        :article-href="quickResultHref" @activated="focusQuickResult" />
      <ArticleLibraryRail :article-id="tab?.articleId" :article-revision="original?.revision" :recent-opens-version="recentOpensVersion"
        :disabled="!canSwitch" :activate="navigateTo" />
      <details v-if="recentlyClosed.length">
        <summary>{{ t('author.write.recentlyClosed') }}</summary>
        <ul>
          <li v-for="item in recentlyClosed" :key="item.articleId">
            <ElButton text native-type="button" :disabled="!canSwitch" @click="reopenRecent(item, $event)">
              {{ t('author.write.reopenTitle', { title: item.title }) }}
            </ElButton>
          </li>
        </ul>
      </details>
      <p v-if="opening" role="status">{{ t('author.write.openingArticle') }}</p>
      <p v-if="groupNotice" role="status">{{ groupNotice }}</p>
      <p v-if="navigationNotice" role="alert">{{ navigationNotice }}</p>
      <p v-if="layoutNotice" role="status">{{ layoutNotice }}</p>
      <p v-if="hasSecondaryGroup && persistentWorkspace && !supportsSavedGroups" role="status">{{ t('author.write.theSecondGroupStaysOpenInThisBrowser') }}</p>
      <p v-if="recentOpensNotice" role="status">{{ recentOpensNotice }}</p>
    </section>
    <p v-if="!authorizationReady || loading" role="status">{{ t('author.write.openingTheEditor') }}</p>
    <template v-else-if="!currentSession?.canAuthor">
      <ElAlert :title="failure || t('author.write.logInWithAnAuthorAccountToWrite')" type="info" :closable="false" />
      <p><RouterLink :to="{ name: 'login', query: { redirect: route.fullPath } }">{{ t('author.write.logIn') }}</RouterLink></p>
    </template>
    <p v-else-if="id === undefined" role="status">{{ t('author.write.openAnArticleOrStartANewDraft') }}</p>
    <template v-else-if="!editable">
      <ElAlert :title="failure" type="error" :closable="false" />
      <ElButton class="retry" @click="reload++">{{ t('author.write.retry') }}</ElButton>
    </template>
    <section v-if="authorizationReady && currentSession?.canAuthor && sourcePanes.length" v-show="editable"
      id="workspace-editor" class="editor-document" role="tabpanel" :aria-label="selectedPanelTitle">
      <div ref="editorArea" class="editor-source" :class="{ 'editor-source--split': showComparison }"
        :style="{ gridTemplateColumns: splitColumns }">
        <WorkspaceSourcePane v-for="pane in sourcePanes" :key="pane.tab.sessionId" :pane="pane" :focus="paneFocused(pane)"
          :concealed="!pane.selected || (!pane.tab.active && !showComparison)"
          :blocked="closingTabs || pending || metadataDirty || recoveryBlocked" :split="hasSecondaryGroup" :can-switch="canSwitch"
          :source-target="!summarySeek && sourceSeek?.sessionId === pane.tab.sessionId ? sourceSeek : undefined" @source-revealed="finishSourceSeek"
          @edit="(field, value, edits) => edit(pane, field, value, edits)" @activate="focusGroup(pane.tab)" @compose="changeComposition(pane, $event)">
          <template #before>
            <template v-if="paneFocused(pane)">
              <p v-if="notice" class="write-notice" role="status">
                {{ notice }} <a v-if="publishedPath" :href="publishedPath" target="_blank" rel="noopener">{{ t('author.write.readThePublishedArticle') }}</a>
              </p>
              <ElAlert v-if="failure" :title="failure" type="error" :closable="false" show-icon />
              <ElButton v-if="hasConflict" class="retry" @click="reloadDraft">{{ t('author.write.loadLatestRevision') }}</ElButton>
              <p v-if="recoveryChecking" role="status">{{ t('author.write.checkingLocalDraftRecovery') }}</p>
              <DraftMarkdownImport v-if="canImportDraft" :key="credentialEpoch"
                @load="loadImportedDraft(pane, $event)" />
            </template>
          </template>
          <template #after>
            <template v-if="paneFocused(pane)">
              <p v-if="recoveryFailure" role="status">{{ t('author.write.localDraftRecoveryIsUnavailableSaveToKeep') }}</p>
              <section v-if="recoveryItems.length" aria-labelledby="draft-recovery-title">
                <h2 id="draft-recovery-title">{{ t('author.write.recoverAnUnsavedDraft') }}</h2>
                <p>{{ t('author.write.unsavedTextIsStoredInThisBrowserFor') }}</p>
                <div v-for="item in recoveryItems" :key="`${item.writer}-${item.editSequence}`">
                  <h3>{{ item.title || t('author.write.untitledDraft') }}</h3>
                  <p v-if="item.relationship === 'compare'">{{ t('author.write.thisRecoveryCopyAndTheServerDraftHave') }}</p>
                  <details>
                    <summary>{{ t('author.write.compareDrafts') }}</summary>
                    <h4>{{ t('author.write.serverDraft') }}</h4><pre>{{ original?.body }}</pre>
                    <h4>{{ t('author.write.recoveryCopy') }}</h4><pre>{{ item.body }}</pre>
                  </details>
                  <ElButton native-type="button" :disabled="pending || recoveryWorking || articleDirty" @click="restoreDraft(item)">{{ t('author.write.restoreDraft') }}</ElButton>
                  <ElButton native-type="button" :disabled="pending || recoveryWorking" @click="recovery.remove(item)">{{ t('author.write.discardRecoveryCopy') }}</ElButton>
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
      <EditorInspector v-if="original && original.id > 0" v-slot="{ ready: inspectorReady }" :nested-modal-active="revisionComparisonActive || taxonomyModalActive"
        :opened="persistentWorkspace ? !sourceInspectorPending && inspectorOpen : undefined" @update:opened="setInspectorOpen">
        <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
          :disabled="pending || hasConflict" />
        <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
          :disabled="pending || hasConflict" format="docx" />
        <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
          :disabled="pending || hasConflict" format="html" />
        <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
          :disabled="pending || hasConflict" format="epub" />
        <MarkdownExportControl :article="original.id" :revision="original.revision" :selected="original.revision"
          :disabled="pending || hasConflict" format="pdf" />
        <DocumentExportTasks :article="original.id" :revision="original.revision" :selected="original.revision"
          :active="inspectorReady && !revisionComparisonActive" :disabled="pending || hasConflict" />
        <AuthorPluginPreview :article="original.id" :revision="original.revision"
          :active="inspectorReady && !revisionComparisonActive" :disabled="!canPreviewPlugin" />
        <ArticleMedia :article-id="original.id" :revision="original.revision"
          :credential="credential" :can-publish="canPublishImages"
          :can-change="!!currentSession?.siteSessionId && !dirty && !pending && !recoveryBlocked && !retry && !hasConflict"
          @save="submit('save-attachment', undefined, undefined, undefined, undefined, $event)" @publish-images="publishSelectedImages" />
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
        <ArticleProperties
          :article-id="original.id"
          :revision="original.revision"
          :identity="identityEpoch"
          :disabled="articleDirty || metadataDirty || articlePending || recoveryBlocked || !!retry || hasConflict"
          :source-target="propertySeek" :inspector-ready="inspectorReady && !recoveryBlocked"
          @pending="setPropertyPending" @source-revealed="finishPropertySeek"
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
        <ArticleSummary ref="summaryEditor" :article-id="original.id" :revision="original.revision" :credential="credential"
          :can-change="canChangeSummary" :saving="articlePending && summaryDirty"
          :source-target="summarySeek" :inspector-ready="inspectorReady" @source-revealed="finishSourceSeek"
          @change="setSummaryDirty" @save="saveSummary" />
      </EditorInspector>
    </section>
  </main>
</template>

<style scoped>
.canvas-entry { margin-inline-start: .75rem; }
.workspace-actions {
  margin-block: .75rem 1rem;
}
.workspace-open {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
  margin-block: .5rem;
}
.workspace-open-field {
  max-inline-size: min(100%, 12rem);
}
.workspace-actions summary {
  cursor: pointer;
}
.workspace-groups, .workspace-group-actions > div { display: flex; flex-wrap: wrap; gap: .5rem; }
.workspace-group-actions { margin-block: .5rem; }
.editor-document {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "source" "launcher";
}
.editor-source {
  grid-area: source;
  display: grid;
  gap: .5rem;
  min-inline-size: 0;
}
.editor-source--split { align-items: start; column-gap: 0; }
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
@media (min-width: 1024px) {
  .editor-document:has(> .inspector-launcher[aria-expanded="true"]) {
    grid-template-columns: minmax(0, 1fr) minmax(18rem, 36%);
    grid-template-areas: "source pane" "launcher pane";
    align-items: start;
    column-gap: var(--fsus-space-4);
  }
}
</style>
