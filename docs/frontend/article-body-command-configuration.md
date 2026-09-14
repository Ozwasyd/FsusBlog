# Article body command configuration

This document is the product command configuration for the article Markdown body. It does not own FsusUI command-surface internals or the Markdown render protocol.

The article title field remains the document's only H1. Body commands consume the FsusUI canonical registry; Blog does not create aliases for those keys and does not rearrange the toolbar with private selectors.

## Frozen primary commands

The default high-frequency set is exactly these six keys, in this order:

1. `heading` — 章节, body H2
2. `bold` — 粗体
3. `italic` — 斜体
4. `link` — 链接
5. `quote` — 引用
6. `code` — 行内代码

The set is not adjusted from analytics, viewport width, locale, or implementer judgment. Mobile may use a more compact presentation of the same six keys plus one insert overflow; it must not receive a different primary set.

## Grouping

- Structure overflow: H3–H6 as `heading-3` … `heading-6` (小节 / 四级标题 / 五级标题 / 六级标题).
- Insert / palette: unordered list, ordered list, task list, code block, image, table, formula, Mermaid, and horizontal rule.
- Toolbar, selection toolbar, slash menu, command palette, and keyboard shortcuts share one command snapshot. Hiding a command from a surface must not change availability or group membership.

Body H1 insert paths (`h1`, `heading-1`, and ATX/setext first-level headings)
are not registered. Existing body H1 source is left unchanged on load and
diagnosed in the editor status until the author converts it to a chapter heading.

## Authority

Machine-readable copies of the frozen keys live in `src/frontend/src/components/ui/markdown-editor/articleBodyCommandConfig.ts` and `tests/frontend/fixtures/article-editor-production-contract.json`. Static gates reject H1 reintroduction, six-item drift, and Blog-local toolbar restyling.
