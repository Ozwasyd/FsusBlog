import { request } from '../../../Contracts/client'
import { decodeDraftRecoveryScope, FrameType, WireRoutes } from '../../../Contracts/wire.generated'
import { DraftJournal, type DraftJournalScope } from './draftJournal'

const emptyId = '00000000-0000-0000-0000-000000000000'
let verified: { epoch: number; scope: DraftJournalScope } | undefined

export async function verifyDraftScope(epoch: number, isCurrent: () => boolean, signal?: AbortSignal): Promise<DraftJournalScope | undefined> {
  const result = await request(WireRoutes.DraftRecoveryScope, FrameType.DraftRecoveryScope, decodeDraftRecoveryScope, signal)
  if (!isCurrent() || signal?.aborted) return undefined
  if (result.siteId === emptyId || result.userId === emptyId) throw new Error('Invalid draft recovery scope')
  const scope = Object.freeze({ site: result.siteId, userId: result.userId })
  const previous = verified?.scope
  if (previous && (previous.site !== scope.site || previous.userId !== scope.userId)) {
    await clearScope(previous)
    if (!isCurrent() || signal?.aborted) return undefined
  }
  verified = { epoch, scope }
  return scope
}

export async function purgeVerifiedDraftScope(epoch: number): Promise<void> {
  const item = verified
  if (!item || item.epoch !== epoch) return
  await clearScope(item.scope)
  if (verified === item) verified = undefined
}

async function clearScope(scope: DraftJournalScope): Promise<void> {
  const journal = await DraftJournal.open(scope)
  try { await journal.purge() }
  finally { journal.close() }
}
