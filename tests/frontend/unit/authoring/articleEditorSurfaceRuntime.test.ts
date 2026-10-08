// @vitest-environment happy-dom
import { ElMarkdownEditor, resolveMarkdownLiveCapability } from '@ozwasyd/element-plus';
import { MARKDOWN_RENDERER_VERSION, createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';

import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter } from '@/services/authoring/articleAttachmentContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { createArticleEditorContinuityAcknowledgement } from '@/services/authoring/articleEditorContinuity';
import { bindArticleEditorRuntime } from '@/services/authoring/articleEditorRuntimeBinding';
import { createArticleEditorSurfacePreference } from '@/services/authoring/articleEditorSurface';
import { ArticleEditorSurfaceRuntime } from '@/services/authoring/articleEditorSurfaceRuntime';
import { ArticleLiveCapabilitySession } from '@/services/authoring/articleLiveCapability';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

import type { MarkdownLiveCapability } from '@ozwasyd/element-plus';
import type { ArticleEditorContinuityPort, ArticleEditorContinuityReceipt } from '@/services/authoring/articleEditorContinuity';
import type { ArticleEditorRuntimeBinding } from '@/services/authoring/articleEditorRuntimeBinding';

const disposals: (() => void)[] = [];
afterEach(() => disposals.splice(0).reverse().forEach(dispose => dispose()));
const environment = { rendererVersion: MARKDOWN_RENDERER_VERSION, projectionVersion: MARKDOWN_RENDERER_VERSION,
    featureDigest: digest({ features: 'actual-public-fixture' }), runtimeIdentity: 'runtime:surface', platformIdentity: 'platform:happy-dom' };
const restore = { origin: 'surface' as const, now: 100, viewportHeight: 500, reducedMotion: true };

async function mounted(surface: 'live' | 'source' = 'live')
{
    let source = '\ufeff# Heading\r\n\r\nparagraph  \r\n';
    const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1', editorSessionId: 'session:surface', siteScope: 'site:test', userScope: 'user:test', content: source });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const attachments = new ArticleAttachmentContextAdapter(owner, 'surface-test', 'v1.0', anchors);
    let binding: ArticleEditorRuntimeBinding | null = null;
    const wrapper = mount(ElMarkdownEditor, { attachTo: document.body, props: {
        modelValue: source, mode: surface, documentIdentity: owner.documentIdentity,
        onTransaction: result => binding?.consumeTransaction(result)
    } });
    const port = wrapper.vm as unknown as ArticleEditorContinuityPort;
    binding = bindArticleEditorRuntime(owner, anchors, attachments, {
        dispatch: transaction => port.dispatchTransaction(transaction),
        commitSource: result => { source = result.value; if (result.revision > owner.context.sourceRevision) owner.updateSource(source, result.revision); },
        binding: () => ({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) })
    }, () => source, port, { surface, configuration: { allowLatex: true, allowMermaid: true, baseUrl: null },
        identity: { locale: 'zh-CN', themeDigest: digest({ theme: 'light' }) }, cachePolicy: { maxEntryBytes: 2000000, maxAgeMs: 60000, maxReceipts: 8 } });
    const bound = binding;
    wrapper.element.addEventListener('focusin', () => bound.consumeFocus('focusin'));
    wrapper.element.addEventListener('focusout', () => bound.consumeFocus('focusout'));
    expect(bound.initialize()).toBe(true);
    const selection = port.dispatchTransaction({ changes: [], history: 'skip', origin: 'programmatic', documentIdentity: owner.documentIdentity,
        expectedRevision: owner.context.sourceRevision, selection: { start: 14, end: 18, direction: 'backward' } });
    expect(selection.accepted).toBe(true);
    await nextTick(); await nextTick();
    let preference = createArticleEditorSurfacePreference(owner.context, 'live');
    const capabilities = new ArticleLiveCapabilitySession(owner);
    const runtime = new ArticleEditorSurfaceRuntime(owner, bound, capabilities, () => preference);
    const capture = () => ({ surface, tool: 'none' as const, affinity: 'after' as const,
        viewportOffset: (wrapper.get('textarea').element as HTMLTextAreaElement).scrollTop, percentage: 0 });
    const capability = (token: MarkdownLiveCapability) => {
        const request = runtime.beginCapability(environment);
        // Explicit typed producer inputs exercise failures. They are not native capability qualification.
        expect(runtime.receiveCapability(request, resolveMarkdownLiveCapability(token, { documentIdentity: owner.documentIdentity, revision: owner.context.sourceRevision }))).toBe('accepted');
        return request;
    };
    const acknowledge = async (receipt: ArticleEditorContinuityReceipt) => {
        expect(receipt.status).toBe('awaiting-ack');
        expect(receipt.after).toBeNull();
        await wrapper.setProps({ mode: receipt.targetSurface, modelValue: source });
        await nextTick(); await nextTick();
        const textarea = wrapper.get('textarea').element as HTMLTextAreaElement;
        if (receipt.before.focus === 'editor')
        {
            textarea.focus();
        }
        const before = bound.continuity.capture(bound.positionBinding(), capture());
        const focused = document.activeElement === textarea;
        const result = bound.continuity.acknowledge(port, createArticleEditorContinuityAcknowledgement({ requestRef: receipt.requestRef,
            document: owner.context, instanceRef: bound.continuity.instanceRef, sessionRef: owner.context.editorSessionId,
            historyRef: before.historyRef, history: before.history,
            selection: { start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection },
            surface: receipt.targetSurface, tool: receipt.targetTool, generation: receipt.anchorCommand!.generation,
            focus: focused ? 'editor' : 'outside', focusEvent: focused ? 'focusin' : 'focusout', viewportOffset: textarea.scrollTop }))!;
        expect(result.status, JSON.stringify({ beforeFocus: receipt.before.focus, observedFocus: focused,
            focusAcknowledged: result.focusAcknowledged, viewportAcknowledged: result.viewportAcknowledged,
            viewport: textarea.scrollTop, targetViewport: receipt.anchorCommand!.viewportOffset })).toBe('restored');
        surface = result.targetSurface;
        return result;
    };
    disposals.push(() => { runtime.dispose(); bound.dispose(); attachments.dispose(); owner.dispose(); wrapper.unmount(); });
    return { owner, port, wrapper, bound, runtime, capture, capability, acknowledge, source: () => source,
        preference: () => preference, committedPreference: (value: 'live' | 'source') => { preference = createArticleEditorSurfacePreference(owner.context, value); } };
}

describe('product surface actions using the real editor and canonical continuity', () => {
    it.each(['unsupported-platform', 'runtime-unavailable', 'projection-failed', 'fatal'] as const)('executes %s session fallback while preserving body, backward selection and history', async failure => {
        const h = await mounted();
        h.capability('supported');
        const instance = h.wrapper.vm;
        const document = h.owner.context;
        const bytes = h.source();
        const preference = h.preference();
        const before = h.bound.continuity.capture(h.bound.positionBinding(), h.capture());
        h.capability(failure);
        const plan = h.runtime.applyDecision(h.capture(), restore)!;
        const after = await h.acknowledge(plan);
        expect(after.targetSurface).toBe('source');
        expect(after.after!.history).toEqual(before.history);
        expect(after.after!.anchor.direction).toBe('backward');
        expect(h.runtime.state.pending!.status).toBe('restored');
        expect(h.preference()).toBe(preference);
        expect(h.wrapper.vm).toBe(instance);
        expect(h.owner.context).toBe(document);
        expect(h.source()).toBe(bytes);
        const edit = h.port.dispatchTransaction({ changes: [{ from: 14, to: 14, insert: 'continue ' }], history: 'record', origin: 'input',
            documentIdentity: h.owner.documentIdentity, expectedRevision: h.owner.context.sourceRevision });
        expect(edit.accepted).toBe(true);
        expect(h.source()).toContain('continue ');
    });

    it('keeps local degradation in Live and executes an explicit temporary Source escape', async () => {
        const h = await mounted();
        h.capability('feature-degraded');
        expect(h.runtime.state.desiredSurface).toBe('live');
        expect(h.runtime.applyDecision(h.capture(), restore)).toBeNull();
        const preference = h.preference();
        await h.acknowledge(h.runtime.escapeToSource(h.capture(), restore)!);
        expect(h.runtime.state.desiredSurface).toBe('source');
        expect(h.preference()).toBe(preference);
        expect(h.preference().surface).toBe('live');
    });

    it('runs actual public runtime recovery but requires a fresh typed result before Live returns', async () => {
        const h = await mounted(); h.capability('fatal');
        await h.acknowledge(h.runtime.applyDecision(h.capture(), restore)!);
        const before = h.owner.context;
        const oldRequest = h.capability('fatal');
        const recovery = await h.runtime.recover(environment);
        expect(recovery.admission).toBe('current');
        expect(typeof recovery.initialization.ok).toBe('boolean');
        expect(h.runtime.state.desiredSurface).toBe('source');
        const result = resolveMarkdownLiveCapability('supported', { documentIdentity: h.owner.documentIdentity, revision: h.owner.context.sourceRevision });
        expect(h.runtime.receiveCapability(oldRequest, result)).toBe('stale');
        expect(h.runtime.receiveCapability(recovery.request, result)).toBe('accepted');
        await h.acknowledge(h.runtime.applyDecision(h.capture(), restore)!);
        expect(h.runtime.state.desiredSurface).toBe('live');
        expect(h.owner.context).toBe(before);
        expect(h.preference().surface).toBe('live');
    });

    it('reads committed preference changes from its existing owner and never overrides Source preference', async () => {
        const h = await mounted('source');
        h.committedPreference('source'); h.capability('supported');
        expect(h.runtime.state.desiredSurface).toBe('source');
        expect(h.runtime.applyDecision(h.capture(), restore)).toBeNull();
        h.committedPreference('live');
        await h.acknowledge(h.runtime.applyDecision(h.capture(), restore)!);
        h.committedPreference('source');
        await h.acknowledge(h.runtime.applyDecision(h.capture(), restore)!);
        expect(h.preference().surface).toBe('source');
    });

    it('cancels a pending Live restoration when a newer typed global failure arrives', async () => {
        const h = await mounted('source'); h.capability('supported');
        const pending = h.runtime.applyDecision(h.capture(), restore)!;
        expect(pending.targetSurface).toBe('live');
        h.capability('fatal');
        expect(h.runtime.applyDecision(h.capture(), restore)).toBeNull();
        expect(h.bound.continuity.receipts.slice().reverse().find(item => item.requestRef === pending.requestRef)!.status).toBe('rejected');
        expect(h.runtime.state.desiredSurface).toBe('source');
        expect(h.runtime.state.pending).toBeNull();
    });

    it('preserves a real manual-scroll pause and replans only after the anchor owner resumes', async () => {
        const h = await mounted(); h.capability('fatal');
        const bytes = h.source();
        const context = h.owner.context;
        const instance = h.wrapper.vm;
        h.bound.anchors.manual('touch', 'source', 100);
        const paused = h.runtime.applyDecision(h.capture(), { ...restore, now: 110 })!;
        expect(paused.status).toBe('paused');
        expect(paused.after).toBeNull();
        expect(h.runtime.applyDecision(h.capture(), { ...restore, now: 120 })).toBe(paused);
        expect(h.source()).toBe(bytes);
        expect(h.owner.context).toBe(context);
        expect(h.wrapper.vm).toBe(instance);
        expect(h.bound.anchors.resume('navigation', 200)).toBe(true);
        const replanned = h.runtime.applyDecision(h.capture(), { ...restore, now: 210 })!;
        expect(replanned.requestRef).not.toBe(paused.requestRef);
        expect((await h.acknowledge(replanned)).targetSurface).toBe('source');
        expect(h.preference().surface).toBe('live');
    });

    it('replans a pending transition after actual input advances its document revision', async () => {
        const h = await mounted(); h.capability('fatal');
        const original = h.runtime.applyDecision(h.capture(), restore)!;
        const edit = h.port.dispatchTransaction({ changes: [{ from: 14, to: 14, insert: 'new ' }], history: 'record', origin: 'input',
            documentIdentity: h.owner.documentIdentity, expectedRevision: h.owner.context.sourceRevision });
        expect(edit.accepted).toBe(true);
        await nextTick(); await nextTick();
        const replanned = h.runtime.applyDecision(h.capture(), { ...restore, now: 110 })!;
        expect(replanned.requestRef).not.toBe(original.requestRef);
        expect(replanned.before.document.sourceRevision).toBe(edit.revision);
        const stale = createArticleEditorContinuityAcknowledgement({ requestRef: original.requestRef,
            document: original.before.document, instanceRef: h.bound.continuity.instanceRef,
            sessionRef: original.before.sessionRef, historyRef: original.before.historyRef, history: original.before.history,
            selection: { ...original.anchorCommand!.range!, direction: original.anchorCommand!.direction },
            surface: original.targetSurface, tool: original.targetTool, generation: original.anchorCommand!.generation,
            focus: 'editor', focusEvent: 'focusin', viewportOffset: original.anchorCommand!.viewportOffset });
        expect(h.bound.continuity.acknowledge(h.port, stale)).toBeNull();
        expect((await h.acknowledge(replanned)).after!.history).toEqual(edit.history);
        expect(h.source()).toContain('new ');
    });

    it('withdraws stale automatic admission when real user scroll takes control', async () => {
        const h = await mounted(); h.capability('fatal');
        const original = h.runtime.applyDecision(h.capture(), restore)!;
        h.bound.anchors.manual('wheel', 'source', 110);
        const paused = h.runtime.applyDecision(h.capture(), { ...restore, now: 120 })!;
        expect(paused.requestRef).not.toBe(original.requestRef);
        expect(paused.status).toBe('paused');
        expect(paused.after).toBeNull();
        expect(h.bound.continuity.receipts.slice().reverse().find(item => item.requestRef === original.requestRef)!.status).toBe('rejected');
        expect(h.preference().surface).toBe('live');
    });

    it.each(['document-switch', 'dispose'] as const)('rejects an actual initialization completion after %s', async boundary => {
        const h = await mounted(); h.capability('fatal');
        const recovery = h.runtime.recover(environment);
        if (boundary === 'document-switch')
        {
            h.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: h.source() });
        }
        else
        {
            h.runtime.dispose();
        }
        const result = await recovery;
        expect(result.admission).toBe('stale');
        expect(result.request.signal.aborted).toBe(true);
        expect(h.runtime.state.desiredSurface).toBe('source');
        expect(h.runtime.state.escaped).toBe(false);
        expect(h.preference().surface).toBe('live');
    });

    it('denies released bindings and disposed owners before native recovery or transition side effects', async () => {
        const h = await mounted(); h.bound.dispose();
        await expect(h.runtime.recover(environment)).rejects.toThrow('article-editor-runtime-binding-disposed');
        expect(() => h.runtime.applyDecision(h.capture(), restore)).toThrow('article-editor-runtime-binding-disposed');
        h.owner.dispose();
        expect(h.runtime.state.documentCurrent).toBe(false);
        expect(() => h.runtime.beginCapability(environment)).toThrow('article-editor-surface-runtime-stale');
    });
});
