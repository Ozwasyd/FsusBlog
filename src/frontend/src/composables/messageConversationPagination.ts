import type { ConversationListItemResponse } from '@/api/message';

export const compareConversationByLastMessage = (
    left: ConversationListItemResponse,
    right: ConversationListItemResponse
): number =>
{
    const leftTime = Date.parse(left.lastMessageAt) || 0;
    const rightTime = Date.parse(right.lastMessageAt) || 0;
    if (rightTime !== leftTime)
    {
        return rightTime - leftTime;
    }
    try
    {
        const leftId = BigInt(left.conversationId);
        const rightId = BigInt(right.conversationId);
        return leftId === rightId ? 0 : leftId > rightId ? -1 : 1;
    }
    catch
    {
        return String(right.conversationId).localeCompare(String(left.conversationId));
    }
};

export const mergeConversationPages = (
    current: readonly ConversationListItemResponse[],
    incoming: readonly ConversationListItemResponse[]
): ConversationListItemResponse[] =>
{
    const byId = new Map(current.map((item) => [item.conversationId, item]));
    for (const item of incoming)
    {
        const existing = byId.get(item.conversationId);
        if (!existing || compareConversationByLastMessage(item, existing) <= 0)
        {
            byId.set(item.conversationId, { ...existing, ...item });
        }
    }
    return [...byId.values()].sort(compareConversationByLastMessage);
};
