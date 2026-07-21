import type { ConversationMessageResponse } from '@/contracts/binaryApi';

export function mergeConversationMessagePages(
  existing: readonly ConversationMessageResponse[],
  incoming: readonly ConversationMessageResponse[]
): ConversationMessageResponse[] {
  const byId = new Map<string, ConversationMessageResponse>()
  for (const message of existing) byId.set(message.messageId, message)
  for (const message of incoming) byId.set(message.messageId, message)
  return [...byId.values()].sort((left, right) => compareMessageId(left.messageId, right.messageId))
}

export function compareMessageId(left: string, right: string): number {
  if (/^\d+$/u.test(left) && /^\d+$/u.test(right)) {
    if (left.length !== right.length) return left.length - right.length
  }
  return left < right ? -1 : left > right ? 1 : 0
}
