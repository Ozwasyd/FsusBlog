import { markdownLiveCapabilities, resolveMarkdownLiveCapability } from '@ozwasyd/element-plus';
import { describe, expect, it } from 'vitest';

import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { createArticleEditorSurfacePreference } from '@/services/authoring/articleEditorSurface';
import { ArticleLiveCapabilitySession } from '@/services/authoring/articleLiveCapability';

const environment = { rendererVersion: 'renderer:v1', projectionVersion: 'projection:v1', featureDigest: 'a'.repeat(64), runtimeIdentity: 'runtime:test', platformIdentity: 'platform:test' };
const setup = () => {
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1', editorSessionId: 'session:test', siteScope: 'site:test', userScope: 'user:test', content: '\ufeff# Test\r\n\r\nbody  \r\n' });
    return { owner, session: new ArticleLiveCapabilitySession(owner), preference: createArticleEditorSurfacePreference(owner.context) };
};

describe('real FsusUI capability product policy (#2282)', () => {
    it.each(markdownLiveCapabilities)('applies %s without touching preference or document state', capability => {
        const { owner, session, preference } = setup();
        const before = owner.context;
        const attachment = owner.beginTask('attachment', 'pending:attachment');
        const request = session.begin(environment);
        const result = resolveMarkdownLiveCapability(capability, { documentIdentity: owner.documentIdentity, revision: before.sourceRevision, nodeId: 'node:test', affectedRange: { start: 2, end: 5 } });
        expect(session.commit(request, result)).toBe('accepted');
        const state = session.state(preference);
        expect(state.effectiveSurface).toBe(capability === 'supported' || capability === 'feature-degraded' ? 'live' : 'source');
        expect(state.localEscape).toEqual(capability === 'feature-degraded' ? result : null);
        expect(state.preference).toEqual(preference);
        expect(owner.context).toBe(before);
        expect(attachment.isCurrent()).toBe(true);
        expect(owner.receipts).toHaveLength(1);
    });

    it('honors explicit source preference even when Live recovers', () => {
        const { owner, session } = setup();
        const preference = createArticleEditorSurfacePreference(owner.context, 'source');
        const request = session.begin(environment);
        expect(session.commit(request, resolveMarkdownLiveCapability('supported', { documentIdentity: owner.documentIdentity, revision: 0 }))).toBe('accepted');
        expect(session.state(preference).effectiveSurface).toBe('source');
    });

    it('retains Source and its recovery path after fatal and returns to preference on explicit current capability recovery', () => {
        const { owner, session, preference } = setup();
        session.commit(session.begin(environment), resolveMarkdownLiveCapability('fatal', { documentIdentity: owner.documentIdentity, revision: 0 }));
        const context = owner.context;
        expect(session.state(preference).recovery).toBe('request-current-capability');
        session.commit(session.begin(environment), resolveMarkdownLiveCapability('supported', { documentIdentity: owner.documentIdentity, revision: 0 }));
        expect(session.state(preference).effectiveSurface).toBe('live');
        expect(owner.context).toBe(context);
    });

    it('rejects A/B equal-source and late-revision results using the original document lease', () => {
        const { owner, session, preference } = setup();
        const first = session.begin(environment);
        const result = resolveMarkdownLiveCapability('supported', { documentIdentity: owner.documentIdentity, revision: 0 });
        owner.updateSource('changed', 1);
        expect(session.commit(first, result)).toBe('stale');
        owner.switchDocument({ articleId: 2, draftId: 'article:2', content: '\ufeff# Test\r\n\r\nbody  \r\n' });
        const second = session.begin(environment);
        expect(session.commit(second, result)).toBe('stale');
        expect(session.state(preference).capability).toBeNull();
    });

    it('rejects cancellation, superseded environments and forged request objects', () => {
        const { owner, session } = setup();
        const first = session.begin(environment);
        const result = resolveMarkdownLiveCapability('supported', { documentIdentity: owner.documentIdentity, revision: 0 });
        const second = session.begin({ ...environment, runtimeIdentity: 'runtime:new' });
        expect(first.signal.aborted).toBe(true);
        expect(session.commit(first, result)).toBe('stale');
        expect(session.commit({ ...second }, result)).toBe('stale');
        session.cancel();
        expect(second.signal.aborted).toBe(true);
        expect(session.commit(second, result)).toBe('stale');
    });

    it('requires fresh capability when platform/runtime/render/projection/features change', () => {
        for (const field of Object.keys(environment)) {
            const { owner, session, preference } = setup();
            session.commit(session.begin(environment), resolveMarkdownLiveCapability('supported', { documentIdentity: owner.documentIdentity, revision: 0 }));
            expect(session.state(preference).effectiveSurface).toBe('live');
            session.cancel();
            session.begin({ ...environment, [field]: field === 'featureDigest' ? 'b'.repeat(64) : 'identity:new' });
            expect(session.state(preference).effectiveSurface).toBe('source');
            expect(session.state(preference).reason).toBe('capability-pending');
        }
    });

    it.each(['unknown', 'write', 'split', 'preview', 0, null])('fails closed for unknown public status %j', capability => {
        const { owner, session, preference } = setup();
        const valid = resolveMarkdownLiveCapability('supported', { documentIdentity: owner.documentIdentity, revision: 0 });
        expect(session.commit(session.begin(environment), { ...valid, capability })).toBe('invalid');
        expect(session.state(preference).effectiveSurface).toBe('source');
        expect(session.state(preference).preference).toEqual(preference);
    });

    it.each(['stale', 'aborted'] as const)('ignores explicitly %s typed results', field => {
        const { owner, session } = setup();
        const result = resolveMarkdownLiveCapability('fatal', { documentIdentity: owner.documentIdentity, revision: 0, [field]: true });
        expect(session.commit(session.begin(environment), result)).toBe('stale');
    });

    it('does not reuse local ranges after edits or turn stale cache state into global failure', () => {
        const { owner, session, preference } = setup();
        session.commit(session.begin(environment), resolveMarkdownLiveCapability('feature-degraded', { documentIdentity: owner.documentIdentity, revision: 0, nodeId: 'node:affected' }));
        owner.updateSource('new revision', 1);
        expect(session.state(preference).effectiveSurface).toBe('live');
        expect(session.state(preference).localEscape).toBeNull();
    });

    it('snapshots public range/identity and refuses malformed ranges instead of mapping offsets', () => {
        const { owner, session, preference } = setup();
        const range = { start: 1, end: 2 };
        const result = resolveMarkdownLiveCapability('feature-degraded', { documentIdentity: owner.documentIdentity, revision: 0, affectedRange: range });
        session.commit(session.begin(environment), result);
        range.start = 9;
        expect(session.state(preference).localEscape?.affectedRange).toEqual({ start: 1, end: 2 });
        expect(session.commit(session.begin(environment), result)).toBe('invalid');
    });
});
