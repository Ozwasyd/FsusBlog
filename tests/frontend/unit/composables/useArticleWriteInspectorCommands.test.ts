// @vitest-environment happy-dom

import { ElMarkdownEditor } from '@ozwasyd/element-plus';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { articleWriteInspectorRegistry, useArticleWriteInspector } from '@/composables/useArticleWriteInspector';
import {
    useArticleWriteInspectorCommands,
    verifyArticleInspectorCommandReceipt
} from '@/composables/useArticleWriteInspectorCommands';
import type { FsusUiAuthoringCommand } from '@/fsusui/authoringCommands';
import { activateLocaleRuntime, requestLocale } from '@/locales';
import { createArticleDocumentContextAdapter, type ArticleDocumentContext } from '@/services/authoring/articleDocumentContext';
import { calculateOpenArticleDocumentDigest } from '@/services/authoring/openArticleDocumentRegistry';
import { useAdminStore } from '@/store/admin';

type CommandContext = Parameters<FsusUiAuthoringCommand['run']>[0];
const source = '# Private draft';
const cleanups: (() => void)[] = [];

function createHarness(loadView: Parameters<typeof useArticleWriteInspector>[0] = {})
{
    const scope = effectScope();
    const documentOwner = createArticleDocumentContextAdapter({
        articleId: 1, draftId: 'article:1', editorSessionId: 'session:palette',
        siteScope: 'site:palette', userScope: 'user:palette', content: source
    });
    const documentContext = shallowRef<ArticleDocumentContext | null>(documentOwner.context);
    const admin = useAdminStore();
    admin.setAdminPrincipal({
        id: 'author:1', displayName: 'Author', source: 'independent',
        permissions: ['article.write'], adminSessionStatus: 'active'
    });
    const loading = ref(false);
    const saving = ref(false);
    const modalActive = ref(false);
    const owner = useArticleWriteInspector(loadView);
    const adapter = scope.run(() => useArticleWriteInspectorCommands({
        inspector: owner, admin, documentContext, loading, saving, modalActive
    }))!;
    const containers = articleWriteInspectorRegistry.map((view) =>
    {
        const target = document.createElement('section');
        target.tabIndex = -1;
        document.body.append(target);
        owner.registerScrollContainer(view.id, target);
        return target;
    });
    const abortController = new AbortController();
    const dispatch = vi.fn(() => { throw new Error('An inspector command must not mutate source.'); });
    const context: CommandContext = {
        documentIdentity: documentOwner.documentIdentity,
        revision: documentOwner.context.sourceRevision,
        value: source, mode: 'source', readonly: false,
        selection: { start: 0, end: 0, direction: 'none' },
        dispatch: { dispatch }, signal: abortController.signal
    };
    const command = (view = 'check') => adapter.commands.value.find((item) => item.key === `fsusblog.core.inspector.${view}`)!;
    cleanups.push(() => { scope.stop(); containers.forEach((element) => element.remove()); });
    return { owner, adapter, command, admin, documentOwner, documentContext, loading, saving,
        modalActive, context, abortController, dispatch, containers };
}

function deferred()
{
    let resolve: () => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<void>((complete, fail) => { resolve = complete; reject = fail; });
    return { promise, resolve, reject };
}

beforeEach(async () =>
{
    setActivePinia(createPinia());
    await activateLocaleRuntime('zh-CN', ['common', 'admin']);
    await requestLocale('zh-CN', ['common', 'admin']);
});
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

describe('public inspector command projection (#2234, partial development stage)', () =>
{
    it('projects exactly the existing inspector views and invokes their real owner without source mutations', async () =>
    {
        const loadResources = vi.fn();
        const loadVersions = vi.fn();
        const harness = createHarness({ loadView: { resources: loadResources, versions: loadVersions } });
        expect(harness.adapter.commands.value.map((item) => item.key)).toEqual(
            articleWriteInspectorRegistry.map((view) => `fsusblog.core.inspector.${view.id}`)
        );
        for (const [index, view] of articleWriteInspectorRegistry.entries())
        {
            const result = await harness.command(view.id).run(harness.context);
            expect(result).toEqual({ focus: 'none' });
            expect(harness.owner.activeInspector.value).toBe(view.id);
            expect(document.activeElement).toBe(harness.containers[index]);
            expect(harness.adapter.lastReceipt.value?.result).toBe('opened');
            expect(verifyArticleInspectorCommandReceipt(harness.adapter.lastReceipt.value)).toBe(true);
        }
        expect(loadResources).toHaveBeenCalledTimes(1);
        expect(loadVersions).toHaveBeenCalledTimes(1);
        expect(harness.dispatch).not.toHaveBeenCalled();
        expect(harness.command('save')).toBeUndefined();
    });

    it.each(['no-document', 'readonly', 'loading', 'saving', 'modal-active', 'permission', 'step-up'])(
        'rejects current authority state %s before the handler', async (state) =>
        {
            const loader = vi.fn();
            const harness = createHarness({ loadView: { check: loader } });
            let context = harness.context;
            if (state === 'no-document') harness.documentContext.value = null;
            if (state === 'readonly') context = { ...context, readonly: true };
            if (state === 'loading') harness.loading.value = true;
            if (state === 'saving') harness.saving.value = true;
            if (state === 'modal-active') harness.modalActive.value = true;
            if (state === 'permission') harness.admin.clearAdminPrincipal();
            if (state === 'step-up') harness.admin.clearAdminPrincipal('step_up_required');
            expect(harness.command().enabled?.(context)).toBe(false);
            expect(harness.command().disabledReason?.(context)).toBeTruthy();
            await expect(harness.command().run(context)).rejects.toThrow('unavailable');
            expect(loader).not.toHaveBeenCalled();
            expect(harness.owner.activeInspector.value).toBeNull();
        }
    );

    it.each(['id', 'epoch', 'revision', 'content', 'context-digest'])(
        'rejects stale or tampered %s even if the source bytes match', async (fact) =>
        {
            const harness = createHarness();
            let context = harness.context;
            if (fact === 'id') context = { ...context, documentIdentity: { ...context.documentIdentity, id: 'foreign:document' } };
            if (fact === 'epoch') context = { ...context, documentIdentity: { ...context.documentIdentity, epoch: context.documentIdentity.epoch + 1 } };
            if (fact === 'revision') context = { ...context, revision: context.revision + 1 };
            if (fact === 'content') context = { ...context, value: source + 'x' };
            if (fact === 'context-digest') harness.documentContext.value = { ...harness.documentContext.value!, contextDigest: '0'.repeat(64) };
            await expect(harness.command().run(context)).rejects.toThrow('stale-document');
            expect(harness.owner.activeInspector.value).toBeNull();
        }
    );

    it('rejects rapid repeats, cancels immediately and prevents late focus after cancellation', async () =>
    {
        const loading = deferred();
        const loader = vi.fn(() => loading.promise);
        const harness = createHarness({ loadView: { check: loader } });
        const first = harness.command().run(harness.context);
        await nextTick();
        expect(harness.adapter.pending.value).toBe(true);
        await expect(harness.command().run(harness.context)).rejects.toThrow('pending');
        const cancelResult = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        harness.adapter.cancel();
        await cancelResult;
        expect(harness.adapter.pending.value).toBe(false);
        expect(harness.adapter.lastReceipt.value?.result).toBe('canceled');
        loading.resolve();
        await nextTick();
        await nextTick();
        expect(loader).toHaveBeenCalledTimes(1);
        expect(document.activeElement).not.toBe(harness.containers[2]);
        await harness.command().run(harness.context);
        expect(harness.adapter.lastReceipt.value?.result).toBe('opened');
    });

    it.each(['revision', 'permission', 'modal', 'signal', 'dispose'])(
        'drops late completion and focus after pending %s changes', async (state) =>
        {
            const loading = deferred();
            const harness = createHarness({ loadView: { check: () => loading.promise } });
            const first = harness.command().run(harness.context);
            const cancelResult = expect(first).rejects.toMatchObject({ name: 'AbortError' });
            if (state === 'revision') harness.documentContext.value = harness.documentOwner.updateSource(source + ' updated');
            if (state === 'permission') harness.admin.clearAdminPrincipal();
            if (state === 'modal') harness.modalActive.value = true;
            if (state === 'signal') harness.abortController.abort();
            if (state === 'dispose') cleanups.splice(0).forEach((cleanup) => cleanup());
            await cancelResult;
            loading.resolve();
            await nextTick();
            await nextTick();
            expect(document.activeElement).not.toBe(harness.containers[2]);
            expect(harness.adapter.lastReceipt.value?.result).toBe('canceled');
        }
    );

    it('reports an actual loader error and retries through the same inspector owner', async () =>
    {
        let fail = true;
        const loader = vi.fn(() =>
        {
            if (fail) throw new Error('private error text');
        });
        const harness = createHarness({ loadView: { check: loader } });
        await expect(harness.command().run(harness.context)).rejects.toThrow('private error text');
        expect(harness.adapter.lastReceipt.value).toMatchObject({ result: 'failed', reason: 'handler-error' });
        expect(JSON.stringify(harness.adapter.lastReceipt.value)).not.toContain('private error text');
        expect(harness.owner.requestedViews.has('check')).toBe(false);
        fail = false;
        await harness.command().run(harness.context);
        expect(loader).toHaveBeenCalledTimes(2);
    });

    it('requires the owner target to remain active and connected; a fulfilled open alone is insufficient', async () =>
    {
        const harness = createHarness();
        harness.containers[2]!.remove();
        await expect(harness.command().run(harness.context)).rejects.toThrow('not current and focused');
        expect(harness.adapter.lastReceipt.value).toMatchObject({ result: 'rejected', reason: 'target-unavailable' });
    });

    it('verifies closed receipt identity, semantics and content integrity without private data', async () =>
    {
        const harness = createHarness();
        await harness.command().run(harness.context);
        const original = harness.adapter.lastReceipt.value!;
        expect(Object.keys(original).sort()).toEqual(['schema', 'commandId', 'result', 'reason', 'contextDigest', 'durationMs', 'contentDigest'].sort());
        expect(verifyArticleInspectorCommandReceipt({ ...original, contentDigest: '0'.repeat(64) })).toBe(false);
        for (const mutation of [
            { result: 'saved' }, { commandId: 'fsusblog.core.save' }, { durationMs: -1 },
            { contextDigest: null }, { reason: 'permission' }, { extra: 'private data' }
        ])
        {
            const changed = { ...original, ...mutation };
            expect(verifyArticleInspectorCommandReceipt(changed)).toBe(false);
            const { contentDigest: _digest, ...unsigned } = changed;
            expect(verifyArticleInspectorCommandReceipt({ ...unsigned, contentDigest: calculateOpenArticleDocumentDigest(unsigned) })).toBe(false);
        }
    });

    it('renders and executes the projection through the real public FsusUI command palette', async () =>
    {
        const harness = createHarness();
        const wrapper = mount(ElMarkdownEditor, {
            attachTo: document.body,
            props: { modelValue: source, mode: 'source', documentIdentity: harness.context.documentIdentity,
                commands: harness.adapter.commands.value, surfaces: { commandPalette: true } }
        });
        cleanups.push(() => wrapper.unmount());
        (wrapper.vm as unknown as { openCommandPalette(): void; }).openCommandPalette();
        await nextTick();
        const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
        expect(options).toHaveLength(articleWriteInspectorRegistry.length);
        expect(options.map((option) => option.textContent?.trim())).toContain('内容检查');
        expect(document.querySelector('[role="combobox"]')).not.toBeNull();
        expect(document.querySelector('[role="listbox"]')).not.toBeNull();
        options.find((option) => option.textContent?.trim() === '内容检查')!.click();
        await vi.waitFor(() => expect(harness.owner.activeInspector.value).toBe('check'));
        await vi.waitFor(() => expect(harness.adapter.lastReceipt.value?.result).toBe('opened'));
        expect(document.activeElement).toBe(harness.containers[2]);
        expect(harness.dispatch).not.toHaveBeenCalled();
    });

    it('uses the existing locale runtime without introducing locale-specific command identities', async () =>
    {
        const harness = createHarness();
        const keys = harness.adapter.commands.value.map((item) => item.key);
        await requestLocale('en-US', ['common', 'admin']);
        expect(harness.command().label).toBe('Content inspection');
        expect(harness.adapter.commands.value.map((item) => item.key)).toEqual(keys);
        harness.modalActive.value = true;
        expect(harness.command().disabledReason?.(harness.context)).toBe('Close the current dialog first');
    });
});
