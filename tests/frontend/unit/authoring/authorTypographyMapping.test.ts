// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { ElMarkdownEditor, MARKDOWN_EDITOR_TYPOGRAPHY_CATALOG as publicCatalog, resolveMarkdownEditorTypography as publicResolver } from '@ozwasyd/element-plus';
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { FsusUiMarkdownEditor, MARKDOWN_EDITOR_TYPOGRAPHY_CATALOG, resolveMarkdownEditorTypography } from '@/fsusui/markdownEditor';
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter } from '@/services/authoring/articleAttachmentContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { validateArticleEditorContinuityContext } from '@/services/authoring/articleEditorContinuity';
import { bindArticleEditorRuntime } from '@/services/authoring/articleEditorRuntimeBinding';
import { applyAuthorTypographyToEditor, captureAuthorTypographyContinuity, readAuthorTypographyMappingAvailability } from '@/services/authoring/authorTypographyMapping';
import { calculateOpenArticleDocumentDigest } from '@/services/authoring/openArticleDocumentRegistry';
import { AUTHOR_TYPOGRAPHY_CHOICES, AUTHOR_TYPOGRAPHY_FIELDS } from '@/view-contracts/authorTypographyProfile';

import type { MarkdownEditorDispatchResult, MarkdownEditorTransaction } from '@ozwasyd/element-plus';
import type { ArticleEditorContinuityPort } from '@/services/authoring/articleEditorContinuity';
import type { AuthorTypographyEditorPort } from '@/services/authoring/authorTypographyMapping';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

function openRuntime(surface: 'live' | 'source')
{
    let source = '# Heading\n\nCJK 中文 العربية emoji 👩🏽‍💻 é';
    const owner = createArticleDocumentContextAdapter({
        articleId: 1, draftId: 'article:1', editorSessionId: 'session:typography',
        siteScope: 'site:test', userScope: 'user:test', content: source
    });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const attachments = new ArticleAttachmentContextAdapter(owner, 'article-assets', 'version:1', anchors);
    let consumeTransaction: ((result: MarkdownEditorDispatchResult) => boolean) | null = null;
    const wrapper = mount(ElMarkdownEditor, {
        props: {
            modelValue: source, mode: surface, documentIdentity: owner.documentIdentity,
            onTransaction: (result: MarkdownEditorDispatchResult) => consumeTransaction?.(result)
        }
    });
    const editor = wrapper.vm as unknown as ArticleEditorContinuityPort;
    const binding = bindArticleEditorRuntime(owner, anchors, attachments, {
        dispatch: (transaction: MarkdownEditorTransaction) => editor.dispatchTransaction(transaction),
        commitSource: result =>
        {
            source = result.value;
            if (result.revision > owner.context.sourceRevision)
            {
                owner.updateSource(source, result.revision);
            }
        },
        binding: () => ({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) })
    }, () => source, editor, {
        surface,
        configuration: { allowLatex: false, allowMermaid: false, baseUrl: null },
        identity: { locale: 'zh-CN', themeDigest: calculateOpenArticleDocumentDigest({ theme: 'light' }) },
        cachePolicy: { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 }
    });
    consumeTransaction = result => binding.consumeTransaction(result);
    const options = { affinity: 'after' as const, viewportOffset: 12, percentage: 0.25, surface, tool: 'none' as const };
    cleanups.push(() =>
    {
        binding.dispose();
        attachments.dispose();
        wrapper.unmount();
        owner.dispose();
    });
    return { binding, owner, editor, wrapper, options, source: () => source };
}

describe('author typography public mapping boundary', () =>
{
    it('preserves the real public editor identity, prop types, default and validator through the named adapter', () =>
    {
        expectTypeOf(FsusUiMarkdownEditor).toEqualTypeOf<typeof ElMarkdownEditor>();
        expectTypeOf<AuthorTypographyEditorPort['applyTypography']>().toEqualTypeOf<InstanceType<typeof ElMarkdownEditor>['applyTypography']>();
        expect(FsusUiMarkdownEditor).toBe(ElMarkdownEditor);
        expect(FsusUiMarkdownEditor.props).toBe(ElMarkdownEditor.props);
        expect(FsusUiMarkdownEditor.props.editorProfile).toBe(ElMarkdownEditor.props.editorProfile);
        expect(FsusUiMarkdownEditor.props.editorProfile.default).toBe(ElMarkdownEditor.props.editorProfile.default);
        expect(FsusUiMarkdownEditor.props.editorProfile.validator).toBe(ElMarkdownEditor.props.editorProfile.validator);
        expect(readAuthorTypographyMappingAvailability().publicEditorDefaultProfile).toBe(FsusUiMarkdownEditor.props.editorProfile.default);
    });

    it('preserves the actual public catalog/resolver and requires a profile rather than manufacturing a default', () =>
    {
        const availability = readAuthorTypographyMappingAvailability();
        expect(availability).toEqual({
            status: 'blocked',
            reason: 'profile-required',
            publicEditorDefaultProfile: ElMarkdownEditor.props.editorProfile.default
        });
        expect(Object.isFrozen(availability)).toBe(true);
        expect(MARKDOWN_EDITOR_TYPOGRAPHY_CATALOG).toBe(publicCatalog);
        expect(resolveMarkdownEditorTypography).toBe(publicResolver);
        expect(ElMarkdownEditor.props.editorProfile.validator('markdown')).toBe(true);
        expect(ElMarkdownEditor.props.editorProfile.validator('prose')).toBe(true);
        for (const value of ['reading-serif', 'cjk-sans', 'system-sans', '18px', 'standard'])
        {
            expect(ElMarkdownEditor.props.editorProfile.validator(value)).toBe(false);
        }
    });

    it('cannot apply preferences or mutate a live editor through the capability observation', () =>
    {
        expect(Object.keys(readAuthorTypographyMappingAvailability()).sort()).toEqual([
            'publicEditorDefaultProfile', 'reason', 'status'
        ]);
        expect(readAuthorTypographyMappingAvailability()).not.toHaveProperty('apply');
        expect(readAuthorTypographyMappingAvailability()).not.toHaveProperty('profile');
    });

    it('delegates all 243 combinations to the real resolver: exactly 27 supported and 216 unsupported', () =>
    {
        let count = 0;
        let supported = 0;
        let unsupported = 0;
        for (const fontFamily of AUTHOR_TYPOGRAPHY_CHOICES.fontFamily)
        for (const fontSize of AUTHOR_TYPOGRAPHY_CHOICES.fontSize)
        for (const lineHeight of AUTHOR_TYPOGRAPHY_CHOICES.lineHeight)
        for (const canvasWidth of AUTHOR_TYPOGRAPHY_CHOICES.canvasWidth)
        for (const paragraphSpacing of AUTHOR_TYPOGRAPHY_CHOICES.paragraphSpacing)
        {
            const profile = {
                schemaVersion: 1, fontFamily, fontSize, lineHeight, canvasWidth, paragraphSpacing
            };
            const resolution = publicResolver(profile);
            const availability = readAuthorTypographyMappingAvailability(profile);
            expect(resolution.status).not.toBe('invalid');
            if (resolution.status === 'supported')
            {
                expect(availability.status).toBe('supported');
                expect(availability.reason).toBeNull();
                supported += 1;
            }
            else
            {
                expect(availability.status).toBe('blocked');
                expect(availability.reason).toBe('unsupported-profile');
                unsupported += 1;
            }
            expect(availability).not.toHaveProperty('applied');
            expect(Object.isFrozen(availability)).toBe(true);
            count += 1;
        }
        expect(count).toBe(243);
        expect(supported).toBe(27);
        expect(unsupported).toBe(216);
    });

    it('delegates hostile records to the public resolver without executing profile getters', () =>
    {
        let reads = 0;
        const profile = {
            schemaVersion: 1, fontFamily: 'system-sans', fontSize: 'standard',
            lineHeight: 'standard', canvasWidth: 'standard', paragraphSpacing: 'standard'
        };
        const accessor = { ...profile };
        Object.defineProperty(accessor, 'fontFamily', { enumerable: true, get: () => { reads += 1; throw new Error('getter-must-not-run'); } });
        const inherited = Object.assign(Object.create({}), profile);
        for (const input of [accessor, inherited])
            expect(readAuthorTypographyMappingAvailability(input).reason).toBe('invalid-profile');
        expect(reads).toBe(0);
    });

    it.each(['unsupported-profile', 'stale-document', 'stale-revision'] as const)('forwards the actual mounted editor Promise and %s result without a Writer acknowledgement', async reason =>
    {
        const runtime = openRuntime('source');
        expect(runtime.binding.initialize()).toBe(true);
        const before = captureAuthorTypographyContinuity(runtime.binding, runtime.options);
        const source = runtime.source();
        const context = runtime.owner.context;
        const instance = runtime.wrapper.vm;
        const transactions = runtime.wrapper.emitted('transaction')?.length;
        const call = vi.spyOn(instance, 'applyTypography'); // Call-through to the real public method; no mock result or geometry.
        try
        {
            const promise = applyAuthorTypographyToEditor(instance, {
                profile: {
                    schemaVersion: 1, fontFamily: reason === 'unsupported-profile' ? 'reading-serif' : 'system-sans',
                    fontSize: 'standard', lineHeight: 'standard', canvasWidth: 'standard', paragraphSpacing: 'standard'
                },
                expectedDocumentIdentity: reason === 'stale-document' ? { id: 'another-document', epoch: 0 } : runtime.owner.documentIdentity,
                expectedRevision: reason === 'stale-revision' ? runtime.owner.context.sourceRevision + 1 : runtime.owner.context.sourceRevision,
                requestId: `typography:${reason}`
            });
            expect(promise).toBe(call.mock.results[0].value);
            expect(await promise).toMatchObject({ status: 'rejected', reason, visualCommitted: false, settle: 'not-applied', effective: null });
            const after = captureAuthorTypographyContinuity(runtime.binding, runtime.options);
            expect(runtime.source()).toBe(source);
            expect(runtime.owner.context).toBe(context);
            expect(runtime.wrapper.vm).toBe(instance);
            expect(after.historyRef).toBe(before.historyRef);
            expect(after.anchor.range).toEqual(before.anchor.range);
            expect(after.anchor.direction).toBe(before.anchor.direction);
            expect(runtime.wrapper.emitted('transaction')?.length).toBe(transactions);
        }
        finally { call.mockRestore(); }
    });

    it('refuses missing, extra, future, numeric, CSS and font URL profile inputs before capability inspection', () =>
    {
        // A test input only, never a production default or verified preference.
        const profile = {
            schemaVersion: 1, fontFamily: 'system-sans', fontSize: 'standard',
            lineHeight: 'standard', canvasWidth: 'standard', paragraphSpacing: 'standard'
        };
        const invalid: unknown[] = [undefined, null, [], '', {}, { ...profile, schemaVersion: 2 }];
        for (const dimension of AUTHOR_TYPOGRAPHY_FIELDS)
        {
            for (const value of ['18px', 'var(--custom)', 'https://fonts.example/font.woff2', 18, null, '', 'STANDARD'])
            {
                invalid.push({ ...profile, [dimension]: value });
            }
            const missing: Record<string, unknown> = { ...profile };
            delete missing[dimension];
            invalid.push(missing);
        }
        for (const extra of [{ mode: 'source' }, { articleId: 1 }, { css: 'body{}' }, { [Symbol('extra')]: true }])
        {
            invalid.push({ ...profile, ...extra });
        }
        for (const input of invalid)
        {
            const availability = readAuthorTypographyMappingAvailability(input);
            expect(availability).toEqual({ status: 'blocked', reason: 'invalid-profile', publicEditorDefaultProfile: null });
            expect(Object.isFrozen(availability)).toBe(true);
        }
    });

    it.each(['live', 'source'] as const)('captures %s through the real runtime binding without transactions or remount', surface =>
    {
        const runtime = openRuntime(surface);
        expect(runtime.binding.initialize()).toBe(true);
        const selected = runtime.editor.dispatchTransaction({
            changes: [], history: 'skip', origin: 'programmatic',
            documentIdentity: runtime.owner.documentIdentity, expectedRevision: runtime.owner.context.sourceRevision,
            selection: { start: 12, end: 18, direction: 'backward' }
        });
        expect(selected.accepted).toBe(true);
        const before = runtime.binding.continuity.capture(runtime.binding.positionBinding(), runtime.options);
        const source = runtime.source();
        const context = runtime.owner.context;
        const editor = runtime.wrapper.vm;
        const transactions = runtime.wrapper.emitted('transaction')?.length;
        runtime.binding.anchors.manual('wheel', 'source', 100);
        const captured = captureAuthorTypographyContinuity(runtime.binding, runtime.options);
        expect(validateArticleEditorContinuityContext(captured)).toBe(true);
        expect(captured.anchor.intent.state).toBe('manual');
        expect(captured.anchor.direction).toBe('backward');
        expect(captured.anchor.viewportOffset).toBe(12);
        expect(captured.historyRef).toBe(before.historyRef);
        expect(captured.instanceRef).toBe(before.instanceRef);
        expect(captured.document).toEqual(context);
        expect(runtime.owner.context).toBe(context);
        expect(runtime.source()).toBe(source);
        expect(runtime.wrapper.vm).toBe(editor);
        expect(runtime.wrapper.emitted('transaction')?.length).toBe(transactions);
        expect(Object.isFrozen(captured)).toBe(true);
        expect(readAuthorTypographyMappingAvailability().status).toBe('blocked');
    });

    it('retains canonical refusal for unobserved, mismatched, stale and disposed bindings', () =>
    {
        const runtime = openRuntime('source');
        expect(() => captureAuthorTypographyContinuity(runtime.binding, runtime.options)).toThrow('continuity-observation-required');
        expect(runtime.binding.initialize()).toBe(true);
        expect(() => captureAuthorTypographyContinuity(runtime.binding, { ...runtime.options, surface: 'live' })).toThrow('continuity-observation-required');
        runtime.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: runtime.source(), reason: 'article-switch' });
        expect(() => captureAuthorTypographyContinuity(runtime.binding, runtime.options)).toThrow('continuity-observation-required');
        runtime.binding.dispose();
        expect(() => captureAuthorTypographyContinuity(runtime.binding, runtime.options)).toThrow('article-editor-runtime-binding-disposed');
    });
});
