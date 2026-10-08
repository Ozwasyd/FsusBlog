// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ArticleRevisionResponsibilitySnapshotResponse } from '@/api/authoring';
import ArticleResponsibilityDisclosure from '@/components/article/ArticleResponsibilityDisclosure.vue';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { createArticleDraftResponsibilitySnapshot, bindArticleDraftResponsibilitySnapshot, admitArticleDraftResponsibilitySnapshot,
    verifyArticleDraftResponsibilitySnapshot, type ArticleDraftResponsibilitySource } from '@/view-contracts/articleDraftResponsibility';

const owner = (articleId: number | null = 42) => createArticleDocumentContextAdapter({ articleId,
    draftId: articleId === null ? 'draft:new' : `article:${articleId}`, editorSessionId: 'session:responsibility',
    siteScope: 'site:responsibility', userScope: 'user:responsibility', content: 'same source' });
const source = (): ArticleDraftResponsibilitySource => ({ inheritSiteAuthor: false,
    authors: [{ name: ' Draft author ', profileUrl: 'https://example.test/author' }],
    reviewer: { name: 'Draft reviewer', profileUrl: null }, sources: [
        { title: 'Public evidence', url: 'https://example.test/evidence', sourceType: 'primary', accessedOn: null, version: null, citationNote: null },
        { title: 'Private evidence', url: 'https://example.test/private', sourceType: 'private', accessedOn: null, version: null, citationNote: null, isPublic: false }
    ], updateSummary: 'Draft change', updateReason: 'New evidence', effectiveAt: null,
    conclusionImpact: 'changed', responsiblePersonConfirmed: true });
const draft = (adapter = owner(), input: ArticleDraftResponsibilitySource | null = source()) => bindArticleDraftResponsibilitySnapshot(
    adapter.context, input, 'Site author', createArticleDraftResponsibilitySnapshot(adapter.context, input, 'Site author'));
afterEach(() => vi.unstubAllGlobals());

describe('draft responsibility public composition (#2283)', () => {
    it.each([null, 42])('renders a %s draft snapshot without requesting published responsibility or inventing proof coordinates', async articleId => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const value = draft(owner(articleId));
        const wrapper = mount(ArticleResponsibilityDisclosure, { props: { articleId,
            fallbackAuthor: 'Published fallback', draftResponsibility: value } });
        await flushPromises();
        expect(fetch).not.toHaveBeenCalled();
        expect(wrapper.text()).toContain('Draft author');
        expect(wrapper.text()).toContain('Draft reviewer');
        expect(wrapper.text()).toContain('Draft change');
        expect(wrapper.text()).not.toContain('Private evidence');
        expect(wrapper.text()).not.toContain('Published fallback');
        expect(wrapper.find('[data-article-verification-link]').exists()).toBe(false);
        expect(wrapper.get('[data-proof-status]').attributes('data-proof-status')).toBe('not-published');
        expect(wrapper.attributes('data-manifest-state')).toBe('ready');
        expect(Object.hasOwn(value.snapshot, 'articleId')).toBe(false);
        expect(Object.hasOwn(value.snapshot, 'verification')).toBe(false);
    });

    it('isolates an abort-ignoring public response after switching to draft and releases its signal on unmount', async () => {
        let resolve!: (value: unknown) => void;
        const fetch = vi.fn().mockImplementation(() => new Promise(value => { resolve = value; }));
        vi.stubGlobal('fetch', fetch);
        const wrapper = mount(ArticleResponsibilityDisclosure, { props: { articleId: 42, fallbackAuthor: 'Public author' } });
        const signal = fetch.mock.calls[0][1].signal as AbortSignal;
        await wrapper.setProps({ draftResponsibility: draft() });
        expect(signal.aborted).toBe(true);
        resolve({ ok: true, json: async () => ({ articleId: 42, revisionNo: 1,
            authors: [{ name: 'Late published author', profileUrl: null }], reviewer: null, sources: [], update: null,
            verification: { url: '/integrity/article/42', proofStatus: 'ready' } }) });
        await flushPromises();
        expect(wrapper.text()).toContain('Draft author');
        expect(wrapper.text()).not.toContain('Late published author');
        await wrapper.setProps({ draftResponsibility: undefined });
        expect(fetch).toHaveBeenCalledTimes(2);
        const resumedSignal = fetch.mock.calls[1][1].signal as AbortSignal;
        wrapper.unmount();
        expect(resumedSignal.aborted).toBe(true);
    });

    it('updates only from current draft props and rejects same-source different-document, stale revision, serialized and tampered projections', async () => {
        const adapter = owner();
        const value = draft(adapter);
        const wrapper = mount(ArticleResponsibilityDisclosure, { props: { articleId: 42,
            fallbackAuthor: 'Published author', draftResponsibility: value } });
        expect(admitArticleDraftResponsibilitySnapshot(value)).toBe(true);
        expect(verifyArticleDraftResponsibilitySnapshot(value.snapshot, adapter.context, source(), 'Site author')).toBe(true);
        const tampered = { ...value.snapshot, authors: [{ name: 'Tampered', profileUrl: null }] };
        expect(verifyArticleDraftResponsibilitySnapshot(tampered, adapter.context, source(), 'Site author')).toBe(false);
        expect(admitArticleDraftResponsibilitySnapshot({ ...value, snapshot: { ...value.snapshot } })).toBe(false);
        expect(admitArticleDraftResponsibilitySnapshot({ ...value, context: owner(43).context })).toBe(false);
        const metadataEdit = { ...source(), updateSummary: 'New metadata, same source' };
        expect(admitArticleDraftResponsibilitySnapshot(bindArticleDraftResponsibilitySnapshot(
            adapter.context, metadataEdit, 'Site author', value.snapshot))).toBe(false);
        expect(admitArticleDraftResponsibilitySnapshot(bindArticleDraftResponsibilitySnapshot(
            adapter.context, source(), 'New site author', value.snapshot))).toBe(false);
        adapter.updateSource('same source', adapter.context.sourceRevision + 1);
        expect(admitArticleDraftResponsibilitySnapshot({ ...value, context: adapter.context })).toBe(false);
        await wrapper.setProps({ draftResponsibility: { ...value, context: adapter.context } });
        expect(wrapper.attributes('data-manifest-state')).toBe('invalid');
        expect(wrapper.text()).not.toContain('Draft author');
        expect(wrapper.text()).not.toContain('Published author');
        const changed = source();
        changed.authors = [{ name: 'Current draft author', profileUrl: null }];
        await wrapper.setProps({ draftResponsibility: draft(adapter, changed) });
        expect(wrapper.text()).toContain('Current draft author');
    });

    it('copies immutable public fields and keeps missing/unconfirmed authors honest', () => {
        const adapter = owner(null);
        const input = source();
        const snapshot = draft(adapter, input).snapshot;
        input.authors[0].name = 'Edited later';
        input.sources[0].title = 'Edited later';
        expect(snapshot.authors[0].name).toBe('Draft author');
        expect(snapshot.sources[0].title).toBe('Public evidence');
        expect(Object.isFrozen(snapshot.authors[0])).toBe(true);
        expect(Object.isFrozen(snapshot.sources)).toBe(true);
        expect(draft(adapter, null).snapshot.status).toBe('missing');
        const incomplete = { ...source(), authors: [], responsiblePersonConfirmed: false };
        const current = draft(adapter, incomplete).snapshot;
        expect(current.status).toBe('incomplete');
        expect(current.authors).toEqual([]);
        expect(current.reasons).toContain('responsibility-person-unconfirmed');
        expect(draft(adapter, { ...incomplete, inheritSiteAuthor: true }).snapshot.authors[0].name).toBe('Site author');
    });

    it('consumes the real revision-response shape without promoting its saved coordinates to publication/proof', () => {
        const saved: ArticleRevisionResponsibilitySnapshotResponse = { ...source(), id: 'responsibility-unit:1',
            responsibilityVersion: 2, previousSnapshotId: null, methodology: 'Private methodology',
            applicability: null, limitations: null, createdAt: '2026-10-08T00:00:00Z', conclusionImpact: 'unknown' };
        const value = draft(owner(), saved);
        expect(value.snapshot.authors[0].name).toBe('Draft author');
        expect(value.snapshot.update?.conclusionImpact).toBe('unknown');
        expect(Object.hasOwn(value.snapshot, 'id')).toBe(false);
        expect(Object.hasOwn(value.snapshot, 'methodology')).toBe(false);
        expect(verifyArticleDraftResponsibilitySnapshot(value.snapshot, value.context, { ...saved,
            responsibilityVersion: 3 } as ArticleRevisionResponsibilitySnapshotResponse, 'Site author')).toBe(false);
    });

    it.each(['javascript:alert(1)', 'fsus-asset:private', 'https://user:secret@example.test/a',
        'http://localhost/a', 'http://127.1/a', 'http://10.1.2.3/a', 'http://172.16.1.2/a',
        'http://192.168.1.2/a', 'http://169.254.1.2/a', 'http://[::1]/a', 'http://[fe80::1]/a',
        'http://[fec0::1]/a', 'http://[::ffff:127.0.0.1]/a'])('omits unsafe public display URL %s without claiming resource verification', url => {
        const input = source();
        input.authors[0].profileUrl = url;
        input.sources[0].url = url;
        const snapshot = draft(owner(), input).snapshot;
        expect(snapshot.authors[0].profileUrl).toBe(null);
        expect(snapshot.sources).toEqual([]);
        expect(snapshot.status).toBe('incomplete');
        expect(snapshot.reasons).toContain('responsibility-source-incomplete');
    });
});
