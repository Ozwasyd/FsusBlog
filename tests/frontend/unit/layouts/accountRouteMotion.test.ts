import { describe, expect, it } from 'vitest';

import {
    ACCOUNT_ROUTE_MOTION_POLICIES,
    resolveAccountRouteMotionPolicy,
    shouldRestoreAccountRouteFocus
} from '@/layouts/accountRouteMotion';
import { ACCOUNT_PAGE_KINDS } from '@/router/accountRouteMeta';

describe('account route motion policy', () =>
{
    it('keeps admin tasks immediate and identity settings opacity-only', () =>
    {
        for (const pageKind of ACCOUNT_PAGE_KINDS)
        {
            expect(ACCOUNT_ROUTE_MOTION_POLICIES.manage[pageKind]).toEqual({
                preset: null,
                reason: pageKind === 'inbox' ? 'pane-continuity' : 'task-immediacy'
            });
        }

        expect(resolveAccountRouteMotionPolicy('self', 'identity-settings', 'standard')).toEqual({
            preset: 'ownership-transfer-snapshot',
            reason: 'identity-continuity'
        });
        expect(resolveAccountRouteMotionPolicy('self', 'collection', 'standard').preset).toBeNull();
    });

    it('always disables route motion for takeover panes', () =>
    {
        expect(resolveAccountRouteMotionPolicy('self', 'identity-settings', 'takeover')).toEqual({
            preset: null,
            reason: 'pane-continuity'
        });
        expect(resolveAccountRouteMotionPolicy('manage', 'settings', 'takeover')).toEqual({
            preset: null,
            reason: 'pane-continuity'
        });
    });

    it('restores programmatic or outgoing-content focus without stealing chrome focus', () =>
    {
        const main = document.createElement('main');
        const outgoingButton = document.createElement('button');
        const chromeLink = document.createElement('a');
        main.append(outgoingButton);
        document.body.append(main, chromeLink);

        expect(shouldRestoreAccountRouteFocus(document.body, main)).toBe(true);
        expect(shouldRestoreAccountRouteFocus(outgoingButton, main)).toBe(true);
        expect(shouldRestoreAccountRouteFocus(chromeLink, main)).toBe(false);
        expect(shouldRestoreAccountRouteFocus(null, main)).toBe(false);
        expect(shouldRestoreAccountRouteFocus(outgoingButton, null)).toBe(false);

        main.remove();
        chromeLink.remove();
    });
});
