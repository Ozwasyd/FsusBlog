<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, ref, watch } from 'vue'
import { ElAlert, ElButton, ElCheckbox, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus'
import { draftRights, type RightsEdit } from '../../../Contracts/article-rights'

const props = defineProps<{ articleId: number; revision: bigint; canChange: boolean }>()
const emit = defineEmits<{ save: [policy: RightsEdit] }>()
const licenses = ['all-rights-reserved', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'CC0-1.0']
const policies = ['append-attribution', 'excerpt-only', 'disabled']
const open = ref(false)
const policy = ref<RightsEdit>()
const present = ref(false)
const error = ref('')
const year = ref('')
const excerpt = ref('')
const valid = computed(() => !!policy.value && (!year.value || /^[1-9]\d{3}$/.test(year.value)) &&
  /^\d{1,5}$/.test(excerpt.value) && Number(excerpt.value) <= 10000)

watch(() => [props.articleId, props.revision, open.value] as const, async ([id, revision, visible], _, cleanup) => {
  const stop = new AbortController()
  cleanup(() => stop.abort())
  policy.value = undefined
  error.value = ''
  present.value = false
  if (!visible) return
  try {
    const result = await draftRights(id, revision, stop.signal)
    if (stop.signal.aborted) return
    present.value = result.present
    policy.value = {
      enabled: result.present ? result.enabled : true,
      licenseType: result.licenseType || licenses[0],
      copyrightHolder: result.copyrightHolder,
      copyrightYear: result.copyrightYear,
      rightsStatement: result.rightsStatement,
      attributionTemplate: result.attributionTemplate,
      copyPolicy: result.copyPolicy || policies[0],
      maxExcerptChars: result.maxExcerptChars,
      allowCodeCopy: result.present ? result.allowCodeCopy : true,
      showPublicBadge: result.present ? result.showPublicBadge : true,
      proofBindingEnabled: result.proofBindingEnabled,
    }
    year.value = result.copyrightYear ? String(result.copyrightYear) : ''
    excerpt.value = result.present ? String(result.maxExcerptChars) : '300'
  } catch {
    if (!stop.signal.aborted) error.value = t('author.articleRights.could.not.load.this.revision.s.rights.policy.reopen')
  }
}, { flush: 'sync' })

function toggle(event: Event) {
  open.value = (event.currentTarget as HTMLDetailsElement).open
}

function save() {
  if (!policy.value || !valid.value || !props.canChange) return
  emit('save', {
    ...policy.value, copyrightHolder: policy.value.copyrightHolder.trim(),
    rightsStatement: policy.value.rightsStatement.trim(), attributionTemplate: policy.value.attributionTemplate.trim(),
    copyrightYear: Number(year.value), maxExcerptChars: Number(excerpt.value),
  })
}
</script>

<template>
  <details @toggle="toggle">
    <summary>{{ t('author.articleRights.publication.rights') }}</summary>
    <ElAlert v-if="error" :title="error" :closable="false" type="error" />
    <p v-else-if="open && !policy" role="status">{{ t('author.articleRights.loading.rights') }}</p>
    <div v-if="policy" class="rights-fields">
      <p v-if="!present">{{ t('author.articleRights.this.revision.has.no.stored.rights.policy.save') }}</p>
      <ElCheckbox :model-value="policy.enabled" :disabled="!canChange" @update:model-value="policy.enabled = $event === true">{{ t('author.articleRights.enable.rights.notice') }}</ElCheckbox>
      <label for="draft-rights-license">{{ t('author.articleRights.license') }}</label>
      <ElSelect id="draft-rights-license" v-model="policy.licenseType" :ariaLabel="t('author.articleRights.license')" :disabled="!canChange">
        <ElOption v-for="license in licenses" :key="license" :label="license" :value="license" />
      </ElSelect>
      <label for="draft-rights-holder">{{ t('author.articleRights.copyright.holder') }}</label>
      <ElInput id="draft-rights-holder" v-model="policy.copyrightHolder" :disabled="!canChange" />
      <label for="draft-rights-year">{{ t('author.articleRights.copyright.year') }}</label>
      <ElInput id="draft-rights-year" v-model="year" :disabled="!canChange" />
      <label for="draft-rights-statement">{{ t('author.articleRights.rights.statement') }}</label>
      <ElInput id="draft-rights-statement" v-model="policy.rightsStatement" type="textarea" :disabled="!canChange" />
      <label for="draft-rights-attribution">{{ t('author.articleRights.attribution.template') }}</label>
      <ElInput id="draft-rights-attribution" v-model="policy.attributionTemplate" type="textarea" :disabled="!canChange" />
      <label for="draft-rights-copy">{{ t('author.articleRights.copy.policy') }}</label>
      <ElSelect id="draft-rights-copy" v-model="policy.copyPolicy" :ariaLabel="t('author.articleRights.copy.policy')" :disabled="!canChange">
        <ElOption v-for="value in policies" :key="value" :label="value" :value="value" />
      </ElSelect>
      <label for="draft-rights-excerpt">{{ t('author.articleRights.maximum.excerpt.characters') }}</label>
      <ElInput id="draft-rights-excerpt" v-model="excerpt" :disabled="!canChange" />
      <ElCheckbox :model-value="policy.allowCodeCopy" :disabled="!canChange"
        @update:model-value="policy.allowCodeCopy = $event === true">{{ t('author.articleRights.allow.code.copy.controls') }}</ElCheckbox>
      <ElCheckbox :model-value="policy.showPublicBadge" :disabled="!canChange"
        @update:model-value="policy.showPublicBadge = $event === true">{{ t('author.articleRights.show.the.public.rights.notice') }}</ElCheckbox>
      <ElCheckbox :model-value="policy.proofBindingEnabled" :disabled="!canChange"
        @update:model-value="policy.proofBindingEnabled = $event === true">{{ t('author.articleRights.request.proof.binding') }}</ElCheckbox>
      <ElButton :disabled="!canChange || !valid" @click="save">{{ t('author.articleRights.save.publication.rights') }}</ElButton>
    </div>
  </details>
</template>

<style scoped>
summary { cursor: pointer; }
.rights-fields { display: grid; gap: .45rem; padding-block: .5rem; }
</style>
