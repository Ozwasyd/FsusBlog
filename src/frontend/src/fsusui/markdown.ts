import {
    renderMarkdownResultWithRuntime as renderMarkdownResultWithFsusUiRuntime
} from '@ozwasyd/element-plus/markdown-runtime';

import { isFsusUiResult, type FsusUiResult } from '@/fsusui/result';

import type {
    MarkdownRenderFeature,
    MarkdownRenderMetadata,
    MarkdownRenderMode,
    MarkdownRenderPlaceholder,
    MarkdownSafeRenderResult
} from '@ozwasyd/element-plus/markdown-runtime';

export type MarkdownRenderResult = MarkdownSafeRenderResult;

export {
    createMarkdownEditorProjection,
    createMarkdownOutlineEntries,
    resolveMarkdownSourceIdentity
} from '@ozwasyd/element-plus/markdown-runtime';
export type { MarkdownEditorProjectionResult } from '@ozwasyd/element-plus/markdown-runtime';

type MarkdownRuntimeRenderer = (input: {
    source: string;
    mode: MarkdownRenderMode;
    allowLatex: boolean;
    allowMermaid: boolean;
    baseUrl: string | null;
}) => Promise<unknown>;

const unavailable = (message: string, cause?: unknown): FsusUiResult<MarkdownRenderResult> => ({
    ok: false,
    error: {
        code: 'infra',
        category: 'runtime',
        message,
        cause
    }
});

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null;
}

function isMarkdownRuntimeRenderer(value: unknown): value is MarkdownRuntimeRenderer
{
    return typeof value === 'function';
}

function isMarkdownRenderFeature(value: unknown): value is MarkdownRenderFeature
{
    return typeof value === 'string'
        && [
            'code_block',
            'latex',
            'mermaid',
            'table',
            'image',
            'heading',
            'link',
            'emphasis',
            'footnote'
        ].includes(value);
}

function isMarkdownRenderPlaceholder(value: unknown): value is MarkdownRenderPlaceholder
{
    if (!isRecord(value))
    {
        return false;
    }
    return typeof value.kind === 'string'
        && ['latex_inline', 'latex_block', 'mermaid_block'].includes(value.kind)
        && typeof value.token === 'string'
        && typeof value.label === 'string'
        && typeof value.line === 'number'
        && (value.source === undefined || typeof value.source === 'string')
        && (value.column === undefined || typeof value.column === 'number')
        && (value.endLine === undefined || typeof value.endLine === 'number')
        && (value.endColumn === undefined || typeof value.endColumn === 'number')
        && (value.startOffset === undefined || typeof value.startOffset === 'number')
        && (value.endOffset === undefined || typeof value.endOffset === 'number');
}

function isMarkdownRenderMetadata(value: unknown): value is MarkdownRenderMetadata
{
    if (!isRecord(value))
    {
        return false;
    }
    return typeof value.mode === 'string'
        && ['article', 'about', 'preview', 'editor'].includes(value.mode)
        && (value.baseUrl === null || typeof value.baseUrl === 'string')
        && typeof value.allowLatex === 'boolean'
        && typeof value.allowMermaid === 'boolean'
        && typeof value.sourceLength === 'number'
        && (value.sourceLineCount === undefined || typeof value.sourceLineCount === 'number')
        && (value.normalizedSourceLength === undefined || typeof value.normalizedSourceLength === 'number')
        && typeof value.featureCount === 'number'
        && typeof value.placeholderCount === 'number'
        && typeof value.rendererVersion === 'string';
}

function isMarkdownSafeRenderResult(value: unknown): value is MarkdownSafeRenderResult
{
    if (!isRecord(value))
    {
        return false;
    }
    return typeof value.html === 'string'
        && typeof value.normalizedSource === 'string'
        && typeof value.sourceIdentity === 'string'
        && Array.isArray(value.features)
        && value.features.every(isMarkdownRenderFeature)
        && Array.isArray(value.placeholders)
        && value.placeholders.every(isMarkdownRenderPlaceholder)
        && typeof value.rendererVersion === 'string'
        && (value.metadata === undefined || isMarkdownRenderMetadata(value.metadata));
}

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
        const renderer: unknown = renderMarkdownResultWithFsusUiRuntime;
        if (!isMarkdownRuntimeRenderer(renderer))
        {
            return unavailable('FsusUI markdown runtime export is unavailable.');
        }
        const result: unknown = await renderer({
            source: input.source,
            mode: input.mode ?? 'article',
            allowLatex: input.allowLatex ?? true,
            allowMermaid: input.allowMermaid ?? true,
            baseUrl: input.baseUrl ?? null
        });
        if (!isFsusUiResult(result))
        {
            return unavailable('FsusUI markdown runtime returned an invalid result envelope.');
        }
        if (!result.ok)
        {
            return {
                ok: false,
                error: result.error
            };
        }
        if (!isMarkdownSafeRenderResult(result.value))
        {
            return unavailable('FsusUI markdown runtime returned an invalid safe-render result.');
        }
        return {
            ok: true,
            value: result.value
        };
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
    MarkdownPlaceholderKind,
    MarkdownRenderFeature,
    MarkdownRenderMetadata,
    MarkdownRenderMode,
    MarkdownRenderPlaceholder,
    MarkdownSafeHtml,
    MarkdownSafeRenderResult
} from '@ozwasyd/element-plus/markdown-runtime';
export type {
    MarkdownFeatureActivationError,
    MarkdownFeatureActivationFeatureOptions,
    MarkdownFeatureActivationItem,
    MarkdownFeatureActivationKind,
    MarkdownFeatureActivationOptions,
    MarkdownFeatureActivationResult,
    MarkdownRenderChunk,
    MarkdownRenderChunkKind,
    MarkdownRenderRequest,
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
