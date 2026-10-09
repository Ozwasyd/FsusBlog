import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    getMotionPreset,
    isMotionPresetName,
    motionPresetAliases,
    normalizeMotionOptions,
    setMotionBudget
} from '@ozwasyd/element-plus/motion';
import type { MotionPresetName, MotionRunOptions } from '@ozwasyd/element-plus/motion';

import {
    fsusBlogMotionPresets,
    fsusBlogScrollRevealMotion,
    fsusBlogScrollRevealOptions,
    runMotion
} from '@/fsusui/motion';
import type { FsusBlogMotionSurface } from '@/fsusui/motion';

// Keep the original consumer inputs beside the documented runtime migration
// targets. Surface-specific alternatives would change the existing effects.
const migration = {
    homeHero: ['fade-in', 'surface-settle'],
    articleCards: ['fade-in', 'surface-settle'],
    searchDialog: ['scale-fade', 'dialog-settle'],
    mobileDrawer: ['slide-right', 'sheet-settle'],
    mobileBar: ['slide-up', 'sheet-settle'],
    toast: ['slide-up', 'sheet-settle'],
    articleTitle: ['fade-in', 'surface-settle'],
    mediaOverlay: ['scale-fade', 'dialog-settle'],
    backToTop: ['scale-fade', 'dialog-settle'],
    tagChip: ['fade-in', 'surface-settle'],
    route: ['ownership-transfer-snapshot', 'ownership-transfer-snapshot'],
    identityRoute: ['ownership-transfer-snapshot', 'ownership-transfer-snapshot'],
    banner: ['fade-down', 'paper-settle']
} as const satisfies Record<FsusBlogMotionSurface, readonly [string, MotionPresetName]>;

// Compiling this ordinary test also checks every adapter value against the real
// public union, which intentionally excludes runtime-only compatibility names.
const publicPresetContract: Record<FsusBlogMotionSurface, MotionPresetName> = fsusBlogMotionPresets;
const originalMotionMode = document.documentElement.dataset.fsusMotion;

afterEach(() =>
{
    vi.restoreAllMocks();
    setMotionBudget();
    if (originalMotionMode === undefined)
    {
        delete document.documentElement.dataset.fsusMotion;
    }
    else
    {
        document.documentElement.dataset.fsusMotion = originalMotionMode;
    }
});

function captureMotion(options: MotionRunOptions)
{
    const element = document.createElement('div');
    const animation = {
        playState: 'running',
        cancel: vi.fn(),
        finish: vi.fn(),
        onfinish: null,
        oncancel: null
    };
    const animate = vi.fn().mockReturnValue(animation);
    Object.defineProperty(element, 'animate', { value: animate });
    const onFinish = vi.fn();
    const controls = runMotion(element, { ...options, onFinish });
    return { element, animation, animate, onFinish, controls };
}

describe('Blog motion canonical contract migration', () =>
{
    it('uses canonical public names with the same real preset definitions for every surface', () =>
    {
        expect(Object.keys(publicPresetContract).sort()).toEqual(Object.keys(migration).sort());
        for (const [surface, [legacy, canonical]] of Object.entries(migration))
        {
            const actual = publicPresetContract[surface as FsusBlogMotionSurface];
            expect(actual, surface).toBe(canonical);
            expect(isMotionPresetName(actual), surface).toBe(true);
            expect(normalizeMotionOptions(legacy).name, surface).toBe(canonical);
            expect(getMotionPreset(actual), surface).toBe(getMotionPreset(legacy));
            if (legacy !== canonical)
            {
                expect(motionPresetAliases[legacy as keyof typeof motionPresetAliases], surface).toBe(canonical);
            }
        }
    });

    it('preserves quiet, once-only scroll reveal options', () =>
    {
        expect(fsusBlogScrollRevealMotion).toEqual({ name: 'surface-settle', once: true });
        expect(fsusBlogScrollRevealOptions).toEqual({ name: 'surface-settle', once: true, start: 'top 88%' });
        expect(getMotionPreset(fsusBlogScrollRevealOptions.name)).toBe(getMotionPreset('fade-in'));
    });

    it.each(['enabled', 'reduced', 'disabled'] as const)('preserves enter/leave runtime and cancellation in %s mode', (mode) =>
    {
        document.documentElement.dataset.fsusMotion = mode;
        for (const [surface, [legacy]] of Object.entries(migration))
        {
            const name = publicPresetContract[surface as FsusBlogMotionSurface];
            for (const phase of ['enter', 'leave'] as const)
            {
                const original = captureMotion({ name: legacy, phase });
                const migrated = captureMotion({ name, phase });
                expect(migrated.animate.mock.calls, `${surface}/${phase}`).toEqual(original.animate.mock.calls);
                expect(migrated.onFinish.mock.calls).toEqual(original.onFinish.mock.calls);
                if (mode !== 'enabled')
                {
                    const preset = getMotionPreset(name);
                    const terminal = {
                        opacity: phase === 'leave' ? preset.leaveTo?.opacity ?? '0' : preset.reduced.opacity,
                        transform: 'none',
                        filter: 'none'
                    };
                    expect(migrated.animate.mock.calls[0][0]).toEqual([terminal, terminal]);
                    expect(migrated.onFinish).toHaveBeenCalledOnce();
                }
                original.controls.cancel();
                migrated.controls.cancel();
                expect(migrated.animation.cancel).toHaveBeenCalledOnce();
                expect(migrated.onFinish).toHaveBeenCalledTimes(mode === 'enabled' ? 0 : 1);
            }
        }
    });

    it('retains the opacity-only route handoff and cancels a replaced run without completing it', () =>
    {
        document.documentElement.dataset.fsusMotion = 'enabled';
        for (const surface of ['route', 'identityRoute'] as const)
        {
            const name = publicPresetContract[surface];
            expect(getMotionPreset(name)).toMatchObject({
                surfaces: ['ownership-transfer-surface', 'route-surface'],
                from: { opacity: '0' },
                to: { opacity: '1' },
                leaveFrom: { opacity: '1' },
                leaveTo: { opacity: '0' },
                reduced: { opacity: '1' }
            });
            const entering = captureMotion({ name });
            expect(entering.animate.mock.calls[0][0]).toEqual([{ opacity: '0' }, { opacity: '1' }]);
            const onFinish = vi.fn();
            const leaving = runMotion(entering.element, { name, phase: 'leave', onFinish });
            expect(entering.animation.cancel).toHaveBeenCalledOnce();
            expect(entering.onFinish).not.toHaveBeenCalled();
            expect(entering.animate.mock.calls[1][0]).toEqual([{ opacity: '1' }, { opacity: '0' }]);
            leaving.finish();
            leaving.finish();
            expect(onFinish).toHaveBeenCalledOnce();
            leaving.cancel();
        }
    });
});
