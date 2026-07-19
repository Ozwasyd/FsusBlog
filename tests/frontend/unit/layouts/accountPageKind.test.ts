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
        'identity-settings': 'identity-page-shell identity-page-shell--settings',
        inbox: 'identity-page-shell identity-page-shell--inbox',
        dashboard: 'identity-page-shell identity-page-shell--dashboard',
        collection: 'identity-page-shell identity-page-shell--collection',
        form: 'identity-page-shell identity-page-shell--form',
        settings: 'identity-page-shell identity-page-shell--settings',
        console: 'identity-page-shell identity-page-shell--console'
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
      expect(resolveAccountPageKindClass('self', pageKind))
        .toBe(ACCOUNT_PAGE_KIND_CLASSES.self[pageKind])
      expect(resolveAccountPageKindClass('manage', pageKind))
        .toBe(ACCOUNT_PAGE_KIND_CLASSES.manage[pageKind])
    }
  })
})
