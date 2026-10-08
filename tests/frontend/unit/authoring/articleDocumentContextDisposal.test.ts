import { describe, expect, it } from 'vitest';

import { createArticleDocumentContextAdapter, validateArticleDocumentContext } from '@/services/authoring/articleDocumentContext';

const open = () => createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
    editorSessionId: 'session:disposal-verifier', siteScope: 'site:test', userScope: 'user:test', content: '# shared source' });

describe('canonical document current-context disposal admission', () =>
{
    it('admits an active current snapshot and refuses another same-byte document', () =>
    {
        const owner = open();
        const other = open();
        try
        {
            expect(owner.context.contentDigest).toBe(other.context.contentDigest);
            expect(owner.context.documentId).not.toBe(other.context.documentId);
            expect(owner.isCurrentContext(owner.context)).toBe(true);
            expect(owner.isCurrentContext(structuredClone(owner.context))).toBe(true);
            expect(owner.isCurrentContext(other.context)).toBe(false);
            expect(other.isCurrentContext(other.context)).toBe(true);
        }
        finally
        {
            owner.dispose();
            other.dispose();
        }
    });

    it('admits only the current revision while the owner is active', () =>
    {
        const owner = open();
        const before = owner.context;
        owner.updateSource('changed source');
        expect(owner.isCurrentContext(before)).toBe(false);
        expect(owner.isCurrentContext(owner.context)).toBe(true);
        owner.dispose();
    });

    it('keeps historical context readable while denying disposed admission and preserving another active owner', () =>
    {
        const owner = open();
        const other = open();
        const snapshot = owner.context;
        const receipt = owner.dispose();
        expect(receipt?.action).toBe('dispose');
        expect(owner.context).toEqual(snapshot);
        expect(validateArticleDocumentContext(snapshot)).toBe(true);
        expect(owner.isCurrentContext(snapshot)).toBe(false);
        expect(owner.isCurrentContext(structuredClone(snapshot))).toBe(false);
        expect(owner.dispose()).toBeNull();
        expect(owner.isCurrentContext(owner.context)).toBe(false);
        expect(other.isCurrentContext(other.context)).toBe(true);
        other.dispose();
    });
});
