# Issue #1096: Local FsusUI article theme verification

文章附录和评论区域只消费 FsusBlog 产品语义变量，不在组件内声明主题色或 `html.dark` 覆盖。产品变量在 `public-page.css` 与 `public-shell-foundation.css` 中映射到相邻 FsusUI #183 的 public tokens：

| FsusBlog alias                      | FsusUI source                  |
| ----------------------------------- | ------------------------------ |
| `--fsusblog-text-primary`           | `--fsus-color-text-primary`    |
| `--fsusblog-text-quiet`             | `--fsus-color-text-quiet`      |
| `--fsusblog-text-decorative`        | `--fsus-color-text-decorative` |
| `--fsusblog-panel-border`           | `--fsus-color-border-subtle`   |
| `--fsusblog-color-primary`          | `--fsus-color-action-primary`  |
| `--fsusblog-color-focus-ring`       | `--fsus-color-focus-ring`      |
| `--fsusblog-reading-inline-code-bg` | `--fsus-color-surface-raised`  |

相邻仓库联调使用现有 local alias，不修改 `@ozwasyd/element-plus` 版本或 lockfile，也不依赖 npm 发布。旧发布包路径只通过每个产品 alias 的窄 fallback 保持可构建，不复制整套 FsusUI token。

聚焦验证：

```bash
cd src/frontend
npm run typecheck:local-fsusui
node ../../tests/frontend/checks/static/check-public-reading-motion.mjs
node ../../tests/frontend/checks/static/check-foundation-token-governance.mjs
node ../../tests/frontend/checks/static/check-fsusui-boundary.mjs
```

`public-visual.spec.ts` 同时冻结 light/dark 的正文、安静文本、边框、hover、focus 和行内代码表面 computed style。`html.dark` 与 `html[data-theme-resolved='dark']` 共用同一主题声明，因此显式 dark 与 system-resolved dark 不会形成两套组件覆盖。AOT emergency CSS 从 `public-page.css` 的 `emergency:keep` 区块生成，以确保 hydration 前后产品 alias 一致。
