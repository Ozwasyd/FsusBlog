<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, onBeforeUnmount, ref } from 'vue'
import { ElAlert, ElButton, ElInput, ElRadio, ElRadioGroup, ElTaskPageHeader } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { cancelSubscription, enrollSubscription, type SubscriptionChannel } from '../../../Contracts/subscription-preference'
import { WireLimits } from '../../../Contracts/wire.generated'

const removing = ref(false)
const channel = ref<SubscriptionChannel>('rss')
const email = ref('')
const proof = ref('')
const pending = ref(false)
const feedback = ref<{ text: string, type: 'success' | 'error' }>()
const action = computed(() => removing.value ? t('account.message187') : t('account.message188'))
let request: AbortController | undefined

function selectMode(remove: boolean) {
  if (pending.value || removing.value === remove) return
  removing.value = remove
  proof.value = ''
  feedback.value = undefined
}

function selectChannel(value: string | number | boolean) {
  if (value === 'rss' || value === 'email') channel.value = value
}

async function submit() {
  if (pending.value) return
  const address = email.value.trim()
  const credential = proof.value.trim().toLowerCase()
  if (address.length > WireLimits.SubscriptionEmailBytes || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(address) || /[^!-~]/u.test(address)) {
    feedback.value = { text: t('account.message189'), type: 'error' }
    return
  }
  if (removing.value && (credential.length !== WireLimits.SubscriptionProofChars || !/^[0-9a-f]+$/.test(credential))) {
    feedback.value = { text: t('account.message190'), type: 'error' }
    return
  }

  const remove = removing.value
  const current = new AbortController()
  request = current
  pending.value = true
  feedback.value = undefined
  try {
    if (remove) await cancelSubscription(address, channel.value, credential, current.signal)
    else await enrollSubscription(address, channel.value, current.signal)
    if (current.signal.aborted) return
    email.value = ''
    proof.value = ''
    feedback.value = { type: 'success', text: remove
      ? t('account.message191')
      : t('account.message192') }
  } catch (error) {
    if (current.signal.aborted) return
    const status = error instanceof ApiError ? error.status : 0
    feedback.value = { type: 'error', text: status === 429 ? t('account.message193')
      : status === 400 || status === 428 ? (remove ? t('account.message194') : t('account.message195'))
      : t('account.message196') }
  } finally {
    if (!current.signal.aborted) pending.value = false
    if (request === current) request = undefined
  }
}

onBeforeUnmount(() => request?.abort())
</script>

<template>
  <article class="reading-column editorial-page subscription-page">
    <ElTaskPageHeader :title="t('account.message173')" density="compact" />
    <section class="subscription-section" aria-labelledby="subscription-feeds-heading">
      <h2 id="subscription-feeds-heading">{{ t('account.message174') }}</h2>
      <p>{{ t('account.message175') }}</p>
      <ul class="subscription-feeds">
        <li><a href="/feed/rss.xml" type="application/rss+xml">RSS</a></li>
        <li><a href="/feed/atom.xml" type="application/atom+xml">Atom</a></li>
        <li><a href="/feed/feed.json" type="application/feed+json">JSON Feed</a></li>
      </ul>
    </section>
    <section class="subscription-section" aria-labelledby="subscription-preference-heading">
      <h2 id="subscription-preference-heading">{{ t('account.message176') }}</h2>
      <p>{{ t('account.message177') }}</p>
      <div class="subscription-modes" role="group" :aria-label="t('account.message178')">
        <ElButton native-type="button" :type="removing ? undefined : 'primary'" :disabled="pending"
          v-bind="{ 'aria-pressed': !removing }" @click="selectMode(false)">{{ t('account.message179') }}</ElButton>
        <ElButton native-type="button" :type="removing ? 'primary' : undefined" :disabled="pending"
          v-bind="{ 'aria-pressed': removing }" @click="selectMode(true)">{{ t('account.message180') }}</ElButton>
      </div>
      <form class="subscription-form" :aria-label="action" :aria-busy="pending" novalidate @submit.prevent="submit">
        <label for="subscription-email">{{ t('account.message181') }}</label>
        <ElInput id="subscription-email" v-model="email" type="email" autocomplete="off" :disabled="pending" />
        <fieldset class="subscription-channels">
          <legend>{{ t('account.message182') }}</legend>
          <ElRadioGroup :model-value="channel" :disabled="pending" @update:model-value="selectChannel">
            <ElRadio value="rss">{{ t('account.message183') }}</ElRadio>
            <ElRadio value="email">{{ t('account.message184') }}</ElRadio>
          </ElRadioGroup>
        </fieldset>
        <template v-if="removing">
          <label for="subscription-proof">{{ t('account.message185') }}</label>
          <ElInput id="subscription-proof" v-model="proof" type="password" autocomplete="off" :disabled="pending"
            v-bind="{ 'aria-describedby': 'subscription-proof-description' }" />
          <p id="subscription-proof-description" class="subscription-note">{{ t('account.message186') }}</p>
        </template>
        <ElButton native-type="submit" type="primary" :loading="pending">{{ action }}</ElButton>
      </form>
      <ElAlert v-if="feedback" :title="feedback.text" :type="feedback.type" :closable="false" show-icon />
    </section>
  </article>
</template>

<style scoped>
.subscription-page { display: grid; gap: var(--fsus-space-6); }
.subscription-section { display: grid; gap: var(--fsus-space-3); }
h2, p, .subscription-feeds { margin: 0; }
.subscription-feeds, .subscription-modes { display: flex; flex-wrap: wrap; gap: var(--fsus-space-3); }
.subscription-feeds { padding: 0; list-style: none; }
.subscription-feeds a { display: inline-flex; align-items: center; min-height: 2.75rem; }
.subscription-modes > :deep(.el-button + .el-button) { margin-inline-start: 0; }
.subscription-form { display: grid; gap: var(--fsus-space-2); max-width: 26rem; }
.subscription-form > :deep(.el-button) { justify-self: start; margin-block-start: var(--fsus-space-2); }
.subscription-channels { border: 0; padding: 0; margin: var(--fsus-space-2) 0; }
.subscription-channels legend { padding: 0; }
.subscription-note { color: var(--fsus-color-text-muted); }
</style>
