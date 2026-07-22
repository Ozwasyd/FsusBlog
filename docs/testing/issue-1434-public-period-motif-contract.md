# Issue #1434：public period motif 测试分层

## 权威边界

`src/frontend/src/ui-contracts/publicPeriodMotif.ts` 是 period motif 的唯一运行时 owner：它定义 metadata glyph、共享 loading dot 接口，以及 neutral/error 的允许使用边界。`themeTokens` 只做主题适配，public list/detail/loading/empty-state 组件只消费该 owner，不再分别硬编码 glyph 或 class。

Public AOT、SSR snapshot、hydration 与 SPA 都通过 `pageAssemblies.ts` 引用相同的 public page components，所以不维护第二套 motif markup。`public-page.css` 只负责 `#app` 与 `#fsus-aot-shell` 共用的视觉实现。

## 测试分层

- `check-period-motif-contract.mjs` 是 canonical visual contract，核验 owner、允许/禁止场景、共享 renderer 接线和 CSS 边界。
- `PublicContentSemantics.test.ts` 只核验可见标题、摘要、metadata、link content、loading/status、error/alert，以及 SSR → hydration → SPA 的内容与状态语义。
- `articleTitleAuthority.test.ts` 只保留标题层级和 Markdown mode ownership，不再转述 motif contract。
- 浏览器视觉风险继续由语义命名的 `public-home-*` 与 `public-article-*` baseline 覆盖；本次没有改变 glyph、尺寸、颜色或 spacing，因此不新增 motif 专用截图。

旧 `PublicPeriodMotif.test.ts` 的三个 test IDs，以及 `articleTitleAuthority.test.ts` 被合并的 punctuation test ID，均在 `tests/test-retention-replacements.json` 映射到 canonical static owner 与对应行为测试。

## 本地验证

```bash
node tests/frontend/checks/static/check-period-motif-contract.mjs
node tests/frontend/checks/static/check-article-title-authority.mjs
cd src/frontend
vitest run --config vitest.config.ts \
  ../../tests/frontend/unit/components/PublicContentSemantics.test.ts \
  ../../tests/frontend/unit/contracts/articleTitleAuthority.test.ts \
  ../../tests/frontend/unit/public-renderers/homeEditorialRendererParity.test.ts
```

这些检查不依赖 GitHub Actions，也不设置固定时间门禁。
