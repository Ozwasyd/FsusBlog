import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';

import {
    messageApi,
    type AdminConversationDetailResponse,
    type AdminConversationListItemResponse,
    type ConversationFilter,
    type InboxConversationStatusChangedPayload,
    type InboxConversationUpsertPayload,
    type InboxMessageAppendPayload,
    type InboxReadUpdatedPayload
} from '@/api/message';
import { mergeConversationPages } from '@/composables/messageConversationPagination';
import {
    isOlderPatchVersion,
    newerMessageId,
    newerTimestamp,
    reduceConversationUpsert,
    reduceMessageAppend,
    reduceReadUpdated,
    reduceStatusChanged,
    type InboxPatchVersion
} from '@/composables/messageInboxPatchReducer';
import { mergeConversationMessagePages } from '@/composables/messageThreadPagination';
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback';
import { toast } from '@/fsusui/feedback';
import type { NotificationStreamInboxRenderPatch } from '@/services/notificationStreamTypes';
import { useNotificationStreamStore } from '@/store/notificationStream';
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation';

const PAGE_SIZE = 30;

const isAbortError = (error: unknown): boolean =>
    error instanceof DOMException && error.name === 'AbortError';

const matchesFilter = (item: AdminConversationListItemResponse, filter: ConversationFilter): boolean =>
{
    if (filter === 'all')
    {
        return true;
    };
    if (filter === 'unread')
    {
        return item.unreadCount > 0;
    };
    if (filter === 'system')
    {
        return item.isSystemSource;
    };
    if (filter === 'open')
    {
        return item.status === 0;
    };
    if (filter === 'pending')
    {
        return item.status === 1;
    };
    return item.status === 2;
};

const resetDetailState = (detailRef: { value: AdminConversationDetailResponse | null; }, selectionRef: { value: string; }, conversationsRef: { value: AdminConversationListItemResponse[]; }, replyRef: { value: string; }) =>
{
    detailRef.value = null;
    selectionRef.value = '';
    conversationsRef.value = [];
    replyRef.value = '';
};

export function useAdminMessageCenter(isEnabled: () => boolean = () => true)
{
    const notificationStreamStore = useNotificationStreamStore();

    const loading = ref(false);
    const loadingDetail = ref(false);
    const loadingOlderMessages = ref(false);
    const processing = ref(false);
    const taskFeedback = useAdminTaskFeedback();

    const filter = ref<ConversationFilter>('open');
    const conversations = shallowRef<AdminConversationListItemResponse[]>([]);
    const totalConversations = ref(0);
    const nextCursor = ref<string | null>(null);
    const hasMoreConversations = ref(false);
    const loadingMoreConversations = ref(false);
    const loadedPageCount = ref(0);
    const selectedConversationId = ref<string>('');
    const detail = shallowRef<AdminConversationDetailResponse | null>(null);
    const replyBody = ref('');

    const systemTargetAccountId = ref('');
    const systemSubject = ref('');
    const systemBody = ref('');
    let listRequestGeneration = 0;
    let listPatchRevision = 0;
    let detailRequestGeneration = 0;
    let detailPatchRevision = 0;
    let detailRequestController: AbortController | null = null;
    let recoveryScheduled = false;
    let pendingListRecovery = false;
    let pendingDetailRecoveryId = '';
    const latestPatchVersion = new Map<string, InboxPatchVersion>();
    const conversationPatchRevision = new Map<string, number>();
    const seenPatchKeys = new Set<string>();

    const selectedConversation = computed(() =>
        conversations.value.find((it) => it.conversationId === selectedConversationId.value) ?? null
    );

    const resetPagination = (): void =>
    {
        totalConversations.value = 0;
        nextCursor.value = null;
        hasMoreConversations.value = false;
        loadedPageCount.value = 0;
    };

    const mergeAuthoritativeConversations = (
        authoritative: readonly AdminConversationListItemResponse[],
        patchRevisionAtStart: number
    ): AdminConversationListItemResponse[] =>
    {
        const current = conversations.value;
        let merged = mergeConversationPages(authoritative, current) as AdminConversationListItemResponse[];
        const currentIds = new Set(current.map((item) => item.conversationId));
        for (const [conversationId, revision] of conversationPatchRevision)
        {
            if (revision > patchRevisionAtStart && !currentIds.has(conversationId))
            {
                merged = merged.filter((item) => item.conversationId !== conversationId);
            }
        }
        return merged;
    };

    const loadConversations = async (silent = false, preserveLoaded = silent): Promise<boolean> =>
    {
        if (!isEnabled())
        {
            resetDetailState(detail, selectedConversationId, conversations, replyBody);
            resetPagination();
            return true;
        }

        const generation = ++listRequestGeneration;
        const patchRevisionAtStart = listPatchRevision;
        if (!silent)
        {
            loading.value = true;
        };
        try
        {
            const data = await messageApi.adminGetConversations(PAGE_SIZE, filter.value);
            if (generation !== listRequestGeneration || !isEnabled())
            {
                return false;
            };
            const authoritative = (data.items || []);
            const preservePagination = preserveLoaded && loadedPageCount.value > 1;
            if (listPatchRevision !== patchRevisionAtStart)
            {
                conversations.value = mergeAuthoritativeConversations(authoritative, patchRevisionAtStart);
            }
            else if (preservePagination)
            {
                conversations.value = mergeConversationPages(conversations.value, authoritative) as AdminConversationListItemResponse[];
            }
            else
            {
                conversations.value = mergeConversationPages([], authoritative) as AdminConversationListItemResponse[];
            }
            if (!preservePagination)
            {
                nextCursor.value = data.nextCursor ?? null;
                hasMoreConversations.value = Boolean(data.hasMore && data.nextCursor);
                loadedPageCount.value = 1;
            }
            if (listPatchRevision === patchRevisionAtStart)
            {
                totalConversations.value = data.total;
            };
            if (!selectedConversationId.value && conversations.value.length > 0)
            {
                selectedConversationId.value = conversations.value[0].conversationId;
            }
            if (selectedConversationId.value)
            {
                const exists = conversations.value.some((it) => it.conversationId === selectedConversationId.value);
                const preservePatchedSelection = silent && detail.value?.conversationId === selectedConversationId.value;
                if (!exists && !preservePatchedSelection)
                {
                    selectedConversationId.value = conversations.value[0]?.conversationId ?? '';
                }
            }
        }
        catch (error)
        {
            if (!silent)
            {
                showErrorToast(error, '管理员会话列表加载失败');
            };
            return false;
        }
        finally
        {
            if (generation === listRequestGeneration)
            {
                loading.value = false;
            };
        }

        return true;
    };

    const loadMoreConversations = async (): Promise<boolean> =>
    {
        if (!isEnabled() || loadingMoreConversations.value || !hasMoreConversations.value || !nextCursor.value)
        {
            return false;
        }

        loadingMoreConversations.value = true;
        const patchRevisionAtStart = listPatchRevision;
        try
        {
            const data = await messageApi.adminGetConversations(PAGE_SIZE, filter.value, nextCursor.value);
            const authoritative = (data.items || []);
            conversations.value = listPatchRevision === patchRevisionAtStart
                ? mergeConversationPages(conversations.value, authoritative) as AdminConversationListItemResponse[]
                : mergeAuthoritativeConversations(authoritative, patchRevisionAtStart);
            if (listPatchRevision === patchRevisionAtStart)
            {
                totalConversations.value = data.total;
            };
            nextCursor.value = data.nextCursor ?? null;
            hasMoreConversations.value = Boolean(data.hasMore && data.nextCursor);
            loadedPageCount.value += 1;
            return true;
        }
        catch (error)
        {
            showErrorToast(error, '更多管理员会话加载失败');
            return false;
        }
        finally
        {
            loadingMoreConversations.value = false;
        }
    };

    const loadDetail = async (conversationId: string, silent = false): Promise<boolean> =>
    {
        if (!isEnabled())
        {
            detail.value = null;
            return true;
        }

        if (!conversationId)
        {
            detail.value = null;
            return true;
        }
        detailRequestController?.abort();
        const controller = new AbortController();
        detailRequestController = controller;
        const generation = ++detailRequestGeneration;
        const patchRevisionAtStart = detailPatchRevision;
        loadingDetail.value = true;
        try
        {
            const payload = await messageApi.adminGetConversationDetail(conversationId, null, { signal: controller.signal });
            if (controller.signal.aborted || generation !== detailRequestGeneration ||
        selectedConversationId.value !== conversationId || !isEnabled())
            {
                return false;
            };
            const current = detail.value?.conversationId === conversationId ? detail.value : null;
            detail.value = current && detailPatchRevision !== patchRevisionAtStart
                ? {
            ...payload,
            ...current,
            readSnapshotMessageId: newerMessageId(current.readSnapshotMessageId, payload.readSnapshotMessageId),
            lastMessageAt: newerTimestamp(current.lastMessageAt, payload.lastMessageAt),
            messages: mergeConversationMessagePages(payload.messages, current.messages)
          }
                : payload;
        }
        catch (error)
        {
            if (!controller.signal.aborted && !isAbortError(error) && !silent)
            {
                showErrorToast(error, '会话详情加载失败');
            }
            return false;
        }
        finally
        {
            if (generation === detailRequestGeneration)
            {
                loadingDetail.value = false;
            };
        }

        return true;
    };

    const loadOlderMessages = async (): Promise<boolean> =>
    {
        const current = detail.value;
        const conversationId = selectedConversationId.value;
        if (!current || !conversationId || loadingOlderMessages.value || !current.hasOlder || !current.previousCursor)
        {
            return false;
        }

        const cursor = current.previousCursor;
        loadingOlderMessages.value = true;
        try
        {
            const older = await messageApi.adminGetConversationDetail(conversationId, cursor);
            const latest = detail.value;
            if (!latest || latest.conversationId !== conversationId || selectedConversationId.value !== conversationId)
            {
                return false;
            }
            detail.value = {
                ...latest,
                previousCursor: older.previousCursor ?? null,
                hasOlder: Boolean(older.hasOlder),
                messages: mergeConversationMessagePages(latest.messages, older.messages)
            };
            return true;
        }
        catch (error)
        {
            showErrorToast(error, '更早消息加载失败');
            return false;
        }
        finally
        {
            loadingOlderMessages.value = false;
        }
    };

    const selectConversation = async (conversationId: string): Promise<void> =>
    {
        selectedConversationId.value = conversationId;
        await loadDetail(conversationId);
    };

    const reply = async (): Promise<void> =>
    {
        if (!selectedConversationId.value || !replyBody.value.trim() || processing.value)
        {
            return;
        }
        processing.value = true;
        const conversationId = selectedConversationId.value;
        taskFeedback.begin('正在发送站内信回复', conversationId, conversationId);
        try
        {
            const message = await messageApi.adminReplyConversation(conversationId, { body: replyBody.value });
            replyBody.value = '';
            if (detail.value && detail.value.conversationId === conversationId)
            {
                detail.value = {
                    ...detail.value,
                    messages: [...detail.value.messages, message],
                    lastMessageAt: message.createdAt
                };
            }
            const listSynced = await loadConversations(true);
            taskFeedback.succeed('站内信回复已发送', listSynced ? conversationId : '列表同步失败，请稍后刷新', conversationId);
            toast.success('回复已发送');
            if (!listSynced)
            {
                showWarningToast('回复已发送，但会话列表同步失败，请稍后刷新', '回复已发送，但会话列表同步失败，请稍后刷新');
            }
        }
        catch (error)
        {
            taskFeedback.fail('发送回复失败', error, '发送回复失败', conversationId);
            showErrorToast(error, '发送回复失败');
        }
        finally
        {
            processing.value = false;
        }
    };

    const updateStatus = async (status: 'open' | 'pending' | 'closed'): Promise<void> =>
    {
        if (!selectedConversationId.value || processing.value)
        {
            return;
        }
        processing.value = true;
        const conversationId = selectedConversationId.value;
        taskFeedback.begin('正在更新会话状态', `${conversationId} -> ${status}`, conversationId);
        try
        {
            const projectedStatus = detail.value?.status ?? conversations.value.find((item) => item.conversationId === conversationId)?.status ?? 0;
            const previousStatus = projectedStatus === 1 ? 'pending' : projectedStatus === 2 ? 'closed' : 'open';
            const result = await messageApi.adminUpdateConversationStatus(conversationId, {
                status,
                reason: `admin_message_center_${previousStatus}_to_${status}`
            });
            const nextStatus = result.currentStatus;
            if (detail.value && detail.value.conversationId === conversationId)
            {
                detail.value = {
                    ...detail.value,
                    status: nextStatus
                };
            }
            const currentList = conversations.value.slice();
            const index = currentList.findIndex((it) => it.conversationId === conversationId);
            if (index >= 0)
            {
                currentList[index] = {
                    ...currentList[index],
                    status: nextStatus
                };
                conversations.value = currentList;
            }
            const listSynced = await loadConversations(true);
            const detailSynced = await loadDetail(conversationId, true);
            if (listSynced && detailSynced)
            {
                taskFeedback.succeed(
          result.outcome === 'no_change' ? '会话状态未变化' : '会话状态已更新',
          `${conversationId} -> ${status}`,
          conversationId
                );
            }
            else
            {
                taskFeedback.partial('会话状态已更新', '列表或详情同步失败，请稍后刷新', conversationId);
            }
            toast.success(result.outcome === 'no_change' ? '状态未变化' : '状态已更新');
            if (!listSynced || !detailSynced)
            {
                showWarningToast('状态已更新，但列表或详情同步失败，请稍后刷新', '状态已更新，但列表或详情同步失败，请稍后刷新');
            }
        }
        catch (error)
        {
            taskFeedback.fail('状态更新失败', error, '状态更新失败', conversationId);
            showErrorToast(error, '状态更新失败');
        }
        finally
        {
            processing.value = false;
        }
    };

    const sendSystemMessage = async (): Promise<void> =>
    {
        if (!systemTargetAccountId.value.trim() || !systemBody.value.trim() || processing.value)
        {
            return;
        }

        const parsedTargetAccountId = Number(systemTargetAccountId.value.trim());
        if (!Number.isInteger(parsedTargetAccountId) || parsedTargetAccountId <= 0)
        {
            showErrorToast('请输入有效的账号 ID', '请输入有效的账号 ID');
            return;
        }

        processing.value = true;
        taskFeedback.begin('正在发送系统消息', `账号 ${parsedTargetAccountId}`, 'admin-system-message');
        try
        {
            await messageApi.adminSendSystemMessage({
                targetAccountId: parsedTargetAccountId,
                subject: systemSubject.value || '系统通知',
                body: systemBody.value
            });
            systemTargetAccountId.value = '';
            systemSubject.value = '';
            systemBody.value = '';
            const listSynced = await loadConversations(true);
            taskFeedback.succeed('系统消息已发送', listSynced ? `账号 ${parsedTargetAccountId}` : '列表同步失败，请稍后刷新', 'admin-system-message');
            toast.success('系统消息已发送');
            if (!listSynced)
            {
                showWarningToast('系统消息已发送，但会话列表同步失败，请稍后刷新', '系统消息已发送，但会话列表同步失败，请稍后刷新');
            }
        }
        catch (error)
        {
            taskFeedback.fail('系统消息发送失败', error, '系统消息发送失败', 'admin-system-message');
            showErrorToast(error, '系统消息发送失败');
        }
        finally
        {
            processing.value = false;
        }
    };

    const scheduleRecovery = (refreshList: boolean, detailConversationId = ''): void =>
    {
        pendingListRecovery ||= refreshList;
        if (detailConversationId)
        {
            pendingDetailRecoveryId = detailConversationId;
        };
        if (recoveryScheduled)
        {
            return;
        };
        recoveryScheduled = true;
        queueMicrotask(() =>
        {
            recoveryScheduled = false;
            const shouldRefreshList = pendingListRecovery;
            const conversationId = pendingDetailRecoveryId;
            pendingListRecovery = false;
            pendingDetailRecoveryId = '';
            const tasks: Promise<unknown>[] = [];
            if (shouldRefreshList)
            {
                tasks.push(loadConversations(true, true));
            };
            if (conversationId && selectedConversationId.value === conversationId)
            {
                tasks.push(loadDetail(conversationId, true));
            }
            if (tasks.length > 0)
            {
                void Promise.allSettled(tasks);
            };
        });
    };

    const patchConversationId = (patch: NotificationStreamInboxRenderPatch): string =>
    {
        const payload = patch.payload;
        return typeof payload === 'object' && payload && 'conversationId' in payload
            ? String(payload.conversationId ?? '')
            : patch.kind === 'conversation-upsert' && typeof payload === 'object' && payload &&
          'conversation' in payload && typeof payload.conversation === 'object' && payload.conversation &&
          'conversationId' in payload.conversation
        ? String(payload.conversation.conversationId ?? '')
        : '';
    };

    const patchKey = (patch: NotificationStreamInboxRenderPatch, conversationId: string): string =>
    {
        if (patch.eventId !== undefined)
        {
            return `event:${patch.eventId}`;
        };
        const payload = patch.payload;
        const messageId = typeof payload === 'object' && payload && 'message' in payload &&
      typeof payload.message === 'object' && payload.message && 'messageId' in payload.message
            ? String(payload.message.messageId ?? '')
            : '';
        return `${patch.kind}:${conversationId}:${messageId}:${patch.ts ?? ''}`;
    };

    const rememberPatch = (key: string): boolean =>
    {
        if (seenPatchKeys.has(key))
        {
            return false;
        };
        seenPatchKeys.add(key);
        if (seenPatchKeys.size > 512)
        {
            const oldest = seenPatchKeys.values().next().value;
            if (oldest)
            {
                seenPatchKeys.delete(oldest);
            };
        }
        return true;
    };

    const consumePatches = (patches: readonly NotificationStreamInboxRenderPatch[]): void =>
    {
        const originalConversations = conversations.value;
        const originalDetail = detail.value;
        let nextConversations = originalConversations;
        let nextDetail = originalDetail;
        let refreshList = false;
        let refreshDetailId = '';
        let handledProjection = false;
        const handledConversationIds = new Set<string>();

        for (const patch of patches)
        {
            const conversationId = patchConversationId(patch);
            if (!rememberPatch(patchKey(patch, conversationId)))
            {
                continue;
            };
            const payloadTime = typeof patch.payload === 'object' && patch.payload && 'time' in patch.payload
                ? Date.parse(String(patch.payload.time ?? '')) || undefined
                : undefined;
            const version: InboxPatchVersion = { eventId: patch.eventId, time: patch.ts ?? payloadTime };
            const currentVersion = conversationId ? latestPatchVersion.get(conversationId) ?? null : null;
            if (conversationId && isOlderPatchVersion(version, currentVersion))
            {
                continue;
            };
            if (conversationId && (version.eventId !== undefined || version.time !== undefined))
            {
                latestPatchVersion.set(conversationId, version);
            }
            if (conversationId)
            {
                handledConversationIds.add(conversationId);
            };

            switch (patch.kind)
            {
                case 'conversation-upsert': {
                    const projection = reduceConversationUpsert(
                        nextConversations,
                        nextDetail,
                        patch.payload as InboxConversationUpsertPayload,
                        false
                    );
                    nextConversations = projection.conversations;
                    nextDetail = projection.detail;
                    refreshList ||= !projection.complete;
                    handledProjection = true;
                    break;
                }
                case 'message-append': {
                    const projection = reduceMessageAppend(
                        nextConversations,
                        nextDetail,
                        patch.payload as InboxMessageAppendPayload
                    );
                    nextConversations = projection.conversations;
                    nextDetail = projection.detail;
                    refreshList ||= !projection.targetInList || !projection.complete;
                    if (!projection.complete && conversationId === selectedConversationId.value)
                    {
                        refreshDetailId = conversationId;
                    }
                    handledProjection = true;
                    break;
                }
                case 'read-updated': {
                    const projection = reduceReadUpdated(
                        nextConversations,
                        nextDetail,
                        patch.payload as InboxReadUpdatedPayload
                    );
                    nextConversations = projection.conversations;
                    nextDetail = projection.detail;
                    refreshList ||= !projection.targetInList;
                    handledProjection = true;
                    break;
                }
                case 'conversation-status-changed': {
                    const projection = reduceStatusChanged(
                        nextConversations,
                        nextDetail,
                        patch.payload as InboxConversationStatusChangedPayload
                    );
                    nextConversations = projection.conversations;
                    nextDetail = projection.detail;
                    refreshList ||= !projection.targetInList;
                    handledProjection = true;
                    break;
                }
                case 'reconnected':
                    refreshList = true;
                    if (patch.replayMissed && selectedConversationId.value)
                    {
                        refreshDetailId = selectedConversationId.value;
                    }
                    break;
            }
        }

        if (handledProjection)
        {
            const beforeFilterCount = nextConversations.length;
            nextConversations = nextConversations.filter((item) => matchesFilter(item, filter.value));
            const removedCount = beforeFilterCount - nextConversations.length;
            conversations.value = nextConversations;
            detail.value = nextDetail;
            listPatchRevision += 1;
            for (const conversationId of handledConversationIds)
            {
                conversationPatchRevision.set(conversationId, listPatchRevision);
            }
            if (nextDetail !== originalDetail || refreshDetailId)
            {
                detailPatchRevision += 1;
            };
            if (removedCount > 0)
            {
                totalConversations.value = Math.max(0, totalConversations.value - removedCount);
            };
        }
        scheduleRecovery(refreshList, refreshDetailId);
    };

    watch(
        () => filter.value,
        () =>
        {
            if (!isEnabled())
            {
                return;
            }
            void loadConversations();
        }
    );

    watch(
        () => notificationStreamStore.inboxRevision,
        () =>
        {
            if (!isEnabled())
            {
                return;
            }
            consumePatches(notificationStreamStore.inboxBatch);
        }
    );

    watch(
        () => isEnabled(),
        (enabled) =>
        {
            if (enabled)
            {
                void loadConversations();
                return;
            }

            resetDetailState(detail, selectedConversationId, conversations, replyBody);
            resetPagination();
            listRequestGeneration += 1;
            detailRequestGeneration += 1;
            detailRequestController?.abort();
            latestPatchVersion.clear();
            conversationPatchRevision.clear();
            seenPatchKeys.clear();
        }
    );

    onMounted(async () =>
    {
        if (!isEnabled())
        {
            return;
        }

        await loadConversations();
        if (selectedConversationId.value)
        {
            await loadDetail(selectedConversationId.value);
        }
    });

    onUnmounted(() =>
    {
        listRequestGeneration += 1;
        detailRequestGeneration += 1;
        detailRequestController?.abort();
        pendingListRecovery = false;
        pendingDetailRecoveryId = '';
    });

    return {
        taskFeedback,
        loading,
        loadingDetail,
        loadingOlderMessages,
        processing,
        filter,
        conversations,
        totalConversations,
        hasMoreConversations,
        loadingMoreConversations,
        selectedConversationId,
        selectedConversation,
        detail,
        replyBody,
        systemTargetAccountId,
        systemSubject,
        systemBody,
        selectConversation,
        loadMoreConversations,
        loadOlderMessages,
        reply,
        updateStatus,
        sendSystemMessage
    };
}
