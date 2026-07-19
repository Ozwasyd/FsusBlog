import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_PAGE_KIND_CLASSES,
  resolveAccountPageKindClass
} from '@/layouts/accountPageKind'
import { ACCOUNT_PAGE_KINDS } from '@/router/accountRouteMeta'

describe('account page kind visual mapping', () => {
  it('preserves the existing self and admin shell classes for every typed kind', () => {
    expect(ACCOUNT_PAGE_KIND_CLASSES).toEqual({
      self: {
        'identity-settings': '',
        inbox: '',
        dashboard: '',
        collection: '',
        form: '',
        settings: '',
        console: ''
      },
      manage: {
        'identity-settings': 'admin-page-shell admin-page-shell--list',
        inbox: 'admin-page-shell admin-page-shell--list',
        dashboard: 'admin-page-shell admin-page-shell--dashboard',
        collection: 'admin-page-shell admin-page-shell--list',
        form: 'admin-page-shell admin-page-shell--form',
        settings: 'admin-page-shell admin-page-shell--settings',
        console: 'admin-page-shell admin-page-shell--list'
      }
    })

    for (const pageKind of ACCOUNT_PAGE_KINDS) {
      expect(resolveAccountPageKindClass('self', pageKind)).toBe('')
      expect(resolveAccountPageKindClass('manage', pageKind))
        .toBe(ACCOUNT_PAGE_KIND_CLASSES.manage[pageKind])
    }
  })

  it('removes business route names from AccountLayout visual branching', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/layouts/AccountLayout.vue'), 'utf8')
    const routerSource = readFileSync(resolve(process.cwd(), 'src/router/index.ts'), 'utf8')

    expect(source).toContain('resolveAccountPageKindClass(currentArea.value, route.meta.accountPageKind)')
    expect(source).not.toMatch(/route\.name\s*===\s*['"]Manage/u)
    expect(source).not.toMatch(/ManageWriteArticle|ManageEditArticle|ManageSettings|ManageDashboard/u)
    expect(routerSource).toContain('selfMeta({')
    expect(routerSource).toContain('manageMeta({')
    expect(routerSource).not.toMatch(/\b(?:selfMeta|manageMeta)\(\s*['"]/u)
  })
})
