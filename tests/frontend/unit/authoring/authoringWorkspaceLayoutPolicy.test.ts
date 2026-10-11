import { afterEach, describe, expect, it } from 'vitest';

import { calculateAuthoringWorkspaceGeometry } from '@/services/authoring/authoringWorkspaceGeometryPolicy';
import { authoringWorkspaceRatioOwner, authoringWorkspaceRatioPolicy } from '@/services/authoring/authoringWorkspaceRatioOwner';

import type { AuthoringWorkspaceGeometryInput } from '@/services/authoring/authoringWorkspaceGeometryPolicy';
import type { AuthoringWorkspaceRatioRef, AuthoringWorkspaceRatioScope } from '@/services/authoring/authoringWorkspaceRatioOwner';

// Source controls only. The original Vitest setup/locale graph still requires root approval.
// Synthetic geometry is not a browser, receipt, security or session-retention qualification.
const scopes = new Set<AuthoringWorkspaceRatioScope>();

function workspace(): AuthoringWorkspaceRatioScope
{
    const scope = authoringWorkspaceRatioOwner.openWorkspace();
    scopes.add(scope);
    return scope;
}

afterEach(() =>
{
    for (const scope of scopes)
    {
        authoringWorkspaceRatioOwner.releaseWorkspace(scope);
    }
    scopes.clear();
});

function measurements(overrides: Partial<AuthoringWorkspaceGeometryInput> = {}): AuthoringWorkspaceGeometryInput
{
    return {
        requestedLayout: 'horizontal-two-group',
        splitRatioPermille: 500,
        layoutViewportWidthCssPx: 1440,
        layoutViewportHeightCssPx: 900,
        browserZoomPercent: 100,
        visualViewportScale: 1,
        frame: { left: 0, top: 0, width: 1440, height: 900 },
        visualViewport: { left: 0, top: 0, width: 1440, height: 900 },
        railWidthCssPx: 0,
        inspectorWidthCssPx: 0,
        pageChromeStartCssPx: 0,
        pageChromeEndCssPx: 0,
        pageChromeTopCssPx: 0,
        pageChromeBottomCssPx: 0,
        scrollbarWidthCssPx: 0,
        leadingGroupChromeWidthCssPx: 0,
        trailingGroupChromeWidthCssPx: 0,
        focusedGroupChromeWidthCssPx: 0,
        safeAreaLeftCssPx: 0,
        safeAreaRightCssPx: 0,
        safeAreaTopCssPx: 0,
        safeAreaBottomCssPx: 0,
        mobile: false,
        softKeyboardOpen: false,
        ...overrides
    };
}

describe('workspace ratio owner source controls', () =>
{
    it('keeps state and issuance helpers absent from runtime reflection', () =>
    {
        const prototype = Object.getPrototypeOf(authoringWorkspaceRatioOwner) as object;
        expect(Reflect.ownKeys(authoringWorkspaceRatioOwner)).toEqual([]);
        expect(Reflect.ownKeys(prototype).sort()).toEqual([
            'constructor', 'openWorkspace', 'read', 'resolve', 'prepare', 'readPrepared',
            'commit', 'discard', 'releaseWorkspace'
        ].sort());
        for (const name of ['requireScope', 'issue', '#requireScope', '#issue', '#scopes', '#ratios', '#changes'])
        {
            expect(Reflect.get(authoringWorkspaceRatioOwner, name)).toBeUndefined();
        }
    });

    it('exposes frozen observations without mutable internal state aliases', () =>
    {
        const scope = workspace();
        const before = authoringWorkspaceRatioOwner.read(scope);
        const change = authoringWorkspaceRatioOwner.prepare(scope, before.ratioRef, 600);
        const staged = authoringWorkspaceRatioOwner.readPrepared(scope, change);
        expect(Object.isFrozen(before)).toBe(true);
        expect(Object.isFrozen(staged)).toBe(true);
        expect(Reflect.ownKeys(before).sort()).toEqual(['ratioRef', 'revision', 'splitRatioPermille'].sort());
        expect(Reflect.ownKeys(staged).sort()).toEqual(['expectedRatioRef', 'ratioRef', 'revision', 'splitRatioPermille'].sort());
        expect(Reflect.set(before, 'ratioRef', change.ratioRef)).toBe(false);
        expect(Reflect.set(before, 'revision', staged.revision)).toBe(false);
        expect(Reflect.set(staged, 'expectedRatioRef', change.ratioRef)).toBe(false);
        expect(authoringWorkspaceRatioOwner.read(scope)).toEqual(before);
        expect(() => authoringWorkspaceRatioOwner.resolve(scope, change.ratioRef)).toThrow('stale-ratio');
    });

    it('rejects reflected helper calls without publishing staged refs or issuing outside-bound values', () =>
    {
        const scope = workspace();
        const before = authoringWorkspaceRatioOwner.read(scope);
        const change = authoringWorkspaceRatioOwner.prepare(scope, before.ratioRef, 600);
        const stateGetter = Reflect.get(authoringWorkspaceRatioOwner, 'requireScope') as (...args: unknown[]) => unknown;
        const issuer = Reflect.get(authoringWorkspaceRatioOwner, 'issue') as (...args: unknown[]) => unknown;
        expect(() => Reflect.apply(stateGetter, authoringWorkspaceRatioOwner, [scope])).toThrow(TypeError);
        expect(() => Reflect.apply(issuer, authoringWorkspaceRatioOwner, [scope, 1, 0])).toThrow(TypeError);
        expect(authoringWorkspaceRatioOwner.read(scope)).toEqual(before);
        expect(() => authoringWorkspaceRatioOwner.resolve(scope, change.ratioRef)).toThrow('stale-ratio');
        const after = authoringWorkspaceRatioOwner.commit(scope, change);
        expect(after.ratioRef).toBe(change.ratioRef);
        expect(after.splitRatioPermille).toBe(600);
        expect(() => authoringWorkspaceRatioOwner.prepare(scope, before.ratioRef, 700)).toThrow('stale-ratio');
        expect(() => authoringWorkspaceRatioOwner.prepare(scope, after.ratioRef, 0)).toThrow('invalid-ratio');
    });

    it('starts each real workspace with the canonical default and a distinct ref', () =>
    {
        const first = authoringWorkspaceRatioOwner.read(workspace());
        const second = authoringWorkspaceRatioOwner.read(workspace());
        expect(first.splitRatioPermille).toBe(authoringWorkspaceRatioPolicy.defaultPermille);
        expect(first.revision).toBe(0);
        expect(first.ratioRef).not.toBe(second.ratioRef);
    });

    it('stages and commits both closed endpoints without publishing during prepare', () =>
    {
        const scope = workspace();
        for (const value of [200, 800])
        {
            const before = authoringWorkspaceRatioOwner.read(scope);
            const change = authoringWorkspaceRatioOwner.prepare(scope, before.ratioRef, value);
            const staged = authoringWorkspaceRatioOwner.readPrepared(scope, change);
            expect(staged.expectedRatioRef).toBe(before.ratioRef);
            expect(staged.ratioRef).toBe(change.ratioRef);
            expect(staged.splitRatioPermille).toBe(value);
            expect(authoringWorkspaceRatioOwner.read(scope)).toEqual(before);
            expect(() => authoringWorkspaceRatioOwner.resolve(scope, change.ratioRef)).toThrow('stale-ratio');
            const after = authoringWorkspaceRatioOwner.commit(scope, change);
            expect(after.ratioRef).toBe(change.ratioRef);
            expect(after.splitRatioPermille).toBe(value);
            expect(after.revision).toBe(before.revision + 1);
        }
    });

    it('refuses noninteger, nonfinite and outside-bound input without clamping', () =>
    {
        const scope = workspace();
        const before = authoringWorkspaceRatioOwner.read(scope);
        for (const value of [0, 199, 801, 1000, 500.5, NaN, Infinity])
        {
            expect(() => authoringWorkspaceRatioOwner.prepare(scope, before.ratioRef, value)).toThrow('invalid-ratio');
        }
        expect(authoringWorkspaceRatioOwner.read(scope)).toEqual(before);
    });

    it('lets only one concurrent proposal win exact predecessor CAS', () =>
    {
        const scope = workspace();
        const before = authoringWorkspaceRatioOwner.read(scope);
        const winner = authoringWorkspaceRatioOwner.prepare(scope, before.ratioRef, 600);
        const loser = authoringWorkspaceRatioOwner.prepare(scope, before.ratioRef, 700);
        const after = authoringWorkspaceRatioOwner.commit(scope, winner);
        expect(() => authoringWorkspaceRatioOwner.commit(scope, loser)).toThrow('stale-ratio');
        expect(authoringWorkspaceRatioOwner.read(scope)).toEqual(after);
        expect(() => authoringWorkspaceRatioOwner.commit(scope, winner)).toThrow('invalid-change');
    });

    it('rejects an ABA ref when the number returns to the default', () =>
    {
        const scope = workspace();
        const first = authoringWorkspaceRatioOwner.read(scope);
        const changed = authoringWorkspaceRatioOwner.commit(scope, authoringWorkspaceRatioOwner.prepare(scope, first.ratioRef, 600));
        const restored = authoringWorkspaceRatioOwner.commit(scope, authoringWorkspaceRatioOwner.prepare(scope, changed.ratioRef, 500));
        expect(restored.splitRatioPermille).toBe(first.splitRatioPermille);
        expect(restored.ratioRef).not.toBe(first.ratioRef);
        expect(() => authoringWorkspaceRatioOwner.prepare(scope, first.ratioRef, 600)).toThrow('stale-ratio');
    });

    it('rejects structural copies, fabricated strings and cross-workspace refs', () =>
    {
        const scope = workspace();
        const before = authoringWorkspaceRatioOwner.read(scope);
        const other = authoringWorkspaceRatioOwner.read(workspace());
        expect(() => authoringWorkspaceRatioOwner.resolve(scope, { ...before.ratioRef })).toThrow('stale-ratio');
        expect(() => authoringWorkspaceRatioOwner.resolve(scope, 'ratio:500' as unknown as AuthoringWorkspaceRatioRef)).toThrow('stale-ratio');
        expect(() => authoringWorkspaceRatioOwner.resolve(scope, undefined as unknown as AuthoringWorkspaceRatioRef)).toThrow('stale-ratio');
        expect(() => authoringWorkspaceRatioOwner.resolve(scope, other.ratioRef)).toThrow('stale-ratio');
        expect(() => authoringWorkspaceRatioOwner.read({ ...scope })).toThrow('invalid-scope');
    });

    it('discards a refused transaction and refuses cloned proposals', () =>
    {
        const scope = workspace();
        const before = authoringWorkspaceRatioOwner.read(scope);
        const change = authoringWorkspaceRatioOwner.prepare(scope, before.ratioRef, 600);
        expect(() => authoringWorkspaceRatioOwner.commit(scope, { ...change })).toThrow('invalid-change');
        authoringWorkspaceRatioOwner.discard(scope, change);
        expect(() => authoringWorkspaceRatioOwner.commit(scope, change)).toThrow('invalid-change');
        expect(authoringWorkspaceRatioOwner.read(scope)).toEqual(before);
    });

    it('revokes current and pending refs when the actual workspace lifetime ends', () =>
    {
        const scope = workspace();
        const before = authoringWorkspaceRatioOwner.read(scope);
        const change = authoringWorkspaceRatioOwner.prepare(scope, before.ratioRef, 600);
        authoringWorkspaceRatioOwner.releaseWorkspace(scope);
        scopes.delete(scope);
        expect(() => authoringWorkspaceRatioOwner.read(scope)).toThrow('invalid-scope');
        expect(() => authoringWorkspaceRatioOwner.commit(scope, change)).toThrow('invalid-scope');
        expect(authoringWorkspaceRatioOwner.read(workspace()).splitRatioPermille).toBe(500);
    });
});

describe('workspace pure geometry source controls', () =>
{
    it('plans only horizontal two groups within the visible frame', () =>
    {
        const plan = calculateAuthoringWorkspaceGeometry(measurements());
        expect(plan.status).toBe('planned');
        if (plan.status !== 'planned' || plan.effectiveLayout !== 'horizontal-two-group')
        {
            throw new Error('expected-two-group-plan');
        }
        expect(plan.leadingGroupWidthCssPx + plan.splitter.width + plan.trailingGroupWidthCssPx).toBe(plan.available.width);
        expect(plan.leadingGroupUsableWidthCssPx).toBeGreaterThanOrEqual(384);
        expect(plan.trailingGroupUsableWidthCssPx).toBeGreaterThanOrEqual(384);
        expect(plan.splitter.left).toBe(plan.available.left + plan.leadingGroupWidthCssPx);
    });

    it('subtracts disjoint Rail, inspector, page chrome and scrollbar observations', () =>
    {
        const plan = calculateAuthoringWorkspaceGeometry(measurements({
            railWidthCssPx: 240, inspectorWidthCssPx: 320,
            pageChromeStartCssPx: 16, pageChromeEndCssPx: 16,
            pageChromeTopCssPx: 48, pageChromeBottomCssPx: 32, scrollbarWidthCssPx: 16
        }));
        expect(plan.status === 'planned' && plan.available).toEqual({ left: 256, top: 48, width: 832, height: 820 });
    });

    it('accounts for per-group editor chrome before applying each usable-width minimum', () =>
    {
        const plan = calculateAuthoringWorkspaceGeometry(measurements({
            frame: { left: 0, top: 0, width: 900, height: 900 },
            leadingGroupChromeWidthCssPx: 100, trailingGroupChromeWidthCssPx: 100,
            focusedGroupChromeWidthCssPx: 100
        }));
        expect(plan.status === 'planned' && plan.effectiveLayout).toBe('single-group');
        expect(plan.status === 'planned' && plan.effectiveLayout === 'single-group' && plan.focusedGroupUsableWidthCssPx).toBe(800);
    });

    it('clamps effective ratio without changing the requested ratio or owner identity', () =>
    {
        const scope = workspace();
        const before = authoringWorkspaceRatioOwner.read(scope);
        const current = authoringWorkspaceRatioOwner.commit(scope, authoringWorkspaceRatioOwner.prepare(scope, before.ratioRef, 200));
        const input = measurements({ splitRatioPermille: current.splitRatioPermille, frame: { left: 0, top: 0, width: 800, height: 900 } });
        const plan = calculateAuthoringWorkspaceGeometry(input);
        expect(plan.status === 'planned' && plan.effectiveLayout).toBe('horizontal-two-group');
        if (plan.status !== 'planned' || plan.effectiveLayout !== 'horizontal-two-group')
        {
            throw new Error('expected-two-group-plan');
        }
        expect(plan.requestedRatioPermille).toBe(200);
        expect(plan.effectiveRatioPermille).toBe(plan.minimumEffectiveRatioPermille);
        expect(plan.leadingGroupUsableWidthCssPx).toBeGreaterThanOrEqual(384);
        expect(authoringWorkspaceRatioOwner.read(scope)).toEqual(current);
        expect(input.splitRatioPermille).toBe(200);
    });

    it('collapses and re-expands without issuing a replacement ratio ref', () =>
    {
        const scope = workspace();
        const current = authoringWorkspaceRatioOwner.read(scope);
        const narrow = calculateAuthoringWorkspaceGeometry(measurements({ railWidthCssPx: 400, inspectorWidthCssPx: 400 }));
        const restored = calculateAuthoringWorkspaceGeometry(measurements());
        expect(narrow.status === 'planned' && narrow.effectiveLayout).toBe('single-group');
        expect(restored.status === 'planned' && restored.effectiveLayout).toBe('horizontal-two-group');
        expect(authoringWorkspaceRatioOwner.read(scope).ratioRef).toBe(current.ratioRef);
    });

    it('forces a focused single plan for mobile, soft keyboard or an explicit single request', () =>
    {
        for (const change of [{ mobile: true }, { softKeyboardOpen: true }, { requestedLayout: 'single-group' as const }])
        {
            const plan = calculateAuthoringWorkspaceGeometry(measurements(change));
            expect(plan.status === 'planned' && plan.effectiveLayout).toBe('single-group');
        }
    });

    it('intersects current visual viewport, safe area and soft-keyboard height', () =>
    {
        const plan = calculateAuthoringWorkspaceGeometry(measurements({
            visualViewport: { left: 10, top: 20, width: 1000, height: 500 },
            safeAreaLeftCssPx: 8, safeAreaRightCssPx: 12,
            safeAreaTopCssPx: 16, safeAreaBottomCssPx: 24,
            softKeyboardOpen: true
        }));
        expect(plan.status === 'planned' && plan.available).toEqual({ left: 18, top: 36, width: 980, height: 460 });
    });

    it('refuses invalid measurements, invalid ratio and layouts outside the closed two states', () =>
    {
        expect(calculateAuthoringWorkspaceGeometry(measurements({ railWidthCssPx: -1 }))).toEqual({ status: 'blocked', reason: 'invalid-measurement' });
        expect(calculateAuthoringWorkspaceGeometry(measurements({ browserZoomPercent: NaN }))).toEqual({ status: 'blocked', reason: 'invalid-measurement' });
        expect(calculateAuthoringWorkspaceGeometry(measurements({ splitRatioPermille: 0 }))).toEqual({ status: 'blocked', reason: 'invalid-ratio' });
        expect(calculateAuthoringWorkspaceGeometry(measurements({ requestedLayout: 'grid' as AuthoringWorkspaceGeometryInput['requestedLayout'] }))).toEqual({ status: 'blocked', reason: 'invalid-layout' });
    });

    it('refuses zero area, offscreen frame and a focused editor below its explicit minimum', () =>
    {
        expect(calculateAuthoringWorkspaceGeometry(measurements({ railWidthCssPx: 1440 }))).toEqual({ status: 'blocked', reason: 'offscreen-or-zero-area' });
        expect(calculateAuthoringWorkspaceGeometry(measurements({ frame: { left: 1440, top: 0, width: 800, height: 900 } }))).toEqual({ status: 'blocked', reason: 'offscreen-or-zero-area' });
        expect(calculateAuthoringWorkspaceGeometry(measurements({ frame: { left: 0, top: 900, width: 800, height: 900 } }))).toEqual({ status: 'blocked', reason: 'offscreen-or-zero-area' });
        expect(calculateAuthoringWorkspaceGeometry(measurements({ focusedGroupChromeWidthCssPx: 1320 }))).toEqual({ status: 'blocked', reason: 'insufficient-focused-width' });
    });

    it('uses already-zoomed CSS observations for the required synthetic viewport/zoom matrix', () =>
    {
        for (const viewport of [375, 768, 1024, 1366, 1440])
        {
            for (const zoom of [100, 150, 200])
            {
                const width = viewport / (zoom / 100);
                const input = measurements({
                    layoutViewportWidthCssPx: width, browserZoomPercent: zoom,
                    frame: { left: 0, top: 0, width, height: 900 },
                    visualViewport: { left: 0, top: 0, width, height: 900 }
                });
                const plan = calculateAuthoringWorkspaceGeometry(input);
                if (width < 128)
                {
                    expect(plan).toEqual({ status: 'blocked', reason: 'insufficient-focused-width' });
                }
                else
                {
                    expect(plan.status === 'planned' && plan.available.width).toBe(width);
                    expect(plan.status === 'planned' && plan.effectiveLayout).toBe(width >= 1024 ? 'horizontal-two-group' : 'single-group');
                }
            }
        }
    });
});
