export const MARKDOWN_RENDERER_VERSION = 'markdown-wasm-contract@2026-04-06-3';

export type MarkdownRenderMode = 'article' | 'about' | 'preview' | 'editor';
export type MarkdownRenderFeature = 'code_block' | 'latex' | 'mermaid' | 'table' | 'image' | 'heading' | 'link';
export type MarkdownPlaceholderKind = 'latex_inline' | 'latex_block' | 'mermaid_block';

export interface MarkdownRenderMetadata {
  mode: MarkdownRenderMode;
  baseUrl: string | null;
  allowHtml: boolean;
  allowLatex: boolean;
  allowMermaid: boolean;
  sourceLength: number;
  normalizedSourceLength?: number;
  featureCount: number;
  placeholderCount: number;
  rendererVersion: string;
}

export interface MarkdownRenderRequest {
  source: string;
  baseUrl?: string | null;
  mode?: MarkdownRenderMode;
  allowHtml?: boolean;
  allowLatex?: boolean;
  allowMermaid?: boolean;
}

export interface MarkdownRenderPlaceholder {
  kind: MarkdownPlaceholderKind;
  token: string;
  label: string;
  line: number;
}

export interface MarkdownRenderResult {
  html: string;
  normalizedSource: string;
  features: readonly MarkdownRenderFeature[];
  placeholders: readonly MarkdownRenderPlaceholder[];
  rendererVersion: string;
  metadata?: MarkdownRenderMetadata;
}

export interface MarkdownRendererSurfaceContract {
  root: string;
  detail: string;
  body: string;
  placeholder: string;
  error: string;
  mermaid: string;
  latex: string;
  code: string;
}

export const MARKDOWN_RENDERER_SURFACE_CLASSES: MarkdownRendererSurfaceContract = Object.freeze({
  root: 'markdown-body prose prose-zinc max-w-none subpixel-antialiased',
  detail: 'markdown-body prose prose-zinc max-w-none subpixel-antialiased whitespace-pre-wrap',
  body: 'markdown-renderer__body',
  placeholder: 'markdown-renderer__placeholder',
  error: 'markdown-renderer__error',
  mermaid: 'markdown-renderer__mermaid',
  latex: 'markdown-renderer__latex',
  code: 'shiki'
});

export function normalizeMarkdownSource(input: string): string {
  const raw = typeof input === 'string' ? input : '';
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function escapeMarkdownHtml(input: string): string {
  return String(input).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case '\'':
        return '&#39;';
      default:
        return char;
    }
  });
}

export function detectMarkdownFeatures(source: string): MarkdownRenderFeature[] {
  const normalized = normalizeMarkdownSource(source);
  const features = new Set<MarkdownRenderFeature>();

  if (normalized.includes('```') || normalized.includes('~~~')) {
    features.add('code_block');
  }
  if (normalized.includes('$$') || normalized.includes('\\(') || normalized.includes('\\[')) {
    features.add('latex');
  }
  if (normalized.includes('```mermaid') || normalized.includes(':::mermaid')) {
    features.add('mermaid');
  }
  if (normalized.includes('|')) {
    features.add('table');
  }
  if (normalized.includes('![')) {
    features.add('image');
  }
  if (normalized.includes('#')) {
    features.add('heading');
  }
  if (normalized.includes('](')) {
    features.add('link');
  }

  return [...features];
}

export function detectMarkdownPlaceholders(source: string): MarkdownRenderPlaceholder[] {
  const normalized = normalizeMarkdownSource(source);
  const placeholders: MarkdownRenderPlaceholder[] = [];
  const lines = normalized.split('\n');

  lines.forEach((line, index) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```mermaid')) {
      placeholders.push({
        kind: 'mermaid_block',
        token: 'mermaid',
        label: 'Mermaid 图表将在 Wasm 渲染器中占位',
        line: index + 1
      });
      return;
    }

    if (trimmed === '$$' || trimmed.startsWith('$$ ')) {
      placeholders.push({
        kind: 'latex_block',
        token: 'latex-block',
        label: 'LaTeX 块公式将在 Wasm 渲染器中占位',
        line: index + 1
      });
      return;
    }

    if (line.includes('\\(') || line.includes('\\[')) {
      placeholders.push({
        kind: 'latex_inline',
        token: 'latex-inline',
        label: 'LaTeX 行内公式将在 Wasm 渲染器中占位',
        line: index + 1
      });
    }
  });

  return placeholders;
}

export function buildMarkdownRenderResult(input: {
  html: string;
  source: string;
  features?: readonly MarkdownRenderFeature[];
  placeholders?: readonly MarkdownRenderPlaceholder[];
  rendererVersion?: string;
  metadata?: MarkdownRenderMetadata;
}): MarkdownRenderResult {
  const normalizedSource = normalizeMarkdownSource(input.source);
  return {
    html: input.html,
    normalizedSource,
    features: input.features ? [...input.features] : detectMarkdownFeatures(normalizedSource),
    placeholders: input.placeholders ? [...input.placeholders] : detectMarkdownPlaceholders(normalizedSource),
    rendererVersion: input.rendererVersion ?? MARKDOWN_RENDERER_VERSION,
    metadata: input.metadata
  };
}
