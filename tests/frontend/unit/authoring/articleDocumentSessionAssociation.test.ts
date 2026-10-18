import { describe, expect, it } from 'vitest';

import * as documents from '@/services/authoring/articleDocumentContext';
import { OpenArticleDocumentRegistry, openArticleDocumentCommandSchema } from '@/services/authoring/openArticleDocumentRegistry';

function fixture()
{
    const authority = new documents.ArticleDocumentContextAuthority();
    const registry = new OpenArticleDocumentRegistry();
    let principal = '41';
    const scope = { readPrincipalIdentityId: () => principal, readSiteScope: () => 'site:test' };
    const prepared = authority.prepareRetainedDocument(registry, {
        articleId: 1, siteScope: 'site:test', userScope: 'user:41', content: '# source'
    }, scope);
    const context = prepared.context;
    const command = { schema: openArticleDocumentCommandSchema, kind: 'open-or-activate' as const,
        commandId: 'association:open', idempotencyKey: 'association:open', expectedRevision: registry.getRevision(),
        intent: 'workspace' as const, entrypoint: 'direct-route' as const,
        identity: { articleId: context.articleId, draftId: context.draftId, documentId: context.documentId },
        documentContext: { documentEpoch: context.documentEpoch, sourceRevision: `source-revision:${context.sourceRevision}`, draftRevision: context.draftRevision },
        editorSessionRef: 'session:registry-issued', tabId: 'tab:association', targetGroupId: 'group:main', tabKind: 'pinned' as const,
        status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false,
            permission: 'allowed' as const, lifecycle: 'current' as const, statusRef: 'status:current' }, lastActiveAnchorRef: null };
    expect(registry.openOrActivate(command).status).toBe('applied');
    const retained = authority.acquireRetainedDocument(registry.issueRetainedDocumentHandle(command.tabId), prepared);
    return { authority, registry, retained, command, scope, driftScope: () => { principal = '42'; } };
}

describe('original Document/Registry editor session association', () =>
{
    it('issues the exact relation for genuinely distinct session IDs and reuses its original token', () =>
    {
        const f = fixture();
        const association = f.authority.issueEditorSessionAssociation(f.retained);
        expect(association).not.toBeNull();
        expect(f.authority.issueEditorSessionAssociation(f.retained)).toBe(association);
        const observed = documents.inspectArticleDocumentEditorSessionAssociation(association!, f.retained.adapter);
        expect(observed?.documentEditorSessionId).toMatch(/^editor-session:/u);
        expect(observed?.registryEditorSessionRef).toBe('session:registry-issued');
        expect(observed?.documentEditorSessionId).not.toBe(observed?.registryEditorSessionRef);
        expect(observed?.registry).toBe(f.registry);
        expect(observed?.handle).toBe(f.retained.handle);
        expect(observed?.document).toBe(f.retained.adapter.context);
    });

    it('refuses copied bindings/tokens, foreign authorities and matching-string standalone adapters', () =>
    {
        const f = fixture();
        expect(f.authority.issueEditorSessionAssociation({ ...f.retained })).toBeNull();
        expect(new documents.ArticleDocumentContextAuthority().issueEditorSessionAssociation(f.retained)).toBeNull();
        const association = f.authority.issueEditorSessionAssociation(f.retained)!;
        expect(documents.inspectArticleDocumentEditorSessionAssociation({ ...association }, f.retained.adapter)).toBeNull();
        const context = f.retained.adapter.context;
        const standalone = documents.createArticleDocumentContextAdapter({ ...context, content: '# source' });
        expect(documents.inspectArticleDocumentEditorSessionAssociation(association, standalone)).toBeNull();
    });

    it('does not infer a relation for an unretained original primary', () =>
    {
        const f = fixture();
        const primary = new documents.ArticleDocumentContextAuthority().acquire({ articleId: 1,
            siteScope: 'site:test', userScope: 'user:41', content: '# source' });
        expect(documents.inspectArticleDocumentEditorSessionAssociation({} as documents.ArticleDocumentEditorSessionAssociation, primary.adapter)).toBeNull();
        expect(f.authority.issueEditorSessionAssociation(primary as unknown as documents.ArticleDocumentRetainedBinding)).toBeNull();
    });

    it('keeps numeric source revisions distinct from Registry references', () =>
    {
        const f = fixture();
        const association = f.authority.issueEditorSessionAssociation(f.retained)!;
        f.retained.adapter.updateSource('# changed', 47);
        const observed = documents.inspectArticleDocumentEditorSessionAssociation(association, f.retained.adapter);
        expect(observed?.document.sourceRevision).toBe(47);
        expect(observed?.entry.documentContext.sourceRevision).toBe('source-revision:0');
        expect(observed?.documentEditorSessionId).toBe(f.retained.adapter.context.editorSessionId);
    });

    it.each(['scope-retirement', 'scope-reader-drift', 'final-close'] as const)('invalidates after %s without same-ID resurrection', kind =>
    {
        const f = fixture();
        const association = f.authority.issueEditorSessionAssociation(f.retained)!;
        if (kind === 'scope-retirement') f.authority.revokeRetainedScope('site:test', '41');
        if (kind === 'scope-reader-drift') f.driftScope();
        if (kind === 'final-close')
        {
            f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'request-close', tabId: f.command.tabId,
                commandId: 'association:close', idempotencyKey: 'association:close', expectedRevision: f.registry.getRevision() });
            f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'detach-on-final-close', tabId: f.command.tabId,
                commandId: 'association:detach', idempotencyKey: 'association:detach', expectedRevision: f.registry.getRevision(), closeDecisionRef: 'association:decision' });
            f.registry.openOrActivate({ ...f.command, commandId: 'association:reopen', idempotencyKey: 'association:reopen', expectedRevision: f.registry.getRevision() });
        }
        expect(documents.inspectArticleDocumentEditorSessionAssociation(association, f.retained.adapter)).toBeNull();
        expect(f.authority.issueEditorSessionAssociation(f.retained)).toBeNull();
    });
});
