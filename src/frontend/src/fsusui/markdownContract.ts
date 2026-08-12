export type MarkdownRenderMode = 'article' | 'about' | 'preview' | 'editor';
export type MarkdownRenderFeature =
    | 'code_block'
    | 'latex'
    | 'mermaid'
    | 'table'
    | 'image'
    | 'heading'
    | 'link'
    | 'emphasis'
    | 'footnote';
export type MarkdownPlaceholderKind = 'latex_inline' | 'latex_block' | 'mermaid_block';
export type MarkdownSafeHtml = string;

export interface MarkdownRenderMetadata
{
    readonly mode: MarkdownRenderMode;
    readonly baseUrl: string | null;
    readonly allowLatex: boolean;
    readonly allowMermaid: boolean;
    readonly sourceLength: number;
    readonly sourceLineCount?: number;
    readonly normalizedSourceLength?: number;
    readonly featureCount: number;
    readonly placeholderCount: number;
    readonly rendererVersion: string;
}

export interface MarkdownRenderPlaceholder
{
    readonly kind: MarkdownPlaceholderKind;
    readonly token: string;
    readonly label: string;
    readonly line: number;
    readonly source?: string;
    readonly column?: number;
    readonly endLine?: number;
    readonly endColumn?: number;
    readonly startOffset?: number;
    readonly endOffset?: number;
}

export interface MarkdownSafeRenderResult
{
    readonly html: MarkdownSafeHtml;
    readonly normalizedSource: string;
    readonly sourceIdentity: string;
    readonly features: readonly MarkdownRenderFeature[];
    readonly placeholders: readonly MarkdownRenderPlaceholder[];
    readonly rendererVersion: string;
    readonly metadata?: MarkdownRenderMetadata;
}
