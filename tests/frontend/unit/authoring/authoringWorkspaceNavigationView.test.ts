// @vitest-environment happy-dom
import { ElDrawer, ElIcon, ElMarkdownEditor } from '@ozwasyd/element-plus';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ArticleWriteEditor from '@/components/admin/article/ArticleWriteEditor.vue';
import type { AuthoringNativeNavigationViewPort } from '@/services/authoring/authoringWorkspaceNavigationView';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));
async function fixture()
{
    const wrapper = mount(ArticleWriteEditor, { props: { modelValue: '# Real writer\n\n😀 source',
        documentIdentity: { id: 'document:wrapper', epoch: 2 } }, attachTo: document.body,
        global: { components: { ElDrawer, ElIcon } } });
    cleanups.push(() => wrapper.unmount());
    await nextTick();
    const editor = wrapper.vm.getAuthoringSessionPort()!;
    const session = editor.getSession('session:wrapper');
    const options = { session, expected: session.inspectDocumentState(), signal: new AbortController().signal,
        assertAdmission: () => undefined };
    return { wrapper, editor, options };
}

describe('original ArticleWriteEditor → adapter → leaf source view plumbing', () =>
{
    it('preserves explicit public surface choices through every original wrapper without replacing the native session', async () =>
    {
        const f = await fixture();
        const surfaces = { toolbar: true, selectionToolbar: false, slashMenu: true, commandPalette: true };
        await f.wrapper.setProps({ commandSurfaces: surfaces });
        expect(f.wrapper.getComponent(ElMarkdownEditor).props('surfaces')).toEqual(surfaces);
        expect(f.wrapper.vm.getAuthoringSessionPort()).toBe(f.editor);
        expect(f.editor.getSession('session:wrapper')).toBe(f.options.session);
        await f.wrapper.setProps({ commandSurfaces: { ...surfaces, selectionToolbar: true } });
        expect(f.wrapper.getComponent(ElMarkdownEditor).props('surfaces').selectionToolbar).toBe(true);
    });

    it('keeps the original raw editor/session and refuses unavailable geometry without a capture default', async () =>
    {
        const f = await fixture();
        expect(f.wrapper.vm.getAuthoringEditorPort()).toBe(f.editor);
        expect(f.wrapper.vm.getAuthoringSessionPort()!.getSession('session:wrapper')).toBe(f.options.session);
        const focus = document.activeElement;
        expect(f.wrapper.vm.readSourceNavigationView(f.options)).toBeNull();
        expect(document.activeElement).toBe(focus);
    });

    it('passes the exact session, expected state, signal and admission callback to the original native method', async () =>
    {
        const f = await fixture();
        const native = f.editor as typeof f.editor & AuthoringNativeNavigationViewPort;
        const read = vi.spyOn(native, 'readSourceNavigationView');
        f.wrapper.vm.readSourceNavigationView(f.options);
        expect(read).toHaveBeenCalledWith(f.options);
        expect(read.mock.calls[0]![0].session).toBe(f.options.session);
        expect(read.mock.calls[0]![0].signal).toBe(f.options.signal);
    });

    it.each(['abort', 'admission'])('preserves the original %s thrown value across the real wrappers', async kind =>
    {
        const f = await fixture();
        const sentinel = new Error(`original-${kind}`);
        const controller = new AbortController();
        const options = { ...f.options, signal: controller.signal,
            assertAdmission: () => { if (kind === 'admission') throw sentinel; } };
        if (kind === 'abort') controller.abort(sentinel);
        let thrown: unknown;
        try { f.wrapper.vm.readSourceNavigationView(options); } catch (error) { thrown = error; }
        expect(thrown).toBe(sentinel);
    });

    it('refuses copied or foreign capsules before reading their properties', async () =>
    {
        const f = await fixture();
        const getter = vi.fn(() => { throw new Error('foreign property must not execute'); });
        const foreign = Object.defineProperty({}, 'source', { get: getter });
        expect(f.wrapper.vm.isCurrentSourceNavigationView(foreign as never)).toBe(false);
        expect(f.wrapper.vm.isCurrentSourceNavigationView({ ...foreign } as never)).toBe(false);
        expect(getter).not.toHaveBeenCalled();
    });

    it('does not turn synthetic wheel or navigation-key events into manual intent', async () =>
    {
        const f = await fixture();
        await f.wrapper.find('textarea').trigger('wheel', { deltaY: 30 });
        await f.wrapper.find('textarea').trigger('keydown', { key: 'ArrowDown' });
        expect(f.wrapper.emitted('source-navigation-gesture')).toBeUndefined();
    });
});
