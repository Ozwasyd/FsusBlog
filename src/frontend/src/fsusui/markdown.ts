import {
    renderMarkdownResultWithRuntime,
    type MarkdownSafeRenderResult
} from '@ozwasyd/element-plus/markdown-runtime';

import type { FsusUiResult } from '@/fsusui/result';

export type MarkdownRenderMode = 'article' | 'about' | 'preview' | 'editor';
export type MarkdownRenderResult = MarkdownSafeRenderResult;

const unavailable = (message: string, cause?: unknown): FsusUiResult<MarkdownRenderResult> => ({
    ok: false,
    error: {
        code: 'infra',
        category: 'runtime',
        message,
        cause
    }
});

export async function renderMarkdownWithFsusRuntime(input: {
    source: string;
    mode?: MarkdownRenderMode;
    allowLatex?: boolean;
    allowMermaid?: boolean;
    baseUrl?: string | null;
}): Promise<FsusUiResult<MarkdownRenderResult>>
{
    try
    {
        const result: FsusUiResult<MarkdownRenderResult> = await renderMarkdownResultWithRuntime({
            source: input.source,
            mode: input.mode ?? 'article',
            allowLatex: input.allowLatex ?? true,
            allowMermaid: input.allowMermaid ?? true,
            baseUrl: input.baseUrl ?? null
        });
        return result;
    }
    catch (error: unknown)
    {
        return unavailable('FsusUI markdown runtime is unavailable.', error);
    }
}

export async function renderMarkdownOrThrow(input: {
    source: string;
    mode?: MarkdownRenderMode;
    allowLatex?: boolean;
    allowMermaid?: boolean;
    baseUrl?: string | null;
}): Promise<MarkdownSafeRenderResult>
{
    const result = await renderMarkdownWithFsusRuntime(input);
    return unwrapMarkdownRuntimeResult(result);
}

export function unwrapMarkdownRuntimeResult(
    result: FsusUiResult<MarkdownRenderResult>
): MarkdownSafeRenderResult
{
    if (!result.ok)
    {
        throw new Error(`markdown_runtime_failed:${result.error.code}`);
    }
    return result.value;
}

export {
    MARKDOWN_RENDERER_SURFACE_CLASSES,
    MARKDOWN_RENDERER_VERSION,
    MarkdownRuntimeError,
    activateMarkdownFeatures,
    detectMarkdownFeatures,
    detectMarkdownPlaceholders,
    escapeMarkdownHtml,
    initMarkdownRuntime,
    normalizeMarkdownSource,
    renderMarkdownChunksWithRuntime,
    renderMarkdownHtmlWithRuntime,
    renderMarkdownResultWithRuntime,
    renderMarkdownSummaryWithRuntime,
    renderMarkdownWithRuntime
} from '@ozwasyd/element-plus/markdown-runtime';
export type {
    MarkdownFeatureActivationError,
    MarkdownFeatureActivationFeatureOptions,
    MarkdownFeatureActivationItem,
    MarkdownFeatureActivationKind,
    MarkdownFeatureActivationOptions,
    MarkdownFeatureActivationResult,
    MarkdownFeatureAdapter,
    MarkdownPlaceholderKind,
    MarkdownRenderChunk,
    MarkdownRenderChunkKind,
    MarkdownRenderFeature,
    MarkdownRenderMetadata,
    MarkdownRenderPlaceholder,
    MarkdownRenderRequest,
    MarkdownSafeHtml,
    MarkdownSafeRenderResult,
    MarkdownRenderTimings,
    MarkdownRendererSurfaceContract,
    MarkdownRuntimeChunkResult,
    MarkdownRuntimeErrorCode,
    MarkdownRuntimeHtmlResult,
    MarkdownRuntimeKind,
    MarkdownRuntimeProfile,
    MarkdownRuntimeProfilePhase,
    MarkdownRuntimeRenderResult,
    MarkdownRuntimeSummaryResult
} from '@ozwasyd/element-plus/markdown-runtime';
