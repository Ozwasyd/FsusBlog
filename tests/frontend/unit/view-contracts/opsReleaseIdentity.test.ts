import { describe, expect, it } from 'vitest'
import { toOpsReleaseIdentityView } from '@/view-contracts/opsReleaseIdentity'

describe('ops release identity view contract', () => {
  it('shows canonical release, short commit and slot while retaining the full commit', () => {
    const view = toOpsReleaseIdentityView({
      releaseId: '20260720143025-32a785eabb20',
      commitSha: '32a785eabb2061f447d064bd55a61ddca0928582',
      releaseSlot: 'green'
    })

    expect(view).toEqual({
      releaseLabel: '20260720143025-32a785eabb20',
      commitLabel: '32a785eabb20',
      releaseSlotLabel: 'green',
      fullCommitSha: '32a785eabb2061f447d064bd55a61ddca0928582',
      published: true
    })
  })

  it('shows an explicit local state instead of SemVer, unknown or zero commit values', () => {
    expect(toOpsReleaseIdentityView({
      releaseId: 'local-unversioned',
      commitSha: '0000000000000000000000000000000000000000',
      releaseSlot: 'local'
    })).toEqual({
      releaseLabel: '本地开发（未发布）',
      commitLabel: '未发布',
      releaseSlotLabel: '本地',
      fullCommitSha: null,
      published: false
    })
  })
})
