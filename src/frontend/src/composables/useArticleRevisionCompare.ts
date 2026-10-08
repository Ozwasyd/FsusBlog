import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';

import { compareArticleRevisionSources, readArticleRevisionCompareDraftCoordinate } from '@/api/articleRevisionCompare';
import type { ArticleRevisionCompareRequest, ArticleRevisionCompareSelector } from '@/api/articleRevisionCompare';
import { getArticleRevision, getServerDraft } from '@/api/authoring';
import { materializeRevisionSourcePresentation, revisionSourceDigest } from '@/services/revisionComparePresentation';
import type { RevisionSourcePresentation } from '@/services/revisionComparePresentation';

export interface ArticleRevisionCompareInputs {
    articleId: number | null;
    compareRevisionId: string | null;
    currentRevisionId: string | null;
    draftKey: string | null;
    serverDraftRevision: number | null;
    currentContent: string;
    contextIdentity: string;
}

const defaultPorts = { compareArticleRevisionSources, readArticleRevisionCompareDraftCoordinate, getArticleRevision, getServerDraft };

export function useArticleRevisionCompare(inputs: () => ArticleRevisionCompareInputs, ports = defaultPorts)
{
    const baseSelection = ref('current');
    const mode = ref<0 | 1>(0);
    const status = ref<'idle' | 'loading' | 'ready' | 'stale' | 'cancelled' | 'unavailable'>('idle');
    const result = shallowRef<RevisionSourcePresentation | null>(null);
    const phase = ref('');
    let controller: AbortController | null = null;
    let generation = 0;
    const invalidate = (next: typeof status.value): void =>
    {
        generation++;
        controller?.abort();
        controller = null;
        result.value = null;
        phase.value = '';
        status.value = next;
    };
    const cancel = (): void => invalidate('cancelled');
    watch(() => [inputs().articleId, inputs().compareRevisionId, inputs().currentRevisionId,
        inputs().draftKey, inputs().serverDraftRevision, inputs().currentContent, inputs().contextIdentity, baseSelection.value],
    () => invalidate(status.value === 'idle' ? 'idle' : 'stale'));
    onScopeDispose(() => invalidate('cancelled'));
    const canCompare = computed(() => inputs().articleId !== null && inputs().compareRevisionId !== null
        && (baseSelection.value === 'draft' ? inputs().draftKey !== null : baseSelection.value === 'current' ? inputs().currentRevisionId !== null : true));
    const compare = async (): Promise<void> =>
    {
        invalidate('loading');
        const identity = generation;
        const requestController = new AbortController();
        controller = requestController;
        const config = { signal: requestController.signal };
        const input = inputs();
        const base = baseSelection.value;
        try
        {
            if (!canCompare.value || input.articleId === null || !input.compareRevisionId)
            {
                throw new Error('revision_compare_input_unavailable');
            }
            phase.value = '正在读取授权的精确版本';
            const historical = async (revisionId: string) =>
            {
                const value = await ports.getArticleRevision(input.articleId!, revisionId, config);
                if (value.articleId !== input.articleId || value.id !== revisionId)
                {
                    throw new Error('revision_compare_source_identity_invalid');
                }
                return value.content;
            };
            const compareContent = await historical(input.compareRevisionId);
            let baseContent: string;
            let selector: ArticleRevisionCompareSelector;
            if (base === 'draft')
            {
                const draft = await ports.getServerDraft(input.draftKey!, config);
                if (draft?.articleId !== input.articleId || draft.draftKey !== input.draftKey
                    || !Number.isSafeInteger(draft.serverRevision) || draft.serverRevision <= 0
                    || draft.serverRevision !== input.serverDraftRevision || draft.content !== input.currentContent)
                {
                    throw new Error('revision_compare_source_stale');
                }
                const coordinate = await ports.readArticleRevisionCompareDraftCoordinate(input.articleId,
                    { draftKey: draft.draftKey, expectedServerRevision: String(draft.serverRevision) }, config);
                baseContent = draft.content;
                const sourceDigest = await revisionSourceDigest(new TextEncoder().encode(baseContent));
                if (coordinate.sourceDigest !== sourceDigest)
                {
                    throw new Error('revision_compare_source_stale');
                }
                selector = { kind: 0, draftKey: coordinate.draftKey, expectedServerRevision: coordinate.serverRevision,
                    documentEpoch: coordinate.documentEpoch, expectedSourceDigest: coordinate.sourceDigest };
            }
            else
            {
                const revisionId = base === 'current' ? input.currentRevisionId! : base;
                baseContent = await historical(revisionId);
                selector = { kind: base === 'current' ? 2 : 1, revisionId };
            }
            requestController.signal.throwIfAborted();
            phase.value = '正在执行服务端有界比较；可取消';
            const request: ArticleRevisionCompareRequest = { base: selector, compare: { kind: 1, revisionId: input.compareRevisionId },
                options: { viewMode: mode.value, wordSegmentation: 0, contextLineCount: 3, headingNavigation: true,
                    metadataFieldIds: ['title', 'summary', 'cover-image-url', 'category-id', 'tag-ids', 'status', 'scheduled-publish-at'] },
                budgets: { maxSourceBytes: 4 * 1024 * 1024, maxLineCount: 200000, maxTokenCount: 1000000,
                    maxOutputBytes: 8 * 1024 * 1024, maxMemoryBytes: 64 * 1024 * 1024, maxHunksPerChunk: 200, maxChunks: 100, timeoutMilliseconds: 30000 },
                cancellationIdentity: crypto.randomUUID() };
            const response = await ports.compareArticleRevisionSources(input.articleId, request, config);
            phase.value = '正在验证授权源码与服务端范围';
            const presentation = await materializeRevisionSourcePresentation(response, baseContent, compareContent);
            requestController.signal.throwIfAborted();
            if (identity !== generation)
            {
                return;
            }
            result.value = presentation;
            phase.value = '';
            status.value = 'ready';
        }
        catch (error)
        {
            if (identity === generation)
            {
                result.value = null;
                phase.value = '';
                status.value = error instanceof Error && error.message === 'revision_compare_source_stale' ? 'stale'
                    : requestController.signal.aborted ? 'cancelled' : 'unavailable';
            }
        }
        finally
        {
            if (identity === generation)
            {
                controller = null;
            }
        }
    };
    const setMode = async (next: 0 | 1): Promise<void> =>
    {
        if (mode.value !== next)
        {
            mode.value = next;
            await compare();
        }
    };
    return { baseSelection, mode, status, result, phase, canCompare, compare, cancel, setMode };
}
