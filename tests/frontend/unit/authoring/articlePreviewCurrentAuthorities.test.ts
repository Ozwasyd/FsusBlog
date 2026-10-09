import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArticleResponsibilityVersionResponse } from '@/api/authoring';
import type { SeoConfigPublic } from '@/api/system';
import { ArticleDocumentContextAuthority } from '@/services/authoring/articleDocumentContext';
import { createArticlePreviewCurrentAuthorities } from '@/services/authoring/articlePreviewCurrentAuthorities';
import { ArticlePreviewSourceAdmission } from '@/services/authoring/articlePreviewSourceAdmission';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';
import type { ArticleDraftResponsibilitySource } from '@/view-contracts/articleDraftResponsibility';

const api = vi.hoisted(() => ({ history: vi.fn(), site: vi.fn() }));
vi.mock('@/api/authoring', () => ({ getArticleResponsibilityHistory: api.history }));
vi.mock('@/api/system', () => ({ getSiteConfig: api.site }));

const cleanups: (() => void)[] = [];
beforeEach(() => {
    api.history.mockReset().mockResolvedValue([version()]);
    api.site.mockReset().mockResolvedValue(site());
});
afterEach(() => cleanups.splice(0).reverse().forEach(dispose => dispose()));

function site(author = 'Canonical site author'): SeoConfigPublic {
    // Ordinary read fixtures; no live backend, user data or runtime registration is claimed.
    return { author } as SeoConfigPublic;
}

function responsibility(confirmed = true): ArticleDraftResponsibilitySource {
    return { inheritSiteAuthor: true, authors: [], reviewer: null, sources: [], updateSummary: null,
        updateReason: null, effectiveAt: null, conclusionImpact: null, responsiblePersonConfirmed: confirmed };
}

function version(overrides: Partial<ArticleResponsibilityVersionResponse> = {}): ArticleResponsibilityVersionResponse {
    return { ...responsibility(), id: '101', responsibilityVersion: 1, previousSnapshotId: null,
        methodology: null, applicability: null, limitations: null, createdAt: '2026-10-09T00:00:00Z',
        articleId: 1, articleRevisionId: '11', revisionNo: 1, ...overrides };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
    return { promise, resolve, reject };
}

function open(articleId: number | null = 1) {
    const authority = new ArticleDocumentContextAuthority();
    const source = 'same article body';
    const host = authority.acquire({ articleId, content: source, siteScope: 'site:preview', userScope: 'user:preview' });
    const owner = host.adapter;
    let revisionId: string | null = articleId === null ? null : '11';
    let editing: ArticleDraftResponsibilitySource | null | undefined;
    let hostAuthor: string | undefined;
    let authoringInputDigest = digest('current host form');
    const reads = createArticlePreviewCurrentAuthorities({ documentContext: owner,
        readHost: () => ({ context: owner.context, source, revisionId,
            attachmentLifecycleHistory: [], authoringInputDigest }),
        readEditingResponsibility: () => editing,
        readCurrentSiteAuthor: () => hostAuthor });
    cleanups.push(host.release, () => reads.dispose());
    const refresh = () => reads.refresh(new AbortController().signal);
    const attach = () => {
        const admission = ArticlePreviewSourceAdmission.attach(reads.read, authority);
        cleanups.push(() => admission.dispose());
        return admission;
    };
    return { reads, refresh, attach, host, owner,
        setEditing(value: typeof editing) { editing = value; },
        setAuthor(value: typeof hostAuthor) { hostAuthor = value; },
        setRevision(value: typeof revisionId) { revisionId = value; },
        changeMetadata() { authoringInputDigest = digest('changed host form'); },
        switchArticle() {
            host.switchDocument({ articleId: 2, content: source, reason: 'article-switch' });
            revisionId = '22';
        }
    };
}

describe('article preview current authority composition', () => {
    it('reads existing APIs for the exact current revision and projects the latest original history version', async () => {
        api.history.mockResolvedValue([version({ id: '102', responsibilityVersion: 2,
            inheritSiteAuthor: false, authors: [{ name: 'Saved editor', profileUrl: null }] }), version()]);
        const f = open();
        const context = f.owner.context;
        expect((await f.refresh()).responsibilitySource).toBe('revision-history');
        expect(api.history).toHaveBeenCalledWith(1, '11', { signal: expect.any(AbortSignal) });
        expect(api.site.mock.calls[0]![0].signal).toBe(api.history.mock.calls[0]![2].signal);
        expect(f.reads.read().context).toBe(context);
        expect(f.reads.readResponsibility()?.authors[0]?.name).toBe('Saved editor');
        expect(Object.hasOwn(f.reads.readResponsibility()!, 'id')).toBe(false);
        expect(Object.isFrozen(f.reads.readResponsibility()?.authors)).toBe(true);
        const admission = f.attach();
        const request = admission.begin();
        expect(request.responsibility.authors[0]?.name).toBe('Saved editor');
        expect(admission.accept(request, 'composition').accepted).toBe(true);
        expect(f.owner.context).toBe(context);
    });

    it('refreshes changed canonical site authors and rejects the older admission with unchanged body', async () => {
        const f = open();
        f.setAuthor('Stale host cache');
        await f.refresh();
        expect(f.reads.readSiteAuthor()).toBe('Canonical site author');
        const admission = f.attach();
        const old = admission.begin();
        api.site.mockResolvedValue(site('Changed canonical author'));
        await f.refresh();
        expect(admission.accept(old, 'old').accepted).toBe(false);
        expect(admission.begin().responsibility.authors[0]?.name).toBe('Changed canonical author');
        expect(api.site).toHaveBeenCalledTimes(2);
    });

    it('observes a later host site-author edit at admission acceptance', async () => {
        const f = open();
        f.setEditing(responsibility());
        f.setAuthor('Canonical site author');
        await f.refresh();
        const admission = f.attach();
        const old = admission.begin();
        f.setAuthor('Live changed site author');
        expect(admission.accept(old, 'old').reason).toBe('preview-input-changed');
        expect(admission.begin().responsibility.authors[0]?.name).toBe('Live changed site author');
        f.setAuthor(undefined);
        expect(() => f.reads.readSiteAuthor()).toThrow('preview-site-author-unavailable');
    });

    it('preserves inherit toggles and explicit responsible editor input without changing source or confirmation', async () => {
        const f = open();
        const editing = responsibility(false);
        f.setEditing(editing);
        await f.refresh();
        expect(api.history).not.toHaveBeenCalled();
        const admission = f.attach();
        const old = admission.begin();
        expect(old.responsibility.reasons).toContain('responsibility-person-unconfirmed');
        editing.inheritSiteAuthor = false;
        editing.authors.push({ name: 'Actual editor input', profileUrl: null });
        expect(admission.accept(old, 'old').accepted).toBe(false);
        const explicit = admission.begin();
        expect(explicit.responsibility.authors[0]?.name).toBe('Actual editor input');
        expect(explicit.responsibility.reasons).toContain('responsibility-person-unconfirmed');
        editing.authors[0]!.name = 'Changed responsible editor';
        expect(admission.accept(explicit, 'old').accepted).toBe(false);
        expect(admission.begin().responsibility.authors[0]?.name).toBe('Changed responsible editor');
        expect(f.reads.readResponsibility()).toBe(editing);
        expect(editing.responsiblePersonConfirmed).toBe(false);
        editing.inheritSiteAuthor = true;
        editing.authors.splice(0);
        expect(admission.begin().responsibility.authors[0]?.name).toBe('Canonical site author');
    });

    it('keeps explicit missing input missing and never restores saved responsibility over it', async () => {
        const f = open();
        f.setEditing(null);
        const result = await f.refresh();
        expect(result.reasons).toContain('responsibility-missing');
        expect(api.history).not.toHaveBeenCalled();
        expect(f.attach().begin().responsibility.status).toBe('missing');
        f.setEditing(undefined);
        expect(f.reads.state.status).toBe('unavailable');
        expect(f.reads.state.currentResponsibilityTransport).toBe('unavailable');
        await f.refresh();
        expect(f.reads.readResponsibility()).not.toBeNull();
    });

    it('keeps an unsaved new article and missing current-authoring transport explicitly unavailable', async () => {
        const f = open(null);
        const result = await f.refresh();
        expect(result.status).toBe('unavailable');
        expect(result.reasons).toContain('current-authoring-responsibility-transport-unavailable');
        expect(result.reasons).toContain('responsibility-missing');
        expect(api.history).not.toHaveBeenCalled();
        expect(f.attach().begin().responsibility.status).toBe('missing');
        f.setEditing(responsibility(false));
        await f.refresh();
        expect(f.attach().begin().responsibility.status).toBe('incomplete');
        expect(f.reads.state.currentResponsibilityTransport).toBe('unavailable');
    });

    it('does not manufacture an author or confirmation from empty site config and unconfirmed saved history', async () => {
        api.site.mockResolvedValue(site(''));
        api.history.mockResolvedValue([version({ responsiblePersonConfirmed: false })]);
        const f = open();
        await f.refresh();
        expect(f.reads.readSiteAuthor()).toBe('');
        const snapshot = f.attach().begin().responsibility;
        expect(snapshot.authors).toEqual([]);
        expect(snapshot.reasons).toEqual(['responsibility-author-incomplete', 'responsibility-person-unconfirmed']);
        expect(f.reads.state.reasons).toContain('site-author-missing');
        api.history.mockResolvedValue([]);
        await f.refresh();
        expect(f.reads.readResponsibility()).toBeNull();
    });

    it('rejects same-body A to B context switches and a late A history result', async () => {
        const history = deferred<ArticleResponsibilityVersionResponse[]>();
        api.history.mockReturnValueOnce(history.promise);
        const f = open();
        const pending = f.refresh();
        const signal = api.history.mock.calls[0]![2].signal as AbortSignal;
        f.switchArticle();
        expect(signal.aborted).toBe(true);
        expect((await pending).status).toBe('canceled');
        api.history.mockResolvedValue([version({ articleId: 2, articleRevisionId: '22',
            inheritSiteAuthor: false, authors: [{ name: 'B editor', profileUrl: null }] })]);
        await f.refresh();
        history.resolve([version({ authors: [{ name: 'A editor', profileUrl: null }] })]);
        await Promise.resolve();
        expect(f.reads.readResponsibility()?.authors[0]?.name).toBe('B editor');
        expect(f.attach().begin().context.articleId).toBe(2);
    });

    it('does not dispatch APIs for a pre-canceled request', async () => {
        const f = open();
        const controller = new AbortController();
        controller.abort();
        expect((await f.reads.refresh(controller.signal)).status).toBe('canceled');
        expect(api.site).not.toHaveBeenCalled();
        expect(api.history).not.toHaveBeenCalled();
    });

    it('settles cancellation promptly even when the original API ignores abort and rejects late data', async () => {
        const siteRead = deferred<SeoConfigPublic>();
        api.site.mockReturnValue(siteRead.promise);
        const f = open();
        const controller = new AbortController();
        const pending = f.reads.refresh(controller.signal);
        controller.abort();
        expect((await pending).status).toBe('canceled');
        expect(api.site.mock.calls[0]![0].signal.aborted).toBe(true);
        siteRead.resolve(site('Late site author'));
        await Promise.resolve();
        expect(() => f.reads.read()).toThrow('preview-authorities-not-current');
    });

    it('keeps a superseded caller canceled and prevents late old reads from overwriting a new refresh', async () => {
        const late = deferred<SeoConfigPublic>();
        api.site.mockReturnValueOnce(late.promise);
        const f = open();
        const old = f.refresh();
        api.site.mockResolvedValue(site('Current author'));
        expect((await f.refresh()).status).toBe('ready');
        expect((await old).status).toBe('canceled');
        late.resolve(site('Old author'));
        await Promise.resolve();
        expect(f.reads.readSiteAuthor()).toBe('Current author');
    });

    it('rejects responsibility edits made while a site-author read is pending', async () => {
        const late = deferred<SeoConfigPublic>();
        api.site.mockReturnValueOnce(late.promise);
        const f = open();
        const editing = responsibility();
        f.setEditing(editing);
        const pending = f.refresh();
        editing.responsiblePersonConfirmed = false;
        late.resolve(site());
        expect((await pending).status).toBe('stale');
        expect(() => f.reads.read()).toThrow('preview-authorities-not-current');
    });

    it('rejects revision and metadata changes during pending reads without changing the document owner', async () => {
        const f = open();
        for (const change of [() => f.setRevision('12'), () => f.changeMetadata()]) {
            const late = deferred<SeoConfigPublic>();
            api.site.mockReturnValueOnce(late.promise);
            const context = f.owner.context;
            const pending = f.refresh();
            change();
            late.resolve(site());
            expect((await pending).status).toBe('stale');
            expect(f.owner.context).toBe(context);
        }
    });

    it('rejects foreign, unordered and ambiguous revision history rather than guessing a current version', async () => {
        const f = open();
        for (const history of [[version({ articleId: 2 })], [version({ articleRevisionId: '22' })],
            [version(), version({ responsibilityVersion: 2 })], [version(), version()]]) {
            api.history.mockResolvedValueOnce(history);
            expect((await f.refresh()).status).toBe('failed');
            expect(() => f.reads.readResponsibility()).toThrow('preview-authorities-not-current');
        }
    });

    it('does not reuse a previously successful read after either existing API fails', async () => {
        const f = open();
        await f.refresh();
        const admission = f.attach();
        const old = admission.begin();
        api.history.mockRejectedValueOnce(new Error('history unavailable'));
        expect((await f.refresh()).status).toBe('failed');
        expect(admission.accept(old, 'old').reason).toBe('preview-input-invalid');
        api.site.mockRejectedValueOnce(new Error('site unavailable'));
        expect((await f.refresh()).status).toBe('failed');
        expect(() => f.reads.readSiteAuthor()).toThrow('preview-authorities-not-current');
    });

    it('cancels and disposes only this read consumer while retaining the original host', async () => {
        const f = open();
        await f.refresh();
        f.reads.cancel();
        expect(() => f.reads.read()).toThrow('preview-authorities-not-current');
        await f.refresh();
        const admission = f.attach();
        const request = admission.begin();
        f.reads.dispose();
        f.reads.dispose();
        expect(admission.accept(request, 'old').accepted).toBe(false);
        expect(() => f.reads.read()).toThrow('preview-authorities-disposed');
        const task = f.owner.beginTask('search', 'host-search');
        expect(task.isCurrent()).toBe(true);
        task.cancel();
    });
});
