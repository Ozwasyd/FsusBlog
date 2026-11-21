<script setup lang="ts">
import { t } from '../siteLocale'
import { draftMarkdownErrorMessage } from './draftMarkdownErrorMessage'
import { nextTick, onScopeDispose, ref, useId } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { maxDraftMarkdownCharacters, parseDraftMarkdown, readDraftMarkdownFile, type DraftMarkdown } from './draftMarkdownImport'

const emit = defineEmits<{ load: [draft: DraftMarkdown] }>()
const open = ref(false)
const reading = ref(false)
const source = ref('')
const title = ref('')
const error = ref('')
const input = ref<InstanceType<typeof ElInput>>()
const launcher = ref<InstanceType<typeof ElButton>>()
const id = useId()
const sourceAttributes = { rows: 6, maxlength: maxDraftMarkdownCharacters }
const titleAttributes = { maxlength: 256 }
let readTicket = 0

async function begin() {
  open.value = true
  await nextTick()
  if (open.value) input.value?.focus()
}

async function cancel() {
  ++readTicket
  open.value = false
  reading.value = false
  source.value = ''
  title.value = ''
  error.value = ''
  await nextTick()
  if (!open.value) launcher.value?.ref?.focus()
}

function paste(value: string) {
  ++readTicket
  reading.value = false
  source.value = value
  error.value = ''
}

async function chooseFile(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return
  const file = event.target.files?.[0]
  if (!file) return
  event.target.value = ''
  const ticket = ++readTicket
  reading.value = true
  source.value = ''
  error.value = ''
  try {
    const content = await readDraftMarkdownFile(file)
    if (ticket === readTicket) source.value = content
  } catch (cause) {
    if (ticket === readTicket && cause instanceof Error) error.value = draftMarkdownErrorMessage(cause.message)
  } finally {
    if (ticket === readTicket) reading.value = false
  }
}

function load() {
  if (reading.value) return
  try {
    emit('load', parseDraftMarkdown(source.value, title.value))
  } catch (cause) {
    if (cause instanceof Error) error.value = draftMarkdownErrorMessage(cause.message)
  }
}

onScopeDispose(() => { ++readTicket })
</script>

<template>
  <ElButton v-if="!open" ref="launcher" text size="small" native-type="button" @click="begin">{{ t('author.draftMarkdownImport.import.markdown') }}</ElButton>
  <section v-else :aria-labelledby="`${id}-heading`" class="markdown-import">
    <h3 :id="`${id}-heading`">{{ t('author.draftMarkdownImport.import.markdown') }}</h3>
    <label :for="`${id}-file`">{{ t('author.draftMarkdownImport.markdown.file') }}</label>
    <input :id="`${id}-file`" type="file" accept=".md,.markdown,text/markdown,text/plain" @change="chooseFile" />
    <label :for="`${id}-source`">{{ t('author.draftMarkdownImport.markdown.to.import') }}</label>
    <ElInput :id="`${id}-source`" ref="input" :model-value="source" csp-safe type="textarea"
      v-bind="sourceAttributes" @update:model-value="paste" />
    <label :for="`${id}-title`">{{ t('author.draftMarkdownImport.title.for.plain.markdown') }}</label>
    <ElInput :id="`${id}-title`" v-model="title" v-bind="titleAttributes" />
    <ElAlert v-if="error" :title="error" type="error" :closable="false" />
    <div class="markdown-import__actions">
      <ElButton type="primary" size="small" native-type="button" :loading="reading" @click="load">{{ t('author.draftMarkdownImport.load.into.draft') }}</ElButton>
      <ElButton size="small" native-type="button" @click="cancel">{{ t('author.draftMarkdownImport.cancel.import') }}</ElButton>
    </div>
  </section>
</template>

<style scoped>
.markdown-import {
  display: grid;
  gap: var(--fsus-space-2);
  margin-block: var(--fsus-space-2);
  padding: var(--fsus-space-4);
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-panel);
  background: var(--fsus-paper);
}
.markdown-import h3 { margin: 0; font-size: var(--fsus-typography-heading-sm-size); }
.markdown-import label { font-size: .8125rem; color: var(--fsus-color-text-muted); }
.markdown-import input { min-inline-size: 0; max-inline-size: 100%; }
.markdown-import__actions { display: flex; flex-wrap: wrap; gap: var(--fsus-space-2); margin-block-start: var(--fsus-space-1); }
</style>
