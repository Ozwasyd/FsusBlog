// @vitest-environment happy-dom
import { ElMarkdownEditor } from '@ozwasyd/element-plus';
import type { MarkdownEditorInstance } from '@ozwasyd/element-plus';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, onUnmounted, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthoringWorkspaceNavigationHost } from '@/services/authoring/authoringWorkspaceNavigationHost';
import { createArticleWriterMountedEditorSource } from '@/services/authoring/articleWriterMountedEditorSource';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import { privateSurfaceRuntime } from '@/services/privateSurfaceRuntime';
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { ArticleDocumentContextAuthority, inspectArticleDocumentEditorSessionAssociation } from '@/services/authoring/articleDocumentContext';
import { OpenArticleDocumentRegistry, openArticleDocumentCommandSchema } from '@/services/authoring/openArticleDocumentRegistry';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));
const input = { articleId: 1, siteScope: 'primary-site', userScope: 'user:41', content: '# Loaded\n\nreal primary\n' };
let principal = '41';
const scope = { readPrincipalIdentityId: () => principal, readSiteScope: () => 'primary-site' };
beforeEach(() => { principal = '41'; privateRequestRuntime.resetForTests(); privateSurfaceRuntime.resetForTests(); });
async function fixture(canonical = false)
{
    const authority = new ArticleDocumentContextAuthority();
    // This is the same original acquire path as useAdminArticleWrite's private primary. The host only receives adapter/anchors.
    const primary = authority.acquire(input);
    const anchors = new ArticleAnchorContextAdapter(primary.adapter);
    const registry = new OpenArticleDocumentRegistry();
    const target = canonical ? new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input, scope).context : primary.adapter.context;
    expect(registry.openOrActivate({ schema: openArticleDocumentCommandSchema, kind: 'open-or-activate',
        commandId: 'open:primary', idempotencyKey: 'open:primary', expectedRevision: registry.getRevision(), intent: 'workspace', entrypoint: 'direct-route',
        identity: { articleId: target.articleId, draftId: target.draftId, documentId: target.documentId },
        documentContext: { documentEpoch: target.documentEpoch, sourceRevision: `source-revision:${target.sourceRevision}`, draftRevision: target.draftRevision },
        editorSessionRef: 'native:primary', tabId: 'tab:primary', targetGroupId: 'group:primary', tabKind: 'pinned', lastActiveAnchorRef: null,
        status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false,
            permission: 'allowed', lifecycle: 'current', statusRef: 'status:current' } }).status).toBe('applied');
    const entry = registry.getEntry('tab:primary')!;
    const controller = new AbortController();
    const identity = ref(primary.adapter.documentIdentity);
    const source = ref(input.content);
    const native = ref<MarkdownEditorInstance>();
    const wrapper = mount(defineComponent({ setup()
    {
        onUnmounted(() => controller.abort());
        return () => h(ElMarkdownEditor, { ref: native, modelValue: source.value, mode: 'source', documentIdentity: identity.value,
            'onUpdate:modelValue': (value: string) => { source.value = value; } });
    } }), { attachTo: document.body });
    cleanups.push(() => { wrapper.unmount(); anchors.dispose(); primary.release(); });
    await nextTick();
    const editor = native.value;
    if (!editor) throw new Error('actual-mounted-editor-missing');
    let actual = editor;
    let currentGeneration = 1;
    const originalGeneration = currentGeneration;
    let refresh = async () => { identity.value = primary.adapter.documentIdentity; await nextTick(); };
    const mountedSource = createArticleWriterMountedEditorSource(primary.adapter, registry, editor, () => actual,
        () => currentGeneration === originalGeneration);
    const admission = vi.spyOn(anchors, 'admitCurrentPrimaryRetainedDocument');
    const host = createAuthoringWorkspaceNavigationHost({ authority, document: primary.adapter, anchors, registry, mountedSource,
        scope, signal: controller.signal, isCurrent: () => currentGeneration === originalGeneration,
        readNative: () => actual, refreshNativeIdentity: () => refresh(), viewOwner: null });
    cleanups.push(() => host.dispose());
    return { authority, primary, anchors, registry, entry, controller, target, editor, wrapper, host, admission,
        mountedSource, identity, source, retire: () => { currentGeneration += 1; },
        setNative: (value: typeof editor) => { actual = value; },
        setRefresh: (value: typeof refresh) => { refresh = value; } };
}

function request(): AbortSignal { return new AbortController().signal; }

describe('actual retained workspace host hookup with navigation refused', () =>
{
    it.each([false, true])('borrows the actual original primary/Anchor/native, canonical=%s', async canonical =>
    {
        const f = await fixture(canonical);
        const nativeSession = f.editor.getSession(f.entry.editorSessionRef);
        const loan = await f.host.prepare(f.entry, request());
        expect(loan).not.toBeNull();
        expect(loan!.binding.adapter).toBe(f.primary.adapter);
        expect(loan!.anchors).toBe(f.anchors);
        expect(loan!.isCurrent()).toBe(true);
        const association = inspectArticleDocumentEditorSessionAssociation(loan!.association, f.primary.adapter);
        expect(association?.registry).toBe(f.registry);
        expect(association?.handle).toBe(loan!.binding.handle);
        expect(association?.documentEditorSessionId).not.toBe(association?.registryEditorSessionRef);
        expect(f.editor.getSession(f.entry.editorSessionRef)).toBe(nativeSession);
        expect(f.mountedSource.readMountedEditor(f.entry.editorSessionRef)).toBe(f.editor);
        expect(f.mountedSource.readDocumentBinding(f.entry.editorSessionRef)?.identity.documentId).toBe(f.target.documentId);
        expect(await f.host.prepare(f.registry.getEntry(f.entry.tabId)!, request())).toBe(loan);
        expect(f.admission).toHaveBeenCalledTimes(1);
    });

    it('refuses mounted navigation without a complete original capture/viewport owner', async () =>
    {
        const f = await fixture();
        const loan = await f.host.prepare(f.entry, request());
        expect(loan).not.toBeNull();
        const reveal = vi.spyOn(f.editor, 'revealSourceRangeAndWait');
        const focus = document.activeElement;
        expect(await f.host.wait(f.entry, request())).toBeNull();
        expect(f.host.current(f.entry)).toBeNull();
        expect(reveal).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(focus);
        expect(loan!.isCurrent()).toBe(true);
    });

    it('refuses canonical publication before the actual native identity is refreshed', async () =>
    {
        const f = await fixture(true);
        f.setRefresh(async () => { await nextTick(); });
        expect(await f.host.prepare(f.entry, request())).toBeNull();
        const actual = f.admission.mock.results[0]!.value;
        expect(actual.signal.aborted).toBe(true);
        expect(actual.isCurrent()).toBe(false);
        expect(f.editor.getSession(f.entry.editorSessionRef).inspectDocumentState().documentIdentity.id).not.toBe(f.target.documentId);
    });

    it.each(['entry', 'scope', 'generation', 'disposed'])('refuses missing current %s facts', async kind =>
    {
        const f = await fixture();
        if (kind === 'scope') principal = '42';
        if (kind === 'generation') f.retire();
        if (kind === 'disposed') f.host.dispose();
        const entry = kind === 'entry' ? { ...f.entry, editorSessionRef: 'session:foreign' } : f.entry;
        expect(await f.host.prepare(entry, request())).toBeNull();
        expect(f.host.current(entry)).toBeNull();
    });

    it.each(['request', 'lifetime', 'generation', 'scope', 'registry'])('refuses %s drift across native identity await', async kind =>
    {
        const f = await fixture();
        const caller = new AbortController();
        let resume: (() => void) | undefined;
        f.setRefresh(() => new Promise<void>(resolve => { resume = resolve; }));
        const pending = f.host.prepare(f.entry, caller.signal);
        await vi.waitFor(() => expect(resume).toBeTypeOf('function'));
        const loan = f.admission.mock.results[0]!.value;
        if (kind === 'request') caller.abort();
        if (kind === 'lifetime') f.controller.abort();
        if (kind === 'generation') f.retire();
        if (kind === 'scope') principal = '42';
        if (kind === 'registry') f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'activate',
            commandId: 'activate:changed', idempotencyKey: 'activate:changed', expectedRevision: f.registry.getRevision(),
            tabId: f.entry.tabId, lastActiveAnchorRef: null });
        resume!();
        expect(await pending).toBeNull();
        expect(loan.signal.aborted).toBe(true);
        expect(loan.isCurrent()).toBe(false);
        expect(f.host.current(f.entry)).toBeNull();
    });

    it.each(['request', 'auth', 'unmount', 'dispose'])('retires on original %s while preserving unrelated retained work', async kind =>
    {
        const f = await fixture();
        const loan = await f.host.prepare(f.entry, request());
        expect(loan).not.toBeNull();
        const work = f.primary.adapter.beginTask('attachment', 'original:pending-work');
        if (kind === 'request') privateRequestRuntime.advance('admin');
        if (kind === 'auth') await privateSurfaceRuntime.invalidate('account-switch', () => undefined);
        if (kind === 'unmount') f.wrapper.unmount();
        if (kind === 'dispose') f.host.dispose();
        expect(loan!.signal.aborted).toBe(true);
        expect(loan!.isCurrent()).toBe(false);
        expect(loan!.binding.inspect().pendingTaskRefs).toContain(work.taskRef);
        expect(work.signal.aborted).toBe(false);
        work.cancel('original-work-stopped'); work.settle();
    });
    it('refuses a same-ID replacement of the actual raw mounted object', async () =>
    {
        const f = await fixture();
        const loan = await f.host.prepare(f.entry, request());
        expect(loan).not.toBeNull();
        const other = await fixture();
        f.setNative(other.editor);
        expect(await f.host.prepare(f.entry, request())).toBeNull();
        expect(loan!.signal.aborted).toBe(true);
        f.setNative(f.editor);
        expect(await f.host.prepare(f.entry, request())).toBeNull();
    });
    it('refuses absent view ownership before attempting any new admission', async () =>
    {
        const f = await fixture();
        expect(await f.host.wait(f.entry, request())).toBeNull();
        expect(f.admission).not.toHaveBeenCalled();
        expect(await f.host.prepare(f.entry, request())).not.toBeNull();
    });

    it('does not retire the genuine owner for an already canceled unrelated borrower', async () =>
    {
        const f = await fixture();
        const loan = await f.host.prepare(f.entry, request());
        expect(loan).not.toBeNull();
        const canceled = new AbortController(); canceled.abort();
        await expect(f.host.prepare(f.entry, canceled.signal)).rejects.toThrow();
        expect(loan!.isCurrent()).toBe(true);
        expect(loan!.signal.aborted).toBe(false);
    });
});

function deferredRefresh()
{
    let resume: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { resume = resolve; });
    return { ready, resume: () => resume!() };
}

describe('pending canonical preparation review5562314613 controls', () =>
{
    it.each(['same-entry', 'foreign-entry', 'already-canceled'])('preserves the first genuine loan for %s repeat', async kind =>
    {
        const f = await fixture(true);
        const gate = deferredRefresh();
        f.setRefresh(async () =>
        {
            await gate.ready;
            f.identity.value = f.primary.adapter.documentIdentity;
            await nextTick();
        });
        const first = f.host.prepare(f.entry, request());
        const issued = f.admission.mock.results[0]!.value;
        expect(issued.isCurrent()).toBe(true);
        expect(f.editor.getSession(f.entry.editorSessionRef).inspectDocumentState().documentIdentity.id).not.toBe(f.target.documentId);
        const second = new AbortController();
        if (kind === 'already-canceled') second.abort();
        const entry = kind === 'foreign-entry' ? { ...f.entry, editorSessionRef: 'session:unrelated' } : f.entry;
        const repeated = f.host.prepare(entry, second.signal);
        if (kind === 'already-canceled') await expect(repeated).rejects.toThrow();
        else expect(await repeated).toBeNull();
        // Always finish the original refresh so RED also records its actual result.
        gate.resume();
        const loan = await first;
        expect(loan).toBe(issued);
        expect(issued.signal.aborted).toBe(false);
        expect(issued.isCurrent()).toBe(true);
        expect(f.admission).toHaveBeenCalledTimes(1);
        expect(await f.host.prepare(f.entry, request())).toBe(issued);
    });

    it('retains real pending work on normal release', async () =>
    {
        const f = await fixture();
        const loan = await f.host.prepare(f.entry, request());
        expect(loan).not.toBeNull();
        const work = f.primary.adapter.beginTask('attachment', 'original:review-pending');
        f.host.dispose();
        expect(loan!.signal.aborted).toBe(true);
        expect(work.signal.aborted).toBe(false);
        expect(loan!.binding.inspect().pendingTaskRefs).toContain(work.taskRef);
        work.cancel('original-review-work-stopped'); work.settle();
    });

    it('keeps repeated fresh original mounts and their associations isolated', async () =>
    {
        const first = await fixture();
        const original = await first.host.prepare(first.entry, request());
        expect(original).not.toBeNull();
        first.host.dispose();
        const next = await fixture(true);
        const current = await next.host.prepare(next.entry, request());
        expect(current).not.toBeNull();
        expect(current!.association).not.toBe(original!.association);
        expect(current!.binding.adapter).not.toBe(original!.binding.adapter);
        expect(current!.isCurrent()).toBe(true);
    });
});

describe('bounded overlapping preparation lifecycle', () =>
{
    it.each(['success', 'failure', 'caller-cancel', 'release', 'unmount', 'scope', 'registry', 'generation'])(
        'isolates repeated borrowers across original refresh %s', async outcome =>
        {
            const f = await fixture(true);
            const gate = deferredRefresh();
            f.setRefresh(async () =>
            {
                await gate.ready;
                if (outcome === 'failure') throw new Error('original native refresh failed');
                f.identity.value = f.primary.adapter.documentIdentity;
                await nextTick();
            });
            const caller = new AbortController();
            const first = f.host.prepare(f.entry, caller.signal);
            const issued = f.admission.mock.results[0]!.value;
            const work = f.primary.adapter.beginTask('attachment', 'original:overlap-work');
            const mountedReads = vi.spyOn(f.mountedSource, 'readDocumentBinding');
            mountedReads.mockClear();
            const other = new AbortController();
            expect(await f.host.prepare(f.entry, other.signal)).toBeNull();
            expect(await f.host.prepare({ ...f.entry, editorSessionRef: 'session:unrelated' }, request())).toBeNull();
            expect(await f.host.prepare(f.entry, request())).toBeNull();
            expect(mountedReads).not.toHaveBeenCalled();
            other.abort();
            expect(issued.signal.aborted).toBe(false);
            expect(f.admission).toHaveBeenCalledTimes(1);
            if (outcome === 'caller-cancel') caller.abort();
            if (outcome === 'release') f.host.dispose();
            if (outcome === 'unmount') f.wrapper.unmount();
            if (outcome === 'scope') principal = '42';
            if (outcome === 'generation') f.retire();
            if (outcome === 'registry') f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'activate',
                commandId: 'activate:overlap', idempotencyKey: 'activate:overlap', expectedRevision: f.registry.getRevision(),
                tabId: f.entry.tabId, lastActiveAnchorRef: null });
            gate.resume();
            const result = await first;
            expect(issued.binding.inspect().pendingTaskRefs).toContain(work.taskRef);
            if (outcome === 'success')
            {
                expect(result).toBe(issued);
                expect(issued.signal.aborted).toBe(false);
                expect(await f.host.prepare(f.entry, request())).toBe(issued);
                expect(f.admission).toHaveBeenCalledTimes(1);
            }
            else
            {
                expect(result).toBeNull();
                expect(issued.signal.aborted).toBe(true);
                expect(issued.isCurrent()).toBe(false);
                expect(await f.host.prepare(f.registry.getEntry(f.entry.tabId)!, request())).toBeNull();
            }
            work.cancel('original-overlap-work-stopped'); work.settle();
            if (outcome !== 'success')
            {
                // Retirement is terminal for the old issuer. Recovery borrows a
                // fresh genuine original mount, never the retired same-ID loan.
                principal = '41';
                const fresh = await fixture(true);
                const recovered = await fresh.host.prepare(fresh.entry, request());
                expect(recovered).not.toBeNull();
                expect(recovered!.isCurrent()).toBe(true);
                expect(recovered!.association).not.toBe(issued.association);
            }
        }
    );

    it('recovers from an unavailable entry before original admission', async () =>
    {
        const f = await fixture(true);
        expect(await f.host.prepare({ ...f.entry, editorSessionRef: 'session:unknown' }, request())).toBeNull();
        expect(f.admission).not.toHaveBeenCalled();
        const loan = await f.host.prepare(f.entry, request());
        expect(loan).not.toBeNull();
        expect(loan!.isCurrent()).toBe(true);
        expect(f.admission).toHaveBeenCalledTimes(1);
    });
});
