import {
    MARKDOWN_RENDERER_VERSION,
    createMarkdownEditorProjection,
    resolveMarkdownSourceIdentity,
    renderMarkdownWithFsusRuntime,
    type MarkdownEditorProjectionResult,
    type MarkdownSafeRenderResult
} from '@/fsusui/markdown';

import { articleDocumentContextSchema } from './articleDocumentContext';
import {
    type ArticleRenderProducer,
    type ArticleRenderRequest,
    type ArticleRenderResult,
    validateArticleRenderResult
} from './articleRenderCache';
import { calculateOpenArticleDocumentDigest as digest } from './openArticleDocumentRegistry';

export interface ArticleFsusUiRenderConfiguration {
    readonly allowLatex: boolean;
    readonly allowMermaid: boolean;
    readonly baseUrl: string | null;
}

interface RetainedFsusUiPair {
    readonly render: MarkdownSafeRenderResult;
    readonly projection: MarkdownEditorProjectionResult;
}

interface RetainedFsusUiResult {
    readonly request: ArticleRenderRequest;
    readonly result: ArticleRenderResult;
    readonly pair: Readonly<RetainedFsusUiPair>;
}

const freezeProjection = <T extends object>(value: T): T =>
{
    for (const child of Object.values(value))
    {
        if (child && typeof child === 'object')
        {
            freezeProjection(child);
        }
    }
    return Object.freeze(value);
};

// The only body-bearing objects retained are canonical public FsusUI results.
export class ArticleFsusUiRenderProducer implements ArticleRenderProducer
{
    private readonly results = new Map<string, RetainedFsusUiResult>();
    private sequence = 0;
    private readonly configuration: ArticleFsusUiRenderConfiguration;
    private readonly readSource: (request: ArticleRenderRequest) => string;
    private readonly maxResultBytes: number;

    public constructor(
        readSource: (request: ArticleRenderRequest) => string,
        configuration: ArticleFsusUiRenderConfiguration,
        maxResultBytes: number
    )
    {
        this.readSource = readSource;
        this.maxResultBytes = maxResultBytes;
        if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1
            || Object.keys(configuration).sort().join(',') !== 'allowLatex,allowMermaid,baseUrl'
            || typeof configuration.allowLatex !== 'boolean' || typeof configuration.allowMermaid !== 'boolean'
            || (configuration.baseUrl !== null && typeof configuration.baseUrl !== 'string'))
        {
            throw new Error('article-render-producer-input-invalid');
        }
        this.configuration = Object.freeze({ ...configuration });
    }

    public async render(request: ArticleRenderRequest): Promise<ArticleRenderResult>
    {
        const failure = (reason: string, status: 'fatal' | 'projection-failed' = 'fatal'): ArticleRenderResult => ({
            contextDigest: request.context.contextDigest, requestId: request.requestId, identity: request.identity,
            status, reason, resultRef: null, resultDigest: null,
            fallbackRefs: [], longTaskRefs: [], layoutObservationRefs: []
        });
        if (request.signal.aborted)
        {
            throw new Error('render-canceled');
        }
        const source = this.readSource(request);
        if (digest({ schema: articleDocumentContextSchema, content: source }) !== request.context.contentDigest
            || request.identity.rendererVersion !== MARKDOWN_RENDERER_VERSION
            || request.identity.projectionVersion !== MARKDOWN_RENDERER_VERSION
            || request.identity.featureConfigurationDigest !== digest(this.configuration))
        {
            return failure('render-identity-mismatch');
        }
        // The public renderer has no AbortSignal parameter: cancellation guards its admission.
        const rendered = await renderMarkdownWithFsusRuntime({ source, mode: 'editor', ...this.configuration });
        if (request.signal.aborted)
        {
            throw new Error('render-canceled');
        }
        if (!rendered.ok)
        {
            return failure('fsusui-render-failed');
        }
        let projection: MarkdownEditorProjectionResult;
        try
        {
            projection = freezeProjection(createMarkdownEditorProjection(source));
            // Projection uses the public source-only identity; render identity also binds mode/features/baseUrl.
            if (projection.identity.rawSource !== rendered.value.rawSource
                || projection.identity.normalizedSource !== rendered.value.normalizedSource
                || projection.identity.version !== rendered.value.rendererVersion
                || projection.identity.parser !== rendered.value.parser
                || projection.identity.sourceIdentity !== resolveMarkdownSourceIdentity(source)
                || rendered.value.sourceIdentity !== resolveMarkdownSourceIdentity({ source, mode: 'editor', ...this.configuration }))
            {
                return failure('projection-identity-mismatch', 'projection-failed');
            }
        }
        catch
        {
            return failure('fsusui-projection-failed', 'projection-failed');
        }
        if (request.signal.aborted)
        {
            throw new Error('render-canceled');
        }
        const size = new TextEncoder().encode(JSON.stringify({ render: rendered.value, projection })).byteLength;
        if (size > this.maxResultBytes || this.results.size >= 2)
        {
            return failure('render-retention-limit');
        }
        this.sequence += 1;
        const resultRef = `fsusui-render:${request.context.documentId}:${this.sequence.toString(36)}`;
        const result: ArticleRenderResult = Object.freeze({
            contextDigest: request.context.contextDigest, requestId: request.requestId, identity: request.identity,
            status: projection.diagnostics.length ? 'partial' : 'valid',
            reason: projection.diagnostics.length ? 'fsusui-node-fallback' : null,
            resultRef, resultDigest: digest({ render: rendered.value, projection }),
            // The complete public projection keeps every diagnostic; the metadata ref list is bounded.
            fallbackRefs: Object.freeze([...new Set(projection.diagnostics.map(item => item.blockIdentity))].slice(0, 64)),
            longTaskRefs: Object.freeze([]), layoutObservationRefs: Object.freeze([])
        });
        if (!validateArticleRenderResult(result))
        {
            return failure('fsusui-result-invalid');
        }
        this.results.set(resultRef, { request, result, pair: Object.freeze({ render: rendered.value, projection }) });
        return result;
    }

    public verify(request: ArticleRenderRequest, result: ArticleRenderResult): boolean
    {
        if (!validateArticleRenderResult(result))
        {
            return false;
        }
        if (result.resultRef === null)
        {
            return result.contextDigest === request.context.contextDigest
            && result.requestId === request.requestId && digest(result.identity) === digest(request.identity);
        }
        const retained = this.results.get(result.resultRef);
        return retained?.request === request && digest(retained.result) === digest(result)
            && result.resultDigest === digest(retained.pair);
    }

    public resolve(result: ArticleRenderResult): Readonly<RetainedFsusUiPair> | null
    {
        const retained = result.resultRef ? this.results.get(result.resultRef) : null;
        if (!retained || digest(retained.result) !== digest(result)
            || result.resultDigest !== digest(retained.pair))
        {
            return null;
        }
        return retained.pair;
    }

    public release(resultRef: string): void
    {
        this.results.delete(resultRef);
    }
}
