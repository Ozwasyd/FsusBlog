<script setup lang="ts">
import { computed, h, onScopeDispose, ref, shallowRef, useId, watch, type VNodeChild } from 'vue'
import { ElButton } from '@ozwasyd/element-plus'
import { renderMarkdownResultWithRuntime } from '@ozwasyd/element-plus/markdown-runtime'
import { ApiError } from '../../../Contracts/aeds'
import { previewArticlePlugin, reviewArticlePlugin } from '../../../Contracts/author-plugin-preview'
import { credentialEpoch, currentSession, recheckCredential } from '../session'

const props = defineProps<{ article: number; revision: bigint; active: boolean; disabled: boolean }>()
const enabled = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-author-plugin-preview"]')?.content === '1'
const canPreview = computed(() => enabled && props.active && !props.disabled &&
  !!currentSession.value?.canAuthor && !!currentSession.value.siteSessionId)
const regionId = useId()
const waiting = ref(false)
const failure = ref('')
const consent = shallowRef<Awaited<ReturnType<typeof reviewArticlePlugin>>>()
const preview = shallowRef<{ source: string; formatted?: () => VNodeChild }>()
let request: AbortController | undefined

const readingTags = new Set([
  'p', 'br', 'hr', 'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
])

function renderNode(node: Node, depth: number): VNodeChild {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement) || node.localName === 'script' || node.localName === 'style') return null
  if (node.localName === 'img') return node.getAttribute('alt') ?? ''
  if (node.localName === 'input' && node.getAttribute('type') === 'checkbox')
    return node.hasAttribute('checked') ? '[x] ' : '[ ] '
  if (depth >= 32) return node.textContent ?? ''
  const children = Array.from(node.childNodes, child => renderNode(child, depth + 1))
  if (readingTags.has(node.localName)) return h(node.localName, children)
  if (/^h[1-6]$/.test(node.localName))
    return h(`h${Math.min(6, Number(node.localName[1]) + 2)}`, children)
  return children
}

function staticMarkdown(html: string) {
  // Parsing in a template keeps resource elements inert. Only fresh Vue text and
  // named semantic elements reach live DOM. No source node or URL is mounted.
  const parsed = document.createElement('template')
  parsed.innerHTML = html
  const children = Array.from(parsed.content.childNodes, node => renderNode(node, 0))
  return () => h('div', children)
}

function reset() {
  request?.abort()
  request = undefined
  waiting.value = false
  failure.value = ''
  consent.value = undefined
  preview.value = undefined
}

async function run() {
  const handle = currentSession.value?.siteSessionId
  if (!canPreview.value || !handle || request) return
  const epoch = credentialEpoch.value
  const { article, revision } = props
  const approval = consent.value
  const controller = new AbortController()
  request = controller
  const current = () => !controller.signal.aborted && request === controller && epoch === credentialEpoch.value &&
    canPreview.value && article === props.article && revision === props.revision &&
    handle === currentSession.value?.siteSessionId && currentSession.value.expiresAt > Date.now()
  waiting.value = true
  failure.value = ''
  preview.value = undefined
  try {
    if (!approval) {
      const reviewed = await reviewArticlePlugin(article, revision, handle, controller.signal)
      if (current()) consent.value = reviewed
      return
    }
    const source = await previewArticlePlugin(article, revision, handle, approval.token, controller.signal)
    if (!current()) return
    const formatted = source && import.meta.env.FSUS_MARKDOWN_NATIVE ? await renderMarkdownResultWithRuntime({
      source, mode: 'preview', allowLatex: false, allowMermaid: false,
    }) : undefined
    if (!current()) return
    preview.value = { source, formatted: formatted && 'value' in formatted ? staticMarkdown(formatted.value.html) : undefined }
  } catch (error) {
    if (!current()) return
    if (error instanceof ApiError) {
      if (error.status === 401) {
        await recheckCredential(handle, controller.signal)
        if (!current()) return
      }
      if (error.status === 409) failure.value = 'Load the current saved revision before running the preview.'
      else if (error.status === 429) failure.value = 'The preview service is busy. Try again.'
      else if (error.status === 503) failure.value = 'The signed plugin is unavailable.'
      else if (error.status === 403 && approval) failure.value = 'Review the signed plugin again before running it.'
      else if (error.status === 403 || error.status === 404) failure.value = 'This revision is unavailable for preview.'
    }
    if (!failure.value) failure.value = 'Could not run the signed plugin preview. Try again.'
  } finally {
    if (request === controller) {
      request = undefined
      waiting.value = false
      if (approval) consent.value = undefined
    }
  }
}

watch(() => [props.article, props.revision, props.active, props.disabled, credentialEpoch.value], reset, { flush: 'sync' })
onScopeDispose(reset)
</script>

<template>
  <section v-if="enabled && active" class="plugin-preview" aria-label="Signed plugin preview">
    <p v-if="consent" role="status">Allow {{ consent.plugin }} v{{ consent.version }} to read the saved Markdown of revision {{ revision }} for this preview?</p>
    <p v-if="consent">Package SHA-256 <code>{{ consent.digest }}</code></p>
    <ElButton native-type="button" :disabled="!canPreview" v-bind="{ 'aria-controls': regionId }" @click="waiting ? reset() : run()">
      {{ waiting ? 'Cancel preview' : consent ? 'Run plugin preview' : 'Review plugin access' }}
    </ElButton>
    <ElButton v-if="consent && !waiting" native-type="button" text @click="reset">Cancel</ElButton>
    <p v-if="disabled">Save the current draft before running the preview.</p>
    <p v-if="failure" role="alert">{{ failure }}</p>
    <p role="status">{{ waiting ? consent ? 'Running the signed plugin…' : 'Checking the signed plugin…' : preview ? `Preview ready for revision ${revision}.` : '' }}</p>
    <div :id="regionId" role="region" aria-label="Plugin preview result" :aria-busy="waiting">
      <template v-if="preview">
        <component :is="preview.formatted" v-if="preview.formatted" />
        <p v-else-if="preview.source === ''">The plugin returned an empty preview.</p>
        <template v-else>
          <p>Formatted preview unavailable. Showing the plugin output as text.</p>
          <pre>{{ preview.source }}</pre>
        </template>
      </template>
    </div>
  </section>
</template>

<style scoped>
.plugin-preview { min-inline-size: 0; }
.plugin-preview code { overflow-wrap: anywhere; }
.plugin-preview [role=region] { overflow: auto; overflow-wrap: anywhere; }
.plugin-preview pre { white-space: pre-wrap; }
</style>
