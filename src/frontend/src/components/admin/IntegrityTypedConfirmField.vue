<template>
  <div
    class="integrity-typed-confirm"
    :class="{
      'integrity-typed-confirm--complete': isComplete,
      'integrity-typed-confirm--invalid': isInvalid
    }"
  >
    <label class="integrity-typed-confirm__label" :for="controlId">{{ label }}</label>
    <p v-if="hasDescription" :id="descriptionId" class="integrity-typed-confirm__description">
      <slot name="description">{{ description }}</slot>
    </p>
    <code :id="phraseId" class="integrity-typed-confirm__phrase">{{ phrase }}</code>
    <input
      :id="controlId"
      class="integrity-typed-confirm__input"
      :name="name"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :required="required"
      :aria-describedby="describedby"
      :aria-invalid="isInvalid ? 'true' : undefined"
      autocomplete="off"
      spellcheck="false"
      @input="handleInput"
      @change="handleChange"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, useId, useSlots } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: string
  phrase: string
  label?: string
  description?: string
  id?: string
  name?: string
  placeholder?: string
  disabled?: boolean
  required?: boolean
}>(), {
  label: '确认短语',
  description: '',
  id: '',
  name: undefined,
  placeholder: '',
  disabled: false,
  required: true
})

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'change', value: string): void
}>()

const slots = useSlots()
const fallbackId = useId()

const controlId = computed(() => props.id || `${fallbackId}-input`)
const phraseId = computed(() => `${controlId.value}-phrase`)
const descriptionId = computed(() => `${controlId.value}-description`)
const hasDescription = computed(() => Boolean(props.description || slots.description))
const isComplete = computed(() => props.phrase.length > 0 && props.modelValue === props.phrase)
const isInvalid = computed(() => props.modelValue.length > 0 && !isComplete.value)
const describedby = computed(() =>
  [phraseId.value, hasDescription.value ? descriptionId.value : '']
    .filter(Boolean)
    .join(' ')
)

const handleInput = (event: Event): void => {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}

const handleChange = (event: Event): void => {
  emit('change', (event.target as HTMLInputElement).value)
}
</script>

<style scoped>
.integrity-typed-confirm {
  display: grid;
  gap: 0.5rem;
  min-width: 0;
}

.integrity-typed-confirm__label {
  color: var(--fsusblog-text-primary);
  font-size: 0.8125rem;
  font-weight: 700;
}

.integrity-typed-confirm__description {
  margin: 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.75rem;
  line-height: 1.7;
}

.integrity-typed-confirm__phrase {
  width: fit-content;
  max-width: 100%;
  overflow-wrap: anywhere;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-control-small);
  background: var(--fsusblog-page-bg-soft);
  padding: 0.35rem 0.5rem;
  color: var(--fsusblog-text-primary);
  font-size: 0.8125rem;
  line-height: 1.5;
}

.integrity-typed-confirm__input {
  width: 100%;
  min-height: 2.25rem;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-control);
  background: var(--fsusblog-page-bg);
  color: var(--fsusblog-text-primary);
  padding: 0.45rem 0.625rem;
  font: inherit;
}

.integrity-typed-confirm__input:focus-visible {
  outline: 2px solid var(--fsusblog-color-primary);
  outline-offset: 2px;
}

.integrity-typed-confirm--invalid .integrity-typed-confirm__input {
  border-color: var(--fsusblog-color-error, #dc2626);
}

.integrity-typed-confirm--complete .integrity-typed-confirm__input {
  border-color: var(--fsusblog-color-success, #16a34a);
}
</style>
