<template>
  <component
    :is="href ? 'a' : 'button'"
    :href="href"
    :disabled="!href ? disabled : undefined"
    :aria-label="contract.ariaLabel"
    :data-aot-action="contract.action?.action"
    :data-aot-value="contract.action?.value"
    :class="buttonClass"
  >
    <slot>{{ contract.label }}</slot>
  </component>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ButtonContract } from '@/ui-contracts/primitives';
import { themeTokens } from '@/ui-tokens/themeTokens';

const props = defineProps<{
  contract: ButtonContract;
  extraClass?: string;
}>();

const href = computed(() => props.contract.href);
const disabled = computed(() => props.contract.disabled === true);

const buttonClass = computed(() => {
  const variant = props.contract.variant === 'primary'
    ? themeTokens.primitives.buttonPrimary
    : props.contract.variant === 'quiet'
      ? themeTokens.primitives.buttonQuiet
      : themeTokens.primitives.buttonPlain;

  return [
    variant,
    disabled.value ? themeTokens.primitives.buttonDisabled : '',
    props.extraClass ?? ''
  ].filter(Boolean).join(' ');
});
</script>
