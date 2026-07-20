import { isCanonicalReleaseId } from '@/generated/releaseIdContract'
import type { OpsReleaseIdentityResponse } from '@/api/authoring'

export interface OpsReleaseIdentityView {
  releaseLabel: string
  commitLabel: string
  releaseSlotLabel: string
  fullCommitSha: string | null
  published: boolean
}

export function toOpsReleaseIdentityView(
  identity: OpsReleaseIdentityResponse
): OpsReleaseIdentityView {
  const published = isCanonicalReleaseId(identity.releaseId)
    && /^[0-9a-f]{40}$/u.test(identity.commitSha)
    && identity.commitSha.startsWith(identity.releaseId.slice(-12))

  if (!published) {
    return {
      releaseLabel: '本地开发（未发布）',
      commitLabel: '未发布',
      releaseSlotLabel: identity.releaseSlot === 'local' ? '本地' : identity.releaseSlot,
      fullCommitSha: null,
      published: false
    }
  }

  return {
    releaseLabel: identity.releaseId,
    commitLabel: identity.commitSha.slice(0, 12),
    releaseSlotLabel: identity.releaseSlot,
    fullCommitSha: identity.commitSha,
    published: true
  }
}
