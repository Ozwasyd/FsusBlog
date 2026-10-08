// @vitest-environment happy-dom

import { effectScope, ref, shallowRef } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useArticleAuthorCommandPalette } from '@/composables/useArticleAuthorCommandPalette';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function harness() {
    const scope = effectScope();
    const host = document.createElement('section');
    const input = document.createElement('textarea');
    host.append(input);
    document.body.append(host);
    const openCommandPalette = vi.fn();
    const editor = shallowRef<{ openCommandPalette: () => void; } | null>({ openCommandPalette });
    const shortcutScope = shallowRef<HTMLElement | null>(host);
    const enabled = ref(true);
    const palette = scope.run(() => useArticleAuthorCommandPalette({ editor, shortcutScope, enabled }))!;
    cleanups.push(() => { scope.stop(); host.remove(); });
    const key = (options: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true, ...options });
        input.dispatchEvent(event);
        return event;
    };
    return { scope, host, input, editor, shortcutScope, enabled, palette, openCommandPalette, key };
}

describe('article author command palette entry', () => {
    it.each([{ ctrlKey: true, metaKey: false }, { ctrlKey: false, metaKey: true }])(
        'opens the existing owner for one Mod+P variant %j', (modifier) => {
            const test = harness();
            expect(test.key({ ...modifier, key: 'P' }).defaultPrevented).toBe(true);
            expect(test.openCommandPalette).toHaveBeenCalledTimes(1);
            expect(test.palette.open()).toBe(true);
            expect(test.openCommandPalette).toHaveBeenCalledTimes(2);
        }
    );

    it.each([
        { key: 'o' }, { key: 'Enter' }, { key: 'Escape' }, { altKey: true }, { shiftKey: true },
        { ctrlKey: false }, { metaKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }
    ])('preserves other shortcuts and native/composition events %j', (options) => {
        const test = harness();
        expect(test.key(options).defaultPrevented).toBe(false);
        expect(test.openCommandPalette).not.toHaveBeenCalled();
    });

    it('preserves an already claimed shortcut', () => {
        const test = harness();
        const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
        event.preventDefault();
        test.input.dispatchEvent(event);
        expect(test.openCommandPalette).not.toHaveBeenCalled();
    });

    it('reads current availability and current editor on every invocation', () => {
        const test = harness();
        test.enabled.value = false;
        expect(test.palette.available.value).toBe(false);
        expect(test.palette.open()).toBe(false);
        expect(test.key().defaultPrevented).toBe(false);
        test.enabled.value = true;
        test.editor.value = null;
        expect(test.palette.open()).toBe(false);
        expect(test.key().defaultPrevented).toBe(false);
        const replacement = vi.fn();
        test.editor.value = { openCommandPalette: replacement };
        expect(test.key().defaultPrevented).toBe(true);
        expect(replacement).toHaveBeenCalledTimes(1);
        expect(test.openCommandPalette).not.toHaveBeenCalled();
    });

    it('owns only its current scope and removes both old and disposed listeners', () => {
        const test = harness();
        const other = document.createElement('section');
        document.body.append(other);
        cleanups.push(() => other.remove());
        const dispatch = () => {
            const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
            other.dispatchEvent(event);
            return event;
        };
        expect(dispatch().defaultPrevented).toBe(false);
        test.shortcutScope.value = other;
        expect(test.key().defaultPrevented).toBe(false);
        expect(dispatch().defaultPrevented).toBe(true);
        test.shortcutScope.value = null;
        expect(dispatch().defaultPrevented).toBe(false);
        test.shortcutScope.value = other;
        test.scope.stop();
        expect(dispatch().defaultPrevented).toBe(false);
        expect(test.openCommandPalette).toHaveBeenCalledTimes(1);
    });
});
