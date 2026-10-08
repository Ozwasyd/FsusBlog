<template>
    <div
        class="locale-selector"
        :class="{ 'locale-selector--compact': compact, 'locale-selector--disabled': disabled }"
        data-locale-selector
        :data-compact="compact ? 'true' : 'false'"
        :data-active-locale="activeLocale"
        :data-pending-locale="pendingLocale || undefined"
    >
        <ElDropdown
            ref="dropdown"
            trigger="click"
            max-height="70vh"
            :hide-on-click="false"
            :disabled="disabled"
            @visible-change="handleVisibleChange"
            @command="handleCommand"
        >
            <ElButton
                data-locale-selector-trigger
                :disabled="disabled"
                :aria-label="triggerAriaLabel"
            >
                <svg
                    class="locale-selector__globe-icon"
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.75"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                    focusable="false"
                >
                    <circle
                        cx="12"
                        cy="12"
                        r="9"
                    />
                    <path d="M3 12h18" />
                    <path d="M12 3a14 14 0 0 1 0 18" />
                    <path d="M12 3a14 14 0 0 0 0 18" />
                </svg>
                <span class="safe-inline-wrap">{{ triggerLabel }}</span>
                <Loading
                    v-if="pendingLocale"
                    class="locale-selector__spinner"
                    data-locale-selector-trigger-pending
                    aria-hidden="true"
                />
            </ElButton>
            <template #dropdown>
                <ElDropdownMenu
                    data-locale-selector-menu
                    :aria-label="triggerAriaLabel"
                >
                    <ElDropdownItem
                        v-for="item in items"
                        :key="item.code"
                        :command="item"
                        :checked="isSelected(item)"
                        :disabled="disabled"
                        data-locale-selector-item
                        :data-locale-code="item.code"
                        :data-selected="isSelected(item) ? 'true' : 'false'"
                        :data-pending="isPending(item) ? 'true' : 'false'"
                        :aria-current="isSelected(item) ? 'true' : undefined"
                        :dir="item.direction"
                    >
                        <span class="locale-selector__item-copy safe-inline-wrap">
                            <span class="locale-selector__item-native">{{ item.nativeName }}</span>
                            <span
                                v-if="item.englishName && item.englishName !== item.nativeName"
                                class="locale-selector__item-english"
                            >
                                {{ item.englishName }}
                            </span>
                        </span>
                        <span
                            class="locale-selector__item-status"
                            aria-hidden="true"
                        >
                            <Loading
                                v-if="isPending(item)"
                                class="locale-selector__spinner"
                                data-locale-selector-item-pending
                            />
                            <Check
                                v-else-if="isSelected(item)"
                                class="locale-selector__check"
                                data-locale-selector-item-check
                            />
                        </span>
                    </ElDropdownItem>
                    <li
                        v-if="errorMessage"
                        role="presentation"
                    >
                        <p
                            class="locale-selector__error-message safe-inline-wrap"
                            data-locale-selector-error
                            role="alert"
                        >{{ errorMessage }}</p>
                    </li>
                    <ElDropdownItem
                        v-if="errorMessage"
                        command="retry"
                        :disabled="disabled || !resolvedRetryLocale"
                        data-locale-selector-retry
                        :aria-label="retryLabel"
                    >
                        <Refresh
                            class="locale-selector__retry-icon"
                            aria-hidden="true"
                        />
                        <span class="safe-inline-wrap">{{ retryLabel }}</span>
                    </ElDropdownItem>
                </ElDropdownMenu>
            </template>
        </ElDropdown>
        <div
            v-if="errorMessage && !visible"
            class="locale-selector__error"
        >
            <p
                class="locale-selector__error-message safe-inline-wrap"
                data-locale-selector-error
                role="alert"
            >{{ errorMessage }}</p>
            <ElButton
                data-locale-selector-retry
                :disabled="disabled || !resolvedRetryLocale"
                :aria-label="retryLabel"
                @click="handleRetry"
            >
                <Refresh
                    class="locale-selector__retry-icon"
                    aria-hidden="true"
                />
                <span class="safe-inline-wrap">{{ retryLabel }}</span>
            </ElButton>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu } from '@ozwasyd/element-plus';
import { computed, ref, watch } from 'vue';

import { findActiveLocaleItem, isLocaleItemPending, localeRetryLabel, localeTriggerAriaLabel, localeTriggerLabel } from '@/components/ui/localeSelectorPresentation';
import type { LocaleSelectorItem, LocaleSelectorProps } from '@/components/ui/localeSelectorTypes';
import { Check, Loading, Refresh } from '@/fsusui/icons';

const props = withDefaults(defineProps<LocaleSelectorProps>(), {
    pendingLocale: null,
    retryLocale: null,
    open: undefined,
    disabled: false,
    errorMessage: null,
    compact: false
});
const emit = defineEmits<{
    select: [locale: string];
    'open-change': [open: boolean];
    retry: [locale: string];
}>();
const dropdown = ref<{ handleOpen: () => void; handleClose: () => void; } | null>(null);
// Visibility is an observation of the library, never a second popup owner.
const visible = ref(false);
const activeItem = computed(() => findActiveLocaleItem(props.items, props.activeLocale));
const triggerLabel = computed(() => localeTriggerLabel(activeItem.value, props.activeLocale, props.compact));
const triggerAriaLabel = computed(() => localeTriggerAriaLabel(activeItem.value, props.activeLocale));
const resolvedRetryLocale = computed(() => props.retryLocale ?? props.pendingLocale ?? props.activeLocale);
const retryLabel = computed(() => localeRetryLabel(props.items, resolvedRetryLocale.value));
const isSelected = (item: LocaleSelectorItem): boolean => item.code === props.activeLocale;
const isPending = (item: LocaleSelectorItem): boolean => isLocaleItemPending(item, props.pendingLocale);

function handleVisibleChange(open: boolean): void
{
    visible.value = open;
    emit('open-change', open);
}

function handleRetry(): void
{
    if (!props.disabled && resolvedRetryLocale.value)
    {
        emit('retry', resolvedRetryLocale.value);
    }
}

function handleCommand(command: LocaleSelectorItem | 'retry'): void
{
    if (props.disabled)
    {
        return;
    }
    if (command === 'retry')
    {
        handleRetry();
        return;
    }
    // Public command activation covers pointer, Enter and Space. URLs remain
    // a product adapter; a URL item never starts a locale resource transaction.
    if (command.href)
    {
        globalThis.location.assign(command.href);
        return;
    }
    emit('select', command.code);
}

watch([() => props.open, () => props.disabled, dropdown], ([open, disabled]) =>
{
    if (disabled || open === false)
    {
        if (visible.value)
        {
            dropdown.value?.handleClose();
        }
    }
    else if (open === true && !visible.value)
    {
        dropdown.value?.handleOpen();
    }
}, { flush: 'post' });
</script>

<style scoped>
.locale-selector
 {
    display: inline-flex;
    min-width: 0;
    max-width: 100%;
    flex-direction: column;
}

.locale-selector__item-copy
 {
    display: flex;
    min-width: 0;
    flex-direction: column;
    white-space: normal;
    overflow-wrap: anywhere;
}

.locale-selector__item-native
 {
    font-weight: 600;
}

.locale-selector__item-english
 {
    font-size: 0.75rem;
    color: var(--fsusblog-text-muted);
}

.locale-selector__item-status
 {
    display: inline-flex;
    margin-inline-start: auto;
}

.locale-selector__spinner,
.locale-selector__check,
.locale-selector__retry-icon
 {
    width: 1rem;
    height: 1rem;
}

.locale-selector__spinner
 {
    animation: locale-selector-spin 0.8s linear infinite;
}

.locale-selector__error-message
 {
    margin: 0;
    white-space: normal;
    overflow-wrap: anywhere;
}

@keyframes locale-selector-spin
 {
    to
 {
        transform: rotate(360deg);
    }
}

@media (prefers-reduced-motion: reduce)
 {
    .locale-selector__spinner
 {
        animation: none;
    }
}
</style>
