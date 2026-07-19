import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

const representativeTaskPages = {
  collection: 'src/views/admin/article/List.vue',
  dashboard: 'src/components/admin/AdminDashboardTaskWorkbench.vue',
  form: 'src/views/admin/article/Write.vue',
  identity: 'src/views/user/IdentityCenter.vue',
  settings: 'src/views/admin/Settings.vue'
} as const

describe('account task page heading hierarchy', () => {
  it('uses the type-preserving canonical FsusUI boundary', () => {
    const adapter = read('src/fsusui/taskPageHeader.ts')

    expect(adapter).toContain('FsusTaskPageHeader as FsusUiTaskPageHeader')
    expect(adapter).toContain('TaskPageHeaderProps as FsusUiTaskPageHeaderProps')
    expect(adapter).not.toMatch(/\bas\s+Component\b/u)
  })

  it.each(Object.entries(representativeTaskPages))(
    'uses one canonical task header on the %s representative',
    (_, path) => {
      const source = read(path)

      expect(source.match(/<FsusUiTaskPageHeader\b/gu)).toHaveLength(1)
      expect(source).not.toMatch(/account-page-title|identity-section-header__copy|write-command-title/u)
    }
  )

  it('keeps heading before actions and preserves live editor status', () => {
    const dashboard = read(representativeTaskPages.dashboard)
    const write = read(representativeTaskPages.form)

    expect(dashboard).toMatch(/<FsusUiTaskPageHeader[\s\S]*?<template #actions>[\s\S]*?帮助与反馈/u)
    expect(write).toMatch(/<template #title>[\s\S]*?article-write-title[\s\S]*?<template #description>/u)
    expect(write).toMatch(/article-editor-status[\s\S]*?aria-live="polite"[\s\S]*?<template #actions>/u)
    expect(write).toContain('aria-describedby="article-editor-status"')
  })

  it('retains only the Blog-owned header-to-content margin handoff', () => {
    const accountShell = read('src/assets/account-shell-base.css')

    expect(accountShell).toMatch(/\.account-task-page-header\s*\{[^}]*margin-bottom:\s*var\(--fsus-space-6\);/u)
    expect(accountShell).not.toMatch(/\.account-page-(?:header|title|description)\b/u)
  })
})
