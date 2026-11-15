<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElCard, ElOption, ElSelect } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import { applyAppearance, readAdminAppearance, readAppearanceCatalog, readAppearanceHistory } from '../../../Contracts/admin-appearance'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ 'session-lost': [error: unknown] }>()
const lifetime = new AbortController()
const signal = () => AbortSignal.any([lifetime.signal, props.sessionSignal])
const state = shallowRef<Awaited<ReturnType<typeof readAdminAppearance>>>()
const catalog = shallowRef<Awaited<ReturnType<typeof readAppearanceCatalog>>>()
const history = shallowRef<Awaited<ReturnType<typeof readAppearanceHistory>>>()
const historyBefore = shallowRef<bigint>()
const historyHeading = ref<HTMLElement>()
const theme = ref('')
const font = ref('')
const busy = ref(false)
const notice = ref('')
const error = ref('')
const canApply = computed(() => state.value && (theme.value !== state.value.theme || font.value !== state.value.font) &&
  (!theme.value || catalog.value?.some(item => !item.font && item.archive === theme.value)) &&
  (!font.value || catalog.value?.some(item => item.font && item.archive === font.value)))

async function read(request: AbortSignal) {
  const [next, packages] = await Promise.all([readAdminAppearance(request), readAppearanceCatalog(request)])
  if (request.aborted) return
  state.value = next
  catalog.value = packages
  history.value = undefined
  historyBefore.value = undefined
  theme.value = next.theme
  font.value = next.font
}

function readHistory(before?: bigint) {
  return run(async request => {
    const next = await readAppearanceHistory(before, request)
    if (request.aborted) return
    history.value = next
    historyBefore.value = before
    await nextTick()
    if (!request.aborted) historyHeading.value?.focus()
  }, 'Appearance history requires system.config.')
}

function historyTime(unixMs: bigint) {
  return new Date(Number(unixMs)).toISOString()
}

function name(digest: string) {
  return digest.length ? catalog.value?.find(item => item.archive === digest)?.id ?? 'Unavailable package' : 'Built-in'
}

async function run(action: (request: AbortSignal) => Promise<void>,
  forbidden = 'Appearance requires system.config and current Passkey confirmation.') {
  if (busy.value || props.sessionSignal.aborted) return
  const request = signal()
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await action(request)
  } catch (cause) {
    if (request.aborted) return
    if (cause instanceof ApiError && cause.status === 401 && !cause.details.startsWith('pow_')) {
      emit('session-lost', cause)
    } else if (cause instanceof ApiError && cause.status === 404) {
      error.value = 'Online appearance is unavailable.'
    } else if (cause instanceof ApiError && cause.status === 403) {
      error.value = forbidden
    } else if (cause instanceof ApiError && cause.status === 409) {
      state.value = undefined
      error.value = 'The active appearance changed. Reload before applying.'
    } else {
      error.value = 'Could not complete the request. Check the active appearance before trying again.'
    }
  } finally {
    busy.value = false
  }
}

function apply(rollback: boolean) {
  const current = state.value
  if (!current || (rollback ? !current.canRollback : !canApply.value)) return
  return run(async request => {
    await applyAppearance({ expectedRevision: current.revision, currentTheme: current.theme, currentFont: current.font,
      theme: rollback ? current.previousTheme : theme.value, font: rollback ? current.previousFont : font.value, rollback }, request)
    await read(request)
    if (!request.aborted) notice.value = rollback ? 'Previous appearance restored.' : 'Appearance applied.'
  })
}

watch(() => props.sessionSignal, (current, _, cleanup) => {
  const clear = () => {
    state.value = undefined
    catalog.value = undefined
    history.value = undefined
    historyBefore.value = undefined
    theme.value = ''
    font.value = ''
    notice.value = ''
    error.value = ''
  }
  clear()
  current.addEventListener('abort', clear, { once: true })
  cleanup(() => current.removeEventListener('abort', clear))
}, { immediate: true, flush: 'sync' })
onScopeDispose(() => lifetime.abort())
</script>

<template>
  <section class="auth-form" aria-labelledby="admin-appearance">
    <h2 id="admin-appearance">Site appearance</h2>
    <ElButton :loading="busy" native-type="button" @click="run(read)">Check active appearance</ElButton>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" />
    <p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="state && catalog">
      <p>Active theme: {{ name(state.theme) }} · Active font: {{ name(state.font) }}</p>
      <p v-if="!state.serving" role="status">Built-in appearance is serving because the selected package is unavailable.</p>
      <label for="admin-appearance-theme">Theme</label>
      <ElSelect id="admin-appearance-theme" v-model="theme" ariaLabel="Theme" :disabled="busy">
        <ElOption v-if="state.theme && !catalog.some(item => item.archive === state?.theme)" :value="state.theme" label="Unavailable package" disabled />
        <ElOption value="" label="Built-in" />
        <ElOption v-for="item in catalog.filter(item => !item.font)" :key="item.archive" :value="item.archive" :label="`${item.id} ${item.version}`" />
      </ElSelect>
      <label for="admin-appearance-font">Font</label>
      <ElSelect id="admin-appearance-font" v-model="font" ariaLabel="Font" :disabled="busy">
        <ElOption v-if="state.font && !catalog.some(item => item.archive === state?.font)" :value="state.font" label="Unavailable package" disabled />
        <ElOption value="" label="Built-in" />
        <ElOption v-for="item in catalog.filter(item => item.font)" :key="item.archive" :value="item.archive" :label="`${item.id} ${item.version}`" />
      </ElSelect>
      <ElButton type="primary" :disabled="busy || !canApply" native-type="button" @click="apply(false)">Apply appearance with Passkey</ElButton>
      <ElButton v-if="state.canRollback" :disabled="busy" native-type="button" @click="apply(true)">
        Restore {{ name(state.previousTheme) }} / {{ name(state.previousFont) }} with Passkey
      </ElButton>
      <ElButton :disabled="busy" native-type="button" @click="readHistory()">
        {{ historyBefore === undefined ? 'Check appearance history' : 'Back to latest appearance changes' }}
      </ElButton>
      <section v-if="history" aria-labelledby="admin-appearance-history">
        <h3 id="admin-appearance-history" ref="historyHeading" tabindex="-1">Appearance history</h3>
        <p v-if="history.items.length === 0">No appearance changes recorded.</p>
        <ol v-else class="appearance-history">
          <li v-for="change in history.items" :key="String(change.revision)">
            <ElCard shadow="never">
              <strong>{{ change.rollback ? 'Rolled back' : 'Applied' }} · revision {{ change.revision }}</strong>
              <p><time :datetime="historyTime(change.happenedUnixMs)">{{ historyTime(change.happenedUnixMs) }}</time> · {{ change.actor }}</p>
              <dl>
                <dt>Theme archive</dt>
                <dd><code>{{ change.previousTheme || 'Built-in' }}</code> → <code>{{ change.theme || 'Built-in' }}</code></dd>
                <dt>Font archive</dt>
                <dd><code>{{ change.previousFont || 'Built-in' }}</code> → <code>{{ change.font || 'Built-in' }}</code></dd>
              </dl>
            </ElCard>
          </li>
        </ol>
        <ElButton v-if="history.nextBefore" :disabled="busy" native-type="button" @click="readHistory(history.nextBefore ?? undefined)">
          Earlier appearance changes
        </ElButton>
      </section>
    </template>
  </section>
</template>

<style scoped>
.appearance-history { display: grid; gap: .75rem; padding: 0; list-style: none; }
.appearance-history dd { margin-inline-start: 0; overflow-wrap: anywhere; }
</style>
