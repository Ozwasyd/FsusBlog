<script setup lang="ts">
import { ElButton, type ButtonInstance } from '@ozwasyd/element-plus'
import { onMounted, onScopeDispose, ref, useTemplateRef, watch } from 'vue'
import type { Article } from '../../../Contracts/public-articles'
import { PublicationProofError, publicationProofPath, verifyCurrentPublication } from '../../../Contracts/article-publication-proof'

const props = defineProps<{ article: Article }>()
const state = ref<'idle' | 'busy' | 'verified' | 'unavailable' | 'invalid' | 'expired'>('idle')
const checkedAt = ref('')
const verifyButton = useTemplateRef<ButtonInstance>('verifyButton')
const receipt = useTemplateRef<HTMLAnchorElement>('receipt')
let pending: AbortController | undefined
let expires: number | undefined

function clear() {
  pending?.abort()
  pending = undefined
  window.clearTimeout(expires)
  expires = undefined
  state.value = 'idle'
  checkedAt.value = ''
}

function expire() {
  if (state.value === 'expired') return
  const wasVerified = state.value === 'verified'
  if (!document.hidden && receipt.value === document.activeElement) verifyButton.value?.ref?.focus()
  clear()
  if (wasVerified) state.value = 'expired'
}

async function verify() {
  clear()
  const request = new AbortController()
  const article = props.article
  pending = request
  state.value = 'busy'
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(6_000)])
    await verifyCurrentPublication(article, location.origin, signal)
    if (pending !== request) return
    checkedAt.value = new Date().toISOString()
    state.value = 'verified'
    expires = window.setTimeout(expire, 30_000)
  } catch (error) {
    if (pending === request) {
      state.value = error instanceof PublicationProofError && error.reason === 'invalid' ? 'invalid' : 'unavailable'
    }
  } finally {
    if (pending === request) pending = undefined
  }
}

watch(() => props.article, clear, { flush: 'sync' })
onMounted(() => {
  document.addEventListener('visibilitychange', expire)
  window.addEventListener('pagehide', clear)
})
onScopeDispose(() => {
  document.removeEventListener('visibilitychange', expire)
  window.removeEventListener('pagehide', clear)
  clear()
})
</script>

<template>
  <section class="publication-proof" aria-label="Publication verification">
    <ElButton ref="verifyButton" :loading="state === 'busy'" @click="verify">Verify publication</ElButton>
    <div role="status">
      <span v-if="state === 'verified'">
        Publication signature verified at <time :datetime="checkedAt">{{ new Date(checkedAt).toLocaleTimeString() }}</time>.
        It covers the title, original Markdown, taxonomy IDs, and rights policy.
        <a ref="receipt" :href="publicationProofPath(article)" target="_blank" rel="noopener noreferrer">Signed receipt (JSON)</a>
      </span>
      <span v-else-if="state === 'busy'">Checking the current publication…</span>
      <span v-else-if="state === 'unavailable'">Proof unavailable for this publication. Reload the article to check for an update.</span>
      <span v-else-if="state === 'invalid'">The publication signature could not be verified.</span>
      <span v-else-if="state === 'expired'">Verify again to see the latest publication signature status.</span>
    </div>
  </section>
</template>

<style scoped>
.publication-proof {
  display: grid;
  justify-items: start;
  margin-block: 1rem;
}
.publication-proof [role='status']:not(:empty) { margin-block-start: 0.5rem; }
</style>
