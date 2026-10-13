<template>
    <section
        v-if="copy"
        class="article-pin-list"
        :aria-label="surface === 'switcher' ? copy.switcherLabel : copy.railLabel"
        :aria-busy="presentation?.state === 'loading' || actionState === 'pending'"
    >
        <p
            class="article-pin-list__status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
        >{{ statusText }}</p>
        <ol
            v-if="page"
            :aria-label="copy.orderLabel"
        >
            <li
                v-for="row in page.items"
                :key="row.pinId"
                :draggable="!busy"
                @dragstart="startDrag($event, row.pinId)"
                @dragend="drag = null"
                @dragover.prevent
                @drop.prevent="dropAfter(row.pinId)"
                @keydown="onKey($event, row.pinId)"
            >
                <FsusUiButton
                    :ref="instance => rememberButton(row.pinId, instance)"
                    class="article-pin-list__title"
                    text
                    :disabled="busy || !row.openEligible"
                    :aria-current="row.open ? 'page' : undefined"
                    @focus="focusedPinId = row.pinId"
                    @click="open(row.pinId)"
                >{{ row.title }}</FsusUiButton>
                <span v-if="row.status === 3">{{ copy.archivedLabel }}</span>
                <span v-if="row.dirty">{{ copy.dirtyLabel }}</span>
                <span v-if="row.open">{{ copy.openLabel }}</span>
                <ArticlePinToggle
                    :copy="copy"
                    :binding="page"
                    :article-id="row.articleId"
                    membership="pinned"
                    :pin-id="row.pinId"
                    :disabled="busy"
                    @intent="toggle"
                />
                <FsusUiDropdown
                    trigger="click"
                    :disabled="busy"
                    @command="command => menuMove(row.pinId, command)"
                >
                    <FsusUiButton
                        text
                        :disabled="busy"
                        :aria-label="copy.reorderLabel"
                    >{{ copy.reorderLabel }}</FsusUiButton>
                    <template #dropdown>
                        <FsusUiDropdownMenu>
                            <FsusUiDropdownItem
                                command="previous"
                                :disabled="!canMove(row.pinId, 'previous')"
                            >{{ copy.previousLabel }}</FsusUiDropdownItem>
                            <FsusUiDropdownItem
                                command="next"
                                :disabled="!canMove(row.pinId, 'next')"
                            >{{ copy.nextLabel }}</FsusUiDropdownItem>
                        </FsusUiDropdownMenu>
                    </template>
                </FsusUiDropdown>
            </li>
        </ol>
        <FsusUiButton
            v-if="page?.hasMore"
            text
            :disabled="busy"
            @click="nextPage"
        >{{ copy.nextPageLabel }}</FsusUiButton>
        <FsusUiButton
            v-if="!page && presentation && presentation.state !== 'unconnected' && presentation.state !== 'loading'"
            text
            :disabled="actionState === 'pending'"
            @click="refresh"
        >{{ copy.refreshLabel }}</FsusUiButton>
    </section>
</template>

<script setup lang="ts">
import { ElDropdown as FsusUiDropdown, ElDropdownItem as FsusUiDropdownItem, ElDropdownMenu as FsusUiDropdownMenu } from '@ozwasyd/element-plus';
import { computed, shallowRef } from 'vue';


import { FsusUiButton } from '@/fsusui/button';

import {
    articlePinAdjacentAnchor,
    createArticlePinMoveIntent,
    readArticlePinDisplayPage,
    type ArticlePinActionState,
    type ArticlePinCopy,
    type ArticlePinDisplayBinding,
    type ArticlePinMoveIntent,
    type ArticlePinOpenIntent,
    type ArticlePinPresentation,
    type ArticlePinToggleIntent
} from './articlePinPresentation';
import ArticlePinToggle from './ArticlePinToggle.vue';

const props = defineProps<{
    copy: ArticlePinCopy;
    surface: 'rail' | 'switcher';
    presentation?: ArticlePinPresentation;
    actionState?: ArticlePinActionState;
}>();
const emit = defineEmits<{
    toggle: [intent: ArticlePinToggleIntent];
    reorder: [intent: ArticlePinMoveIntent];
    open: [intent: ArticlePinOpenIntent];
    page: [request: Readonly<ArticlePinDisplayBinding & { cursor: string; }>];
    refresh: [];
}>();
const page = computed(() => readArticlePinDisplayPage(props.presentation, props.actionState));
const busy = computed(() => props.actionState === 'pending' || !page.value);
const focusedPinId = shallowRef<string | null>(null);
const buttons = new Map<string, HTMLButtonElement>();
const drag = shallowRef<(ArticlePinDisplayBinding & { pinId: string; }) | null>(null);
const statusText = computed(() =>
{
    const copy = props.copy;
    if (!copy)
    {
        return '';
    }
    if (props.actionState === 'conflict' || props.presentation?.state === 'conflict')
    {
        return copy.statusConflict;
    }
    if (props.actionState === 'stale' || props.presentation?.state === 'stale')
    {
        return copy.statusStale;
    }
    if (props.actionState === 'pending')
    {
        return copy.statusPending;
    }
    if (props.actionState === 'failed')
    {
        return copy.statusFailed;
    }
    if (props.presentation?.state === 'loading')
    {
        return copy.statusLoading;
    }
    return page.value ? page.value.items.length === 0 ? copy.statusEmpty : copy.statusCurrent : copy.statusUnavailable;
});

function rememberButton(pinId: string, instance: unknown): void
{
    // FsusUI's documented Button.ref exposes its native focus element; no private selector.
    if (instance && typeof instance === 'object' && 'ref' in instance && instance.ref instanceof HTMLButtonElement)
    {
        buttons.set(pinId, instance.ref);
    }
    else
    {
        buttons.delete(pinId);
    }
}

function restoreFocus(pinId = focusedPinId.value): boolean
{
    if (pinId === null || !page.value?.items.some(row => row.pinId === pinId))
    {
        return false;
    }
    const button = buttons.get(pinId);
    if (!button || button.disabled)
    {
        return false;
    }
    button.focus();
    return true;
}

function open(pinId: string): void
{
    const current = page.value;
    const row = current?.items.find(item => item.pinId === pinId);
    if (busy.value || !current || !row?.openEligible)
    {
        return;
    }
    // The original host must revalidate then open-or-activate; this hint opens no route/session.
    emit('open', Object.freeze({ kind: 'open', actionId: 'article-pin-open', pinId, articleId: row.articleId,
                                 collectionRevision: current.collectionRevision, pageDigest: current.pageDigest }));
}

function toggle(intent: ArticlePinToggleIntent): void
{
    const current = page.value;
    if (busy.value || intent.collectionRevision !== current?.collectionRevision || intent.pageDigest !== current?.pageDigest
        || !current?.items.some(row => row.pinId === intent.pinId && row.articleId === intent.articleId))
    {
        return;
    }
    emit('toggle', intent);
}

function canMove(pinId: string, direction: 'previous' | 'next'): boolean
{
    return !busy.value && page.value !== null && articlePinAdjacentAnchor(page.value, pinId, direction) !== undefined;
}

function moveAfter(pinId: string, afterPinId: string | null): void
{
    const current = page.value;
    if (busy.value || !current)
    {
        return;
    }
    const intent = createArticlePinMoveIntent(current, pinId, afterPinId);
    if (intent)
    {
        emit('reorder', intent);
    }
}

function menuMove(pinId: string, command: unknown): void
{
    const current = page.value;
    if (!current || (command !== 'previous' && command !== 'next'))
    {
        return;
    }
    const anchor = articlePinAdjacentAnchor(current, pinId, command);
    if (anchor !== undefined)
    {
        moveAfter(pinId, anchor);
    }
}

function onKey(event: KeyboardEvent, pinId: string): void
{
    // Only this row's public title Button owns these keys; nested controls keep their own semantics.
    if (event.defaultPrevented || event.target !== buttons.get(pinId) || event.ctrlKey || event.metaKey || event.shiftKey)
    {
        return;
    }
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown'))
    {
        event.preventDefault();
        menuMove(pinId, event.key === 'ArrowUp' ? 'previous' : 'next');
        return;
    }
    if (event.altKey)
    {
        return;
    }
    const current = page.value;
    if (!current || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
    {
        return;
    }
    const index = current.items.findIndex(row => row.pinId === pinId);
    const target = event.key === 'Home' ? current.items[0] : event.key === 'End' ? current.items[current.items.length - 1]
        : current.items[index + (event.key === 'ArrowUp' ? -1 : 1)];
    if (target)
    {
        event.preventDefault();
        restoreFocus(target.pinId);
    }
}

function startDrag(event: DragEvent, pinId: string): void
{
    const current = page.value;
    if (busy.value || !current)
    {
        event.preventDefault();
        return;
    }
    drag.value = { pinId, collectionRevision: current.collectionRevision, pageDigest: current.pageDigest };
    event.dataTransfer?.setData('text/plain', pinId);
}

/** Drag supports visible after-anchors only; head/null remains a keyboard/menu operation. */
function dropAfter(afterPinId: string): void
{
    const captured = drag.value;
    drag.value = null;
    const current = page.value;
    if (!captured || !current)
    {
        return;
    }
    if (captured.collectionRevision !== current.collectionRevision || captured.pageDigest !== current.pageDigest)
    {
        return;
    }
    moveAfter(captured.pinId, afterPinId);
}

function nextPage(): void
{
    const current = page.value;
    if (!busy.value && current?.hasMore && current.nextCursor !== null)
    {
        emit('page', Object.freeze({ collectionRevision: current.collectionRevision, pageDigest: current.pageDigest,
                                     cursor: current.nextCursor }));
    }
}

function refresh(): void
{
    if (props.actionState === 'pending' || !props.presentation || props.presentation.state === 'loading'
        || props.presentation.state === 'unconnected' || page.value)
    {
        return;
    }
    emit('refresh');
}

defineExpose({ restoreFocus, getFocusIdentity: () => focusedPinId.value });
</script>

<style scoped lang="scss">
.article-pin-list
 {
    min-width: 0;
    color: var(--fsusblog-text-secondary);

    ol
 {
        margin: 0;
        padding: 0;
        list-style: none;
    }

    li
 {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.25rem;
        min-width: 0;
    }
}

.article-pin-list__status
 {
    color: var(--fsusblog-text-muted);
}

.article-pin-list__title
 {
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
    white-space: normal;
}
</style>
