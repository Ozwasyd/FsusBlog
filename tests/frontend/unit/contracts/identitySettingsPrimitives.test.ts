import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

const identityPath = 'src/views/user/IdentityCenter.vue'
const profilePath = 'src/views/user/Profile.vue'
const retiredPrimitivesPath = 'src/components/user/ProfileSettingsPrimitives.ts'

describe('identity settings primitive ownership', () => {
  it('uses type-preserving FsusUI adapters and deletes the duplicate local implementation', () => {
    const adapter = read('src/fsusui/settingsSection.ts')

    for (const token of [
      'ElResourceList as FsusUiResourceList',
      'ElResourceListItem as FsusUiResourceListItem',
      'ElMetadataRow as FsusUiMetadataRow',
      'ElMetadataItem as FsusUiMetadataItem',
      'ElInlineActions as FsusUiInlineActions',
      'ResourceListProps as FsusUiResourceListProps',
      'InlineActionsProps as FsusUiInlineActionsProps'
    ]) {
      expect(adapter).toContain(token)
    }

    expect(adapter).not.toMatch(/\bas\s+Component\b|defineComponent\s*\(/u)
    expect(existsSync(resolve(process.cwd(), retiredPrimitivesPath))).toBe(false)
  })

  it('renders credential and session resources with canonical metadata and actions', () => {
    const identity = read(identityPath)

    expect(identity.match(/<FsusUiResourceList\b/gu)).toHaveLength(2)
    expect(identity.match(/<FsusUiResourceListItem\b/gu)).toHaveLength(2)
    expect(identity.match(/<FsusUiMetadataRow\b/gu)).toHaveLength(2)
    expect(identity).toContain('passkeysCopy.backupModeLabel')
    expect(identity).toContain('sessionsCopy.sessionTypeLabel')
    expect(identity).toMatch(/<template #actions>[\s\S]*?<FsusUiInlineActions[\s\S]*?confirmDeletePasskey/u)
    expect(identity).toMatch(/<template v-if="!session\.isCurrent" #actions>[\s\S]*?<FsusUiInlineActions[\s\S]*?revokeSessionDevice/u)
  })

  it('uses flat illustration-free empty states on identity and profile surfaces', () => {
    const identity = read(identityPath)
    const profile = read(profilePath)

    expect(identity.match(/<FsusUiEmptyState\b/gu)).toHaveLength(2)
    expect(identity.match(/size="inline"/gu)).toHaveLength(2)
    expect(identity.match(/:illustration="false"/gu)).toHaveLength(2)
    expect(profile).toMatch(/<FsusUiEmptyState[\s\S]*?size="inline"[\s\S]*?:illustration="false"/u)
    expect(`${identity}\n${profile}`).not.toMatch(/ProfileInlineEmptyState|ProfileSettingsPrimitives/u)
  })

  it('keeps account deletion policy in Blog while using the canonical danger hierarchy', () => {
    const identity = read(identityPath)

    expect(identity).toMatch(/<FsusUiDangerZone[\s\S]*?<FsusUiRiskNotice[\s\S]*?copy\.lifecycleWarning[\s\S]*?<FsusUiDestructiveActionPanel[\s\S]*?deleteCurrentAccount[\s\S]*?<\/FsusUiDangerZone>/u)
    expect(identity).toContain('confirmCopy.deleteAccountBody')
    expect(identity).toContain('await deleteAccount({')
    expect(identity).not.toContain(':deep(')
  })
})
