// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ArticleAuthorCommandEntry from '@/components/admin/article/ArticleAuthorCommandEntry.vue';
import MarkdownTextEditor from '@/components/ui/MarkdownTextEditor.vue';
import { useArticleAuthorCommandPalette } from '@/composables/useArticleAuthorCommandPalette';
import type { FsusUiAuthoringCommand } from '@/fsusui/authoringCommands';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

async function harness(commands: readonly FsusUiAuthoringCommand[] = []) {
    const host = document.createElement('section');
    document.body.append(host);
    const editor = mount(MarkdownTextEditor, {
        attachTo: host,
        props: {
            modelValue: 'Unchanged source',
            documentIdentity: { id: 'article:palette-entry', epoch: 1 },
            authoringCommands: commands,
            commandSurfaces: { commandPalette: true }
        }
    });
    const scope = effectScope();
    const enabled = ref(true);
    const palette = scope.run(() => useArticleAuthorCommandPalette({
        editor: shallowRef(editor.vm), shortcutScope: shallowRef(host), enabled
    }))!;
    const entry = mount(ArticleAuthorCommandEntry, { attachTo: host, props: { palette, label: 'Author commands' } });
    cleanups.push(() => { entry.unmount(); editor.unmount(); scope.stop(); host.remove(); });
    await nextTick();
    return { host, editor, entry, enabled };
}

describe('article command entry with real alias-resolved FsusUI editor', () => {
    it('offers a visible accessible button and delegates to the existing command-only palette', async () => {
        const test = await harness();
        const button = test.entry.get('button');
        expect(button.attributes('type')).toBe('button');
        expect(button.attributes('aria-haspopup')).toBe('dialog');
        expect(button.attributes('aria-keyshortcuts')).toBe('Control+P Meta+P');
        expect(button.text()).toBe('Author commands');
        await button.trigger('click');
        const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(dialog).not.toBeNull();
        expect(dialog.querySelector('[role="combobox"]')).toBe(document.activeElement);
        expect(dialog.querySelector('[role="listbox"]')).not.toBeNull();
        expect(test.editor.emitted('update:modelValue')).toBeUndefined();
        test.enabled.value = false;
        await nextTick();
        expect(button.attributes('disabled')).toBeDefined();
    });

    it('opens from scoped Mod+P and restores the same backward selection on Escape', async () => {
        const test = await harness();
        const textarea = test.editor.get('textarea').element as HTMLTextAreaElement;
        textarea.focus();
        textarea.setSelectionRange(2, 8, 'backward');
        const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
        textarea.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        await nextTick();
        const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] [role="combobox"]')!;
        expect(input).toBe(document.activeElement);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await vi.waitFor(() => {
            expect(document.activeElement).toBe(textarea);
            expect(textarea.selectionStart).toBe(2);
            expect(textarea.selectionEnd).toBe(8);
            expect(textarea.selectionDirection).toBe('backward');
        });
        expect(test.editor.emitted('update:modelValue')).toBeUndefined();
    });

    it('executes the supplied formal command once through the actual palette registry', async () => {
        const handler = vi.fn<FsusUiAuthoringCommand['run']>(() => ({ focus: 'none' as const }));
        const command: FsusUiAuthoringCommand = {
            key: 'fsusblog.core.fixture.inspector', group: 'navigate', label: 'Inspect exact handler',
            presentation: ['palette'], when: () => true, enabled: () => true, run: handler
        };
        const test = await harness([command]);
        await test.entry.get('button').trigger('click');
        const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] [role="combobox"]')!;
        input.value = 'Inspect exact handler';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await nextTick();
        expect(document.body.querySelectorAll('[role="dialog"] [role="option"]')).toHaveLength(1);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
        expect(handler.mock.calls[0]?.[0].documentIdentity).toEqual({ id: 'article:palette-entry', epoch: 1 });
        expect(test.editor.emitted('update:modelValue')).toBeUndefined();
    });

    it('keeps command availability with its original current authority after searching', async () => {
        let permitted = true;
        const handler = vi.fn<FsusUiAuthoringCommand['run']>(() => ({ focus: 'none' as const }));
        const test = await harness([{
            key: 'fsusblog.core.fixture.permission', group: 'navigate', label: 'Guarded handler',
            presentation: ['palette'], when: () => true, enabled: () => permitted, run: handler
        }]);
        await test.entry.get('button').trigger('click');
        const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] [role="combobox"]')!;
        input.value = 'Guarded handler';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await nextTick();
        permitted = false;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await nextTick();
        expect(handler).not.toHaveBeenCalled();
        expect(test.editor.emitted('update:modelValue')).toBeUndefined();
    });

    it('closes the original palette on a same-bytes document identity change', async () => {
        const test = await harness();
        await test.entry.get('button').trigger('click');
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
        await test.editor.setProps({ documentIdentity: { id: 'article:another', epoch: 2 } });
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(test.editor.emitted('update:modelValue')).toBeUndefined();
    });

    it('keeps async duplicate suppression and stale-result cancellation in the original editor', async () => {
        let finish: (result: { focus: 'none'; }) => void = () => undefined;
        const result = new Promise<{ focus: 'none'; }>((resolve) => { finish = resolve; });
        const handler = vi.fn<FsusUiAuthoringCommand['run']>(() => result);
        const test = await harness([{
            key: 'fsusblog.core.fixture.pending', group: 'navigate', label: 'Pending handler',
            presentation: ['palette'], when: () => true, enabled: () => true, run: handler
        }]);
        await test.entry.get('button').trigger('click');
        const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] [role="combobox"]')!;
        input.value = 'Pending handler';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await nextTick();
        for (let index = 0; index < 3; index += 1) {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        }
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
        const signal = handler.mock.calls[0]![0].signal;
        await test.editor.setProps({ documentIdentity: { id: 'article:replacement', epoch: 2 } });
        expect(signal.aborted).toBe(true);
        finish({ focus: 'none' });
        await nextTick();
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(test.editor.emitted('update:modelValue')).toBeUndefined();
    });
});
