// @vitest-environment happy-dom

import { effectScope, ref, shallowRef } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useArticleAuthorCommandPalette } from '@/composables/useArticleAuthorCommandPalette';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));

function harness() {
    const scope = effectScope();
    const host = document.createElement('section');
    const input = document.createElement('textarea');
    host.append(input);
    document.body.append(host);
    const openCommandPalette = vi.fn();
    const closeCommandPalette = vi.fn();
    const editor = shallowRef<{ openCommandPalette: () => void; closeCommandPalette: () => void; } | null>({
        openCommandPalette, closeCommandPalette
    });
    const shortcutScope = shallowRef<HTMLElement | null>(host);
    const enabled = ref(true);
    const palette = scope.run(() => useArticleAuthorCommandPalette({ editor, shortcutScope, enabled }))!;
    cleanups.push(() => { scope.stop(); host.remove(); });
    const key = (options: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true, ...options });
        input.dispatchEvent(event);
        return event;
    };
    const composition = (type: 'compositionstart' | 'compositionend') => {
        input.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
    };
    return { scope, host, editor, shortcutScope, enabled, palette, openCommandPalette, closeCommandPalette, key, composition };
}

describe('article palette post-composition repeated shortcut admission', () => {
    it.each([{ ctrlKey: true, metaKey: false }, { ctrlKey: false, metaKey: true }])(
        'keeps inherited repeats native until a fresh shortcut after composition %j', modifier => {
            const test = harness();
            test.composition('compositionstart');
            expect([
                test.key({ ...modifier, isComposing: true }),
                test.key({ ...modifier, keyCode: 229 }),
                test.key({ ...modifier, repeat: true })
            ].map(event => event.defaultPrevented)).toEqual([false, false, false]);
            test.composition('compositionend');
            for (let index = 0; index < 3; index += 1) {
                expect(test.key({ ...modifier, repeat: true }).defaultPrevented).toBe(false);
            }
            expect(test.openCommandPalette).not.toHaveBeenCalled();
            expect(test.closeCommandPalette).not.toHaveBeenCalled();
            expect(test.key(modifier).defaultPrevented).toBe(true);
            expect(test.key({ ...modifier, repeat: true }).defaultPrevented).toBe(true);
            expect(test.openCommandPalette).toHaveBeenCalledTimes(1);
        }
    );

    it('keeps guarded or already claimed keys from admitting inherited repeats', () => {
        const test = harness();
        test.composition('compositionstart');
        test.composition('compositionend');
        for (const guard of [{ keyCode: 229 }, { isComposing: true }, { shiftKey: true }, { altKey: true }, { key: 'o' }]) {
            expect(test.key(guard).defaultPrevented).toBe(false);
            expect(test.key({ repeat: true }).defaultPrevented).toBe(false);
        }
        const claimed = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
        claimed.preventDefault();
        test.host.dispatchEvent(claimed);
        expect(test.key({ repeat: true }).defaultPrevented).toBe(false);
        expect(test.openCommandPalette).not.toHaveBeenCalled();
    });

    it('admits an explicit entry after composition and preserves delegated cancellation', () => {
        const test = harness();
        test.composition('compositionstart');
        expect(test.palette.open()).toBe(false);
        test.composition('compositionend');
        expect(test.palette.open()).toBe(true);
        expect(test.key({ repeat: true }).defaultPrevented).toBe(true);
        test.enabled.value = false;
        expect(test.closeCommandPalette).toHaveBeenCalledTimes(1);
        test.scope.stop();
        expect(test.closeCommandPalette).toHaveBeenCalledTimes(1);
    });

    it('leaves ordinary repeats unchanged when composition never started', () => {
        const test = harness();
        test.composition('compositionend');
        expect(test.key({ repeat: true }).defaultPrevented).toBe(true);
        expect(test.openCommandPalette).not.toHaveBeenCalled();
    });

    it('retires the old composition tail when the scoped editor is replaced', () => {
        const test = harness();
        test.composition('compositionstart');
        test.composition('compositionend');
        test.editor.value = null;
        expect(test.key({ repeat: true }).defaultPrevented).toBe(false);
        test.editor.value = { openCommandPalette: test.openCommandPalette, closeCommandPalette: test.closeCommandPalette };
        expect(test.key({ repeat: true }).defaultPrevented).toBe(true);
        expect(test.openCommandPalette).not.toHaveBeenCalled();
    });
});
