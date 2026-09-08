# Reading Typography Contract

This document owns `reading` content from [`surface-profiles.md`](surface-profiles.md). Article, About, Comment, and admin Preview share `MarkdownRenderer` and `markdown.css`. The body baseline is `16px`, weight `400`, line-height `1.8`. Chinese narrative text uses `text-align: justify`, `0.015em` tracking compensation, and `2em` first-line indent; headings stay left-aligned. Document mode (About, legal, and policy) uses left alignment and no paragraph indent. Entrypoints declare only `article`, `about`, or `preview`; callers must not redefine body, quote, list, heading, or code typography.

## Display, reading, and metadata

- `display`: list titles use `18/20/24px`, line-height `1.25/1.2`, weight `700`; page H1 follows [`page-title-scale.md`](page-title-scale.md).
- `reading`: list summaries use `14/16px`, `400`, `1.7`; long-form body and quotes use `16px/400/1.8`. Markdown paragraphs have one authoritative rule.
- `metadata`: dates, categories, status, reading counts, and actions use `12px` or `14px`; muted/tertiary text must meet AA. Decorative tokens are only for dots and markers.

AOT emergency, hydration, and SPA takeover use the same reading roles and metadata tiers. Blockquotes inherit body typography. Account navigation, task controls, and other non-reading text belong to FsusUI and their task contracts.

## Weights, headings, and document mode

The renderer uses only font-loader-confirmed body, emphasis, and heading weights; it never relies on synthetic missing weights. `ArticleCommentComposer` identity labels, badges, toggles, drafts, empty previews, feedback, and metrics, and the desktop TOC title use `700`. Blockquotes declare no local weight and inherit Markdown root `400`.

Markdown H1 is `24px`; H2-H6 are `20px`, all left-aligned. The article-mode H1 is a chapter heading at `1.4em/700` with `3em` top spacing. Preview/editor does not inherit article-only overrides; choose `article` mode explicitly for a faithful preview. About, privacy, guidelines, and copyright use `mode="about"` and `markdown-body--document`: natural tracking, `text-autospace: normal`, zero paragraph indent, zero list horizontal margin, and `1.5em` marker padding. Article/preview/editor do not inherit these overrides. Paragraphs, quotes, lists, and code blocks share one reading column; quotes remain `16px/400/1.8`.

Fenced, inline, comment, audit/detail preview, AOT/SSR, and hydrated code use `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`. Code blocks use reading-surface fill and neutral borders; long lines scroll inside the block and never widen the reading container.

`data-fsus-surface="reading"` forbids blur, glow, motion trail, shimmer, pulse, translate, scale, stagger, and scroll reveal under every motion preference. Body, headings, images, and code blocks appear statically. Copy feedback, focus/target positioning, reading-progress state, and media-overlay settle may use functional motion; Light/Dark changes semantic colors only. 375px, 768px, 1440px, and 150% zoom keep DOM order and typography roles unchanged.
