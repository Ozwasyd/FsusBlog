// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue';
import ArticleAuthorCommandEntry from '@/components/admin/article/ArticleAuthorCommandEntry.vue';
import MarkdownTextEditor from '@/components/ui/MarkdownTextEditor.vue';
import { useArticleAuthorCommandPalette } from '@/composables/useArticleAuthorCommandPalette';

it('mounts the real secondary entry and opens the same public writer palette without changing source', async () => {
    const host = document.createElement('section');
    document.body.append(host);
    const enabled = ref(true);
    const handler = vi.fn(() => ({ focus: 'none' as const }));
    const Wrapper = defineComponent({ setup() {
        const editor = ref<{ openCommandPalette: () => void; } | null>(null);
        const shortcutScope = ref<HTMLElement | null>(null);
        const palette = useArticleAuthorCommandPalette({ editor, shortcutScope, enabled });
        return () => h('div', { ref: shortcutScope }, [h(ArticleWriteEditor, {
            ref: editor, modelValue: 'Unchanged writer source', documentIdentity: { id: 'article:writer-entry', epoch: 1 },
            authoringCommands: [{ key: 'fixture.inspect', label: 'Inspect document', group: 'fixture', run: handler }]
        }, { 'secondary-action': () => h(ArticleAuthorCommandEntry, { palette, label: 'Article inspectors' }) })]);
    } });
    const wrapper = mount(Wrapper, { attachTo: host });
    try {
        await nextTick();
        const entry = wrapper.getComponent(ArticleAuthorCommandEntry);
        expect(entry.element.closest('.article-write-editor__secondary')).not.toBeNull();
        await entry.get('button').trigger('click');
        const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(dialog).not.toBeNull();
        const command = [...dialog.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.includes('Inspect document'))!;
        expect(command).toBeDefined();
        command.click();
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
        expect(wrapper.getComponent(MarkdownTextEditor).emitted('update:modelValue')).toBeUndefined();
        enabled.value = false;
        await nextTick();
        expect(entry.get('button').attributes('disabled')).toBeDefined();
        const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
        entry.element.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    } finally {
        wrapper.unmount();
        host.remove();
    }
});
