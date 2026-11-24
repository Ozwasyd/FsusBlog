<script setup lang="ts">
import { t } from '../siteLocale'
import { nextTick, onScopeDispose, ref, shallowRef, useId, watch } from 'vue'
import { ElButton } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { propertyApi, type PropertyWorkspace } from '../../../Contracts/property-values'
import { WireLimits } from '../../../Contracts/wire.generated'
import { credentialEpoch, currentSession } from '../authorSession'
import { showPropertyValue } from './propertyDisplay'

const props = defineProps<{ articleId: number; revision: bigint; sourceRevision: bigint; label: string }>()
const titleId = useId()
const heading = shallowRef<HTMLElement>()
const data = shallowRef<PropertyWorkspace>()
const offset = ref(0)
const state = ref<'loading' | 'ready' | 'unavailable' | 'stale' | 'failed'>('loading')
let request: AbortController | undefined

async function load(start: number) {
  request?.abort()
  const controller = request = new AbortController()
  const session = currentSession.value
  const epoch = credentialEpoch.value
  if (!session?.siteSessionId || !session.canAuthor || session.expiresAt <= Date.now()) {
    state.value = 'unavailable'
    return
  }
  const handle = session.siteSessionId
  const { articleId, revision, sourceRevision } = props
  const current = () => !controller.signal.aborted && props.articleId === articleId && props.revision === revision &&
    props.sourceRevision === sourceRevision && credentialEpoch.value === epoch &&
    currentSession.value?.siteSessionId === handle && currentSession.value.canAuthor && currentSession.value.expiresAt > Date.now()
  const previous = data.value
  state.value = 'loading'
  try {
    const page = await propertyApi.history({ articleId, articleRevision: revision, sourceRevision, offset: start || undefined }, handle, controller.signal)
    if (!current()) return
    if (previous && (previous.schemaRevision !== page.schemaRevision || previous.valueRevision !== page.valueRevision))
      throw Error('The saved property snapshot coordinates changed.')
    data.value = page
    offset.value = start
    state.value = 'ready'
  } catch (error) {
    if (!current()) return
    data.value = undefined
    state.value = error instanceof ApiError && error.status === 409 ? 'stale'
      : error instanceof ApiError && [401, 403, 404].includes(error.status) ? 'unavailable' : 'failed'
  }
}

async function turn(forward: boolean) {
  const page = data.value
  if (state.value !== 'ready' || !page || (forward ? !page.nextKey : offset.value === 0)) return
  const opener = document.activeElement
  const epoch = credentialEpoch.value
  await load(forward ? offset.value + page.fields.length : offset.value - WireLimits.PropertyPageSize)
  await nextTick()
  if (epoch === credentialEpoch.value && (document.activeElement === opener || document.activeElement === document.body))
    heading.value?.focus()
}

watch(() => [props.articleId, props.revision, props.sourceRevision, credentialEpoch.value], () => {
  data.value = undefined
  offset.value = 0
  void load(0)
}, { immediate: true, flush: 'sync' })
onScopeDispose(() => request?.abort())
</script>

<template>
  <section class="revision-properties" :aria-labelledby="titleId">
    <h4 :id="titleId" ref="heading" tabindex="-1">{{ label }}</h4>
    <p v-if="state === 'loading'" role="status">{{ t('author.revisionPropertyPage.loading.saved.properties') }}</p>
    <p v-else-if="state === 'unavailable'" role="status">{{ t('author.revisionPropertyPage.no.property.snapshot.is.available.for.this.revision') }}</p>
    <p v-else-if="state === 'stale'" role="alert">{{ t('author.revisionPropertyPage.the.saved.draft.changed.reopen.the.comparison.for') }}</p>
    <template v-else-if="state === 'failed'">
      <p role="alert">{{ t('author.revisionPropertyPage.could.not.load.saved.properties') }}</p>
      <ElButton text native-type="button" @click="load(0)">{{ t('author.revisionPropertyPage.reload.saved.properties') }}</ElButton>
    </template>
    <template v-if="state === 'ready' && data">
      <p v-if="!data.fields.length">{{ t('author.revisionPropertyPage.no.saved.property.values') }}</p>
      <dl v-else>
        <template v-for="field in data.fields" :key="field.definitionId">
          <dt>{{ field.label }}</dt>
          <dd>{{ showPropertyValue(field) }}</dd>
        </template>
      </dl>
      <nav v-if="offset > 0 || data.nextKey" class="revision-property-pages" :aria-label="`${label} pages`">
        <ElButton text native-type="button" :disabled="offset === 0" @click="turn(false)">{{ t('reading.previous') }}</ElButton>
        <span role="status">{{ t('author.revisionPropertyPage.page', { p0: String(1 + offset / WireLimits.PropertyPageSize) }) }}</span>
        <ElButton text native-type="button" :disabled="!data.nextKey" @click="turn(true)">{{ t('reading.next') }}</ElButton>
      </nav>
    </template>
  </section>
</template>

<style scoped>
.revision-properties { min-inline-size: 0; overflow-wrap: anywhere; }
.revision-properties h4, .revision-properties dl { margin-block: var(--fsus-space-2); }
.revision-properties dt { font-weight: 600; }
.revision-properties dd { margin: 0 0 var(--fsus-space-2); }
.revision-property-pages { display: flex; align-items: center; gap: var(--fsus-space-2); flex-wrap: wrap; }
</style>
