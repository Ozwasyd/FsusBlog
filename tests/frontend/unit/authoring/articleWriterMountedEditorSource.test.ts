// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { ElMarkdownEditor } from '@ozwasyd/element-plus';
import { afterEach, describe, expect, it } from 'vitest';

import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import type { ArticleEditorMountedSessionPort } from '@/services/authoring/articleEditorContinuity';
import { createArticleWriterMountedEditorSource, projectArticleWriterWorkspaceDocument } from '@/services/authoring/articleWriterMountedEditorSource';
import { OpenArticleDocumentRegistry, openArticleDocumentCommandSchema } from '@/services/authoring/openArticleDocumentRegistry';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

function open()
{
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1', editorSessionId: 'session:writer-owner',
        siteScope: 'site:test', userScope: 'user:test', content: 'paragraph' });
    const registry = new OpenArticleDocumentRegistry();
    const document = projectArticleWriterWorkspaceDocument(owner.context);
    registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'open-or-activate', commandId: 'command:mount',
        idempotencyKey: 'idempotency:mount', expectedRevision: registry.getRevision(), intent: 'workspace', entrypoint: 'direct-route',
        ...document, editorSessionRef: 'session:workspace', tabId: 'tab:workspace', targetGroupId: 'group:primary', tabKind: 'pinned',
        status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false,
            permission: 'allowed', lifecycle: 'current', statusRef: 'status:workspace' }, lastActiveAnchorRef: null });
    expect(registry.getEntry('tab:workspace')).not.toBeNull();
    const wrapper = mount(ElMarkdownEditor, { props: { modelValue: 'paragraph', mode: 'source', documentIdentity: owner.documentIdentity } });
    const editor = wrapper.vm as unknown as ArticleEditorMountedSessionPort;
    let active = true;
    let mounted: ArticleEditorMountedSessionPort | null = editor;
    let reads = 0;
    const source = createArticleWriterMountedEditorSource(owner, registry, editor, () => { reads += 1; return mounted; }, () => active);
    cleanups.push(() => { active = false; wrapper.unmount(); owner.dispose(); });
    return { owner, registry, editor, source, reads: () => reads, release: () => { active = false; },
        replace: (replacement: ArticleEditorMountedSessionPort | null) => { mounted = replacement; } };
}

describe('original Writer mounted instance and document source', () =>
{
    it('reads the actual document owner before any edit or snapshot without deriving a route identity', () => {
        const f = open();
        expect(f.source.readMountedEditor('session:workspace')).toBe(f.editor);
        expect(f.source.readDocumentBinding('session:workspace')).toEqual(projectArticleWriterWorkspaceDocument(f.owner.context));
        expect(f.editor.getSession('session:workspace').inspectDocumentState()).toEqual({ documentIdentity: f.owner.documentIdentity, revision: 0 });
    });

    it('refuses an unassociated session before invoking the mounted reader', () => {
        const f = open();
        expect(f.source.readMountedEditor('session:other')).toBeNull();
        expect(f.source.readDocumentBinding('session:other')).toBeNull();
        expect(f.reads()).toBe(0);
    });

    it('stops reads after the original binding release', () => {
        const f = open();
        f.release();
        expect(f.source.readMountedEditor('session:workspace')).toBeNull();
        expect(f.source.readDocumentBinding('session:workspace')).toBeNull();
        expect(f.reads()).toBe(0);
    });

    it('refuses missing or replaced mounted objects without forwarding their public methods', () => {
        const f = open();
        f.replace(null);
        expect(f.source.readDocumentBinding('session:workspace')).toBeNull();
        f.replace({ getSession: ref => f.editor.getSession(ref), dispatchTransaction: transaction => f.editor.dispatchTransaction(transaction) });
        expect(f.source.readMountedEditor('session:workspace')).toBeNull();
        expect(f.source.readDocumentBinding('session:workspace')).toBeNull();
    });

    it('refuses actual native revision drift until the original source owner consumes that revision', () => {
        const f = open();
        const result = f.editor.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'X' }], history: 'separate',
            documentIdentity: f.owner.documentIdentity, expectedRevision: f.owner.context.sourceRevision });
        expect(result.accepted).toBe(true);
        expect(f.source.readDocumentBinding('session:workspace')).toBeNull();
        f.owner.updateSource(result.value, result.revision);
        expect(f.source.readDocumentBinding('session:workspace')?.documentContext.sourceRevision).toBe(`source-revision:${result.revision}`);
    });

    it('refuses the old workspace association after a same-byte document switch', () => {
        const f = open();
        f.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: 'paragraph' });
        expect(f.source.readMountedEditor('session:workspace')).toBeNull();
        expect(f.source.readDocumentBinding('session:workspace')).toBeNull();
        expect(f.reads()).toBe(0);
    });
});
