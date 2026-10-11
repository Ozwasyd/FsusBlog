import { afterEach, describe, expect, it } from 'vitest';

import { authoringWorkspaceRatioOwner } from '@/services/authoring/authoringWorkspaceRatioOwner';
import { createAuthoringWorkspaceSeparatorAdapter } from '@/services/authoring/authoringWorkspaceSeparatorAdapter';

import type { AuthoringWorkspaceGeometryInput } from '@/services/authoring/authoringWorkspaceGeometryPolicy';
import type { AuthoringWorkspaceRatioChange, AuthoringWorkspaceRatioRef, AuthoringWorkspaceRatioScope } from '@/services/authoring/authoringWorkspaceRatioOwner';
import type { AuthoringWorkspaceSeparatorPorts } from '@/services/authoring/authoringWorkspaceSeparatorAdapter';

// UNRUN source regressions. This fixture models only required adapter callbacks, not a group
// registry or joint receipt. Its ratio-only publisher is not original group/host qualification.
const scopes = new Set<AuthoringWorkspaceRatioScope>();
afterEach(() =>
{
    for (const scope of scopes)
    {
        authoringWorkspaceRatioOwner.releaseWorkspace(scope);
    }
    scopes.clear();
});

function fixture()
{
    const scope = authoringWorkspaceRatioOwner.openWorkspace();
    scopes.add(scope);
    const initial = authoringWorkspaceRatioOwner.read(scope);
    type Projection = Readonly<{ ratioRef: AuthoringWorkspaceRatioRef; }>;
    let projection: Projection = Object.freeze({ ratioRef: initial.ratioRef });
    const state = {
        publications: 0,
        cancels: 0,
        refusePublication: false,
        prepared: null as AuthoringWorkspaceRatioChange | null,
        beforePort: (_name: keyof AuthoringWorkspaceSeparatorPorts<Projection>): void => {},
        onCancel: (): void => {}
    };
    const measure = (): Omit<AuthoringWorkspaceGeometryInput, 'splitRatioPermille'> => ({
        requestedLayout: 'horizontal-two-group',
        layoutViewportWidthCssPx: 1440, layoutViewportHeightCssPx: 900,
        browserZoomPercent: 100, visualViewportScale: 1,
        frame: { left: 0, top: 0, width: 1440, height: 900 },
        visualViewport: { left: 0, top: 0, width: 1440, height: 900 },
        railWidthCssPx: 0, inspectorWidthCssPx: 0,
        pageChromeStartCssPx: 0, pageChromeEndCssPx: 0,
        pageChromeTopCssPx: 0, pageChromeBottomCssPx: 0,
        scrollbarWidthCssPx: 0, splitterFootprintCssPx: 40,
        leadingGroupChromeWidthCssPx: 0, trailingGroupChromeWidthCssPx: 0, focusedGroupChromeWidthCssPx: 0,
        safeAreaLeftCssPx: 0, safeAreaRightCssPx: 0, safeAreaTopCssPx: 0, safeAreaBottomCssPx: 0,
        mobile: false, softKeyboardOpen: false
    });
    const ports: AuthoringWorkspaceSeparatorPorts<Projection> = {
        readProjection: () =>
        {
            state.beforePort('readProjection');
            return projection;
        },
        ratioScope: () =>
        {
            state.beforePort('ratioScope');
            return scope;
        },
        ratioRef: value =>
        {
            state.beforePort('ratioRef');
            return value.ratioRef;
        },
        isCurrentProjection: value =>
        {
            state.beforePort('isCurrentProjection');
            return value === projection;
        },
        measure: () =>
        {
            state.beforePort('measure');
            return measure();
        },
        publishPreparedRatio: (expected, change) =>
        {
            state.beforePort('publishPreparedRatio');
            state.publications++;
            state.prepared = change;
            if (expected !== projection || state.refusePublication)
            {
                return null;
            }
            const next = authoringWorkspaceRatioOwner.commit(scope, change);
            projection = Object.freeze({ ratioRef: next.ratioRef });
            return projection;
        },
        cancelSeparator: () =>
        {
            state.cancels++;
            state.onCancel();
        }
    };
    const adapter = createAuthoringWorkspaceSeparatorAdapter(ports, {
        label: 'Resize editor groups', primaryRegionId: 'editor-primary', secondaryRegionId: 'editor-secondary'
    });
    return { adapter, state, scope, initial };
}

const pointer = (value: number) => ({ value, source: 'pointer' as const, pointerId: 7 });

describe('workspace separator synchronous invalidation source regressions', () =>
{
    it('refuses a proposal when measure invalidates but still returns valid old measurements', () =>
    {
        const { adapter, state, scope, initial } = fixture();
        expect(adapter.start(pointer(500))).toBe(true);
        state.beforePort = name =>
        {
            if (name === 'measure')
            {
                adapter.invalidate();
            }
        };
        expect(adapter.proposal(pointer(600))).toBe('refused');
        expect(state.publications).toBe(0);
        expect(authoringWorkspaceRatioOwner.read(scope)).toEqual(initial);
    });

    it('refuses disposal during measure and never admits binding or start afterward', () =>
    {
        const { adapter, state, scope, initial } = fixture();
        expect(adapter.start(pointer(500))).toBe(true);
        state.beforePort = name =>
        {
            if (name === 'measure')
            {
                adapter.dispose();
            }
        };
        expect(adapter.proposal(pointer(600))).toBe('refused');
        state.beforePort = () => {};
        expect(adapter.readBinding()).toEqual({ status: 'blocked' });
        expect(adapter.start(pointer(500))).toBe(false);
        expect(state.publications).toBe(0);
        expect(authoringWorkspaceRatioOwner.read(scope)).toEqual(initial);
    });

    it('checks invalidation and disposal after every prepublication external read port', () =>
    {
        for (const name of ['readProjection', 'isCurrentProjection', 'ratioScope', 'ratioRef', 'measure'] as const)
        {
            for (const revoke of ['invalidate', 'dispose'] as const)
            {
                const { adapter, state, scope, initial } = fixture();
                expect(adapter.start(pointer(500))).toBe(true);
                let revoked = false;
                state.beforePort = current =>
                {
                    if (!revoked && current === name)
                    {
                        revoked = true;
                        adapter[revoke]();
                    }
                };
                expect(adapter.proposal(pointer(600))).toBe('refused');
                expect(state.publications).toBe(0);
                expect(authoringWorkspaceRatioOwner.read(scope)).toEqual(initial);
            }
        }
    });

    it('prevents nested proposals during measurement while preserving the outer valid CAS', () =>
    {
        const { adapter, state, scope } = fixture();
        expect(adapter.start(pointer(500))).toBe(true);
        const nested: string[] = [];
        state.beforePort = name =>
        {
            if (name === 'measure')
            {
                nested.push(adapter.proposal(pointer(650)));
            }
        };
        expect(adapter.proposal(pointer(600))).toBe('accepted');
        expect(nested.length).toBeGreaterThan(0);
        expect(nested.every(value => value === 'refused')).toBe(true);
        expect(state.publications).toBe(1);
        expect(authoringWorkspaceRatioOwner.read(scope).splitRatioPermille).toBe(600);
    });

    it('does not recreate an interaction when start measurement invalidates', () =>
    {
        const { adapter, state } = fixture();
        state.beforePort = name =>
        {
            if (name === 'measure')
            {
                adapter.invalidate();
            }
        };
        expect(adapter.start(pointer(500))).toBe(false);
        state.beforePort = () => {};
        expect(adapter.proposal(pointer(600))).toBe('refused');
        expect(state.publications).toBe(0);
    });

    it('does not return a planned binding after measurement disposes the adapter', () =>
    {
        const { adapter, state } = fixture();
        state.beforePort = name =>
        {
            if (name === 'measure')
            {
                adapter.dispose();
            }
        };
        expect(adapter.readBinding()).toEqual({ status: 'blocked' });
        state.beforePort = () => {};
        expect(adapter.readBinding()).toEqual({ status: 'blocked' });
    });

    it('does not accept or revive an interaction invalidated during final publication observation', () =>
    {
        const { adapter, state, scope } = fixture();
        expect(adapter.start(pointer(500))).toBe(true);
        state.beforePort = name =>
        {
            if (name === 'measure' && state.publications === 1)
            {
                adapter.invalidate();
            }
        };
        expect(adapter.proposal(pointer(600))).toBe('recovery-required');
        state.beforePort = () => {};
        expect(adapter.proposal(pointer(650))).toBe('refused');
        expect(state.publications).toBe(1);
        expect(authoringWorkspaceRatioOwner.read(scope).splitRatioPermille).toBe(600);
    });

    it('locks cancellation callback reentry and allows only a later fresh interaction', () =>
    {
        const { adapter, state } = fixture();
        expect(adapter.start(pointer(500))).toBe(true);
        const observations: { start: boolean; binding: string; proposal: string; }[] = [];
        state.onCancel = () =>
        {
            observations.push({ start: adapter.start(pointer(500)), binding: adapter.readBinding().status,
                proposal: adapter.proposal(pointer(600)) });
        };
        adapter.invalidate();
        // Assert outside cancel: the production cleanup intentionally catches callback failures.
        expect(observations).toEqual([{ start: false, binding: 'blocked', proposal: 'refused' }]);
        expect(state.publications).toBe(0);
        expect(adapter.start(pointer(500))).toBe(true);
    });

    it('discards refused staging and leaves end single-use and cancellation without rollback', () =>
    {
        const refused = fixture();
        expect(refused.adapter.start(pointer(500))).toBe(true);
        refused.state.refusePublication = true;
        expect(refused.adapter.proposal(pointer(600))).toBe('refused');
        expect(() => authoringWorkspaceRatioOwner.commit(refused.scope, refused.state.prepared!)).toThrow('invalid-change');
        expect(authoringWorkspaceRatioOwner.read(refused.scope)).toEqual(refused.initial);

        const accepted = fixture();
        expect(accepted.adapter.start(pointer(500))).toBe(true);
        expect(accepted.adapter.proposal(pointer(600))).toBe('accepted');
        expect(accepted.adapter.end(pointer(600))).toBe(true);
        expect(accepted.adapter.end(pointer(600))).toBe(false);
        expect(accepted.state.publications).toBe(1);
        expect(accepted.adapter.start(pointer(600))).toBe(true);
        expect(accepted.adapter.cancel({ ...pointer(600), reason: 'consumer' })).toBe(true);
        expect(accepted.adapter.end(pointer(600))).toBe(false);
        expect(authoringWorkspaceRatioOwner.read(accepted.scope).splitRatioPermille).toBe(600);
        expect(accepted.state.publications).toBe(1);
    });
});
