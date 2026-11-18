<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { ElAlert, ElButton, ElCheckbox, ElFormSection, ElInlineActions, ElInput, ElSkeleton } from '@ozwasyd/element-plus'
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
const error = ref<MessageKey | ''>('')
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
      error.value = 'admin.sitePageConflict'
    } else if (cause instanceof Error && cause.name === 'NotAllowedError') {
      error.value = 'admin.passkeyCanceled'
    } else {
      error.value = 'admin.sitePageRequestFailed'
    }
  } finally {
    busy.value = false
  }
}

onMounted(load)
onScopeDispose(() => lifetime.abort())
</script>

<template>
  <section class="site-page-editor" :aria-label="t('admin.editPageContent', { slug })" :aria-busy="busy">
    <ElFormSection density="compact">
      <ElAlert v-if="error" :title="t(error)" type="error" :closable="false" />
      <ElAlert v-if="updated" :title="t('admin.pagePublished', { slug })" type="success" :closable="false" />
      <ElSkeleton v-if="busy && !page" :rows="4" />
      <div v-if="page" class="site-page-editor-field">
        <label :for="`site-page-editor-${slug}`">{{ t('admin.pageMarkdownEditor', { slug }) }}</label>
        <ElInput
          :id="`site-page-editor-${slug}`"
          v-model="markdown"
          type="textarea"
          :autosize="{ minRows: 10, maxRows: 20 }"
          v-bind="{ maxlength: WireLimits.PageContentChars }"
          :disabled="busy"
          @input="confirmed = false; updated = false"
        />
      </div>
      <ElAlert v-if="page && !valid" :title="t('admin.markdownTooLarge')" type="warning" :closable="false" />
      <ElCheckbox
        v-if="page && !stale"
        :model-value="confirmed"
        :disabled="busy"
        @update:model-value="confirmed = $event === true"
      >
        {{ t('admin.replacePublicPage', { slug }) }}
      </ElCheckbox>
      <ElInlineActions>
        <ElButton
          v-if="page && !stale"
          native-type="button"
          type="primary"
          :loading="busy"
          :disabled="!canPublish"
          @click="publish"
        >{{ t('admin.publishPasskey') }}</ElButton>
        <ElButton v-if="stale || !page" native-type="button" :loading="busy" @click="load">{{ t('admin.reloadPublished') }}</ElButton>
        <ElButton native-type="button" :disabled="busy" @click="emit('close')">{{ t('admin.closeEditor') }}</ElButton>
      </ElInlineActions>
    </ElFormSection>
  </section>
</template>

<style scoped>
.site-page-editor {
  margin-block: 10px 4px;
}

.site-page-editor-field {
  display: grid;
  gap: 6px;
}

.site-page-editor-field label {
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-regular);
}
</style>
