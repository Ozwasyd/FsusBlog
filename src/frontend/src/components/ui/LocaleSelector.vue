<template>
    <div
        ref="rootRef"
        class="locale-selector"
        :class="{
            'locale-selector--compact': compact,
            'locale-selector--open': resolvedOpen,
            'locale-selector--disabled': disabled,
            'locale-selector--pending': Boolean(pendingLocale),
            'locale-selector--error': Boolean(errorMessage)
        }"
        data-locale-selector
        :data-compact="compact ? 'true' : 'false'"
        :data-active-locale="activeLocale"
        :data-pending-locale="pendingLocale || undefined"
    >
        <FsusUiButton
            ref="triggerRef"
            native-type="button"
            class="locale-selector__trigger"
            data-locale-selector-trigger
            :aria-label="triggerAriaLabel"
            aria-haspopup="menu"
            :aria-expanded="resolvedOpen ? 'true' : 'false'"
            :aria-controls="menuId"
            :aria-disabled="disabled ? 'true' : undefined"
            :disabled="disabled"
            @click="handleTriggerClick"
            @keydown="handleTriggerKeydown"
        >
            <span class="locale-selector__trigger-content">
                <span
                    class="locale-selector__globe"
                    aria-hidden="true"
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
                </span>
                <span class="locale-selector__trigger-label safe-inline-wrap">
                    {{ triggerLabel }}
                </span>
                <span
                    v-if="pendingLocale"
                    class="locale-selector__trigger-pending"
                    data-locale-selector-trigger-pending
                    aria-hidden="true"
                >
                    <Loading class="locale-selector__spinner" />
                </span>
            </span>
        </FsusUiButton>

        <div
            :id="menuId"
            class="locale-selector__menu"
            data-locale-selector-menu
            role="menu"
            :aria-label="triggerAriaLabel"
            v-bind="{ 'aria-activedescendant': activeDescendantId, hidden: !resolvedOpen }"
        >
            <component
                :is="item.href ? 'a' : FsusUiButton"
                v-for="(item, index) in items"
                :id="itemDomId(item.code)"
                :key="item.code"
                :ref="(el: unknown) => setItemRef(item.code, el)"
                class="locale-selector__item"
                :class="{
                    'locale-selector__item--selected': isSelected(item),
                    'locale-selector__item--pending': isPending(item),
                    'locale-selector__item--disabled': disabled,
                    'locale-selector__item--button': !item.href
                }"
                data-locale-selector-item
                :data-locale-code="item.code"
                :data-selected="isSelected(item) ? 'true' : 'false'"
                :data-pending="isPending(item) ? 'true' : 'false'"
                role="menuitemradio"
                :aria-checked="isSelected(item) ? 'true' : 'false'"
                :aria-current="isSelected(item) ? 'true' : undefined"
                :aria-disabled="disabled ? 'true' : undefined"
                :tabindex="resolvedOpen && activeMenuIndex === index ? 0 : -1"
                :href="item.href || undefined"
                :native-type="item.href ? undefined : 'button'"
                :dir="item.direction"
                :disabled="item.href ? undefined : disabled"
                @click.prevent="handleItemActivate(item)"
                @keydown="handleItemKeydown($event, index, item)"
            >
                <template v-if="item.href">
                    <span class="locale-selector__item-copy safe-inline-wrap">
                        <span class="locale-selector__item-native">{{ item.nativeName }}</span>
                        <span
                            v-if="item.englishName && item.englishName !== item.nativeName"
                            class="locale-selector__item-english"
                        >{{ item.englishName }}</span>
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
                </template>
                <span
                    v-else
                    class="locale-selector__item-content"
                >
                    <span class="locale-selector__item-copy safe-inline-wrap">
                        <span class="locale-selector__item-native">{{ item.nativeName }}</span>
                        <span
                            v-if="item.englishName && item.englishName !== item.nativeName"
                            class="locale-selector__item-english"
                        >{{ item.englishName }}</span>
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
                </span>
            </component>

            <div
                v-if="errorMessage"
                class="locale-selector__error"
                data-locale-selector-error
                role="alert"
            >
                <p class="locale-selector__error-message safe-inline-wrap">{{ errorMessage }}</p>
                <FsusUiButton
                    native-type="button"
                    class="locale-selector__retry"
                    data-locale-selector-retry
                    :disabled="disabled || !retryLocale"
                    :aria-label="retryAriaLabel"
                    :aria-disabled="undefined"
                    @click="handleRetry"
                >
                    <span class="locale-selector__retry-content">
                        <Refresh
                            class="locale-selector__retry-icon"
                            aria-hidden="true"
                        />
                        <span class="locale-selector__retry-label">{{ retryLocaleLabel }}</span>
                    </span>
                </FsusUiButton>
            </div>
        </div>

        <div
            v-if="errorMessage && !resolvedOpen"
            class="locale-selector__error locale-selector__error--trigger"
            data-locale-selector-error
            role="alert"
        >
            <p class="locale-selector__error-message safe-inline-wrap">{{ errorMessage }}</p>
            <FsusUiButton
                native-type="button"
                class="locale-selector__retry"
                data-locale-selector-retry
                :disabled="disabled || !retryLocale"
                :aria-label="retryAriaLabel"
                :aria-disabled="undefined"
                @click="handleRetry"
            >
                <span class="locale-selector__retry-content">
                    <Refresh
                        class="locale-selector__retry-icon"
                        aria-hidden="true"
                    />
                    <span class="locale-selector__retry-label">{{ retryLocaleLabel }}</span>
                </span>
            </FsusUiButton>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';

import {
    findActiveLocaleItem,
    isLocaleItemPending,
    isLocaleItemSelected,
    localeItemDomId,
    localeRetryLabel,
    localeTriggerAriaLabel,
    localeTriggerLabel,
    selectedLocaleIndex
} from '@/components/ui/localeSelectorPresentation';
import type { LocaleSelectorItem } from '@/components/ui/localeSelectorTypes';
import { FsusUiButton } from '@/fsusui/button';
import { Check, Loading, Refresh } from '@/fsusui/icons';

interface LocaleButtonInstance
{
    ref?: HTMLButtonElement;
}

const props = withDefaults(defineProps<{
    items: readonly LocaleSelectorItem[];
    activeLocale: string;
    pendingLocale?: string | null;
    open?: boolean;
    disabled?: boolean;
    errorMessage?: string | null;
    compact?: boolean;
}>(), {
    pendingLocale: null,
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

const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<LocaleButtonInstance | null>(null);
const itemRefs = new Map<string, HTMLElement>();
const internalOpen = ref(false);
const activeMenuIndex = ref(0);
const menuId = `locale-selector-menu-${useId()}`;

const isOpenControlled = computed(() => props.open !== undefined);
const resolvedOpen = computed(() => (isOpenControlled.value ? Boolean(props.open) : internalOpen.value));

const activeItem = computed(() => findActiveLocaleItem(props.items, props.activeLocale));
const triggerLabel = computed(() =>
    localeTriggerLabel(activeItem.value, props.activeLocale, props.compact)
);
const triggerAriaLabel = computed(() =>
    localeTriggerAriaLabel(activeItem.value, props.activeLocale)
);
const selectedIndex = computed(() => selectedLocaleIndex(props.items, props.activeLocale));

const activeDescendantId = computed(() =>
{
    const item = props.items[activeMenuIndex.value];
    return item ? itemDomId(item.code) : undefined;
});

const retryLocale = computed(() => props.pendingLocale ?? props.activeLocale ?? null);

const retryLocaleLabel = computed(() => localeRetryLabel(props.items, retryLocale.value));

const retryAriaLabel = computed(() => retryLocaleLabel.value);

const itemDomId = (code: string): string => localeItemDomId(menuId, code);
const isSelected = (item: LocaleSelectorItem): boolean => isLocaleItemSelected(item, props.activeLocale);
const isPending = (item: LocaleSelectorItem): boolean => isLocaleItemPending(item, props.pendingLocale);

function setItemRef(code: string, el: unknown): void
{
    const element = el instanceof HTMLElement ? el : (el as LocaleButtonInstance | null)?.ref;
    if (element instanceof HTMLElement)
    {
        itemRefs.set(code, element);
        return;
    }
    itemRefs.delete(code);
}

function setOpen(next: boolean): void
{
    if (props.disabled && next)
    {
        return;
    }
    if (!isOpenControlled.value)
    {
        internalOpen.value = next;
    }
    emit('open-change', next);
}

async function focusTrigger(): Promise<void>
{
    await nextTick();
    triggerRef.value?.ref?.focus();
}

async function focusMenuItem(index: number): Promise<void>
{
    if (props.items.length === 0)
    {
        return;
    }
    const bounded = ((index % props.items.length) + props.items.length) % props.items.length;
    activeMenuIndex.value = bounded;
    await nextTick();
    const item = props.items[bounded];
    if (!item)
    {
        return;
    }
    itemRefs.get(item.code)?.focus();
}

function openMenu(index = selectedIndex.value): void
{
    if (props.disabled)
    {
        return;
    }
    setOpen(true);
    void focusMenuItem(index);
}

function closeMenu(restoreFocus = false): void
{
    setOpen(false);
    if (restoreFocus)
    {
        void focusTrigger();
    }
}

function handleTriggerClick(): void
{
    if (props.disabled)
    {
        return;
    }
    if (resolvedOpen.value)
    {
        closeMenu(true);
        return;
    }
    openMenu();
}

function handleTriggerKeydown(event: KeyboardEvent): void
{
    if (props.disabled)
    {
        return;
    }

    if (event.key === 'ArrowDown')
    {
        event.preventDefault();
        openMenu(selectedIndex.value);
        return;
    }

    if (event.key === 'ArrowUp')
    {
        event.preventDefault();
        openMenu((selectedIndex.value + props.items.length - 1) % Math.max(props.items.length, 1));
        return;
    }

    if (event.key === 'Enter' || event.key === ' ')
    {
        event.preventDefault();
        handleTriggerClick();
    }
}

function handleItemActivate(item: LocaleSelectorItem): void
{
    if (props.disabled)
    {
        return;
    }
    // Keep the menu open so pending progress and error/retry remain reachable;
    // callers close via open-change / the controlled open prop when settled.
    emit('select', item.code);
}

function handleItemKeydown(event: KeyboardEvent, index: number, item: LocaleSelectorItem): void
{
    if (event.key === 'ArrowDown')
    {
        event.preventDefault();
        void focusMenuItem(index + 1);
        return;
    }

    if (event.key === 'ArrowUp')
    {
        event.preventDefault();
        void focusMenuItem(index - 1);
        return;
    }

    if (event.key === 'Home')
    {
        event.preventDefault();
        void focusMenuItem(0);
        return;
    }

    if (event.key === 'End')
    {
        event.preventDefault();
        void focusMenuItem(props.items.length - 1);
        return;
    }

    if (event.key === 'Escape')
    {
        event.preventDefault();
        closeMenu(true);
        return;
    }

    if (event.key === 'Enter' || event.key === ' ')
    {
        event.preventDefault();
        handleItemActivate(item);
    }
}

function handleRetry(): void
{
    if (props.disabled || !retryLocale.value)
    {
        return;
    }
    emit('retry', retryLocale.value);
}

function handleDocumentPointerDown(event: PointerEvent): void
{
    if (!resolvedOpen.value)
    {
        return;
    }
    const target = event.target;
    if (target instanceof Node && rootRef.value?.contains(target))
    {
        return;
    }
    closeMenu(false);
}

watch(
    () => props.open,
    (value) =>
    {
        if (value && !props.disabled)
        {
            void focusMenuItem(selectedIndex.value);
        }
    }
);

watch(selectedIndex, (index) =>
{
    if (resolvedOpen.value)
    {
        activeMenuIndex.value = index;
    }
});

onMounted(() =>
{
    document.addEventListener('pointerdown', handleDocumentPointerDown);
});

onBeforeUnmount(() =>
{
    document.removeEventListener('pointerdown', handleDocumentPointerDown);
});
</script>

<style scoped>
.locale-selector
 {
    position: relative;
    display: inline-flex;
    max-width: 100%;
    min-width: 0;
    flex-direction: column;
    align-items: stretch;
    vertical-align: middle;
}

.locale-selector__trigger
 {
    display: inline-flex;
    box-sizing: border-box;
    min-width: 44px;
    min-height: 44px;
    max-width: 100%;
    align-items: center;
    justify-content: center;
    gap: var(--fsus-space-1, 0.25rem);
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control, 6px);
    padding-inline: var(--fsus-space-2, 0.5rem);
    background: var(--fsusblog-page-bg, Canvas);
    color: var(--fsusblog-text-secondary);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    line-height: 1.25;
    transition:
        border-color var(--fsus-motion-control-fast, 140ms) var(--fsus-motion-standard, ease),
        background-color var(--fsus-motion-control-fast, 140ms) var(--fsus-motion-standard, ease),
        color var(--fsus-motion-control-fast, 140ms) var(--fsus-motion-standard, ease);
}

.locale-selector:not(.locale-selector--compact) .locale-selector__trigger
 {
    justify-content: flex-start;
    min-width: 44px;
    padding-inline: var(--fsus-space-3, 0.75rem);
    font-size: 13px;
    font-weight: 600;
}

.locale-selector__trigger:hover,
.locale-selector__trigger[aria-expanded='true']
 {
    border-color: var(--fsusblog-color-primary);
    background: var(--fsusblog-page-bg-soft, var(--fsusblog-page-bg, Canvas));
    color: var(--fsusblog-color-primary);
}

.locale-selector__trigger:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.locale-selector__trigger:disabled,
.locale-selector--disabled .locale-selector__trigger
 {
    cursor: not-allowed;
    opacity: 0.62;
}

.locale-selector__globe
 {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
}

.locale-selector__trigger-content,
.locale-selector__retry-content
 {
    display: inline-flex;
    min-width: 0;
    max-width: 100%;
    align-items: center;
    gap: var(--fsus-space-1, 0.25rem);
}

.locale-selector__globe-icon
 {
    display: block;
}

.locale-selector__trigger-label
 {
    min-width: 0;
    text-align: start;
}

.locale-selector__trigger-pending
 {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
}

.locale-selector__menu
 {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 60;
    box-sizing: border-box;
    width: max-content;
    min-width: min(100%, 12rem);
    max-width: min(20rem, calc(100vw - 1.5rem));
    max-height: min(70vh, 24rem);
    overflow: auto;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control, 6px);
    padding: var(--fsus-space-1, 0.25rem);
    background: var(--fsusblog-page-bg, Canvas);
    box-shadow: var(--fsusblog-reading-shadow-panel, 0 8px 24px color-mix(in srgb, CanvasText 8%, transparent));
    overscroll-behavior: contain;
}

.locale-selector__item
 {
    display: flex;
    box-sizing: border-box;
    width: 100%;
    min-height: 44px;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--fsus-space-2, 0.5rem);
    border: 0;
    border-radius: var(--fsus-radius-control, 6px);
    padding: 0.625rem;
    background: transparent;
    color: var(--fsusblog-text-primary);
    cursor: pointer;
    font: inherit;
    text-align: start;
    text-decoration: none;
}

.locale-selector__item:hover,
.locale-selector__item:focus-visible
 {
    background: color-mix(in srgb, var(--fsusblog-color-primary) 8%, transparent);
    color: var(--fsusblog-color-primary);
    outline: none;
}

.locale-selector__item--button
 {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
}

.locale-selector__item-content
 {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--fsus-space-2, 0.5rem);
}

.locale-selector__item:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
}

.locale-selector__item--selected
 {
    background: color-mix(in srgb, var(--fsusblog-color-primary) 12%, transparent);
}

.locale-selector__item--pending
 {
    opacity: 0.92;
}

.locale-selector__item--disabled,
.locale-selector__item[aria-disabled='true']
 {
    cursor: not-allowed;
    opacity: 0.62;
    pointer-events: none;
}

.locale-selector__item-copy
 {
    display: flex;
    min-width: 0;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0.125rem;
}

.locale-selector__item-native
 {
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.35;
    overflow-wrap: anywhere;
    white-space: normal;
}

.locale-selector__item-english
 {
    font-size: 0.75rem;
    font-weight: 500;
    line-height: 1.35;
    color: var(--fsusblog-text-muted);
    overflow-wrap: anywhere;
    white-space: normal;
}

.locale-selector__item-status
 {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    min-width: 1rem;
    min-height: 1.25rem;
    margin-top: 0.125rem;
    color: var(--fsusblog-color-primary);
}

.locale-selector__menu .locale-selector__item
 {
    margin: 0;
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

.locale-selector__error
 {
    display: flex;
    flex-direction: column;
    gap: var(--fsus-space-2, 0.5rem);
    margin-top: var(--fsus-space-1, 0.25rem);
    border-top: 1px solid var(--fsusblog-panel-border);
    padding: var(--fsus-space-2, 0.5rem);
}

.locale-selector__error--trigger
 {
    margin-top: var(--fsus-space-1, 0.25rem);
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control, 6px);
    background: var(--fsusblog-page-bg, Canvas);
}

.locale-selector__error-message
 {
    margin: 0;
    color: var(--fsusblog-text-secondary);
    font-size: 0.75rem;
    font-weight: 500;
    line-height: 1.4;
}

.locale-selector__retry
 {
    display: inline-flex;
    min-height: 44px;
    align-items: center;
    justify-content: center;
    gap: var(--fsus-space-1, 0.25rem);
    align-self: flex-start;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control, 6px);
    padding-inline: var(--fsus-space-2, 0.5rem);
    background: var(--fsusblog-page-bg, Canvas);
    color: var(--fsusblog-color-primary);
    cursor: pointer;
    font: inherit;
    font-size: 0.75rem;
    font-weight: 700;
}

.locale-selector__retry:hover,
.locale-selector__retry:focus-visible
 {
    border-color: var(--fsusblog-color-primary);
    background: var(--fsusblog-page-bg-soft, var(--fsusblog-page-bg, Canvas));
    outline: none;
}

.locale-selector__retry:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
}

.locale-selector__retry:disabled
 {
    cursor: not-allowed;
    opacity: 0.62;
}

.locale-selector__retry-label
 {
    min-width: 0;
    overflow-wrap: anywhere;
}

@media (forced-colors: active)
 {
    .locale-selector__trigger,
    .locale-selector__menu,
    .locale-selector__retry,
    .locale-selector__error--trigger
 {
        border-color: ButtonText;
    }

    .locale-selector__trigger:focus-visible,
    .locale-selector__item:focus-visible,
    .locale-selector__retry:focus-visible
 {
        outline: 2px solid Highlight;
        outline-offset: -2px;
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
