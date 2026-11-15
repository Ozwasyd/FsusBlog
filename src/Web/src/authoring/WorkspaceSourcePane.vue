<script setup lang="ts">
import { computed } from 'vue'
import { defaultMarkdownEditorCommands, ElAlert, ElButton, ElInput, ElMarkdownEditor } from '@ozwasyd/element-plus'
import type { Draft } from '../../../Contracts/client'
import { WireLimits } from '../../../Contracts/wire.generated'
import type { WorkspaceSource } from './workspaceRegistry'

const props = defineProps<{ pane: WorkspaceSource<Draft>; focus: boolean; blocked: boolean; split: boolean; canSwitch: boolean; concealed: boolean }>()
const emit = defineEmits<{ edit: [field: 'title' | 'body', value: string]; activate: []; compose: [active: boolean] }>()
const nativeMarkdown = import.meta.env.FSUS_MARKDOWN_NATIVE
// The clipboard confirmation is teleported outside its editor and has no public closing hook.
const comparisonCommands = defaultMarkdownEditorCommands.filter(command => command.key !== 'paste-as-markdown')
const titleId = computed(() => props.focus ? 'article-title' : `article-title-${props.pane.tab.sessionId}`)
const bodyId = computed(() => props.focus ? 'article-body' : `article-body-${props.pane.tab.sessionId}`)
const groupName = computed(() => props.pane.tab.group === 'main' ? 'Primary article group' : 'Secondary article group')
const identity = computed(() => ({ id: `blog-editor-${props.pane.tab.sessionId}`, epoch: props.pane.tab.sessionId }))
const encoder = new TextEncoder()
const titleLength = computed(() => encoder.encode(props.pane.draft.title.trim()).length)

function edit(field: 'title' | 'body', value: string) {
  if (props.focus && !props.blocked) emit('edit', field, value)
}
</script>

<template>
  <section :id="`workspace-source-${pane.tab.sessionId}`" class="workspace-source" tabindex="-1" :aria-label="groupName"
    :class="{ 'workspace-source--secondary': pane.tab.group === 'secondary' }" v-bind="{ hidden: concealed, inert: concealed }"
    @compositionstart.capture="emit('compose', true)" @compositionend="emit('compose', false)">
    <header v-if="split" class="workspace-source__heading">
      <h2>{{ groupName }}</h2>
      <ElButton v-if="!focus" text native-type="button" :disabled="!canSwitch" @click="emit('activate')">Edit in this group</ElButton>
    </header>
    <slot name="before" />
    <label :for="titleId">Title</label>
    <ElInput :id="titleId" :model-value="pane.draft.title" @update:model-value="edit('title', $event)"
      placeholder="Write the article title" size="large" :readonly="!focus" :disabled="focus && blocked" />
    <p v-if="focus && (pane.tab.articleId === 0 || pane.tab.risk === 'dirty' || pane.tab.risk === 'conflict')" class="metadata">Save the draft before publishing.</p>
    <p class="metadata">{{ titleLength }} / {{ WireLimits.TitleBytes }} bytes</p>
    <label :for="bodyId">Body</label>
    <ElMarkdownEditor v-if="nativeMarkdown" :textarea-id="bodyId" :locale-text="{ textarea: { source: 'Body', live: 'Body' } }"
      :model-value="pane.draft.body" @update:model-value="edit('body', $event)" placeholder="Start writing here."
      :document-identity="identity" :readonly="!focus" :disabled="focus && blocked" :show-actions="false"
      :mode="split ? 'source' : undefined" :commands="split ? comparisonCommands : undefined" :show-mode-switcher="!split" />
    <template v-else>
      <ElAlert title="Rich editing unavailable. Edit the original Markdown below." type="info" :closable="false" />
      <ElInput :id="bodyId" :model-value="pane.draft.body" @update:model-value="edit('body', $event)" type="textarea"
        :autosize="{ minRows: 14 }" placeholder="Start writing here." :readonly="!focus" :disabled="focus && blocked" />
    </template>
    <slot name="after" />
  </section>
</template>

<style scoped>
.workspace-source { display: grid; align-content: start; gap: .5rem; min-inline-size: 0; }
.workspace-source[hidden] { display: none; }
.workspace-source__heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .5rem; }
.workspace-source__heading h2 { margin: 0; font-size: var(--fsus-typography-heading-sm-size); }
</style>
