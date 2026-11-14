<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElCheckbox, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { publishAdminSitePage, readSitePageRevision, validPageMarkdown } from '../../../Contracts/admin-site-pages'
import type { SitePageSlug } from '../../../Contracts/site-pages'
import { WireLimits } from '../../../Contracts/wire.generated'

const props = defineProps<{ slug: SitePageSlug; sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [error: unknown]; close: [] }>()
const lifetime = new AbortController()
const signal = AbortSignal.any([lifetime.signal, props.sessionSignal])
const page = shallowRef<Awaited<ReturnType<typeof readSitePageRevision>>>()
const markdown = ref('')
const confirmed = ref(false)
const busy = ref(false)
const stale = ref(false)
const error = ref('')
const updated = ref(false)
const valid = computed(() => validPageMarkdown(markdown.value))
const canPublish = computed(() => !!page.value && !busy.value && !stale.value && valid.value &&
  markdown.value !== page.value.markdown && confirmed.value)

async function load() {
  await run(async () => {
    const revision = await readSitePageRevision(props.slug, signal)
    if (signal.aborted) return
    page.value = revision
    markdown.value = revision.markdown
    stale.value = false
    updated.value = false
  })
}

async function publish() {
  if (!canPublish.value || !page.value) return
  const { revision, digest } = page.value
  const content = markdown.value
  await run(async () => {
    await publishAdminSitePage({ slug: props.slug, expectedRevision: revision, expectedDigest: digest, markdown: content }, signal)
    if (signal.aborted) return
    updated.value = true
    // A new read is needed before the next change. Preserve the text if that read fails.
    stale.value = true
    const next = await readSitePageRevision(props.slug, signal)
    if (signal.aborted) return
    page.value = next
    markdown.value = next.markdown
    stale.value = false
  })
}

async function run(action: () => Promise<void>) {
  if (busy.value || signal.aborted) return
  error.value = ''
  confirmed.value = false
  busy.value = true
  try {
    await action()
  } catch (cause) {
    if (signal.aborted) return
    if (cause instanceof ApiError && cause.status === 401 && !cause.details.startsWith('pow_')) {
      emit('session-lost', cause)
    } else if (cause instanceof ApiError && cause.status === 409) {
      stale.value = true
      updated.value = false
      error.value = 'Another administrator published this page. Copy any edits you want to keep, then reload the published page.'
    } else if (cause instanceof Error && cause.name === 'NotAllowedError') {
      error.value = 'Passkey confirmation was canceled or timed out.'
    } else {
      error.value = 'The request failed. Check the published page before trying again.'
    }
  } finally {
    busy.value = false
  }
}

onMounted(load)
onScopeDispose(() => lifetime.abort())
</script>

<template>
  <section class="site-page-editor" :aria-label="`Edit ${slug} content`" :aria-busy="busy">
    <ElAlert v-if="error" :title="error" type="error" :closable="false" />
    <ElAlert v-if="updated" :title="`Published /${slug}`" type="success" :closable="false" />
    <template v-if="page">
      <label :for="`site-page-editor-${slug}`">{{ slug }} Markdown editor</label>
      <ElInput :id="`site-page-editor-${slug}`" v-model="markdown" type="textarea" :autosize="{ minRows: 10, maxRows: 20 }"
        v-bind="{ maxlength: WireLimits.PageContentChars }" :disabled="busy" @input="confirmed = false; updated = false" />
    </template>
    <ElAlert v-if="page && !valid" title="Markdown exceeds its size limit." type="warning" :closable="false" />
    <ElCheckbox v-if="page && !stale" :model-value="confirmed" :disabled="busy" @update:model-value="confirmed = $event === true">
      Replace the public /{{ slug }} page
    </ElCheckbox>
    <div class="site-page-actions">
      <ElButton v-if="page && !stale" native-type="button" type="primary" :loading="busy" :disabled="!canPublish"
        @click="publish">Publish with Passkey</ElButton>
      <ElButton v-if="stale || !page" native-type="button" :loading="busy" @click="load">Reload published page</ElButton>
      <ElButton native-type="button" :disabled="busy" @click="emit('close')">Close editor</ElButton>
    </div>
  </section>
</template>

<style scoped>
.site-page-editor { display: grid; gap: .5rem; margin-block: .5rem 1rem; }
.site-page-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
</style>
