<template>
  <section
    v-bind="rootAttrs"
    ref="rootElementRef"
    :class="[
      ns.b(),
      ns.m(currentMode),
      ns.m(`chrome-${chrome}`),
      ns.m(`mobile-${mobileLayout}`),
      ns.m(`profile-${editorProfile}`),
      ns.m(`interaction-${interactionProfile}`),
      ns.m(`toolbar-${effectiveToolbarDensity}`),
      ns.is('commands-expanded', commandsExpanded),
      ns.is('focus-mode', writingAidsFocusState.enabled),
      ns.is('typewriter-mode', resolvedWritingAids.typewriter),
    ]"
    role="region"
    tabindex="-1"
    :aria-label="localeText.editorAria"
    :data-markdown-instance="commandTrayId"
    data-markdown-scroll-container="body"
    :style="editorStyle"
  >
    <div
      v-if="searchUiState.open"
      :class="[
        ns.e('search-bar'),
        ns.is('compact', true),
        ns.is('replace', searchUiState.replaceOpen),
      ]"
      role="search"
      :aria-label="searchUiState.aria.ariaLabel"
    >
      <div :class="ns.e('search-row')">
        <input
          ref="searchQueryInputRef"
          v-model="searchQuery"
          type="text"
          :class="ns.e('search-input')"
          :placeholder="localeText.search.find"
          :aria-label="searchUiState.aria.queryAriaLabel"
          data-testid="markdown-search-query"
          @input="handleSearchQueryInput"
          @keydown="handleSearchInputKeydown"
        />
        <span
          :class="ns.e('search-count')"
          role="status"
          :aria-live="searchUiState.aria.statusAriaLive"
          data-testid="markdown-search-count"
        >
          {{ searchUiState.statusText }}
        </span>
        <button
          type="button"
          :class="[
            ns.e('search-toggle'),
            ns.is('active', searchMode === 'plain-case'),
          ]"
          :aria-label="localeText.search.matchCase"
          :title="localeText.search.matchCase"
          @click="toggleSearchMode('plain-case')"
        >
          Aa
        </button>
        <button
          type="button"
          :class="[
            ns.e('search-toggle'),
            ns.is('active', searchMode === 'whole-word'),
          ]"
          :aria-label="localeText.search.wholeWord"
          :title="localeText.search.wholeWord"
          @click="toggleSearchMode('whole-word')"
        >
          &#92;b
        </button>
        <button
          type="button"
          :class="[
            ns.e('search-toggle'),
            ns.is('active', searchMode === 'regex'),
          ]"
          :aria-label="localeText.search.useRegex"
          :title="localeText.search.useRegex"
          @click="toggleSearchMode('regex')"
        >
          .*
        </button>
        <button
          type="button"
          :class="ns.e('search-nav')"
          :disabled="!searchMatches.length"
          :aria-label="localeText.search.previousMatch"
          :title="localeText.search.previousMatch"
          data-testid="markdown-search-prev"
          @click="searchNavigate('previous')"
        >
          ↑
        </button>
        <button
          type="button"
          :class="ns.e('search-nav')"
          :disabled="!searchMatches.length"
          :aria-label="localeText.search.nextMatch"
          :title="localeText.search.nextMatch"
          data-testid="markdown-search-next"
          @click="searchNavigate('next')"
        >
          ↓
        </button>
        <button
          type="button"
          :class="[
            ns.e('search-toggle'),
            ns.is('active', searchUiState.replaceOpen),
          ]"
          :aria-label="localeText.search.toggleReplace"
          :title="localeText.search.toggleReplace"
          @click="toggleSearchReplace"
        >
          ⇄
        </button>
        <button
          type="button"
          :class="ns.e('search-close')"
          :aria-label="localeText.search.close"
          :title="localeText.search.close"
          data-testid="markdown-search-close"
          @click="closeSearch"
        >
          ×
        </button>
      </div>
      <div v-if="searchUiState.replaceOpen" :class="ns.e('search-row')">
        <input
          ref="searchReplaceInputRef"
          v-model="searchReplaceText"
          type="text"
          :class="ns.e('search-input')"
          :placeholder="localeText.search.replace"
          :aria-label="searchUiState.aria.replaceAriaLabel"
          data-testid="markdown-search-replace"
          @keydown="handleSearchReplaceKeydown"
        />
        <button
          type="button"
          :class="ns.e('search-action')"
          :disabled="!searchMatches.length || editingBlocked"
          data-testid="markdown-search-replace-current"
          @click="searchReplaceCurrent"
        >
          {{ localeText.search.replace }}
        </button>
        <button
          type="button"
          :class="ns.e('search-action')"
          :disabled="!searchMatches.length || editingBlocked"
          data-testid="markdown-search-replace-all"
          @click="searchReplaceAll"
        >
          {{ localeText.search.replaceAll }}
        </button>
      </div>
    </div>
    <header
      v-if="chromeRegions.toolbar && surfaceOptions.toolbar"
      ref="toolbarRef"
      :class="ns.e('toolbar')"
    >
      <div :class="ns.e('commands')">
        <button
          v-for="command in primaryCommands"
          :key="command.key"
          type="button"
          :class="ns.e('command')"
          :disabled="isCommandDisabled(command)"
          :aria-describedby="commandDescriptionId(command)"
          :aria-label="commandName(command)"
          :title="commandName(command)"
          @click="activateCommand(command)"
        >
          {{ commandName(command) }}
        </button>
        <button
          v-if="gatedPasteAsMarkdownCommand"
          type="button"
          :class="ns.e('command')"
          disabled
          :aria-describedby="pasteAsMarkdownDescriptionId"
          :aria-label="commandName(gatedPasteAsMarkdownCommand)"
          :title="commandName(gatedPasteAsMarkdownCommand)"
        >
          {{ commandName(gatedPasteAsMarkdownCommand) }}
        </button>
        <button
          v-if="overflowItemCount"
          ref="commandOverflowRef"
          type="button"
          :class="[ns.e('command-more'), ns.is('expanded', commandsExpanded)]"
          :aria-expanded="commandsExpanded"
          :aria-controls="commandTrayId"
          :aria-label="commandOverflowAriaLabel"
          aria-haspopup="true"
          :disabled="editingBlocked"
          @click="toggleCommands"
        >
          <span>{{ resolvedCommandOverflowLabel }}</span>
          <span :class="ns.e('command-more-count')">{{
            overflowItemCount
          }}</span>
        </button>
      </div>

      <div
        v-if="showModeSwitcher"
        :class="ns.e('modes')"
        role="tablist"
        :aria-label="localeText.modeSwitcherAria"
      >
        <button
          v-for="mode in visibleModes"
          :key="mode"
          type="button"
          role="tab"
          :aria-selected="currentMode === mode"
          :class="[
            ns.e('mode'),
            `${ns.e('mode')}--${mode}`,
            ns.is('active', currentMode === mode),
          ]"
          :disabled="editingBlocked"
          @click="setMode(mode)"
        >
          {{ modeLabel(mode) }}
        </button>
      </div>

      <div v-if="primaryActions.length" :class="ns.e('actions')">
        <button
          v-for="action in primaryActions"
          :key="action.key"
          type="button"
          :class="ns.e('action')"
          :disabled="editingBlocked"
          @click="runAction(action)"
        >
          {{ action.label }}
        </button>
      </div>

      <div
        v-if="overflowItemCount && commandsExpanded"
        :id="commandTrayId"
        ref="commandTrayRef"
        :class="ns.e('command-tray')"
        @keydown.esc.prevent.stop="closeCommandOverflow(true)"
      >
        <button
          v-for="command in overflowCommands"
          :key="command.key"
          type="button"
          :class="ns.e('command')"
          :disabled="isCommandDisabled(command)"
          :aria-describedby="commandDescriptionId(command)"
          :aria-label="commandName(command)"
          :title="commandName(command)"
          @click="activateOverflowCommand(command)"
        >
          {{ commandName(command) }}
        </button>
        <button
          v-for="action in overflowActions"
          :key="action.key"
          type="button"
          :class="[ns.e('command'), ns.e('command-tray-action')]"
          :disabled="editingBlocked"
          @click="runOverflowAction(action)"
        >
          {{ action.label }}
        </button>
      </div>
      <span
        v-if="pasteAsMarkdownGate"
        :id="pasteAsMarkdownDescriptionId"
        :class="ns.e('visually-hidden')"
      >
        {{ pasteAsMarkdownGateDescription }}
      </span>
    </header>

    <div
      :class="ns.e('body')"
      data-markdown-scroll-container="body"
      :data-markdown-reveal-state="liveReveal.state"
      :data-markdown-surface-owner="liveSurface.inputOwner"
      :data-markdown-atomic-kind="liveAtomic?.kind || undefined"
      :data-markdown-atomic-status="liveAtomic?.state || undefined"
      :data-markdown-layout-action="liveLayout.action"
      :data-markdown-layout-smooth="liveLayout.smooth ? 'true' : 'false'"
      @scroll="handlePreviewScroll"
    >
      <pre
        v-if="writingAidsFocusState.enabled"
        ref="focusLayerRef"
        :class="ns.e('focus-layer')"
        aria-hidden="true"
      ><span
          v-for="segment in focusSegments"
          :key="segment.key"
          :class="[
            ns.is('dimmed', segment.dimmed),
            ns.is('exempt', segment.exempt),
          ]"
          :data-node-id="segment.nodeId"
        >{{ segment.text }}</span></pre>
      <textarea
        :id="textareaId"
        ref="textareaRef"
        :class="ns.e('textarea')"
        :aria-hidden="liveSurface.inputVisible ? undefined : 'true'"
        :aria-label="textareaAriaLabel"
        :aria-controls="activeSlashTrigger ? slashMenuId : undefined"
        :aria-activedescendant="
          activeSlashTrigger && slashCommands[activeSlashIndex]
            ? slashItemId(slashCommands[activeSlashIndex].key)
            : undefined
        "
        :aria-haspopup="activeSlashTrigger ? 'menu' : undefined"
        :aria-busy="loading || undefined"
        :aria-disabled="editingBlocked"
        :aria-readonly="props.readonly || undefined"
        :disabled="inputDisabled"
        :readonly="props.readonly"
        :hidden="!liveSurface.inputVisible || undefined"
        :name="textareaName"
        :placeholder="effectivePlaceholder"
        :rows="minRows"
        :tabindex="liveSurface.inputVisible ? undefined : -1"
        :value="isComposing ? nativeCompositionValue : editorValue"
        :spellcheck="!languageSearchPaused && languageCapability.spellcheck"
        :lang="languageCapability.lang || undefined"
        @beforeinput="handleBeforeInput"
        @blur="handleBlur"
        @click="handlePointerReveal"
        @compositionend="handleCompositionEnd"
        @compositionstart="handleCompositionStart"
        @contextmenu="handleTableContextMenu"
        @copy="handleCopy"
        @cut="handleCut"
        @dragover.prevent
        @drop="handleDrop"
        @input="handleInput"
        @keydown="handleKeydown"
        @paste="handlePaste"
        @pointerdown="handleSelectionDragStart"
        @pointerup="handleSelectionDragEnd"
        @scroll="handleLayoutScroll"
        @select="handleSelectionMove"
        @selectionchange="handleSelectionMove"
        @touchmove="handleLayoutTouch"
        @wheel="handleLayoutWheel"
      />

      <input
        ref="attachmentInputRef"
        type="file"
        multiple
        :class="ns.e('attachment-picker')"
        tabindex="-1"
        aria-hidden="true"
        @change="handleAttachmentPickerChange"
      />

      <ul
        v-if="attachmentPresentations.length"
        :class="ns.e('attachments')"
        :aria-label="localeText.attachments.region"
      >
        <li
          v-for="attachment in attachmentPresentations"
          :key="attachment.itemId"
          :class="ns.e('attachment')"
        >
          <span :class="ns.e('attachment-name')">{{ attachment.name }}</span>
          <span
            :class="ns.e('attachment-status')"
            :aria-live="attachment.statusAriaLive"
          >
            {{ attachment.progressAriaText }}
          </span>
          <div :class="ns.e('attachment-actions')">
            <button
              v-for="action in attachment.actions"
              :key="action.key"
              type="button"
              :disabled="action.disabled"
              @click="runAttachmentAction(attachment.itemId, action.key)"
            >
              {{ action.label }}
            </button>
          </div>
        </li>
      </ul>

      <form
        v-if="activeImage"
        :class="ns.e('media-properties')"
        :aria-label="localeText.imageProperties.region"
        @submit.prevent="applyImageProperties"
      >
        <label>
          <span>{{ localeText.imageProperties.alt }}</span>
          <input v-model="imageAltDraft" :disabled="editingBlocked" />
        </label>
        <label>
          <span>{{ localeText.imageProperties.destination }}</span>
          <input
            v-model="imageDestinationDraft"
            :aria-invalid="imagePropertyError ? 'true' : undefined"
            :disabled="editingBlocked"
          />
        </label>
        <label>
          <span>{{ localeText.imageProperties.title }}</span>
          <input v-model="imageTitleDraft" :disabled="editingBlocked" />
        </label>
        <label>
          <span>{{ localeText.imageProperties.caption }}</span>
          <input v-model="imageCaptionDraft" :disabled="editingBlocked" />
        </label>
        <p v-if="imagePropertyError" role="alert">
          {{ imagePropertyError }}
        </p>
        <div :class="ns.e('media-actions')">
          <button type="submit" :disabled="editingBlocked">
            {{ localeText.imageProperties.apply }}
          </button>
          <button
            type="button"
            :disabled="editingBlocked"
            @click="revealActiveImageSource"
          >
            {{ localeText.imageProperties.source }}
          </button>
          <button
            type="button"
            :disabled="!activeImageOpenAllowed"
            @click="openActiveImage"
          >
            {{ localeText.imageProperties.open }}
          </button>
          <button type="button" @click="copyActiveFigure('exact')">
            {{ localeText.imageProperties.copySource }}
          </button>
          <button
            v-if="activeImage.figure"
            type="button"
            @click="copyActiveFigure('visible')"
          >
            {{ localeText.imageProperties.copyVisible }}
          </button>
          <button
            type="button"
            :disabled="editingBlocked"
            @click="openActiveImageReplacement"
          >
            {{ localeText.imageProperties.replace }}
          </button>
          <button
            v-if="activeImage.figure"
            type="button"
            :disabled="editingBlocked"
            @click="removeActiveCaption"
          >
            {{ localeText.imageProperties.removeCaption }}
          </button>
          <button
            type="button"
            :disabled="editingBlocked"
            @click="removeActiveImage"
          >
            {{ localeText.imageProperties.removeImage }}
          </button>
        </div>
      </form>

      <div
        v-if="currentTableCell && !editingBlocked"
        :class="ns.e('table-context')"
      >
        <button
          ref="tableMenuTriggerRef"
          type="button"
          :class="ns.e('table-menu-trigger')"
          aria-haspopup="menu"
          :aria-controls="tableMenuId"
          :aria-expanded="tableMenuOpen"
          aria-label="表格操作"
          @click="toggleTableMenu"
        >
          表格操作
        </button>
        <div
          v-if="tableMenuOpen"
          :id="tableMenuId"
          ref="tableMenuRef"
          :class="ns.e('table-menu')"
          role="menu"
          aria-label="表格操作"
          @keydown="handleTableMenuKeydown"
        >
          <button
            v-for="action in tableContextActions"
            :key="action.key"
            type="button"
            role="menuitem"
            :title="action.title"
            :aria-label="action.title"
            @click="runTableContextAction(action.key)"
          >
            {{ action.label }}
          </button>
        </div>
      </div>
      <span :class="ns.e('visually-hidden')" aria-live="polite">
        {{ tableAnnouncement }}
      </span>

      <div
        v-if="liveDecorations.length"
        :class="ns.e('live-decorations')"
        aria-hidden="true"
        data-markdown-live-decorations
      >
        <span
          v-for="decoration in liveDecorations"
          :key="decoration.nodeId"
          :data-kind="decoration.kind"
          :data-node-id="decoration.nodeId"
          :data-role="decoration.role"
        />
      </div>
      <div
        v-if="currentMode === 'live' && embedPresentationSegments.length"
        :class="ns.e('live-embeds')"
        :aria-label="localeText.embeds.region"
        role="region"
      >
        <section
          v-for="segment in embedPresentationSegments"
          :key="`live:${segment.key}`"
          class="el-markdown-embed"
          :aria-label="segment.plan.accessibility.name"
          role="region"
        >
          <header class="el-markdown-embed__header">
            <span class="el-markdown-embed__target">{{
              segment.plan.title
            }}</span>
            <span class="el-markdown-embed__mode-tag">{{
              localeText.embeds.modes[segment.plan.mode]
            }}</span>
            <span class="el-markdown-embed__status" role="status">{{
              segment.plan.statusText
            }}</span>
          </header>
          <el-markdown-renderer
            v-if="segment.plan.markdown !== undefined"
            :base-url="previewBaseUrl"
            :content="segment.plan.markdown"
            :csp-nonce="previewCspNonce"
            :features="previewFeatures"
            mode="editor"
            @features-activated="emitRenderEvent('features-activated', $event)"
            @render-complete="handleRendererComplete($event)"
            @render-error="emitRenderEvent('render-error', $event)"
          />
          <p v-else-if="segment.plan.excerpt" class="el-markdown-embed__body">
            {{ segment.plan.excerpt }}
          </p>
          <div class="el-markdown-embed__actions">
            <button
              v-for="action in segment.plan.allowedActions"
              :key="action"
              type="button"
              class="el-markdown-embed__action"
              @click="handleEmbedAction(segment, action)"
            >
              {{ embedActionLabel(action) }}
            </button>
          </div>
        </section>
      </div>
      <div
        v-if="visibleSearchHighlights.length"
        :class="ns.e('search-highlights')"
        aria-hidden="true"
      >
        <span
          v-for="highlight in visibleSearchHighlights"
          :key="`search:${highlight.range.start}:${highlight.range.end}`"
          :class="[
            ns.e('search-highlight'),
            ns.is('current', highlight.current),
          ]"
          :style="searchHighlightStyle(highlight.range)"
        />
      </div>

      <div
        v-if="liveSurface.rendererVisible && embedRenderSegments.length > 1"
        ref="previewRendererRef"
        :class="ns.e('preview')"
      >
        <template v-for="segment in embedRenderSegments" :key="segment.key">
          <el-markdown-renderer
            v-if="segment.kind === 'markdown' && segment.content"
            :base-url="previewBaseUrl"
            :content="segment.content"
            :csp-nonce="previewCspNonce"
            :features="previewFeatures"
            mode="editor"
            @features-activated="emitRenderEvent('features-activated', $event)"
            @render-complete="handleRendererComplete($event)"
            @render-error="emitRenderEvent('render-error', $event)"
          />
          <section
            v-else-if="segment.kind === 'embed'"
            class="el-markdown-embed"
            :aria-label="segment.plan.accessibility.name"
            role="region"
          >
            <header class="el-markdown-embed__header">
              <span class="el-markdown-embed__target">{{
                segment.plan.title
              }}</span>
              <span class="el-markdown-embed__mode-tag">{{
                localeText.embeds.modes[segment.plan.mode]
              }}</span>
              <span class="el-markdown-embed__status" role="status">{{
                segment.plan.statusText
              }}</span>
            </header>
            <el-markdown-renderer
              v-if="segment.plan.markdown !== undefined"
              :base-url="previewBaseUrl"
              :content="segment.plan.markdown"
              :csp-nonce="previewCspNonce"
              :features="previewFeatures"
              mode="editor"
              @features-activated="emitRenderEvent('features-activated', $event)"
              @render-complete="handleRendererComplete($event)"
              @render-error="emitRenderEvent('render-error', $event)"
            />
            <p v-else-if="segment.plan.excerpt" class="el-markdown-embed__body">
              {{ segment.plan.excerpt }}
            </p>
            <div class="el-markdown-embed__actions">
              <button
                v-for="action in segment.plan.allowedActions"
                :key="action"
                type="button"
                class="el-markdown-embed__action"
                @click="handleEmbedAction(segment, action)"
              >
                {{ embedActionLabel(action) }}
              </button>
            </div>
          </section>
        </template>
      </div>

      <template v-if="atomicActionNodes.length">
        <div
          v-for="atomicNode in atomicActionNodes"
          :key="atomicNode.id"
          :class="ns.e('visually-hidden')"
          role="group"
          :aria-label="localeText.atomic.actionsRegion(atomicNode.kind)"
          v-bind="{ 'data-markdown-atomic-actions': '' }"
        >
          <button
            type="button"
            tabindex="-1"
            :aria-label="localeText.atomic.enterBefore(atomicNode.kind)"
            @click="invokeAtomicNodeAction(atomicNode.id, 'caret-before')"
          >
            {{ localeText.atomic.enterBefore(atomicNode.kind) }}
          </button>
          <button
            type="button"
            tabindex="-1"
            :aria-label="localeText.atomic.enterAfter(atomicNode.kind)"
            @click="invokeAtomicNodeAction(atomicNode.id, 'caret-after')"
          >
            {{ localeText.atomic.enterAfter(atomicNode.kind) }}
          </button>
          <button
            type="button"
            tabindex="-1"
            :aria-label="localeText.atomic.editSource(atomicNode.kind)"
            @click="invokeAtomicNodeAction(atomicNode.id, 'enter-source')"
          >
            {{ localeText.atomic.editSource(atomicNode.kind) }}
          </button>
        </div>
      </template>

      <el-markdown-renderer
        v-else-if="
          liveSurface.rendererVisible && embedRenderSegments.length <= 1
        "
        ref="previewRendererRef"
        :class="ns.e('preview')"
        :base-url="previewBaseUrl"
        :content="editorValue"
        :csp-nonce="previewCspNonce"
        :features="previewFeatures"
        :loading-text="localeText.states.loading"
        mode="editor"
        @features-activated="emitRenderEvent('features-activated', $event)"
        @render-complete="handlePreviewRenderComplete($event)"
        @render-error="emitRenderEvent('render-error', $event)"
      />
    </div>

    <footer
      v-if="chromeRegions.status && statusDensity !== 'none'"
      :class="ns.e('status')"
    >
      <slot
        name="status"
        :metrics="editorMetrics"
        :state="statusResolution.slotPayload.state"
        :capability="statusResolution.slotPayload.capability"
        :payload="statusResolution.slotPayload"
      >
        <div v-if="statusDensity === 'minimal'" :class="ns.e('status-summary')">
          <span>{{ characterCount }} {{ localeText.metrics.characters }}</span>
          <span>{{ wordCount }} {{ localeText.metrics.words }}</span>
        </div>
        <dl v-else :class="ns.e('status-details')">
          <div>
            <dt>{{ localeText.metrics.line }}</dt>
            <dd>{{ editorMetrics.caretLine }}</dd>
          </div>
          <div>
            <dt>{{ localeText.metrics.column }}</dt>
            <dd>{{ editorMetrics.caretColumn }}</dd>
          </div>
          <div>
            <dt>{{ localeText.metrics.lines }}</dt>
            <dd>{{ editorMetrics.lineCount }}</dd>
          </div>
          <div>
            <dt>{{ localeText.metrics.characters }}</dt>
            <dd>{{ editorMetrics.graphemeCount }}</dd>
          </div>
          <div>
            <dt>{{ localeText.metrics.words }}</dt>
            <dd>{{ editorMetrics.wordCount }}</dd>
          </div>
          <div>
            <dt>{{ localeText.metrics.selected }}</dt>
            <dd>{{ editorMetrics.graphemeSelectionLength }}</dd>
          </div>
          <div v-if="editorMetrics.byteCount !== undefined">
            <dt>{{ localeText.metrics.bytes }}</dt>
            <dd>{{ editorMetrics.byteCount }}</dd>
          </div>
        </dl>
      </slot>
    </footer>

    <div
      v-if="statusDensity === 'none' && statusResolution.ariaLiveMessage"
      :class="ns.e('visually-hidden')"
      aria-live="polite"
    >
      {{ statusResolution.ariaLiveMessage }}
    </div>

    <span
      v-for="item in commandSnapshot"
      v-show="commandStateText(item)"
      :id="commandStateId(item.key)"
      :key="item.key"
      :class="ns.e('visually-hidden')"
    >
      {{ commandStateText(item) }}
    </span>

    <div
      v-if="
        surfaceOptions.selectionToolbar &&
        selectionToolbarVisible &&
        selectionToolbarCommands.length
      "
      :class="ns.e('selection-toolbar')"
      role="toolbar"
      :aria-label="localeText.surfaces.selectionToolbar"
      :data-markdown-anchor-id="selectionToolbarAnchorId"
      :data-markdown-anchor-epoch="
        selectionToolbarPlacement.visual?.documentIdentity.epoch
      "
      :data-markdown-anchor-projection="
        selectionToolbarPlacement.reveal?.reveal.anchorId
      "
      @keydown.esc.prevent.stop="closeSelectionToolbar"
    >
      <button
        v-for="command in selectionToolbarCommands"
        :key="command.key"
        type="button"
        :class="ns.e('command')"
        :disabled="isCommandDisabled(command)"
        :aria-describedby="commandDescriptionId(command)"
        :aria-label="commandName(command)"
        :title="commandName(command)"
        @click="activateCommand(command)"
      >
        {{ commandName(command) }}
      </button>
    </div>

    <div
      v-if="
        surfaceOptions.slashMenu && activeSlashTrigger && slashCommands.length
      "
      :id="slashMenuId"
      :class="ns.e('slash-menu')"
      role="menu"
      :aria-label="localeText.surfaces.slashMenu"
      @keydown.esc.prevent.stop="closeSlashMenu"
    >
      <button
        v-for="(command, idx) in slashCommands"
        :id="slashItemId(command.key)"
        :key="command.key"
        type="button"
        role="menuitem"
        :class="[ns.e('command'), ns.is('active', idx === activeSlashIndex)]"
        :disabled="isCommandDisabled(command)"
        :aria-describedby="commandDescriptionId(command)"
        :aria-label="commandName(command)"
        @click="executeSlashCommand(command)"
        @mouseenter="activeSlashIndex = idx"
      >
        {{ commandName(command) }}
      </button>
    </div>

    <form
      v-if="contextualSurface === 'link-properties' && activeLink"
      ref="contextualSurfaceRef"
      :class="ns.e('property-surface')"
      role="dialog"
      :aria-label="localeText.contextual.editLink"
      :data-markdown-anchor-id="activeLinkNodeId"
      :data-markdown-anchor-epoch="documentIdentity.epoch"
      @submit.prevent="applyLinkProperties"
      @keydown.esc.prevent.stop="closeContextualSurface()"
    >
      <label :class="ns.e('property-field')">
        <span>{{ localeText.contextual.label }}</span>
        <input v-model="linkLabelDraft" type="text" />
      </label>
      <label
        v-if="activeLink.ranges.destination"
        :class="ns.e('property-field')"
      >
        <span>{{ localeText.contextual.destination }}</span>
        <input v-model="linkDestinationDraft" type="url" />
      </label>
      <label
        v-if="activeLink.kind === 'inline'"
        :class="ns.e('property-field')"
      >
        <span>{{ localeText.contextual.title }}</span>
        <input v-model="linkTitleDraft" type="text" />
      </label>
      <p v-if="contextualError" role="alert">{{ contextualError }}</p>
      <footer :class="ns.e('property-actions')">
        <button type="submit">{{ localeText.contextual.apply }}</button>
        <button v-if="activeLink.url" type="button" @click="openActiveLink">
          {{ localeText.contextual.open }}
        </button>
        <button type="button" @click="copyActiveLink">
          {{ localeText.contextual.copy }}
        </button>
        <button type="button" @click="revealActiveLink">
          {{ localeText.contextual.sourceReveal }}
        </button>
        <button type="button" @click="removeActiveLink">
          {{ localeText.contextual.removeLink }}
        </button>
        <button type="button" @click="closeContextualSurface()">
          {{ localeText.contextual.cancel }}
        </button>
      </footer>
    </form>

    <form
      v-else-if="contextualSurface === 'anchor-properties'"
      ref="contextualSurfaceRef"
      :class="ns.e('property-surface')"
      role="dialog"
      :aria-label="
        activeAnchor
          ? localeText.contextual.editAnchor
          : localeText.contextual.insertAnchor
      "
      :data-markdown-anchor-id="activeAnchorNodeId"
      :data-markdown-anchor-epoch="documentIdentity.epoch"
      @submit.prevent="applyAnchorProperties"
      @keydown.esc.prevent.stop="closeContextualSurface()"
    >
      <label :class="ns.e('property-field')">
        <span>{{ localeText.contextual.anchorId }}</span>
        <input
          v-model="anchorIdDraft"
          type="text"
          autocomplete="off"
          pattern="[a-z][a-z0-9-]{0,63}"
          required
        />
      </label>
      <p v-if="contextualError" role="alert">{{ contextualError }}</p>
      <footer :class="ns.e('property-actions')">
        <button type="submit">{{ localeText.contextual.apply }}</button>
        <button v-if="activeAnchor" type="button" @click="copyActiveAnchor">
          {{ localeText.contextual.copy }}
        </button>
        <button v-if="activeAnchor" type="button" @click="removeActiveAnchor">
          {{ localeText.contextual.removeAnchor }}
        </button>
        <button type="button" @click="closeContextualSurface()">
          {{ localeText.contextual.cancel }}
        </button>
      </footer>
    </form>

    <Teleport to="body">
      <div
        v-if="surfaceOptions.commandPalette && commandPaletteOpen"
        :class="ns.e('palette-backdrop')"
        :dir="commandPaletteDirection"
        @mousedown.self.prevent="closeCommandPalette"
      >
        <section
          :class="ns.e('palette-dialog')"
          role="dialog"
          aria-modal="true"
          :aria-label="localeText.commandPalette.title"
          @keydown="handleCommandPaletteKeydown"
        >
          <label
            :for="`${paletteListId}-search`"
            :class="[ns.e('palette-group-label'), ns.e('palette-search-label')]"
          >
            {{ localeText.commandPalette.searchPlaceholder }}
          </label>
          <input
            :id="`${paletteListId}-search`"
            ref="commandPaletteInputRef"
            v-model="paletteQuery"
            type="text"
            :class="ns.e('palette-input')"
            :aria-label="localeText.commandPalette.searchPlaceholder"
            :placeholder="localeText.commandPalette.searchPlaceholder"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            :aria-controls="paletteListId"
            :aria-activedescendant="
              activePaletteCommand
                ? paletteItemId(activePaletteCommand.key)
                : undefined
            "
            @keydown.down.prevent="selectNextPaletteItem"
            @keydown.up.prevent="selectPreviousPaletteItem"
            @keydown.enter="executeActivePaletteItem"
          />
          <div :id="paletteListId" :class="ns.e('palette-list')" role="listbox">
            <div
              v-for="group in paletteCommandGroups"
              :key="group.key"
              :class="ns.e('palette-group')"
              role="group"
              :aria-label="commandGroupName(group.key)"
            >
              <div :class="ns.e('palette-group-label')">
                {{ commandGroupName(group.key) }}
              </div>
              <button
                v-for="item in group.commands"
                :id="paletteItemId(item.key)"
                :key="item.key"
                type="button"
                :class="[
                  ns.e('palette-item'),
                  ns.is(
                    'active',
                    paletteItemIndex(item.key) === activePaletteIndex,
                  ),
                ]"
                role="option"
                :aria-selected="
                  paletteItemIndex(item.key) === activePaletteIndex
                "
                :aria-describedby="commandDescriptionId(item.command)"
                :disabled="isCommandDisabled(item.command)"
                @click="executePaletteCommand(item.command)"
              >
                <span>{{ commandName(item.command) }}</span>
                <kbd v-if="item.shortcut">{{ item.shortcut }}</kbd>
              </button>
            </div>
            <p v-if="!paletteCommands.length" :class="ns.e('palette-empty')">
              {{ localeText.commandPalette.empty }}
            </p>
          </div>
          <p :class="ns.e('visually-hidden')" aria-live="polite">
            {{ localeText.commandPalette.results(paletteCommands.length) }}
          </p>
        </section>
      </div>

      <div
        v-if="pasteAsMarkdownSession"
        :class="ns.e('paste-backdrop')"
        @mousedown.self.prevent
      >
        <section
          ref="pasteAsMarkdownDialogRef"
          :class="ns.e('paste-dialog')"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="pasteAsMarkdownTitleId"
          :aria-describedby="pasteAsMarkdownHelpId"
          @keydown="handlePasteAsMarkdownDialogKeydown"
        >
          <header :class="ns.e('paste-header')">
            <h2 :id="pasteAsMarkdownTitleId">
              {{ localeText.pasteAsMarkdown.title }}
            </h2>
            <p :id="pasteAsMarkdownHelpId">
              {{ localeText.pasteAsMarkdown.description }}
            </p>
          </header>

          <div :class="ns.e('paste-content')">
            <section
              :class="ns.e('paste-preview')"
              role="region"
              :aria-label="localeText.pasteAsMarkdown.markdownPreview"
            >
              <h3>{{ localeText.pasteAsMarkdown.markdownPreview }}</h3>
              <pre>{{ pasteAsMarkdownSession.preview.markdown }}</pre>
            </section>

            <section
              :class="ns.e('paste-diff')"
              role="region"
              :aria-label="localeText.pasteAsMarkdown.sourceDiff"
            >
              <h3>{{ localeText.pasteAsMarkdown.sourceDiff }}</h3>
              <div :class="ns.e('paste-diff-columns')">
                <div>
                  <h4>{{ localeText.pasteAsMarkdown.sourceBefore }}</h4>
                  <pre>{{ pasteAsMarkdownSession.preview.diff.before }}</pre>
                </div>
                <div>
                  <h4>{{ localeText.pasteAsMarkdown.sourceAfter }}</h4>
                  <pre>{{ pasteAsMarkdownSession.preview.diff.after }}</pre>
                </div>
              </div>
            </section>

            <div
              v-if="pasteAsMarkdownSession.preview.warnings.length"
              :class="ns.e('paste-warnings')"
              role="region"
              :aria-label="localeText.pasteAsMarkdown.conversionWarnings"
            >
              <h3>{{ localeText.pasteAsMarkdown.conversionWarnings }}</h3>
              <ul :aria-label="localeText.pasteAsMarkdown.conversionWarnings">
                <li
                  v-for="warning in pasteAsMarkdownSession.preview.warnings"
                  :key="`${warning.kind}:${warning.code}:${warning.detail || ''}`"
                >
                  <strong>{{ warning.kind }}</strong
                  >: {{ warning.code
                  }}<span v-if="warning.detail"> — {{ warning.detail }}</span>
                </li>
              </ul>
            </div>

            <p v-if="pasteAsMarkdownError" role="alert">
              {{ pasteAsMarkdownError }}
            </p>
          </div>

          <footer :class="ns.e('paste-actions')">
            <button
              type="button"
              @click="confirmPasteAsMarkdownChoice('plain-text')"
            >
              {{ localeText.pasteAsMarkdown.pastePlainText }}
            </button>
            <button
              ref="pasteAsMarkdownPrimaryActionRef"
              type="button"
              @click="confirmPasteAsMarkdownChoice('markdown-import')"
            >
              {{ localeText.pasteAsMarkdown.importMarkdown }}
            </button>
            <button type="button" @click="cancelPasteAsMarkdownSurface">
              {{ localeText.pasteAsMarkdown.cancel }}
            </button>
          </footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<script lang="ts" setup>
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  triggerRef,
  toRaw,
  useAttrs,
  useId,
  watch,
} from 'vue'
import { ElMarkdownRenderer } from '@element-plus/components/markdown-renderer'
import { CHANGE_EVENT, UPDATE_MODEL_EVENT } from '@element-plus/constants'
import {
  provideMarkdownEditorFrameScheduler,
  useMarkdownEditorFrameScheduler,
  useNamespace,
} from '@element-plus/hooks'
import { provideMarkdownHeavyFeatureDocumentContext } from '../../../hooks/use-markdown-heavy-feature-lifecycle'
import {
  createMarkdownAnchorMap,
  createMarkdownEditorProjection,
  type MarkdownStableProjection,
  stabilizeMarkdownEditorProjection,
} from '../../../wasm/markdown-runtime'
import {
  isMarkdownEditorCommandEnabled,
  isMarkdownEditorCommandVisible,
  markdownEditorEmits,
  markdownEditorProps,
  createMarkdownEditorMetricsSession,
  type MarkdownEditorMetricsChange,
  resolveMarkdownEditorCommandCopy,
  resolveMarkdownEditorLocaleText,
  resolveMarkdownEditorOverflowCommands,
  resolveMarkdownEditorPrimaryCommands,
  resolveMarkdownEditorSyntaxContext,
  resolveMarkdownEditorShortcut,
  runMarkdownEditorCommand,
} from './markdown-editor'
import {
  createMarkdownEditorCommandSnapshot,
  selectMarkdownEditorCommandSnapshot,
  type MarkdownEditorCommandSnapshotItem,
  type MarkdownEditorCommandRuntimeState,
} from './markdown-editor-command-snapshot'
import {
  captureMarkdownAttachmentInput,
  createMarkdownAttachmentAtomicPresentation,
  createMarkdownAttachmentCaptureSession,
  type MarkdownAttachmentBatchIntent,
  type MarkdownAttachmentCaptureObservation,
  type MarkdownAttachmentFileConsumer,
  type MarkdownAttachmentItemIntent,
  type MarkdownAttachmentProviderResult,
  type MarkdownAttachmentSourceKind,
} from './markdown-editor-attachment'
import {
  cancelMarkdownAttachmentJob,
  inspectMarkdownAttachmentDispatch,
  planMarkdownAttachmentInsert,
  planMarkdownAttachmentRemove,
  planMarkdownAttachmentResolve,
  progressMarkdownAttachmentJob,
  rebaseMarkdownAttachmentJob,
  retryMarkdownAttachmentJob,
  type MarkdownAttachmentJob,
} from './markdown-editor-attachment-lifecycle'
import {
  decomposeMarkdownImageNode,
  planMarkdownImageAltEdit,
  planMarkdownImageDestinationEdit,
  planMarkdownImageRemove,
  planMarkdownImageTitleEdit,
} from './markdown-editor-link-image'
import {
  findMarkdownFigures,
  formatMarkdownFigureExactCopy,
  formatMarkdownFigureVisibleCopy,
  planMarkdownCaptionEdit,
  planMarkdownCaptionInsert,
  planMarkdownCaptionRemove,
  planMarkdownFigureDelete,
} from './markdown-editor-caption'
import { resolveMarkdownEditorChromeRegions } from './markdown-editor-chrome'
import {
  composeMarkdownEditorPositionMapInstances,
  createMarkdownEditorPositionMap,
  deriveMarkdownEditorChange,
  MarkdownEditorTransactionStore,
  toMarkdownEditorTransactionEvent,
} from './markdown-editor-transaction'

import type {
  MarkdownEditorActionItem,
  MarkdownEditorActionKey,
  MarkdownEditorCommand,
  MarkdownEditorInsertOptions,
  MarkdownEditorMode,
  MarkdownEditorSurfaceOptions,
} from './markdown-editor'
import type {
  BeforeInputSnapshot,
  MarkdownEditorDocumentIdentity,
  MarkdownEditorDispatchResult,
  MarkdownEditorHistoryState,
  MarkdownEditorInputMergeDirection,
  MarkdownEditorPositionMap,
  MarkdownEditorSelection,
  MarkdownEditorTransaction,
  MarkdownEditorTransactionRejection,
  MarkdownEditorTransactionEvent,
} from './markdown-editor-transaction'
import {
  resolveMarkdownBlockInputIntent,
  type MarkdownBlockInputKey,
} from './markdown-editor-input-intent'
import {
  MARKDOWN_PAIR_DEFAULTS,
  resolveMarkdownPairInput,
} from './markdown-editor-pair-input'
import {
  markdownClipboardItemsFromDataTransfer,
  resolveMarkdownClipboardCopy,
  resolveMarkdownClipboardCut,
  resolveMarkdownClipboardPaste,
  writeMarkdownClipboardPayload,
} from './markdown-editor-clipboard'
import { resolveMarkdownSelectionToolbarPlacement } from './markdown-editor-selection-toolbar'
import {
  abortMarkdownEditorCommandSessions,
  createMarkdownEditorCommandSession,
  rebaseMarkdownEditorCommandSession,
  resolveMarkdownEditorCommandSession,
  type MarkdownEditorCommandSession,
} from './markdown-editor-command-async'
import {
  planMarkdownSlashCommit,
  groupMarkdownEditorCommandSnapshot,
  resolveMarkdownSlashTrigger,
  searchMarkdownEditorCommandSnapshot,
} from './markdown-editor-surfaces'
import {
  parseMarkdownLinkNode,
  planMarkdownLinkPropertyEdit,
  planMarkdownLinkUnwrap,
  validateMarkdownPropertyUrl,
  type MarkdownParsedLink,
} from './markdown-editor-link-image'
import {
  currentMarkdownAnchors,
  planMarkdownAnchorCopy,
  planMarkdownAnchorEdit,
  planMarkdownAnchorInsert,
  planMarkdownAnchorRemove,
  type MarkdownProjectedAnchor,
} from './markdown-editor-anchor-commands'
import { resolveMarkdownEditorStatus } from './markdown-editor-status'
import {
  cancelMarkdownPasteAsMarkdown,
  confirmMarkdownPasteAsMarkdown,
  openMarkdownPasteAsMarkdown,
  type MarkdownPasteAsMarkdownChoice,
  type MarkdownPasteAsMarkdownRejection,
  type MarkdownPasteAsMarkdownSession,
} from './markdown-editor-paste-markdown'
import { resolveMarkdownLanguageToolCapability } from './markdown-editor-language-tools'
import {
  bindMarkdownWebLanguageTools,
  type MarkdownWebLanguageController,
} from './markdown-editor-language-web'
import { createMarkdownEditorNativeEventMachine } from './markdown-editor-native-event'
import { resolveMarkdownLiveSurface } from './markdown-editor-live-surface'
import {
  resolveMarkdownLiveSyntaxReveal,
  type MarkdownLiveRevealIntent,
} from './markdown-editor-live-reveal'
import {
  MARKDOWN_ATOMIC_NODE_KINDS,
  resolveMarkdownAtomicNodeIntent,
  resolveMarkdownLiveSelectionMotion,
  retainMarkdownLiveSelection,
  type MarkdownAtomicNodePlan,
  type MarkdownAtomicNodeSession,
  type MarkdownLiveSelectionMotion,
} from './markdown-editor-live-selection'
import {
  calculateMarkdownSourceAnchorY,
  createMarkdownFocusSegments,
  createWritingAidsController,
  type MarkdownEditorWritingAidsController,
} from './markdown-editor-writing-aids'
import {
  createMarkdownOutlineModelFromProjection,
  revealHeading as revealHeadingOutline,
  revealSourceRange as revealSourceRangeOutline,
} from './markdown-editor-outline'
import { planMarkdownOutlineReveal } from './markdown-editor-outline-active'
import { createMarkdownEditorSessionBinding } from './markdown-editor-session'
import { freezeMarkdownEditorSessionPanelState, markdownEditorSessionPanelMemoryUnits } from './markdown-editor-session-panels'
import { captureMarkdownEditorSessionAttachmentState } from './markdown-editor-session-attachment-state'
import { createMarkdownAttachmentEmbedResourceOwner } from './markdown-editor-attachment-embed-owner'
import { createMarkdownEditorSessionCommandResources, isMarkdownEditorSessionOwnedCommand } from './markdown-editor-session-command-resources'
import type { MarkdownRendererLastValidRender, createMarkdownRendererSessionResourceOwner } from '../../markdown-renderer/src/markdown-renderer-session-resources'
import { createMarkdownEditorSessionLayoutResources } from './markdown-editor-session-layout'
import { createMarkdownEditorFrameResourceParticipant } from './markdown-editor-session-resources'
import type { MarkdownEditorSessionResourceParticipant } from './markdown-editor-session-resources'
import {
  resolveMarkdownLiveLayoutStability,
  resolveMarkdownLiveVirtualWindow,
  type MarkdownLiveLayoutGesture,
  type MarkdownLiveLayoutPlan,
  type MarkdownLiveLayoutTrigger,
  type MarkdownLiveVirtualWindow,
} from './markdown-editor-live-layout'
import {
  planMarkdownTableAlignColumn,
  planMarkdownTableDeleteColumn,
  planMarkdownTableDeleteRow,
  planMarkdownTableInsertColumn,
  planMarkdownTableInsertRow,
  planMarkdownTableMoveColumn,
  planMarkdownTableMoveRow,
  resolveMarkdownTableCellAtOffset,
  resolveMarkdownTableCellCoordinates,
  type MarkdownTableCellIdentity,
} from './markdown-editor-table-structure'
import {
  planMarkdownTableFormat,
  planMarkdownTablePaste,
  resolveMarkdownTableInputIntent,
} from './markdown-editor-table-input'
import { resolveMarkdownTableContextActions } from './markdown-editor-table-acceptance'

import type { MarkdownHtmlImportSnapshot } from '../../../wasm/markdown-html-import'
import {
  dispatchMarkdownSearchKeydown,
  resolveMarkdownSearchNavigation,
  resolveMarkdownSearchUi,
  revealMarkdownSearchMatch,
  type MarkdownSearchUiState,
  resolveMarkdownSearchHighlights,
} from './markdown-editor-search-ui'
import {
  planMarkdownReplaceAll,
  planMarkdownReplaceCurrentInSet,
} from '../../../wasm/markdown-replace'
import type { MarkdownSearchMatch, MarkdownSearchMode } from '../../../wasm/markdown-search-model'
import type { MarkdownEmbedResult } from '../../../wasm/markdown-embed-provider'
import {
  collectMarkdownEmbedNodes,
  planMarkdownEmbedPresentation,
  runMarkdownEmbedAction,
  type MarkdownEmbedActionKind,
  type MarkdownEmbedPresentationPlan,
  type MarkdownEmbedValidNode,
} from './markdown-editor-embed'



defineOptions({
  name: 'ElMarkdownEditor',
  inheritAttrs: false,
})

const props = defineProps(markdownEditorProps)
const emit = defineEmits(markdownEditorEmits)
const ns = useNamespace('markdown-editor')
const attrs = useAttrs()
const rootElementRef = ref<HTMLElement | null>(null)
const sessionSurfacePaused = ref(false)
let sessionDisposed = false
let retireSnapshotPublicationAuthority: (() => void) | undefined = undefined
let sessionUnmountFailed = false
let sessionUnmountFirstCause: unknown
// Retire before the original scheduler registers its cleanup callbacks.
onBeforeUnmount(() => {
  sessionDisposed = true
  try { retireSnapshotPublicationAuthority?.() } catch (cause) {
    if (!sessionUnmountFailed) sessionUnmountFirstCause = cause
    sessionUnmountFailed = true
    throw cause
  }
})
const frameScheduler = useMarkdownEditorFrameScheduler({
  onFrameEnd: (metrics) => {
    const target = rootElementRef.value
    if (!target) return
    const next = JSON.stringify({
      coalesced: metrics.coalescedTasks,
      executed: metrics.executed,
      frame: metrics.frameId,
      pending: metrics.pendingTasks,
      stale: metrics.staleTasks,
      violations: metrics.readAfterWriteViolations,
    })
    if (target.dataset.markdownFrameMetrics !== next) {
      target.dataset.markdownFrameMetrics = next
    }
  },
})
provideMarkdownEditorFrameScheduler(frameScheduler)
const modes: MarkdownEditorMode[] = ['source', 'live', 'split', 'preview']
const commandTrayId = `${useId()}-command-tray`
const commandTrayRef = ref<HTMLElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const commandOverflowRef = ref<HTMLButtonElement | null>(null)
const commandPaletteInputRef = ref<HTMLInputElement | null>(null)
const paletteListId = `${useId()}-command-palette-list`
const slashMenuId = `${useId()}-slash-menu`
let languageToolsController: MarkdownWebLanguageController | null = null
let languageSearchParticipant: MarkdownEditorSessionResourceParticipant | null = null
const languageSearchPaused = ref(false)
let languageToolsRevision = -1
let languageToolsSource = ''
let languageToolsConfigKey = ''
const attachmentInputRef = ref<HTMLInputElement | null>(null)
const attachmentReplaceRange = ref<{
  readonly nodeId: string
  readonly start: number
  readonly end: number
} | null>(null)
const pasteAsMarkdownDialogRef = ref<HTMLElement | null>(null)
const pasteAsMarkdownPrimaryActionRef = ref<HTMLButtonElement | null>(null)
const pasteAsMarkdownSession = ref<MarkdownPasteAsMarkdownSession | null>(null)
const pasteAsMarkdownError = ref('')
const pasteAsMarkdownBusy = ref(false)
const pasteAsMarkdownDescriptionId = `${useId()}-paste-as-markdown-description`
const pasteAsMarkdownTitleId = `${useId()}-paste-as-markdown-title`
const pasteAsMarkdownHelpId = `${useId()}-paste-as-markdown-help`
const tableMenuId = `${useId()}-table-menu`
const commandsExpanded = ref(false)
const tableMenuOpen = ref(false)
const tableMenuRef = ref<HTMLElement | null>(null)
const tableMenuTriggerRef = ref<HTMLButtonElement | null>(null)
const retainedPreviewScrollLeft = ref(0)
const visualViewportHeight = ref(0)
const visualViewportOffsetTop = ref(0)
const toolbarRef = ref<HTMLElement | null>(null)
const inputDisabled = computed(() => props.disabled || props.loading || sessionSurfacePaused.value)
const editingBlocked = computed(() => props.readonly || inputDisabled.value)
const surfaceOptions = computed<Required<MarkdownEditorSurfaceOptions>>(() => ({
  commandPalette: props.surfaces.commandPalette ?? false,
  selectionToolbar: props.surfaces.selectionToolbar ?? false,
  slashMenu: props.surfaces.slashMenu ?? false,
  toolbar: props.surfaces.toolbar ?? true,
}))
const chromeRegions = computed(() =>
  resolveMarkdownEditorChromeRegions(props.chrome, {
    toolbar: surfaceOptions.value.toolbar,
    status: props.statusDensity !== 'none',
  }),
)
const textareaAriaLabel = computed(() =>
  currentMode.value === 'live'
    ? localeText.value.textarea.live
    : localeText.value.textarea.source,
)
const compactMode = computed(() => props.mobileLayout === 'compact')
const effectiveToolbarDensity = computed(() =>
  compactMode.value ? 'minimal' : props.toolbarDensity,
)
const normalizeModeForLayout = (
  mode: MarkdownEditorMode,
): MarkdownEditorMode =>
  compactMode.value && mode === 'split' ? 'source' : mode
const currentMode = ref<MarkdownEditorMode>(
  normalizeModeForLayout(props.mode ?? props.defaultMode),
)
const initialSelection: MarkdownEditorSelection = {
  direction: 'none',
  end: props.modelValue.length,
  start: props.modelValue.length,
}
const documentIdentity = reactive({
  epoch: props.documentIdentity?.epoch ?? 0,
  id: props.documentIdentity?.id ?? commandTrayId,
})
const transactionStore = new MarkdownEditorTransactionStore(
  props.modelValue,
  initialSelection,
  documentIdentity,
)
const retireStoreDocumentAuthority = MarkdownEditorTransactionStore.prototype.retireDocumentAuthority.bind(transactionStore)
retireSnapshotPublicationAuthority = retireStoreDocumentAuthority
if (sessionDisposed) retireStoreDocumentAuthority()
const sessionLayoutResources = createMarkdownEditorSessionLayoutResources(frameScheduler, () => ({
  documentIdentity: transactionStore.documentIdentity,
  revision: transactionStore.revision,
  disposed: sessionDisposed,
}))
provideMarkdownHeavyFeatureDocumentContext(Object.freeze({
  documentEpoch: () => transactionStore.documentIdentity.epoch,
  documentKey: () => transactionStore.documentIdentity.id,
  revision: () => transactionStore.revision,
  documentAuthority: Object.freeze({
    capture: MarkdownEditorTransactionStore.prototype.captureDocumentAuthority.bind(transactionStore),
    hasCustody: MarkdownEditorTransactionStore.prototype.hasDocumentAuthorityCustody.bind(transactionStore),
    subscribeRetirement: MarkdownEditorTransactionStore.prototype.subscribeDocumentAuthorityRetirement.bind(transactionStore),
  }),
}))
const editorRevision = ref(transactionStore.revision)
const editorSelection = ref(transactionStore.selection)
const editorValue = ref(transactionStore.value)
const currentTableCell = ref<MarkdownTableCellIdentity | null>(null)
const tableAnnouncement = ref('')
const tableContextActions = computed(() =>
  resolveMarkdownTableContextActions().filter(
    (action) => action.key !== 'delete-row' || currentTableCell.value?.row !== 0,
  ),
)
const nativeCompositionValue = ref(transactionStore.value)
const writingAidsController: MarkdownEditorWritingAidsController =
  createWritingAidsController({
    writingAids: props.writingAids,
    editorProfile: props.editorProfile,
    readonly: props.readonly,
    disabled: props.disabled,
    source: transactionStore.value,
    selection: transactionStore.selection,
  })
const resolvedWritingAids = computed(() => writingAidsController.options)
const writingAidsState = ref(writingAidsController.state)
const writingAidsFocusState = ref(writingAidsController.focusState!)
const writingAidsDataAttrs = computed(() => ({
  'data-markdown-focus-active-block':
    writingAidsFocusState.value.activeBlockId || undefined,
  'data-markdown-focus-enabled': writingAidsFocusState.value.enabled
    ? 'true'
    : 'false',
  'data-markdown-writing-aids-state': writingAidsState.value,
}))
const rootAttrs = computed(() => ({ ...attrs, ...writingAidsDataAttrs.value }))
const focusLayerRef = ref<HTMLElement | null>(null)
const syncFocusLayerScroll = (scrollTop: number) => {
  if (focusLayerRef.value) focusLayerRef.value.scrollTop = scrollTop
}
const focusSegments = computed(() => {
  return createMarkdownFocusSegments(
    editorValue.value,
    writingAidsFocusState.value,
  )
})
const refreshWritingAidsDocument = () => {
  let projection: MarkdownStableProjection | undefined
  const focusNeedsProjection =
    props.writingAids?.focus === true &&
    props.editorProfile === 'prose' &&
    !props.readonly &&
    !props.disabled &&
    currentMode.value !== 'preview'
  if (focusNeedsProjection) {
    try {
      projection = editorProjection.value
    } catch {
      projection = undefined
    }
  }
  const selection = transactionStore.selection
  const caret =
    selection.direction === 'backward' ? selection.start : selection.end
  const currentBlock = projection?.nodes.find(
    (node) => node.rawRange.start <= caret && caret <= node.rawRange.end,
  )
  writingAidsController.updateDocument({
    currentBlock,
    caretAnchor: currentBlock
      ? Object.freeze({ blockId: currentBlock.id, sourceOffset: caret })
      : null,
    disabled: props.disabled,
    documentEpoch: documentIdentity.epoch,
    documentIdentity,
    editorProfile: props.editorProfile,
    focusExemptions: props.focusExemptions,
    mode: currentMode.value,
    projection,
    readonly: props.readonly,
    revision: transactionStore.revision,
    selection,
    source: transactionStore.value,
    writingAids: props.writingAids,
  })
  writingAidsFocusState.value = writingAidsController.focusState!
  writingAidsState.value = writingAidsController.state
  writingAidsController.handleProjectionChange()
}
let previousEditorProjection: MarkdownStableProjection | undefined
let previousEditorProjectionSource = ''
const editorProjection = computed(() => {
  const source = editorValue.value
  try {
    const change = previousEditorProjection
      ? deriveMarkdownEditorChange(previousEditorProjectionSource, source)
      : undefined
    const projection = stabilizeMarkdownEditorProjection(
      createMarkdownEditorProjection(source),
      documentIdentity,
      previousEditorProjection,
      change ?? undefined,
    )
    previousEditorProjection = projection
    previousEditorProjectionSource = source
    return projection
  } catch {
    return undefined
  }
})
const editorAnchorMap = computed(() => {
  const projection = editorProjection.value
  if (!projection) return undefined
  try {
    const syntax = projection.nodes.flatMap((node) => [
      {
        atomic: node.presentation === 'live-atomic',
        id: node.id,
        projectionId: node.id,
        range: node.rawRange,
      },
      ...node.rawMarkerRanges.map((range, index) => ({
        hidden: true,
        id: `${node.id}:marker:${index}`,
        parentId: node.id,
        projectionId: node.id,
        range,
      })),
    ])
    return createMarkdownAnchorMap({
      identity: documentIdentity,
      projection,
      source: editorValue.value,
      syntax,
    })
  } catch {
    return undefined
  }
})
const attachmentCaptureSession = createMarkdownAttachmentCaptureSession()
const attachmentPauseRequested = ref(false)
// A public consumer callback has no network/timer census. Remember that it was
// bound/invoked; replacing props or completing a job cannot prove it released
// resources. Only a real consumer resource owner may lift this limitation.
const opaqueAttachmentResourcesObserved = ref(Boolean(props.embedProvider || props.attachmentDispatch))
watch([() => props.embedProvider, () => props.attachmentDispatch], (providers) => {
  if (providers.some(Boolean)) opaqueAttachmentResourcesObserved.value = true
}, { flush: 'sync' })
const attachmentJobs = ref<MarkdownAttachmentJob[]>([])
const attachmentBatches = new Map<
  string,
  {
    readonly batch: MarkdownAttachmentBatchIntent
    capture?: MarkdownAttachmentCaptureObservation
    readonly controller: AbortController
    readonly files: Map<
      MarkdownAttachmentItemIntent,
      { readonly file: File; readonly controller: AbortController }
    >
  }
>()
let attachmentFileCleanupDepth = 0
let attachmentPublicationDepth = 0
let attachmentRetirementRequested = false
let attachmentRetirementRunning = false
let attachmentRetirementContinuation: { handle: number | null; cancelled: boolean } | null = null
const assertAttachmentFileControlIdle = () => {
  if (attachmentFileCleanupDepth !== 0 || attachmentPublicationDepth !== 0 || attachmentRetirementRunning || attachmentRetirementRequested || attachmentRetirementContinuation)
    throw new Error('editor-session-attachment-file-cleanup-in-progress')
}
const revokeAttachmentFiles = (itemIds: readonly string[]) => {
  attachmentFileCleanupDepth += 1
  try {
    const itemControllers: AbortController[] = []
    const batchControllers: AbortController[] = []
    for (const itemId of itemIds) {
      const item = attachmentItems.get(itemId)
      if (!item) continue
      for (const record of attachmentBatches.values()) {
        const loan = record.files.get(item)
        if (!loan) continue
        record.files.delete(item)
        itemControllers.push(loan.controller)
        if (!record.files.size) {
          record.capture = undefined
          batchControllers.push(record.controller)
        }
        break
      }
    }
    for (const controller of itemControllers) controller.abort()
    for (const controller of batchControllers) controller.abort()
  } finally {
    attachmentFileCleanupDepth -= 1
    flushAttachmentRetirement()
  }
}
const revokeAttachmentFile = (itemId: string) => revokeAttachmentFiles([itemId])

const releaseAttachmentFiles = () => {
  attachmentFileCleanupDepth += 1
  try {
    const records = [...attachmentBatches.values()]
    attachmentBatches.clear()
    attachmentItems.clear()
    attachmentJobs.value = []
    attachmentRetirementRequested = false
    const continuation = attachmentRetirementContinuation
    if (continuation) {
      continuation.cancelled = true
      if (continuation.handle !== null) {
        frameScheduler.cancelAuxiliaryFrame(continuation.handle)
        if (attachmentRetirementContinuation === continuation) attachmentRetirementContinuation = null
      }
    }
    attachmentCaptureSession.clear()
    for (const record of records) {
      const loans = [...record.files.values()]
      record.files.clear()
      record.capture = undefined
      for (const loan of loans) loan.controller.abort()
      record.controller.abort()
    }
  } finally {
    attachmentFileCleanupDepth -= 1
    flushAttachmentRetirement()
  }
}
const legacyAttachmentAttempts = new WeakMap<MarkdownAttachmentItemIntent, number>()
const attachmentJobBindings = new WeakMap<MarkdownAttachmentJob, {
  readonly batch: MarkdownAttachmentBatchIntent
  readonly item: MarkdownAttachmentItemIntent
  readonly deletionAttempt?: number
  readonly retirementAttempt?: number
}>()
// Only an actual settled non-retryable attempt can retire original File/item
// custody. Keep the SAME job and dispatch proof as terminal checkpoint state.
const retireSettledAttachmentRecords = (
  job: MarkdownAttachmentJob,
  batch: MarkdownAttachmentBatchIntent,
  item: MarkdownAttachmentItemIntent,
  attempt: number,
) => {
  if (attachmentFileCleanupDepth !== 0 || attachmentPublicationDepth !== 0) {
    attachmentRetirementRequested = true
    return
  }
  const originalJob = toRaw(job)
  const proof = inspectMarkdownAttachmentDispatch(originalJob)
  const binding = attachmentJobBindings.get(originalJob)
  const record = attachmentBatches.get(batch.batchId)
  const identity = transactionStore.documentIdentity
  const revision = transactionStore.revision
  if (sessionDisposed || editorReleased || attachmentPauseRequested.value ||
      !proof?.settlementAvailable || !proof.settled || proof.dispatching ||
      proof.attempt !== attempt || originalJob.attempt !== attempt ||
      (originalJob.phase !== 'resolved' && originalJob.phase !== 'deleted') ||
      (originalJob.phase === 'deleted' && binding?.deletionAttempt !== attempt) ||
      !attachmentJobs.value.some((candidate) => toRaw(candidate) === originalJob) ||
      binding?.batch !== batch || binding.item !== item || record?.batch !== batch ||
      attachmentItems.get(item.itemId) !== item || record.files.has(item) ||
      !item.signal.aborted || originalJob.itemId !== item.itemId || originalJob.batchId !== batch.batchId ||
      originalJob.documentIdentity?.id !== identity.id || originalJob.documentIdentity.epoch !== identity.epoch ||
      batch.documentIdentity.id !== identity.id || batch.documentIdentity.epoch !== identity.epoch ||
      (props.documentIdentity?.id ?? commandTrayId) !== identity.id || (props.documentIdentity?.epoch ?? 0) !== identity.epoch)
    return
  // Document prop readers can reenter. Recheck real private custody after the
  // last reader before releasing any original records.
  const current = transactionStore.documentIdentity
  const finalProof = inspectMarkdownAttachmentDispatch(originalJob)
  if (sessionDisposed || editorReleased || attachmentPauseRequested.value ||
      current.id !== identity.id || current.epoch !== identity.epoch || transactionStore.revision !== revision ||
      finalProof?.dispatchRef !== proof.dispatchRef || finalProof.attempt !== attempt ||
      !finalProof.settlementAvailable || !finalProof.settled || finalProof.dispatching ||
      originalJob.attempt !== attempt || (originalJob.phase !== 'resolved' && originalJob.phase !== 'deleted') ||
      (originalJob.phase === 'deleted' && binding.deletionAttempt !== attempt) ||
      !attachmentJobs.value.some((candidate) => toRaw(candidate) === originalJob) ||
      attachmentJobBindings.get(originalJob) !== binding || attachmentBatches.get(batch.batchId) !== record ||
      attachmentItems.get(item.itemId) !== item || record.files.has(item)) return
  attachmentFileCleanupDepth += 1
  try {
    attachmentItems.delete(item.itemId)
    attachmentJobBindings.delete(originalJob)
    if (!record.files.size && record.capture === undefined && record.controller.signal.aborted &&
        batch.items.every((candidate) => attachmentItems.get(candidate.itemId) !== candidate))
      attachmentBatches.delete(batch.batchId)
  } finally {
    attachmentFileCleanupDepth -= 1
  }
}
const acceptAttachmentDeletion = (job: MarkdownAttachmentJob, identity: MarkdownEditorDocumentIdentity) => {
  const original = toRaw(job)
  const binding = attachmentJobBindings.get(original)
  if (!binding || original.phase !== 'deleted' || original.documentIdentity?.id !== identity.id ||
      original.documentIdentity.epoch !== identity.epoch ||
      !attachmentJobs.value.some((candidate) => toRaw(candidate) === original) ||
      attachmentItems.get(binding.item.itemId) !== binding.item ||
      attachmentBatches.get(binding.batch.batchId)?.batch !== binding.batch) return
  // Derived only from the actual accepted native deletion, in the SAME existing
  // binding. No body/transaction copy, new index or settlement acknowledgement.
  attachmentJobBindings.set(original, Object.freeze({ ...binding, deletionAttempt: original.attempt, retirementAttempt: original.attempt }))
}
const retireAcceptedAttachmentDeletion = (job: MarkdownAttachmentJob) => {
  const original = toRaw(job)
  const binding = attachmentJobBindings.get(original)
  if (binding?.deletionAttempt === original.attempt) {
    attachmentRetirementRequested = true
    flushAttachmentRetirement()
  }
}
const requestTerminalAttachmentRetirement = (job: MarkdownAttachmentJob, attempt: number) => {
  const original = toRaw(job)
  const binding = attachmentJobBindings.get(original)
  if (!binding || original.attempt !== attempt ||
      (original.phase !== 'resolved' && !(original.phase === 'deleted' && binding.deletionAttempt === attempt))) return
  attachmentJobBindings.set(original, Object.freeze({ ...binding, retirementAttempt: attempt }))
  attachmentRetirementRequested = true
  flushAttachmentRetirement()
}
const flushAttachmentRetirement = () => {
  if (!attachmentRetirementRequested || attachmentFileCleanupDepth !== 0 || attachmentPublicationDepth !== 0 || attachmentRetirementRunning) return
  attachmentRetirementRequested = false
  attachmentRetirementRunning = true
  let completed = false
  try {
    for (const job of attachmentJobs.value) {
      const original = toRaw(job)
      const binding = attachmentJobBindings.get(original)
      if (binding?.retirementAttempt === original.attempt && (original.phase === 'resolved' ||
          (original.phase === 'deleted' && binding.deletionAttempt === original.attempt)))
        retireSettledAttachmentRecords(original, binding.batch, binding.item, original.attempt)
    }
    completed = true
  } catch (error) {
    // Preserve the actual outstanding sweep and propagate failure; never turn
    // failed retirement into an idle/paused acknowledgement.
    attachmentRetirementRequested = true
    throw error
  } finally {
    attachmentRetirementRunning = false
    if (completed && attachmentRetirementRequested) scheduleAttachmentRetirement()
  }
}
const scheduleAttachmentRetirement = () => {
  if (!attachmentRetirementRequested || attachmentRetirementContinuation || sessionDisposed || editorReleased) return
  // Reserve before the actual frame owner admission. Exactly one bounded sweep
  // per real frame; reentry schedules another frame instead of recursive drains.
  const continuation = { handle: null as number | null, cancelled: false }
  attachmentRetirementContinuation = continuation
  const handle = frameScheduler.requestAuxiliaryFrame(() => {
    if (attachmentRetirementContinuation !== continuation) return
    attachmentRetirementContinuation = null
    if (!continuation.cancelled && !sessionDisposed && !editorReleased) {
      flushAttachmentRetirement()
      if (attachmentRetirementRequested) scheduleAttachmentRetirement()
    }
  })
  if (handle === undefined) {
    if (attachmentRetirementContinuation === continuation) attachmentRetirementContinuation = null
    return // Real paused/disposed admission refused; outstanding request remains.
  }
  if (attachmentRetirementContinuation === continuation && !continuation.cancelled) continuation.handle = handle
  else {
    continuation.handle = handle
    frameScheduler.cancelAuxiliaryFrame(handle)
    if (attachmentRetirementContinuation === continuation) attachmentRetirementContinuation = null
  }
}
const withAttachmentFile = (
  batch: MarkdownAttachmentBatchIntent,
  item: MarkdownAttachmentItemIntent,
  consume: MarkdownAttachmentFileConsumer,
): boolean => {
  const record = attachmentBatches.get(batch.batchId)
  const loan = record?.files.get(item)
  const job = attachmentJobs.value.find(
    (candidate) => candidate.itemId === item.itemId,
  )
  if (
    editorReleased || sessionDisposed || attachmentPauseRequested.value ||
    !record ||
    record.batch !== batch ||
    !loan ||
    !record.capture ||
    batch.items[item.order] !== item ||
    attachmentItems.get(item.itemId) !== item ||
    batch.signal.aborted ||
    item.signal.aborted ||
    batch.documentIdentity.id !== documentIdentity.id ||
    batch.documentIdentity.epoch !== documentIdentity.epoch ||
    batch.documentIdentity.id !==
      (props.documentIdentity?.id ?? commandTrayId) ||
    batch.documentIdentity.epoch !== (props.documentIdentity?.epoch ?? 0) ||
    !job ||
    attachmentJobBindings.get(toRaw(job))?.batch !== batch ||
    attachmentJobBindings.get(toRaw(job))?.item !== item ||
    job.documentIdentity?.id !== batch.documentIdentity.id ||
    job.documentIdentity?.epoch !== batch.documentIdentity.epoch ||
    job.revision !== batch.revision ||
    job.attempt !== 1 ||
    (job.phase !== 'pending' && job.phase !== 'progress')
  )
    return false
  consume(loan.file, record.capture)
  return true
}
const attachmentItems = new Map<
  string,
  MarkdownAttachmentBatchIntent['items'][number]
>()
const attachmentPresentations = computed(() =>
  attachmentJobs.value
    .filter((job) => job.phase !== 'deleted')
    .map((job) => {
      const item = attachmentItems.get(job.itemId ?? job.id)
      const presentation = createMarkdownAttachmentAtomicPresentation({
        itemId: job.itemId ?? job.id,
        name: item?.name ?? job.name ?? localeText.value.attachments.unnamed,
        kind: item?.kind ?? job.kind,
        status: job.phase === 'idle' ? 'pending' : job.phase,
        progress: job.progress,
        copy: localeText.value.attachments,
      })
      const settlement = inspectMarkdownAttachmentDispatch(job)
      return Object.freeze({
        ...presentation,
        actions: Object.freeze(presentation.actions.map((action) => action.key === 'retry'
          ? Object.freeze({ ...action, disabled: action.disabled || !settlement?.settled || settlement.attempt !== job.attempt })
          : action)),
      })
    }),
)
const selectionTick = ref(0)
const activeImage = computed(() => {
  void selectionTick.value
  if (currentMode.value === 'preview') return null
  const selection = transactionStore.selection
  const projection = createMarkdownEditorProjection(editorValue.value)
  const imageNode = projection.nodes
    .filter(
      (node) =>
        node.kind === 'image' &&
        selection.start >= node.rawRange.start &&
        selection.end <= node.rawRange.end,
    )
    .sort(
      (left, right) =>
        left.rawRange.end -
        left.rawRange.start -
        (right.rawRange.end - right.rawRange.start),
    )[0]
  if (!imageNode) return null
  const image = decomposeMarkdownImageNode(
    editorValue.value,
    imageNode.rawRange,
  )
  if (!image) return null
  const figure =
    findMarkdownFigures(editorValue.value).find(
      (candidate) =>
        candidate.mediaRange.start === imageNode.rawRange.start &&
        candidate.mediaRange.end === imageNode.rawRange.end,
    ) ?? null
  return Object.freeze({
    figure,
    image,
    nodeId: `image:${imageNode.rawRange.start}:${imageNode.rawRange.end}`,
    range: imageNode.rawRange,
  })
})
const imageAltDraft = ref('')
const imageDestinationDraft = ref('')
const imageTitleDraft = ref('')
const imageCaptionDraft = ref('')
const imagePropertyError = ref('')
watch(
  () => {
    const active = activeImage.value
    if (!active) return null
    return [
      active.nodeId,
      active.image.alt.value,
      active.image.destination.value,
      active.image.title?.value ?? '',
      active.figure?.text ?? '',
    ].join('\u0000')
  },
  () => {
    const active = activeImage.value
    imageAltDraft.value = active?.image.alt.value ?? ''
    imageDestinationDraft.value = active?.image.destination.value ?? ''
    imageTitleDraft.value = active?.image.title?.value ?? ''
    imageCaptionDraft.value = active?.figure?.text ?? ''
    imagePropertyError.value = ''
  },
  { immediate: true },
)
const activeImageUrlValidation = computed(() => {
  const active = activeImage.value
  if (!active) return null
  return validateMarkdownPropertyUrl(active.image.destination.value, {
    documentEpoch: documentIdentity.epoch,
    nodeId: active.nodeId,
    revision: transactionStore.revision,
    value: active.image.destination.value,
    version: 1,
  })
})
const activeImageOpenAllowed = computed(
  () => activeImageUrlValidation.value?.open.allowed === true,
)
const liveSurface = computed(() =>
  resolveMarkdownLiveSurface({
    documentIdentity,
    mode: currentMode.value,
    projection: editorProjection.value,
    projectionError: !editorProjection.value,
    revision: transactionStore.revision,
    source: editorValue.value,
  }),
)
const commandRevisionMaps = new Map<number, MarkdownEditorPositionMap>()
const refreshEditorProjection = (previousValue: string, nextValue: string) => {
  const change = deriveMarkdownEditorChange(previousValue, nextValue)
  previousEditorProjection = editorProjection.value
  previousEditorProjectionSource = previousValue
  return change
}
const positionMapFromRevision = (
  fromRevision: number,
  toRevision: number,
): MarkdownEditorPositionMap | undefined => {
  if (fromRevision === toRevision) {
    return createMarkdownEditorPositionMap([], {
      documentIdentity,
      projection: editorProjection.value,
      source: editorValue.value,
    })
  }
  const maps: MarkdownEditorPositionMap[] = []
  for (let revision = fromRevision; revision < toRevision; revision += 1) {
    const map = commandRevisionMaps.get(revision)
    if (!map) return undefined
    maps.push(map)
  }
  return composeMarkdownEditorPositionMapInstances(maps)
}
const liveReveal = ref(
  resolveMarkdownLiveSyntaxReveal({
    documentIdentity,
    mode: currentMode.value,
    selection: transactionStore.selection,
    source: editorValue.value,
  }),
)
const languageCapability = computed(() =>
  resolveMarkdownLanguageToolCapability({
    lang: props.lang,
    nativeWritingTools: props.nativeWritingTools,
    spellcheck: props.spellcheck,
  }),
)
const languageToolsConfig = () => ({
  lang: props.lang,
  nativeWritingTools: props.nativeWritingTools,
  spellcheck: props.spellcheck,
})
const syncLanguageToolsState = () => {
  const controller = languageToolsController
  if (!controller) return null
  const config = languageToolsConfig()
  const configKey = JSON.stringify(config)
  if (
    languageToolsRevision !== transactionStore.revision ||
    languageToolsSource !== transactionStore.value ||
    languageToolsConfigKey !== configKey
  ) {
    controller.updateState({
      anchorMap: editorAnchorMap.value,
      config,
      projection: editorProjection.value,
      projectionRevision: transactionStore.revision,
      revision: transactionStore.revision,
      source: transactionStore.value,
    })
    languageToolsRevision = transactionStore.revision
    languageToolsSource = transactionStore.value
    languageToolsConfigKey = configKey
  }
  controller.switchMode(currentMode.value)
  return controller.updateContext({
    disabled: inputDisabled.value,
    isComposing: nativeMachine.composing,
    mode: currentMode.value,
    readonly: props.readonly,
    selection: transactionStore.selection,
  })
}
const isComposing = ref(false)
const pasteAsMarkdownGate = computed<
  'composition' | 'readonly' | 'disabled' | 'loading' | 'previewOnly' | null
>(() => {
  if (isComposing.value) return 'composition'
  if (props.readonly) return 'readonly'
  if (props.loading) return 'loading'
  if (props.disabled) return 'disabled'
  if (currentMode.value === 'preview') return 'previewOnly'
  return null
})
const atomicSession = ref<MarkdownAtomicNodeSession | null>(null)
const liveAtomic = ref<MarkdownAtomicNodePlan | null>(null)
const atomicActionNodes = computed(() => {
  if (currentMode.value !== 'live') return []
  return MARKDOWN_ATOMIC_NODE_KINDS.map((kind) =>
    resolveMarkdownAtomicNodeIntent({
      action: 'caret-before',
      documentIdentity,
      kind,
      mode: currentMode.value,
      revision: transactionStore.revision,
      selection: transactionStore.selection,
      source: editorValue.value,
    }),
  )
    .filter(
      (
        plan,
      ): plan is MarkdownAtomicNodePlan & { kind: string; nodeId: string } =>
        plan.state === 'current' &&
        plan.kind !== null &&
        plan.nodeId !== null &&
        (plan.kind !== 'attachment' ||
          editorValue.value.includes('pending://')),
    )
    .map((plan) => ({ id: plan.nodeId, kind: plan.kind }))
})
const layoutGesture = ref<MarkdownLiveLayoutGesture | null>(null)
const liveWindow = ref<MarkdownLiveVirtualWindow | null>(null)
const liveLayout = ref<MarkdownLiveLayoutPlan>(
  resolveMarkdownLiveLayoutStability({
    documentIdentity,
    revision: transactionStore.revision,
    selection: transactionStore.selection,
    source: editorValue.value,
    trigger: 'block-height-change',
  }),
)
let layoutGestureTimer: ReturnType<typeof setTimeout> | undefined
let restoringViewport = false
let restoringTypewriter = false
let typewriterScrollTarget: number | null = null
let typewriterScrollSmooth = false
let typewriterLayoutAdjustment = false
let typewriterLayoutFrame: number | undefined
const typewriterScrollFrames = new Set<number>()
const requestTypewriterScrollFrame = (run: () => void) => {
  const handle = sessionLayoutResources.requestFrame(() => {
    if (handle !== undefined) typewriterScrollFrames.delete(handle)
    run()
  })
  if (handle !== undefined) typewriterScrollFrames.add(handle)
  return handle
}
const cancelOwnedTypewriterFrames = () => {
  if (typewriterLayoutFrame !== undefined) {
    sessionLayoutResources.cancelFrame(typewriterLayoutFrame)
    typewriterLayoutFrame = undefined
  }
  for (const handle of typewriterScrollFrames) sessionLayoutResources.cancelFrame(handle)
  typewriterScrollFrames.clear()
  restoringTypewriter = false
  typewriterLayoutAdjustment = false
  typewriterScrollTarget = null
  typewriterScrollSmooth = false
}
let textareaLayoutHeight = 0
let textareaLayoutWidth = 0
let viewportRestoreCurrentScrollTop = 0
let viewportRestoreNextScrollTop: number | null = null
const liveDecorations = computed(() => {
  const decorations = liveSurface.value.decorations
  if (currentMode.value !== 'live' || !liveWindow.value) return decorations
  const mounted = new Set(liveWindow.value.mountedNodeIds)
  return decorations.filter((decoration) => mounted.has(decoration.nodeId))
})
const restoreTextareaViewport = (plan: MarkdownLiveLayoutPlan) => {
  const textarea = textareaRef.value
  if (!textarea || plan.action !== 'restore' || !plan.anchor) return
  const anchor = plan.anchor
  const line =
    transactionStore.value.slice(0, anchor.sourceOffset).split('\n').length - 1
  frameScheduler.schedule({
    // Same-frame supersede: a newer layout plan (or a user gesture yield)
    // replaces or cancels this restore before the frame commits it.
    guard: () => liveLayout.value === plan,
    key: 'viewport-restore',
    measure: () => {
      const target = textareaRef.value
      if (!target) {
        viewportRestoreNextScrollTop = null
        return
      }
      const lineHeight =
        Number.parseFloat(window.getComputedStyle(target).lineHeight) || 20
      viewportRestoreNextScrollTop = Math.max(
        0,
        line * lineHeight - target.clientHeight / 3,
      )
      viewportRestoreCurrentScrollTop = target.scrollTop
    },
    mutate: () => {
      const target = textareaRef.value
      if (
        !target ||
        viewportRestoreNextScrollTop === null ||
        Math.abs(
          viewportRestoreCurrentScrollTop - viewportRestoreNextScrollTop,
        ) <= 1
      ) {
        viewportRestoreNextScrollTop = null
        return
      }
      restoringViewport = true
      target.scrollTop = viewportRestoreNextScrollTop
      viewportRestoreNextScrollTop = null
      sessionLayoutResources.microtask(() => {
        restoringViewport = false
      })
    },
  })
}
const applyLiveLayout = (
  trigger: MarkdownLiveLayoutTrigger,
  extras: {
    readonly gesture?: MarkdownLiveLayoutGesture | null
    readonly reducedMotion?: boolean
  } = {},
) => {
  const plan = resolveMarkdownLiveLayoutStability({
    composing: isComposing.value,
    documentIdentity,
    gesture: extras.gesture ?? layoutGesture.value,
    previousAnchor: liveLayout.value.anchor,
    reducedMotion: extras.reducedMotion,
    revision: transactionStore.revision,
    selection: transactionStore.selection,
    source: transactionStore.value,
    trigger,
  })
  liveLayout.value = plan
  if (plan.action === 'restore') restoreTextareaViewport(plan)
  return plan
}
let virtualWindowNext: MarkdownLiveVirtualWindow | null = null
const refreshLiveWindow = (
  origin: 'input' | 'document-switch' | 'mode-switch' | 'feature' | 'initial',
) => {
  frameScheduler.schedule({
    key: 'virtual-window',
    // The window plan is pure data (projection + selection distance); it is
    // recomputed in the measure phase so rapid input always commits the
    // freshest window, and the mount/unmount commit lands in the mutate phase.
    measure: () => {
      virtualWindowNext = resolveMarkdownLiveVirtualWindow({
        documentIdentity,
        origin,
        previousMountedNodeIds: liveWindow.value?.mountedNodeIds,
        selection: transactionStore.selection,
        source: transactionStore.value,
      })
    },
    mutate: () => {
      if (virtualWindowNext) liveWindow.value = virtualWindowNext
      virtualWindowNext = null
    },
  })
}
const markLayoutGesture = (gesture: MarkdownLiveLayoutGesture) => {
  if (sessionSurfacePaused.value) return
  layoutGesture.value = gesture
  applyLiveLayout('block-height-change', { gesture })
  if (layoutGestureTimer) clearTimeout(layoutGestureTimer)
  layoutGestureTimer = setTimeout(() => {
    layoutGestureTimer = undefined
    layoutGesture.value = null
  }, 200)
}
const suspendTypewriterForUserScroll = () => {
  typewriterScrollTarget = null
  writingAidsController.handleUserScroll()
  writingAidsState.value = writingAidsController.state
}
const settleTypewriterLayout = () => {
  if (sessionSurfacePaused.value) return
  if (typewriterLayoutFrame !== undefined) {
    sessionLayoutResources.cancelFrame(typewriterLayoutFrame)
  }
  typewriterLayoutAdjustment = true
  let remainingFrames = 3
  const settle = () => {
    const textarea = textareaRef.value
    if (!textarea || !resolvedWritingAids.value.typewriter) {
      typewriterLayoutAdjustment = false
      typewriterLayoutFrame = undefined
      return
    }
    textareaLayoutHeight = textarea.clientHeight
    textareaLayoutWidth = textarea.clientWidth
    applyTypewriterScroll('async-layout')
    remainingFrames -= 1
    if (remainingFrames > 0) {
      typewriterLayoutFrame = sessionLayoutResources.requestFrame(settle)
      return
    }
    typewriterLayoutAdjustment = false
    typewriterLayoutFrame = undefined
  }
  typewriterLayoutFrame = sessionLayoutResources.requestFrame(settle)
}
const handleLayoutWheel = () => {
  suspendTypewriterForUserScroll()
  markLayoutGesture('wheel')
}
const handleLayoutTouch = () => {
  suspendTypewriterForUserScroll()
  markLayoutGesture('touch')
}
const handleLayoutScroll = () => {
  const textarea = textareaRef.value
  if (textarea) syncFocusLayerScroll(textarea.scrollTop)
  if (restoringSelection || restoringViewport || restoringTypewriter) return
  if (textarea && typewriterScrollTarget !== null) {
    const reachedTarget =
      Math.abs(textarea.scrollTop - typewriterScrollTarget) <= 1
    if (reachedTarget) typewriterScrollTarget = null
    if (reachedTarget || typewriterScrollSmooth) return
    typewriterScrollTarget = null
  }
  if (
    textarea &&
    (textarea.clientHeight !== textareaLayoutHeight ||
      textarea.clientWidth !== textareaLayoutWidth)
  ) {
    textareaLayoutHeight = textarea.clientHeight
    textareaLayoutWidth = textarea.clientWidth
    settleTypewriterLayout()
    return
  }
  if (typewriterLayoutAdjustment) return
  suspendTypewriterForUserScroll()
  markLayoutGesture('scrollbar')
}
const previewElement = () => {
  const current = previewRendererRef.value
  if (!current) return null
  return current instanceof HTMLElement ? current : (current.$el ?? null)
}
const handlePreviewScroll = () => {
  retainedPreviewScrollLeft.value = previewElement()?.scrollLeft ?? 0
}
const restorePreviewScroll = () => {
  void sessionLayoutResources.afterTick(() => {
    const preview = previewElement()
    if (preview) preview.scrollLeft = retainedPreviewScrollLeft.value
  })
}
const cssLength = (element: HTMLElement, property: string) => {
  const value = Number.parseFloat(
    window.getComputedStyle(element).getPropertyValue(property),
  )
  return Number.isFinite(value) ? value : 0
}
let typewriterTextContext:
  | OffscreenCanvasRenderingContext2D
  | null
  | undefined
const sourceAnchorY = (textarea: HTMLTextAreaElement, lineHeight: number) => {
  if (typeof OffscreenCanvas === 'undefined') return undefined
  if (typewriterTextContext === undefined) {
    typewriterTextContext = new OffscreenCanvas(1, 1).getContext('2d')
  }
  if (!typewriterTextContext) return undefined
  const style = window.getComputedStyle(textarea)
  typewriterTextContext.font = style.font
  const inlineSize =
    textarea.clientWidth -
    cssLength(textarea, 'padding-inline-start') -
    cssLength(textarea, 'padding-inline-end')
  return calculateMarkdownSourceAnchorY({
    caretSourceOffset: transactionStore.selection.end,
    inlineSize,
    lineHeight,
    measureTextWidth: (text) =>
      typewriterTextContext?.measureText(text).width ?? 0,
    paddingBlockStart: cssLength(textarea, 'padding-block-start'),
    source: transactionStore.value,
  })
}
const applyTypewriterScroll = (
  trigger: 'input' | 'explicit-navigation' | 'async-layout' = 'input',
) => {
  if (sessionSurfacePaused.value || !resolvedWritingAids.value.typewriter || isComposing.value) return
  const textarea = textareaRef.value
  if (!textarea) return
  const response =
    trigger === 'explicit-navigation'
      ? writingAidsController.handleExplicitNavigation()
      : trigger === 'async-layout'
        ? writingAidsController.handleAsyncLayoutChange()
        : writingAidsController.handleInput()
  writingAidsState.value = writingAidsController.state
  if (response.scroll !== true) return
  const lineHeight =
    Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 20
  const target = writingAidsController.calculateScroll({
    caretSourceOffset: transactionStore.selection.end,
    lineHeight,
    source: transactionStore.value,
    stickyToolbarHeight: toolbarRef.value?.getBoundingClientRect().height,
    safeAreaInsetBottom: cssLength(
      textarea,
      '--el-markdown-editor-safe-area-inset-bottom',
    ),
    safeAreaInsetTop: cssLength(
      textarea,
      '--el-markdown-editor-safe-area-inset-top',
    ),
    sourceAnchorY: sourceAnchorY(textarea, lineHeight),
    reducedMotion: reducedMotionRequested(),
    viewportHeight: textarea.clientHeight,
    visualViewportHeight: visualViewportHeight.value || undefined,
    visualViewportOffsetTop: visualViewportOffsetTop.value || undefined,
  })
  restoringTypewriter = true
  if (typeof textarea.scrollTo === 'function') {
    const scrollTop = Math.min(
      target.scrollTop,
      Math.max(0, textarea.scrollHeight - textarea.clientHeight),
    )
    typewriterScrollTarget = scrollTop
    typewriterScrollSmooth =
      trigger !== 'async-layout' && target.smooth
    textarea.scrollTo({
      behavior:
        trigger === 'async-layout' ? 'auto' : target.smooth ? 'smooth' : 'auto',
      top: scrollTop,
    })
    requestTypewriterScrollFrame(() => {
      syncFocusLayerScroll(textarea.scrollTop)
    })
  } else {
    typewriterScrollTarget = target.scrollTop
    typewriterScrollSmooth = false
    textarea.scrollTop = target.scrollTop
    syncFocusLayerScroll(target.scrollTop)
  }
  requestTypewriterScrollFrame(() => {
    requestTypewriterScrollFrame(() => {
      restoringTypewriter = false
    })
  })
}
const refreshLiveReveal = (
  extras: {
    readonly intent?: MarkdownLiveRevealIntent
    readonly pointerOffset?: number
  } = {},
) => {
  const previousState = liveReveal.value.state
  liveReveal.value = resolveMarkdownLiveSyntaxReveal({
    composing: isComposing.value,
    documentIdentity,
    intent: extras.intent,
    mode: currentMode.value,
    pointerOffset: extras.pointerOffset,
    previous: liveReveal.value,
    selection: transactionStore.selection,
    source: transactionStore.value,
  })
  if (previousState === 'inactive' && liveReveal.value.state !== 'inactive') {
    applyLiveLayout('marker-reveal')
  } else if (
    previousState !== 'inactive' &&
    liveReveal.value.state === 'inactive'
  ) {
    applyLiveLayout('marker-hide')
  }
}

const applyLiveSelectionMotion = (
  motion: MarkdownLiveSelectionMotion,
  extras: {
    readonly dragOffset?: number
    readonly pointerOffset?: number
    readonly shift?: boolean
  } = {},
) => {
  const plan = resolveMarkdownLiveSelectionMotion({
    composing: isComposing.value,
    documentIdentity,
    dragOffset: extras.dragOffset,
    mode: currentMode.value,
    motion,
    pointerOffset: extras.pointerOffset,
    revision: transactionStore.revision,
    selection: captureSelection(false),
    session: atomicSession.value,
    shift: extras.shift,
    source: transactionStore.value,
  })
  liveAtomic.value = plan.atomic
  atomicSession.value = plan.atomic?.session ?? null
  if (!plan.transaction) return plan
  dispatchTransaction(plan.transaction)
  refreshLiveReveal()
  return plan
}

const applyAtomicIntent = (
  action: Parameters<typeof resolveMarkdownAtomicNodeIntent>[0]['action'],
) => {
  const plan = resolveMarkdownAtomicNodeIntent({
    action,
    composing: isComposing.value,
    documentIdentity,
    mode: currentMode.value,
    revision: transactionStore.revision,
    selection: captureSelection(),
    session: atomicSession.value,
    source: transactionStore.value,
  })
  liveAtomic.value = plan.state === 'unsupported' ? null : plan
  atomicSession.value = plan.session
  if (plan.transaction) dispatchTransaction(plan.transaction)
  refreshLiveReveal()
  return plan
}
const commandSessions = new Map<string, MarkdownEditorCommandSession>()
const commandResources = createMarkdownEditorSessionCommandResources(() => ({
  documentIdentity: transactionStore.documentIdentity,
  disposed: sessionDisposed,
  commands: props.commands,
}), isMarkdownEditorSessionOwnedCommand)
watch(() => props.commands, commandResources.observeConfiguredCommands, { flush: 'sync' })
const commandRuntimeStates = ref(
  new Map<string, MarkdownEditorCommandRuntimeState>(),
)
const invokeAtomicNodeAction = (
  nodeId: string,
  action: Parameters<typeof resolveMarkdownAtomicNodeIntent>[0]['action'],
) => {
  const plan = resolveMarkdownAtomicNodeIntent({
    action,
    composing: isComposing.value,
    documentIdentity,
    mode: currentMode.value,
    nodeId,
    revision: transactionStore.revision,
    selection: captureSelection(),
    source: transactionStore.value,
  })
  liveAtomic.value = plan.state === 'unsupported' ? null : plan
  atomicSession.value = plan.session
  if (plan.transaction) dispatchTransaction(plan.transaction)
  refreshLiveReveal()
  return plan
}
const commandContextSignal = new AbortController().signal

const abortPendingCommands = () => {
  commandResources.abortPending('editor-reset')
  for (const session of commandSessions.values()) {
    session.abort.abort('editor-reset')
    commandRuntimeStates.value.set(session.key, {
      state: 'aborted',
    })
  }
  abortMarkdownEditorCommandSessions(commandSessions.values(), 'editor-reset')
  commandSessions.clear()
  triggerRef(commandRuntimeStates)
}

type EditorOperation =
  | {
      readonly allowBlocked?: boolean
      readonly emitValue?: boolean
      readonly internalPropReset?: boolean
      readonly kind: 'transaction'
      readonly attachmentJob?: MarkdownAttachmentJob
      readonly observeTransaction?: (event: MarkdownEditorTransactionEvent) => void
      readonly mergeDirection?: MarkdownEditorInputMergeDirection
      readonly restoreSelection?: boolean
      readonly transaction: MarkdownEditorTransaction
    }
  | {
      readonly kind: 'undo' | 'redo'
      readonly restoreSelection?: boolean
    }

const nativeMachine = createMarkdownEditorNativeEventMachine({
  documentIdentity,
})
let beforeInputSnapshot: BeforeInputSnapshot | undefined
let pendingClipboardIdentity: string | undefined
let pendingInputOrigin: 'drop' | 'paste' | undefined
let restoringSelection = false

const syncNativeComposing = () => {
  isComposing.value = nativeMachine.composing
}

const historiesEqual = (
  first: MarkdownEditorHistoryState,
  second: MarkdownEditorHistoryState,
) =>
  first.undoDepth === second.undoDepth &&
  first.redoDepth === second.redoDepth &&
  first.retainedUnits === second.retainedUnits &&
  first.canUndo === second.canUndo &&
  first.canRedo === second.canRedo

const rejectedResult = (
  reason: MarkdownEditorTransactionRejection,
): MarkdownEditorDispatchResult =>
  Object.freeze({
    accepted: false,
    beforeRevision: transactionStore.revision,
    documentIdentity: transactionStore.documentIdentity,
    history: transactionStore.history,
    reason,
    revision: transactionStore.revision,
    selection: transactionStore.selection,
    value: transactionStore.value,
  })

const operationTransaction = (
  operation: EditorOperation,
): MarkdownEditorTransaction => {
  if (operation.kind === 'transaction') return operation.transaction
  return Object.freeze({
    changes: [],
    history: 'skip',
    metadata: Object.freeze({ action: operation.kind }),
    origin: 'command',
  })
}

let editorReleased = false
const isEditorDocumentCurrent = (
  identity: MarkdownEditorDispatchResult['documentIdentity'],
) =>
  !editorReleased && !sessionDisposed &&
  documentIdentity.id === identity.id &&
  documentIdentity.epoch === identity.epoch &&
  transactionStore.documentIdentity.id === identity.id &&
  transactionStore.documentIdentity.epoch === identity.epoch &&
  (props.documentIdentity?.id ?? commandTrayId) === identity.id &&
  (props.documentIdentity?.epoch ?? 0) === identity.epoch

const restoreTextareaSelection = async (
  selection: MarkdownEditorSelection,
  focus = true,
  isCurrentResult: () => boolean = () => true,
) => {
  const identity = transactionStore.documentIdentity
  const revision = transactionStore.revision
  const value = transactionStore.value
  const retainedSelection = transactionStore.selection
  const current = () => {
    const actualSelection = transactionStore.selection
    return isEditorDocumentCurrent(identity) &&
      transactionStore.revision === revision && transactionStore.value === value &&
      actualSelection.start === retainedSelection.start &&
      actualSelection.end === retainedSelection.end &&
      actualSelection.direction === retainedSelection.direction && isCurrentResult()
  }
  if (isComposing.value || !current()) return
  await sessionLayoutResources.afterTick((isCurrent) => {
    if (!isCurrent() || isComposing.value || !current()) return
    const textarea = textareaRef.value
    if (!textarea) return
    restoringSelection = true
    try {
      if (focus) textarea.focus()
      if (!isCurrent() || !current() || isComposing.value || textareaRef.value !== textarea) return
      textarea.setSelectionRange(selection.start, selection.end, selection.direction)
    } finally {
      sessionLayoutResources.microtask(() => { restoringSelection = false })
    }
  })
}

let pendingMetricsChange: MarkdownEditorMetricsChange | undefined

const performEditorOperation = (
  operation: EditorOperation,
): MarkdownEditorDispatchResult => {
  const transaction = operationTransaction(
    operation.kind === 'transaction'
      ? {
          ...operation,
          transaction: Object.freeze({
            ...operation.transaction,
            documentIdentity:
              operation.transaction.documentIdentity ?? documentIdentity,
          }),
        }
      : operation,
  )
  const blocked = editorReleased || sessionDisposed || (
    operation.kind === 'transaction'
      ? !operation.allowBlocked && editingBlocked.value
      : editingBlocked.value
  )
  const compositionBlocked =
    isComposing.value &&
    !(operation.kind === 'transaction' && operation.internalPropReset)
  if (blocked || compositionBlocked) {
    const result = rejectedResult(blocked ? 'disabled' : 'composition-active')
    emit('transaction', toMarkdownEditorTransactionEvent(transaction, result))
    return result
  }

  const previousValue = transactionStore.value
  const previousProjection = editorProjection.value
  const previousRevision = transactionStore.revision
  const previousSelection = transactionStore.selection
  const previousHistory = transactionStore.history
  const result =
    operation.kind === 'transaction'
      ? transactionStore.dispatch(transaction, {
          mergeDirection: operation.mergeDirection,
          now: Date.now(),
        })
      : operation.kind === 'undo'
        ? transactionStore.undo()
        : transactionStore.redo()
  const isCurrentResult = () =>
    result.accepted &&
    isEditorDocumentCurrent(result.documentIdentity) &&
    transactionStore.revision === result.revision &&
    transactionStore.value === result.value
  const isCurrentSelection = () => {
    const selection = transactionStore.selection
    return (
      isCurrentResult() &&
      selection.start === result.selection.start &&
      selection.end === result.selection.end &&
      selection.direction === result.selection.direction
    )
  }
  const isCurrentHistory = () =>
    isCurrentResult() &&
    historiesEqual(transactionStore.history, result.history)

  if (result.accepted && result.value !== previousValue) {
    pendingMetricsChange =
      operation.kind === 'transaction' &&
      operation.transaction.changes.length === 1
        ? operation.transaction.changes[0]
        : deriveMarkdownEditorChange(previousValue, result.value)
  }

  if (result.accepted && result.value !== previousValue) {
    const change = deriveMarkdownEditorChange(previousValue, result.value)
    if (change) {
      commandRevisionMaps.set(
        previousRevision,
        previousProjection
          ? createMarkdownEditorPositionMap([change], {
              documentIdentity,
              projection: previousProjection,
              source: previousValue,
            })
          : createMarkdownEditorPositionMap([change], {
              documentIdentity,
              source: previousValue,
            }),
      )
      while (commandRevisionMaps.size > 128) {
        const oldest = commandRevisionMaps.keys().next().value
        if (oldest === undefined) break
        commandRevisionMaps.delete(oldest)
      }
      refreshEditorProjection(previousValue, result.value)
    }
  }
  editorValue.value = result.value
  editorRevision.value = result.revision
  editorSelection.value = result.selection
  if (
    contextualSurface.value &&
    result.revision !== contextualSurfaceRevision.value
  ) {
    contextualSurface.value = null
    contextualError.value = ''
  }
  const transactionEvent = toMarkdownEditorTransactionEvent(transaction, result)
  const deletedItemIds: string[] = []
  const deletedJobs: MarkdownAttachmentJob[] = []
  const rebaseAttachments =
    result.accepted &&
    (result.value !== previousValue ||
      (operation.kind === 'transaction' && transaction.changes.length > 0))
  if (rebaseAttachments) {
    const appliedChanges =
      operation.kind === 'transaction'
        ? transaction.changes
        : (() => {
            const change = deriveMarkdownEditorChange(
              previousValue,
              result.value,
            )
            return change ? [change] : []
          })()
    const ownedJob =
      operation.kind === 'transaction' ? operation.attachmentJob : undefined
    for (const job of attachmentJobs.value) {
      if (
        (ownedJob && toRaw(job) === toRaw(ownedJob)) ||
        job.phase === 'deleted'
      )
        continue
      const rebasedJob = rebaseMarkdownAttachmentJob(
        job,
        appliedChanges,
        previousValue,
      )
      if (rebasedJob.phase === 'deleted') {
        deletedItemIds.push(job.itemId ?? job.id)
        deletedJobs.push(toRaw(job))
      }
    }
    if (ownedJob?.phase === 'deleted' && result.value !== previousValue) {
      deletedItemIds.push(ownedJob.itemId ?? ownedJob.id)
      deletedJobs.push(toRaw(ownedJob))
    }
    for (const job of deletedJobs) acceptAttachmentDeletion(job, result.documentIdentity)
  }
  // The private accepted observer installs this operation's jobs after its own
  // map, but before any abort listener or public callback can dispatch again.
  if (operation.kind === 'transaction')
    operation.observeTransaction?.(transactionEvent)
  if (rebaseAttachments) {
    revokeAttachmentFiles(deletedItemIds)
    for (const job of deletedJobs) retireAcceptedAttachmentDeletion(job)
    triggerRef(attachmentJobs)
  }
  // Keep the accepted transaction as historical evidence even after reentry.
  emit('transaction', transactionEvent)

  // Every outward callback can supersede this result, including selection-only
  // dispatches that retain its content revision. Check the relevant current state
  // again before each saved-value/selection/history effect.
  if (
    isCurrentResult() &&
    result.value !== previousValue &&
    (operation.kind !== 'transaction' || operation.emitValue !== false)
  ) {
    emit(UPDATE_MODEL_EVENT, result.value)
    if (isCurrentResult()) emit(CHANGE_EVENT, result.value)
    if (isCurrentResult()) refreshLiveWindow('input')
  }
  if (isCurrentResult()) refreshWritingAidsDocument()
  if (isCurrentResult() && result.value !== previousValue)
    applyTypewriterScroll()
  if (isCurrentResult()) syncLanguageToolsState()
  if (
    isCurrentSelection() &&
    (result.selection.start !== previousSelection.start ||
      result.selection.end !== previousSelection.end ||
      result.selection.direction !== previousSelection.direction)
  ) {
    emit(
      'selection-change',
      Object.freeze({
        documentIdentity: result.documentIdentity,
        revision: result.revision,
        selection: result.selection,
      }),
    )
  }
  if (isCurrentHistory() && !historiesEqual(previousHistory, result.history)) {
    emit('history-change', result.history)
  }
  if (isCurrentSelection() && operation.restoreSelection !== false) {
    void restoreTextareaSelection(result.selection, true, isCurrentSelection)
  }
  return result
}
const dispatchEditorOperation = (operation: EditorOperation): MarkdownEditorDispatchResult => {
  attachmentPublicationDepth += 1
  let published = false
  try {
    const result = performEditorOperation(operation)
    published = true
    return result
  } finally {
    attachmentPublicationDepth -= 1
    // Accepted transaction/model/selection/history effects finish before any
    // retirement reader can fail. Nested File cleanup drains only after unwind.
    if (published) flushAttachmentRetirement()
  }
}

const readSelectionFrom = (
  textarea: HTMLTextAreaElement | null,
): MarkdownEditorSelection => {
  if (!textarea) return transactionStore.selection
  return {
    direction: textarea.selectionDirection,
    end: textarea.selectionEnd,
    start: textarea.selectionStart,
  }
}

const captureSelection = (breakMerge = true) => {
  const previous = transactionStore.selection
  transactionStore.setSelection(
    readSelectionFrom(textareaRef.value),
    breakMerge,
  )
  const selection = transactionStore.selection
  editorSelection.value = selection
  if (
    selection.start !== previous.start ||
    selection.end !== previous.end ||
    selection.direction !== previous.direction
  ) {
    emit(
      'selection-change',
      Object.freeze({
        documentIdentity: transactionStore.documentIdentity,
        revision: transactionStore.revision,
        selection,
      }),
    )
  }
  selectionTick.value += 1
  return selection
}

const refreshCurrentTableCell = (offset = transactionStore.selection.start) => {
  const previousCellId = currentTableCell.value?.cellId
  const nextCell = resolveMarkdownTableCellAtOffset(
    transactionStore.value,
    documentIdentity,
    offset,
  )
  currentTableCell.value = nextCell
  if (!nextCell || (previousCellId && nextCell.cellId !== previousCellId)) {
    tableMenuOpen.value = false
  }
  return nextCell
}

const selectTableCell = async (cell: MarkdownTableCellIdentity) => {
  const resolved = resolveMarkdownTableCellCoordinates(
    transactionStore.value,
    documentIdentity,
    cell.tableId,
    cell.row,
    cell.column,
    cell.cellId,
  )
  if (!resolved?.anchor) {
    currentTableCell.value = null
    return
  }
  currentTableCell.value = resolved
  transactionStore.setSelection(
    {
      direction: 'none',
      end: resolved.anchor.end,
      start: resolved.anchor.start,
    },
    true,
  )
  await restoreTextareaSelection(transactionStore.selection)
}

const captureAttachmentFiles = (
  sourceKind: MarkdownAttachmentSourceKind,
  files: readonly File[],
  selection: MarkdownEditorSelection,
  eventFingerprint?: string,
  nodeId: string | null = null,
) => {
  if (attachmentPauseRequested.value || sessionDisposed || editorReleased ||
    !isEditorDocumentCurrent(transactionStore.documentIdentity)) return
  const controller = new AbortController()
  const fileControllers = files.map(() => new AbortController())
  const captured = captureMarkdownAttachmentInput({
    sourceKind,
    documentIdentity: Object.freeze({ ...documentIdentity }),
    signal: controller.signal,
    revision: transactionStore.revision,
    anchor: { range: selection, nodeId },
    files: files.map((file, index) => ({
      signal: fileControllers[index]!.signal,
      name: file.name,
      mimeType: file.type,
      byteLength: file.size,
    })),
    context: {
      readonly: props.readonly,
      disabled: inputDisabled.value,
      mode: currentMode.value,
      isComposing: isComposing.value,
      currentRevision: transactionStore.revision,
    },
    eventFingerprint,
    session: attachmentCaptureSession,
  })
  if (!captured.ok) return captured

  const planned = planMarkdownAttachmentInsert(
    transactionStore.value,
    captured.batch.anchor,
    captured.batch,
    localeText.value.attachments.uploading,
  )
  const placements = Object.freeze(
    planned.jobs.map((job, index) =>
      Object.freeze({
        item: captured.batch.items[index]!,
        range: Object.freeze(job.range!),
      }),
    ),
  )
  let transactionEvent: MarkdownEditorTransactionEvent | undefined
  const dispatched = dispatchTransaction(
    {
      ...planned.transaction,
      documentIdentity: captured.batch.documentIdentity,
      expectedRevision: captured.batch.revision,
    },
    (event) => {
      transactionEvent = event
      if (!event.accepted) return
      // Reentrant edits must map the actual original accepted jobs. Files remain
      // unregistered until those jobs survive all synchronous dispatch callbacks.
      for (const item of captured.batch.items)
        attachmentItems.set(item.itemId, item)
      for (const [index, job] of planned.jobs.entries()) {
        attachmentJobBindings.set(toRaw(job), Object.freeze({
          batch: captured.batch, item: captured.batch.items[index]!,
        }))
      }
      attachmentJobs.value = [...attachmentJobs.value, ...planned.jobs]
    },
  )
  const placementsCurrent = planned.jobs.every((job, index) => {
    const item = captured.batch.items[index]!
    const placement = placements[index]!
    const range = job.range
    return (
      attachmentJobs.value.some((candidate) => toRaw(candidate) === job) &&
      attachmentItems.get(item.itemId) === item &&
      job.itemId === item.itemId &&
      job.batchId === captured.batch.batchId &&
      attachmentJobBindings.get(toRaw(job))?.batch === captured.batch &&
      attachmentJobBindings.get(toRaw(job))?.item === item &&
      job.documentIdentity?.id === captured.batch.documentIdentity.id &&
      job.documentIdentity?.epoch === captured.batch.documentIdentity.epoch &&
      job.revision === captured.batch.revision &&
      job.attempt === 1 &&
      (job.phase === 'pending' || job.phase === 'progress') &&
      !captured.batch.signal.aborted &&
      !item.signal.aborted &&
      range &&
      range.start >= 0 &&
      range.start < range.end &&
      range.end <= transactionStore.value.length &&
      transactionStore.value.slice(range.start, range.end) ===
        transactionEvent?.value.slice(
          placement.range.start,
          placement.range.end,
        )
    )
  })
  if (
    editorReleased ||
    !dispatched.accepted ||
    !transactionEvent ||
    !placementsCurrent ||
    transactionStore.revision !== dispatched.revision ||
    documentIdentity.id !== captured.batch.documentIdentity.id ||
    documentIdentity.epoch !== captured.batch.documentIdentity.epoch ||
    captured.batch.documentIdentity.id !==
      (props.documentIdentity?.id ?? commandTrayId) ||
    captured.batch.documentIdentity.epoch !==
      (props.documentIdentity?.epoch ?? 0)
  ) {
    // Retire only this original capture before its signals invoke more listeners.
    attachmentJobs.value = attachmentJobs.value.filter(
      (job) => !planned.jobs.includes(toRaw(job)),
    )
    for (const item of captured.batch.items) {
      if (attachmentItems.get(item.itemId) === item)
        attachmentItems.delete(item.itemId)
    }
    controller.abort()
    for (const itemController of fileControllers) itemController.abort()
    return captured
  }

  const capture = Object.freeze({
    batch: captured.batch,
    transaction: transactionEvent,
    plan: planned,
    placements,
  })
  attachmentBatches.set(captured.batch.batchId, {
    batch: captured.batch,
    capture,
    controller,
    files: new Map(
      captured.batch.items.map((item, index) => [
        item,
        {
          file: files[index]!,
          controller: fileControllers[index]!,
        },
      ]),
    ),
  })
  dispatchAttachmentBatch(captured.batch, capture)
  return captured
}

const resolveDropSelection = (
  event: DragEvent,
): MarkdownEditorSelection | null => {
  const textarea = textareaRef.value
  if (!textarea || typeof document === 'undefined') return null
  const caretDocument = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { readonly offset: number; readonly offsetNode: Node } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const position = caretDocument.caretPositionFromPoint?.(
    event.clientX,
    event.clientY,
  )
  const range = position
    ? null
    : caretDocument.caretRangeFromPoint?.(event.clientX, event.clientY)
  const offset =
    position?.offsetNode === textarea
      ? position.offset
      : range?.startContainer === textarea
        ? range.startOffset
        : null
  if (offset === null) return null

  const bounded = Math.max(0, Math.min(transactionStore.value.length, offset))
  const anchorMap = createMarkdownAnchorMap({
    identity: documentIdentity,
    source: transactionStore.value,
  })
  const mapped = anchorMap.visualAnchorToSourceSelection(
    anchorMap.sourceRangeToVisual({ start: bounded, end: bounded }),
  )
  return Object.freeze({
    direction: 'none' as const,
    start: mapped.anchor,
    end: mapped.focus,
  })
}

const dispatchReplacement = (
  nextValue: string,
  selection: MarkdownEditorSelection,
  options: Omit<MarkdownEditorTransaction, 'changes' | 'selection'>,
  mergeDirection: MarkdownEditorInputMergeDirection = 'none',
) => {
  const change = deriveMarkdownEditorChange(transactionStore.value, nextValue)
  return dispatchEditorOperation({
    kind: 'transaction',
    mergeDirection,
    transaction: {
      ...options,
      changes: change ? [change] : [],
      selection,
    },
  })
}

watch(
  [() => props.mode, () => props.defaultMode, () => props.mobileLayout],
  ([mode, defaultMode]) => {
    transactionStore.breakMergeGroup()
    currentMode.value = normalizeModeForLayout(mode ?? defaultMode)
    refreshWritingAidsDocument()
    syncLanguageToolsState()
  },
)

watch(
  [() => props.lang, () => props.nativeWritingTools, () => props.spellcheck],
  () => syncLanguageToolsState(),
)

watch(
  () => props.modelValue,
  (value) => {
    if (value === transactionStore.value) return

    abortPendingCommands()
    // Document switch: pending frame tasks from the previous document must
    // not commit geometry into the new document (#640 stale cancellation).
    frameScheduler.cancelAll()
    // One settle frame samples the scheduler so evidence can observe that no
    // stale task survived the document switch.
    frameScheduler.schedulePostPaint('frame-metrics-settle', () => undefined)
    nativeMachine.apply({
      documentIdentity,
      kind: 'external-reset',
      revision: transactionStore.revision,
      value,
    })
    syncNativeComposing()
    beforeInputSnapshot = undefined
    pendingClipboardIdentity = undefined
    pendingInputOrigin = undefined
    const result = dispatchEditorOperation({
      allowBlocked: true,
      emitValue: false,
      internalPropReset: true,
      kind: 'transaction',
      restoreSelection: false,
      transaction: {
        changes: [
          {
            from: 0,
            insert: value,
            to: transactionStore.value.length,
          },
        ],
        history: 'skip',
        externalUpdate: 'reset',
        metadata: Object.freeze({ kind: 'external-reset' }),
        origin: 'external',
        selection: {
          direction: transactionStore.selection.direction,
          end: value.length,
          start: value.length,
        },
      },
    })
    if (result.accepted) {
      currentTableCell.value = null
      tableMenuOpen.value = false
    }
  },
)

watch(
  [
    () => props.writingAids,
    () => props.editorProfile,
    () => props.focusExemptions,
    () => props.readonly,
    () => props.disabled,
  ],
  () => refreshWritingAidsDocument(),
  { deep: true },
)

const metricsSession = createMarkdownEditorMetricsSession(props.metrics)
let metricsSource = editorValue.value
const editorMetrics = ref(
  metricsSession.calculate(metricsSource, {
    ...props.metrics,
    includeBytes: props.statusDensity === 'detailed',
    selection: editorSelection.value,
  }),
)
watch(
  [
    editorValue,
    editorSelection,
    () => props.metrics,
    () => props.statusDensity,
  ],
  ([value, selection, options, density]) => {
    const change =
      pendingMetricsChange ??
      deriveMarkdownEditorChange(metricsSource, value) ?? {
        from: 0,
        insert: '',
        to: 0,
      }
    pendingMetricsChange = undefined
    metricsSource = value
    editorMetrics.value = metricsSession.calculate(value, {
      ...options,
      change,
      includeBytes: density === 'detailed',
      selection,
    })
  },
  { deep: true },
)

const liveCapabilities = computed(() => [
  liveSurface.value.capability.capability,
])

const statusResolution = computed(() =>
  resolveMarkdownEditorStatus(
    editorValue.value,
    props.statusDensity,
    props.localeText,
    editorSelection.value,
    liveCapabilities.value,
    {
      mode: currentMode.value,
      readonly: editingBlocked.value,
      disabled: props.disabled,
      loading: props.loading,
    },
    editorMetrics.value,
  ),
)

const selectionToolbarCommands = computed(() =>
  selectMarkdownEditorCommandSnapshot(commandSnapshot.value, 'selection').map(
    (item) => item.command,
  ),
)
const selectionToolbarPlacement = computed(() =>
  resolveMarkdownSelectionToolbarPlacement(
    editorSelection.value,
    editorRevision.value,
    editorRevision.value,
    {
      anchorMap: editorAnchorMap.value,
      documentEpoch: documentIdentity.epoch,
      expectedEpoch: documentIdentity.epoch,
    },
  ),
)
const dismissedSelectionRevision = ref<number | null>(null)
const selectionToolbarVisible = computed(
  () =>
    selectionToolbarPlacement.value.visible &&
    dismissedSelectionRevision.value !== editorRevision.value,
)
const selectionToolbarAnchorId = computed(
  () => selectionToolbarPlacement.value.visual?.anchor.anchorId ?? '',
)
const closeSelectionToolbar = () => {
  dismissedSelectionRevision.value = editorRevision.value
  textareaRef.value?.focus()
}
const contextualSurface = ref<'anchor-properties' | 'link-properties' | null>(
  null,
)
const contextualSurfaceEpoch = ref(documentIdentity.epoch)
const contextualSurfaceRevision = ref(editorRevision.value)
const contextualError = ref('')
const linkLabelDraft = ref('')
const linkDestinationDraft = ref('')
const linkTitleDraft = ref('')
const anchorIdDraft = ref('')
const currentSyntaxNode = computed(() => {
  const syntax = editorProjection.value
    ? resolveMarkdownEditorSyntaxContext(
        editorProjection.value,
        editorSelection.value,
      )
    : undefined
  return syntax && editorProjection.value
    ? editorProjection.value.resolve(syntax.nodeId).node
    : undefined
})
const activeLink = computed<MarkdownParsedLink | undefined>(() => {
  const node = currentSyntaxNode.value
  return node?.kind === 'link'
    ? parseMarkdownLinkNode(editorValue.value, node)
    : undefined
})
const activeLinkNodeId = computed(() => activeLink.value?.nodeId ?? '')
const activeAnchor = computed<MarkdownProjectedAnchor | undefined>(() => {
  const syntax = currentSyntaxNode.value
  if (syntax?.kind !== 'anchor') return undefined
  if (!editorProjection.value) return undefined
  return currentMarkdownAnchors(editorValue.value, editorProjection.value).find(
    (anchor) => anchor.projectionId === syntax.id,
  )
})
const activeAnchorNodeId = computed(
  () => activeAnchor.value?.projectionId ?? '',
)
const closeContextualSurface = async (restore = true) => {
  contextualSurface.value = null
  contextualError.value = ''
  if (restore) await restoreTextareaSelection(editorSelection.value)
}
const openContextualSurface = async (
  surface: 'anchor-properties' | 'link-properties',
) => {
  contextualError.value = ''
  contextualSurfaceEpoch.value = documentIdentity.epoch
  contextualSurfaceRevision.value = editorRevision.value
  if (surface === 'link-properties') {
    const link = activeLink.value
    if (!link || link.kind === 'unsupported') return
    linkLabelDraft.value = link.labelText
    linkDestinationDraft.value = link.url ?? ''
    linkTitleDraft.value = link.title ?? ''
  } else {
    anchorIdDraft.value = activeAnchor.value?.id ?? ''
  }
  contextualSurface.value = surface
  await sessionLayoutResources.afterTick(() => {
    contextualSurfaceRef.value?.querySelector<HTMLInputElement>('input')?.focus()
  })
}
const contextualSurfaceRef = ref<HTMLElement | null>(null)
const contextualSurfaceIsCurrent = () =>
  contextualSurfaceEpoch.value === documentIdentity.epoch &&
  contextualSurfaceRevision.value === editorRevision.value
const applyLinkProperties = () => {
  const link = activeLink.value
  if (!link || !contextualSurfaceIsCurrent()) {
    contextualError.value = localeText.value.results.stale
    return
  }
  if (link.ranges.destination) {
    const validation = validateMarkdownPropertyUrl(linkDestinationDraft.value, {
      documentEpoch: documentIdentity.epoch,
      nodeId: link.nodeId,
      revision: editorRevision.value,
      value: linkDestinationDraft.value,
      version: 1,
    })
    if (!validation.open.allowed) {
      contextualError.value = localeText.value.contextual.unsafeUrl
      return
    }
  }
  const result = dispatchTransaction(
    planMarkdownLinkPropertyEdit(
      editorValue.value,
      link,
      {
        label: linkLabelDraft.value,
        ...(link.ranges.destination ? { url: linkDestinationDraft.value } : {}),
        ...(link.kind === 'inline' &&
        (link.title !== undefined || linkTitleDraft.value)
          ? { title: linkTitleDraft.value }
          : {}),
      },
      contextualSurfaceRevision.value,
    ),
  )
  if (result.accepted) void closeContextualSurface()
}
const removeActiveLink = () => {
  const link = activeLink.value
  if (!link || !contextualSurfaceIsCurrent()) {
    contextualError.value = localeText.value.results.stale
    return
  }
  const result = dispatchTransaction({
    ...planMarkdownLinkUnwrap(editorValue.value, link),
    expectedRevision: contextualSurfaceRevision.value,
  })
  if (result.accepted) void closeContextualSurface()
}
const revealActiveLink = () => {
  const link = activeLink.value
  if (!link || !contextualSurfaceIsCurrent()) return
  const anchorMap = editorAnchorMap.value
  if (!anchorMap) return
  const reveal = anchorMap.sourceRangeToReveal(link.ranges.full)
  const result = dispatchTransaction({
    changes: [],
    expectedRevision: contextualSurfaceRevision.value,
    history: 'skip',
    metadata: Object.freeze({
      anchorId: reveal.reveal.anchorId,
      action: 'source-reveal',
    }),
    origin: 'command',
    selection: {
      start: reveal.reveal.range.start,
      end: reveal.reveal.range.end,
    },
  })
  if (result.accepted) void closeContextualSurface()
}
const copyActiveLink = async () => {
  const link = activeLink.value
  if (!link || !contextualSurfaceIsCurrent()) return
  try {
    await navigator.clipboard.writeText(link.url ?? link.labelText)
  } catch {
    contextualError.value = localeText.value.pasteAsMarkdown.clipboardFailed
  }
}
const openActiveLink = () => {
  const link = activeLink.value
  if (!link?.url || !contextualSurfaceIsCurrent()) return
  const validation = validateMarkdownPropertyUrl(link.url, {
    documentEpoch: documentIdentity.epoch,
    nodeId: link.nodeId,
    revision: editorRevision.value,
    value: link.url,
    version: 1,
  })
  if (!validation.open.allowed) {
    contextualError.value = localeText.value.contextual.unsafeUrl
    return
  }
  window.open(validation.open.href, validation.open.target, validation.open.rel)
}
const applyAnchorProperties = () => {
  if (!contextualSurfaceIsCurrent()) {
    contextualError.value = localeText.value.results.stale
    return
  }
  let transaction: MarkdownEditorTransaction
  try {
    transaction = activeAnchor.value
      ? planMarkdownAnchorEdit(
          editorValue.value,
          activeAnchor.value,
          anchorIdDraft.value,
          editorProjection.value,
        )
      : planMarkdownAnchorInsert(
          editorValue.value,
          editorSelection.value.start,
          anchorIdDraft.value,
          { projection: editorProjection.value },
        )
  } catch {
    contextualError.value = localeText.value.contextual.invalidAnchor
    return
  }
  const result = dispatchTransaction({
    ...transaction,
    expectedRevision: contextualSurfaceRevision.value,
  })
  if (result.accepted) void closeContextualSurface()
}
const removeActiveAnchor = () => {
  const anchor = activeAnchor.value
  if (!anchor || !contextualSurfaceIsCurrent()) return
  const result = dispatchTransaction({
    ...planMarkdownAnchorRemove(
      anchor,
      editorValue.value,
      editorProjection.value,
    ),
    expectedRevision: contextualSurfaceRevision.value,
  })
  if (result.accepted) void closeContextualSurface()
}
const copyActiveAnchor = async () => {
  const anchor = activeAnchor.value
  if (!anchor || !contextualSurfaceIsCurrent()) return
  try {
    await navigator.clipboard.writeText(planMarkdownAnchorCopy(anchor, 'exact'))
  } catch {
    contextualError.value = localeText.value.pasteAsMarkdown.clipboardFailed
  }
}

const slashTrigger = computed(() => {
  if (
    !surfaceOptions.value.slashMenu ||
    editingBlocked.value ||
    isComposing.value
  )
    return null
  return resolveMarkdownSlashTrigger(
    editorValue.value,
    editorSelection.value.start,
    {
      blockOnly: true,
      documentEpoch: documentIdentity.epoch,
      isComposing: isComposing.value,
      projection: editorProjection.value,
      revision: editorRevision.value,
    },
  )
})
const slashCommands = computed(() => {
  if (!slashTrigger.value) return []
  return searchMarkdownEditorCommandSnapshot(
    commandSnapshot.value,
    slashTrigger.value.query,
    'slash',
  ).map((item) => item.command)
})
const activeSlashIndex = ref(0)
const dismissedSlashTrigger = ref('')
const activeSlashTrigger = computed(() => {
  const trigger = slashTrigger.value
  if (!trigger) return null
  if (
    trigger.documentEpoch !== documentIdentity.epoch ||
    trigger.revision !== editorRevision.value ||
    (trigger.nodeId &&
      editorProjection.value?.resolve(trigger.nodeId).status !== 'current')
  )
    return null
  const identity = `${trigger.documentEpoch}:${trigger.revision}:${trigger.nodeId ?? 'document'}:${trigger.range.start}:${trigger.range.end}`
  return dismissedSlashTrigger.value === identity ? null : trigger
})
const closeSlashMenu = () => {
  const trigger = slashTrigger.value
  if (trigger) {
    dismissedSlashTrigger.value = `${trigger.documentEpoch}:${trigger.revision}:${trigger.nodeId ?? 'document'}:${trigger.range.start}:${trigger.range.end}`
  }
  textareaRef.value?.focus()
}
const executeSlashCommand = (command: MarkdownEditorCommand) => {
  if (!activeSlashTrigger.value) return
  if (isCommandDisabled(command)) return
  void runCommand(command, activeSlashTrigger.value.range)
}
const slashItemId = (key: string) =>
  `${slashMenuId}-${key.replace(/[^a-zA-Z0-9_-]/gu, '-')}`
const moveSlashIndex = (direction: 1 | -1) => {
  if (!slashCommands.value.length) return
  for (let step = 1; step <= slashCommands.value.length; step += 1) {
    const candidate =
      (activeSlashIndex.value + direction * step + slashCommands.value.length) %
      slashCommands.value.length
    const command = slashCommands.value[candidate]
    if (command && !isCommandDisabled(command)) {
      activeSlashIndex.value = candidate
      return
    }
  }
}
const commandPaletteOpen = ref(false)
const commandPaletteDirection = ref<'ltr' | 'rtl'>('ltr')
const paletteQuery = ref('')
const activePaletteIndex = ref(0)
const paletteRestoreSelection = ref<MarkdownEditorSelection | null>(null)
const paletteCommandItems = computed(() =>
  searchMarkdownEditorCommandSnapshot(
    commandSnapshot.value,
    paletteQuery.value,
  ),
)
const paletteCommands = computed(() =>
  paletteCommandItems.value.map((item) => item.command),
)
const paletteCommandGroups = computed(() =>
  groupMarkdownEditorCommandSnapshot(paletteCommandItems.value),
)
const activePaletteCommand = computed(
  () => paletteCommands.value[activePaletteIndex.value],
)
const paletteItemId = (key: string) =>
  `${paletteListId}-${key.replace(/[^a-zA-Z0-9_-]/gu, '-')}`
const paletteItemIndex = (key: string) =>
  paletteCommands.value.findIndex((command) => command.key === key)
const openCommandPalette = () => {
  if (editingBlocked.value || isComposing.value) return
  const directionOwner = rootElementRef.value
  const declaredDirection =
    directionOwner?.closest<HTMLElement>('[dir]')?.dir ?? ''
  commandPaletteDirection.value =
    declaredDirection === 'rtl' ||
    (declaredDirection !== 'ltr' &&
      directionOwner &&
      getComputedStyle(directionOwner).direction === 'rtl')
      ? 'rtl'
      : 'ltr'
  paletteRestoreSelection.value = captureSelection(false)
  commandPaletteOpen.value = true
  paletteQuery.value = ''
  activePaletteIndex.value = Math.max(
    0,
    paletteCommands.value.findIndex((command) => !isCommandDisabled(command)),
  )
  void sessionLayoutResources.afterTick(() => commandPaletteInputRef.value?.focus())
}
const closeCommandPalette = () => {
  commandPaletteOpen.value = false
  const selection = paletteRestoreSelection.value
  paletteRestoreSelection.value = null
  if (selection) {
    void restoreTextareaSelection(selection)
  } else {
    textareaRef.value?.focus()
  }
}
const movePaletteIndex = (direction: 1 | -1) => {
  if (!paletteCommands.value.length) return
  for (let step = 1; step <= paletteCommands.value.length; step += 1) {
    const candidate =
      (activePaletteIndex.value +
        direction * step +
        paletteCommands.value.length) %
      paletteCommands.value.length
    const command = paletteCommands.value[candidate]
    if (command && !isCommandDisabled(command)) {
      activePaletteIndex.value = candidate
      return
    }
  }
}
const selectNextPaletteItem = () => movePaletteIndex(1)
const selectPreviousPaletteItem = () => movePaletteIndex(-1)
const executeActivePaletteItem = (event: KeyboardEvent) => {
  if (event.isComposing || event.keyCode === 229 || isComposing.value) return
  event.preventDefault()
  const command = paletteCommands.value[activePaletteIndex.value]
  if (command && !isCommandDisabled(command)) {
    executePaletteCommand(command)
  }
}
const executePaletteCommand = (command: MarkdownEditorCommand) => {
  if (isCommandDisabled(command)) return
  closeCommandPalette()
  activateCommand(command)
}
const handleCommandPaletteKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeCommandPalette()
    return
  }
  if (event.key !== 'Tab') return
  const controls = [
    commandPaletteInputRef.value,
    ...Array.from(
      document
        .getElementById(paletteListId)
        ?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    ),
  ].filter(
    (control): control is HTMLInputElement | HTMLButtonElement =>
      control !== null,
  )
  if (!controls.length) return
  const currentIndex = controls.indexOf(
    document.activeElement as HTMLInputElement | HTMLButtonElement,
  )
  const nextIndex = event.shiftKey
    ? (currentIndex - 1 + controls.length) % controls.length
    : (currentIndex + 1) % controls.length
  event.preventDefault()
  controls[nextIndex]?.focus()
}
const characterCount = computed(() => editorMetrics.value.graphemeCount)
const effectivePlaceholder = computed(
  () => props.writingPlaceholder || props.placeholder,
)
const editorStyle = computed<Record<string, string> | undefined>(() =>
  visualViewportHeight.value > 0
    ? {
        '--el-markdown-editor-visual-viewport-height': `${visualViewportHeight.value}px`,
      }
    : undefined,
)
const commandContext = computed(() => ({
  dispatch: {
    dispatch: (transaction: MarkdownEditorTransaction) =>
      dispatchEditorOperation({ kind: 'transaction', transaction }),
  },
  documentIdentity,
  mode: currentMode.value,
  ...(editorProjection.value
    ? {
        positionMap: createMarkdownEditorPositionMap([], {
          documentIdentity,
          projection: editorProjection.value,
          source: editorValue.value,
        }),
        projection: editorProjection.value,
      }
    : {}),
  readonly: editingBlocked.value,
  revision: editorRevision.value,
  selection: editorSelection.value,
  signal: commandContextSignal,
  syntax: editorProjection.value
    ? resolveMarkdownEditorSyntaxContext(
        editorProjection.value,
        editorSelection.value,
      )
    : undefined,
  value: transactionStore.value,
}))
const commandSnapshot = computed(() =>
  createMarkdownEditorCommandSnapshot(
    props.commands,
    commandContext.value,
    commandRuntimeStates.value,
  ),
)
const toolbarCommands = computed(() =>
  selectMarkdownEditorCommandSnapshot(commandSnapshot.value, 'toolbar').map(
    (item) => item.command,
  ),
)
const gatedPasteAsMarkdownCommand = computed(() =>
  pasteAsMarkdownGate.value &&
  !resolveMarkdownEditorPrimaryCommands(
    toolbarCommands.value,
    effectiveToolbarDensity.value,
    props.primaryCommandKeys,
  ).some((command) => command.key === 'paste-as-markdown')
    ? toolbarCommands.value.find(
        (command) => command.key === 'paste-as-markdown',
      )
    : undefined,
)
const localeText = computed(() =>
  resolveMarkdownEditorLocaleText(props.localeText),
)
const commandCopy = (command: MarkdownEditorCommand) =>
  resolveMarkdownEditorCommandCopy(command, localeText.value)
const commandName = (command: MarkdownEditorCommand) =>
  commandCopy(command).name
const commandGroupName = (group: string) =>
  localeText.value.commandGroups[group] ?? group
const pasteAsMarkdownGateDescription = computed(() => {
  const gate = pasteAsMarkdownGate.value
  return gate ? localeText.value.pasteAsMarkdown.disabledDescriptions[gate] : ''
})
const pasteAsMarkdownRejectionText = (
  rejection: MarkdownPasteAsMarkdownRejection,
) => {
  if (rejection === 'composition-active') {
    return localeText.value.pasteAsMarkdown.disabledDescriptions.composition
  }
  if (rejection === 'readonly') {
    return localeText.value.pasteAsMarkdown.disabledDescriptions.readonly
  }
  if (rejection === 'disabled') {
    return localeText.value.pasteAsMarkdown.disabledDescriptions.disabled
  }
  if (rejection === 'preview-only') {
    return localeText.value.pasteAsMarkdown.disabledDescriptions.previewOnly
  }
  return localeText.value.pasteAsMarkdown.stale
}
const isPasteAsMarkdownCommand = (command: MarkdownEditorCommand) =>
  command.key === 'paste-as-markdown'
const commandSnapshotItem = (command: MarkdownEditorCommand) =>
  commandSnapshot.value.find((item) => item.key === command.key)
const isCommandDisabled = (command: MarkdownEditorCommand) => {
  const item = commandSnapshotItem(command)
  return (
    editingBlocked.value ||
    item?.enabled === false ||
    (isPasteAsMarkdownCommand(command) &&
      (Boolean(pasteAsMarkdownGate.value) || pasteAsMarkdownBusy.value))
  )
}
watch(slashCommands, (commands) => {
  if (!commands.length) {
    activeSlashIndex.value = 0
    return
  }
  if (
    activeSlashIndex.value >= commands.length ||
    isCommandDisabled(commands[activeSlashIndex.value]!)
  ) {
    activeSlashIndex.value = 0
    if (isCommandDisabled(commands[0]!)) moveSlashIndex(1)
  }
})
watch(paletteCommands, (commands) => {
  if (!commands.length) {
    activePaletteIndex.value = 0
    return
  }
  if (
    activePaletteIndex.value >= commands.length ||
    isCommandDisabled(commands[activePaletteIndex.value]!)
  ) {
    activePaletteIndex.value = 0
    if (isCommandDisabled(commands[0]!)) movePaletteIndex(1)
  }
})
const commandStateId = (key: string) =>
  `${commandTrayId}-command-state-${key.replace(/[^a-zA-Z0-9_-]/gu, '-')}`
const commandStateText = (item: MarkdownEditorCommandSnapshotItem) => {
  if (item.disabledReason && item.state === 'idle') return item.disabledReason
  if (item.state === 'idle') return ''
  return localeText.value.results[item.state]
}
const commandDescriptionId = (command: MarkdownEditorCommand) => {
  if (isPasteAsMarkdownCommand(command) && pasteAsMarkdownGate.value) {
    return pasteAsMarkdownDescriptionId
  }
  const item = commandSnapshotItem(command)
  return item && commandStateText(item)
    ? commandStateId(command.key)
    : undefined
}
const primaryCommands = computed(() =>
  resolveMarkdownEditorPrimaryCommands(
    toolbarCommands.value,
    effectiveToolbarDensity.value,
    props.primaryCommandKeys,
  ),
)
const overflowCommands = computed(() =>
  resolveMarkdownEditorOverflowCommands(
    toolbarCommands.value,
    effectiveToolbarDensity.value,
    props.primaryCommandKeys,
  ),
)
const visibleActions = computed<MarkdownEditorActionItem[]>(() => {
  if (!props.showActions) return []

  const actions: MarkdownEditorActionItem[] = []
  if (props.showImageAction) {
    actions.push({
      key: 'image',
      label: props.imageActionLabel ?? localeText.value.actions.image,
    })
  }
  if (props.showSaveAction) {
    actions.push({
      key: 'save',
      label: props.saveActionLabel ?? localeText.value.actions.save,
    })
  }
  if (props.showSubmitAction) {
    actions.push({
      key: 'submit',
      label: props.submitActionLabel ?? localeText.value.actions.submit,
    })
  }
  return actions
})
const actionOverflowKeySet = computed(
  () => new Set<MarkdownEditorActionKey>(props.actionOverflowKeys),
)
const primaryActions = computed(() =>
  visibleActions.value.filter(
    (action) => !actionOverflowKeySet.value.has(action.key),
  ),
)
const overflowActions = computed(() =>
  visibleActions.value.filter((action) =>
    actionOverflowKeySet.value.has(action.key),
  ),
)
const overflowItemCount = computed(
  () => overflowCommands.value.length + overflowActions.value.length,
)
watch([editingBlocked, overflowItemCount], ([blocked, itemCount]) => {
  if (blocked || !itemCount) commandsExpanded.value = false
  if (!blocked) return

  transactionStore.breakMergeGroup()
  if (isComposing.value) {
    nativeMachine.apply({
      documentIdentity,
      kind: 'external-reset',
      revision: transactionStore.revision,
    })
    syncNativeComposing()
    beforeInputSnapshot = undefined
    pendingClipboardIdentity = undefined
    pendingInputOrigin = undefined
    triggerRef(editorValue)
  }
})
watch(
  [() => props.documentIdentity?.id, () => props.documentIdentity?.epoch],
  ([id, epoch], [previousId, previousEpoch]) => {
    const nextId = id ?? commandTrayId
    const nextEpoch = epoch ?? 0
    if (nextId === previousId && nextEpoch === previousEpoch) return

    const previousHistory = transactionStore.history
    // Old geometry continuations remain guarded; release their owned handles
    // and transient flags explicitly instead of executing stale layout work.
    cancelOwnedTypewriterFrames()
    languageToolsController?.cancelSearch()
    clearSearchViewAliases()
    abortPendingCommands()
    commandPaletteOpen.value = false
    contextualSurface.value = null
    contextualError.value = ''
    paletteRestoreSelection.value = null
    commandsExpanded.value = false
    dismissedSlashTrigger.value = ''
    pasteAsMarkdownSession.value = null
    pasteAsMarkdownError.value = ''
    beforeInputSnapshot = undefined
    pendingClipboardIdentity = undefined
    pendingInputOrigin = undefined
    atomicSession.value = null
    liveAtomic.value = null
    releaseAttachmentFiles()

    documentIdentity.id = nextId
    documentIdentity.epoch = nextEpoch
    commandRevisionMaps.clear()
    nativeMachine.apply({
      documentIdentity,
      kind: 'external-reset',
      revision: transactionStore.revision,
      value: props.modelValue,
    })
    syncNativeComposing()

    transactionStore.switchDocument(documentIdentity, props.modelValue)
    const result = {
      history: transactionStore.history,
      revision: transactionStore.revision,
      selection: transactionStore.selection,
      value: transactionStore.value,
    }
    previousEditorProjection = undefined
    previousEditorProjectionSource = ''
    editorValue.value = result.value
    editorRevision.value = result.revision
    editorSelection.value = result.selection
    refreshLiveWindow('input')
    refreshLiveReveal()
    void restoreTextareaSelection(result.selection)
    if (!historiesEqual(previousHistory, result.history)) {
      emit('history-change', result.history)
    }
  },
)
const resolvedCommandOverflowLabel = computed(
  () => props.commandOverflowLabel ?? localeText.value.overflow,
)
const commandOverflowAriaLabel = computed(() =>
  props.commandOverflowLabel
    ? `${props.commandOverflowLabel} (${overflowItemCount.value})`
    : localeText.value.overflowAria(overflowItemCount.value),
)
const visibleModes = computed(() =>
  compactMode.value
    ? modes.filter((mode) => mode !== 'split' && mode !== 'live')
    : modes,
)
const wordCount = computed(() => editorMetrics.value.wordCount)

let viewportHeightNext: number | null = null
let viewportTrigger: MarkdownLiveLayoutTrigger | null = null
const updateVisualViewportHeight = () => {
  if (sessionSurfacePaused.value || typeof window === 'undefined') return

  const previous = visualViewportHeight.value
  visualViewportHeight.value =
    window.visualViewport?.height || window.innerHeight || 0
  visualViewportOffsetTop.value = window.visualViewport?.offsetTop || 0
  const trigger =
    previous > 0 && visualViewportHeight.value + 80 < previous
      ? 'soft-keyboard'
      : 'visual-viewport'
  applyLiveLayout(trigger)
  applyTypewriterScroll('async-layout')
}

let typewriterResizeObserver: ResizeObserver | undefined
const refreshTypewriterResizeObserver = () => {
  typewriterResizeObserver?.disconnect()
  typewriterResizeObserver = undefined
  const textarea = textareaRef.value
  if (
    sessionSurfacePaused.value ||
    props.writingAids?.typewriter !== true ||
    !textarea ||
    typeof ResizeObserver === 'undefined'
  )
    return
  textareaLayoutHeight = textarea.clientHeight
  textareaLayoutWidth = textarea.clientWidth
  typewriterResizeObserver = new ResizeObserver(() => {
    textareaLayoutHeight = textarea.clientHeight
    textareaLayoutWidth = textarea.clientWidth
    applyTypewriterScroll('async-layout')
    settleTypewriterLayout()
  })
  typewriterResizeObserver.observe(textarea)

  frameScheduler.schedule({
    key: 'visual-viewport-read',
    measure: () => {
      const height = window.visualViewport?.height || window.innerHeight || 0
      const previous = visualViewportHeight.value
      viewportHeightNext = height
      viewportTrigger =
        previous > 0 && height + 80 < previous
          ? 'soft-keyboard'
          : 'visual-viewport'
    },
    mutate: () => {
      if (viewportHeightNext === null) return
      visualViewportHeight.value = viewportHeightNext
      const trigger = viewportTrigger ?? 'visual-viewport'
      viewportHeightNext = null
      viewportTrigger = null
      // Applies the (already planned) layout response; a resulting scroll
      // restore is measured in the next frame because this mutate phase has
      // already begun — the read-after-write violation counter records it.
      applyLiveLayout(trigger)
    },
  })
}

let viewportListenersAttached = false
let ownedVisualViewport: VisualViewport | null = null
const attachViewportListeners = () => {
  if (viewportListenersAttached || sessionSurfacePaused.value || typeof window === 'undefined') return
  ownedVisualViewport = window.visualViewport
  ownedVisualViewport?.addEventListener('resize', updateVisualViewportHeight)
  ownedVisualViewport?.addEventListener('scroll', updateVisualViewportHeight)
  window.addEventListener('resize', updateVisualViewportHeight)
  viewportListenersAttached = true
}
const detachViewportListeners = () => {
  if (!viewportListenersAttached || typeof window === 'undefined') return
  ownedVisualViewport?.removeEventListener('resize', updateVisualViewportHeight)
  ownedVisualViewport?.removeEventListener('scroll', updateVisualViewportHeight)
  window.removeEventListener('resize', updateVisualViewportHeight)
  ownedVisualViewport = null
  viewportListenersAttached = false
}

onMounted(() => {
  const textarea = textareaRef.value
  if (textarea) {
    languageToolsController = bindMarkdownWebLanguageTools(textarea, {
      anchorMap: editorAnchorMap.value,
      config: languageToolsConfig(),
      documentIdentity,
      mode: currentMode.value,
      projection: editorProjection.value,
      projectionRevision: transactionStore.revision,
      revision: transactionStore.revision,
      source: transactionStore.value,
    })
    languageToolsRevision = transactionStore.revision
    languageToolsSource = transactionStore.value
    languageToolsConfigKey = JSON.stringify(languageToolsConfig())
    syncLanguageToolsState()
    // No parallel search path is retained: adoption happens before the first
    // component search and the real controller owns every subsequent task.
    const searchOwner = languageToolsController.adoptSearchTask(null)
    languageSearchParticipant = {
      ownerRef: 'language-search',
      inspect: () => searchOwner.inspect(),
      pause() {
        if (isComposing.value || nativeMachine.composing) {
          throw new Error('editor-session-language-search-running')
        }
        syncLanguageToolsState()
        const inspection = searchOwner.pause()
        languageSearchPaused.value = inspection.paused
        clearSearchViewAliases()
        return inspection
      },
      resume() {
        if (isComposing.value || nativeMachine.composing) {
          throw new Error('editor-session-language-search-running')
        }
        syncLanguageToolsState()
        const inspection = searchOwner.resume()
        languageSearchPaused.value = inspection.paused
        // Only a fresh current-document search is permitted; cancelled native
        // sessions and retained matches are never replayed on resume.
        return inspection
      },
      dispose: (snapshotRef) => searchOwner.dispose(snapshotRef),
    }
  }
  refreshLiveWindow('initial')
  refreshWritingAidsDocument()
  updateVisualViewportHeight()
  refreshTypewriterResizeObserver()
  attachViewportListeners()
})

onBeforeUnmount(() => {
  editorReleased = true
  sessionDisposed = true
  const attempt = (cleanup: () => void): boolean => {
    try { cleanup(); return true } catch (cause) {
      if (!sessionUnmountFailed) sessionUnmountFirstCause = cause
      sessionUnmountFailed = true
      return false
    }
  }
  attempt(releaseAttachmentFiles)
  attempt(() => transactionStore.releaseRetainedSnapshot())
  const searchCancelled = attempt(() => languageToolsController?.cancelSearch())
  const searchAliasesCleared = attempt(clearSearchViewAliases)
  if (searchCancelled && searchAliasesCleared) {
    languageSearchParticipant = null
    languageToolsController = null
  }
  attempt(abortPendingCommands)
  attempt(() => {
    if (layoutGestureTimer !== undefined) {
      clearTimeout(layoutGestureTimer)
      layoutGestureTimer = undefined
    }
  })
  attempt(cancelOwnedTypewriterFrames)
  attempt(() => {
    typewriterResizeObserver?.disconnect()
    typewriterResizeObserver = undefined
  })
  attempt(() => { cssHighlightRegistry()?.delete('markdown-search-match') })
  attempt(() => { cssHighlightRegistry()?.delete('markdown-search-current') })
  attempt(() => attachmentEmbedOwner.abort())
  attempt(detachViewportListeners)
  if (sessionUnmountFailed) throw sessionUnmountFirstCause
})

watch(
  () => props.writingAids?.typewriter,
  () => refreshTypewriterResizeObserver(),
)

const handleBeforeInput = (event: InputEvent) => {
  syncLanguageToolsState()
  if (event.inputType === 'insertReplacementText' && languageToolsController) {
    const replacement = languageToolsController.handleBeforeInput(event)
    if (replacement.handled && replacement.transaction) {
      dispatchTransaction(replacement.transaction)
      beforeInputSnapshot = undefined
      pendingClipboardIdentity = undefined
      pendingInputOrigin = undefined
      return
    }
    if (replacement.handled) {
      beforeInputSnapshot = undefined
      pendingClipboardIdentity = undefined
      pendingInputOrigin = undefined
      return
    }
  }
  const plan = nativeMachine.apply({
    clipboardIdentity: pendingClipboardIdentity,
    data: event.data,
    disabled: editingBlocked.value,
    documentIdentity,
    inputType: event.inputType,
    isComposing: event.isComposing,
    kind: 'beforeinput',
    origin: pendingInputOrigin,
    previousValue: transactionStore.value,
    revision: transactionStore.revision,
    selection: captureSelection(!nativeMachine.composing),
  })
  syncNativeComposing()
  if (plan.snapshot) beforeInputSnapshot = plan.snapshot
  if (plan.preventDefault) event.preventDefault()
  if (plan.restoreDisplay) triggerRef(editorValue)
  if (plan.action === 'undo') {
    undo()
    return
  }
  if (plan.action === 'redo') {
    redo()
    return
  }
}

const handleInput = (event: Event) => {
  const target = event.target
  if (!(target instanceof HTMLTextAreaElement)) return
  const inputEvent = event instanceof InputEvent ? event : undefined
  if (nativeMachine.composing || inputEvent?.isComposing) {
    nativeCompositionValue.value = target.value
  }
  const snapshot =
    beforeInputSnapshot?.value === transactionStore.value
      ? beforeInputSnapshot
      : nativeMachine.snapshot
  const plan = nativeMachine.apply({
    clipboardIdentity: pendingClipboardIdentity,
    data: inputEvent?.data ?? snapshot?.data ?? null,
    disabled: editingBlocked.value,
    documentIdentity,
    inputType: inputEvent?.inputType ?? snapshot?.inputType,
    isComposing: inputEvent?.isComposing,
    kind: 'input',
    origin: pendingInputOrigin,
    previousValue: transactionStore.value,
    revision: transactionStore.revision,
    selection: readSelectionFrom(target),
    value: target.value,
  })
  syncNativeComposing()
  beforeInputSnapshot = undefined
  if (
    plan.action === 'dedup' ||
    plan.action === 'prevent' ||
    plan.action === 'ignore'
  ) {
    pendingClipboardIdentity = undefined
    pendingInputOrigin = undefined
    if (plan.restoreDisplay && target.value !== transactionStore.value) {
      triggerRef(editorValue)
      void restoreTextareaSelection(transactionStore.selection)
    } else if (plan.restoreDisplay) {
      triggerRef(editorValue)
    }
    return
  }
  if (plan.action !== 'dispatch' && plan.action !== 'commit') {
    pendingClipboardIdentity = undefined
    pendingInputOrigin = undefined
    return
  }

  dispatchReplacement(
    target.value,
    readSelectionFrom(target),
    {
      history: plan.history,
      metadata: Object.freeze({
        ...(plan.composition ? { composition: true } : {}),
        data: snapshot?.data ?? inputEvent?.data ?? null,
        identity: plan.identity,
        inputType: snapshot?.inputType ?? inputEvent?.inputType ?? 'insertText',
      }),
      origin: plan.origin,
    },
    plan.mergeDirection,
  )
  pendingClipboardIdentity = undefined
  pendingInputOrigin = undefined
}

const handleCompositionStart = (event: CompositionEvent) => {
  const target = event.target
  nativeCompositionValue.value =
    target instanceof HTMLTextAreaElement ? target.value : transactionStore.value
  nativeMachine.apply({
    disabled: editingBlocked.value,
    documentIdentity,
    kind: 'compositionstart',
    revision: transactionStore.revision,
  })
  syncNativeComposing()
  if (editingBlocked.value || !nativeMachine.composing) return
  writingAidsController.handleCompositionStart()
  writingAidsState.value = writingAidsController.state
  transactionStore.breakMergeGroup()
  captureSelection()
  beforeInputSnapshot = undefined
  pendingClipboardIdentity = undefined
  pendingInputOrigin = undefined
  refreshLiveReveal()
}

const handleCompositionEnd = (event: CompositionEvent) => {
  const target = event.target
  if (!(target instanceof HTMLTextAreaElement)) return
  const plan = nativeMachine.apply({
    data: event.data,
    disabled: editingBlocked.value,
    documentIdentity,
    kind: 'compositionend',
    previousValue: transactionStore.value,
    revision: transactionStore.revision,
    selection: readSelectionFrom(target),
    value: target.value,
  })
  syncNativeComposing()
  writingAidsController.handleCompositionEnd()
  writingAidsState.value = writingAidsController.state
  beforeInputSnapshot = undefined
  pendingClipboardIdentity = undefined
  pendingInputOrigin = undefined
  if (plan.action !== 'commit') {
    if (plan.restoreDisplay) triggerRef(editorValue)
    return
  }
  const laggedComposition =
    target.value === transactionStore.value && event.data
      ? `${transactionStore.value}${event.data}`
      : target.value
  const laggedSelection = {
    direction: 'forward' as const,
    end: laggedComposition.length,
    start: laggedComposition.length,
  }
  dispatchReplacement(
    laggedComposition,
    target.value === transactionStore.value && event.data
      ? laggedSelection
      : readSelectionFrom(target),
    {
      history: plan.history,
      metadata: Object.freeze({
        composition: true,
        data: event.data,
        identity: plan.identity,
        inputType: 'insertCompositionText',
      }),
      origin: 'input',
    },
  )
  refreshLiveReveal()
}

const applyClipboardTransfer = (
  event: { preventDefault(): void; dataTransfer?: DataTransfer | null },
  origin: 'paste' | 'drop',
  data: DataTransfer | null | undefined,
  attachmentSelection?: MarkdownEditorSelection | null,
) => {
  const transfer = markdownClipboardItemsFromDataTransfer(data ?? null)
  const hasTransfer = transfer.items.length > 0 || transfer.files.length > 0
  if (!hasTransfer) {
    if (!editingBlocked.value && !nativeMachine.freezeSmartInput) {
      pendingInputOrigin = origin
    }
    return
  }

  const plan = resolveMarkdownClipboardPaste({
    composing: isComposing.value,
    disabled: editingBlocked.value,
    documentIdentity,
    files: transfer.files,
    items: transfer.items,
    mode: currentMode.value,
    origin,
    revision: transactionStore.revision,
    selection: attachmentSelection ?? captureSelection(),
    source: transactionStore.value,
  })

  if (
    plan.rejected === 'composition-active' ||
    plan.rejected === 'disabled' ||
    plan.rejected === 'preview' ||
    plan.rejected === 'readonly' ||
    plan.rejected === 'stale-document' ||
    plan.rejected === 'budget-exceeded' ||
    plan.rejected === 'cancelled'
  ) {
    event.preventDefault()
    return
  }

  if (plan.action === 'attachment-intent' || plan.transaction) {
    event.preventDefault()
    pendingClipboardIdentity = plan.identity
    pendingInputOrigin = origin
    nativeMachine.apply({
      clipboardIdentity: plan.identity,
      documentIdentity,
      kind: origin,
      origin,
      revision: transactionStore.revision,
    })
    if (plan.action === 'attachment-intent') {
      if (origin === 'drop' && !attachmentSelection) return
      captureAttachmentFiles(
        origin,
        Array.from(data?.files ?? []),
        attachmentSelection ?? captureSelection(),
        plan.identity,
      )
    }
    if (plan.transaction) dispatchTransaction(plan.transaction)
    return
  }

  event.preventDefault()
}

const handlePaste = (event: ClipboardEvent) => {
  const cell = refreshCurrentTableCell(captureSelection(false).start)
  const clipboard = event.clipboardData
  if (
    cell &&
    clipboard &&
    clipboard.files.length === 0 &&
    !isComposing.value &&
    !editingBlocked.value
  ) {
    const tsv = clipboard.getData('text/tab-separated-values')
    const csv = clipboard.getData('text/csv')
    const plain = clipboard.getData('text/plain')
    const carriesHtml = Array.from(clipboard.types).includes('text/html')
    const payload = tsv || csv || (carriesHtml ? '' : plain)
    const mime = tsv
      ? 'text/tab-separated-values'
      : csv
        ? 'text/csv'
        : undefined
    if (payload.includes('\t') || mime === 'text/csv') {
      const transfer = markdownClipboardItemsFromDataTransfer(clipboard)
      const clipboardPlan = resolveMarkdownClipboardPaste({
        composing: isComposing.value,
        disabled: editingBlocked.value,
        documentIdentity,
        files: transfer.files,
        items: transfer.items,
        mode: currentMode.value,
        origin: 'paste',
        revision: transactionStore.revision,
        selection: transactionStore.selection,
        source: transactionStore.value,
      })
      const plan = planMarkdownTablePaste(
        transactionStore.value,
        documentIdentity,
        cell.tableId,
        cell,
        payload,
        mime,
        transactionStore.revision,
      )
      if ('changes' in plan) {
        event.preventDefault()
        pendingClipboardIdentity = clipboardPlan.identity
        pendingInputOrigin = 'paste'
        nativeMachine.apply({
          clipboardIdentity: clipboardPlan.identity,
          documentIdentity,
          kind: 'paste',
          origin: 'paste',
          revision: transactionStore.revision,
        })
        const result = dispatchTransaction(plan)
        if (result.accepted) {
          tableAnnouncement.value = 'Pasted table data'
          void selectTableCell(cell)
        }
        return
      }
    }
  }
  applyClipboardTransfer(event, 'paste', event.clipboardData)
}

const handleDrop = (event: DragEvent) => {
  event.preventDefault()
  applyClipboardTransfer(
    event,
    'drop',
    event.dataTransfer,
    resolveDropSelection(event),
  )
}

const handleCopy = (event: ClipboardEvent) => {
  if (
    currentMode.value === 'live' &&
    atomicSession.value?.phase === 'selected'
  ) {
    const atomic = applyAtomicIntent('copy-source')
    if (atomic.copy && 'payload' in atomic.copy) {
      event.preventDefault()
      writeMarkdownClipboardPayload(event.clipboardData, atomic.copy.payload)
      return
    }
  }
  const plan = resolveMarkdownClipboardCopy({
    composing: isComposing.value,
    disabled: editingBlocked.value,
    documentIdentity,
    mode: currentMode.value,
    revision: transactionStore.revision,
    selection: captureSelection(false),
    source: transactionStore.value,
  })
  if (plan.rejected) {
    event.preventDefault()
    return
  }
  event.preventDefault()
  writeMarkdownClipboardPayload(event.clipboardData, plan.payload)
}

const handleCut = (event: ClipboardEvent) => {
  if (
    currentMode.value === 'live' &&
    atomicSession.value?.phase === 'selected'
  ) {
    const atomic = applyAtomicIntent('cut')
    if (atomic.copy && 'payload' in atomic.copy) {
      event.preventDefault()
      writeMarkdownClipboardPayload(event.clipboardData, atomic.copy.payload)
      return
    }
    if (atomic.copy && 'copy' in atomic.copy) {
      event.preventDefault()
      writeMarkdownClipboardPayload(
        event.clipboardData,
        atomic.copy.copy.payload,
      )
      return
    }
  }
  const plan = resolveMarkdownClipboardCut({
    composing: isComposing.value,
    disabled: editingBlocked.value,
    documentIdentity,
    mode: currentMode.value,
    revision: transactionStore.revision,
    selection: captureSelection(),
    source: transactionStore.value,
  })
  if (plan.rejected || !plan.transaction) {
    event.preventDefault()
    return
  }
  event.preventDefault()
  writeMarkdownClipboardPayload(event.clipboardData, plan.copy.payload)
  dispatchTransaction(plan.transaction)
}

const handleSelectionMove = () => {
  if (restoringSelection || isComposing.value) return
  captureSelection()
  refreshCurrentTableCell()
  refreshWritingAidsDocument()
  writingAidsController.handleSelectionChange()
  writingAidsState.value = writingAidsController.state
  syncLanguageToolsState()
  if (currentMode.value === 'live') {
    const selection = transactionStore.selection
    if (selection.start !== selection.end) {
      markLayoutGesture('selection-drag')
      applyLiveSelectionMotion('pointer-drag', {
        dragOffset:
          selection.direction === 'backward' ? selection.start : selection.end,
      })
      return
    }
  }
  refreshLiveReveal()
}

const handleSelectionDragStart = () => {
  if (isComposing.value) return
  typewriterScrollTarget = null
  writingAidsController.handleSelectionDragStart()
  writingAidsState.value = writingAidsController.state
}

const handleSelectionDragEnd = () => {
  writingAidsController.handleSelectionDragEnd()
  writingAidsState.value = writingAidsController.state
}

const handlePointerReveal = () => {
  if (restoringSelection || isComposing.value) return
  captureSelection()
  refreshCurrentTableCell()
  refreshWritingAidsDocument()
  if (currentMode.value === 'live') {
    applyLiveSelectionMotion('pointer-click', {
      pointerOffset: transactionStore.selection.start,
    })
  }
  refreshLiveReveal({
    intent: 'pointer',
    pointerOffset: transactionStore.selection.start,
  })
}

const handleTableContextMenu = (event: MouseEvent) => {
  const cell = refreshCurrentTableCell(captureSelection(false).start)
  if (!cell || editingBlocked.value) return
  event.preventDefault()
  tableAnnouncement.value = `Table row ${cell.row + 1}, column ${cell.column + 1}`
  tableMenuOpen.value = true
  void sessionLayoutResources.afterTick(() =>
    tableMenuRef.value?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(),
  )
}

const focusTableMenuItem = (index: number) => {
  const items = Array.from(
    tableMenuRef.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
  )
  if (!items.length) return
  items[(index + items.length) % items.length]?.focus()
}

const closeTableMenu = (restoreTrigger = false) => {
  tableMenuOpen.value = false
  if (restoreTrigger) {
    void sessionLayoutResources.afterTick(() => tableMenuTriggerRef.value?.focus())
  }
}

const toggleTableMenu = () => {
  tableMenuOpen.value = !tableMenuOpen.value
  if (tableMenuOpen.value) {
    void sessionLayoutResources.afterTick(() => focusTableMenuItem(0))
  }
}

const handleTableMenuKeydown = (event: KeyboardEvent) => {
  const items = Array.from(
    tableMenuRef.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
  )
  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === 'Escape') {
    event.preventDefault()
    closeTableMenu(true)
    return
  }
  if (event.key === 'Tab') {
    tableMenuOpen.value = false
    return
  }
  const targetIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? currentIndex + 1
          : event.key === 'ArrowUp'
            ? currentIndex - 1
            : null
  if (targetIndex === null) return
  event.preventDefault()
  focusTableMenuItem(targetIndex)
}

const runTableContextAction = (key: string) => {
  const cell = currentTableCell.value
  if (!cell || editingBlocked.value || isComposing.value) return
  const source = transactionStore.value
  const revision = transactionStore.revision
  let plan: MarkdownEditorTransaction | { readonly rejected: string }
  switch (key) {
    case 'insert-row-above':
      plan = planMarkdownTableInsertRow(
        source,
        documentIdentity,
        cell.tableId,
        cell.row,
        'above',
        revision,
        cell.column,
      )
      break
    case 'insert-row-below':
      plan = planMarkdownTableInsertRow(
        source,
        documentIdentity,
        cell.tableId,
        cell.row,
        'below',
        revision,
        cell.column,
      )
      break
    case 'move-row-up':
    case 'move-row-down':
      plan = planMarkdownTableMoveRow(
        source,
        documentIdentity,
        cell.tableId,
        cell.row,
        key === 'move-row-up' ? 'up' : 'down',
        revision,
        cell.column,
      )
      break
    case 'delete-row':
      plan = planMarkdownTableDeleteRow(
        source,
        documentIdentity,
        cell.tableId,
        cell.row,
        revision,
        cell.column,
      )
      break
    case 'insert-col-left':
      plan = planMarkdownTableInsertColumn(
        source,
        documentIdentity,
        cell.tableId,
        cell.column,
        'left',
        revision,
        cell.row,
      )
      break
    case 'insert-col-right':
      plan = planMarkdownTableInsertColumn(
        source,
        documentIdentity,
        cell.tableId,
        cell.column,
        'right',
        revision,
        cell.row,
      )
      break
    case 'move-col-left':
    case 'move-col-right':
      plan = planMarkdownTableMoveColumn(
        source,
        documentIdentity,
        cell.tableId,
        cell.column,
        key === 'move-col-left' ? 'left' : 'right',
        revision,
        cell.row,
      )
      break
    case 'delete-col':
      plan = planMarkdownTableDeleteColumn(
        source,
        documentIdentity,
        cell.tableId,
        cell.column,
        revision,
        cell.row,
      )
      break
    case 'align-left':
    case 'align-center':
    case 'align-right':
      plan = planMarkdownTableAlignColumn(
        source,
        documentIdentity,
        cell.tableId,
        cell.column,
        key.slice('align-'.length) as 'left' | 'center' | 'right',
        revision,
        cell.row,
      )
      break
    case 'format-table':
      plan = planMarkdownTableFormat(
        source,
        documentIdentity,
        cell.tableId,
        revision,
        cell,
      )
      break
    default:
      return
  }
  if (!('changes' in plan)) return
  const targetCell = (
    plan.metadata?.markdownTable as
      | {
          readonly targetCell?: Readonly<{ row: number; column: number }>
        }
      | undefined
  )?.targetCell
  const result = dispatchTransaction(plan)
  if (!result.accepted) return
  tableAnnouncement.value = tableContextActions.value.find(
    (action) => action.key === key,
  )?.title ?? 'Table updated'
  closeTableMenu()
  const nextCell = targetCell
    ? resolveMarkdownTableCellCoordinates(
        transactionStore.value,
        documentIdentity,
        cell.tableId,
        targetCell.row,
        targetCell.column,
      )
    : resolveMarkdownTableCellAtOffset(
        transactionStore.value,
        documentIdentity,
        result.selection.start,
      )
  currentTableCell.value = nextCell
    ? Object.freeze({
        ...nextCell,
        ...(!key.startsWith('delete-') && cell.cellId
          ? { cellId: cell.cellId }
          : {}),
      })
    : null
}

const handleBlur = () => {
  transactionStore.breakMergeGroup()
}

class MarkdownClipboardUnavailableError extends Error {}

const readPasteAsMarkdownClipboard =
  async (): Promise<MarkdownHtmlImportSnapshot> => {
    const clipboard = navigator.clipboard
    if (typeof clipboard?.read === 'function') {
      const items = await clipboard.read()
      const item = items[0]
      if (!item) return Object.freeze({ explicit: true })
      const types = new Set(item.types)
      const readType = async (type: string) =>
        types.has(type) ? (await item.getType(type)).text() : undefined
      const [html, markdown, plain] = await Promise.all([
        readType('text/html'),
        readType('text/markdown'),
        readType('text/plain'),
      ])
      return Object.freeze({
        explicit: true,
        html,
        markdown,
        plain,
        sourceApplication: undefined,
      })
    }
    if (typeof clipboard?.readText === 'function') {
      return Object.freeze({
        explicit: true,
        plain: await clipboard.readText(),
      })
    }
    throw new MarkdownClipboardUnavailableError()
  }

const restorePasteAsMarkdownFocus = (selection: MarkdownEditorSelection) => {
  void restoreTextareaSelection(selection)
}

const openPasteAsMarkdownSurface = async () => {
  if (pasteAsMarkdownGate.value || pasteAsMarkdownBusy.value) return
  const anchor = Object.freeze({
    documentIdentity,
    revision: transactionStore.revision,
    selection: Object.freeze({ ...captureSelection() }),
    source: transactionStore.value,
  })
  pasteAsMarkdownBusy.value = true
  pasteAsMarkdownError.value = ''
  try {
    const snapshot = await readPasteAsMarkdownClipboard()
    const opened = openMarkdownPasteAsMarkdown({
      anchor,
      composition: isComposing.value,
      disabled: props.disabled || props.loading,
      explicit: true,
      previewOnly: currentMode.value === 'preview',
      readonly: props.readonly,
      snapshot,
    })
    if (opened.ok === false) {
      pasteAsMarkdownError.value =
        pasteAsMarkdownGateDescription.value ||
        pasteAsMarkdownRejectionText(opened.rejected)
      restorePasteAsMarkdownFocus(anchor.selection)
      return
    }
    pasteAsMarkdownSession.value = opened.session
    await sessionLayoutResources.afterTick(() => pasteAsMarkdownPrimaryActionRef.value?.focus())
  } catch (error) {
    pasteAsMarkdownError.value =
      error instanceof MarkdownClipboardUnavailableError
        ? localeText.value.pasteAsMarkdown.clipboardUnavailable
        : localeText.value.pasteAsMarkdown.clipboardFailed
    restorePasteAsMarkdownFocus(anchor.selection)
  } finally {
    pasteAsMarkdownBusy.value = false
  }
}

const closePasteAsMarkdownSurface = (selection: MarkdownEditorSelection) => {
  pasteAsMarkdownSession.value = null
  pasteAsMarkdownError.value = ''
  restorePasteAsMarkdownFocus(selection)
}

const cancelPasteAsMarkdownSurface = () => {
  const session = pasteAsMarkdownSession.value
  if (!session) return
  const cancelled = cancelMarkdownPasteAsMarkdown(session)
  closePasteAsMarkdownSurface(cancelled.selection)
}

const confirmPasteAsMarkdownChoice = (
  choice: Exclude<MarkdownPasteAsMarkdownChoice, 'cancel'>,
) => {
  const session = pasteAsMarkdownSession.value
  if (!session) return
  if (pasteAsMarkdownGate.value) {
    pasteAsMarkdownError.value = pasteAsMarkdownGateDescription.value
    return
  }
  const current = Object.freeze({
    documentIdentity,
    revision: transactionStore.revision,
    selection: Object.freeze({ ...captureSelection(false) }),
    source: transactionStore.value,
  })
  const confirmed = confirmMarkdownPasteAsMarkdown(session, choice, current)
  if ('rejected' in confirmed) {
    pasteAsMarkdownError.value = localeText.value.pasteAsMarkdown.stale
    return
  }
  const result = dispatchTransaction(confirmed.transaction)
  if (!result.accepted) {
    pasteAsMarkdownError.value = localeText.value.pasteAsMarkdown.stale
    return
  }
  if (confirmed.attachmentBatch) {
    // This original producer supplies no owned job/service future. Preserve
    // its legacy event and keep its consumer resources explicitly unknown.
    opaqueAttachmentResourcesObserved.value = true
    emit('upload-image', confirmed.attachmentBatch)
  }
  closePasteAsMarkdownSurface(result.selection)
}

const handlePasteAsMarkdownDialogKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelPasteAsMarkdownSurface()
    return
  }
  if (event.key !== 'Tab') return
  const buttons = Array.from(
    pasteAsMarkdownDialogRef.value?.querySelectorAll<HTMLButtonElement>(
      'button:not(:disabled)',
    ) ?? [],
  )
  if (!buttons.length) return
  const first = buttons[0]!
  const last = buttons[buttons.length - 1]!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

const activateCommand = (command: MarkdownEditorCommand) => {
  if (isPasteAsMarkdownCommand(command)) {
    void openPasteAsMarkdownSurface()
    return
  }
  void runCommand(command)
}

const activateOverflowCommand = (command: MarkdownEditorCommand) => {
  activateCommand(command)
  commandsExpanded.value = false
}

const rebaseCommandTransaction = (
  transaction: MarkdownEditorTransaction,
  positionMap: MarkdownEditorPositionMap | undefined,
) => {
  if (!positionMap) return transaction
  const changes = transaction.changes.map((change) => {
    const rebased = positionMap.rebase({
      start: change.from,
      end: change.to,
    })
    if (rebased.status !== 'mapped') return undefined
    return Object.freeze({
      from: rebased.start,
      to: rebased.end,
      insert: change.insert,
    })
  })
  if (changes.some((change) => change === undefined)) return undefined
  const selection = transaction.selection
    ? positionMap.rebase({
        start: transaction.selection.start,
        end: transaction.selection.end,
      })
    : undefined
  if (selection?.status === 'deleted') return undefined
  return Object.freeze({
    ...transaction,
    changes: changes as MarkdownEditorTransaction['changes'],
    ...(selection
      ? {
          selection: {
            direction: transaction.selection?.direction,
            start: selection.start,
            end: selection.end,
          },
        }
      : {}),
  })
}

const runCommand = async (
  command: MarkdownEditorCommand,
  slashRange?: Readonly<{ start: number; end: number }>,
) => {
  if (editingBlocked.value || nativeMachine.freezeSmartInput || commandResources.paused) return
  const activeSession = commandSessions.get(command.key)
  if (activeSession?.state === 'pending' && !command.concurrent) return

  const selection = captureSelection()
  const projection = editorProjection.value
  const initialContext = {
    ...commandContext.value,
    selection,
    syntax: projection
      ? resolveMarkdownEditorSyntaxContext(projection, selection)
      : undefined,
  }
  const session = createMarkdownEditorCommandSession(
    command.key,
    initialContext,
    {
      activeSessions: commandSessions,
      anchor: {
        ...(slashRange ?? selection),
        nodeId: initialContext.syntax?.nodeId,
      },
      concurrent: command.concurrent,
    },
  )
  commandResources.begin(session, command)
  commandSessions.set(command.key, session)
  commandRuntimeStates.value.set(command.key, { state: 'pending' })
  triggerRef(commandRuntimeStates)
  try {
    const context = {
      ...initialContext,
      dispatch: {
        dispatch: (transaction: MarkdownEditorTransaction) => {
          if (!commandResources.isCurrent(session)) {
            throw new Error('editor-session-command-attempt-stale')
          }
          return initialContext.dispatch.dispatch(transaction)
        },
      },
      signal: session.abort.signal,
    }
    if (
      !isMarkdownEditorCommandVisible(command, context) ||
      !isMarkdownEditorCommandEnabled(command, context)
    )
      return
    const result = await runMarkdownEditorCommand(command, context)
    if (!commandResources.isCurrent(session) || commandSessions.get(command.key) !== session) return
    const currentContext = commandContext.value
    const positionMap = positionMapFromRevision(
      session.revision,
      currentContext.revision,
    )
    const rebasedState = rebaseMarkdownEditorCommandSession(
      session,
      currentContext,
      positionMap,
    )
    if (rebasedState !== 'pending') {
      commandRuntimeStates.value.set(command.key, { state: rebasedState })
      triggerRef(commandRuntimeStates)
      return
    }
    const resolvedState = resolveMarkdownEditorCommandSession(
      session,
      currentContext,
      'resolved-current',
    )
    commandRuntimeStates.value.set(command.key, { state: resolvedState })
    triggerRef(commandRuntimeStates)
    if (resolvedState !== 'resolved-current') return
    if (result?.surface) {
      await openContextualSurface(result.surface)
      return
    }
    if (!result?.transaction) {
      if (result?.focus !== 'surface' && result?.focus !== 'none') {
        await restoreTextareaSelection(selection)
      }
      return
    }
    const rebasedTransaction = rebaseCommandTransaction(
      result.transaction,
      positionMap,
    )
    if (!rebasedTransaction) {
      session.state = 'stale'
      commandRuntimeStates.value.set(command.key, { state: 'stale' })
      triggerRef(commandRuntimeStates)
      return
    }
    const transaction =
      slashRange && session.anchor
        ? planMarkdownSlashCommit(session.anchor, rebasedTransaction)
        : rebasedTransaction
    const dispatchResult = dispatchTransaction({
      ...transaction,
      expectedRevision: currentContext.revision,
      history: transaction.history ?? 'separate',
      metadata: Object.freeze({ command: command.key }),
      origin: 'command',
    })
    if (dispatchResult.accepted) emit('command', command)
    if (
      !dispatchResult.accepted &&
      result.focus !== 'surface' &&
      result.focus !== 'none'
    ) {
      await restoreTextareaSelection(selection)
    }
  } catch (error) {
    if (!commandResources.isCurrent(session)) return
    const state = resolveMarkdownEditorCommandSession(
      session,
      commandContext.value,
      'rejected',
      error,
    )
    commandRuntimeStates.value.set(command.key, { error, state })
    triggerRef(commandRuntimeStates)
    await restoreTextareaSelection(selection)
  } finally {
    commandResources.finish(session)
    if (commandSessions.get(command.key) === session) {
      commandSessions.delete(command.key)
    }
  }
}

const runAction = (action: MarkdownEditorActionItem) => {
  if (action.key === 'image') {
    emitUploadImage()
    return
  }
  if (action.key === 'save') {
    emitSave()
    return
  }
  emitSubmit()
}

const runOverflowAction = (action: MarkdownEditorActionItem) => {
  runAction(action)
  commandsExpanded.value = false
}

const closeCommandOverflow = (restoreFocus = false) => {
  commandsExpanded.value = false
  if (restoreFocus) void sessionLayoutResources.afterTick(() => commandOverflowRef.value?.focus())
}

const toggleCommands = async () => {
  if (editingBlocked.value || isComposing.value) return
  commandsExpanded.value = !commandsExpanded.value
  if (!commandsExpanded.value) return
  await sessionLayoutResources.afterTick(() => {
    commandTrayRef.value
      ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus()
  })
}

const setMode = (mode: MarkdownEditorMode) => {
  if (editingBlocked.value || isComposing.value) return

  const preview = previewElement()
  if (preview) retainedPreviewScrollLeft.value = preview.scrollLeft
  transactionStore.breakMergeGroup()
  const nextMode = normalizeModeForLayout(mode)
  const retained = retainMarkdownLiveSelection({
    documentIdentity,
    mode: nextMode,
    selection: captureSelection(false),
    source: transactionStore.value,
  })
  transactionStore.setSelection(retained.selection, false)
  currentMode.value = nextMode
  refreshWritingAidsDocument()
  emit('mode-change', nextMode)
  void restoreTextareaSelection(retained.selection, false)
  applyLiveLayout('mode-switch')
  refreshLiveWindow('mode-switch')
  refreshLiveReveal()
  restorePreviewScroll()
}

const modeLabel = (mode: MarkdownEditorMode) => localeText.value.modes[mode]

const emitSave = () => {
  if (editingBlocked.value || isComposing.value) return
  emit('save', editorValue.value)
}

const emitSubmit = () => {
  if (editingBlocked.value || isComposing.value) return
  emit('submit', editorValue.value)
}

const emitUploadImage = () => {
  if (editingBlocked.value || isComposing.value) return
  attachmentInputRef.value?.click()
}

const handleAttachmentPickerChange = (event: Event) => {
  const input = event.currentTarget
  if (!(input instanceof HTMLInputElement)) return
  const files = Array.from(input.files ?? [])
  if (files.length > 0) {
    const replacement = attachmentReplaceRange.value
    captureAttachmentFiles(
      'pick',
      files,
      replacement
        ? {
            direction: 'none',
            end: replacement.end,
            start: replacement.start,
          }
        : captureSelection(),
      `pick:${event.timeStamp}:${files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join('|')}`,
      replacement?.nodeId ?? null,
    )
  }
  attachmentReplaceRange.value = null
  input.value = ''
}

const applyAttachmentResult = (result: MarkdownAttachmentProviderResult) => {
  const job = attachmentJobs.value.find(
    (candidate) =>
      candidate.itemId === result.itemId &&
      candidate.batchId === result.batchId,
  )
  if (!job || !job.itemId || sessionDisposed || attachmentPauseRequested.value ||
    (job.phase !== 'pending' && job.phase !== 'progress') ||
    job.documentIdentity?.id !== transactionStore.documentIdentity.id ||
    job.documentIdentity.epoch !== transactionStore.documentIdentity.epoch ||
    (result.documentIdentity && (result.documentIdentity.id !== job.documentIdentity.id ||
      result.documentIdentity.epoch !== job.documentIdentity.epoch)) ||
    (result.revision !== undefined && result.revision !== job.revision) ||
    !job.range || !Number.isSafeInteger(job.range.start) || !Number.isSafeInteger(job.range.end) ||
    job.range.start < 0 || job.range.start >= job.range.end || job.range.end > transactionStore.value.length) return false
  // Legacy content admission is independent of resource settlement. Only an
  // actual void-event attempt can use it; a future attempt always needs proof,
  // even if its dispatch prop was removed after starting.
  const legacyItem = attachmentItems.get(job.itemId)
  const legacyContentAttempt = legacyItem ? legacyAttachmentAttempts.get(legacyItem) : undefined
  const isLegacyContent = legacyContentAttempt === job.attempt && inspectMarkdownAttachmentDispatch(job) === null
  if (!isLegacyContent && !attachmentEmbedOwner.acceptsAttachmentResult(result)) return false
  if (result.status === 'progress') {
    if (job.phase !== 'pending' && job.phase !== 'progress') return false
    const ratio = result.ratio ?? 0
    progressMarkdownAttachmentJob(job, ratio <= 1 ? ratio * 100 : ratio)
    triggerRef(attachmentJobs)
    return true
  }
  if (
    result.status === 'resolved' &&
    job.phase !== 'pending' &&
    job.phase !== 'progress'
  )
    return false

  const source = transactionStore.value
  const revision = transactionStore.revision
  const identity = transactionStore.documentIdentity
  const range = job.range
  const attempt = job.attempt
  const progress = job.progress
  const item = attachmentItems.get(job.itemId ?? job.id)
  const batch = job.batchId ? attachmentBatches.get(job.batchId) : undefined
  const planned = planMarkdownAttachmentResolve(source, job, result)
  const resolvedRange = job.range
  // Until acceptance, abort callbacks must rebase the actual placeholder range.
  if (planned.transaction) job.range = range
  if (job.phase !== 'pending' && job.phase !== 'progress')
    revokeAttachmentFile(job.itemId ?? job.id)
  triggerRef(attachmentJobs)
  if (!planned.transaction) return planned.accepted

  const current =
    !sessionDisposed && !attachmentPauseRequested.value && !editorReleased &&
    attachmentJobs.value.includes(job) &&
    item &&
    batch &&
    range &&
    resolvedRange &&
    attachmentItems.get(item.itemId) === item &&
    attachmentBatches.get(batch.batch.batchId) === batch &&
    job.itemId === item.itemId &&
    job.batchId === batch.batch.batchId &&
    attachmentJobBindings.get(toRaw(job))?.batch === batch.batch &&
    attachmentJobBindings.get(toRaw(job))?.item === item &&
    job.documentIdentity?.id === batch.batch.documentIdentity.id &&
    job.documentIdentity?.epoch === batch.batch.documentIdentity.epoch &&
    job.revision === batch.batch.revision &&
    job.attempt === attempt &&
    toRaw(job).phase === 'resolved' &&
    job.range === range &&
    planned.transaction.changes.length === 1 &&
    planned.transaction.changes[0]?.from === range.start &&
    planned.transaction.changes[0]?.to === range.end &&
    planned.transaction.changes[0]?.insert === planned.markdown &&
    documentIdentity.id === identity.id &&
    documentIdentity.epoch === identity.epoch &&
    (props.documentIdentity?.id ?? commandTrayId) === identity.id &&
    (props.documentIdentity?.epoch ?? 0) === identity.epoch &&
    transactionStore.revision === revision &&
    transactionStore.value === source
  const refuseCompletion = () => {
    if (
      attachmentJobs.value.includes(job) &&
      job.attempt === attempt &&
      job.phase !== 'cancelled' &&
      job.phase !== 'deleted' &&
      job.phase !== 'document-abort'
    ) {
      job.phase = 'stale'
      job.progress = progress
      job.code = 'stale-completion'
      triggerRef(attachmentJobs)
    }
    return false
  }
  if (!current) return refuseCompletion()

  const dispatched = dispatchTransaction(
    {
      ...planned.transaction,
      documentIdentity: identity,
      expectedRevision: revision,
      metadata: Object.freeze({ attachmentItemId: job.itemId }),
    },
    (event) => {
      // Publish the resolved range with the actual accepted result/map, before observers.
      if (event.accepted) {
        job.range = resolvedRange
        triggerRef(attachmentJobs)
      }
    },
    job,
  )
  return dispatched.accepted || refuseCompletion()
}

const dispatchAttachmentBatch = (
  batch: MarkdownAttachmentBatchIntent,
  capture?: MarkdownAttachmentCaptureObservation,
) => {
  opaqueAttachmentResourcesObserved.value = true
  const dispatch = props.attachmentDispatch
  if (!dispatch) {
    // Mark the content channel before emitting: synchronous legacy consumers
    // may reply here. This metadata does not issue any settlement/resource proof.
    for (const item of batch.items) {
      const job = attachmentJobs.value.find((candidate) => candidate.itemId === item.itemId && candidate.batchId === batch.batchId)
      const retainedItem = attachmentItems.get(item.itemId)
      if (job && retainedItem && !inspectMarkdownAttachmentDispatch(job)) {
        legacyAttachmentAttempts.set(retainedItem, job.attempt)
      }
    }
    const record = attachmentBatches.get(batch.batchId)
    const observation = record?.batch === batch && record.capture === capture ? capture : undefined
    emit('upload-image', batch, observation)
    return
  }
  for (const item of batch.items) {
    const job = attachmentJobs.value.find((candidate) => candidate.itemId === item.itemId && candidate.batchId === batch.batchId)
    if (!job) continue
    const attempt = job.attempt
    const identity = Object.freeze({ ...transactionStore.documentIdentity })
    const record = attachmentBatches.get(batch.batchId)
    const original = record?.batch.items[item.order]
    const file = original === item && attachmentItems.get(item.itemId) === item &&
      attachmentJobBindings.get(toRaw(job))?.batch === record?.batch &&
      attachmentJobBindings.get(toRaw(job))?.item === item
      ? record?.files.get(item)?.file ?? null : null
    void attachmentEmbedOwner.runAttachmentDispatch(job, (admitProgress) => dispatch(Object.freeze({
      batch,
      item,
      file,
      onProgress: (progress: MarkdownAttachmentProviderResult) => admitProgress(progress) && applyAttachmentResult(progress),
    }))).then((settled) => {
      // Only the real owner's awaited terminal proof reaches content commit.
      applyAttachmentResult(settled)
    }).catch(() => {
      const settled = inspectMarkdownAttachmentDispatch(job)
      if (!settled?.settled || settled.attempt !== attempt || job.attempt !== attempt ||
        sessionDisposed || attachmentPauseRequested.value ||
        transactionStore.documentIdentity.id !== identity.id || transactionStore.documentIdentity.epoch !== identity.epoch ||
        (job.phase !== 'pending' && job.phase !== 'progress')) return
      // A rejected actual future is settled independently of its UI phase.
      // Missing/throwing dispatch without a future remains unknown and pending.
      job.phase = 'rejected'
      job.code = 'attachment-dispatch-rejected'
      revokeAttachmentFile(item.itemId)
    }).finally(() => {
      if (record) requestTerminalAttachmentRetirement(job, attempt)
      // Refresh retry eligibility from real settlement even for cancelled jobs.
      triggerRef(attachmentJobs)
    })
  }
}

const runAttachmentAction = (
  itemId: string,
  action: 'cancel' | 'retry' | 'remove',
) => {
  const job = attachmentJobs.value.find(
    (candidate) => candidate.itemId === itemId,
  )
  if (!job || sessionDisposed || editorReleased || attachmentPauseRequested.value) return
  const original = toRaw(job)
  const originalAttempt = original.attempt
  const originalPhase = original.phase
  const originalRange = original.range
  const originalBinding = attachmentJobBindings.get(original)
  const originalIdentity = transactionStore.documentIdentity
  const originalRevision = transactionStore.revision
  revokeAttachmentFile(itemId)
  if (sessionDisposed || editorReleased || attachmentPauseRequested.value ||
      !attachmentJobs.value.some((candidate) => toRaw(candidate) === original) || original.attempt !== originalAttempt ||
      original.phase !== originalPhase || original.range !== originalRange || attachmentJobBindings.get(original) !== originalBinding ||
      transactionStore.documentIdentity.id !== originalIdentity.id || transactionStore.documentIdentity.epoch !== originalIdentity.epoch ||
      transactionStore.revision !== originalRevision) return
  if (action === 'cancel') {
    cancelMarkdownAttachmentJob(job)
  } else if (action === 'retry') {
    if (attachmentPauseRequested.value) return
    try { retryMarkdownAttachmentJob(job) } catch {
      // Unknown legacy settlement or a still-running attempt cannot be retried.
      return
    }
    const batch = job.batchId ? attachmentBatches.get(job.batchId)?.batch : undefined
    const item = batch?.items.find((candidate) => candidate.itemId === itemId)
    if (batch && item) {
      dispatchAttachmentBatch(Object.freeze({ ...batch, items: Object.freeze([item]) }))
    }
  } else {
    const originalPhase = job.phase
    const originalRange = job.range
    const originalAttempt = job.attempt
    const originalBinding = attachmentJobBindings.get(toRaw(job))
    const identity = transactionStore.documentIdentity
    const revision = transactionStore.revision
    const planned = planMarkdownAttachmentRemove(transactionStore.value, job)
    const plannedRange = job.range
    const dispatched = dispatchTransaction({
      ...planned.transaction,
      metadata: Object.freeze({ attachmentItemId: job.itemId }),
    }, undefined, job)
    const ownsRejectedRemoval = () => !dispatched.accepted &&
      transactionStore.documentIdentity.id === identity.id && transactionStore.documentIdentity.epoch === identity.epoch &&
      transactionStore.revision === revision && job.attempt === originalAttempt && job.range === plannedRange &&
      attachmentJobBindings.get(toRaw(job)) === originalBinding && attachmentJobs.value.includes(job)
    if (job.phase === 'deleted' && ownsRejectedRemoval()) {
      job.phase = originalPhase
      if (job.phase === originalPhase && ownsRejectedRemoval()) job.range = originalRange
    }
  }
  triggerRef(attachmentJobs)
  applyLiveLayout('block-height-change')
}

const emitRenderEvent = (
  event: 'features-activated' | 'render-complete' | 'render-error',
  payload: unknown,
) => {
  if (event === 'features-activated') {
    emit('features-activated', payload)
    applyTypewriterScroll('async-layout')
    return
  }
  if (event === 'render-complete') {
    emit('render-complete', payload)
    applyTypewriterScroll('async-layout')
    return
  }
  emit('render-error', payload)
}

const handlePreviewRenderComplete = (payload: unknown) => {
  emitRenderEvent('render-complete', payload)
  restorePreviewScroll()
  void sessionLayoutResources.afterTick(syncRenderedSearchHighlights)
}

const handleRendererComplete = (payload: unknown) => {
  emitRenderEvent('render-complete', payload)
  void sessionLayoutResources.afterTick(syncRenderedSearchHighlights)
}

const searchUiState = ref<MarkdownSearchUiState>(resolveMarkdownSearchUi(false, '', 0))
const searchQuery = ref('')
const searchReplaceText = ref('')
const searchMatches = ref<readonly MarkdownSearchMatch[]>([])
const searchCurrentIndex = ref<number | null>(null)
const searchMode = ref<MarkdownSearchMode>('plain')
const searchQueryInputRef = ref<HTMLInputElement | null>(null)
const searchReplaceInputRef = ref<HTMLInputElement | null>(null)
const previewRendererRef = ref<HTMLElement | {
  $el?: HTMLElement
  captureLastValidRender?: () => MarkdownRendererLastValidRender | null
  getSessionResourceSourceOffer?: () => ReturnType<ReturnType<typeof createMarkdownRendererSessionResourceOwner>['inspectOwnedResources']>
  restoreLastValidRender?: (ref: string) => Promise<{ readonly ref: string; readonly status: 'restored' | 'blocked'; readonly reason: string | null }>
} | null>(null)

const searchHighlights = computed(() =>
  resolveMarkdownSearchHighlights({
    currentIndex: searchCurrentIndex.value,
    matches: searchMatches.value,
    mode: currentMode.value,
    source: editorValue.value,
  }),
)
const MAX_RENDERED_SEARCH_HIGHLIGHTS = 256
const renderedSearchHighlights = computed(() => {
  const items = searchHighlights.value.items
  if (items.length <= MAX_RENDERED_SEARCH_HIGHLIGHTS) return items
  const current = Math.max(0, searchCurrentIndex.value ?? 0)
  const half = Math.floor(MAX_RENDERED_SEARCH_HIGHLIGHTS / 2)
  const start = Math.min(
    Math.max(0, current - half),
    items.length - MAX_RENDERED_SEARCH_HIGHLIGHTS,
  )
  return items.slice(start, start + MAX_RENDERED_SEARCH_HIGHLIGHTS)
})
const visibleSearchHighlights = computed(() =>
  searchUiState.value.open && liveSurface.value.inputVisible
    ? renderedSearchHighlights.value
    : [],
)

const searchHighlightStyle = (range: { readonly start: number; readonly end: number }) => {
  const source = editorValue.value
  const lineStart = source.lastIndexOf('\n', Math.max(0, range.start - 1)) + 1
  const line = source.slice(0, lineStart).split('\n').length - 1
  const column = range.start - lineStart
  const lineEnd = source.indexOf('\n', range.start)
  const visibleEnd = lineEnd < 0 ? range.end : Math.min(range.end, lineEnd)
  return {
    '--markdown-search-column': String(column),
    '--markdown-search-length': String(Math.max(1, visibleEnd - range.start)),
    '--markdown-search-line': String(line),
  }
}

type CssHighlightRegistry = {
  delete(name: string): boolean
  set(name: string, value: unknown): unknown
}

const cssHighlightRegistry = () =>
  (globalThis.CSS as typeof CSS & { highlights?: CssHighlightRegistry } | undefined)
    ?.highlights

const renderedSearchRanges = (root: HTMLElement, needles: readonly string[]) => {
  const owner = root.ownerDocument
  const walker = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let node = walker.nextNode()
  while (node) {
    if (node instanceof Text && node.data) textNodes.push(node)
    node = walker.nextNode()
  }
  const nextOffsets = new Map<Text, number>()
  const ranges: Array<Range | null> = []
  for (const needle of needles) {
    if (!needle || needle.includes('\n')) {
      ranges.push(null)
      continue
    }
    let matched: Range | null = null
    for (const textNode of textNodes) {
      const index = textNode.data.indexOf(needle, nextOffsets.get(textNode) ?? 0)
      if (index < 0) continue
      const range = owner.createRange()
      range.setStart(textNode, index)
      range.setEnd(textNode, index + needle.length)
      nextOffsets.set(textNode, index + needle.length)
      matched = range
      break
    }
    ranges.push(matched)
  }
  return ranges
}

const syncRenderedSearchHighlights = () => {
  const registry = cssHighlightRegistry()
  if (!registry) return
  registry.delete('markdown-search-match')
  registry.delete('markdown-search-current')
  if (languageSearchPaused.value || !searchUiState.value.open || !searchMatches.value.length) return
  const candidate = previewRendererRef.value
  const root = candidate instanceof HTMLElement ? candidate : candidate?.$el
  if (!(root instanceof HTMLElement)) return
  const renderedItems = renderedSearchHighlights.value
  const needles = renderedItems.map(({ match }) =>
    editorValue.value.slice(match.range.start, match.range.end),
  )
  const ranges = renderedSearchRanges(root, needles)
  const HighlightCtor = (globalThis as typeof globalThis & {
    Highlight?: new (...ranges: Range[]) => unknown
  }).Highlight
  const visibleRanges = ranges.filter((range): range is Range => Boolean(range))
  if (!HighlightCtor || !visibleRanges.length) return
  registry.set('markdown-search-match', new HighlightCtor(...visibleRanges))
  const current = renderedItems.findIndex(({ current }) => current)
  if (current >= 0 && ranges[current]) {
    registry.set('markdown-search-current', new HighlightCtor(ranges[current]))
  }
}

type MarkdownEmbedRenderSegment =
  | { readonly content: string; readonly key: string; readonly kind: 'markdown' }
  | {
      readonly key: string
      readonly kind: 'embed'
      readonly node: MarkdownEmbedValidNode
      readonly plan: MarkdownEmbedPresentationPlan
      readonly result?: MarkdownEmbedResult
    }

const embedResults = ref<ReadonlyMap<string, MarkdownEmbedResult>>(new Map())
const embedNodeId = (node: MarkdownEmbedValidNode) =>
  `embed:${node.ranges.full.start}:${node.target}:${node.mode}`
const embedNodes = computed(() =>
  collectMarkdownEmbedNodes(editorValue.value).filter(
    (node): node is MarkdownEmbedValidNode => node.ok,
  ),
)

const attachmentEmbedOwner = createMarkdownAttachmentEmbedResourceOwner({
  readDocument: () => ({
    documentIdentity: transactionStore.documentIdentity,
    revision: transactionStore.revision,
  }),
  readEmbedProvider: () => props.embedProvider,
  readAttachmentJobs: () => attachmentJobs.value,
  readAttachmentBatches: () => attachmentBatches,
  readAttachmentItems: () => attachmentItems,
  attachmentCaptureSession,
  publishEmbedResults: (results) => { embedResults.value = results },
})
attachmentEmbedOwner.bindAttachmentInputs({
  documentIdentity,
  revision: editorRevision,
  jobs: attachmentJobs,
})
const attachmentResourceParticipant: MarkdownEditorSessionResourceParticipant = {
  ownerRef: 'attachment-embed',
  inspect: () => {
    assertAttachmentFileControlIdle()
    return attachmentEmbedOwner.participant.inspect()
  },
  pause() {
    assertAttachmentFileControlIdle()
    // Never freeze the result gate while a consumer upload still needs to
    // deliver its terminal response. No cancellation acknowledgment exists.
    if (attachmentJobs.value.some((job) => job.phase === 'pending' || job.phase === 'progress')) {
      throw new Error('editor-session-attachment-upload-resource-owner-unavailable')
    }
    attachmentPauseRequested.value = true
    return attachmentEmbedOwner.participant.pause()
  },
  resume() {
    assertAttachmentFileControlIdle()
    const state = attachmentEmbedOwner.participant.resume()
    attachmentPauseRequested.value = false
    return state
  },
  dispose: (snapshotRef) => attachmentEmbedOwner.participant.dispose(snapshotRef),
}
// Root review retains upload-settlement/attempt/reentrancy/capacity blockers.
// Do not admit this source offer as a trusted complete resource participant.
const attachmentResourceOwnerReviewed = false

const embedRenderSegments = computed<readonly MarkdownEmbedRenderSegment[]>(
  () => {
    const segments: MarkdownEmbedRenderSegment[] = []
    let offset = 0
    for (const node of embedNodes.value) {
      segments.push({
        content: editorValue.value.slice(offset, node.ranges.full.start),
        key: `markdown:${offset}`,
        kind: 'markdown',
      })
      const result = embedResults.value.get(embedNodeId(node))
      segments.push({
        key: embedNodeId(node),
        kind: 'embed',
        node,
        plan: planMarkdownEmbedPresentation(
          node,
          result,
          localeText.value.embeds,
          result ? {
            requestId: result.requestId,
            requestDigest: result.requestDigest,
            documentIdentity,
            revision: transactionStore.revision,
            nodeId: embedNodeId(node),
            target: node.target,
            mode: node.mode,
            version: attachmentEmbedOwner.readEmbedRequestVersions().get(embedNodeId(node)) ?? 0,
          } : undefined,
        ),
        result,
      })
      offset = node.ranges.full.end
    }
    if (!segments.length) {
      return [
        { content: editorValue.value, key: 'markdown:all', kind: 'markdown' },
      ]
    }
    segments.push({
      content: editorValue.value.slice(offset),
      key: `markdown:${offset}`,
      kind: 'markdown',
    })
    return Object.freeze(segments)
  },
)
const embedPresentationSegments = computed(() =>
  embedRenderSegments.value.filter(
    (
      segment,
    ): segment is Extract<
      MarkdownEmbedRenderSegment,
      { readonly kind: 'embed' }
    > => segment.kind === 'embed',
  ),
)

const embedActionLabel = (action: MarkdownEmbedActionKind) =>
  localeText.value.embeds.actions[action]

const markdownCommandContext = () => ({
  dispatch: { dispatch: dispatchTransaction },
  documentIdentity,
  mode: currentMode.value,
  readonly: editingBlocked.value,
  revision: transactionStore.revision,
  selection: captureSelection(false),
  signal: new AbortController().signal,
  value: transactionStore.value,
})

const handleEmbedAction = async (
  segment: Extract<MarkdownEmbedRenderSegment, { readonly kind: 'embed' }>,
  action: MarkdownEmbedActionKind,
) => {
  const result = runMarkdownEmbedAction(
    markdownCommandContext(),
    segment.node,
    action,
    segment.result,
  )
  if (result.action === 'delete') {
    dispatchTransaction(result.transaction)
    return
  }
  if (
    result.action === 'source-reveal' ||
    result.action === 'caret-before' ||
    result.action === 'caret-after' ||
    result.action === 'select-node'
  ) {
    if (currentMode.value === 'preview') setMode('source')
    transactionStore.setSelection(result.selection, false)
    await restoreTextareaSelection(result.selection)
    return
  }
  if (result.action === 'copy') {
    await navigator.clipboard?.writeText(result.exactMarkdown)
    return
  }
  if (result.action === 'retry') {
    emit('embed-retry', result.target, result.mode)
    void attachmentEmbedOwner.resolveEmbedNode(segment.node)
    return
  }
  emit('embed-open-source', result.target, result.mode)
}

const updateSearchState = () => {
  searchUiState.value = resolveMarkdownSearchUi(
    searchUiState.value.open,
    searchQuery.value,
    searchMatches.value.length,
    {
      currentIndex: searchCurrentIndex.value,
      mode: searchMode.value,
      replaceOpen: searchUiState.value.replaceOpen,
      replaceText: searchReplaceText.value,
      copy: localeText.value.search,
    },
  )
}

const clearSearchViewAliases = () => {
  searchMatches.value = []
  searchCurrentIndex.value = null
  cssHighlightRegistry()?.delete('markdown-search-match')
  cssHighlightRegistry()?.delete('markdown-search-current')
  updateSearchState()
}

const runSearch = () => {
  const controller = languageToolsController
  if (languageSearchPaused.value || !controller || !searchQuery.value) {
    controller?.cancelSearch()
    clearSearchViewAliases()
    return
  }
  syncLanguageToolsState()
  const session = controller.executeSearch({
    documentEpoch: documentIdentity.epoch,
    documentId: documentIdentity.id,
    mode: searchMode.value,
    queryText: searchQuery.value,
    revision: transactionStore.revision,
    source: transactionStore.value,
  })
  searchMatches.value = session.execution.matches
  searchCurrentIndex.value = session.execution.matches.length > 0 ? 0 : null
  updateSearchState()
}

const openSearch = (replace = false) => {
  searchUiState.value = resolveMarkdownSearchUi(
    true,
    searchQuery.value,
    searchMatches.value.length,
    {
      currentIndex: searchCurrentIndex.value,
      mode: searchMode.value,
      replaceOpen: replace,
      replaceText: searchReplaceText.value,
      copy: localeText.value.search,
    },
  )
  if (searchQuery.value) {
    runSearch()
  }
  sessionLayoutResources.afterTick(() => {
    if (replace && searchReplaceInputRef.value) {
      searchReplaceInputRef.value.focus()
    } else if (searchQueryInputRef.value) {
      searchQueryInputRef.value.focus()
    }
  })
}

const closeSearch = () => {
  searchUiState.value = resolveMarkdownSearchUi(
    false,
    searchQuery.value,
    searchMatches.value.length,
    {
      currentIndex: searchCurrentIndex.value,
      mode: searchMode.value,
      replaceOpen: false,
      replaceText: searchReplaceText.value,
      copy: localeText.value.search,
    },
  )
  if (currentMode.value === 'preview') {
    rootElementRef.value?.focus()
  } else if (textareaRef.value) {
    textareaRef.value.focus()
  }
}

const toggleSearchMode = (mode: MarkdownSearchMode) => {
  searchMode.value = searchMode.value === mode ? 'plain' : mode
  runSearch()
}

const toggleSearchReplace = () => {
  searchUiState.value = resolveMarkdownSearchUi(
    searchUiState.value.open,
    searchQuery.value,
    searchMatches.value.length,
    {
      currentIndex: searchCurrentIndex.value,
      mode: searchMode.value,
      replaceOpen: !searchUiState.value.replaceOpen,
      replaceText: searchReplaceText.value,
      copy: localeText.value.search,
    },
  )
}

const searchNavigate = (direction: 'next' | 'previous') => {
  const result = resolveMarkdownSearchNavigation(
    searchMatches.value,
    searchCurrentIndex.value,
    direction,
  )
  if (result.match) {
    const reveal = revealMarkdownSearchMatch({
      currentMode: currentMode.value,
      documentIdentity,
      match: result.match,
      revision: transactionStore.revision,
      source: transactionStore.value,
    })
    if (reveal.status === 'stale' || reveal.status === 'deleted') {
      runSearch()
      return reveal.status
    }
    if (reveal.status !== 'success') return reveal.status
    searchCurrentIndex.value = result.nextIndex
    updateSearchState()
    if (!reveal.suspended && currentMode.value !== 'preview') {
      void restoreTextareaSelection({
        direction: 'none',
        end: result.match.range.end,
        start: result.match.range.start,
      })
    }
    void sessionLayoutResources.afterTick(syncRenderedSearchHighlights)
    return reveal.status
  }
  return 'not-found' as const
}

const handleSearchQueryInput = () => {
  runSearch()
}

const handleSearchInputKeydown = (event: KeyboardEvent) => {
  const action = dispatchMarkdownSearchKeydown({
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    key: event.key,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    targetIsInput: true,
  })
  if (action === 'next-match') {
    event.preventDefault()
    searchNavigate('next')
  } else if (action === 'prev-match') {
    event.preventDefault()
    searchNavigate('previous')
  } else if (action === 'close') {
    event.preventDefault()
    closeSearch()
  }
}

const handleSearchReplaceKeydown = (event: KeyboardEvent) => {
  const action = dispatchMarkdownSearchKeydown({
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    key: event.key,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    targetIsReplaceInput: true,
  })
  if (action === 'replace-current') {
    event.preventDefault()
    searchReplaceCurrent()
  } else if (action === 'replace-all') {
    event.preventDefault()
    searchReplaceAll()
  } else if (action === 'close') {
    event.preventDefault()
    closeSearch()
  }
}

const searchReplaceCurrent = () => {
  if (searchCurrentIndex.value === null || !searchMatches.value.length) return
  const plan = planMarkdownReplaceCurrentInSet(
    {
      documentEpoch: documentIdentity.epoch,
      documentId: documentIdentity.id,
      query: { mode: searchMode.value, queryVersion: 1, text: searchQuery.value },
      revision: transactionStore.revision,
      source: transactionStore.value,
    },
    searchMatches.value,
    searchCurrentIndex.value,
    searchReplaceText.value,
  )
  if ('changes' in plan) {
    dispatchTransaction({
      changes: [...plan.changes],
      expectedRevision: transactionStore.revision,
      history: 'separate',
      origin: 'command',
      selection: plan.selection,
    })
    runSearch()
  }
}

const searchReplaceAll = () => {
  if (!searchMatches.value.length) return
  const plan = planMarkdownReplaceAll(
    {
      documentEpoch: documentIdentity.epoch,
      documentId: documentIdentity.id,
      query: { mode: searchMode.value, queryVersion: 1, text: searchQuery.value },
      revision: transactionStore.revision,
      source: transactionStore.value,
    },
    searchMatches.value,
    searchReplaceText.value,
  )
  if ('changes' in plan) {
    dispatchTransaction({
      changes: [...plan.changes],
      expectedRevision: transactionStore.revision,
      history: 'separate',
      origin: 'command',
      selection: plan.selection,
    })
    runSearch()
  }
}

attachmentEmbedOwner.bindEmbedInputs(
  [editorValue, editorRevision, () => documentIdentity.id,
    () => documentIdentity.epoch, () => props.embedProvider],
  () => embedNodes.value,
)

watch(
  [editorValue, editorRevision, currentMode],
  () => {
    if (searchUiState.value.open && searchQuery.value) runSearch()
  },
)

watch(
  [searchMatches, searchCurrentIndex, () => searchUiState.value.open, currentMode],
  () => void sessionLayoutResources.afterTick(syncRenderedSearchHighlights),
  { flush: 'post' },
)

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && searchUiState.value.open) {
    event.preventDefault()
    closeSearch()
    return
  }
  const searchAction = dispatchMarkdownSearchKeydown({
    ctrlKey: event.ctrlKey,
    key: event.key,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  })
  if (searchAction === 'open-find' || searchAction === 'open-replace') {
    event.preventDefault()
    openSearch(searchAction === 'open-replace')
    return
  }
  if (
    event.key === 'PageUp' ||
    event.key === 'PageDown' ||
    ((event.ctrlKey || event.metaKey) &&
      (event.key === 'Home' || event.key === 'End'))
  ) {
    suspendTypewriterForUserScroll()
  }

  if (editingBlocked.value || nativeMachine.freezeSmartInput) return
  if (activeSlashTrigger.value && slashCommands.value.length) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeSlashMenu()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveSlashIndex(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Enter') {
      const command = slashCommands.value[activeSlashIndex.value]
      if (command) {
        event.preventDefault()
        executeSlashCommand(command)
      }
      return
    }
  }

  if (!event.altKey && !event.ctrlKey && !event.metaKey) {
    const selection = captureSelection(false)
    const cell = refreshCurrentTableCell(selection.start)
    const tableKey =
      event.key === 'Tab' && event.shiftKey
        ? 'Shift+Tab'
        : event.key === 'Enter' && event.shiftKey
          ? 'Shift+Enter'
          : event.key
    if (cell?.anchor) {
      const plan = resolveMarkdownTableInputIntent({
        cell,
        cellOffset: Math.max(0, selection.start - cell.anchor.start),
        cellText: transactionStore.value.slice(cell.anchor.start, cell.anchor.end),
        compositionActive: isComposing.value,
        documentIdentity,
        expectedRevision: transactionStore.revision,
        key: tableKey,
        selection,
        source: transactionStore.value,
      })
      const moved =
        plan.nextCell.row !== cell.row ||
        plan.nextCell.column !== cell.column ||
        plan.nextCell.status !== cell.status
      if (plan.transaction || moved || tableKey === 'Tab' || tableKey === 'Shift+Tab') {
        event.preventDefault()
        if (plan.transaction) {
          const result = dispatchTransaction(plan.transaction)
          if (!result.accepted) return
        }
        tableAnnouncement.value = plan.screenReaderText
        if (plan.nextCell.status === 'current') {
          void selectTableCell(plan.nextCell)
        } else {
          currentTableCell.value = null
        }
        return
      }
    }
  }

  if (event.key === 'Escape' && currentMode.value === 'live') {
    if (atomicSession.value) {
      event.preventDefault()
      applyAtomicIntent('escape')
      return
    }
    if (liveReveal.value.state !== 'inactive') {
      event.preventDefault()
      refreshLiveReveal({ intent: 'escape' })
      return
    }
  }

  if (currentMode.value === 'live') {
    const motionKey =
      event.key === 'ArrowLeft'
        ? event.ctrlKey || event.altKey
          ? 'word-left'
          : 'left'
        : event.key === 'ArrowRight'
          ? event.ctrlKey || event.altKey
            ? 'word-right'
            : 'right'
          : event.key === 'Home'
            ? 'home'
            : event.key === 'End'
              ? 'end'
              : event.key === 'PageUp'
                ? 'page-up'
                : event.key === 'PageDown'
                  ? 'page-down'
                  : null
    const nativeDocumentNavigation =
      (event.ctrlKey || event.metaKey) &&
      (event.key === 'Home' || event.key === 'End')
    if (motionKey && !nativeDocumentNavigation) {
      event.preventDefault()
      applyLiveSelectionMotion(motionKey, { shift: event.shiftKey })
      return
    }
    if (
      event.key === 'Enter' &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const atomic = resolveMarkdownAtomicNodeIntent({
        action: 'caret-before',
        composing: isComposing.value,
        documentIdentity,
        mode: currentMode.value,
        revision: transactionStore.revision,
        selection: captureSelection(),
        session: atomicSession.value,
        source: transactionStore.value,
      })
      if (atomic.state === 'current') {
        event.preventDefault()
        applyAtomicIntent(event.shiftKey ? 'enter-source' : 'enter')
        return
      }
    }
    if (
      (event.key === 'Backspace' || event.key === 'Delete') &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const selection = captureSelection()
      const atomic = resolveMarkdownAtomicNodeIntent({
        action: event.key === 'Backspace' ? 'backspace' : 'delete',
        composing: isComposing.value,
        documentIdentity,
        mode: currentMode.value,
        revision: transactionStore.revision,
        selection,
        session: atomicSession.value,
        source: transactionStore.value,
      })
      if (atomic.state === 'current' && atomic.nodeId) {
        const before = resolveMarkdownAtomicNodeIntent({
          action: 'caret-before',
          documentIdentity,
          mode: currentMode.value,
          nodeId: atomic.nodeId,
          revision: transactionStore.revision,
          selection,
          source: transactionStore.value,
        })
        const after = resolveMarkdownAtomicNodeIntent({
          action: 'caret-after',
          documentIdentity,
          mode: currentMode.value,
          nodeId: atomic.nodeId,
          revision: transactionStore.revision,
          selection,
          source: transactionStore.value,
        })
        const caret = selection.start
        const shouldDelete =
          atomicSession.value?.phase === 'selected' ||
          (event.key === 'Delete' && caret === before.selection.start) ||
          (event.key === 'Backspace' && caret === after.selection.start)
        if (shouldDelete) {
          event.preventDefault()
          applyAtomicIntent(event.key === 'Backspace' ? 'backspace' : 'delete')
          return
        }
      }
    }
  }

  const isMod = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()
  if (isMod && !event.shiftKey && key === 'z') {
    event.preventDefault()
    undo()
    return
  }
  if (
    isMod &&
    ((event.shiftKey && key === 'z') || (!event.shiftKey && key === 'y'))
  ) {
    event.preventDefault()
    redo()
    return
  }

  const pairChars = new Set<string>(
    MARKDOWN_PAIR_DEFAULTS.flatMap(([open, close]) => [open, close]),
  )
  if (
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    (event.key === 'Backspace' || pairChars.has(event.key))
  ) {
    const pairPlan = resolveMarkdownPairInput({
      source: transactionStore.value,
      selection: captureSelection(),
      inserted: event.key === 'Backspace' ? undefined : event.key,
      key: event.key === 'Backspace' ? 'backspace' : undefined,
      composing: isComposing.value,
      readonly: props.disabled,
      mode: currentMode.value,
      documentIdentity,
    })
    if (pairPlan.transaction) {
      event.preventDefault()
      dispatchTransaction(pairPlan.transaction)
      return
    }
  }

  const blockKey =
    event.key === 'Tab'
      ? event.shiftKey
        ? 'shift-tab'
        : 'tab'
      : event.key === 'Enter'
        ? event.shiftKey
          ? 'shift-enter'
          : 'enter'
        : event.key === 'Backspace'
          ? 'backspace'
          : event.key === 'Delete'
            ? 'delete'
            : null
  if (blockKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
    const plan = resolveMarkdownBlockInputIntent({
      source: transactionStore.value,
      selection: captureSelection(),
      key: blockKey as MarkdownBlockInputKey,
      composing: isComposing.value,
      documentIdentity,
    })
    if (plan.rejected === 'composition-active') return
    if (!plan.transaction) return
    event.preventDefault()
    dispatchTransaction(plan.transaction)
    return
  }

  if (!isMod) return

  if (key === 's') {
    event.preventDefault()
    emitSave()
    return
  }
  if (key === 'enter') {
    event.preventDefault()
    emitSubmit()
    return
  }

  const command = resolveMarkdownEditorShortcut(props.commands, `mod+${key}`)

  if (command) {
    event.preventDefault()
    runCommand(command)
  }
}

const dispatchTransaction = (
  transaction: MarkdownEditorTransaction,
  observeTransaction?: (event: MarkdownEditorTransactionEvent) => void,
  attachmentJob?: MarkdownAttachmentJob,
) => {
  const result = dispatchEditorOperation({
    kind: 'transaction',
    transaction,
    observeTransaction,
    attachmentJob,
  })
  selectionTick.value += 1
  return result
}

const applyImageProperties = () => {
  const active = activeImage.value
  if (!active || editingBlocked.value || isComposing.value) return
  const source = transactionStore.value
  const destinationValidation = validateMarkdownPropertyUrl(
    imageDestinationDraft.value,
    {
      documentEpoch: documentIdentity.epoch,
      nodeId: active.nodeId,
      revision: transactionStore.revision,
      value: imageDestinationDraft.value,
      version: 1,
    },
  )
  if (!destinationValidation.open.allowed) {
    imagePropertyError.value =
      localeText.value.imageProperties.destinationRejected(
        destinationValidation.state,
      )
    return
  }

  const transactions: MarkdownEditorTransaction[] = []
  if (imageAltDraft.value !== active.image.alt.value) {
    transactions.push(
      planMarkdownImageAltEdit(source, active.range, imageAltDraft.value),
    )
  }
  if (imageDestinationDraft.value !== active.image.destination.value) {
    transactions.push(
      planMarkdownImageDestinationEdit(
        source,
        active.range,
        imageDestinationDraft.value,
      ),
    )
  }
  if (imageTitleDraft.value !== (active.image.title?.value ?? '')) {
    transactions.push(
      planMarkdownImageTitleEdit(
        source,
        active.range,
        imageTitleDraft.value || null,
      ),
    )
  }
  if (active.figure) {
    if (imageCaptionDraft.value !== active.figure.text) {
      transactions.push(
        imageCaptionDraft.value
          ? planMarkdownCaptionEdit(
              source,
              active.figure.captionNode,
              imageCaptionDraft.value,
            )
          : planMarkdownCaptionRemove(source, active.figure.captionNode),
      )
    }
  } else if (imageCaptionDraft.value) {
    transactions.push(
      planMarkdownCaptionInsert(source, active.range, imageCaptionDraft.value),
    )
  }

  const changes = transactions
    .flatMap((transaction) => transaction.changes)
    .filter((change) => source.slice(change.from, change.to) !== change.insert)
    .sort((left, right) => left.from - right.from || left.to - right.to)
  if (!changes.length) {
    imagePropertyError.value = ''
    return
  }
  const result = dispatchTransaction({
    changes: Object.freeze(changes),
    history: 'separate',
    origin: 'command',
  })
  imagePropertyError.value = result.accepted
    ? ''
    : localeText.value.imageProperties.updateRejected(
        result.reason ?? 'invalid-change',
      )
}

const revealActiveImageSource = () => {
  const active = activeImage.value
  if (!active) return
  const range = active.figure?.captionRange ?? active.range
  setMode('source')
  transactionStore.setSelection(
    { direction: 'none', end: range.end, start: range.start },
    false,
  )
  selectionTick.value += 1
  void restoreTextareaSelection(transactionStore.selection)
}

const openActiveImage = () => {
  const validated = activeImageUrlValidation.value
  if (!validated?.open.allowed || typeof window === 'undefined') return
  window.open(
    validated.open.href,
    validated.open.target,
    validated.open.rel ? 'noopener,noreferrer' : undefined,
  )
}

const copyActiveFigure = async (mode: 'exact' | 'visible') => {
  const active = activeImage.value
  if (!active || typeof navigator === 'undefined') return
  const source = transactionStore.value
  const payload =
    active.figure && mode === 'visible'
      ? formatMarkdownFigureVisibleCopy(source, active.figure)
      : active.figure
        ? formatMarkdownFigureExactCopy(source, active.figure)
        : source.slice(active.range.start, active.range.end)
  await navigator.clipboard?.writeText(payload)
}

const openActiveImageReplacement = () => {
  const active = activeImage.value
  if (!active || editingBlocked.value || isComposing.value) return
  attachmentReplaceRange.value = Object.freeze({
    end: active.range.end,
    nodeId: active.nodeId,
    start: active.range.start,
  })
  attachmentInputRef.value?.click()
}

const removeActiveCaption = () => {
  const active = activeImage.value
  if (!active?.figure || editingBlocked.value || isComposing.value) return
  dispatchTransaction(
    planMarkdownCaptionRemove(
      transactionStore.value,
      active.figure.captionNode,
    ),
  )
}

const removeActiveImage = () => {
  const active = activeImage.value
  if (!active || editingBlocked.value || isComposing.value) return
  dispatchTransaction(
    active.figure
      ? planMarkdownFigureDelete(transactionStore.value, active.figure)
      : planMarkdownImageRemove(transactionStore.value, active.range),
  )
}

function undo() {
  const result = dispatchEditorOperation({ kind: 'undo' })
  selectionTick.value += 1
  return result
}

function redo() {
  const result = dispatchEditorOperation({ kind: 'redo' })
  selectionTick.value += 1
  return result
}

const insertMarkdownAtCursor = (
  markdown: string,
  options: MarkdownEditorInsertOptions = {},
) => {
  const selection = options.selection ?? captureSelection()
  const cursor = selection.start + markdown.length
  return dispatchEditorOperation({
    kind: 'transaction',
    transaction: {
      changes: [
        {
          from: selection.start,
          insert: markdown,
          to: selection.end,
        },
      ],
      expectedRevision: options.expectedRevision,
      history: 'separate',
      metadata: options.metadata,
      origin: 'programmatic',
      selection: {
        direction: 'none',
        end: cursor,
        start: cursor,
      },
    },
  }).accepted
}

const commitRevealSelection = async (
  range: { start: number; end: number },
  smooth: boolean,
) => {
  const selection = Object.freeze({
    direction: 'none' as const,
    end: range.start,
    start: range.start,
  })
  transactionStore.setSelection(selection, true)
  refreshLiveWindow('feature')
  refreshWritingAidsDocument()
  await restoreTextareaSelection(selection)
  const textarea = textareaRef.value
  if (!textarea) return
  textarea.focus()
  if (resolvedWritingAids.value.typewriter) {
    applyTypewriterScroll('explicit-navigation')
    return
  }
  const lineHeight =
    Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 20
  const line =
    transactionStore.value.slice(0, range.start).split('\n').length - 1
  const top = Math.max(0, line * lineHeight - textarea.clientHeight / 3)
  if (typeof textarea.scrollTo === 'function') {
    const scrollTop = Math.min(
      top,
      Math.max(0, textarea.scrollHeight - textarea.clientHeight),
    )
    textarea.scrollTo({ behavior: smooth ? 'smooth' : 'auto', top: scrollTop })
    sessionLayoutResources.requestFrame(() => {
      syncFocusLayerScroll(textarea.scrollTop)
    })
  } else {
    textarea.scrollTop = top
    syncFocusLayerScroll(top)
  }
}

const currentOutlineContext = () => {
  const projection = editorProjection.value
  return {
    anchorMap: createMarkdownAnchorMap({
      identity: documentIdentity,
      projection,
      source: transactionStore.value,
    }),
    model: projection
      ? createMarkdownOutlineModelFromProjection(
          transactionStore.value,
          projection,
        )
      : { items: [], projection: undefined },
  }
}

const reducedMotionRequested = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

const revealHeading = (
  nodeId: string,
  options?: Parameters<typeof revealHeadingOutline>[4],
) => {
  const { anchorMap, model } = currentOutlineContext()
  const actual = {
    documentIdentity,
    revision: transactionStore.revision,
  }
  const expected = options?.expected ?? actual
  const status = revealHeadingOutline(model.items, nodeId, expected, actual, {
    ...options,
    anchorMap,
    projection: model.projection,
  })
  if (status !== 'success') return status
  const plan = planMarkdownOutlineReveal(model.items, nodeId, {
    ...options,
    actual,
    anchorMap,
    expected,
    mode: currentMode.value,
    reducedMotion: options?.reducedMotion ?? reducedMotionRequested(),
  })
  if (plan.status !== 'success' || !plan.range) return plan.status
  void commitRevealSelection(plan.range, plan.smooth)
  return 'success'
}

const revealSourceRange = (
  range: { start: number; end: number },
  options?: Parameters<typeof revealSourceRangeOutline>[2],
) => {
  if (
    range.start < 0 ||
    range.end < range.start ||
    range.end > transactionStore.value.length
  ) {
    return 'not-found'
  }
  const { anchorMap, model } = currentOutlineContext()
  const actual = {
    documentIdentity,
    revision: transactionStore.revision,
  }
  const guarded = revealSourceRangeOutline(model.items, range, {
    ...options,
    actual,
    anchorMap,
    expected: options?.expected ?? actual,
    mode: options?.mode ?? currentMode.value,
    sourceLength: transactionStore.value.length,
  })
  if (guarded !== 'success') return guarded
  const smooth = !(options?.reducedMotion ?? reducedMotionRequested())
  void commitRevealSelection(range, smooth)
  return 'success'
}

const frameResourceParticipant = createMarkdownEditorFrameResourceParticipant(frameScheduler)
// This controls imperative resources only. Vue's template/v-model DOM bindings
// have no reversible subscription owner yet; disabled/readonly does not detach
// them. Keep this partial owner out of the complete resource roster.
const surfaceResourceOwnerComplete = false
const surfaceResourceParticipant: MarkdownEditorSessionResourceParticipant = {
  ownerRef: 'editor-surface',
  inspect() {
    return {
      ownerRef: 'editor-surface',
      paused: sessionSurfacePaused.value,
      recoverable: false,
      retainedListeners: viewportListenersAttached ? (ownedVisualViewport ? 3 : 1) : 0,
      usage: {
        editorInstances: sessionDisposed ? 0 : 1,
        renderers: 0,
        observers: typewriterResizeObserver ? 1 : 0,
        timers: layoutGestureTimer === undefined ? 0 : 1,
        backgroundTasks: Number(attachmentFileCleanupDepth !== 0 || attachmentPublicationDepth !== 0 || attachmentRetirementRunning || attachmentRetirementRequested || attachmentRetirementContinuation),
        networkRequests: 0,
        memoryUnits: Math.ceil((transactionStore.value.length + transactionStore.retainedSessionUnits) * 2 / 65536) +
          sessionBinding.inspectRetainedPanelMemoryUnits() + Number(attachmentRetirementContinuation !== null),
      },
    }
  },
  pause() {
    if (!surfaceResourceOwnerComplete) {
      throw new Error('editor-session-native-surface-resource-owner-unavailable')
    }
    if (sessionDisposed || isComposing.value || nativeMachine.composing) {
      throw new Error('editor-session-surface-pause-unavailable')
    }
    sessionSurfacePaused.value = true
    restoringSelection = false
    restoringViewport = false
    cancelOwnedTypewriterFrames()
    detachViewportListeners()
    typewriterResizeObserver?.disconnect()
    typewriterResizeObserver = undefined
    if (layoutGestureTimer !== undefined) {
      clearTimeout(layoutGestureTimer)
      layoutGestureTimer = undefined
    }
    return this.inspect()
  },
  resume() {
    if (sessionDisposed) throw new Error('editor-session-disposed')
    sessionSurfacePaused.value = false
    attachViewportListeners()
    refreshTypewriterResizeObserver()
    updateVisualViewportHeight()
    refreshLiveWindow('initial')
    return this.inspect()
  },
  dispose() {
    throw new Error('editor-session-surface-checkpoint-not-recoverable')
  },
}

// This binding closes over the existing owner; it never creates another editor.
const sessionBinding = createMarkdownEditorSessionBinding({
  transactionStore,
  resourceParticipants: () => [
    frameResourceParticipant, sessionLayoutResources.participant,
    ...(surfaceResourceOwnerComplete ? [surfaceResourceParticipant] : []),
    ...(languageSearchParticipant ? [languageSearchParticipant] : []),
    ...(attachmentResourceOwnerReviewed && !opaqueAttachmentResourcesObserved.value ? [attachmentResourceParticipant] : []),
    ...(commandResources.canInspect() ? [commandResources.participant] : []),
  ],
  isComposing: () => isComposing.value || nativeMachine.composing,
  isDisposed: () => sessionDisposed,
  captureLastValidRender: () => {
    // Segmented/embed renderers prove their own fragments, not the full article.
    // Only this existing full-document mounted renderer can supply this ref.
    if (embedRenderSegments.value.length > 1) return null
    const renderer = previewRendererRef.value
    if (!renderer || !('captureLastValidRender' in renderer) ||
      typeof renderer.captureLastValidRender !== 'function') return null
    const capture = renderer.captureLastValidRender()
    if (!capture || typeof capture.documentIdentity.epoch !== 'number' ||
      typeof capture.revision !== 'number') return null
    return Object.freeze({
      ref: capture.ref,
      documentIdentity: Object.freeze({
        id: capture.documentIdentity.id, epoch: capture.documentIdentity.epoch,
      }),
      revision: capture.revision,
    })
  },
  inspectAttachmentResourceSource: () => {
    // Read the original single pipeline. Unknown legacy settlement still throws;
    // measured source custody never proves consumer resources or complete pause.
    const inspection = attachmentResourceParticipant.inspect()
    const usage = inspection.usage
    return Object.freeze({
      complete: false as const,
      measuredUsageOnly: true as const,
      sourceReview: 'unqualified' as const,
      missingSourceDependencies: Object.freeze([
        'attachment-embed:independent-source-review',
        'attachment-embed:consumer-resource-controls',
        'attachment-embed:component-dispatch-continuation-custody',
        'attachment-embed:recoverable-checkpoint-owner',
      ]),
      measuredUsage: Object.freeze({
        editorInstances: usage.editorInstances,
        renderers: usage.renderers,
        observers: usage.observers,
        timers: usage.timers,
        backgroundTasks: usage.backgroundTasks,
        memoryUnits: usage.memoryUnits,
      }),
      measuredNetworkRequests: null,
      retainedListeners: inspection.retainedListeners,
      unknownUsage: Object.freeze([
        'consumer-network-requests',
        'consumer-timers-and-subscriptions',
        ...(opaqueAttachmentResourcesObserved.value ? ['observed-opaque-consumer-resources'] : []),
      ]),
    })
  },
  inspectRendererResourceSource: () => {
    // Use the original mounted full-document owner. A fragment/DOM fallback
    // cannot prove whole-editor ownership, and missing source is not zero usage.
    if (embedRenderSegments.value.length > 1) return null
    const renderer = previewRendererRef.value
    if (!renderer || !('getSessionResourceSourceOffer' in renderer) ||
      typeof renderer.getSessionResourceSourceOffer !== 'function') return null
    const offer = renderer.getSessionResourceSourceOffer()
    if (previewRendererRef.value !== renderer || embedRenderSegments.value.length > 1)
      throw new Error('editor-session-renderer-resource-owner-replaced')
    const usage = offer.inspection.usage
    return Object.freeze({
      complete: offer.complete,
      measuredUsageOnly: offer.measuredUsageOnly,
      sourceReview: 'unqualified' as const,
      missingSourceDependencies: Object.freeze([
        ...offer.missingSourceDependencies,
      ]),
      measuredUsage: Object.freeze({
        editorInstances: usage.editorInstances,
        renderers: usage.renderers,
        observers: usage.observers,
        timers: usage.timers,
        backgroundTasks: usage.backgroundTasks,
        memoryUnits: usage.memoryUnits,
      }),
      // Forward the original nullable measurement; never present its direct
      // component zero as the complete renderer/network resource total.
      measuredNetworkRequests: offer.knownNetworkRequests,
      retainedListeners: offer.inspection.retainedListeners,
      pendingRenderAdmissions: offer.sources.renderPipeline.pendingRenderAdmissions,
      pendingControlTransitions: offer.sources.renderPipeline.pendingControlTransitions,
      unknownUsage: offer.unknownUsage,
    })
  },
  restoreLastValidRender: async (ref) => {
    const renderer = previewRendererRef.value
    const blocked = (reason: string) => Object.freeze({ ref, status: 'blocked' as const, reason })
    if (embedRenderSegments.value.length > 1 || !renderer ||
      !('restoreLastValidRender' in renderer) ||
      typeof renderer.restoreLastValidRender !== 'function')
      return blocked('editor-session-full-renderer-restoration-owner-unavailable')
    const proof = await renderer.restoreLastValidRender(ref)
    if (previewRendererRef.value !== renderer || embedRenderSegments.value.length > 1)
      return blocked('editor-session-renderer-owner-replaced')
    return proof
  },
  capturePanelState: () => {
    const projection = editorProjection.value
    if (!projection || isComposing.value || sessionDisposed) return null
    const textarea = textareaRef.value
    const renderer = previewRendererRef.value
    const preview = previewElement()
    const mode = currentMode.value
    if ((mode !== 'preview' && !textarea) || (mode !== 'source' && !preview)) return null
    const identity = transactionStore.documentIdentity
    const revision = transactionStore.revision
    const liveAnchor = liveLayout.value.anchor
    if (liveAnchor && (liveAnchor.documentIdentity.id !== identity.id ||
        liveAnchor.documentIdentity.epoch !== identity.epoch || liveAnchor.revision !== revision)) return null
    if (searchMatches.value.some((match) => match.documentId !== identity.id ||
        match.documentEpoch !== identity.epoch || match.revision !== revision)) return null
    if (atomicSession.value && !projection.nodes.some((node) => node.id === atomicSession.value!.nodeId)) return null
    const originalAtomic = liveAtomic.value
    const requireQuiescent = () => {
      const frames = frameScheduler.resourceState()
      if (frames.runningPhase || frames.pendingFrames || frames.pendingAuxiliaryFrames || frames.runningAuxiliaryFrames ||
          sessionLayoutResources.participant.inspect().usage.backgroundTasks ||
          languageSearchParticipant?.inspect().usage.backgroundTasks) {
        throw new Error('editor-session-panel-continuation-active')
      }
    }
    try { requireQuiescent() } catch { return null }
    const attachment = captureMarkdownEditorSessionAttachmentState(() => attachmentJobs.value, () => {
      assertAttachmentFileControlIdle()
      if (attachmentJobs.value.some((job) => job.documentIdentity?.id !== identity.id ||
          job.documentIdentity.epoch !== identity.epoch || job.revision === undefined || job.revision > revision))
        throw new Error('editor-session-attachment-document-custody-unavailable')
      const usage = attachmentResourceParticipant.inspect().usage
      if (attachmentBatches.size || attachmentItems.size || usage.backgroundTasks || usage.networkRequests)
        throw new Error('editor-session-attachment-state-unsettled')
    })
    const outline = currentOutlineContext()
    const state = freezeMarkdownEditorSessionPanelState({
      mode,
      activeNode: {
        selection: transactionStore.selection,
        syntaxNodeId: currentSyntaxNode.value?.id ?? null,
        syntaxKind: currentSyntaxNode.value?.kind ?? null,
        linkNodeId: activeLinkNodeId.value,
        anchorNodeId: activeAnchorNodeId.value,
        atomicSession: atomicSession.value,
        contextualSurface: contextualSurface.value,
        contextualEpoch: contextualSurfaceEpoch.value,
        contextualRevision: contextualSurfaceRevision.value,
        contextualError: contextualError.value,
        linkLabel: linkLabelDraft.value, linkDestination: linkDestinationDraft.value,
        linkTitle: linkTitleDraft.value, anchorId: anchorIdDraft.value,
      },
      scrollAnchor: {
        anchor: liveAnchor,
        textareaTop: textarea?.scrollTop ?? null, textareaLeft: textarea?.scrollLeft ?? null,
        previewTop: preview?.scrollTop ?? null, previewLeft: preview?.scrollLeft ?? null,
        retainedPreviewLeft: retainedPreviewScrollLeft.value,
      },
      outline: outline.model.items,
      search: { ui: searchUiState.value, query: searchQuery.value, replaceText: searchReplaceText.value,
        matches: searchMatches.value, currentIndex: searchCurrentIndex.value, mode: searchMode.value },
      attachment: attachment?.state ?? null,
    })
    const isCurrent = () => {
      // Attachment inspection reads original owner inputs. Recheck continuations
      // and native identity after that reader, not only before it.
      try {
        requireQuiescent()
        if (attachment && !attachment.isCurrent()) return false
        requireQuiescent()
      } catch { return false }
      const currentPreview = previewElement()
      if (sessionDisposed || isComposing.value || editorProjection.value !== projection ||
          transactionStore.documentIdentity.id !== identity.id || transactionStore.documentIdentity.epoch !== identity.epoch ||
          transactionStore.revision !== revision || textareaRef.value !== textarea ||
          previewRendererRef.value !== renderer || currentPreview !== preview) return false
      return true
    }
    return Object.freeze({
      state, missingOwners: Object.freeze(attachment ? [] : ['attachment-original-settled-state-custody']),
      memoryUnits: markdownEditorSessionPanelMemoryUnits(state) + Number(textarea !== null) + Number(preview !== null) +
        (attachment?.state.length ?? 0) + 2,
      isCurrent,
      restore() {
        if (!isCurrent()) throw new Error('editor-session-panel-owner-stale')
        // Same original projection backs immutable outline; original jobs/proofs must remain exact.
        currentMode.value = state.mode
        contextualSurface.value = state.activeNode.contextualSurface
        contextualSurfaceEpoch.value = state.activeNode.contextualEpoch
        contextualSurfaceRevision.value = state.activeNode.contextualRevision
        contextualError.value = state.activeNode.contextualError
        linkLabelDraft.value = state.activeNode.linkLabel
        linkDestinationDraft.value = state.activeNode.linkDestination
        linkTitleDraft.value = state.activeNode.linkTitle
        anchorIdDraft.value = state.activeNode.anchorId
        atomicSession.value = state.activeNode.atomicSession
        liveAtomic.value = originalAtomic
        searchUiState.value = state.search.ui
        searchQuery.value = state.search.query
        searchReplaceText.value = state.search.replaceText
        searchMatches.value = state.search.matches
        searchCurrentIndex.value = state.search.currentIndex
        searchMode.value = state.search.mode
        editorSelection.value = transactionStore.selection
        if (textarea) {
          const selection = transactionStore.selection
          textarea.setSelectionRange(selection.start, selection.end, selection.direction)
        }
        liveLayout.value = Object.freeze({ ...liveLayout.value, anchor: state.scrollAnchor.anchor })
        retainedPreviewScrollLeft.value = state.scrollAnchor.retainedPreviewLeft
        if (textarea && state.scrollAnchor.textareaTop !== null && state.scrollAnchor.textareaLeft !== null) {
          textarea.scrollTop = state.scrollAnchor.textareaTop
          textarea.scrollLeft = state.scrollAnchor.textareaLeft
        }
        if (preview && state.scrollAnchor.previewTop !== null && state.scrollAnchor.previewLeft !== null) {
          preview.scrollTop = state.scrollAnchor.previewTop
          preview.scrollLeft = state.scrollAnchor.previewLeft
        }
      },
    })
  },
  captureViewState: () => ({
    mode: currentMode.value,
    search: {
      ui: searchUiState.value,
      query: searchQuery.value,
      replaceText: searchReplaceText.value,
      matches: searchMatches.value,
      currentIndex: searchCurrentIndex.value,
      mode: searchMode.value,
    },
    textarea: textareaRef.value,
    textareaScrollTop: textareaRef.value?.scrollTop ?? null,
    textareaScrollLeft: textareaRef.value?.scrollLeft ?? null,
    previewScrollLeft: retainedPreviewScrollLeft.value,
  }),
  restoreViewState: (state) => {
    currentMode.value = state.mode
    searchUiState.value = state.search.ui
    searchQuery.value = state.search.query
    searchReplaceText.value = state.search.replaceText
    searchMatches.value = state.search.matches
    searchCurrentIndex.value = state.search.currentIndex
    searchMode.value = state.search.mode
    editorSelection.value = transactionStore.selection
    const textarea = textareaRef.value
    if (textarea && textarea === state.textarea) {
      const selection = transactionStore.selection
      textarea.setSelectionRange(selection.start, selection.end, selection.direction)
      if (state.textareaScrollTop !== null) textarea.scrollTop = state.textareaScrollTop
      if (state.textareaScrollLeft !== null) textarea.scrollLeft = state.textareaScrollLeft
    }
    retainedPreviewScrollLeft.value = state.previewScrollLeft
  },
})


retireSnapshotPublicationAuthority = () => {
  let failed = false
  let firstCause: unknown
  try { retireStoreDocumentAuthority() } catch (cause) { failed = true; firstCause = cause }
  try { sessionBinding.retirePublicationAuthority() } catch (cause) { if (!failed) firstCause = cause; failed = true }
  if (failed) throw firstCause
}
if (sessionDisposed) retireSnapshotPublicationAuthority()

// Invalidate the private native publication reservation at actual synchronous
// owner input transitions, before queued Vue/render/layout work can run.
watch([
  () => props.modelValue, () => props.documentIdentity?.id, () => props.documentIdentity?.epoch,
  () => props.disabled, () => props.readonly, () => props.mode,
  currentMode, isComposing, editorValue, editorRevision, editorSelection,
  editorProjection, textareaRef, previewRendererRef, searchUiState, searchQuery,
  searchReplaceText, searchMatches, searchCurrentIndex, searchMode,
  atomicSession, liveAtomic, contextualSurface, contextualSurfaceEpoch, contextualSurfaceRevision,
  contextualError, linkLabelDraft, linkDestinationDraft, linkTitleDraft, anchorIdDraft,
], sessionBinding.invalidatePublicationAuthority, { flush: 'sync' })

defineExpose({
  getSession: sessionBinding.getSession,
  closeSearch,
  closeCommandPalette,
  applyAttachmentResult,
  withAttachmentFile,
  dispatchTransaction: (transaction: MarkdownEditorTransaction) => dispatchTransaction(transaction),
  insertMarkdownAtCursor,
  openSearch,
  openCommandPalette,
  redo,
  searchNavigate,
  searchReplaceAll,
  searchReplaceCurrent,
  searchUi: searchUiState,
  undo,
  revealHeading,
  revealSourceRange,
  writingAidsController,
})
</script>
