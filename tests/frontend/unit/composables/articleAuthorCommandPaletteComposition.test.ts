// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElDrawer, ElIcon } from '@ozwasyd/element-plus';

import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue';
import MarkdownTextEditor from '@/components/ui/MarkdownTextEditor.vue';
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
    const composition = (type: 'compositionstart' | 'compositionend') => {
        input.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
    };
    return { scope, host, input, editor, shortcutScope, enabled, palette, openCommandPalette, key, composition };
}

describe('article palette host composition lifecycle', () => {
    it.each([{ ctrlKey: true, metaKey: false }, { ctrlKey: false, metaKey: true }])(
        'preserves composition in the actual Writer and resumes normal shortcuts afterward %j', async modifier => {
            const host = document.createElement('section');
            document.body.append(host);
            const writer = mount(ArticleWriteEditor, { attachTo: host, global: { components: { ElDrawer, ElIcon } }, props: {
                modelValue: 'Unchanged writer source',
                documentIdentity: { id: 'article:writer-composition', epoch: 1 }
            } });
            const scope = effectScope();
            const palette = scope.run(() => useArticleAuthorCommandPalette({
                editor: shallowRef(writer.vm), shortcutScope: shallowRef(host), enabled: ref(true)
            }))!;
            cleanups.push(() => { scope.stop(); writer.unmount(); host.remove(); });
            await nextTick();
            const textarea = writer.get('textarea').element as HTMLTextAreaElement;
            textarea.focus();
            textarea.setSelectionRange(2, 8, 'backward');
            textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            const events = [{ isComposing: true }, { keyCode: 229 }, { repeat: true }].map(guard => {
                const event = new KeyboardEvent('keydown', {
                    key: 'p', bubbles: true, cancelable: true, ...modifier, ...guard
                });
                textarea.dispatchEvent(event);
                return event;
            });
            expect(events.map(event => event.defaultPrevented)).toEqual([false, false, false]);
            expect(palette.open()).toBe(false);
            await nextTick();
            expect(document.body.querySelector('[role="dialog"]')).toBeNull();
            expect(textarea.value).toBe('Unchanged writer source');
            textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
            expect(palette.open()).toBe(true);
            await nextTick();
            const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] [role="combobox"]')!;
            expect(input).not.toBeNull();
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            await vi.waitFor(() => {
                expect(document.activeElement).toBe(textarea);
                expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual([2, 8, 'backward']);
            });
            expect(writer.getComponent(MarkdownTextEditor).emitted('update:modelValue')).toBeUndefined();
        }
    );

    it.each([{ ctrlKey: true, metaKey: false }, { ctrlKey: false, metaKey: true }])(
        'leaves all three composition shortcuts native, including the unflagged repeat %j', modifier => {
            const test = harness();
            test.composition('compositionstart');
            const events = [
                test.key({ ...modifier, isComposing: true }),
                test.key({ ...modifier, keyCode: 229 }),
                test.key({ ...modifier, repeat: true })
            ];
            expect(events.map(event => event.defaultPrevented)).toEqual([false, false, false]);
            expect(test.openCommandPalette).not.toHaveBeenCalled();
            expect(test.palette.open()).toBe(false);
            test.composition('compositionend');
            expect(test.key(modifier).defaultPrevented).toBe(true);
            expect(test.key({ ...modifier, repeat: true }).defaultPrevented).toBe(true);
            expect(test.openCommandPalette).toHaveBeenCalledTimes(1);
        }
    );

    it('retains the composition guard through host disable and reenable', () => {
        const test = harness();
        test.composition('compositionstart');
        test.enabled.value = false;
        test.enabled.value = true;
        expect(test.key({ repeat: true }).defaultPrevented).toBe(false);
        expect(test.palette.open()).toBe(false);
        test.composition('compositionend');
        expect(test.palette.open()).toBe(true);
    });

    it('unbinds old composition listeners when the editor is replaced', () => {
        const test = harness();
        test.composition('compositionstart');
        test.editor.value = null;
        test.composition('compositionstart');
        const replacement = vi.fn();
        test.editor.value = { openCommandPalette: replacement };
        expect(test.key().defaultPrevented).toBe(true);
        expect(replacement).toHaveBeenCalledTimes(1);
        expect(test.openCommandPalette).not.toHaveBeenCalled();
    });

    it('owns composition only in the current scope and removes it on disposal', () => {
        const test = harness();
        const other = document.createElement('section');
        document.body.append(other);
        cleanups.push(() => other.remove());
        test.composition('compositionstart');
        test.shortcutScope.value = other;
        test.composition('compositionstart');
        const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
        other.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(test.openCommandPalette).toHaveBeenCalledTimes(1);
        expect(test.key().defaultPrevented).toBe(false);
        test.scope.stop();
        other.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        expect(test.palette.open()).toBe(false);
        expect(test.openCommandPalette).toHaveBeenCalledTimes(1);
    });
});
