import type { AccountArea, AccountPageKind } from '@/router/accountRouteMeta';

export const ACCOUNT_PAGE_KIND_CLASSES = {
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
} as const satisfies Record<AccountArea, Record<AccountPageKind, string>>;

export function resolveAccountPageKindClass(area: AccountArea, pageKind: AccountPageKind): string
{
    return ACCOUNT_PAGE_KIND_CLASSES[area][pageKind];
}
