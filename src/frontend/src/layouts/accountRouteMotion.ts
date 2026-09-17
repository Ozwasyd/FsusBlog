import { fsusBlogMotionPresets } from '@/fsusui/blogMotion';
import type { MotionPresetName } from '@/fsusui/motion';
import type {
    AccountArea,
    AccountContentMode,
    AccountPageKind
} from '@/router/accountRouteMeta';

export type AccountRouteMotionPolicy = Readonly<{
    preset: MotionPresetName | null;
    reason: 'identity-continuity' | 'pane-continuity' | 'task-immediacy';
}>;

const immediateTaskPolicy: AccountRouteMotionPolicy = {
    preset: null,
    reason: 'task-immediacy'
};

const paneContinuityPolicy: AccountRouteMotionPolicy = {
    preset: null,
    reason: 'pane-continuity'
};

const identityContinuityPolicy: AccountRouteMotionPolicy = {
    preset: fsusBlogMotionPresets.identityRoute,
    reason: 'identity-continuity'
};

export const ACCOUNT_ROUTE_MOTION_POLICIES = {
    self: {
        'identity-settings': identityContinuityPolicy,
        inbox: paneContinuityPolicy,
        dashboard: immediateTaskPolicy,
        collection: immediateTaskPolicy,
        form: immediateTaskPolicy,
        settings: identityContinuityPolicy,
        console: immediateTaskPolicy
    },
    manage: {
        'identity-settings': immediateTaskPolicy,
        inbox: paneContinuityPolicy,
        dashboard: immediateTaskPolicy,
        collection: immediateTaskPolicy,
        form: immediateTaskPolicy,
        settings: immediateTaskPolicy,
        console: immediateTaskPolicy
    }
} as const satisfies Record<AccountArea, Record<AccountPageKind, AccountRouteMotionPolicy>>;

export function resolveAccountRouteMotionPolicy(
    area: AccountArea,
    pageKind: AccountPageKind,
    contentMode: AccountContentMode
): AccountRouteMotionPolicy
{
    if (contentMode === 'takeover')
    {
        return paneContinuityPolicy;
    }

    return ACCOUNT_ROUTE_MOTION_POLICIES[area][pageKind];
}

export function shouldRestoreAccountRouteFocus(
    activeElement: Element | null,
    mainElement: HTMLElement | null
): boolean
{
    if (typeof document === 'undefined' || mainElement === null)
    {
        return false;
    }

    return activeElement === document.body
        || activeElement === document.documentElement
        || (activeElement !== null && mainElement.contains(activeElement));
}
