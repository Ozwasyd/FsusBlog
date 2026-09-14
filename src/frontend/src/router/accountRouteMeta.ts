import type { RouteTitleKey } from '@/router/routeTitleContract';
import type { RouteStateClass } from '@/security/privateNavigationPolicy';

import type { RouteRecordRaw } from 'vue-router';

export const ACCOUNT_PAGE_KINDS = [
    'identity-settings',
    'inbox',
    'dashboard',
    'collection',
    'form',
    'settings',
    'console'
] as const;

export const ACCOUNT_CONTENT_MODES = ['standard', 'wide', 'takeover'] as const;

export type AccountPageKind = (typeof ACCOUNT_PAGE_KINDS)[number];
export type AccountContentMode = (typeof ACCOUNT_CONTENT_MODES)[number];
export type AccountArea = 'self' | 'manage';
export type AccountPrivateRouteState = Exclude<RouteStateClass, 'public-shareable'>;

export type SelfMetaOptions = Readonly<{
    titleKey: RouteTitleKey;
    pageKind: AccountPageKind;
    contentMode?: Extract<AccountContentMode, 'standard' | 'takeover'>;
    routeState?: AccountPrivateRouteState;
}>;

export type ManageMetaOptions = Readonly<{
    titleKey: RouteTitleKey;
    permissions: readonly string[];
    pageKind: AccountPageKind;
    contentMode?: Extract<AccountContentMode, 'wide' | 'takeover'>;
    routeState?: AccountPrivateRouteState;
}>;

export function isAccountPageKind(value: unknown): value is AccountPageKind
{
    return typeof value === 'string' && (ACCOUNT_PAGE_KINDS as readonly string[]).includes(value);
}

export function isAccountContentMode(value: unknown): value is AccountContentMode
{
    return typeof value === 'string' && (ACCOUNT_CONTENT_MODES as readonly string[]).includes(value);
}

export function assertAccountLeafRouteMeta(records: readonly RouteRecordRaw[]): void
{
    const accountRoot = records.find((record) => record.path === '/user');
    if (!accountRoot)
    {
        throw new Error('Account route contract requires the /user root');
    }

    const visit = (record: RouteRecordRaw, parentPath: string): void =>
    {
        const path = record.path.length === 0
            ? parentPath
            : `${parentPath.replace(/\/$/u, '')}/${record.path.replace(/^\//u, '')}`;

        if (record.children?.length)
        {
            for (const child of record.children)
            {
                visit(child, path);
            }
            return;
        }

        if (record.name === undefined)
        {
            return;
        }

        if (!isAccountPageKind(record.meta?.accountPageKind))
        {
            throw new Error(`${String(record.name)} (${path}) must declare a valid accountPageKind`);
        }
        if (!isAccountContentMode(record.meta?.accountContentMode))
        {
            throw new Error(`${String(record.name)} (${path}) must declare a valid accountContentMode`);
        }
    };

    for (const child of accountRoot.children ?? [])
    {
        visit(child, accountRoot.path);
    }
}

declare module 'vue-router'
{
    interface RouteMeta {
        accountArea?: AccountArea;
        accountContentMode?: AccountContentMode;
        accountPageKind?: AccountPageKind;
    }
}
