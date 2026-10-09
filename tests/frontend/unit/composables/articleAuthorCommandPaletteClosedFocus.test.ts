// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';

import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue';
import { useArticleAuthorCommandPalette } from '@/composables/useArticleAuthorCommandPalette';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));

it.each(['disable', 'replace-scope'] as const)(
    'keeps newer focus when the actual Writer retires an already closed palette: %s',
    async retirement =>
    {
        const host = document.createElement('section');
        const replacementScope = document.createElement('section');
        const other = document.createElement('button');
        document.body.append(host, replacementScope, other);
        const editor = mount(ArticleWriteEditor, {
            attachTo: host,
            props: { modelValue: 'Writer source stays unchanged',
                documentIdentity: { id: 'article:closed-palette-focus', epoch: 1 } }
        });
        const scope = effectScope();
        const enabled = ref(true);
        const shortcutScope = shallowRef<HTMLElement | null>(host);
        const palette = scope.run(() => useArticleAuthorCommandPalette({
            editor: shallowRef(editor.vm), shortcutScope, enabled
        }))!;
        cleanups.push(() =>
        {
            scope.stop();
            editor.unmount();
            host.remove();
            replacementScope.remove();
            other.remove();
        });

        const textarea = editor.get('textarea').element as HTMLTextAreaElement;
        textarea.focus();
        textarea.setSelectionRange(2, 8, 'backward');
        expect(palette.open()).toBe(true);
        await vi.waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('combobox'));
        const input = document.activeElement!;
        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true
        }));
        await vi.waitFor(() =>
        {
            expect(document.activeElement).toBe(textarea);
            expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        });
        other.focus();
        await nextTick();
        expect(document.activeElement).toBe(other);

        if (retirement === 'disable')
        {
            enabled.value = false;
        }
        else
        {
            shortcutScope.value = replacementScope;
        }
        await nextTick();
        expect(document.activeElement).toBe(other);
        expect(textarea.selectionStart).toBe(2);
        expect(textarea.selectionEnd).toBe(8);
        expect(textarea.selectionDirection).toBe('backward');
        expect(textarea.value).toBe('Writer source stays unchanged');
        expect(editor.emitted('update:modelValue')).toBeUndefined();
    }
);
