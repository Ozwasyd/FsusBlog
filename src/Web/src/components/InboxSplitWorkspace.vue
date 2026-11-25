<script setup lang="ts">
import { computed, ref, type ComponentPublicInstance } from 'vue'
import {
  ElButton, ElConversationContextBar, ElConversationList, ElEmptySelectionState, ElInboxEmptyState,
  ElInboxLayout, ElInput, ElMessageBubble, ElMessageTimeline, ElReplyComposerShell, ElSkeleton, ElThreadPanel,
} from '@ozwasyd/element-plus'
import { focusInboxHeading, resolveElementRoot, type InboxRenderedMessage } from '../inboxPresentation'

const props = withDefaults(defineProps<{
  hasSelection: boolean; hasThread: boolean; listLabel: string; detailLabel: string
  listBusy?: boolean; listEmpty?: boolean; listError?: boolean; emptyListTitle: string; emptyListDescription?: string
  hasMore?: boolean; moreLoading?: boolean; moreLabel?: string; threadKey?: string; threadTitle?: string
  threadTitleTag?: 'h2' | 'h3'; threadBusy?: boolean; showBack?: boolean; backDisabled?: boolean; backLabel?: string
  hasEarlier?: boolean; earlierLoading?: boolean; earlierLabel?: string; messages: readonly InboxRenderedMessage[]
  replyEnabled?: boolean; replyInputId?: string; replyLabel?: string; replyPlaceholder?: string; replyModel?: string
  replyDisabled?: boolean; replyPending?: boolean; replySubmitLabel?: string; closedNote?: string
  hasComposerExtra?: boolean; hasEmptyListActions?: boolean; emptySelectionTitle: string; emptySelectionDescription?: string
  detailLoadingTitle?: string; showDetailLoadingBack?: boolean
}>(), {
  listBusy: false, listEmpty: false, listError: false, emptyListDescription: '', hasMore: false, moreLoading: false,
  moreLabel: '', threadKey: '', threadTitle: '', threadTitleTag: 'h2', threadBusy: false, showBack: false,
  backDisabled: false, backLabel: '', hasEarlier: false, earlierLoading: false, earlierLabel: '',
  replyEnabled: false, replyInputId: 'inbox-reply-body', replyLabel: '', replyPlaceholder: '', replyModel: '',
  replyDisabled: false, replyPending: false, replySubmitLabel: '', closedNote: '', hasComposerExtra: false,
  hasEmptyListActions: false, emptySelectionDescription: '', detailLoadingTitle: '', showDetailLoadingBack: false,
})

const emit = defineEmits<{
  'load-more': []; back: []; 'load-earlier': []; 'update:replyModel': [value: string]; 'submit-reply': []
}>()

const listRoot = ref<HTMLElement>()
const threadPanelRef = ref<ComponentPublicInstance | HTMLElement>()
const showComposerSlot = computed(() => props.replyEnabled || Boolean(props.closedNote) || props.hasComposerExtra)

defineExpose({
  focusList: () => { listRoot.value?.focus({ preventScroll: true }) },
  focusThreadHeading: () => focusInboxHeading(threadPanelRef.value),
  containsListFocus: (node: Element | null) => Boolean(node && listRoot.value?.contains(node)),
  containsThreadFocus: (node: Element | null) => Boolean(node && resolveElementRoot(threadPanelRef.value)?.contains(node)),
})
</script>

<template>
  <ElInboxLayout class="inbox-ws-shell" :selected="hasSelection" :mobile-pane="hasSelection ? 'detail' : 'list'"
    :list-label="listLabel" :detail-label="detailLabel" density="compact">
    <template #list>
      <div ref="listRoot" class="inbox-ws-list-pane" tabindex="-1" :aria-busy="listBusy">
        <div v-if="$slots['list-toolbar']" class="inbox-ws-toolbar"><slot name="list-toolbar" /></div>
        <slot name="list-before" />
        <ElSkeleton v-if="listBusy && listEmpty" :rows="5" animated class="inbox-ws-skeleton" />
        <ElInboxEmptyState v-else-if="listEmpty && !listError" :key="hasEmptyListActions ? 'with-actions' : 'plain'"
          :title="emptyListTitle" :description="emptyListDescription || undefined" density="compact">
          <template v-if="hasEmptyListActions" #actions><slot name="empty-list-actions" /></template>
        </ElInboxEmptyState>
        <ElConversationList v-else-if="!listEmpty" :ariaLabel="listLabel" density="compact"><slot name="list-items" /></ElConversationList>
        <div v-if="hasMore" class="inbox-ws-list-footer">
          <ElButton native-type="button" text :loading="moreLoading" @click="emit('load-more')">{{ moreLabel }}</ElButton>
        </div>
      </div>
    </template>

    <template #detail>
      <ElThreadPanel v-if="hasThread" :key="threadKey" ref="threadPanelRef" :title="threadTitle" :title-tag="threadTitleTag"
        density="compact" v-bind="{ 'aria-busy': threadBusy }">
        <template v-if="showBack" #back>
          <ElButton native-type="button" text :disabled="backDisabled" @click="emit('back')">{{ backLabel }}</ElButton>
        </template>
        <template #actions><slot name="thread-actions" /></template>
        <template #context>
          <ElConversationContextBar class="inbox-ws-context-bar" density="compact"><slot name="thread-context" /></ElConversationContextBar>
          <slot name="thread-context-extra" />
        </template>
        <template #messages>
          <div v-if="hasEarlier" class="inbox-ws-earlier">
            <ElButton native-type="button" text :loading="earlierLoading" @click="emit('load-earlier')">{{ earlierLabel }}</ElButton>
          </div>
          <ElMessageTimeline density="compact">
            <ElMessageBubble v-for="message in messages" :key="message.id" :variant="message.variant"
              :author="message.author" :meta="message.meta" density="compact">{{ message.body }}</ElMessageBubble>
          </ElMessageTimeline>
        </template>
        <template v-if="showComposerSlot" #composer>
          <div class="inbox-ws-composer-stack">
            <form v-if="replyEnabled" @submit.prevent="emit('submit-reply')">
              <ElReplyComposerShell density="compact">
                <template #title><label class="inbox-ws-composer-label" :for="replyInputId">{{ replyLabel }}</label></template>
                <template #input>
                  <ElInput :id="replyInputId" :model-value="replyModel" type="textarea" :placeholder="replyPlaceholder || undefined"
                    :autosize="{ minRows: 2, maxRows: 6 }" :disabled="replyDisabled"
                    @update:model-value="value => emit('update:replyModel', String(value))" />
                </template>
                <template #actions>
                  <ElButton type="primary" native-type="submit" :disabled="replyDisabled || !replyModel.trim()" :loading="replyPending">{{ replySubmitLabel }}</ElButton>
                </template>
              </ElReplyComposerShell>
            </form>
            <p v-else-if="closedNote" class="inbox-ws-closed-note">{{ closedNote }}</p>
            <slot name="composer-extra" />
          </div>
        </template>
      </ElThreadPanel>

      <div v-else-if="hasSelection" class="inbox-ws-detail-loading" :aria-busy="threadBusy">
        <div v-if="detailLoadingTitle || showDetailLoadingBack" class="inbox-ws-detail-loading-header">
          <ElButton v-if="showDetailLoadingBack" native-type="button" text :disabled="backDisabled" @click="emit('back')">{{ backLabel }}</ElButton>
          <span v-if="detailLoadingTitle" class="inbox-ws-detail-loading-title">{{ detailLoadingTitle }}</span>
        </div>
        <ElSkeleton :rows="6" animated class="inbox-ws-skeleton" />
      </div>

      <ElEmptySelectionState v-else :title="emptySelectionTitle" :description="emptySelectionDescription || undefined" />
    </template>
  </ElInboxLayout>
</template>

<style scoped>
.inbox-ws-list-pane, .inbox-ws-detail-loading { display: grid; align-content: start; min-inline-size: 0; }
.inbox-ws-toolbar { display: grid; gap: var(--fsus-space-2); padding: var(--fsus-space-3); border-block-end: 1px solid var(--el-border-color-lighter); background: var(--fsus-color-surface-raised, var(--el-fill-color-blank)); }
.inbox-ws-skeleton { padding: var(--fsus-space-4); }
.inbox-ws-list-footer, .inbox-ws-earlier { display: flex; justify-content: center; padding: var(--fsus-space-2) var(--fsus-space-3); }
.inbox-ws-context-bar { align-items: safe center; }
.inbox-ws-composer-stack { display: grid; container: inbox-composer / inline-size; }
.inbox-ws-composer-label { display: inline-block; color: inherit; cursor: pointer; }
.inbox-ws-closed-note { margin: 0; padding: var(--fsus-space-3) var(--fsus-space-4); color: var(--el-text-color-secondary); font-size: var(--el-font-size-small); line-height: 1.5; }
.inbox-ws-detail-loading-header { display: flex; align-items: safe center; gap: var(--fsus-space-2); padding: var(--fsus-space-3); border-block-end: 1px solid var(--el-border-color-lighter); }
.inbox-ws-detail-loading-title { color: var(--el-text-color-primary); font-size: 18px; font-weight: 700; line-height: 1.35; overflow-wrap: anywhere; }
@media (min-width: 761px) { .inbox-ws-shell { block-size: clamp(30rem, calc(100dvh - 14.5rem), 52rem); grid-template-rows: minmax(0, 1fr); } }
@media (min-width: 1024px) { .inbox-ws-shell { grid-template-columns: minmax(21.5rem, 23.5rem) minmax(0, 1fr); } }
</style>
