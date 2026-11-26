<script setup lang="ts">
import { ElInput } from '@ozwasyd/element-plus'
import { t } from '../siteLocale'
import { fieldId, fieldInputAttrs, fieldLabel, type SiteConfigField, type SiteConfigFieldControls } from './siteConfigFields'

const props = defineProps<{ fields: readonly SiteConfigField[]; controls: SiteConfigFieldControls }>()

function inputAttrs(field: SiteConfigField) {
  return fieldInputAttrs(field.key, !!props.controls.error(field.key), {
    ...field,
    hintId: field.hint ? fieldId('hint', field.key) : field.hintId,
  })
}
</script>

<template>
  <div v-for="field in fields" :key="field.key" class="config-field">
    <label :for="fieldId('field', field.key)">{{ t(fieldLabel(field.key)) + (field.required ? ' ' : '') }}<span v-if="field.required" aria-hidden="true">*</span></label>
    <span v-if="field.hint" :id="fieldId('hint', field.key)" class="config-hint">{{ t(field.hint) }}</span>
    <ElInput :id="fieldId('field', field.key)" :model-value="controls.values[field.key]" :type="field.type"
      :placeholder="field.placeholder" :autosize="field.autosize" :disabled="controls.disabled" v-bind="inputAttrs(field)"
      @update:model-value="controls.change(field.key, $event)" @blur="controls.blur(field.key)" @input="controls.input(field.key)" />
    <p v-if="controls.error(field.key)" :id="fieldId('error', field.key)" class="config-error">{{ controls.error(field.key) }}</p>
  </div>
</template>
