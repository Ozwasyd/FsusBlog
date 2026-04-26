<template>
  <component
    :is="componentType"
    v-bind="componentBindings"
    :aria-label="ariaLabel"
    :aria-disabled="isDisabled ? 'true' : undefined"
    :data-aot-action="action?.action"
    :data-aot-value="action?.value"
    :class="buttonClass"
    @click="handleClick"
  >
    <span v-if="loading" class="ui-button__spinner" aria-hidden="true" />
    <slot>{{ label }}</slot>
  </component>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import type { ButtonSize, ButtonTone, ButtonVariant, UiActionContract } from '@/ui-contracts/primitives';
import { themeTokens } from '@/ui-tokens/themeTokens';

const props = withDefaults(defineProps<{
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  tone?: ButtonTone;
  href?: string;
  to?: RouteLocationRaw;
  disabled?: boolean;
  loading?: boolean;
  ariaLabel?: string;
  action?: UiActionContract;
  block?: boolean;
}>(), {
  label: '',
  variant: 'plain',
  size: 'md',
  tone: 'neutral',
  disabled: false,
  loading: false,
  block: false
});

const emit = defineEmits<{
  (event: 'click', value: MouseEvent): void;
}>();

const isDisabled = computed(() => props.disabled || props.loading);
const componentType = computed(() => props.to ? RouterLink : props.href ? 'a' : 'button');
const componentBindings = computed(() => {
  if (props.to) {
    return { to: props.to };
  }

  if (props.href) {
    return { href: props.href };
  }

  return {
    type: 'button',
    disabled: isDisabled.value
  };
});

const buttonClass = computed(() => {
  return [
    themeTokens.primitives.buttonBase,
    themeTokens.primitives.buttonSizes[props.size],
    themeTokens.primitives.buttonVariants[props.variant],
    themeTokens.primitives.buttonTones[props.tone],
    isDisabled.value ? themeTokens.primitives.buttonDisabled : '',
    props.block ? 'w-full' : ''
  ].filter(Boolean).join(' ');
});

function handleClick(event: MouseEvent): void {
  if (isDisabled.value) {
    event.preventDefault();
    return;
  }

  emit('click', event);
}
</script>

<style scoped>
.ui-button__spinner {
  width: 0.75rem;
  height: 0.75rem;
  margin-right: 0.5rem;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 999px;
  animation: ui-button-spin 0.8s linear infinite;
}

@keyframes ui-button-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
